/**
 * Bundle the CLI into a single file: packages/cli/dist/cli.js
 *
 * Why one file: `anvil` has to run inside locked-down corporate networks where
 * `npm install -g` may not be available, and on a PATH somewhere between the shell and
 * an agent. Zero runtime dependencies plus one bundle is the most portable thing we can
 * ship.
 */

import { build } from 'esbuild'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const outfile = join(repoRoot, 'packages', 'cli', 'dist', 'cli.js')

mkdirSync(dirname(outfile), { recursive: true })

const result = await build({
  entryPoints: [join(repoRoot, 'packages', 'cli', 'src', 'main.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // Keep node built-ins external; bundle everything else (there is nothing else).
  external: ['node:*'],
  banner: { js: '#!/usr/bin/env node' },
  define: {
    __ANVIL_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.1.0-dev'),
    __ANVIL_SCHEMA_VERSION__: JSON.stringify(1),
  },
  minify: process.env.ANVIL_MINIFY === '1',
  sourcemap: process.env.ANVIL_SOURCEMAP === '1' ? 'inline' : false,
  metafile: true,
  logLevel: 'info',
})

try {
  chmodSync(outfile, 0o755)
} catch {
  // chmod is a no-op on Windows; ignore.
}

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0)
process.stdout.write(`anvil bundle: ${outfile} (${(bytes / 1024).toFixed(1)} kB)\n`)
