import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AnvilError, ErrorCode } from '@anvil/core'

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

interface Contender {
  id: string
  /** null means the contender is still choosing its ticket. */
  ticket: bigint | null
}

/** Each record has a unique, never-reused name. Stale cleanup cannot remove a successor. */
function contenders(directory: string): Contender[] {
  const result: Contender[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const match = /^(\d+)-[a-f0-9-]{36}$/.exec(entry.name)
    if (!entry.isDirectory() || match === null) {
      throw new AnvilError(ErrorCode.Usage, `Unrecognized repository lock record: ${join(directory, entry.name)}`)
    }
    const path = join(directory, entry.name)
    if (!pidAlive(Number(match[1]))) {
      rmSync(path, { recursive: true, force: true })
      continue
    }
    try {
      const files = readdirSync(path)
      const published = files.find((file) => /^ticket-[1-9]\d*$/.test(file))
      result.push({ id: entry.name, ticket: published === undefined ? null : BigInt(published.slice(7)) })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      // The owner released its record while we were reading it.
    }
  }
  return result
}

/**
 * Lamport's bakery ordering over dynamically registered, PID-stamped contenders.
 * Registration (mkdir) and ticket publication (exclusive file creation) are atomic.
 * A newcomer registers before reading tickets, then waits for all choosing contenders
 * and all lower (ticket, id) pairs. A later arrival sees our published ticket and chooses
 * a larger one. No participant ever replaces or unlinks a shared owner pathname.
 *
 * The directory is permanent: removing an empty directory can race a new registration.
 */
export async function withDirectoryLock<T>(
  directory: string,
  options: { timeoutMs: number; pollMs: number; name: string },
  fn: () => Promise<T>,
): Promise<T> {
  try {
    mkdirSync(directory, { recursive: true })
  } catch (err) {
    throw new AnvilError(ErrorCode.Usage, `Cannot open the ${options.name} lock directory: ${directory}`, {
      hint: 'If this is a legacy PID lock file, stop older anvil processes and remove that file before retrying.',
      cause: err,
    })
  }
  const deadline = Date.now() + options.timeoutMs
  const id = `${process.pid}-${randomUUID()}`
  const ownPath = join(directory, id)
  mkdirSync(ownPath)
  try {
    let ticket = 1n
    for (const other of contenders(directory)) {
      if (other.ticket !== null && other.ticket >= ticket) ticket = other.ticket + 1n
    }
    writeFileSync(join(ownPath, `ticket-${ticket}`), '', { flag: 'wx' })
    for (;;) {
      const blocked = contenders(directory).some(
        (other) =>
          other.id !== id &&
          (other.ticket === null || other.ticket < ticket || (other.ticket === ticket && other.id < id)),
      )
      if (!blocked) return await fn()
      if (Date.now() >= deadline) {
        throw new AnvilError(ErrorCode.Usage, `Timed out waiting for the ${options.name} lock`, {
          hint: `Another anvil process is using this repository. Lock: ${directory}`,
        })
      }
      await new Promise((resolve) => setTimeout(resolve, options.pollMs))
    }
  } finally {
    // Only our own unique record is removed, including after a timeout or callback error.
    // Do not turn a completed registry write into a failure/rollback if cleanup fails.
    try {
      rmSync(ownPath, { recursive: true, force: true })
    } catch {
      // Fail closed: the record blocks contenders until this process exits and is reaped.
    }
  }
}
