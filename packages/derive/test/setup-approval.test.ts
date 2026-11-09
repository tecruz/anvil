import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { AnvilError } from '@anvil/core'
import {
  approvalStoreDir,
  buildSetupApprovalGrant,
  buildSetupExecutionPlan,
  consumeSetupApproval,
  gradeSetupApprovalGrant,
  inspectSetupApproval,
  LOCAL_SKILL_ADAPTER,
  readSetupApprovalGrant,
  revokeSetupApproval,
  SETUP_APPROVAL_TTL_MS,
  type SetupRepositoryState,
  saveSetupApprovalGrant,
  setupApprovalOperationsDigest,
} from '@anvil/derive'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})
function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}
function repository(root: string, overrides: Partial<SetupRepositoryState> = {}): SetupRepositoryState {
  return { root, head: 'a'.repeat(40), worktree: 'clean', ...overrides }
}
function skill(name = 'my-skill', body = 'Do the thing.\n'): string {
  return `---\nname: ${name}\ndescription: A test skill for ${name}.\n---\n\n# ${name}\n\n${body}`
}
function write(root: string, path: string, content: string): void {
  const target = join(root, ...path.split('/'))
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, content)
}
function planFor(root: string, name = 'my-skill') {
  write(root, 'skill.md', skill(name))
  return buildSetupExecutionPlan({ repository: repository(root), sourcePath: 'skill.md', name })
}
/** A repository scratch dir plus an approval store that lives outside it. */
function fixture(): { repo: string; store: string; env: NodeJS.ProcessEnv } {
  const repo = scratch('anvil-approval-repo-')
  const store = scratch('anvil-approval-store-')
  return { repo, store, env: { ...process.env, ANVIL_APPROVAL_HOME: store } }
}

const ID = '11111111-2222-4333-8444-555555555555'
const ID2 = '99999999-8888-4777-8666-555555555555'
const T0 = new Date('2026-11-09T12:00:00.000Z')
const TTL = 10 * 60 * 1000

