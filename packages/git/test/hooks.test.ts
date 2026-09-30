/**
 * The pre-commit hook, tested the way it will actually be used: through git.
 *
 * A hook that is only ever asserted on as a file is not tested. What matters is that a badly
 * formatted staged file *blocks the commit*, and that a clean one does not -- so this builds
 * a real repository, copies the real hook in, and lets git run it.
 *
 * The one thing stubbed is where the biome binary lives, because that is the part that
 * legitimately differs per machine: each temp repository gets a `node_modules/.bin/biome`
 * shim that forwards to the real one. Everything else -- git's hook dispatch, the script's
 * own path resolution, the flags, the exit code -- is the genuine article.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(here, '..', '..', '..')
const HOOK = join(REPO, '.githooks', 'pre-commit')

/** The real biome, invoked through a path the hook can find from a temp repository. */
const BIOME =
  process.platform === 'win32'
    ? join(REPO, 'node_modules', '.bin', 'biome.cmd')
    : join(REPO, 'node_modules', '.bin', 'biome')

const temps: string[] = []
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' })
}

interface CommitResult {
  ok: boolean
  output: string
}

/** Attempt a commit and report whether it happened, rather than throwing on rejection. */
function tryCommit(dir: string, message: string): CommitResult {
  try {
    return { ok: true, output: git(dir, 'commit', '-m', message) }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string }
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

/**
 * A repository with the real hook installed and a biome shim the hook can execute.
 *
 * The shim is a shell script even on Windows, because the hook is a `#!/bin/sh` script and
 * resolves `node_modules/.bin/biome` -- the same shim npm itself installs, which is a
 * `#!/bin/sh` script on every platform.
 */
function repoWithHook(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anvil-hook-'))
  temps.push(dir)
  git(dir, 'init', '--initial-branch=main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  // Committed the way the project commits it, with the executable bit recorded: a hook
  // without it is skipped silently by git on POSIX.
  mkdirSync(join(dir, '.githooks'), { recursive: true })
  copyFileSync(HOOK, join(dir, '.githooks', 'pre-commit'))
  git(dir, 'add', '--chmod=+x', '.githooks/pre-commit')
  // Committed before the hook is enabled, so the repository has a history to assert
  // against and the helper itself does not depend on the hook passing.
  git(dir, 'commit', '-m', 'install hook')
  git(dir, 'config', 'core.hooksPath', '.githooks')
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
  const shim = join(dir, 'node_modules', '.bin', 'biome')
  writeFileSync(shim, `#!/bin/sh\nexec "${BIOME}" "$@"\n`, 'utf8')
  // The executable bit, which npm sets on a real `.bin` shim and `writeFileSync` does not.
  // Without it the hook's `"$biome" check` fails with "Permission denied" on Linux, and the
  // commit is rejected for a reason that has nothing to do with formatting -- which is how
  // this test failed on its first CI run while passing on Windows, where the bit is ignored.
  chmodSync(shim, 0o755)
  // The project's own biome config, because the hook runs with it. Without this the temp
  // repository falls back to biome's defaults, which want semicolons -- so a file that is
  // perfectly formatted *here* is reported as unformatted, and the test ends up measuring
  // biome's defaults instead of this hook.
  copyFileSync(join(REPO, 'biome.jsonc'), join(dir, 'biome.jsonc'))
  return dir
}

/** A file that is valid but not formatted the way biome wants it. */
const BAD = 'export const value   =    {a:1,b:2}\n'
const GOOD = 'export const value = { a: 1, b: 2 }\n'

function stage(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content, 'utf8')
  git(dir, 'add', name)
}

describe('the pre-commit hook', () => {
  test('a badly formatted staged file blocks the commit', () => {
    const dir = repoWithHook()
    stage(dir, 'bad.ts', BAD)
    const before = git(dir, 'log', '--oneline')
    const result = tryCommit(dir, 'should not land')
    assert.equal(result.ok, false, `commit unexpectedly succeeded:\n${result.output}`)
    assert.match(result.output, /pre-commit|lint\/format/i)
    // The history is unchanged, which is the entire point of blocking it.
    assert.equal(git(dir, 'log', '--oneline'), before)
  })

  test('a properly formatted staged file commits', () => {
    const dir = repoWithHook()
    stage(dir, 'good.ts', GOOD)
    const result = tryCommit(dir, 'lands')
    assert.equal(result.ok, true, `commit unexpectedly failed:\n${result.output}`)
    assert.match(git(dir, 'log', '--oneline'), /lands/)
  })

  test('the hook checks the staged files, not the working tree', () => {
    // Unformatted files are not unusual -- they are the normal state of a working tree. The
    // moment a developer starts fixing them, the hook must not follow them around.
    const dir = repoWithHook()
    stage(dir, 'good.ts', GOOD)
    writeFileSync(join(dir, 'scratch.ts'), BAD, 'utf8')
    const result = tryCommit(dir, 'only the staged file')
    assert.equal(result.ok, true, `commit unexpectedly failed:\n${result.output}`)
  })

  test('the hook says what to do when dependencies are not installed', () => {
    // A fresh clone with no `npm ci` must not fail with "command not found".
    const dir = mkdtempSync(join(tmpdir(), 'anvil-hook-bare-'))
    temps.push(dir)
    git(dir, 'init', '--initial-branch=main')
    git(dir, 'config', 'user.email', 'test@example.com')
    git(dir, 'config', 'user.name', 'Test')
    mkdirSync(join(dir, '.githooks'), { recursive: true })
    copyFileSync(HOOK, join(dir, '.githooks', 'pre-commit'))
    git(dir, 'add', '--chmod=+x', '.githooks/pre-commit')
    git(dir, 'config', 'core.hooksPath', '.githooks')
    stage(dir, 'a.ts', GOOD)
    const result = tryCommit(dir, 'no deps')
    assert.equal(result.ok, false)
    assert.match(result.output, /npm ci/)
  })
})

describe('the hook this repository ships', () => {
  test('is a POSIX script with an interpreter line, not a Windows batch file', () => {
    const content = readFileSync(HOOK, 'utf8')
    assert.match(content, /^#!\/bin\/sh/)
    // Git runs hooks through sh, so a CRLF line ending breaks the shebang. `.gitattributes`
    // pins `* text=auto eol=lf`, which is what guarantees it on a Windows checkout where
    // `core.autocrlf=true` is the default -- so the rule is asserted here too, because the
    // guarantee lives in that file and not in this one.
    assert.ok(!content.includes('\r\n'), 'the hook must use LF line endings')
    assert.match(readFileSync(join(REPO, '.gitattributes'), 'utf8'), /\*\s+text=auto\s+eol=lf/)
  })

  test('never skips checks on its own', () => {
    // The one thing a hook must not contain is a way to quietly not run. Comments are
    // excluded, because this file's own comment mentions `--no-verify` while explaining why
    // it does not use it -- a test that tripped over its own documentation would be a test
    // that pushes the next person to delete the explanation instead.
    const code = readFileSync(HOOK, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
    assert.ok(!code.includes('--no-verify'), 'the hook must not skip itself')
    assert.ok(!code.includes('|| true'), 'a hook must not swallow a failure')
  })
})
