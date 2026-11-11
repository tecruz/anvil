import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import {
  applySetupPlan,
  buildSetupApprovalGrant,
  buildSetupExecutionPlan,
  consumeSetupApproval,
  inspectSetupApproval,
  prepareSetupApprovalStore,
  readGrantRecord,
  readSetupApprovalGrant,
  replaceGrantRecord,
  revokeSetupApproval,
  SETUP_APPLICATION_JOURNAL_FILE,
  SETUP_APPLICATION_JOURNAL_KIND,
  type SetupApplicationJournal,
  type SetupApplyFlow,
  type SetupApplyVerification,
  type SetupApprovalGrant,
  type SetupExecutionPlan,
  type SetupRepositoryState,
  saveSetupApprovalGrant,
  verifyInstalledLocalSkill,
  writeGrantRecordOnce,
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
function write(root: string, path: string, content: string | Buffer): void {
  const target = join(root, ...path.split('/'))
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, content)
}
const ID = '11111111-2222-4333-8444-555555555555'
const ID2 = '99999999-8888-4777-8666-555555555555'
const T0 = new Date('2026-11-09T12:00:00.000Z')
const T1 = new Date(T0.getTime() + 1_000)
const TTL = 10 * 60 * 1000

interface Fixture {
  repo: string
  store: string
  env: NodeJS.ProcessEnv
  plan: SetupExecutionPlan
  grant: SetupApprovalGrant
}

function fixture(options: { content?: string; id?: string } = {}): Fixture {
  const repo = scratch('anvil-apply-repo-')
  const store = scratch('anvil-apply-store-')
  const env: NodeJS.ProcessEnv = { ...process.env, ANVIL_APPROVAL_HOME: store }
  prepareSetupApprovalStore(env)
  write(repo, 'skill.md', options.content ?? skill())
  const plan = buildSetupExecutionPlan({ repository: repository(repo), sourcePath: 'skill.md', name: 'my-skill' })
  const grant = buildSetupApprovalGrant(plan, { now: T0, ttlMs: TTL, id: options.id ?? ID })
  saveSetupApprovalGrant(grant, { env })
  return { repo, store, env, plan, grant }
}

function apply(fixture: Fixture, overrides: Partial<SetupApplyFlow> = {}) {
  return applySetupPlan({
    saved: fixture.plan,
    repository: repository(fixture.repo),
    grantId: fixture.grant.id,
    lock: (work) => work(),
    refresh: async () => repository(fixture.repo),
    env: fixture.env,
    now: T1,
    ...overrides,
  })
}

function journalDir(fixture: Fixture): string {
  const read = readSetupApprovalGrant(fixture.grant.id, { env: fixture.env })
  assert.equal(read.ok, true)
  return read.ok ? read.dir : ''
}

function active(fixture: Fixture): string {
  return inspectSetupApproval(fixture.grant.id, repository(fixture.repo), { env: fixture.env, now: T1 }).status
}

/** A journal that claims the attempt started but has no terminal outcome. */
function startedJournal(fixture: Fixture): SetupApplicationJournal {
  return {
    schemaVersion: 1,
    kind: SETUP_APPLICATION_JOURNAL_KIND,
    grantId: fixture.grant.id,
    planDigest: fixture.plan.digest,
    adapter: fixture.plan.adapter,
    adapterFingerprint: fixture.plan.adapterFingerprint,
    repository: fixture.grant.repository,
    skill: fixture.grant.skill,
    startedAt: T0.toISOString(),
    updatedAt: T0.toISOString(),
    status: 'started',
    operations: fixture.plan.operations.map((operation) => ({
      id: operation.id,
      kind: operation.kind,
      path: operation.path,
      status: 'pending',
    })),
    verification: null,
    reason: 'started',
  }
}

