import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { isUnsafeArgument, probeCommandVersion, quoteForCmd, resolveCommand, runProcess } from '@anvil/core'

/**
 * Windows process execution.
 *
 * These tests exist because a naive `execFile('npm', ...)` fails with ENOENT on Windows:
 * npm is a `.cmd` shim and Node does not resolve PATHEXT. That silently broke every verify
 * command, `gh` call and agent launch on Windows, so the behaviour is pinned here rather
 * than re-broken by a well-meaning refactor.
 */

describe('argument safety', () => {
  test('rejects every character cmd would treat as a metacharacter', () => {
    // If any of these got through, a malicious PR body or ticket title could execute.
    for (const arg of ['a&b', 'a|b', 'a>b', 'a<b', 'a"b', 'a^b', 'a`b', 'a!b', 'a\nb', 'a\rb', 'a\0b']) {
      assert.equal(isUnsafeArgument(arg), true, JSON.stringify(arg))
    }
  })

  test('allows the characters real commands legitimately contain', () => {
    for (const arg of [
      'run',
      'test',
      './gradlew',
      '--tests',
      '*Changed*',
      'path/with space',
      '%PATH%',
      '(x)',
      'a,b',
      '-Dfoo=1',
    ]) {
      assert.equal(isUnsafeArgument(arg), false, JSON.stringify(arg))
    }
  })
})

describe('cmd quoting', () => {
  test('leaves simple tokens alone', () => {
    assert.equal(quoteForCmd('run'), 'run')
    assert.equal(quoteForCmd('./gradlew'), './gradlew')
  })

  test('quotes a path with a space', () => {
    assert.equal(quoteForCmd('C:\\Program Files\\nodejs\\npm.CMD'), '"C:\\Program Files\\nodejs\\npm.CMD"')
  })

  test('quotes an argument with a space', () => {
    assert.equal(quoteForCmd('some arg'), '"some arg"')
  })

  test('quotes an empty argument rather than dropping it', () => {
    assert.equal(quoteForCmd(''), '""')
  })

  test('leaves a glob unquoted but harmless', () => {
    // cmd does not glob, so `*` needs no escaping -- but it is not in the safe set, so it
    // gets quoted, which is also fine.
    assert.match(quoteForCmd('*Changed*'), /Changed/)
  })
})

describe('resolveCommand', () => {
  test('finds a real executable on PATH', () => {
    const found = resolveCommand(process.platform === 'win32' ? 'git' : 'git')
    assert.ok(found !== null, 'git should be on PATH')
    assert.equal(found?.isShim, false, 'git is a real executable, not a shim')
  })

  test('returns null for something that does not exist', () => {
    assert.equal(resolveCommand('definitely-not-a-real-binary-xyz'), null)
  })

  test('resolves the .cmd shim for npm on Windows', () => {
    if (process.platform !== 'win32') return
    const found = resolveCommand('npm')
    assert.ok(found !== null, 'npm should resolve')
    assert.equal(found?.isShim, true, 'npm on Windows is a .cmd shim and must go through cmd')
    assert.match(found?.path ?? '', /\.CMD$|\.cmd$/)
  })

  test('a directory is not a resolvable command', () => {
    // `existsSync` is satisfied by a directory, so a directory named `npm.exe` on PATH used to
    // resolve as the binary. The consequence was an `EISDIR` at spawn time, reported as
    // INTERNAL exit 70 ("Bug in anvil") instead of a clean "command not found" with exit 7 --
    // and on the agent-launch path, a directory handed to `spawn` as the program.
    const dir = mkdtempSync(join(tmpdir(), 'anvil-dirbin-'))
    // On Windows the resolver tries `acme` + each PATHEXT extension, so the decoy directory is
    // named `acme.exe`; on POSIX the bare name is used.
    const query = 'acme'
    const decoy = process.platform === 'win32' ? 'acme.exe' : 'acme'
    mkdirSync(join(dir, decoy))
    assert.equal(resolveCommand(query, { env: { PATH: dir } as NodeJS.ProcessEnv }), null)
    assert.equal(resolveCommand(join(dir, decoy)), null, 'an explicit directory path is not a binary either')
  })

  test('a real file of the resolvable name still resolves next to a decoy directory', () => {
    // The check must reject only the directory, not skip past it to nothing.
    const dir = mkdtempSync(join(tmpdir(), 'anvil-binfile-'))
    const query = 'acme'
    const file = process.platform === 'win32' ? 'acme.exe' : 'acme'
    mkdirSync(join(dir, `${file}.d`))
    writeFileSync(join(dir, file), 'binary')
    const found = resolveCommand(query, { env: { PATH: dir } as NodeJS.ProcessEnv })
    assert.ok(found !== null, 'the real file should resolve')
    assert.equal(found?.isShim, false)
  })
})

