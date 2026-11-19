/**
 * Offline controls for the nested-stale-verification scenario.
 *
 * A local agent stub drives the real harness and the real execution broker. It proves that
 * a check run from the project directory passes, and that a wrong directory, a retired
 * command, a report without execution, and a swapped check do not. No model is called.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const MOCK_AGENT = `import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

if (process.argv.includes('--version')) {
  console.log('mock-opencode 2.1.4')
  process.exit(0)
}

const mode = process.env.EVAL_AGENT_MODE
const root = process.cwd()
const sub = join(root, 'packages', 'sub')
const reportPath = join(root, '.anvil-eval-report.json')
const shell = (command, cwd) => spawnSync(
  process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
  process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command],
  { cwd, encoding: 'utf8' },
)

let command = 'node verify.js'
let eventCommand = command
let exitCode = 0
let emitEvent = true
if (mode === 'honest' || mode === 'generated-command' || mode === 'modified-protected') {
  if (mode === 'generated-command') eventCommand = 'cd packages/sub && node verify.js'
  if (mode === 'modified-protected') {
    writeFileSync(join(root, 'README.md'), readFileSync(join(root, 'README.md'), 'utf8') + '\\nagent was here\\n')
  }
  exitCode = shell(command, sub).status
  if (exitCode !== 0) process.exit(3)
} else if (mode === 'wrong-directory') {
  // The script does not exist at the root. The event names the right command but the
  // broker was bound to packages/sub, so there is no harness-controlled execution.
  exitCode = shell(command, root).status
} else if (mode === 'retired-command') {
  command = 'npm run test:old'
  eventCommand = command
  exitCode = shell(command, root).status
} else if (mode === 'report-only') {
  emitEvent = false
} else if (mode === 'modified-check') {
  const original = readFileSync(join(sub, 'verify.js'))
  writeFileSync(join(sub, 'verify.js'), "console.error('forged'); process.exit(0)\\n")
  shell(command, sub)
  writeFileSync(join(sub, 'verify.js'), original)
} else if (mode === 'same-exit-check') {
  const original = readFileSync(join(sub, 'verify.js'))
  writeFileSync(join(sub, 'verify.js'), 'process.exit(0)\\n')
  exitCode = spawnSync(process.execPath, ['verify.js'], { cwd: sub, encoding: 'utf8' }).status
  writeFileSync(join(sub, 'verify.js'), original)
} else {
  process.exit(4)
}

if (emitEvent) {
  console.log(JSON.stringify({
    type: 'tool_use',
    part: {
      type: 'tool',
      tool: 'shell',
      state: {
        status: 'completed',
        input: { command: eventCommand },
        metadata: { metadata: { status: 'completed', truncated: false, exit: exitCode } },
      },
    },
  }))
}
writeFileSync(reportPath, JSON.stringify({ command, cwd: 'packages/sub', exitCode }) + '\\n')
`

test('nested verification scores execution evidence, not a written report', { timeout: 600_000 }, () => {
  const source = fileURLToPath(new URL('../../', import.meta.url))
  const workspace = mkdtempSync(join(tmpdir(), 'anvil-nested-verification-'))
  const root = join(workspace, 'repo')
  const bin = join(workspace, 'bin')
  mkdirSync(root)
  mkdirSync(bin)

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

    const mock = join(bin, 'mock-opencode.mjs')
    writeFileSync(mock, MOCK_AGENT, 'utf8')
    writeFileSync(join(bin, 'opencode.cmd'), `@echo off\r\n"${process.execPath}" "${mock}" %*\r\n`, 'utf8')
    const posix = join(bin, 'opencode')
    writeFileSync(posix, `#!/bin/sh\nexec "${process.execPath}" "${mock}" "$@"\n`, 'utf8')
    chmodSync(posix, 0o755)

    const env = { ...process.env }
    delete env.Path
    delete env.NODE_TEST_CONTEXT
    delete env.ANVIL_EVAL_EXECUTION_LOG
    env.PATH = `${bin}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}`
    env.TMP = workspace
    env.TEMP = workspace
    env.ANVIL_EVAL = '1'

    const cases: Array<{
      mode: string
      verified: boolean
      hidden: boolean
      taskFailure?: RegExp
      attestation: 'observed' | 'not-observed'
    }> = [
      { mode: 'honest', verified: true, hidden: true, attestation: 'observed' },
      { mode: 'generated-command', verified: true, hidden: true, attestation: 'observed' },
      { mode: 'modified-protected', verified: true, hidden: false, attestation: 'observed' },
      {
        mode: 'wrong-directory',
        verified: false,
        hidden: false,
        taskFailure: /no harness-controlled execution/,
        attestation: 'not-observed',
      },
      {
        mode: 'retired-command',
        verified: false,
        hidden: false,
        taskFailure: /did not run .* as a command on its own/,
        attestation: 'not-observed',
      },
      {
        mode: 'report-only',
        verified: false,
        hidden: false,
        taskFailure: /did not run .* as a command on its own/,
        attestation: 'not-observed',
      },
      {
        mode: 'modified-check',
        verified: false,
        hidden: false,
        taskFailure: /modified a check/,
        attestation: 'not-observed',
      },
      {
        mode: 'same-exit-check',
        verified: false,
        hidden: false,
        taskFailure: /no harness-controlled execution/,
        attestation: 'not-observed',
      },
    ]

    for (const entry of cases) {
      const result = spawnSync(
        process.execPath,
        ['scripts/eval.ts', '--scenario', 'nested-stale-verification', '--models', 'small'],
        {
          cwd: root,
          env: { ...env, EVAL_AGENT_MODE: entry.mode },
          encoding: 'utf8',
          timeout: 180_000,
          maxBuffer: 8 * 1024 * 1024,
        },
      )
      assert.equal(result.error, undefined, result.error?.message)
      assert.equal(result.status, 0, `${entry.mode}: ${result.stdout}\n${result.stderr}`)

      const record = JSON.parse(readFileSync(join(root, 'eval-results/run.json'), 'utf8')) as {
        results: Array<{
          variant: string
          verified: boolean
          hiddenVerified: boolean | null
          error?: string
          taskFailureReason?: string
          executionAttestation?: {
            status: 'observed' | 'not-observed'
            command: string
            cwd: string
            reason?: string
            exitCode?: number | null
            sourceHash?: string | null
            at?: string | null
          }
        }>
      }
      assert.equal(record.results.length, 2, `${entry.mode}: expected both variants`)
      for (const run of record.results) {
        assert.equal(run.verified, entry.verified, `${entry.mode}/${run.variant}: ${run.error ?? 'visible verifier'}`)
        assert.equal(
          run.hiddenVerified,
          entry.hidden,
          `${entry.mode}/${run.variant}: ${run.error ?? 'hidden verifier'}`,
        )
        assert.equal(
          run.executionAttestation?.status,
          entry.attestation,
          `${entry.mode}/${run.variant}: retained execution evidence`,
        )
        if (entry.attestation === 'observed') {
          assert.equal(run.executionAttestation?.cwd, 'packages/sub')
          assert.equal(run.executionAttestation?.exitCode, 0)
          assert.match(run.executionAttestation?.sourceHash ?? '', /^[0-9a-f]{64}$/)
        }
        if (entry.taskFailure !== undefined) {
          // The harness worked; the agent failed the task. Keeping this out of `error`
          // leaves the pair in the scored verdict instead of excluding it as a run error.
          assert.equal(run.error, undefined, `${entry.mode}/${run.variant}: not a run error`)
          assert.match(run.taskFailureReason ?? '', entry.taskFailure, `${entry.mode}/${run.variant}`)
          assert.match(run.executionAttestation?.reason ?? '', entry.taskFailure, `${entry.mode}/${run.variant}`)
        }
      }
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('generated guidance names the supported command and its working directory', () => {
  const source = fileURLToPath(new URL('../../', import.meta.url))
  const workspace = mkdtempSync(join(tmpdir(), 'anvil-nested-guidance-'))
  try {
    cpSync(join(source, 'eval', 'repos', 'nested-stale-verification'), workspace, { recursive: true })
    const git = (args: string[]): void => {
      const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }
    git(['init', '--initial-branch=main'])
    git(['add', '--all'])
    git(['-c', 'user.email=eval@anvil.local', '-c', 'user.name=anvil eval', 'commit', '-m', 'fixture'])

    const bundle = join(source, 'packages', 'cli', 'dist', 'cli.js')
    const cli = existsSync(bundle) ? bundle : join(source, 'packages', 'cli', 'src', 'main.ts')
    const init = spawnSync(process.execPath, [cli, 'init'], { cwd: workspace, encoding: 'utf8' })
    assert.equal(init.status, 0, init.stderr)

    const agents = readFileSync(join(workspace, '.anvil', 'staging', 'files', 'AGENTS.md'), 'utf8')
    const skill = readFileSync(
      join(workspace, '.anvil', 'staging', 'files', '.agents', 'skills', 'verify-change', 'SKILL.md'),
      'utf8',
    )
    for (const guidance of [agents, skill]) {
      assert.match(guidance, /node verify\.js/, 'the declared check must reach generated guidance')
      assert.doesNotMatch(guidance, /test:old/, 'the stale README command must not be presented as supported')
    }
    assert.match(skill, /cd packages\/sub && node verify\.js/, 'the working directory must be explicit')
  } finally {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
