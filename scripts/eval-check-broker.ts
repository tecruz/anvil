import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface CapturedCheck {
  command: string
  script: string
  source: string
  sourceHash: string
}

export interface CheckExecution {
  command: string
  exitCode: number
  sourceHash: string
  stdout: string
  stderr: string
  at: string
}

export interface CheckBroker {
  /** Only the node launcher is exposed, never the verifier's execution log. */
  env: NodeJS.ProcessEnv
  executions: readonly CheckExecution[]
  readonly integrityError: string | null
  close(): Promise<void>
}

export function captureCheck(command: string, script: string, fixtureRoot: string): CapturedCheck {
  const source = readFileSync(join(fixtureRoot, script), 'utf8')
  return { command, script, source, sourceHash: hashSource(source) }
}

function hashSource(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex')
}

/**
 * A PATH launcher asks this parent-process broker to execute a captured Node ESM
 * check. Source comes from a pre-agent snapshot held in memory, not a file the
 * agent could swap. The client may be edited or bypassed, but it cannot add an
 * execution record: even a direct HTTP request has to run the captured source.
 * This is a provenance boundary, not an OS sandbox for hostile native processes.
 */
export async function startCheckBroker(checks: readonly CapturedCheck[], workdir: string): Promise<CheckBroker> {
  // macOS temporary paths (/var vs /private/var), Windows short names and shell
  // directory normalization can give the same directory different spellings.
  const directory = realpathSync.native(workdir)
  const executions: CheckExecution[] = []
  let integrityError: string | null = null
  let closing = false
  let requests = 0
  const route = `/${randomUUID()}`
  const pending = new Set<Promise<void>>()
  const reply = (response: ServerResponse, status: number, body: unknown): void => {
    if (response.destroyed || response.writableEnded) return
    response.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' })
    response.end(JSON.stringify(body))
  }
  const server = createServer((request, response) => {
    const handle = async (): Promise<void> => {
      if (closing || request.method !== 'POST' || request.url !== route || ++requests > 64) {
        reply(response, 404, { error: 'unsupported check request' })
        return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of request) {
        bytes += chunk.length
        if (bytes > 8192) throw new Error('check request is too large')
        chunks.push(Buffer.from(chunk))
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { command?: unknown; cwd?: unknown }
      const check = checks.find((entry) => entry.command === input?.command)
      let requestDirectory: string | null = null
      if (typeof input?.cwd === 'string') {
        try {
          requestDirectory = realpathSync.native(input.cwd)
        } catch {
          // An invalid path is not the scenario directory.
        }
      }
      if (check === undefined || requestDirectory !== directory) {
        reply(response, 400, { error: 'unknown check or working directory' })
        return
      }
      let current: string | null = null
      try {
        current = readFileSync(join(directory, check.script), 'utf8')
      } catch {
        // A missing script is an integrity failure too.
      }
      if (current === null || hashSource(current) !== check.sourceHash) {
        integrityError = 'the agent modified a check script at execution time; execution evidence is invalid'
        reply(response, 409, { error: integrityError })
        return
      }
      // Never accept source, environment, argv or an exit status from the client.
      // The absolute runtime and captured source prevent executable/file swaps and
      // a race between the integrity check above and Node reading the main script.
      const env: NodeJS.ProcessEnv = { ...process.env, PWD: directory }
      for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'NODE_TEST_CONTEXT', 'ANVIL_EVAL_EXECUTION_LOG'])
        delete env[name]
      let exitCode = 0
      let stdout: string
      let stderr: string
      try {
        const result = await execFileAsync(process.execPath, ['--input-type=module', '--eval', check.source], {
          cwd: directory,
          env,
          encoding: 'utf8',
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        })
        stdout = result.stdout
        stderr = result.stderr
      } catch (error) {
        const result = error as { code?: unknown; killed?: boolean; stdout?: string; stderr?: string }
        if (result.killed || typeof result.code !== 'number') throw error
        exitCode = result.code
        stdout = result.stdout ?? ''
        stderr = result.stderr ?? ''
      }
      const execution = {
        command: check.command,
        exitCode,
        sourceHash: check.sourceHash,
        stdout,
        stderr,
        at: new Date().toISOString(),
      }
      executions.push(execution)
      reply(response, 200, execution)
    }
    const task = handle().catch((error: unknown) => {
      reply(response, 500, { error: error instanceof Error ? error.message : String(error) })
    })
    pending.add(task)
    void task.finally(() => pending.delete(task))
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000
  const launcher = mkdtempSync(join(tmpdir(), 'anvil-eval-node-'))
  let closed: Promise<void> | null = null
  const close = (): Promise<void> => {
    closed ??= (async () => {
      closing = true
      server.closeAllConnections()
      if (server.listening) {
        await new Promise<void>((resolvePromise, reject) =>
          server.close((error) => (error ? reject(error) : resolvePromise())),
        )
      }
      await Promise.all(pending)
      rmSync(launcher, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    })()
    return closed
  }
  try {
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolvePromise()
      })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('check broker did not bind a TCP port')

    // Keep the launcher separate from the private log directory. Its location and
    // endpoint are not secrets: a caller can request execution, never attest to it.
    const client = join(launcher, 'client.mjs')
    const endpoint = `http://127.0.0.1:${address.port}${route}`
    const script = `import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
const checks = ${JSON.stringify(checks.map(({ command, script }) => ({ command, script })))}
const cwd = ${JSON.stringify(directory)}
const actualCwd = realpathSync.native(process.cwd())
const args = process.argv.slice(2)
const check = actualCwd === cwd && args.length === 1
  ? checks.find((entry) => resolve(cwd, args[0]) === resolve(cwd, entry.script)) : undefined
if (check === undefined) {
  const child = spawn(${JSON.stringify(process.execPath)}, args, { stdio: 'inherit' })
  child.on('error', (error) => { console.error(error.message); process.exit(2) })
  child.on('exit', (code) => process.exit(code ?? 2))
} else {
  try {
    const response = await fetch(${JSON.stringify(endpoint)}, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: check.command, cwd: actualCwd }),
      signal: AbortSignal.timeout(35000),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error ?? 'check broker rejected execution')
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    process.exitCode = result.exitCode
  } catch (error) { console.error(error.message); process.exitCode = 2 }
}
`
    writeFileSync(client, script, 'utf8')
    writeFileSync(join(launcher, 'node.cmd'), `@echo off\r\n"${process.execPath}" "${client}" %*\r\n`, 'utf8')
    const posixLauncher = join(launcher, 'node')
    writeFileSync(posixLauncher, `#!/bin/sh\nexec "${process.execPath}" "${client}" "$@"\n`, 'utf8')
    chmodSync(posixLauncher, 0o755)
    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
    return {
      env: { [pathKey]: `${launcher}${delimiter}${process.env[pathKey] ?? ''}` },
      executions,
      get integrityError() {
        return integrityError
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
