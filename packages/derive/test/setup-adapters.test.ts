import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { AnvilError, ErrorCode } from '@anvil/core'
import {
  buildSetupExecutionPlan,
  findSetupAdapterForPlan,
  LOCAL_SKILL_ADAPTER,
  LOCAL_SKILL_ADAPTER_FINGERPRINT,
  resolveSetupAdapter,
  resolveSetupExecutionPlan,
  resolveSetupPlan,
  SETUP_ADAPTERS,
  type SetupRepositoryState,
  setupAdapterList,
} from '@anvil/derive'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'anvil-adapters-'))
  roots.push(root)
  return root
}
function repository(root: string): SetupRepositoryState {
  return { root, head: 'a'.repeat(40), worktree: 'clean' }
}
function skill(name = 'my-skill', body = 'Do the thing.\n'): string {
  return `---\nname: ${name}\ndescription: A test skill for ${name}.\n---\n\n# ${name}\n\n${body}`
}
function fixture(): { root: string; plan: ReturnType<typeof buildSetupExecutionPlan> } {
  const root = scratch()
  const target = join(root, 'skill.md')
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, skill())
  return {
    root,
    plan: buildSetupExecutionPlan({ repository: repository(root), sourcePath: 'skill.md', name: 'my-skill' }),
  }
}

/**
 * The fingerprint is the contract that an approval survives only the adapter behaviour it was
 * issued against. Pin it so an accidental descriptor edit cannot silently keep old grants
 * valid; changing behaviour must update this test in the same commit.
 */
const LOCAL_SKILL_GOLDEN_FINGERPRINT = 'ac1833e3296de3741102254ff899e371d89e692dc2f87dbdc90436651aeaca2d'

describe('setup adapter registry', () => {
  test('the registry is a closed list and every entry is internally consistent', () => {
    assert.deepEqual([...SETUP_ADAPTERS], ['local-skill', 'pinned-skill'])
    assert.equal(setupAdapterList(), 'local-skill, pinned-skill')
    const adapter = resolveSetupAdapter('local-skill')
    assert.equal(adapter.id, LOCAL_SKILL_ADAPTER)
    assert.equal(adapter.cliName, 'local-skill')
    assert.equal(adapter.fingerprint, LOCAL_SKILL_ADAPTER_FINGERPRINT)
    assert.equal(LOCAL_SKILL_ADAPTER_FINGERPRINT, LOCAL_SKILL_GOLDEN_FINGERPRINT)
  })

  test('an unknown adapter is a usage error that names what is supported', () => {
    assert.throws(
      () => resolveSetupAdapter('mcp-config'),
      (error: unknown) =>
        error instanceof AnvilError &&
        error.code === ErrorCode.Usage &&
        /Unsupported setup adapter/.test(error.message) &&
        /pinned-skill/.test(error.hint ?? ''),
    )
  })

  test('the local-skill plan envelope and digest are unchanged by the registry', () => {
    const { root, plan } = fixture()
    const adapter = resolveSetupAdapter('local-skill')
    const rebuilt = adapter.build(repository(root), adapter.parseRequest({ source: 'skill.md', name: 'my-skill' }))
    assert.deepEqual(rebuilt, plan)
    assert.deepEqual(Object.keys(plan).sort(), [
      'adapter',
      'adapterFingerprint',
      'approval',
      'digest',
      'effects',
      'executed',
      'executionSupported',
      'inputsDigest',
      'kind',
      'operations',
      'repository',
      'schemaVersion',
      'skill',
      'source',
      'status',
      'verification',
      'warnings',
    ])
    assert.deepEqual(adapter.operations(plan), plan.operations)
    assert.deepEqual(adapter.extractRequest(JSON.parse(JSON.stringify(plan))), {
      adapter: LOCAL_SKILL_ADAPTER,
      name: 'my-skill',
      sourcePath: 'skill.md',
    })
  })

  test('adapter input validation stays strict and names the missing flag', () => {
    const adapter = resolveSetupAdapter('local-skill')
    for (const values of [
      {},
      { name: 'my-skill' },
      { source: 'skill.md' },
      { source: '', name: 'my-skill' },
      { source: 'skill.md', name: '' },
    ]) {
      assert.throws(
        () => adapter.parseRequest(values),
        (error: unknown) => error instanceof AnvilError && error.code === ErrorCode.Usage,
      )
    }
  })

  test('plan resolution dispatches through the registry and unknown adapters are invalid', () => {
    const { root, plan } = fixture()
    const saved = JSON.parse(JSON.stringify(plan))
    assert.deepEqual(resolveSetupPlan(saved, repository(root)), resolveSetupExecutionPlan(saved, repository(root)))
    assert.equal(resolveSetupPlan(saved, repository(root)).validation.status, 'current')

    for (const unknown of [
      { ...saved, adapter: 'other/v1' },
      { ...saved, adapter: 'local-skill/v2' },
      { ...saved, adapter: undefined },
      { ...saved, adapter: 7 },
      null,
      [],
    ]) {
      assert.equal(resolveSetupPlan(unknown, repository(root)).validation.status, 'invalid')
      assert.equal(findSetupAdapterForPlan(unknown), null)
    }
  })
})
