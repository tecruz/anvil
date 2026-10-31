import assert from 'node:assert/strict'
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { withRepoLock } from '@anvil/git'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'anvil-lock-recovery-'))
  roots.push(repo)
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo, stdio: 'pipe' })
  const directory = join(repo, '.git', 'anvil-locks', 'claims.lock')
  mkdirSync(directory, { recursive: true })
  return { repo, directory }
}

test('an abandoned choosing record is recoverable even before ticket publication', async () => {
  const { repo, directory } = fixture()
  mkdirSync(join(directory, '999999999-00000000-0000-0000-0000-000000000001'))
  assert.equal(await withRepoLock({ cwd: repo, name: 'claims', timeoutMs: 1000 }, async () => 'ran'), 'ran')
  assert.deepEqual(readdirSync(directory), [])
})

test('a thrown callback releases only its own contender record', async () => {
  const { repo, directory } = fixture()
  await assert.rejects(
    () =>
      withRepoLock({ cwd: repo, name: 'claims' }, async () => {
        throw new Error('injected')
      }),
    /injected/,
  )
  assert.deepEqual(readdirSync(directory), [])
  assert.equal(await withRepoLock({ cwd: repo, name: 'claims' }, async () => 'retry'), 'retry')
})

test('legacy shared PID files fail closed with migration guidance', async () => {
  const { repo, directory } = fixture()
  rmSync(directory, { recursive: true })
  writeFileSync(directory, String(process.pid))
  await assert.rejects(
    () => withRepoLock({ cwd: repo, name: 'claims' }, async () => assert.fail('must not enter')),
    (error: unknown) => {
      assert.match(String(error), /lock directory/)
      assert.match((error as { hint: string }).hint, /stop older anvil processes/)
      return true
    },
  )
})

test('a stale observer cannot remove a live successor record in another process', { timeout: 30000 }, async (t) => {
  const { repo, directory } = fixture()
  mkdirSync(join(directory, '999999999-00000000-0000-0000-0000-000000000001'))
  const moduleUrl = new URL('../src/index.ts', import.meta.url).href
  const script = `
import fs, { existsSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { withRepoLock } from ${JSON.stringify(moduleUrl)}
const { ANVIL_LOCK_REPO: repo, ANVIL_LOCK_MODE: mode } = process.env
const held = join(repo, 'successor-published')
if (mode === 'successor') {
  const originalWrite = fs.writeFileSync
  fs.writeFileSync = (path, ...args) => {
    const result = originalWrite(path, ...args)
    if (String(path).includes('ticket-')) originalWrite(held, '')
    return result
  }
  syncBuiltinESMExports()
}
if (mode === 'observer') {
  const original = process.kill.bind(process)
  let observed = false
  process.kill = (pid, signal) => {
    if (pid === 999999999 && !observed) {
      observed = true
      process.send('stale-observed')
      const deadline = Date.now() + 15000
      while (!existsSync(held)) {
        if (Date.now() > deadline) throw new Error('successor did not publish')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
      }
    }
    return original(pid, signal)
  }
}
await withRepoLock({ cwd: repo, name: 'claims', timeoutMs: 15000, pollMs: 5 }, async () => {
  process.send('entered')
  await new Promise((resolve) => process.once('message', resolve))
})
process.disconnect()
`
  const children: ChildProcess[] = []
  t.after(() => {
    for (const child of children) if (child.exitCode === null) child.kill()
  })
  function start(mode: string) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, ANVIL_LOCK_REPO: repo, ANVIL_LOCK_MODE: mode },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    children.push(child)
    return child
  }
  function message(child: ChildProcess, expected: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const listener = (value: unknown) => {
        if (value === expected) {
          child.off('message', listener)
          resolve()
        }
      }
      child.on('message', listener)
      child.once('error', reject)
      child.once('exit', (code) => reject(new Error(`child exited ${code} before ${expected}`)))
    })
  }
  const observer = start('observer')
  const arrivals: ChildProcess[] = []
  const entered = message(observer, 'entered').then(() => {
    arrivals.push(observer)
    return observer
  })
  await message(observer, 'stale-observed')
  const successor = start('successor')
  const successorEntered = message(successor, 'entered').then(() => {
    arrivals.push(successor)
    return successor
  })
  const first = await Promise.race([entered, successorEntered])
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(arrivals.length, 1, 'only one contender may enter after concurrent stale recovery')
  const firstExited = new Promise((resolve) => first.once('exit', resolve))
  first.send('release')
  await firstExited
  await Promise.all([entered, successorEntered])
  const second = first === observer ? successor : observer
  const secondExited = new Promise((resolve) => second.once('exit', resolve))
  second.send('release')
  await secondExited
  assert.deepEqual(readdirSync(directory), [])
})
