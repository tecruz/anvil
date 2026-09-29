/**
 * Bundle the CLI into a single file: packages/cli/dist/cli.js
 *
 * Why one file: `anvil` has to run inside locked-down corporate networks where
 * `npm install -g` may not be available, and on a PATH somewhere between the shell and
 * an agent. Zero runtime dependencies plus one bundle is the most portable thing we can
 * ship.
 */

import { build } from 'esbuild'
import { mkdirSync, chmodSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const outfile = join(repoRoot, 'packages', 'cli', 'dist', 'cli.js')

/**
 * The version to inject.
 *
 * `npm_package_version` is only set for the package npm is running a script *in*, and this
 * script runs from the workspace root, whose package.json is private and has no version. So
 * relying on it means every published binary reports `0.1.0-dev` -- a bug nobody notices
 * until someone files it against the wrong version.
 *
 * `packages/cli` is the package the bundle ships as, so its version is the one that matters.
 * Read here rather than injected from the environment so the two can never disagree.
 */
const cliPackage = JSON.parse(readFileSync(join(repoRoot, 'packages', 'cli', 'package.json'), 'utf8'))
const version = process.env.npm_package_version ?? cliPackage.version

mkdirSync(dirname(outfile), { recursive: true })

/**
 * The opencode plugin, built separately.
 *
 * It ships as compiled JS rather than TypeScript. opencode loads the plugin through its own
 * resolver with no transpiler, so a `src/index.ts` entry point works from a checkout and
 * fails the moment it is installed -- and only for users, never for us.
 */
const pluginOut = join(repoRoot, 'packages', 'plugin-opencode', 'dist')
const pluginResult = await build({
  entryPoints: [join(repoRoot, 'packages', 'plugin-opencode', 'src', 'index.ts')],
  outfile: join(pluginOut, 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // The plugin SDK is a peer dependency: opencode already has it, and bundling a second
  // copy would give the plugin a different Plugin type than the host expects.
  external: ['node:*', '@opencode-ai/plugin'],
  sourcemap: process.env.ANVIL_SOURCEMAP === '1' ? 'inline' : false,
  logLevel: 'info',
})

/**
 * Types for the plugin entry point.
 *
 * Emitted by tsc rather than esbuild, and as a separate step, because a `.d.ts` is what makes
 * a plugin's tools typed in the host editor. Without it the tools are `any`, and a tool an
 * agent calls with the wrong argument fails at runtime instead of being caught while typing.
 */
const tsc = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')
execFileSync(process.execPath, [
  tsc,
  'packages/plugin-opencode/src/index.ts',
  '--declaration',
  '--emitDeclarationOnly',
  '--outDir',
  'packages/plugin-opencode/dist',
  '--target',
  'ES2023',
  '--module',
  'NodeNext',
  '--moduleResolution',
  'NodeNext',
  '--skipLibCheck',
], { cwd: repoRoot, stdio: 'inherit' })

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
    __ANVIL_VERSION__: JSON.stringify(version),
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
process.stdout.write(`plugin bundle: ${join(pluginOut, 'index.js')}\n`)
