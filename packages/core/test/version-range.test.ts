import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { compareVersions, isValidVersionRange, parseVersion, satisfiesVersionRange } from '@anvil/core'

describe('parseVersion', () => {
  test('reads a three-part version, with or without a v prefix', () => {
    assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] })
    assert.deepEqual(parseVersion('v20.11.1'), { major: 20, minor: 11, patch: 1, prerelease: [] })
  })

  test('normalises missing components to zero', () => {
    assert.deepEqual(parseVersion('20'), { major: 20, minor: 0, patch: 0, prerelease: [] })
    assert.deepEqual(parseVersion('20.11'), { major: 20, minor: 11, patch: 0, prerelease: [] })
  })

  test('keeps prerelease identifiers, numeric ones as numbers', () => {
    assert.deepEqual(parseVersion('1.2.3-beta.2'), {
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ['beta', 2],
    })
  })

  test('ignores build metadata but keeps the version comparable', () => {
    assert.deepEqual(parseVersion('1.2.3+build.5'), { major: 1, minor: 2, patch: 3, prerelease: [] })
    // Build metadata does not decide ordering, so a long numeric identifier is not held to
    // the safe-integer rule a prerelease identifier is.
    assert.deepEqual(parseVersion('1.2.3+20261105094537688000'), {
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
    })
  })

  test('rejects wildcards and malformed versions', () => {
    for (const value of ['', 'banana', '1.x', '1.2.3.4', '>=1.2.3', '1.2.3-rc..1', '1.2.3+.']) {
      assert.equal(parseVersion(value), null, value)
    }
  })

  test('rejects components that cannot be compared exactly', () => {
    // Rounding this to a double would make it equal to 9007199254740992, which is a
    // different version.
    assert.equal(parseVersion('9007199254740993.0.0'), null)
    assert.equal(parseVersion('1.2.9007199254740993'), null)
  })
})

describe('compareVersions', () => {
  test('orders numeric components', () => {
    const version = (value: string) => parseVersion(value)
    const a = version('1.10.0')
    const b = version('1.9.9')
    assert.ok(a !== null && b !== null)
    assert.equal(compareVersions(a, b), 1)
    assert.equal(compareVersions(b, a), -1)
  })

  test('sorts a prerelease before its release, numeric before text', () => {
    const compare = (a: string, b: string) => {
      const left = parseVersion(a)
      const right = parseVersion(b)
      assert.ok(left !== null && right !== null)
      return compareVersions(left, right)
    }
    assert.equal(compare('1.2.3-beta', '1.2.3'), -1)
    assert.equal(compare('1.2.3-alpha.2', '1.2.3-alpha.10'), -1)
    assert.equal(compare('1.2.3-1', '1.2.3-alpha'), -1)
  })
})

describe('satisfiesVersionRange', () => {
  const cases: Array<[string, string, boolean]> = [
    // Exact and partial versions.
    ['1.2.3', '1.2.3', true],
    ['1.2.4', '1.2.3', false],
    ['20.11.1', '20', true],
    ['20.11.1', '20.11', true],
    ['21.0.0', '20', false],
    ['20.12.0', '20.11', false],
    // Comparators, including partial bounds.
    ['18.2.0', '>=18', true],
    ['17.9.9', '>=18', false],
    ['20.11.1', '>=18 <21', true],
    ['21.0.0', '>=18 <21', false],
    ['20.11.1', '>= 18 < 21', true],
    ['18.2.9', '>=18, <19', true],
    ['18.2.9', '>18.2', false],
    ['18.3.0', '>18.2', true],
    ['18.2.9', '<=18.2', true],
    ['18.3.0', '<=18.2', false],
    ['18.2.9', '<18.3', true],
    // Wildcards and alternatives.
    ['1.0.0', '*', true],
    ['20.0.0', '20.x', true],
    ['21.0.0', '20.x', false],
    ['20.4.2', '20.4.x', true],
    ['20.5.0', '20.4.x', false],
    ['18.20.0', '^18 || ^20', true],
    ['22.0.0', '^18 || ^20', false],
    // Caret and tilde.
    ['20.11.0', '^20.11.0', true],
    ['20.99.0', '^20.11.0', true],
    ['21.0.0', '^20.11.0', false],
    ['0.2.9', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    ['0.0.4', '^0.0.3', false],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['1.9.0', '~1', true],
    ['2.0.0', '~1', false],
  ]

  for (const [version, range, expected] of cases) {
    test(`${version} ${expected ? 'satisfies' : 'does not satisfy'} ${range}`, () => {
      assert.equal(satisfiesVersionRange(version, range), expected)
    })
  }

  test('a malformed version or range is not a pass', () => {
    assert.equal(satisfiesVersionRange('nightly', '>=18'), false)
    assert.equal(satisfiesVersionRange('18.0.0', 'not-a-range'), false)
  })
})

describe('isValidVersionRange', () => {
  test('accepts the documented subset', () => {
    for (const range of [
      '1.2.3',
      '>=18 <21',
      '>= 18 < 21',
      '>=18, <21',
      '^20.11',
      '~1.2.3',
      '20.x',
      '*',
      '^18 || ^20',
      '1.2.3+build.5',
      '1.2.3+20261105094537688000',
    ]) {
      assert.equal(isValidVersionRange(range), true, range)
    }
  })

  test('rejects an empty, incomplete or unsupported range', () => {
    for (const range of [
      '',
      '>=',
      'banana',
      '^x',
      '1.2.3.4',
      '>=1 <',
      '1.2.3 - 2.0.0',
      '1.2.3-rc..1',
      '1.2.3+.',
      '9007199254740993.0.0',
    ]) {
      assert.equal(isValidVersionRange(range), false, range)
    }
  })
})
