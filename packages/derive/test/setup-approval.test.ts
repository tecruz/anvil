import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
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
  inspectSetupApprovalTransition,
  isTrustedRootAlias,
  LOCAL_SKILL_ADAPTER,
  prepareSetupApprovalStore,
  readGrantRecord,
  readSetupApprovalGrant,
  readSetupApprovalTransition,
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
/** A repository scratch dir plus a prepared, private approval store that lives outside it. */
function fixture(): { repo: string; store: string; env: NodeJS.ProcessEnv } {
  const repo = scratch('anvil-approval-repo-')
  const store = scratch('anvil-approval-store-')
  const env: NodeJS.ProcessEnv = { ...process.env, ANVIL_APPROVAL_HOME: store }
  // Harden the store the same way a real grant would, so Windows ACL checks see a private
  // directory rather than the inherited temporary-directory ACL.
  prepareSetupApprovalStore(env)
  return { repo, store, env }
}

/** Run the system `icacls` by absolute path, so a repository checkout cannot shadow it. */
function icacls(...args: string[]): void {
  const path = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe')
  execFileSync(path, args, { windowsHide: true })
}
/** The raw SDDL export of an object's ACL, for comparing it before and after an operation. */
function aclDump(path: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'anvil-acl-'))
  roots.push(dir)
  const file = join(dir, 'acl.txt')
  icacls(path, '/save', file)
  return readFileSync(file, 'utf16le')
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
    assert.equal(record.executionSupported, true)
    // Without a current repository state, freshness cannot be checked, so it is never active.
    assert.equal(inspectSetupApproval(ID, null, { env, now: new Date(T0.getTime() + 2000) }).status, 'unknown')
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
    const reserved = consumeSetupApproval(ID2, repository(repo), { env, now: at })
    assert.equal(reserved.reserved, true)
    assert.equal(reserved.record.status, 'consumed')
    assert.equal(revokeSetupApproval(ID2, { env }).status, 'consumed')
    assert.equal(inspectSetupApproval(ID2, repository(repo), { env, now: at }).status, 'consumed')
    // A grant that was revoked before an attempt cannot be reserved.
    const afterRevoke = consumeSetupApproval(ID, repository(repo), { env, now: at })
    assert.equal(afterRevoke.reserved, false)
    assert.equal(afterRevoke.record.status, 'revoked')
  })

  test('the single attempt is reserved only once, and only from an active grant', () => {
    const { repo, env } = fixture()
    const plan = planFor(repo)
    saveSetupApprovalGrant(buildSetupApprovalGrant(plan, { now: T0, ttlMs: 1_000, id: ID }), { env })
    const late = new Date(T0.getTime() + 5_000)
    const expired = consumeSetupApproval(ID, repository(repo), { env, now: late })
    assert.equal(expired.reserved, false)
    assert.equal(expired.record.status, 'expired')
    // A refused reservation leaves no attempt record behind.
    assert.equal(inspectSetupApproval(ID, repository(repo), { env, now: late }).status, 'expired')

    saveSetupApprovalGrant(buildSetupApprovalGrant(plan, { now: T0, ttlMs: TTL, id: ID2 }), { env })
    const at = new Date(T0.getTime() + 1000)
    assert.equal(consumeSetupApproval(ID2, repository(repo), { env, now: at }).reserved, true)
    const again = consumeSetupApproval(ID2, repository(repo), { env, now: at })
    assert.equal(again.reserved, false)
    assert.equal(again.record.status, 'consumed')
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
    const valid = buildSetupApprovalGrant(plan, { now: T0, ttlMs: TTL, id: ID })
    saveSetupApprovalGrant(valid, { env })
    const grantFile = join(store, ID, 'grant.json')

    // A recomputed (forged) plan digest no longer matches the current plan.
    writeFileSync(grantFile, JSON.stringify({ ...valid, planDigest: 'f'.repeat(64) }))
    assert.equal(inspectSetupApproval(ID, repository(repo), { env, now: at }).status, 'stale')

    // A duplicated binding that disagrees with the plan is stale even when the digest is kept.
    writeFileSync(grantFile, JSON.stringify({ ...valid, source: { ...valid.source, bytes: valid.source.bytes + 1 } }))
    assert.equal(inspectSetupApproval(ID, repository(repo), { env, now: at }).status, 'stale')

    // An unknown field, a future issue time, a malformed shape and an id that does not match
    // its directory are all invalid rather than accepted.
    writeFileSync(grantFile, JSON.stringify({ ...valid, unexpected: true }))
    assert.equal(inspectSetupApproval(ID, repository(repo), { env, now: at }).status, 'invalid')
    const future = new Date(T0.getTime() + 86_400_000)
    writeFileSync(
      grantFile,
      JSON.stringify({
        ...valid,
        issuedAt: future.toISOString(),
        expiresAt: new Date(future.getTime() + TTL).toISOString(),
      }),
    )
    assert.equal(inspectSetupApproval(ID, repository(repo), { env, now: at }).status, 'invalid')
    writeFileSync(grantFile, JSON.stringify({ ...plan, maxAttempts: 2 }))
    assert.equal(inspectSetupApproval(ID, repository(repo), { env, now: at }).status, 'invalid')
    writeFileSync(grantFile, JSON.stringify({ ...valid, id: ID2 }))
    assert.equal(inspectSetupApproval(ID, repository(repo), { env, now: at }).status, 'invalid')
    writeFileSync(grantFile, 'not json')
    assert.equal(inspectSetupApproval(ID, repository(repo), { env, now: at }).status, 'invalid')
  })

  test('a store inside the repository it approves is never read as authority', () => {
    const repo = scratch('anvil-approval-repo-')
    const plan = planFor(repo)
    const at = new Date(T0.getTime() + 1000)
    const insideStore = join(repo, '.approvals')
    mkdirSync(join(insideStore, ID), { recursive: true })
    writeFileSync(
      join(insideStore, ID, 'grant.json'),
      JSON.stringify(buildSetupApprovalGrant(plan, { now: T0, ttlMs: TTL, id: ID })),
    )
    const env: NodeJS.ProcessEnv = { ...process.env, ANVIL_APPROVAL_HOME: insideStore }
    assert.equal(inspectSetupApproval(ID, repository(repo), { env, now: at }).status, 'unknown')
  })

  test('an uninspectable store and a link inside it are never active', (t) => {
    const repo = scratch('anvil-approval-repo-')
    const plan = planFor(repo)
    const realStore = scratch('anvil-approval-store-')
    prepareSetupApprovalStore({ ...process.env, ANVIL_APPROVAL_HOME: realStore })
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
    prepareSetupApprovalStore({ ...process.env, ANVIL_APPROVAL_HOME: store2 })
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

  test('saving refuses a store inside the repository before creating anything', () => {
    const repo = scratch('anvil-approval-repo-')
    const plan = planFor(repo)
    const grant = buildSetupApprovalGrant(plan, { now: T0, ttlMs: TTL, id: ID })
    assert.throws(
      () => saveSetupApprovalGrant(grant, { env: { ANVIL_APPROVAL_HOME: join(repo, '.approvals') } }),
      AnvilError,
    )
    // Containment is checked before the store is created, so a refusal leaves no directory.
    assert.equal(existsSync(join(repo, '.approvals')), false)
  })

  test('a store writable by group or other is refused on POSIX', (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX ownership and permission bits do not apply on Windows')
      return
    }
    const { repo, env, store } = fixture()
    const plan = planFor(repo)
    chmodSync(store, 0o777)
    const grant = buildSetupApprovalGrant(plan, { now: T0, ttlMs: TTL, id: ID })
    assert.throws(() => saveSetupApprovalGrant(grant, { env }), AnvilError)
    assert.equal(inspectSetupApproval(ID, null, { env }).status, 'unknown')
    // A refusal must not repair an existing store's permissions.
    assert.equal(statSync(store).mode & 0o777, 0o777)
  })

  test('an unwritable store location is a preflight failure, not an internal error', (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX permission bits only')
      return
    }
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      t.skip('root bypasses directory permissions')
      return
    }
    const locked = scratch('anvil-approval-locked-')
    const store = join(locked, 'store')
    chmodSync(locked, 0o500)
    try {
      const repo = scratch('anvil-approval-repo-')
      const plan = planFor(repo)
      const grant = buildSetupApprovalGrant(plan, { now: T0, ttlMs: TTL, id: ID })
      assert.throws(
        () => saveSetupApprovalGrant(grant, { env: { ANVIL_APPROVAL_HOME: store } }),
        (error: unknown) => error instanceof AnvilError && error.code === 'PREFLIGHT_FAILED',
      )
    } finally {
      chmodSync(locked, 0o700)
    }
  })

  test('a record another user could write is not authority on POSIX', (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX ownership and permission bits do not apply on Windows')
      return
    }
    const { repo, env, store } = fixture()
    const plan = planFor(repo)
    const at = new Date(T0.getTime() + 1000)
    saveSetupApprovalGrant(buildSetupApprovalGrant(plan, { now: T0, ttlMs: TTL, id: ID }), { env })
    assert.equal(inspectSetupApproval(ID, repository(repo), { env, now: at }).status, 'active')

    // A writable grant directory is refused even though the store root is private.
    chmodSync(join(store, ID), 0o777)
    assert.equal(inspectSetupApproval(ID, repository(repo), { env, now: at }).status, 'unknown')
    chmodSync(join(store, ID), 0o700)

    // A writable grant file is refused too.
    chmodSync(join(store, ID, 'grant.json'), 0o666)
    assert.equal(inspectSetupApproval(ID, repository(repo), { env, now: at }).status, 'unknown')
  })

  test('a Windows store another principal can reach is not authority', (t) => {
    if (process.platform !== 'win32') {
      t.skip('Windows access control lists only')
      return
    }
    const { repo, env, store } = fixture()
    const plan = planFor(repo)
    const at = new Date(T0.getTime() + 1000)
    saveSetupApprovalGrant(buildSetupApprovalGrant(plan, { now: T0, ttlMs: TTL, id: ID }), { env })
    assert.equal(inspectSetupApproval(ID, repository(repo), { env, now: at }).status, 'active')

    // A foreign SID makes the store unusable authority, even though it still names the user.
    icacls(store, '/grant', '*S-1-1-0:(OI)(CI)F')
    assert.equal(inspectSetupApproval(ID, repository(repo), { env, now: at }).status, 'unknown')
  })

  test('a Windows child record another user could write is not authority', (t) => {
    if (process.platform !== 'win32') {
      t.skip('Windows access control lists only')
      return
    }
    const { repo, env, store } = fixture()
    const plan = planFor(repo)
    const at = new Date(T0.getTime() + 1000)
    saveSetupApprovalGrant(buildSetupApprovalGrant(plan, { now: T0, ttlMs: TTL, id: ID }), { env })
    assert.equal(inspectSetupApproval(ID, repository(repo), { env, now: at }).status, 'active')

    // The store root stays private; only the grant directory is loosened, so the record
    // directory itself must be checked, not just the root.
    icacls(join(store, ID), '/grant', '*S-1-1-0:(OI)(CI)F')
    assert.equal(inspectSetupApproval(ID, repository(repo), { env, now: at }).status, 'unknown')
  })

  test('a Windows ACL read that exceeds its bound is refused as a timeout, not as unreadable', (t) => {
    if (process.platform !== 'win32') {
      t.skip('Windows access control lists only')
      return
    }
    const { repo, env } = fixture()
    const plan = planFor(repo)
    const at = new Date(T0.getTime() + 1000)
    saveSetupApprovalGrant(buildSetupApprovalGrant(plan, { now: T0, ttlMs: TTL, id: ID }), { env })
    assert.equal(inspectSetupApproval(ID, repository(repo), { env, now: at }).status, 'active')

    const previous = process.env.ANVIL_APPROVAL_TOOL_TIMEOUT_MS
    process.env.ANVIL_APPROVAL_TOOL_TIMEOUT_MS = '1'
    try {
      const record = inspectSetupApproval(ID, repository(repo), { env, now: at })
      // The timeout is still a refusal: a bound that fired must not become `active`.
      assert.equal(record.status, 'unknown')
      assert.match(record.reason, /could not be read within 1 ms/)
      assert.doesNotMatch(record.reason, /cannot be read/)
    } finally {
      if (previous === undefined) delete process.env.ANVIL_APPROVAL_TOOL_TIMEOUT_MS
      else process.env.ANVIL_APPROVAL_TOOL_TIMEOUT_MS = previous
    }
    // Once the tool can finish, the same store is authority again: the timeout was reported,
    // not written down as a permanent verdict about the store.
    assert.equal(inspectSetupApproval(ID, repository(repo), { env, now: at }).status, 'active')
  })

  test('a Windows store hardening timeout removes what it created and refuses', (t) => {
    if (process.platform !== 'win32') {
      t.skip('Windows access control lists only')
      return
    }
    const repo = scratch('anvil-approval-repo-')
    const store = join(scratch('anvil-approval-parent-'), 'store')
    const plan = planFor(repo)
    const grant = buildSetupApprovalGrant(plan, { now: T0, ttlMs: TTL, id: ID })

    const previous = process.env.ANVIL_APPROVAL_TOOL_TIMEOUT_MS
    process.env.ANVIL_APPROVAL_TOOL_TIMEOUT_MS = '1'
    try {
      assert.throws(
        () => saveSetupApprovalGrant(grant, { env: { ANVIL_APPROVAL_HOME: store } }),
        /could not be restricted within 1 ms/,
      )
    } finally {
      if (previous === undefined) delete process.env.ANVIL_APPROVAL_TOOL_TIMEOUT_MS
      else process.env.ANVIL_APPROVAL_TOOL_TIMEOUT_MS = previous
    }
    // A harden that timed out is a refusal, and the directory this call created is removed
    // rather than left behind with the inherited ACL.
    assert.equal(existsSync(store), false)
  })

  test('a transition-record ACL timeout is reported as a timeout, not as a corrupt record', () => {
    const { repo, env, store } = fixture()
    const plan = planFor(repo)
    saveSetupApprovalGrant(buildSetupApprovalGrant(plan, { now: T0, ttlMs: TTL, id: ID }), { env })
    const dir = join(store, ID)
    write(store, `${ID}/transition.json`, JSON.stringify({ schemaVersion: 1, kind: 'revoked', at: T0.toISOString() }))

    // Without the stub this record is a readable revocation, so the stub is what changes it.
    assert.equal(readSetupApprovalTransition(dir), 'revoked')

    // A stubbed ACL reader proves the timeout branch on any platform, without a real 1 ms
    // deadline that only a slow host reproduces.
    const io = { platform: 'win32' as const, readAcl: () => ({ ok: false as const, timedOut: true, timeoutMs: 250 }) }
    const inspection = inspectSetupApprovalTransition(dir, io)
    assert.equal(inspection.state, 'unknown')
    assert.match(inspection.reason ?? '', /grant state record cannot be inspected/)
    assert.match(inspection.reason ?? '', /protection check could not be read within 250 ms/)
    assert.match(inspection.reason ?? '', /refused rather than trusted/)
    assert.doesNotMatch(inspection.reason ?? '', /not private/)
    // Fail closed: the state readers still report the record as untrusted.
    assert.equal(readSetupApprovalTransition(dir, io), 'unknown')
  })

  test('a grant-record ACL timeout is reported as a timeout, not as a permissions problem', () => {
    const { repo, env, store } = fixture()
    const plan = planFor(repo)
    saveSetupApprovalGrant(buildSetupApprovalGrant(plan, { now: T0, ttlMs: TTL, id: ID }), { env })
    const dir = join(store, ID)
    write(store, `${ID}/application.json`, JSON.stringify({ schemaVersion: 1 }))

    assert.equal(readGrantRecord(dir, 'application.json').state, 'present')

    const io = { platform: 'win32' as const, readAcl: () => ({ ok: false as const, timedOut: true, timeoutMs: 250 }) }
    const read = readGrantRecord(dir, 'application.json', 64 * 1024, io)
    assert.equal(read.state, 'unknown')
    assert.match(
      read.state === 'unknown' ? read.reason : '',
      /grant record protection check could not be read within 250 ms/,
    )
    assert.doesNotMatch(read.state === 'unknown' ? read.reason : '', /not private to the current user/)
  })

  test('a genuine ACL refusal keeps the "not private" reason, distinct from a timeout', () => {
    const { repo, env, store } = fixture()
    const plan = planFor(repo)
    saveSetupApprovalGrant(buildSetupApprovalGrant(plan, { now: T0, ttlMs: TTL, id: ID }), { env })
    const dir = join(store, ID)
    write(store, `${ID}/application.json`, JSON.stringify({ schemaVersion: 1 }))

    // A readable ACL that grants another principal is a permissions problem, not a timeout.
    const io = {
      platform: 'win32' as const,
      readAcl: () => ({
        ok: true as const,
        acl: { self: 'S-1-5-21-1', owner: 'S-1-5-21-1', allow: ['S-1-5-21-1', 'S-1-1-0'] },
      }),
    }
    const read = readGrantRecord(dir, 'application.json', 64 * 1024, io)
    assert.equal(read.state, 'unknown')
    assert.match(read.state === 'unknown' ? read.reason : '', /not private to the current user/)
    assert.doesNotMatch(read.state === 'unknown' ? read.reason : '', /timed out/)
    // The transition read distinguishes the two as well.
    const transition = inspectSetupApprovalTransition(dir, io)
    assert.equal(transition.state, 'none')
  })

  test('a linked Windows store is refused without modifying its target', (t) => {
    if (process.platform !== 'win32') {
      t.skip('Windows junctions only')
      return
    }
    const target = scratch('anvil-approval-target-')
    const linkParent = scratch('anvil-approval-link-')
    const store = join(linkParent, 'store')
    try {
      symlinkSync(target, store, 'junction')
    } catch {
      t.skip('junctions are unavailable here')
      return
    }
    const repo = scratch('anvil-approval-repo-')
    const plan = planFor(repo)
    const grant = buildSetupApprovalGrant(plan, { now: T0, ttlMs: TTL, id: ID })
    // A refusal must not touch the target the link points at.
    const before = aclDump(target)
    assert.throws(() => saveSetupApprovalGrant(grant, { env: { ANVIL_APPROVAL_HOME: store } }), AnvilError)
    assert.equal(aclDump(target), before)
  })

  test('an existing unsafe Windows store is refused, not repaired', (t) => {
    if (process.platform !== 'win32') {
      t.skip('Windows access control lists only')
      return
    }
    const repo = scratch('anvil-approval-repo-')
    const store = scratch('anvil-approval-store-')
    const plan = planFor(repo)
    const env: NodeJS.ProcessEnv = { ...process.env, ANVIL_APPROVAL_HOME: store }
    // An existing store another user could write must be refused, not hardened into one.
    icacls(store, '/grant', '*S-1-1-0:(OI)(CI)F')
    const before = aclDump(store)
    const grant = buildSetupApprovalGrant(plan, { now: T0, ttlMs: TTL, id: ID })
    assert.throws(() => saveSetupApprovalGrant(grant, { env }), AnvilError)
    assert.equal(aclDump(store), before)
  })

  test('only known OS aliases are trusted at the filesystem root', () => {
    // The macOS root aliases are followed; an arbitrary root-level link is not.
    assert.equal(isTrustedRootAlias('/var'), true)
    assert.equal(isTrustedRootAlias('/tmp'), true)
    assert.equal(isTrustedRootAlias('/etc'), true)
    assert.equal(isTrustedRootAlias('/home'), false)
    assert.equal(isTrustedRootAlias('C:\\redirect'), false)
    assert.equal(isTrustedRootAlias('C:\\Windows'), false)
  })

  test('a failed store initialization removes the directory it created', (t) => {
    if (process.platform !== 'win32') {
      t.skip('Windows hardening only')
      return
    }
    const parent = scratch('anvil-approval-parent-')
    const store = join(parent, 'store')
    const repo = scratch('anvil-approval-repo-')
    const plan = planFor(repo)
    const grant = buildSetupApprovalGrant(plan, { now: T0, ttlMs: TTL, id: ID })
    // Without the system root, ACL hardening cannot run, so initialization fails after creating
    // the store. It must remove what it created rather than strand it.
    const systemRoot = process.env.SystemRoot
    const windir = process.env.windir
    process.env.SystemRoot = ''
    process.env.windir = ''
    try {
      assert.throws(() => saveSetupApprovalGrant(grant, { env: { ANVIL_APPROVAL_HOME: store } }), AnvilError)
    } finally {
      if (systemRoot === undefined) delete process.env.SystemRoot
      else process.env.SystemRoot = systemRoot
      if (windir === undefined) delete process.env.windir
      else process.env.windir = windir
    }
    assert.equal(existsSync(store), false)
  })

  test('a store reached through an intermediate junction is refused', (t) => {
    if (process.platform !== 'win32') {
      t.skip('Windows junctions only')
      return
    }
    const target = scratch('anvil-approval-target-')
    const linkParent = scratch('anvil-approval-link-')
    const redirect = join(linkParent, 'redirect')
    try {
      symlinkSync(target, redirect, 'junction')
    } catch {
      t.skip('junctions are unavailable here')
      return
    }
    const store = join(redirect, 'store')
    const repo = scratch('anvil-approval-repo-')
    const plan = planFor(repo)
    const grant = buildSetupApprovalGrant(plan, { now: T0, ttlMs: TTL, id: ID })
    assert.throws(() => saveSetupApprovalGrant(grant, { env: { ANVIL_APPROVAL_HOME: store } }), AnvilError)
    // Nothing may be created or hardened through the junction.
    assert.equal(existsSync(join(target, 'store')), false)
  })

  test('a terminal record survives the removal of its checkout', () => {
    const { repo, env } = fixture()
    const plan = planFor(repo)
    saveSetupApprovalGrant(buildSetupApprovalGrant(plan, { now: T0, ttlMs: TTL, id: ID }), { env })
    assert.equal(revokeSetupApproval(ID, { env }).status, 'revoked')
    // Removing the repository must not hide the terminal state or block a repeat revocation.
    rmSync(repo, { recursive: true, force: true })
    assert.equal(inspectSetupApproval(ID, null, { env }).status, 'revoked')
    assert.equal(revokeSetupApproval(ID, { env }).status, 'revoked')
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
    assert.equal(
      gradeSetupApprovalGrant({ ...grant, source: { ...grant.source, bytes: grant.source.bytes + 1 } }, plan).status,
      'stale',
    )
  })

  test('the default lifetime is the documented ten minutes', () => {
    const { repo } = fixture()
    const plan = planFor(repo)
    const grant = buildSetupApprovalGrant(plan, { now: T0, id: ID })
    assert.equal(Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt), SETUP_APPROVAL_TTL_MS)
  })
})
