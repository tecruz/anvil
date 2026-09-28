import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AnvilError,
  ErrorCode,
  defaultConfig,
  globalConfigPath,
  loadConfig,
  mergeConfig,
  repoConfigPath,
} from '@anvil/core'

function tempDir(prefix = 'anvil-config-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('globalConfigPath', () => {
  test('uses ANVIL_CONFIG_HOME when set', () => {
    const p = globalConfigPath({ ANVIL_CONFIG_HOME: 'C:/custom' })
    assert.equal(p, join('C:/custom', 'anvil.config.json').replace(/\\/g, '\\'))
  })

  test('ignores an empty ANVIL_CONFIG_HOME', () => {
    const p = globalConfigPath({ ANVIL_CONFIG_HOME: '' })
    assert.ok(p.endsWith(join('.anvil', 'anvil.config.json')))
  })
})

describe('mergeConfig', () => {
  test('returns defaults unchanged for an empty layer', () => {
    const base = defaultConfig()
    assert.deepEqual(mergeConfig(base, {}, 'test'), base)
  })

  test('does not mutate the base config', () => {
    const base = defaultConfig()
    const next = mergeConfig(base, { provider: { default: 'github' } }, 'test')
    assert.equal(base.provider.default, 'local')
    assert.equal(next.provider.default, 'github')
  })

  test('overrides only the keys present in the layer', () => {
    const next = mergeConfig(defaultConfig(), { output: { color: 'never' } }, 'test')
    assert.equal(next.output.color, 'never')
    assert.equal(next.provider.default, 'local')
  })

  test('a layer that sets one key does not require its siblings', () => {
    // Regression: validating every key in a section made a partial config impossible.
    // `{ "git": { "defaultBaseBranch": "main" } }` must be valid on its own.
    const next = mergeConfig(defaultConfig(), { git: { defaultBaseBranch: 'main' } }, 'cfg')
    assert.equal(next.git.defaultBaseBranch, 'main')
    assert.equal(next.git.worktreeRoot, null, 'sibling keeps its default')
  })

  test('every section accepts a partial layer', () => {
    assert.doesNotThrow(() => mergeConfig(defaultConfig(), { provider: { default: 'github' } }, 'cfg'))
    assert.doesNotThrow(() => mergeConfig(defaultConfig(), { output: { color: 'never' } }, 'cfg'))
    assert.doesNotThrow(() => mergeConfig(defaultConfig(), { features: { probeCommands: true } }, 'cfg'))
    assert.doesNotThrow(() => mergeConfig(defaultConfig(), { git: { worktreeRoot: '/tmp/wt' } }, 'cfg'))
  })

  test('accepts explicit nulls', () => {
    const next = mergeConfig(defaultConfig(), { git: { defaultBaseBranch: null } }, 'test')
    assert.equal(next.git.defaultBaseBranch, null)
  })

  test('rejects unknown top-level keys', () => {
    assert.throws(
      () => mergeConfig(defaultConfig(), { nope: true }, '/tmp/anvil.config.json'),
      (err: unknown) => {
        assert.ok(err instanceof AnvilError)
        assert.equal(err.code, ErrorCode.ConfigInvalid)
        assert.match(err.message, /nope: unknown configuration key/)
        assert.match(err.message, /\/tmp\/anvil\.config\.json/)
        return true
      },
    )
  })

  test('rejects unknown nested keys with a dotted path', () => {
    assert.throws(
      () => mergeConfig(defaultConfig(), { git: { branch: 'main' } }, 'cfg'),
      (err: unknown) => {
        assert.ok(err instanceof AnvilError)
        assert.match(err.message, /git\.branch: unknown configuration key/)
        return true
      },
    )
  })

  test('rejects wrong types with the offending path', () => {
    assert.throws(
      () => mergeConfig(defaultConfig(), { features: { probeCommands: 'yes' } }, 'cfg'),
      (err: unknown) => {
        assert.ok(err instanceof AnvilError)
        assert.match(err.message, /features\.probeCommands: expected a boolean/)
        return true
      },
    )
  })

  test('rejects an unsupported schemaVersion', () => {
    assert.throws(
      () => mergeConfig(defaultConfig(), { schemaVersion: 2 }, 'cfg'),
      (err: unknown) => {
        assert.ok(err instanceof AnvilError)
        assert.match(err.message, /schemaVersion: unsupported schemaVersion/)
        return true
      },
    )
  })

  test('rejects an out-of-range enum', () => {
    assert.throws(
      () => mergeConfig(defaultConfig(), { output: { color: 'rainbow' } }, 'cfg'),
      (err: unknown) => {
        assert.ok(err instanceof AnvilError)
        assert.match(err.message, /output\.color: expected one of: auto, always, never/)
        return true
      },
    )
  })

  test('reports every problem at once rather than the first', () => {
    assert.throws(
      () => mergeConfig(defaultConfig(), { nope: 1, alsoNope: 2, output: { color: 7 } }, 'cfg'),
      (err: unknown) => {
        assert.ok(err instanceof AnvilError)
        assert.match(err.message, /nope/)
        assert.match(err.message, /alsoNope/)
        assert.match(err.message, /output\.color/)
        return true
      },
    )
  })

  test('an invalid layer is not partially applied', () => {
    // A typo in one key must not leave the others half-merged.
    assert.throws(() => mergeConfig(defaultConfig(), { provider: { default: 'github' }, git: { bad: 1 } }, 'cfg'))
    const fresh = defaultConfig()
    assert.equal(fresh.provider.default, 'local')
  })
})

