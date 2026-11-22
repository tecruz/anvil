import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { hashDirectory } from '../../packages/cli/src/eval-gate.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'eval/pilots/sources.json'), 'utf8')) as {
  sources: Array<{ repo: string; origin: string; sha: string }>
}

function git(cwd: string, ...args: string[]): string | null {
  const result = spawnSync('git', ['--no-optional-locks', ...args], { cwd, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

describe('pinned pilot source clones', () => {
  for (const source of manifest.sources) {
    const cwd = join(root, source.repo)
    const label = source.repo.split('/').at(-1) ?? source.repo

    test(`${label}: HEAD and origin match the predeclared card`, { skip: !existsSync(join(cwd, '.git')) }, () => {
      assert.equal(git(cwd, 'rev-parse', 'HEAD'), source.sha)
      assert.equal(git(cwd, 'config', '--get', 'remote.origin.url'), source.origin)
      // The pinned clone may carry Windows CRLF in files that declare `eol=crlf`; that is not a
      // source change. Any content change, staged or unstaged, must fail the pin check.
      for (const args of [
        ['diff', 'HEAD', '--ignore-cr-at-eol', '--quiet'],
        ['diff', '--cached', 'HEAD', '--ignore-cr-at-eol', '--quiet'],
      ]) {
        const clean = spawnSync('git', ['--no-optional-locks', ...args], { cwd })
        assert.equal(clean.status, 0, `working tree must match HEAD: ${args.join(' ')}`)
      }
      assert.equal(git(cwd, 'ls-files', '--others'), '')
    })
  }
})

describe('source hashing ignores clone state', () => {
  const base = join(tmpdir(), `pilot-hash-${process.pid}`)
  const withGit = join(base, 'with-git')
  const plain = join(base, 'plain')
  after(() => rmSync(base, { recursive: true, force: true }))

  test('a .git directory does not change the source hash', () => {
    for (const dir of [withGit, plain]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'source.txt'), 'the source tree\n')
    }
    mkdirSync(join(withGit, '.git'))
    writeFileSync(join(withGit, '.git', 'config'), 'clone-specific metadata\n')
    assert.equal(hashDirectory(withGit), hashDirectory(plain))
  })
})