function serialLock(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

const failedVerification: SetupApplyVerification = {
  id: 'local-skill-installed/v1',
  scope: 'artifact-installed',
  ok: false,
  checks: [{ name: 'installed-bytes-match-source-sha256', ok: false, detail: 'simulated failure' }],
  proves: 'A simulated verifier failure.',
}

describe('setup application', () => {
  test('applies a current plan once, writes the exact bytes and journals a verified success', async () => {
    const fixtureLocal = fixture()
    const record = await apply(fixtureLocal)
    assert.equal(record.status, 'applied')
    assert.equal(record.executed, true)
    assert.equal(record.verified, true)
    assert.equal(record.alreadyApplied, false)
    assert.equal(record.grant?.id, fixtureLocal.grant.id)
    assert.equal(record.destination, '.agents/skills/my-skill/SKILL.md')

    const installed = readFileSync(join(fixtureLocal.repo, '.agents', 'skills', 'my-skill', 'SKILL.md'))
    assert.deepEqual(installed, Buffer.from(fixtureLocal.plan.source.content, 'utf8'))
    assert.equal(record.journal?.status, 'succeeded')
    assert.equal(record.journal?.verification?.ok, true)
    assert.equal(active(fixtureLocal), 'consumed')

    // A second invocation re-reads the journal, re-verifies and writes nothing.
    let writes = 0
    let locks = 0
    const again = await apply(fixtureLocal, {
      lock: async (work) => {
        locks += 1
        return work()
      },
      hooks: {
        publish: () => {
          writes += 1
          throw new Error('a used grant must not write again')
        },
      },
    })
    assert.equal(again.status, 'applied')
    assert.equal(again.executed, false)
    assert.equal(again.alreadyApplied, true)
    assert.equal(writes, 0)
    assert.equal(locks, 0, 'a terminal journal is read-only and needs no repository lock')
    assert.deepEqual(readFileSync(join(fixtureLocal.repo, '.agents', 'skills', 'my-skill', 'SKILL.md')), installed)
  })

  test('a recorded success is never reported for a different plan or repository', async () => {
    const fixtureLocal = fixture()
    assert.equal((await apply(fixtureLocal)).status, 'applied')

    // A different plan with the same grant is refused, not reported as a completed install.
    const elsewhere = scratch('anvil-apply-elsewhere-')
    write(elsewhere, 'skill.md', skill('other-skill'))
    const otherPlan = buildSetupExecutionPlan({
      repository: repository(elsewhere),
      sourcePath: 'skill.md',
      name: 'other-skill',
    })
    const other = await apply(fixtureLocal, { saved: otherPlan })
    assert.equal(other.status, 'refused')
    assert.equal(other.alreadyApplied, false)
    assert.match(other.reason, /not the plan this grant approved/)

    // The same plan from a different checkout is refused as well.
    const differentCheckout = await apply(fixtureLocal, { repository: repository(elsewhere) })
    assert.equal(differentCheckout.status, 'refused')
    assert.match(differentCheckout.reason, /different repository/)
  })

  test('preserves exact CRLF bytes and trailing whitespace', async () => {
    const content = skill('my-skill', 'line one\r\nline two\r\n')
    const fixtureLocal = fixture({ content })
    const record = await apply(fixtureLocal)
    assert.equal(record.status, 'applied', record.reason)
    const installed = readFileSync(join(fixtureLocal.repo, '.agents', 'skills', 'my-skill', 'SKILL.md'))
    assert.deepEqual(installed, Buffer.from(content, 'utf8'))
  })

  test('refuses a stale plan without consuming the grant or creating anything', async () => {
    const fixtureLocal = fixture()
    write(fixtureLocal.repo, 'skill.md', skill('my-skill', 'A different body.\n'))
    const record = await apply(fixtureLocal)
    assert.equal(record.status, 'refused')
    assert.equal(record.executed, false)
    // The grant is bound to the source hash, so it also reports stale; the attempt itself is
    // not consumed and nothing was written.
    assert.notEqual(active(fixtureLocal), 'consumed')
    assert.equal(existsSync(join(fixtureLocal.repo, '.agents')), false)
  })

  test('refuses a revoked or expired grant without writing', async () => {
    const revokedFixture = fixture()
    revokeSetupApproval(revokedFixture.grant.id, { env: revokedFixture.env, now: T1 })
    const revoked = await apply(revokedFixture)
    assert.equal(revoked.status, 'refused')
    assert.match(revoked.reason, /revoked/)
    assert.equal(existsSync(join(revokedFixture.repo, '.agents')), false)

    const expiredFixture = fixture()
    const expired = await apply(expiredFixture, { now: new Date(T0.getTime() + TTL + 1) })
    assert.equal(expired.status, 'refused')
    assert.match(expired.reason, /expired/)
    assert.equal(existsSync(join(expiredFixture.repo, '.agents')), false)
    assert.equal(active(expiredFixture), 'active', 'an expired-at-read grant was not consumed')
  })

  test('never overwrites a destination that appeared after approval', async () => {
    const fixtureLocal = fixture()
    const existing = join(fixtureLocal.repo, '.agents', 'skills', 'my-skill', 'SKILL.md')
    mkdirSync(join(existing, '..'), { recursive: true })
    writeFileSync(existing, 'EXISTING CONTENT MUST SURVIVE')
    const record = await apply(fixtureLocal)
    assert.equal(record.status, 'refused')
    assert.equal(readFileSync(existing, 'utf8'), 'EXISTING CONTENT MUST SURVIVE')
    assert.notEqual(active(fixtureLocal), 'consumed')
  })

  test('a write failure is journaled as partial and cannot be retried', async () => {
    const fixtureLocal = fixture()
    const record = await apply(fixtureLocal, {
      hooks: {
        publish: () => {
          throw new Error('simulated write failure')
        },
      },
    })
    assert.equal(record.status, 'partial')
    assert.equal(record.executed, true)
    assert.equal(record.verified, false)
    assert.match(record.reason, /partial write/)
    assert.equal(record.journal?.status, 'partial')
    assert.equal(existsSync(join(fixtureLocal.repo, '.agents', 'skills', 'my-skill', 'SKILL.md')), false)
    assert.equal(active(fixtureLocal), 'consumed')

    let writes = 0
    const retry = await apply(fixtureLocal, {
      hooks: {
        publish: () => {
          writes += 1
        },
      },
    })
    assert.equal(retry.status, 'partial')
    assert.equal(retry.executed, false)
    assert.equal(writes, 0)
  })

  test('a failed verification is partial, leaves the bytes inspectable and never reports success', async () => {
    const fixtureLocal = fixture()
    const record = await apply(fixtureLocal, { hooks: { verify: () => failedVerification } })
    assert.equal(record.status, 'partial')
    assert.equal(record.executed, true)
    assert.equal(record.verified, false)
    assert.equal(record.journal?.status, 'partial')
    assert.equal(
      existsSync(join(fixtureLocal.repo, '.agents', 'skills', 'my-skill', 'SKILL.md')),
      true,
      'the written bytes stay for inspection instead of being deleted',
    )
    // The real verifier would pass, but the recorded attempt is still partial: an app that
    // failed its own verification is not upgraded to success by a later read.
    const after = await apply(fixtureLocal)
    assert.equal(after.status, 'partial')
    assert.equal(after.executed, false)
  })

  test('a destination created between revalidation and the first write is preserved', async () => {
    const fixtureLocal = fixture()
    const existing = join(fixtureLocal.repo, '.agents', 'skills', 'my-skill', 'SKILL.md')
    const record = await apply(fixtureLocal, {
      hooks: {
        beforeWrite: () => {
          mkdirSync(join(existing, '..'), { recursive: true })
          writeFileSync(existing, 'RACED CONTENT MUST SURVIVE')
        },
      },
    })
    assert.equal(record.status, 'failed')
    assert.match(record.reason, /already exists/)
    assert.equal(record.executed, false)
    assert.equal(readFileSync(existing, 'utf8'), 'RACED CONTENT MUST SURVIVE')
  })

  test('a plan that reads stale because a concurrent writer finished is settled, not refused', async () => {
    const fixtureLocal = fixture()
    const dir = journalDir(fixtureLocal)
    let locks = 0
    const record = await apply(fixtureLocal, {
      lock: async (work) => {
        locks += 1
        return work()
      },
      hooks: {
        beforeResolve: () => {
          // The winning writer consumes the grant, publishes a terminal journal and writes
          // the destination while this caller is still doing preflight work.
          const consumption = consumeSetupApproval(fixtureLocal.grant.id, repository(fixtureLocal.repo), {
            env: fixtureLocal.env,
            now: T1,
          })
          assert.equal(consumption.reserved, true)
          const skillDirectory = join(fixtureLocal.repo, '.agents', 'skills', 'my-skill')
          mkdirSync(skillDirectory, { recursive: true })
          writeFileSync(join(skillDirectory, 'SKILL.md'), fixtureLocal.plan.source.content)
          const verification = verifyInstalledLocalSkill({
            root: fixtureLocal.repo,
            destination: fixtureLocal.plan.skill.destination,
            sha256: fixtureLocal.plan.source.sha256,
            bytes: fixtureLocal.plan.source.bytes,
          })
          const journal = startedJournal(fixtureLocal)
          replaceGrantRecord(dir, SETUP_APPLICATION_JOURNAL_FILE, {
            ...journal,
            status: 'succeeded',
            operations: journal.operations.map((operation) => ({ ...operation, status: 'done' })),
            verification,
            reason: 'The reviewed bytes were installed and independently verified.',
          })
        },
      },
    })
    assert.equal(locks, 1, 'the preflight must wait for the lock before refusing')
    assert.equal(record.status, 'applied')
    assert.equal(record.executed, false)
    assert.equal(record.alreadyApplied, true)
    assert.equal(record.verified, true)
  })

  test('a write that lands during grant inspection is settled, not refused', async () => {
    const fixtureLocal = fixture()
    const dir = journalDir(fixtureLocal)
    let locks = 0
    const record = await apply(fixtureLocal, {
      lock: async (work) => {
        locks += 1
        return work()
      },
      hooks: {
        beforeInspect: () => {
          // The destination and journal appear after the plan resolved but before this
          // caller inspects the grant, so the rebuilt plan now reads as stale.
          const skillDirectory = join(fixtureLocal.repo, '.agents', 'skills', 'my-skill')
          mkdirSync(skillDirectory, { recursive: true })
          writeFileSync(join(skillDirectory, 'SKILL.md'), fixtureLocal.plan.source.content)
          const verification = verifyInstalledLocalSkill({
            root: fixtureLocal.repo,
            destination: fixtureLocal.plan.skill.destination,
            sha256: fixtureLocal.plan.source.sha256,
            bytes: fixtureLocal.plan.source.bytes,
          })
          const journal = startedJournal(fixtureLocal)
          replaceGrantRecord(dir, SETUP_APPLICATION_JOURNAL_FILE, {
            ...journal,
            status: 'succeeded',
            operations: journal.operations.map((operation) => ({ ...operation, status: 'done' })),
            verification,
            reason: 'The reviewed bytes were installed and independently verified.',
          })
        },
      },
    })
    assert.equal(locks, 1, 'the inspection race must be settled under the lock')
    assert.equal(record.status, 'applied')
    assert.equal(record.executed, false)
    assert.equal(record.alreadyApplied, true)
    assert.equal(record.verified, true)
  })

  test('a journal caught in its hard-link publication window is re-read under the lock', async () => {
    const fixtureLocal = fixture()
    const dir = journalDir(fixtureLocal)
    const consumption = consumeSetupApproval(fixtureLocal.grant.id, repository(fixtureLocal.repo), {
      env: fixtureLocal.env,
      now: T1,
    })
    assert.equal(consumption.reserved, true)
    assert.equal(writeGrantRecordOnce(dir, SETUP_APPLICATION_JOURNAL_FILE, startedJournal(fixtureLocal)), 'written')
    // Hard-link publication briefly gives the journal a second name; the protected reader
    // refuses a multiply-linked file, so this is the state a concurrent caller can observe.
    linkSync(join(dir, SETUP_APPLICATION_JOURNAL_FILE), join(dir, 'application.link.tmp'))

    let locks = 0
    const record = await apply(fixtureLocal, {
      lock: async (work) => {
        locks += 1
        // The writer publishes its terminal record and unlinks its temporary name while
        // this caller waits for the lock.
        const skillDirectory = join(fixtureLocal.repo, '.agents', 'skills', 'my-skill')
        mkdirSync(skillDirectory, { recursive: true })
        writeFileSync(join(skillDirectory, 'SKILL.md'), fixtureLocal.plan.source.content)
        const verification = verifyInstalledLocalSkill({
          root: fixtureLocal.repo,
          destination: fixtureLocal.plan.skill.destination,
          sha256: fixtureLocal.plan.source.sha256,
          bytes: fixtureLocal.plan.source.bytes,
        })
        const journal = startedJournal(fixtureLocal)
        replaceGrantRecord(dir, SETUP_APPLICATION_JOURNAL_FILE, {
          ...journal,
          status: 'succeeded',
          operations: journal.operations.map((operation) => ({ ...operation, status: 'done' })),
          verification,
          reason: 'The reviewed bytes were installed and independently verified.',
        })
        return work()
      },
    })
    assert.equal(locks, 1, 'an unreadable journal must be re-read under the lock')
    assert.equal(record.status, 'applied')
    assert.equal(record.executed, false)
    assert.equal(record.alreadyApplied, true)
    assert.equal(record.verified, true)
  })

  test('a reservation caught in its hard-link publication window is settled, not refused', async () => {
    const fixtureLocal = fixture()
    const dir = journalDir(fixtureLocal)
    const consumption = consumeSetupApproval(fixtureLocal.grant.id, repository(fixtureLocal.repo), {
      env: fixtureLocal.env,
      now: T1,
    })
    assert.equal(consumption.reserved, true)
    // `writeTransition` publishes `transition.json` through a hard link. While the temporary
    // name exists the record has two links, so the protected reader reports it as unknown.
    linkSync(join(dir, 'transition.json'), join(dir, 'transition.link.tmp'))

    let locks = 0
    const record = await apply(fixtureLocal, {
      lock: async (work) => {
        locks += 1
        // The writer unlinks its temporary name, installs the artifact and publishes a
        // terminal journal before releasing the lock this caller is waiting for.
        rmSync(join(dir, 'transition.link.tmp'))
        const skillDirectory = join(fixtureLocal.repo, '.agents', 'skills', 'my-skill')
        mkdirSync(skillDirectory, { recursive: true })
        writeFileSync(join(skillDirectory, 'SKILL.md'), fixtureLocal.plan.source.content)
        const verification = verifyInstalledLocalSkill({
          root: fixtureLocal.repo,
          destination: fixtureLocal.plan.skill.destination,
          sha256: fixtureLocal.plan.source.sha256,
          bytes: fixtureLocal.plan.source.bytes,
        })
        const journal = startedJournal(fixtureLocal)
        replaceGrantRecord(dir, SETUP_APPLICATION_JOURNAL_FILE, {
          ...journal,
          status: 'succeeded',
          operations: journal.operations.map((operation) => ({ ...operation, status: 'done' })),
          verification,
          reason: 'The reviewed bytes were installed and independently verified.',
        })
        return work()
      },
    })
    assert.equal(locks, 1, 'an unreadable reservation must be re-read under the lock')
    assert.equal(record.status, 'applied')
    assert.equal(record.executed, false)
    assert.equal(record.alreadyApplied, true)
    assert.equal(record.verified, true)
  })

  test('a corrupt reservation record is refused once the lock rules out a live writer', async () => {
    const fixtureLocal = fixture()
    const dir = journalDir(fixtureLocal)
    const consumption = consumeSetupApproval(fixtureLocal.grant.id, repository(fixtureLocal.repo), {
      env: fixtureLocal.env,
      now: T1,
    })
    assert.equal(consumption.reserved, true)
    linkSync(join(dir, 'transition.json'), join(dir, 'transition.link.tmp'))

    let locks = 0
    const record = await apply(fixtureLocal, {
      lock: async (work) => {
        locks += 1
        return work()
      },
      hooks: {
        publish: () => assert.fail('a corrupt reservation must not write'),
      },
    })
    assert.equal(locks, 1, 'an unreadable reservation must be checked under the lock')
    assert.equal(record.status, 'refused')
    assert.match(record.reason, /grant state record cannot be inspected/)
    assert.equal(record.executed, false)
  })

  test('a started journal without an outcome is reported as interrupted, never retried', async () => {
    const fixtureLocal = fixture()
    const dir = journalDir(fixtureLocal)
    const consumption = consumeSetupApproval(fixtureLocal.grant.id, repository(fixtureLocal.repo), {
      env: fixtureLocal.env,
      now: T1,
    })
    assert.equal(consumption.reserved, true)
    assert.equal(writeGrantRecordOnce(dir, SETUP_APPLICATION_JOURNAL_FILE, startedJournal(fixtureLocal)), 'written')

    let writes = 0
    let locks = 0
    const record = await apply(fixtureLocal, {
      lock: async (work) => {
        locks += 1
        return work()
      },
      hooks: {
        publish: () => {
          writes += 1
        },
      },
    })
    assert.equal(record.status, 'interrupted')
    assert.equal(record.executed, false)
    assert.equal(writes, 0)
    assert.equal(locks, 1, 'a started journal must be re-read under the repository lock')
    assert.match(record.reason, /never recorded an outcome/)
    assert.equal(existsSync(join(fixtureLocal.repo, '.agents')), false)
  })

  test('a consumed grant with no journal is interrupted, not refused as a new attempt', async () => {
    const fixtureLocal = fixture()
    const consumption = consumeSetupApproval(fixtureLocal.grant.id, repository(fixtureLocal.repo), {
      env: fixtureLocal.env,
      now: T1,
    })
    assert.equal(consumption.reserved, true)
    let locks = 0
    const record = await apply(fixtureLocal, {
      lock: async (work) => {
        locks += 1
        return work()
      },
    })
    assert.equal(record.status, 'interrupted')
    assert.equal(record.executed, false)
    assert.match(record.reason, /no application journal exists/)
    assert.equal(locks, 1, 'a reservation without a journal must re-read under the lock')
  })

  test('a reservation without a journal waits for the writer and settles its outcome', async () => {
    const fixtureLocal = fixture()
    const dir = journalDir(fixtureLocal)
    const consumption = consumeSetupApproval(fixtureLocal.grant.id, repository(fixtureLocal.repo), {
      env: fixtureLocal.env,
      now: T1,
    })
    assert.equal(consumption.reserved, true)

    let locks = 0
    const record = await apply(fixtureLocal, {
      lock: async (work) => {
        locks += 1
        // The winning writer installs the artifact and publishes a terminal journal before
        // releasing the lock this caller is waiting for.
        const skillDirectory = join(fixtureLocal.repo, '.agents', 'skills', 'my-skill')
        mkdirSync(skillDirectory, { recursive: true })
        writeFileSync(join(skillDirectory, 'SKILL.md'), Buffer.from(fixtureLocal.plan.source.content, 'utf8'))
        const verification = verifyInstalledLocalSkill({
          root: fixtureLocal.repo,
          destination: fixtureLocal.plan.skill.destination,
          sha256: fixtureLocal.plan.source.sha256,
          bytes: fixtureLocal.plan.source.bytes,
        })
        const journal = startedJournal(fixtureLocal)
        replaceGrantRecord(dir, SETUP_APPLICATION_JOURNAL_FILE, {
          ...journal,
          status: 'succeeded',
          operations: journal.operations.map((operation) => ({ ...operation, status: 'done' })),
          verification,
          reason: 'The reviewed bytes were installed and independently verified.',
        })
        return work()
      },
    })
    assert.equal(locks, 1)
    assert.equal(record.status, 'applied')
    assert.equal(record.executed, false)
    assert.equal(record.alreadyApplied, true)
    assert.equal(record.verified, true)
  })

  test('a started journal does not settle from authority read before the lock', async () => {
    const fixtureLocal = fixture()
    const dir = journalDir(fixtureLocal)
    const consumption = consumeSetupApproval(fixtureLocal.grant.id, repository(fixtureLocal.repo), {
      env: fixtureLocal.env,
      now: T1,
    })
    assert.equal(consumption.reserved, true)
    assert.equal(writeGrantRecordOnce(dir, SETUP_APPLICATION_JOURNAL_FILE, startedJournal(fixtureLocal)), 'written')

    const record = await apply(fixtureLocal, {
      lock: async (work) => {
        // The authority is removed while this caller waits for the lock.
        rmSync(join(dir, 'grant.json'))
        return work()
      },
    })
    assert.equal(record.status, 'refused')
    assert.match(record.reason, /grant record is missing|unreadable|No such approval grant/i)
  })

  test('a malformed or foreign journal is never trusted as a successful application', async () => {
    const fixtureLocal = fixture()
    const first = await apply(fixtureLocal)
    assert.equal(first.status, 'applied')
    const dir = journalDir(fixtureLocal)

    const foreign = startedJournal(fixtureLocal)
    replaceGrantRecord(dir, SETUP_APPLICATION_JOURNAL_FILE, { ...foreign, grantId: ID2, status: 'succeeded' })
    const foreignRecord = await apply(fixtureLocal)
    assert.equal(foreignRecord.status, 'interrupted')
    assert.match(foreignRecord.reason, /different grant/)

    // A malformed journal is untrusted, not an absent one.
    writeFileSync(join(dir, SETUP_APPLICATION_JOURNAL_FILE), 'not json')
    const malformed = await apply(fixtureLocal)
    assert.equal(malformed.status, 'interrupted')
    assert.match(malformed.reason, /cannot be trusted/)
  })

  test('a repository that moves before the lock is refused and the grant stays active', async () => {
    const fixtureLocal = fixture()
    const record = await apply(fixtureLocal, {
      refresh: async () => repository(fixtureLocal.repo, { head: 'b'.repeat(40) }),
    })
    assert.equal(record.status, 'refused')
    assert.equal(record.executed, false)
    assert.equal(active(fixtureLocal), 'active')
    assert.equal(existsSync(join(fixtureLocal.repo, '.agents')), false)
  })

  test('two concurrent applications reserve one attempt and write once', async () => {
    const fixtureLocal = fixture()
    const lock = serialLock()
    const [first, second] = await Promise.all([apply(fixtureLocal, { lock }), apply(fixtureLocal, { lock })])
    const records = [first, second]
    assert.deepEqual(
      records.map((record) => record.status),
      ['applied', 'applied'],
    )
    assert.equal(records.filter((record) => record.executed).length, 1)
    assert.equal(records.filter((record) => record.alreadyApplied).length, 1)
    assert.deepEqual(
      readFileSync(join(fixtureLocal.repo, '.agents', 'skills', 'my-skill', 'SKILL.md')),
      Buffer.from(fixtureLocal.plan.source.content, 'utf8'),
    )
  })

  test('the verifier detects changed installed bytes and missing destinations', async () => {
    const fixtureLocal = fixture()
    await apply(fixtureLocal)
    const destination = join(fixtureLocal.repo, '.agents', 'skills', 'my-skill', 'SKILL.md')
    const pointer = {
      root: fixtureLocal.repo,
      destination: fixtureLocal.plan.skill.destination,
      sha256: fixtureLocal.plan.source.sha256,
      bytes: fixtureLocal.plan.source.bytes,
    }
    assert.equal(verifyInstalledLocalSkill(pointer).ok, true)
    writeFileSync(destination, skill('my-skill', 'tampered\n'))
    const tampered = verifyInstalledLocalSkill(pointer)
    assert.equal(tampered.ok, false)
    assert.equal(tampered.checks.find((check) => check.name === 'installed-bytes-match-source-sha256')?.ok, false)

    rmSync(destination)
    const missing = verifyInstalledLocalSkill(pointer)
    assert.equal(missing.ok, false)
    assert.equal(missing.checks.find((check) => check.name === 'destination-regular-file')?.ok, false)
  })

  test('the verifier refuses a destination that escapes the repository through a backslash', () => {
    const parent = scratch('anvil-apply-traversal-')
    const root = join(parent, 'repo')
    mkdirSync(join(root, 'safe'), { recursive: true })
    const outside = join(parent, 'outside', 'secret.md')
    mkdirSync(join(parent, 'outside'), { recursive: true })
    const content = skill('verify-change')
    writeFileSync(outside, content)
    const bytes = Buffer.from(content, 'utf8')
    const result = verifyInstalledLocalSkill({
      root,
      destination: 'safe/..\\..\\outside\\secret.md',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    })
    assert.equal(result.ok, false)
    const containment = result.checks.find((check) => check.name === 'destination-inside-repository')
    assert.equal(containment?.ok, false, 'a backslash must be refused, not treated as a file name')
  })

  test('the journal is private and readable only through the protected record reader', async () => {
    const fixtureLocal = fixture()
    await apply(fixtureLocal)
    const dir = journalDir(fixtureLocal)
    const path = join(dir, SETUP_APPLICATION_JOURNAL_FILE)
    const read = readGrantRecord(dir, SETUP_APPLICATION_JOURNAL_FILE)
    assert.equal(read.state, 'present')
    if (process.platform !== 'win32') {
      assert.equal(statSync(path).mode & 0o077, 0, 'the journal must not be group or other accessible')
    }
    assert.equal(existsSync(path), true)
  })
})
