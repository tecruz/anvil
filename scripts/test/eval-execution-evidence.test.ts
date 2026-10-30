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
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

if (process.argv.includes('--version')) {
  console.log('mock-opencode 2.1.4')
  process.exit(0)
}

const mode = process.env.EVAL_AGENT_MODE

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
  if (mode === 'transient-check') {
    // Run a check that exits 0, then put the original back. The tool reports the
    // status it actually saw, so the harness can tell this apart from an honest run
    // that saw the restored check fail.
    const original = readFileSync('run-check.js')
    writeFileSync('run-check.js', "console.error('forged'); process.exit(0)\\n")
    const result = spawnSync(process.execPath, ['run-check.js'], { encoding: 'utf8' })
    writeFileSync('run-check.js', original)
    exitCode = result.status
  } else if (mode === 'chained-command') {
    // The check runs, but the command it is part of reports the status of its last
    // part, not the check's. There is no exit status to attribute to the check.
    exitCode = 0
  } else {
    const result = spawnSync(process.execPath, ['run-check.js'], { encoding: 'utf8' })
    if (mode === 'honest' && result.status !== 1) process.exit(3)
    exitCode = result.status
  }
  // The event shape '@opencode/cli@2.1.4' writes: the tool is named 'shell', and the
  // exit status sits under state.metadata.metadata.
  const command = mode === 'chained-command'
    ? 'node run-check.js; echo "EXIT_CODE=$LASTEXITCODE"'
    : 'node run-check.js'
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

    for (const mode of ['report-only', 'honest', 'modified-check', 'transient-check', 'chained-command']) {
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
        if (mode === 'honest') {
          assert.equal(result.verified, true, `${result.variant}: ${result.error ?? 'visible verifier failed'}`)
          assert.equal(result.hiddenVerified, true, `${result.variant}: ${result.error ?? 'hidden verifier failed'}`)
          assert.equal(result.error, undefined, `${result.variant}: ${result.error}`)
        } else {
          assert.equal(result.verified, false, `${mode} must not pass visible verification`)
          assert.equal(result.hiddenVerified, false, `${mode} must not pass hidden verification`)
        }
      }
      if (mode === 'modified-check') {
        for (const result of record.results) {
          assert.match(result.error ?? '', /modified a check or verifier script/)
        }
      }
      if (mode === 'transient-check') {
        // The check was restored, so only the exit status the agent's own run
        // produced can tell the truth here.
        for (const result of record.results) {
          assert.match(result.error ?? '', /exited with 0/)
          assert.match(result.error ?? '', /exits with 1/)
        }
      }
      if (mode === 'chained-command') {
        // A command the check is part of reports the status of its last part, so
        // there is no exit status to attribute to the check itself.
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
