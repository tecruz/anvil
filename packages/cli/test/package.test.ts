/**
 * Packaging tests.
 *
 * These exist because a package that works from a checkout and fails from an install is the
 * single most common way a CLI ships broken, and nothing in the unit suite would catch it.
 * Every assertion here is about the *tarball* and the *installed binary*, not about source.
 */

import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// packages/cli/test -> packages/cli -> packages -> repo root
const here = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(here, '..', '..', '..')
const CLI_DIR = resolve(here, '..')
const PLUGIN_DIR = join(REPO_ROOT, 'packages', 'plugin-opencode')
const PLUGIN_PKG = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8')) as Record<string, unknown>
const ROOT_PKG = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as Record<string, unknown>
const CLI_PKG = JSON.parse(readFileSync(join(CLI_DIR, 'package.json'), 'utf8')) as Record<string, unknown>

const temps: string[] = []
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  temps.push(d)
  return d
}

describe('publishable package', () => {
  test('the CLI package is the one that publishes', () => {
    // ADR-0006 settled this: the bundle lives in packages/cli, so packages/cli is the
    // publishable unit. A root-level `bin` would be unpublishable.
    assert.equal(CLI_PKG.private, undefined, 'a private package cannot be published')
    assert.equal(ROOT_PKG.private, true, 'the workspace root stays private')
    assert.notEqual(CLI_PKG.name, ROOT_PKG.name, 'they must not share a name')
  })

  test('the name is the unscoped one, so `anvil` is what a user types', () => {
    // A scoped `@anvil/cli` would install as `anvil` via the bin key but show up in
    // `npm ls` as a scope the user never chose. The bin is what people type, so the
    // package name should match it.
    assert.equal(CLI_PKG.name, 'anvil')
    assert.deepEqual(CLI_PKG.bin, { anvil: './dist/cli.js' })
  })

  test('the version in the bundle is the version in the published package.json', () => {
    // `npm_package_version` is only set for the package npm is running a script *in*, and
    // the build runs from the root, which is private and versionless. So a build that
    // trusted it alone shipped a binary reporting 0.1.0-dev forever.
    const bundle = join(CLI_DIR, 'dist', 'cli.js')
    if (!existsSync(bundle)) return // covered by the build step; nothing to assert yet
    const out = execFileSync(process.execPath, [bundle, 'version', '--json'], { encoding: 'utf8' })
    const parsed = JSON.parse(out) as { data: { version: string } }
    assert.equal(
      parsed.data.version,
      CLI_PKG.version,
      'a published binary reporting the wrong version is how a bug report lands on the wrong release',
    )
  })

  test('the files list ships the bundle and nothing incidental', () => {
    const files = CLI_PKG.files as string[]
    assert.ok(Array.isArray(files), 'files must be an allowlist, or source and tests get published')
    assert.ok(files.includes('dist/cli.js'), 'the bundle is the whole product')
    assert.ok(!files.some((f) => f.includes('test')), 'tests are not part of the CLI')
    assert.ok(!files.some((f) => f.startsWith('src')), 'source is not shipped; the bundle is')
  })

  test('the package declares the engine it actually needs', () => {
    // Node 22.6 for `node --test` with TS, and esbuild's node22 target.
    const engines = CLI_PKG.engines as { node: string }
    assert.match(engines.node, />=22/)
  })

  test('the package has zero runtime dependencies', () => {
    // The single-file bundle is the reason the tool works in a locked-down network with no
    // `npm install -g`. A runtime dependency reintroduces exactly the problem the bundling
    // exists to avoid.
    assert.equal(CLI_PKG.dependencies, undefined, 'a dependency means the install is not self-contained')
    assert.equal(CLI_PKG.peerDependencies, undefined)
  })

  test('the bundle has no bare imports left for node to resolve at runtime', () => {
    // The strongest available check that the bundle really is self-contained: anything
    // non-relative and not a node: builtin would have to be installed.
    const bundle = join(CLI_DIR, 'dist', 'cli.js')
    if (!existsSync(bundle)) return
    const source = readFileSync(bundle, 'utf8')
    // Only real import statements. A bare `from "<something>"` also appears inside string
    // literals anvil itself emits -- error hints, for one -- so the shape is anchored to
    // line start to avoid matching prose.
    const bare = [...source.matchAll(/^\s*import\s[^'"]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1] as string)
    const offenders = [...new Set(bare)].filter((spec) => !spec.startsWith('node:'))
    assert.deepEqual(offenders, [], `bundle has unresolvable imports: ${offenders.join(', ')}`)
  })
})

describe('the opencode plugin package', () => {
  test('ships compiled JS, not TypeScript', () => {
    // opencode loads a plugin through its own resolver with no transpiler. A `src/index.ts`
    // entry point works from a checkout and fails the moment it is installed, and only for
    // users, never for us.
    const exports = PLUGIN_PKG.exports as Record<string, string>
    assert.match(exports['.'] ?? '', /^\.\/dist\/.*\.js$/, 'the entry point must be built output')
    assert.doesNotMatch(exports['.'] ?? '', /\.ts$/)
  })

  test('the entry point it declares actually exists after a build', () => {
    const exports = PLUGIN_PKG.exports as Record<string, string>
    const entry = resolve(PLUGIN_DIR, exports['.'] ?? '')
    if (!existsSync(join(PLUGIN_DIR, 'dist'))) return // nothing built yet; not a failure
    assert.ok(existsSync(entry), `${entry} is missing; the build did not emit the entry point`)
  })

  test('the plugin SDK is a peer dependency, not a bundled or vendored copy', () => {
    // opencode already has the SDK loaded. Bundling a second copy would give the plugin a
    // different `Plugin` type than the host expects, and the tools would not register.
    const peers = PLUGIN_PKG.peerDependencies as Record<string, string> | undefined
    assert.ok(peers?.['@opencode-ai/plugin'] !== undefined, 'the SDK must be a peer dependency')
    assert.equal(PLUGIN_PKG.dependencies, undefined, 'and must not be a hard dependency')
  })

  test('the bundle leaves the SDK external rather than inlining it', () => {
    const bundle = join(PLUGIN_DIR, 'dist', 'index.js')
    if (!existsSync(bundle)) return
    const source = readFileSync(bundle, 'utf8')
    assert.match(
      source,
      /from\s*["']@opencode-ai\/plugin["']/,
      'the SDK should be imported, not inlined; a vendored copy breaks the host\'s tool registry',
    )
  })

  test('the plugin exposes its tools and its compaction hook', () => {
    // A plugin that compiles and exports nothing useful is a packaging success and a
    // product failure, and neither the bundle nor the typecheck can tell.
    const bundle = join(PLUGIN_DIR, 'dist', 'index.js')
    if (!existsSync(bundle)) return
    const source = readFileSync(bundle, 'utf8')
    for (const tool of ['anvil_doctor', 'anvil_plan', 'anvil_ticket', 'anvil_status']) {
      assert.ok(source.includes(tool), `${tool} is missing from the built plugin`)
    }
    assert.ok(source.includes('shell.env'), 'the plugin must forward anvil config to the shell')
  })
})

describe('the packed tarball installs and runs', () => {
  // A single test, because the expensive part is `npm pack` plus `npm install` and splitting
  // it would pay that cost repeatedly. Each assertion below is a separate way a package
  // breaks, so one failure still names which one.
  test('npm pack -> npm install -> the installed binary does real work', { timeout: 300_000 }, () => {
    const packDir = tempDir('anvil-pack-')
    const packed = spawnSync('npm', ['pack', '--pack-destination', packDir], {
      cwd: CLI_DIR,
      encoding: 'utf8',
      shell: true,
    })
    assert.equal(packed.status, 0, `npm pack failed: ${packed.stderr}`)

    const tarball = join(packDir, `${String(CLI_PKG.name)}-${String(CLI_PKG.version)}.tgz`)
    assert.ok(existsSync(tarball), `expected ${tarball} to exist`)

    // A consumer project, so the install resolves exactly as a user's would.
    const consumer = tempDir('anvil-consumer-')
    writeFileSync(
      join(consumer, 'package.json'),
      JSON.stringify({ name: 'consumer', private: true, scripts: { test: 'node -e "process.exit(0)"' } }),
      'utf8',
    )
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: consumer, encoding: 'utf8', stdio: 'pipe' })
    git('init', '-q', '-b', 'main')
    git('add', '-A')
    git('-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-qm', 'init')

    const installed = spawnSync('npm', ['install', '--no-save', tarball], {
      cwd: consumer,
      encoding: 'utf8',
      shell: true,
    })
    assert.equal(installed.status, 0, `npm install failed: ${installed.stderr}`)

    // The bin shim, not the bundle path. On Windows npm writes an anvil.cmd, and this is
    // exactly where a package that only works when invoked as `node dist/cli.js` breaks.
    const bin = join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? 'anvil.cmd' : 'anvil')
    assert.ok(existsSync(bin), `bin shim missing at ${bin}`)

    const run = (...args: string[]): { status: number | null; stdout: string; stderr: string } => {
      const r = spawnSync(bin, args, {
        cwd: consumer,
        encoding: 'utf8',
        shell: process.platform === 'win32',
        env: { ...process.env, NO_COLOR: '1' },
      })
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    }

    // 1. It reports its own version, which is what a user pastes into a bug report.
    const version = run('version', '--json')
    assert.equal(version.status, 0, `version failed: ${version.stderr}`)
    assert.equal((JSON.parse(version.stdout) as { data: { version: string } }).data.version, CLI_PKG.version)

    // 2. The JSON envelope survives bundling and minification.
    const doctor = run('doctor', '--json')
    assert.equal(doctor.status, 0, `doctor failed: ${doctor.stderr}`)
    const envelope = JSON.parse(doctor.stdout) as { schemaVersion: number; ok: boolean }
    assert.equal(envelope.schemaVersion, 1)
    assert.equal(envelope.ok, true)

    // 3. Real work in a real repo: create a ticket, claim it, verify the crew. This is the
    //    path that exercises playbooks, profile, the worktree registry and the process
    //    layer, and it is the only way to know the bundle is complete rather than merely
    //    importable.
    const created = run('issue', 'create', 'Real install smoke task')
    assert.equal(created.status, 0, `issue create failed: ${created.stderr}`)

    const claimed = run('claim', 'local-1')
    assert.equal(claimed.status, 0, `claim failed: ${claimed.stderr}`)
    assert.match(claimed.stdout, /claimed local-1/)

    // Windows shim handling, end to end, on a real `npm run` from an installed bundle. This
    // is the defect that made the tool non-functional on Windows, and the unit tests cannot
    // see it because they run from the repo rather than from node_modules.
    const verified = run('crew', 'verify')
    assert.equal(verified.status, 0, `crew verify failed: ${verified.stderr}\n${verified.stdout}`)
    assert.match(verified.stdout, /pass/)
  })
})
