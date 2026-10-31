import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { AnvilError, ErrorCode } from '@anvil/core'

/** Validate every component, including dangling links and multiply-linked output files. */
export function checkedStatePath(root: string, parts: string[], directory = false): string {
  const realRoot = realpathSync(root)
  let path = root
  for (const [index, part] of ['.anvil', ...parts].entries()) {
    if (part === '' || part === '.' || part === '..' || part.includes('/') || part.includes('\\')) {
      throw new AnvilError(ErrorCode.Internal, 'Invalid anvil state path component')
    }
    path = join(path, part)
    const stat = lstatSync(path, { throwIfNoEntry: false })
    const needsDirectory = index < parts.length || directory
    if (
      stat !== undefined &&
      (stat.isSymbolicLink() || (needsDirectory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1))
    ) {
      throw new AnvilError(
        ErrorCode.PreflightFailed,
        `Refusing to write anvil state through a link or unsafe path: ${path}`,
        {
          hint: 'State directories must be real directories; output files must be regular files with no other links.',
          details: { path },
        },
      )
    }
    if (stat !== undefined) {
      const resolved = realpathSync(path)
      const rel = relative(realRoot, resolved)
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new AnvilError(ErrorCode.PreflightFailed, `Refusing to write anvil state outside the repository: ${path}`)
      }
    }
  }
  return path
}

export function createStateDirectory(root: string, parts: string[] = []): string {
  const path = checkedStatePath(root, parts, true)
  mkdirSync(path, { recursive: true })
  return checkedStatePath(root, parts, true)
}
