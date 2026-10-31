import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { branchExists } from '@anvil/git'
import { claimTicket, findOrphanWorktrees, readClaims, writeClaims } from '@anvil/worktrees'
import { installPushGuard } from '@anvil/worktrees/hooks'
import { checkedStatePath } from '../src/state.ts'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'anvil-state-safety-'))
  roots.push(root)
  const repo = join(root, 'repo')
  mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' })
  git('init', '--initial-branch=main')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.com')
  writeFileSync(join(repo, 'README.md'), '# fixture\n')
  git('add', '.')
  git('commit', '-m', 'init')
  return { root, repo, git }
}
const ticket = {
  ref: { provider: 'local', id: '1', key: 'local-1' },
  title: 'Safety',
  body: '',
  acceptance: [],
  normalizedState: 'todo' as const,
}

for (const leaf of ['ticket.md', 'AGENTS.md']) {
  test(`claim refuses a committed ${leaf} symlink and preserves its external target`, async (t) => {
    const { root, repo, git } = fixture()
    const outside = join(root, 'sentinel')
    writeFileSync(outside, 'untouched\n')
    mkdirSync(join(repo, '.anvil'))
    try {
      symlinkSync(outside, join(repo, '.anvil', leaf), 'file')
    } catch {
      t.skip('file symlinks unavailable without elevation')
      return
    }
    git('config', 'core.symlinks', 'true')
    git('add', `.anvil/${leaf}`)
    git('commit', '-m', 'linked output')
    await assert.rejects(
      () => claimTicket({ repoRoot: repo, ticket, worktreeRoot: join(root, 'wt') }),
      /worktree and branch were removed/,
    )
    assert.equal(readFileSync(outside, 'utf8'), 'untouched\n')
    assert.equal(existsSync(join(root, 'wt', 'local-1')), false)
    assert.equal(await branchExists(repo, 'feat/local-1-safety'), false)
    assert.deepEqual(readClaims(repo).claims, [])
    assert.deepEqual(await findOrphanWorktrees(repo), [])
  })
}

test('state output refuses hard links without modifying the shared file', () => {
  const { root, repo } = fixture()
  mkdirSync(join(repo, '.anvil'))
  const outside = join(root, 'sentinel')
  writeFileSync(outside, 'untouched\n')
  linkSync(outside, join(repo, '.anvil', 'ticket.md'))
  assert.throws(() => checkedStatePath(repo, ['ticket.md']), /unsafe path/)
  assert.equal(readFileSync(outside, 'utf8'), 'untouched\n')
})

test('registry refusal preserves a multiply-linked registry and leaves no temporary file', () => {
  const { root, repo } = fixture()
  mkdirSync(join(repo, '.anvil'))
  const outside = join(root, 'sentinel')
  writeFileSync(outside, 'untouched\n')
  linkSync(outside, join(repo, '.anvil', 'claims.json'))
  assert.throws(() => writeClaims(repo, { schemaVersion: 1, claims: [] }), /unsafe path/)
  assert.equal(readFileSync(outside, 'utf8'), 'untouched\n')
  assert.deepEqual(readdirSync(join(repo, '.anvil')), ['claims.json'])
})

test('hook installation refuses a linked hooks directory without writing outside', async (t) => {
  const { root, repo } = fixture()
  const outside = join(root, 'outside')
  mkdirSync(outside)
  mkdirSync(join(repo, '.anvil'))
  writeFileSync(join(outside, 'sentinel'), 'untouched\n')
  try {
    symlinkSync(outside, join(repo, '.anvil', 'hooks'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    t.skip('directory links unavailable without elevation')
    return
  }
  const result = await installPushGuard({ worktreePath: repo, key: 'local-1' })
  assert.equal(result.installed, false)
  assert.deepEqual(readdirSync(outside), ['sentinel'])
  assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'untouched\n')
})

test('hook installation validates the complete batch before writing any wrapper', async () => {
  const { root, repo, git } = fixture()
  const ownHooks = join(repo, '.githooks')
  mkdirSync(ownHooks)
  writeFileSync(join(ownHooks, 'pre-commit'), '#!/bin/sh\nexit 0\n')
  git('config', 'core.hooksPath', '.githooks')
  const hooks = join(repo, '.anvil', 'hooks')
  mkdirSync(hooks, { recursive: true })
  const outside = join(root, 'sentinel')
  writeFileSync(outside, 'untouched\n')
  linkSync(outside, join(hooks, 'pre-push'))
  const result = await installPushGuard({ worktreePath: repo, key: 'local-1' })
  assert.equal(result.installed, false)
  assert.equal(existsSync(join(hooks, 'pre-commit')), false)
  assert.equal(readFileSync(outside, 'utf8'), 'untouched\n')
  assert.equal(git('config', '--get', 'core.hooksPath').trim(), '.githooks')
})
