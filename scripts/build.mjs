/**
 * Bundle the CLI into a single file: packages/cli/dist/cli.js
 *
 * Why one file: `anvil` has to run inside locked-down corporate networks where
 * `npm install -g` may not be available, and on a PATH somewhere between the shell and
 * an agent. Zero runtime dependencies plus one bundle is the most portable thing we can
 * ship.
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const outfile = join(repoRoot, 'packages', 'cli', 'dist', 'cli.js')

/**
 * The version to inject.
 *
 * Read from the **root** manifest, never from `npm_package_version`. `npm_package_version`
 * is only set for the package npm is running a script *in*, and this script runs from the
 * workspace root, so relying on it means every installed binary reports whatever the
 * environment happened to contain -- a bug nobody notices until someone files it against the
 * wrong version.
 *
 * The root is also the right place to read it from as well as the right place to *ship* it
 * from: since ADR-0007 the root manifest is the distribution, so its version is the one a
 * user installs. `packages/cli` keeps a version field because npm expects one, and a test
 * asserts the two agree -- two version fields that can drift is a release-day surprise.
 */
const rootPackage = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const version = rootPackage.version

mkdirSync(dirname(outfile), { recursive: true })

/**
 * The opencode plugin, built separately.
 *
 * It ships as compiled JS rather than TypeScript. opencode loads the plugin through its own
 * resolver with no transpiler, so a `src/index.ts` entry point works from a checkout and
 * fails the moment it is installed -- and only for users, never for us.
 */
const pluginOut = join(repoRoot, 'packages', 'plugin-opencode', 'dist')
const _pluginResult = await build({
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
execFileSync(
  process.execPath,
  [
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
  ],
  { cwd: repoRoot, stdio: 'inherit' },
)

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
