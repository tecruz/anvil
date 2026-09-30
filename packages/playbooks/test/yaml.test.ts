import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { parseYamlSubset, YamlError } from '@anvil/playbooks'

/**
 * The YAML subset is load-bearing: a misparse would point an agent at the wrong
 * technology guidance with full confidence. These tests cover the accepted subset and,
 * more importantly, assert that everything *outside* it is rejected rather than
 * approximated.
 */

function parse(text: string): unknown {
  return parseYamlSubset(text)
}

function expectRejection(text: string, pattern: RegExp): void {
  assert.throws(
    () => parse(text),
    (err: unknown) => {
      assert.ok(err instanceof YamlError, `expected YamlError, got ${String(err)}`)
      assert.match(err.message, pattern)
      return true
    },
  )
}

describe('scalars', () => {
  test('parses strings, numbers, booleans and nulls', () => {
    assert.deepEqual(parse('a: hello'), { a: 'hello' })
    assert.deepEqual(parse('a: 42'), { a: 42 })
    assert.deepEqual(parse('a: 3.5'), { a: 3.5 })
    assert.deepEqual(parse('a: true'), { a: true })
    assert.deepEqual(parse('a: false'), { a: false })
    assert.deepEqual(parse('a: null'), { a: null })
    assert.deepEqual(parse('a: ~'), { a: null })
  })

  test('an empty value is null', () => {
    assert.deepEqual(parse('a:'), { a: null })
  })

  test('preserves version-like strings as strings', () => {
    assert.deepEqual(parse('v: 1.2.3'), { v: '1.2.3' })
  })

  test('handles single and double quotes', () => {
    assert.deepEqual(parse(`a: 'it''s fine'`), { a: "it's fine" })
    assert.deepEqual(parse('a: "line\\nbreak"'), { a: 'line\nbreak' })
  })

  test('a value containing a colon is not split', () => {
    assert.deepEqual(parse('a: https://example.com/x'), {
      a: 'https://example.com/x',
    })
  })
})

describe('comments', () => {
  test('drops full-line and trailing comments', () => {
    assert.deepEqual(parse('# lead\na: 1 # trailing\nb: 2'), { a: 1, b: 2 })
  })

  test('a hash inside quotes is not a comment', () => {
    assert.deepEqual(parse(`a: 'x # y'`), { a: 'x # y' })
    assert.deepEqual(parse('a: "x # y"'), { a: 'x # y' })
  })
})

describe('mappings', () => {
  test('parses nested mappings', () => {
    assert.deepEqual(parse('a:\n  b:\n    c: 1'), { a: { b: { c: 1 } } })
  })

  test('rejects a duplicate key rather than silently overwriting', () => {
    expectRejection('a: 1\na: 2', /duplicate key "a"/)
  })

  test('rejects a line that is not key: value', () => {
    expectRejection('just a bare string', /expected "key: value"/)
  })

  test('rejects inconsistent indentation', () => {
    expectRejection('a: 1\n   b: 2', /unexpected indentation/)
  })
})

describe('sequences', () => {
  test('parses a block sequence of scalars', () => {
    assert.deepEqual(parse('a:\n  - one\n  - two'), { a: ['one', 'two'] })
  })

  test('parses a sequence at the document root', () => {
    assert.deepEqual(parse('- one\n- two'), ['one', 'two'])
  })

  test('parses maps as sequence items', () => {
    assert.deepEqual(parse('items:\n  - name: a\n    why: b\n  - name: c'), {
      items: [{ name: 'a', why: 'b' }, { name: 'c' }],
    })
  })

  test('an empty sequence item is null', () => {
    assert.deepEqual(parse('a:\n  -\n  - two'), { a: [null, 'two'] })
  })
})

describe('flow collections', () => {
  test('parses inline sequences', () => {
    assert.deepEqual(parse('a: [1, 2, 3]'), { a: [1, 2, 3] })
    assert.deepEqual(parse('a: []'), { a: [] })
  })

  test('parses inline maps, including nested', () => {
    assert.deepEqual(parse('a: {x: 1, y: two}'), { a: { x: 1, y: 'two' } })
    assert.deepEqual(parse('a: {x: {z: 1}, y: 2}'), {
      a: { x: { z: 1 }, y: 2 },
    })
  })

  test('a comma inside quotes does not split an item', () => {
    assert.deepEqual(parse(`a: ['x, y', 'z']`), { a: ['x, y', 'z'] })
  })

  test('rejects an unterminated flow collection', () => {
    expectRejection('a: [1, 2', /unterminated flow sequence/)
    expectRejection('a: {x: 1', /unterminated flow mapping/)
  })

  test('rejects an unterminated quote', () => {
    expectRejection(`a: 'x`, /unterminated quoted string/)
    expectRejection(`a: ['x]`, /unterminated quote in flow collection/)
  })
})

describe('block scalars', () => {
  test('literal keeps newlines', () => {
    const value = parse('a: |\n  one\n  two') as { a: string }
    assert.equal(value.a, 'one\ntwo\n')
  })

  test('folded joins lines', () => {
    const value = parse('a: >\n  one\n  two') as { a: string }
    assert.equal(value.a, 'one two\n')
  })

  test('strips the trailing newline with a chomping indicator', () => {
    const value = parse('a: |-\n  one\n  two') as { a: string }
    assert.equal(value.a, 'one\ntwo')
  })

  test('block scalars end at the first less-indented line', () => {
    const value = parse('a: |\n  one\nb: 2') as { a: string; b: number }
    assert.equal(value.a, 'one\n')
    assert.equal(value.b, 2)
  })
})

describe('rejected constructs', () => {
  test('rejects tab indentation', () => {
    expectRejection('a:\n\tb: 1', /tab characters/)
  })

  test('rejects anchors, aliases and tags', () => {
    expectRejection('a: &anchor 1', /not supported/)
    expectRejection('a: *alias', /not supported/)
  })

  test('reports the line number of the failure', () => {
    try {
      parse('a: 1\nb: 2\nc: [1')
      assert.fail('expected a throw')
    } catch (err) {
      assert.ok(err instanceof YamlError)
      assert.equal(err.line, 3)
    }
  })
})

describe('realistic playbook shape', () => {
  const text = `
# Seed playbook
id: node
title: Node / TypeScript
priority: 60

match:
  files: ['package.json']
  deps: ['typescript', /^react/]

official:
  docs:
    - { label: 'Node docs', url: 'https://nodejs.org/docs' }
  skills:
    - label: TypeScript handbook
      url: 'https://www.typescriptlang.org/docs/'
      why: |
        Official language reference. Covers
        generics and narrowing well.

verify:
  build: ['npm run build']
  testFast: ['npm run test:changed']

riskGlobs: ['**/package.json']
`

  test('parses a full playbook document', () => {
    const p = parse(text) as Record<string, unknown>
    assert.equal(p.id, 'node')
    assert.equal(p.title, 'Node / TypeScript')
    assert.equal(p.priority, 60)
    assert.deepEqual((p.match as { files: string[] }).files, ['package.json'])
    assert.deepEqual((p.official as { docs: Array<{ label: string }> }).docs[0]?.label, 'Node docs')
    assert.equal(
      (p.official as { skills: Array<{ why: string }> }).skills[0]?.why,
      'Official language reference. Covers\ngenerics and narrowing well.\n',
    )
    assert.deepEqual((p.verify as { testFast: string[] }).testFast, ['npm run test:changed'])
    assert.deepEqual(p.riskGlobs, ['**/package.json'])
  })
})
