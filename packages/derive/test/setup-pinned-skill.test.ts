import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { AnvilError, ErrorCode, type ProcessResult } from '@anvil/core'
import {
  applySetupPlan,
  buildPinnedSkillPlan,
  buildSetupApprovalGrant,
  fetchPinnedSkill,
  PINNED_SKILL_ADAPTER,
  pinnedSkillBlobPath,
  prepareSetupApprovalStore,
  readPinnedSkillContent,
  resolveSetupAdapter,
  type SetupRepositoryState,
  saveSetupApprovalGrant,
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
function repository(root: string): SetupRepositoryState {
  return { root, head: 'a'.repeat(40), worktree: 'clean' }
}
function skill(name: string, body = 'Do the thing.\n'): string {
  return `---\nname: ${name}\ndescription: A test skill for ${name}.\n---\n\n# ${name}\n\n${body}`
}
function fixture(): { repo: string; env: NodeJS.ProcessEnv } {
  const repo = scratch('anvil-pinned-repo-')
  const store = scratch('anvil-pinned-store-')
  const env: NodeJS.ProcessEnv = { ...process.env, ANVIL_APPROVAL_HOME: store }
  prepareSetupApprovalStore(env)
  return { repo, env }
}

const COMMIT = 'b'.repeat(40)
const ID = '11111111-2222-4333-8444-555555555555'
const T0 = new Date('2026-11-09T12:00:00.000Z')
const T1 = new Date(T0.getTime() + 1_000)
const TTL = 10 * 60 * 1000

interface FakeGh {
  calls: string[][]
  run(args: string[]): Promise<ProcessResult>
  setContent(content: string): void
}

function fakeGh(initial: string): FakeGh {
  let content = initial
  const calls: string[][] = []
  return {
    calls,
    setContent(next: string) {
      content = next
    },
    async run(args: string[]): Promise<ProcessResult> {
      calls.push(args)
      if (args.some((arg) => arg.includes('/commits/'))) {
        return { stdout: `${COMMIT}\n`, stderr: '', exitCode: 0 }
      }
      if (args.some((arg) => arg.includes('/contents/'))) {
        const bytes = Buffer.from(content)
        return {
          stdout: JSON.stringify({
            type: 'file',
            encoding: 'base64',
            size: bytes.length,
            content: bytes.toString('base64'),
          }),
          stderr: '',
          exitCode: 0,
        }
      }
      return { stdout: '', stderr: `unexpected gh call: ${args.join(' ')}`, exitCode: 1 }
    },
  }
}

const PATH = 'skills/release-notes/SKILL.md'
const REPO = 'tecruz/anvil'

describe('pinned-skill fetch and plan', () => {
  test('fetch resolves a ref, freezes one file, and planning makes no network calls', async () => {
    const { repo, env } = fixture()
    const gh = fakeGh(skill('release-notes'))
    const fetched = await fetchPinnedSkill({
      repositoryRoot: repo,
      repo: REPO,
      ref: 'main',
      path: PATH,
      name: 'release-notes',
      env,
      now: T0,
      gh: gh.run,
    })
    assert.equal(fetched.status, 'fetched')
    assert.equal(fetched.origin.commit, COMMIT)
    assert.equal(fetched.record.requestedRef, 'main')
    assert.equal(fetched.record.fetchedAt, T0.toISOString())
    const callsAfterFetch = gh.calls.length

    const adapter = resolveSetupAdapter('pinned-skill')
    const request = adapter.parseRequest({ repo: REPO, commit: COMMIT, path: PATH, name: 'release-notes' })
    const plan = adapter.build(repository(repo), request, { env })
    assert.equal(plan.adapter, PINNED_SKILL_ADAPTER)
    if (plan.adapter !== PINNED_SKILL_ADAPTER) throw new Error('expected a pinned-skill plan')
    assert.equal(gh.calls.length, callsAfterFetch)
    assert.equal(plan.source.sha256, fetched.record.blobSha256)
    assert.equal(plan.source.bytes, fetched.record.bytes)
    assert.equal(plan.origin.commit, COMMIT)
  })

  test('a 40-hex --commit is used directly, and a mismatched --commit is refused', async () => {
    const { repo, env } = fixture()
    const gh = fakeGh(skill('release-notes'))
    const direct = await fetchPinnedSkill({
      repositoryRoot: repo,
      repo: REPO,
      commit: COMMIT,
      path: PATH,
      name: 'release-notes',
      env,
      now: T0,
      gh: gh.run,
    })
    assert.equal(direct.record.requestedRef, COMMIT)
    assert.equal(gh.calls.length, 1)

    const other = 'c'.repeat(40)
    await assert.rejects(
      () =>
        fetchPinnedSkill({
          repositoryRoot: repo,
          repo: REPO,
          ref: 'main',
          commit: other,
          path: PATH,
          name: 'release-notes',
          env,
          now: T0,
          gh: gh.run,
        }),
      (error: unknown) => error instanceof AnvilError && error.code === ErrorCode.PreflightFailed,
    )
  })

  test('re-fetching identical bytes is cached without moving the frozen time', async () => {
    const { repo, env } = fixture()
    const gh = fakeGh(skill('release-notes'))
    const first = await fetchPinnedSkill({
      repositoryRoot: repo,
      repo: REPO,
      commit: COMMIT,
      path: PATH,
      name: 'release-notes',
      env,
      now: T0,
      gh: gh.run,
    })
    const second = await fetchPinnedSkill({
      repositoryRoot: repo,
      repo: REPO,
      commit: COMMIT,
      path: PATH,
      name: 'release-notes',
      env,
      now: T1,
      gh: gh.run,
    })
    assert.equal(second.status, 'cached')
    assert.equal(second.wrote, false)
    assert.equal(second.record.fetchedAt, first.record.fetchedAt)
  })

  test('a commit that appears to change content is a conflict, not a replacement', async () => {
    const { repo, env } = fixture()
    const gh = fakeGh(skill('release-notes'))
    await fetchPinnedSkill({
      repositoryRoot: repo,
      repo: REPO,
      commit: COMMIT,
      path: PATH,
      name: 'release-notes',
      env,
      now: T0,
      gh: gh.run,
    })
    gh.setContent(skill('release-notes', 'Different bytes.\n'))
    await assert.rejects(
      () =>
        fetchPinnedSkill({
          repositoryRoot: repo,
          repo: REPO,
          commit: COMMIT,
          path: PATH,
          name: 'release-notes',
          env,
          now: T1,
          gh: gh.run,
        }),
      (error: unknown) =>
        error instanceof AnvilError &&
        error.code === ErrorCode.PreflightFailed &&
        /already records different content/.test(error.message),
    )
  })

  test('a corrupt frozen blob is invalid and cannot become a plan', async () => {
    const { repo, env } = fixture()
    const gh = fakeGh(skill('release-notes'))
    const fetched = await fetchPinnedSkill({
      repositoryRoot: repo,
      repo: REPO,
      commit: COMMIT,
      path: PATH,
      name: 'release-notes',
      env,
      now: T0,
      gh: gh.run,
    })
    writeFileSync(pinnedSkillBlobPath(fetched.record.blobSha256, env), 'tampered')
    const read = readPinnedSkillContent({ host: 'github.com', repo: REPO, commit: COMMIT, path: PATH }, env)
    assert.equal(read.state, 'invalid')
    assert.throws(
      () =>
        buildPinnedSkillPlan({
          repository: repository(repo),
          request: {
            adapter: PINNED_SKILL_ADAPTER,
            host: 'github.com',
            repo: REPO,
            commit: COMMIT,
            path: PATH,
            name: 'release-notes',
          },
          env,
        }),
      (error: unknown) => error instanceof AnvilError && error.code === ErrorCode.ConfigInvalid,
    )
  })

  test('the reserved verify-change name and a mutable plan ref are refused before network access', async () => {
    const { repo, env } = fixture()
    const gh = fakeGh(skill('release-notes'))
    await assert.rejects(
      () =>
        fetchPinnedSkill({
          repositoryRoot: repo,
          repo: REPO,
          commit: COMMIT,
          path: PATH,
          name: 'verify-change',
          env,
          now: T0,
          gh: gh.run,
        }),
      (error: unknown) => error instanceof AnvilError && error.code === ErrorCode.ConfigInvalid,
    )
    assert.equal(gh.calls.length, 0)

    const adapter = resolveSetupAdapter('pinned-skill')
    assert.throws(
      () => adapter.parseRequest({ repo: REPO, commit: 'main', path: PATH, name: 'release-notes' }),
      (error: unknown) => error instanceof AnvilError && error.code === ErrorCode.ConfigInvalid,
    )
  })

  test('a store inside the repository is refused before it is created', async () => {
    const { repo } = fixture()
    const inside = join(repo, '.approvals')
    const env: NodeJS.ProcessEnv = { ...process.env, ANVIL_APPROVAL_HOME: inside }
    const gh = fakeGh(skill('release-notes'))
    await assert.rejects(
      () =>
        fetchPinnedSkill({
          repositoryRoot: repo,
          repo: REPO,
          commit: COMMIT,
          path: PATH,
          name: 'release-notes',
          env,
          now: T0,
          gh: gh.run,
        }),
      (error: unknown) => error instanceof AnvilError && error.code === ErrorCode.PreflightFailed,
    )
    assert.equal(existsSync(inside), false)
  })
})

describe('pinned-skill grant and application', () => {
  test('grant v2 binds the origin and content, and apply installs and replays once', async () => {
    const { repo, env } = fixture()
    const content = skill('release-notes')
    const gh = fakeGh(content)
    await fetchPinnedSkill({
      repositoryRoot: repo,
      repo: REPO,
      commit: COMMIT,
      path: PATH,
      name: 'release-notes',
      env,
      now: T0,
      gh: gh.run,
    })
    const adapter = resolveSetupAdapter('pinned-skill')
    const plan = adapter.build(
      repository(repo),
      adapter.parseRequest({ repo: REPO, commit: COMMIT, path: PATH, name: 'release-notes' }),
      { env },
    )
    if (plan.adapter !== PINNED_SKILL_ADAPTER) throw new Error('expected a pinned-skill plan')
    const grant = buildSetupApprovalGrant(plan, { now: T0, ttlMs: TTL, id: ID })
    assert.equal(grant.schemaVersion, 2)
    if (grant.schemaVersion !== 2) throw new Error('expected a v2 grant')
    assert.equal(grant.permission, 'apply-setup-plan-once')
    assert.equal(grant.adapter, PINNED_SKILL_ADAPTER)
    assert.equal(grant.bindingsDigest.length, 64)
    assert.deepEqual(grant.bindings.content, { sha256: plan.source.sha256, bytes: plan.source.bytes })
    assert.deepEqual(grant.bindings.origin, plan.origin)
    saveSetupApprovalGrant(grant, { env })

    const flow = {
      saved: JSON.parse(JSON.stringify(plan)),
      repository: repository(repo),
      grantId: ID,
      lock: <T>(work: () => Promise<T>): Promise<T> => work(),
      refresh: async () => repository(repo),
      env,
      now: T1,
    }
    const applied = await applySetupPlan(flow)
    assert.equal(applied.status, 'applied')
    assert.equal(applied.alreadyApplied, false)
    assert.equal(applied.executed, true)
    assert.equal(applied.adapter, PINNED_SKILL_ADAPTER)
    assert.equal(applied.subject?.id, 'release-notes')
    assert.equal(applied.journal?.schemaVersion, 2)
    if (applied.journal?.schemaVersion !== 2) throw new Error('expected a v2 journal')
    assert.equal(applied.journal.subject.destination, '.agents/skills/release-notes/SKILL.md')
    assert.ok(applied.journal.operations.every((operation) => operation.status === 'done'))
    assert.equal(readFileSync(join(repo, '.agents/skills/release-notes/SKILL.md'), 'utf8'), content)

    const replay = await applySetupPlan(flow)
    assert.equal(replay.status, 'applied')
    assert.equal(replay.alreadyApplied, true)
    assert.equal(replay.executed, false)
    assert.equal(readFileSync(join(repo, '.agents/skills/release-notes/SKILL.md'), 'utf8'), content)
  })
})
