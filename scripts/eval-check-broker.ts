import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, relative } from 'node:path'
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
  /** Fixture-relative directory the broker ran the check in. Empty for the fixture root. */
  cwd: string
  /**
   * Optional snapshot of the in-scope files taken at execution time. A grader can compare it
   * with the final patch so a check that went green before the last edit is not counted.
   */
  patchHash?: string
}

/**
 * A command declared by the repository manifest, such as `npm run test`. The broker puts a
 * PATH shim in front of that binary so an agent invocation of the declared command is captured
 * with the same provenance as a standalone Node check.
 */
export interface DeclaredCommand {
  /** Exact command string recorded in the attestation. */
  command: string
  /** Binary name to shim, e.g. `npm`. */
  bin: string
  /** Exact argv the shim must match, e.g. ['run', 'test']. */
  argv: readonly string[]
}

export interface CheckBroker {
  /** Only the node launcher is exposed, never the verifier's execution log. */
  env: NodeJS.ProcessEnv
  executions: readonly CheckExecution[]
  readonly integrityError: string | null
  /** An unexpected broker failure, which is a harness fault rather than an agent outcome. */
  readonly fault: string | null
  close(): Promise<void>
}

export function captureCheck(command: string, script: string, fixtureRoot: string, captureDir = ''): CapturedCheck {
  const source = readFileSync(join(fixtureRoot, ...segments(captureDir), script), 'utf8')
  return { command, script, source, sourceHash: hashSource(source) }
}

/**
 * A fixture-relative directory must stay inside the fixture. The value comes from a checked-in
 * scenario, but a traversal would make the broker attest to a directory outside the worktree.
 */
function segments(captureDir: string): string[] {
  if (captureDir === '') return []
  if (captureDir.startsWith('/') || captureDir.startsWith('\\') || /^[A-Za-z]:/.test(captureDir)) {
    throw new Error(`captureDir must be relative, got ${JSON.stringify(captureDir)}`)
  }
  const parts = captureDir.split(/[/\\]/)
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`captureDir must be a clean relative path, got ${JSON.stringify(captureDir)}`)
  }
  return parts
}

function hashSource(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex')
}

/** Resolve a declared binary on the original PATH, before any shim directory is prepended. */
function resolveBinary(bin: string): string {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
  const names = process.platform === 'win32' ? [`${bin}.cmd`, `${bin}.exe`, bin] : [bin]
  for (const dir of (process.env[pathKey] ?? '').split(delimiter)) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return bin
}

/**
 * A broker fault must not carry a raw Node error: `error.message` includes the runtime path
 * and the `--eval` source, neither of which belongs in retained evidence. Return a small
 * fixed category instead.
 */
function faultCategory(error: unknown): string {
  const failure = error as { code?: unknown; killed?: boolean }
  if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'the check produced too much output'
  if (failure.killed === true) return 'the check was stopped by the harness'
  return 'the check could not be executed'
}

/**
 * A PATH launcher asks this parent-process broker to execute a captured Node ESM
 * check. Source comes from a pre-agent snapshot held in memory, not a file the
 * agent could swap. The client may be edited or bypassed, but it cannot add an
 * execution record: even a direct HTTP request has to run the captured source.
 * This is a provenance boundary, not an OS sandbox for hostile native processes.
 */
export async function startCheckBroker(
  checks: readonly CapturedCheck[],
  workdir: string,
  captureDir = '',
  fingerprint?: () => string,
  declared?: DeclaredCommand,
): Promise<CheckBroker> {
  // macOS temporary paths (/var vs /private/var), Windows short names and shell
  // directory normalization can give the same directory different spellings.
  const root = realpathSync.native(workdir)
  const parts = segments(captureDir)
  const directory = parts.length === 0 ? root : realpathSync.native(join(root, ...parts))
  const fromRoot = relative(root, directory)
  if (
    fromRoot === '..' ||
    fromRoot.startsWith(`..${'/'}`) ||
    fromRoot.startsWith(`..${'\\'}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`captureDir resolves outside the worktree: ${JSON.stringify(captureDir)}`)
  }
  const recordedCwd = parts.join('/')
  const executions: CheckExecution[] = []
  let integrityError: string | null = null
  let fault: string | null = null
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
      try {
        for await (const chunk of request) {
          bytes += chunk.length
          if (bytes > 8192) throw new Error('check request is too large')
          chunks.push(Buffer.from(chunk))
        }
      } catch {
        reply(response, 400, { error: 'check request is too large' })
        return
      }
      let input: { command?: unknown; cwd?: unknown }
      try {
        input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { command?: unknown; cwd?: unknown }
      } catch {
        reply(response, 400, { error: 'check request is not valid JSON' })
        return
      }
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
      // Snapshot the in-scope patch before the check starts. A fingerprint taken only after
      // the process exits can attribute a green run to edits made while it was executing.
      const patchHashBefore = fingerprint?.() ?? null
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
      const patchHashAfter = fingerprint?.() ?? null
      if (patchHashBefore !== null && patchHashAfter !== patchHashBefore) {
        integrityError = 'the patch changed while the check was running; execution evidence is invalid'
        reply(response, 409, { error: integrityError })
        return
      }
      const execution = {
        command: check.command,
        exitCode,
        sourceHash: check.sourceHash,
        stdout,
        stderr,
        at: new Date().toISOString(),
        cwd: recordedCwd,
        ...(patchHashBefore === null ? {} : { patchHash: patchHashBefore }),
      }
      executions.push(execution)
      reply(response, 200, execution)
    }
    const task = handle().catch((error: unknown) => {
      // Never persist a raw Node error: its message embeds the executable path and the
      // captured source passed to `--eval`. Keep a bounded category for the harness record.
      fault = faultCategory(error)
      reply(response, 500, { error: fault })
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

    if (declared !== undefined) {
      const shimModule = join(launcher, `${declared.bin}-declared.mjs`)
      const shim = `import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
const argv = ${JSON.stringify(declared.argv)}
const command = ${JSON.stringify(declared.command)}
const args = process.argv.slice(2)
const cwd = realpathSync.native(process.cwd())
const expected = ${JSON.stringify(directory)}
if (cwd === expected && args.length === argv.length && args.every((a, i) => a === argv[i])) {
  try {
    const response = await fetch(${JSON.stringify(endpoint)}, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, cwd }), signal: AbortSignal.timeout(35000),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error ?? 'the declared check was rejected')
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    process.exitCode = result.exitCode
  } catch (error) { console.error(error.message); process.exitCode = 2 }
} else {
  const child = spawn(process.env.ANVIL_DECLARED_BIN, args, { stdio: 'inherit' })
  child.on('error', (error) => { console.error(error.message); process.exit(2) })
  child.on('exit', (code) => process.exit(code ?? 2))
}
`
      writeFileSync(shimModule, shim, 'utf8')
      writeFileSync(
        join(launcher, `${declared.bin}.cmd`),
        `@echo off\r\n"${process.execPath}" "${shimModule}" %*\r\n`,
        'utf8',
      )
      const posixShim = join(launcher, declared.bin)
      writeFileSync(posixShim, `#!/bin/sh\nexec "${process.execPath}" "${shimModule}" "$@"\n`, 'utf8')
      chmodSync(posixShim, 0o755)
    }

    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
    return {
      env: {
        [pathKey]: `${launcher}${delimiter}${process.env[pathKey] ?? ''}`,
        ...(declared === undefined ? {} : { ANVIL_DECLARED_BIN: resolveBinary(declared.bin) }),
      },
      executions,
      get integrityError() {
        return integrityError
      },
      get fault() {
        return fault
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
