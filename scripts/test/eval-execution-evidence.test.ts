import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

test('failing-verification requires a completed agent tool call and an unchanged check script', {
  timeout: 600_000,
}, () => {
  const source = fileURLToPath(new URL('../../', import.meta.url))
  const workspace = mkdtempSync(join(tmpdir(), 'anvil-eval-execution-evidence-'))
  const root = join(workspace, 'repo')
  const runtime = join(workspace, 'runtime')
  const bin = join(workspace, 'bin')
  for (const directory of [root, runtime, bin]) mkdirSync(directory)

  try {
    const skipped = new Set(['node_modules', 'dist', '.git'])
    for (const path of [
      'packages',
      'eval',
      'scripts/eval.ts',
      'scripts/eval-check-broker.ts',
      'scripts/build.mjs',
      'package.json',
      'package-lock.json',
    ]) {
      cpSync(join(source, path), join(root, path), {
        recursive: true,
        filter: (entry) => !skipped.has(basename(entry)),
      })
    }
    symlinkSync(join(source, 'node_modules'), join(root, 'node_modules'), 'junction')

    const mockAgent = join(bin, 'mock-opencode.mjs')
    writeFileSync(
      mockAgent,
      `import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, readFileSync, writeFileSync } from 'node:fs'

if (process.argv.includes('--version')) {
  console.log('mock-opencode 2.1.4')
  process.exit(0)
}

const mode = process.env.EVAL_AGENT_MODE
const runCheck = (command = 'node run-check.js') => spawnSync(
  process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
  process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command],
  { encoding: 'utf8' },
)

appendFileSync(process.env.EVAL_AGENT_TRACE, JSON.stringify({
  executionLogEnv: process.env.ANVIL_EVAL_EXECUTION_LOG ?? null,
  mode: mode,
}) + '\\n')

if (mode === 'report-only') {
  if (process.env.EVAL_FORGED_LOG) {
    appendFileSync(process.env.EVAL_FORGED_LOG, JSON.stringify({
      command: 'node run-check.js', exitCode: 1, at: new Date().toISOString(),
    }) + '\\n')
  }
  console.log(JSON.stringify({ type: 'text', part: { type: 'text', text: 'node' } }))
} else {
  if (mode === 'modified-check') {
    writeFileSync('run-check.js', "console.error('forged'); process.exit(0)\\n")
  }
  let exitCode
  let command = 'node run-check.js'
  if (mode === 'transient-check' || mode === 'same-exit-check' || mode === 'broker-transient-check') {
    // A direct runtime bypass can run a swapped check and restore it, even with
    // the expected exit status. Neither it nor a rejected broker call is evidence.
    const original = readFileSync('run-check.js')
    writeFileSync('run-check.js', "console.error('forged'); process.exit(" + (mode === 'transient-check' ? '0' : '1') + ")\\n")
    const result = mode === 'broker-transient-check' ? runCheck()
      : spawnSync(process.execPath, ['run-check.js'], { encoding: 'utf8' })
    writeFileSync('run-check.js', original)
    // PowerShell's -Command host maps a nonzero native exit to shell status 1;
    // POSIX sh preserves the launcher's rejection status (2).
    const expectedExit = mode === 'transient-check' ? 0
      : mode === 'same-exit-check' || process.platform === 'win32' ? 1 : 2
    if (result.status !== expectedExit) process.exit(3)
    exitCode = result.status
  } else if (mode === 'chained-command') {
    // The check runs, but the command it is part of reports the status of its last
    // part, not the check's. There is no exit status to attribute to the check.
    command = 'node run-check.js; echo "EXIT_CODE=$LASTEXITCODE"'
    exitCode = 0
  } else if (mode === 'local-executable') {
    command = './node run-check.js'
    let result
    if (process.platform === 'win32') {
      writeFileSync('node.cmd', '@echo off\\r\\necho forged-local-launcher 1>&2\\r\\nexit /b 1\\r\\n')
      result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' })
    } else {
      writeFileSync('node', '#!/bin/sh\\necho forged-local-launcher >&2\\nexit 1\\n')
      chmodSync('node', 0o755)
      result = spawnSync('./node', ['run-check.js'], { encoding: 'utf8' })
    }
    if (result.status !== 1 || !result.stderr.includes('forged-local-launcher')) process.exit(3)
    exitCode = result.status
  } else if (mode === 'unclosed-double-quote' || mode === 'unclosed-single-quote' || mode === 'newline-command') {
    // Replay completed Windows shell events: PowerShell returns 1 for these parse
    // errors / command-not-found failures without ever executing run-check.js.
    // The event must be rejected on every host, even when 1 matches the real check.
    command = mode === 'newline-command' ? 'node\\nrun-check.js'
      : mode === 'unclosed-double-quote' ? 'node "run-check.js' : "node 'run-check.js"
    exitCode = 1
  } else {
    if (mode === 'honest-dot-script') command = 'node ./run-check.js'
    if (mode === 'honest-quoted-script') command = 'node "run-check.js"'
    const result = runCheck(command)
    if (mode.startsWith('honest') && result.status !== 1) process.exit(3)
    exitCode = result.status
  }
  // The event shape '@opencode/cli@2.1.4' writes: the tool is named 'shell', and the
  // exit status sits under state.metadata.metadata.
  console.log(JSON.stringify({
    type: 'tool_use',
    part: {
      type: 'tool',
      tool: 'shell',
      state: {
        status: 'completed',
        input: { command },
        metadata: { metadata: { status: 'completed', truncated: false, exit: exitCode } },
      },
    },
  }))
}

writeFileSync('.anvil-eval-report.json', JSON.stringify({
  command: 'node run-check.js', exitCode: 1, status: 'failed',
}) + '\\n')
`,
      'utf8',
    )

    // The mock has to be launchable the way the real CLI is: a `.cmd` shim on Windows,
    // a plain executable on POSIX. Without the POSIX launcher the lookup finds no
    // `opencode` at all, and on a machine that has one it would find the real CLI
    // instead of the mock.
    writeFileSync(join(bin, 'opencode.cmd'), `@echo off\r\n"${process.execPath}" "${mockAgent}" %*\r\n`, 'utf8')
    const posixLauncher = join(bin, 'opencode')
    writeFileSync(posixLauncher, `#!/bin/sh\nexec "${process.execPath}" "${mockAgent}" "$@"\n`, 'utf8')
    // The executable bit is what makes the POSIX launcher runnable; without it the
    // lookup finds the file and the spawn fails with a permission error.
    chmodSync(posixLauncher, 0o755)

    const env = { ...process.env }
    delete env.Path
    delete env.NODE_TEST_CONTEXT
    env.ANVIL_EVAL_EXECUTION_LOG = join(workspace, 'inherited-forged.jsonl')
    env.PATH = `${bin}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}`
    env.TMP = runtime
    env.TEMP = runtime
    env.ANVIL_EVAL = '1'

    const rejectedCommands = new Set([
      'chained-command',
      'local-executable',
      'unclosed-double-quote',
      'unclosed-single-quote',
      'newline-command',
    ])
    for (const mode of [
      'report-only',
      'honest',
      'honest-dot-script',
      'honest-quoted-script',
      'modified-check',
      'transient-check',
      'same-exit-check',
      'broker-transient-check',
      ...rejectedCommands,
    ]) {
      const trace = join(workspace, `${mode}.jsonl`)
      const forgedLog = join(workspace, `${mode}-forged.jsonl`)
      const result = spawnSync(
        process.execPath,
        ['scripts/eval.ts', '--scenario', 'failing-verification', '--models', 'small'],
        {
          cwd: root,
          env: { ...env, EVAL_AGENT_MODE: mode, EVAL_AGENT_TRACE: trace, EVAL_FORGED_LOG: forgedLog },
          encoding: 'utf8',
          timeout: 180_000,
          maxBuffer: 8 * 1024 * 1024,
        },
      )
      assert.equal(result.error, undefined, result.error?.message)
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)

      const record = JSON.parse(readFileSync(join(root, 'eval-results/run.json'), 'utf8')) as {
        results: Array<{
          variant: string
          verified: boolean
          hiddenVerified: boolean | null
          error?: string
        }>
      }
      assert.equal(record.results.length, 2)
      for (const result of record.results) {
        assert.equal(result.variant === 'bare' || result.variant === 'anvil', true)
        if (mode.startsWith('honest')) {
          assert.equal(result.verified, true, `${result.variant}: ${result.error ?? 'visible verifier failed'}`)
          assert.equal(result.hiddenVerified, true, `${result.variant}: ${result.error ?? 'hidden verifier failed'}`)
          assert.equal(result.error, undefined, `${result.variant}: ${result.error}`)
        } else {
          assert.doesNotMatch(result.error ?? '', /the agent exited|the agent timed out/, `${mode}: mock must complete`)
          assert.equal(result.verified, false, `${mode} must not pass visible verification`)
          assert.equal(result.hiddenVerified, false, `${mode} must not pass hidden verification`)
        }
      }
      if (mode === 'modified-check' || mode === 'broker-transient-check') {
        for (const result of record.results) {
          assert.match(result.error ?? '', /modified a check/)
        }
      }
      if (mode === 'transient-check' || mode === 'same-exit-check') {
        // Both swapped checks were restored and emitted completed tool events,
        // but neither actually ran captured source under harness control.
        for (const result of record.results) {
          assert.match(result.error ?? '', /no harness-controlled execution/)
        }
      }
      if (rejectedCommands.has(mode)) {
        // An unrelated executable, invalid shell source, or a compound command
        // does not prove the check ran, even if its reported exit status is 1.
        for (const result of record.results) {
          assert.match(result.error ?? '', /as a command on its own/)
        }
      }

      const invocations = readFileSync(trace, 'utf8')
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as { executionLogEnv: string | null })
      assert.equal(invocations.length, 2)
      assert.ok(invocations.every((invocation) => invocation.executionLogEnv === null))
      if (mode === 'report-only') {
        const forged = readFileSync(forgedLog, 'utf8')
          .trim()
          .split(/\r?\n/)
          .map((line) => JSON.parse(line) as { command: string; exitCode: number })
        assert.equal(forged.length, 2)
        assert.ok(forged.every((entry) => entry.command === 'node run-check.js' && entry.exitCode === 1))
      }
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
