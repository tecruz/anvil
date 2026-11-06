import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, test } from 'node:test'
import { AnvilError, defaultConfig, type ProjectConfig } from '@anvil/core'
import { buildSetupPlan, type SetupRepositoryState, validateSetupPlan } from '@anvil/derive'

const repository: SetupRepositoryState = { root: '/repo', head: 'a'.repeat(40), worktree: 'clean' }
function config(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return { ...defaultConfig().project, ...overrides }
}
function plan(declared = config(), state = repository, projectDir = '') {
  return buildSetupPlan({ repository: state, declared, projectDir })
}

/** Test-side canonicalization, also used to model an attacker recomputing a digest. */
function recanonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(recanonicalize)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [key, recanonicalize(entry)]),
  )
}
function rehash(value: object): Record<string, unknown> {
  const { digest: _digest, ...payload } = value as Record<string, unknown>
  return {
    ...payload,
    digest: createHash('sha256')
      .update(JSON.stringify(recanonicalize(payload)))
      .digest('hex'),
  }
}

describe('setup proposals', () => {
  test('only owner install commands are proposed, unchanged, with their directory and provenance', () => {
    const result = plan(
      config({
        commands: [
          { kind: 'test', cmd: 'never run this' },
          { kind: 'install', cmd: 'npm ci && echo "$TOKEN"', dir: 'app' },
        ],
        tools: [{ id: 'make' }, { id: 'sdk', version: '^1.2', install: 'company-install sdk@1.2.3', required: false }],
      }),
      repository,
      'default-dir',
    )
    assert.equal(result.status, 'proposed')
    assert.equal(result.approval, 'not-granted')
    assert.equal(result.executionSupported, false)
    assert.equal(result.executed, false)
    assert.equal(result.actions.length, 2)
    assert.equal(result.actions[0]?.source, 'project.commands[1]')
    assert.equal(result.actions[0]?.command, 'npm ci && echo "$TOKEN"')
    assert.equal(result.actions[0]?.cwd, 'app')
    assert.equal(result.actions[1]?.source, 'project.tools[1].install')
    assert.equal(result.actions[1]?.cwd, 'default-dir')
    assert.equal(result.actions[1]?.versionRange, '^1.2')
    assert.equal(result.actions[1]?.required, false)
    for (const action of result.actions) {
      assert.equal(action.permissions, null)
      assert.equal(action.fileChanges, null)
      assert.equal(action.immutableRef, null)
      assert.equal(action.verification, 'not-run')
      assert.equal(action.requiresApproval, true)
    }
  })

  test('an empty declaration never invents commands', () => {
    const result = plan()
    assert.deepEqual(result.actions, [])
    assert.match(result.warnings.join('\n'), /No owner-declared install commands/)
  })

  test('alternative install commands retain the same primary/optional distinction as readiness', () => {
    const result = plan(
      config({
        commands: [
          { kind: 'install', cmd: 'npm ci' },
          { kind: 'install', cmd: 'alternative installer' },
        ],
      }),
    )
    assert.deepEqual(
      result.actions.map((action) => action.required),
      [true, false],
    )
  })

  test('plans are deterministic, independent of object key order, and round-trip as JSON', () => {
    const first = plan(config({ tools: [{ id: 'node', install: 'install node' }] }))
    const second = plan(config({ tools: [{ install: 'install node', id: 'node' }] }))
    assert.deepEqual(first, second)
    assert.match(first.digest, /^[a-f0-9]{64}$/)
    assert.equal(validateSetupPlan(JSON.parse(JSON.stringify(first)), second).status, 'current')
    const reordered = Object.fromEntries(Object.entries(first).reverse())
    assert.equal(validateSetupPlan(reordered, second).status, 'current')
  })

  test('mutating source declarations or repository state cannot silently change a built plan', () => {
    const state = { ...repository }
    const declared = config({ tools: [{ id: 'node', install: 'install node' }] })
    const result = plan(declared, state)
    declared.tools[0]!.install = 'changed'
    state.head = 'b'.repeat(40)
    assert.equal(result.actions[0]?.command, 'install node')
    assert.equal(result.repository.head, repository.head)
    assert.equal(validateSetupPlan(result, result).status, 'current')
  })

  test('altered contents without a matching digest are invalid', () => {
    const result = plan(config({ commands: [{ kind: 'install', cmd: 'original' }] }))
    const changed = structuredClone(result)
    changed.actions[0]!.command = 'changed'
    assert.equal(validateSetupPlan(changed, result).status, 'invalid')
  })

  test('recomputed digests cannot authorize different commands, unknown fields or forged approval', () => {
    const result = plan(config({ commands: [{ kind: 'install', cmd: 'original' }] }))
    const changed = structuredClone(result)
    changed.actions[0]!.command = 'changed'
    for (const saved of [
      rehash(changed),
      rehash({ ...result, approved: true }),
      rehash({ ...result, approval: 'granted' }),
    ]) {
      const validation = validateSetupPlan(saved, result)
      assert.notEqual(validation.status, 'current')
      assert.equal(validation.approval, 'not-granted')
      assert.equal(validation.executed, false)
    }
  })

  test('a moved repository, new HEAD, changed requirements or changed working directory invalidates the plan', () => {
    const declared = config({ tools: [{ id: 'node', install: 'install node', version: '^22' }] })
    const saved = plan(declared)
    for (const current of [
      plan(declared, { ...repository, root: '/other-repo' }),
      plan(declared, { ...repository, head: 'b'.repeat(40) }),
      plan(config({ tools: [{ id: 'node', install: 'install node', version: '^24' }] })),
      plan(declared, repository, 'app'),
      plan({ ...declared, env: [{ name: 'NEW_REQUIREMENT' }] }),
    ]) {
      assert.equal(validateSetupPlan(saved, current).status, 'stale')
    }
  })

  test('dirty, missing-HEAD and unknown repository state never validates as current', () => {
    for (const state of [
      { ...repository, worktree: 'dirty' as const },
      { ...repository, worktree: 'unknown' as const },
      { ...repository, head: null },
    ]) {
      const proposal = plan(config(), state)
      const validation = validateSetupPlan(proposal, proposal)
      assert.equal(validation.status, 'unknown')
      assert.equal(validation.approval, 'not-granted')
      assert.match(proposal.warnings.join('\n'), /not a clean commit/)
    }
  })

  test('malformed JSON values, unsupported versions, envelopes and deep data are rejected', () => {
    const current = plan()
    let deep: unknown = null
    for (let i = 0; i < 55; i++) deep = [deep]
    for (const saved of [
      null,
      [],
      { data: current },
      { ...current, schemaVersion: 2 },
      { ...current, digest: 'wrong' },
      { ...current, extra: deep },
      { ...current, extra: undefined },
    ]) {
      assert.equal(validateSetupPlan(saved, current).status, 'invalid')
    }
  })

  test('directories cannot request parent traversal, an absolute location or a drive', () => {
    for (const dir of [
      '../outside',
      'app/../../outside',
      '/tmp',
      '\\server\\share',
      'C:tools',
      'C:\\tools',
      'bad\0dir',
    ]) {
      assert.throws(() => plan(config({ commands: [{ kind: 'install', cmd: 'install', dir }] })), AnvilError)
    }
    assert.equal(
      plan(config({ commands: [{ kind: 'install', cmd: 'install', dir: './app' }] })).actions[0]?.cwd,
      './app',
    )
  })
})
