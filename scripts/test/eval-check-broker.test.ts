import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { type TestContext, test } from 'node:test'

import { spawnArgv } from '../../packages/core/src/exec.ts'
import { type CheckBroker, captureCheck, startCheckBroker } from '../eval-check-broker.ts'

const original = "console.error('original-check'); process.exit(1)\n"

async function fixture(t: TestContext, source = original, directoryAlias = false) {
  const root = mkdtempSync(join(tmpdir(), 'anvil-check-broker-test-'))
  const trusted = join(root, 'fixture')
  let workdir = join(root, 'workdir')
  mkdirSync(trusted)
  mkdirSync(workdir)
  writeFileSync(join(trusted, 'run-check.js'), source)
  writeFileSync(join(workdir, 'run-check.js'), source)
  if (directoryAlias) {
    const alias = join(root, 'alias')
    symlinkSync(workdir, alias, process.platform === 'win32' ? 'junction' : 'dir')
    workdir = alias
  }
  const check = captureCheck('node run-check.js', 'run-check.js', trusted)
  const broker = await startCheckBroker([check], workdir)
  t.after(async () => {
    await broker.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  return { workdir, check, broker }
}

async function launch(broker: CheckBroker, cwd: string, args: string[], shell = false) {
  const env = { ...process.env, ...broker.env }
  delete env.NODE_TEST_CONTEXT
  const command = shell
    ? process.platform === 'win32'
      ? spawnArgv('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'node run-check.js'], { env })
      : spawnArgv('/bin/sh', ['-c', 'node run-check.js'], { env })
    : spawnArgv('node', args, { env })
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
    const child = spawn(command.file, command.args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
      ...(command.resolved.isShim ? { windowsVerbatimArguments: true } : {}),
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.once('error', reject)
    child.once('close', (code) => resolvePromise({ code, stdout, stderr }))
  })
}

function endpoint(broker: CheckBroker): string {
  const path = Object.values(broker.env)[0] as string
  const client = readFileSync(join(path.split(delimiter)[0] as string, 'client.mjs'), 'utf8')
  const match = /fetch\(("[^"]+")/.exec(client)
  assert.ok(match)
  return JSON.parse(match[1] as string) as string
}

test('the launcher returns actual output and a source-bound parent-process record', async (t) => {
  const { workdir, check, broker } = await fixture(t)
  const result = await launch(broker, workdir, ['./run-check.js'])
  assert.equal(result.code, 1, result.stderr)
  assert.match(result.stderr, /original-check/)
  assert.equal(broker.executions.length, 1)
  assert.equal(broker.executions[0]?.sourceHash, check.sourceHash)
  assert.equal(broker.executions[0]?.exitCode, 1)
  assert.equal(broker.integrityError, null)
  assert.equal(broker.env.ANVIL_EVAL_EXECUTION_LOG, undefined)

  const version = await launch(broker, workdir, ['--version'])
  assert.equal(version.code, 0, version.stderr)
  assert.match(version.stdout, /^v\d+/)
  assert.equal(broker.executions.length, 1, 'non-check Node commands must not produce evidence')
  await broker.close()
  await broker.close()
})

test('same-exit script replacement is rejected and the integrity error survives restoration', async (t) => {
  const { workdir, broker } = await fixture(t)
  writeFileSync(join(workdir, 'run-check.js'), "console.error('forged'); process.exit(1)\n")
  const forged = await launch(broker, workdir, ['run-check.js'])
  writeFileSync(join(workdir, 'run-check.js'), original)
  assert.equal(forged.code, 2)
  assert.match(forged.stderr, /modified a check script at execution time/)
  assert.equal(broker.executions.length, 0)
  const honest = await launch(broker, workdir, ['run-check.js'])
  assert.equal(honest.code, 1)
  assert.equal(broker.executions.length, 1)
  assert.match(broker.integrityError ?? '', /modified a check script/)
})

test('a declared directory alias and its physical cwd share execution provenance', async (t) => {
  const { workdir, broker } = await fixture(t, original, true)
  const result = await launch(broker, realpathSync(workdir), ['./run-check.js'])
  assert.equal(result.code, 1, result.stderr)
  assert.match(result.stderr, /original-check/)
  assert.equal(broker.executions.length, 1, 'the launcher must not fall back to an unrecorded native run')
})

test('a shell-normalized cwd still routes through the check broker', async (t) => {
  const { workdir, broker } = await fixture(t, original, true)
  const cwd = process.platform === 'win32' ? workdir.toUpperCase() : realpathSync(workdir)
  const result = await launch(broker, cwd, ['run-check.js'], true)
  assert.equal(result.code, 1, result.stderr)
  assert.match(result.stderr, /original-check/)
  assert.equal(broker.executions.length, 1, 'PowerShell/sh must not bypass capture when normalizing the cwd')
})

test('broker requests accept equivalent directory aliases but reject a different directory', async (t) => {
  const { workdir, check, broker } = await fixture(t, original, true)
  for (const cwd of [workdir, realpathSync(workdir)]) {
    const response = await fetch(endpoint(broker), {
      method: 'POST',
      body: JSON.stringify({ command: check.command, cwd }),
    })
    assert.equal(response.status, 200, await response.text())
  }
  assert.equal(broker.executions.length, 2)
  const response = await fetch(endpoint(broker), {
    method: 'POST',
    body: JSON.stringify({ command: check.command, cwd: tmpdir() }),
  })
  assert.equal(response.status, 400)
  assert.equal(broker.executions.length, 2)
})

test('a client can request execution but cannot submit source or attest to an exit status', async (t) => {
  const { workdir, check, broker } = await fixture(t)
  const response = await fetch(endpoint(broker), {
    method: 'POST',
    body: JSON.stringify({ command: check.command, cwd: workdir, source: 'process.exit(0)', exitCode: 0 }),
  })
  assert.equal(response.status, 200)
  const result = (await response.json()) as { exitCode: number; stderr: string; sourceHash: string }
  assert.equal(result.exitCode, 1)
  assert.equal(result.sourceHash, check.sourceHash)
  assert.match(result.stderr, /original-check/)
  assert.equal(broker.executions.length, 1)
  const rejected = await fetch(endpoint(broker), {
    method: 'POST',
    body: JSON.stringify({ command: check.command, cwd: tmpdir() }),
  })
  assert.equal(rejected.status, 400)
  assert.equal(broker.executions.length, 1)
})

test('a file swap after execution starts cannot change the source Node executes', { timeout: 30_000 }, async (t) => {
  const source = `import { writeFileSync } from 'node:fs'
writeFileSync('started', 'yes')
await new Promise((resolve) => setTimeout(resolve, 200))
console.error('original-check')
process.exit(1)
`
  const { workdir, check, broker } = await fixture(t, source)
  let notify: () => void = () => {}
  const started = new Promise<void>((resolvePromise) => {
    notify = resolvePromise
  })
  const watcher = watch(workdir, () => {
    if (existsSync(join(workdir, 'started'))) notify()
  })
  try {
    const execution = launch(broker, workdir, ['run-check.js'])
    await started
    writeFileSync(join(workdir, 'run-check.js'), "console.error('forged'); process.exit(1)\n")
    const result = await execution
    assert.equal(result.code, 1)
    assert.match(result.stderr, /original-check/)
    assert.doesNotMatch(result.stderr, /forged/)
    assert.equal(broker.executions[0]?.sourceHash, check.sourceHash)
  } finally {
    watcher.close()
  }
})
