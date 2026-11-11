import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { AnvilError, ErrorCode } from '@anvil/core'

const LEGACY_HINT =
  'If this is a legacy PID lock file, stop older anvil processes and remove that file before retrying.'

/**
 * Create `target` beneath `root` one component at a time, refusing to follow a link.
 *
 * `mkdirSync(..., { recursive: true })` follows a symbolic link or Windows junction that
 * already occupies an intermediate component. A pre-existing `<git-common-dir>/anvil-locks`
 * junction would therefore place lock records outside the repository, and cleanup would
 * remove files there too. Every component anvil creates is inspected before use and a link is
 * refused instead of followed. `root` itself is trusted: git reports it, and a repository may
 * legitimately be reached through a link higher in its path.
 */
function createLockDirectory(root: string, target: string, name: string): void {
  const rel = relative(root, target)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new AnvilError(ErrorCode.Internal, `The ${name} lock directory must be inside the repository`, {
      hint: 'Lock records are written beside the common git directory, never to a caller-supplied path.',
    })
  }
  let current = root
  for (const component of rel.split(sep)) {
    current = join(current, component)
    let stat: ReturnType<typeof lstatSync>
    try {
      stat = lstatSync(current)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new AnvilError(ErrorCode.Usage, `Cannot open the ${name} lock directory: ${target}`, {
          hint: LEGACY_HINT,
          cause,
        })
      }
      try {
        mkdirSync(current)
      } catch (createCause) {
        if ((createCause as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new AnvilError(ErrorCode.Usage, `Cannot open the ${name} lock directory: ${target}`, {
            hint: LEGACY_HINT,
            cause: createCause,
          })
        }
        // A concurrent creator won the race; inspect what it made below.
      }
      try {
        stat = lstatSync(current)
      } catch (inspectCause) {
        throw new AnvilError(ErrorCode.Usage, `Cannot open the ${name} lock directory: ${target}`, {
          hint: LEGACY_HINT,
          cause: inspectCause,
        })
      }
    }
    if (stat.isSymbolicLink()) {
      throw new AnvilError(ErrorCode.Usage, `Refusing a linked ${name} lock directory: ${current}`, {
        hint: 'Lock records must stay inside the repository. Remove the link or junction and retry.',
      })
    }
    if (!stat.isDirectory()) {
      throw new AnvilError(ErrorCode.Usage, `Cannot open the ${name} lock directory: ${current}`, {
        hint: LEGACY_HINT,
      })
    }
  }
}

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
  options: { root: string; timeoutMs: number; pollMs: number; name: string },
  fn: () => Promise<T>,
): Promise<T> {
  createLockDirectory(options.root, directory, options.name)
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