describe('setup approval grants', () => {
  test('the store is a dedicated user-owned location, not the config home', () => {
    const empty = approvalStoreDir({})
    assert.match(empty.replace(/\\/g, '/'), /\/\.anvil\/approvals\/setup\/v1$/)
    // The config home is deliberately irrelevant: a repository-configured location must not
    // be able to choose where its own authority lives.
    assert.equal(approvalStoreDir({ ANVIL_CONFIG_HOME: join('somewhere', 'else') }), empty)
    assert.ok(
      approvalStoreDir({ ANVIL_APPROVAL_HOME: join('tmp', 'custom') })
        .replace(/\\/g, '/')
        .endsWith('tmp/custom'),
    )
  })

  test('an approved plan becomes an active, single-attempt grant bound to the plan', () => {
    const { repo, env } = fixture()
    const plan = planFor(repo)
    const grant = buildSetupApprovalGrant(plan, { now: T0, ttlMs: TTL, id: ID })
    assert.equal(grant.kind, 'setup-approval-grant')
    assert.equal(grant.permission, 'apply-local-skill-once')
    assert.equal(grant.adapter, LOCAL_SKILL_ADAPTER)
    assert.equal(grant.planDigest, plan.digest)
    assert.equal(grant.adapterFingerprint, plan.adapterFingerprint)
    assert.equal(grant.operationsDigest, setupApprovalOperationsDigest(plan))
    assert.equal(grant.repository.root, plan.repository.root)
    assert.equal(grant.repository.head, plan.repository.head)
    assert.equal(grant.source.sha256, plan.source.sha256)
    assert.equal(grant.skill.destination, '.agents/skills/my-skill/SKILL.md')
    assert.equal(grant.maxAttempts, 1)
    assert.equal(grant.issuedAt, T0.toISOString())
    assert.equal(grant.expiresAt, new Date(T0.getTime() + TTL).toISOString())

    saveSetupApprovalGrant(grant, { env })
    const read = readSetupApprovalGrant(ID, { env })
    assert.equal(read.ok, true)
    const record = inspectSetupApproval(ID, repository(repo), { env, now: new Date(T0.getTime() + 1000) })
    assert.equal(record.status, 'active')
    assert.equal(record.grant?.planDigest, plan.digest)
    assert.equal(record.executed, false)
    assert.equal(record.executionSupported, false)
  })

  test('a changed source, a new HEAD or a different repository makes a grant stale', () => {
    const { repo, env } = fixture()
    const plan = planFor(repo)
    saveSetupApprovalGrant(buildSetupApprovalGrant(plan, { now: T0, ttlMs: TTL, id: ID }), { env })
    const now = new Date(T0.getTime() + 1000)
    assert.equal(inspectSetupApproval(ID, repository(repo), { env, now }).status, 'active')

    write(repo, 'skill.md', skill('my-skill', 'A different body.\n'))
    assert.equal(inspectSetupApproval(ID, repository(repo), { env, now }).status, 'stale')

    write(repo, 'skill.md', skill())
    assert.equal(inspectSetupApproval(ID, repository(repo), { env, now }).status, 'active')
    assert.equal(inspectSetupApproval(ID, repository(repo, { head: 'b'.repeat(40) }), { env, now }).status, 'stale')

    const other = scratch('anvil-approval-other-')
    assert.equal(inspectSetupApproval(ID, repository(other), { env, now }).status, 'stale')
    // A dirty or headless current state cannot be checked, and is never called active.
    assert.equal(inspectSetupApproval(ID, repository(repo, { worktree: 'dirty' }), { env, now }).status, 'unknown')
    assert.equal(inspectSetupApproval(ID, repository(repo, { head: null }), { env, now }).status, 'unknown')
  })

  test('an expired grant is reported as expired, even without a repository', () => {
    const { repo, env } = fixture()
    const plan = planFor(repo)
    saveSetupApprovalGrant(buildSetupApprovalGrant(plan, { now: T0, ttlMs: 60_000, id: ID }), { env })
    assert.equal(
      inspectSetupApproval(ID, repository(repo), { env, now: new Date(T0.getTime() + 30_000) }).status,
      'active',
    )
    assert.equal(
      inspectSetupApproval(ID, repository(repo), { env, now: new Date(T0.getTime() + 60_000) }).status,
      'expired',
    )
    assert.equal(inspectSetupApproval(ID, null, { env, now: new Date(T0.getTime() + 90_000) }).status, 'expired')
  })

  test('revocation is terminal and idempotent; a consumed grant cannot be revoked', () => {
    const { repo, env } = fixture()
    const plan = planFor(repo)
    const at = new Date(T0.getTime() + 1000)
    saveSetupApprovalGrant(buildSetupApprovalGrant(plan, { now: T0, ttlMs: TTL, id: ID }), { env })
    assert.equal(revokeSetupApproval(ID, { env }).status, 'revoked')
    assert.equal(revokeSetupApproval(ID, { env }).status, 'revoked')
    assert.equal(inspectSetupApproval(ID, repository(repo), { env, now: at }).status, 'revoked')

    saveSetupApprovalGrant(buildSetupApprovalGrant(plan, { now: T0, ttlMs: TTL, id: ID2 }), { env })
    assert.equal(consumeSetupApproval(ID2, repository(repo), { env, now: at }).status, 'consumed')
    assert.equal(revokeSetupApproval(ID2, { env }).status, 'consumed')
    assert.equal(inspectSetupApproval(ID2, repository(repo), { env, now: at }).status, 'consumed')
  })

  test('the single attempt is reserved only from an active grant', () => {
    const { repo, env } = fixture()
    const plan = planFor(repo)
    saveSetupApprovalGrant(buildSetupApprovalGrant(plan, { now: T0, ttlMs: 1_000, id: ID }), { env })
    const late = new Date(T0.getTime() + 5_000)
    assert.equal(consumeSetupApproval(ID, repository(repo), { env, now: late }).status, 'expired')
    // A refused reservation leaves no attempt marker behind.
    assert.equal(inspectSetupApproval(ID, repository(repo), { env, now: late }).status, 'expired')
  })

  test('malformed ids throw and unknown ids are invalid, never active', () => {
    const { env } = fixture()
    assert.throws(() => readSetupApprovalGrant('../escape', { env }), AnvilError)
    assert.throws(() => inspectSetupApproval('not-a-uuid', null, { env }), AnvilError)
    const missing = inspectSetupApproval(ID, null, { env })
    assert.equal(missing.status, 'invalid')
    assert.equal(missing.grant, null)
  })

  test('a tampered or forged record is not active', () => {
    const { repo, env, store } = fixture()
    const plan = planFor(repo)
    const at = new Date(T0.getTime() + 1000)
    saveSetupApprovalGrant(buildSetupApprovalGrant(plan, { now: T0, ttlMs: TTL, id: ID }), { env })
    const grantFile = join(store, ID, 'grant.json')

    // A recomputed (forged) plan digest no longer matches the current plan.
    writeFileSync(
      grantFile,
      JSON.stringify({ ...buildSetupApprovalGrant(plan, { now: T0, id: ID }), planDigest: 'f'.repeat(64) }),
    )
    assert.equal(inspectSetupApproval(ID, repository(repo), { env, now: at }).status, 'stale')

    // A malformed shape and an id that does not match its directory are invalid.
    writeFileSync(grantFile, JSON.stringify({ ...plan, maxAttempts: 2 }))
    assert.equal(inspectSetupApproval(ID, repository(repo), { env, now: at }).status, 'invalid')
    writeFileSync(grantFile, JSON.stringify({ ...buildSetupApprovalGrant(plan, { now: T0, id: ID }), id: ID2 }))
    assert.equal(inspectSetupApproval(ID, repository(repo), { env, now: at }).status, 'invalid')
    writeFileSync(grantFile, 'not json')
    assert.equal(inspectSetupApproval(ID, repository(repo), { env, now: at }).status, 'invalid')
  })

  test('a link in the store never produces an active grant', (t) => {
    const repo = scratch('anvil-approval-repo-')
    const plan = planFor(repo)
    const realStore = scratch('anvil-approval-store-')
    const elsewhere = scratch('anvil-approval-elsewhere-')
    const grant = buildSetupApprovalGrant(plan, { now: T0, ttlMs: TTL, id: ID })

    // A symlinked store root is uninspectable.
    const linkParent = scratch('anvil-approval-link-')
    const storeLink = join(linkParent, 'store')
    try {
      symlinkSync(realStore, storeLink, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      t.skip('links are unavailable here')
      return
    }
    assert.equal(
      inspectSetupApproval(ID, null, { env: { ...process.env, ANVIL_APPROVAL_HOME: storeLink } }).status,
      'unknown',
    )

    // A symlinked grant directory is not trusted.
    writeFileSync(join(elsewhere, 'grant.json'), JSON.stringify(grant))
    const env: NodeJS.ProcessEnv = { ...process.env, ANVIL_APPROVAL_HOME: realStore }
    try {
      symlinkSync(elsewhere, join(realStore, ID), process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      t.skip('links are unavailable here')
      return
    }
    assert.equal(inspectSetupApproval(ID, null, { env }).status, 'unknown')

    // A symlinked grant file is refused as unreadable.
    const store2 = scratch('anvil-approval-store2-')
    mkdirSync(join(store2, ID2))
    try {
      symlinkSync(join(elsewhere, 'grant.json'), join(store2, ID2, 'grant.json'))
    } catch {
      t.skip('file symlinks are unavailable here')
      return
    }
    assert.equal(
      inspectSetupApproval(ID2, null, { env: { ...process.env, ANVIL_APPROVAL_HOME: store2 } }).status,
      'invalid',
    )
  })

  test('saving refuses a store inside the repository it approves', () => {
    const repo = scratch('anvil-approval-repo-')
    const plan = planFor(repo)
    const grant = buildSetupApprovalGrant(plan, { now: T0, ttlMs: TTL, id: ID })
    assert.throws(
      () => saveSetupApprovalGrant(grant, { env: { ANVIL_APPROVAL_HOME: join(repo, '.approvals') } }),
      AnvilError,
    )
  })

  test('saving writes only to the store, never into the repository', () => {
    const { repo, env, store } = fixture()
    const plan = planFor(repo)
    const before = readdirSync(repo).sort()
    saveSetupApprovalGrant(buildSetupApprovalGrant(plan, { now: T0, ttlMs: TTL, id: ID }), { env })
    assert.deepEqual(readdirSync(repo).sort(), before)
    assert.ok(readdirSync(join(store, ID)).includes('grant.json'))
  })

  test('a grant is never built from a dirty or headless plan', () => {
    const { repo } = fixture()
    const plan = planFor(repo)
    assert.throws(
      () => buildSetupApprovalGrant({ ...plan, repository: { ...plan.repository, head: null } }),
      AnvilError,
    )
    assert.throws(
      () => buildSetupApprovalGrant({ ...plan, repository: { ...plan.repository, worktree: 'dirty' } }),
      AnvilError,
    )
  })

  test('grading compares the grant against a rebuilt plan field by field', () => {
    const { repo } = fixture()
    const plan = planFor(repo)
    const grant = buildSetupApprovalGrant(plan, { now: T0, ttlMs: TTL, id: ID })
    assert.equal(gradeSetupApprovalGrant(grant, plan).ok, true)
    assert.equal(gradeSetupApprovalGrant({ ...grant, adapterFingerprint: 'a'.repeat(64) }, plan).status, 'stale')
    assert.equal(gradeSetupApprovalGrant({ ...grant, planDigest: 'b'.repeat(64) }, plan).status, 'stale')
  })

  test('the default lifetime is the documented ten minutes', () => {
    const { repo } = fixture()
    const plan = planFor(repo)
    const grant = buildSetupApprovalGrant(plan, { now: T0, id: ID })
    assert.equal(Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt), SETUP_APPROVAL_TTL_MS)
  })
})