describe('loadConfig', () => {
  test('returns defaults with no files present', () => {
    const dir = tempDir()
    const resolved = loadConfig({ repoRoot: dir, env: { ANVIL_CONFIG_HOME: join(dir, 'absent') } })
    assert.deepEqual(resolved.config, defaultConfig())
    assert.deepEqual(
      resolved.sources.map((s) => s.kind),
      ['global', 'repo', 'default'],
    )
    assert.equal(resolved.sources[0]?.present, false)
    assert.equal(resolved.sources[1]?.present, false)
    assert.equal(resolved.sources[2]?.present, true)
  })

  test('repo layer wins over global layer', () => {
    const home = tempDir()
    const repo = tempDir()

    writeFileSync(
      join(home, 'anvil.config.json'),
      JSON.stringify({ provider: { default: 'github' }, output: { color: 'always' } }),
    )
    writeFileSync(join(repo, 'anvil.config.json'), JSON.stringify({ provider: { default: 'local' } }))

    const resolved = loadConfig({ repoRoot: repo, env: { ANVIL_CONFIG_HOME: home } })
    assert.equal(resolved.config.provider.default, 'local', 'repo should win')
    assert.equal(resolved.config.output.color, 'always', 'global should survive where repo is silent')
  })

  test('records which files were present', () => {
    const home = tempDir()
    const repo = tempDir()
    writeFileSync(join(home, 'anvil.config.json'), JSON.stringify({ provider: { default: 'github' } }))

    const resolved = loadConfig({ repoRoot: repo, env: { ANVIL_CONFIG_HOME: home } })
    assert.equal(resolved.sources[0]?.present, true)
    assert.equal(resolved.sources[1]?.present, false)
  })

  test('omits the repo layer when no repoRoot is given', () => {
    const home = tempDir()
    const resolved = loadConfig({ env: { ANVIL_CONFIG_HOME: home } })
    assert.deepEqual(
      resolved.sources.map((s) => s.kind),
      ['global', 'default'],
    )
  })

  test('invalid JSON is a config error, not a crash', () => {
    const home = tempDir()
    writeFileSync(join(home, 'anvil.config.json'), '{ not json')
    assert.throws(
      () => loadConfig({ env: { ANVIL_CONFIG_HOME: home } }),
      (err: unknown) => {
        assert.ok(err instanceof AnvilError)
        assert.equal(err.code, ErrorCode.ConfigInvalid)
        return true
      },
    )
  })

  test('a JSON array is rejected as not-an-object', () => {
    const home = tempDir()
    writeFileSync(join(home, 'anvil.config.json'), '[]')
    assert.throws(() => loadConfig({ env: { ANVIL_CONFIG_HOME: home } }), AnvilError)
  })

  test('repoConfigPath points inside the repo', () => {
    assert.equal(repoConfigPath('/tmp/x'), join('/tmp/x', 'anvil.config.json'))
  })

  test('works with no files and no repo at all', () => {
    const home = tempDir()
    mkdirSync(join(home, 'nested'), { recursive: true })
    const resolved = loadConfig({ env: { ANVIL_CONFIG_HOME: join(home, 'nested') } })
    assert.deepEqual(resolved.config, defaultConfig())
  })
})
