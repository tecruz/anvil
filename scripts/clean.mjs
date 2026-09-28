/**
 * Remove build output. Deliberately does not touch node_modules or anything a person
 * might have written; if it has to be clever about cleanup, it is doing too much.
 */

import { rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

const targets = [join(repoRoot, 'packages', 'cli', 'dist')]

for (const target of targets) {
  rmSync(target, { recursive: true, force: true })
  process.stdout.write(`removed ${target}\n`)
}