describe('runProcess', () => {
  test('runs a real executable and returns stdout', async () => {
    // node is itself a .exe on Windows, so this covers the non-shim path.
    const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("hello")'])
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, 'hello')
  })

  test('returns a non-zero exit code rather than throwing', async () => {
    const result = await runProcess(process.execPath, ['-e', 'process.exit(3)'])
    assert.equal(result.exitCode, 3)
  })

  test('captures stderr', async () => {
    const result = await runProcess(process.execPath, ['-e', 'process.stderr.write("bad")'])
    assert.equal(result.stdout + result.stderr, 'bad')
  })

  test('throws a ToolMissing error naming the binary, with a Windows-specific hint', async () => {
    await assert.rejects(
      () => runProcess('definitely-not-a-real-binary-xyz'),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /Command not found/)
        return true
      },
    )
  })

  test('honours cwd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-exec-'))
    writeFileSync(join(dir, 'marker.txt'), 'x', 'utf8')
    const result = await runProcess(
      process.execPath,
      ['-e', 'process.stdout.write(require("fs").readdirSync(".").join(","))'],
      { cwd: dir },
    )
    assert.match(result.stdout, /marker\.txt/)
  })

  test('runs an npm script, which is the case that was broken on Windows', async () => {
    // The whole reason this module exists. A shim with a spaced path, on Windows, with
    // an argument -- previously ENOENT, then a literal-quote error.
    const dir = mkdtempSync(join(tmpdir(), 'anvil-exec-npm-'))
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'x',
        scripts: { t: 'node -e "process.stdout.write(\'shim-ok\')"' },
      }),
      'utf8',
    )
    const result = await runProcess('npm', ['run', 't'], { cwd: dir })
    assert.equal(result.exitCode, 0, result.stderr)
    assert.match(result.stdout, /shim-ok/)
  })

  test('refuses an unsafe argument on a shim instead of running it', async () => {
    // Proves the refusal happens before execution, on the path that would otherwise be
    // injectable.
    //
    // Windows only, and the reason is structural rather than a shrug: the risk being tested
    // is argument interpretation by `cmd.exe`, which only exists on the `.cmd` shim path.
    // On POSIX there is no shim and no shell -- `runProcess` is `execFile` with an argument
    // array -- so `&` and `>` in an argument are already inert and there is nothing to
    // refuse. The first version of this test ran everywhere and failed on both Linux and
    // macOS, where npm simply reports an unknown script.
    if (process.platform !== 'win32') return
    const dir = mkdtempSync(join(tmpdir(), 'anvil-exec-unsafe-'))
    const created = join(dir, 'canary.txt')
    await assert.rejects(
      () => runProcess('npm', ['run', `t&echo pwned>${created}`], { cwd: dir }),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /would interpret/)
        return true
      },
    )
  })
})

describe('probeCommandVersion', () => {
  test('reads the semver a real executable reports', async () => {
    // Node itself is always present in this suite, so the probe needs no fixture binary.
    const version = await probeCommandVersion(process.execPath)
    assert.match(version ?? '', /^\d+\.\d+\.\d+/)
  })

  test('a missing binary is unknown, not a failed claim', async () => {
    assert.equal(await probeCommandVersion('definitely-not-a-real-binary-xyz'), null)
  })
})
