import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

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
      // source change. Any content change must fail the pin check.
      const clean = spawnSync('git', ['--no-optional-locks', 'diff', '--ignore-cr-at-eol', '--quiet'], {
        cwd,
      })
      assert.equal(clean.status, 0)
      assert.equal(git(cwd, 'ls-files', '--others', '--exclude-standard'), '')
    })
  }
})
