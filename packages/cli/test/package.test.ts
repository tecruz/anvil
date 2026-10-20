/**
 * Packaging tests.
 *
 * These exist because a package that works from a checkout and fails from an install is the
 * single most common way a CLI ships broken, and nothing in the unit suite would catch it.
 * Every assertion here is about the *tarball* and the *installed binary*, not about source.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runProcess } from '@anvil/core'

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

/**
 * True when a build artefact is present, and says so out loud when it is not.
 *
 * These assertions are about the *built* bundle, which `npm ci` produces through `prepare` --
 * so in CI and after any install they always run. From a checkout where `dist/` has been
 * removed, they used to `return` silently: the test reported as passed while testing nothing,
 * which is the failure mode a green suite exists to prevent. A one-line note is the honest
 * middle ground between failing a contributor who has not built yet and pretending.
 */
function haveBuild(what: string): boolean {
  if (existsSync(what)) return true
  process.stderr.write(`note: ${what} is absent, so the assertions about it did not run (run 'npm run build')\n`)
  return false
}
describe('the distribution is installable from a git URL', () => {
  // ADR-0007. The channel is `npm i github:owner/repo`, not the registry, and that choice
  // dictates the manifest layout: npm packs the **repository root** for a git dependency, so
  // a root that is `private: true` with no `bin` installs something that cannot run.
  //
  // These were established by experiment rather than assumption, because both are the sort of
  // thing that is easy to believe and expensive to discover:
  //
  //   npm i git+file:///repo#packages/cli   ->  git checkout packages/cli: pathspec did not match
  //
  // npm parses the fragment as a *ref*, not a path, so there is no subdirectory install. The
  // root is the only candidate, which is why this reverses the publish target ADR-0006 chose.

  test('the root manifest is a real package, not a private workspace holder', () => {
    assert.equal(ROOT_PKG.private, undefined, 'a private root cannot be installed from a git URL')
    assert.equal(ROOT_PKG.name, 'anvil', 'the installed package should be named for the command')
    assert.equal(ROOT_PKG.version, CLI_PKG.version, 'two version fields must not be able to drift')
  })

  test('the root exposes the binary', () => {
    assert.deepEqual(ROOT_PKG.bin, { anvil: './packages/cli/dist/cli.js' })
    // The path stays *inside* the package. ADR-0006 rejected a root bin because it had to
    // point outside its own root; pointing down into a workspace directory is not that, and
    // it is the only layout where the bundle can live where the build puts it.
    const bin = String((ROOT_PKG.bin as Record<string, string>).anvil)
    assert.ok(!bin.includes('..'), 'a bin escaping the package root breaks on install')
  })

  test('the bin path exists after a build', () => {
    // The failure this catches is the one a source checkout never sees: the manifest is
    // correct, the file is not there, and only a user finds out.
    const bin = resolve(REPO_ROOT, String((ROOT_PKG.bin as Record<string, string>).anvil))
    if (!haveBuild(join(REPO_ROOT, 'packages', 'cli', 'dist'))) return
    assert.ok(existsSync(bin), `${bin} is missing; the bin points at a file the build does not emit`)
  })

  test('a git install builds the bundle, so there is a prepare script', () => {
    // npm runs `prepare` after installing a git dependency's devDependencies, which is the
    // only reason a git install of a TypeScript monorepo produces a working binary at all.
    // Without it, `dist/` is gitignored and the install ships no CLI.
    assert.equal(
      (ROOT_PKG.scripts as Record<string, string>).prepare,
      'npm run build',
      'the prepare script is what makes a git install work',
    )
  })

  test('the tarball ships the bundle and the licence, and nothing incidental', () => {
    const files = ROOT_PKG.files as string[]
    assert.ok(Array.isArray(files), 'files must be an allowlist, or the whole repo is installed')
    assert.ok(files.includes('packages/cli/dist/cli.js'), 'the bundle is the whole product')
    assert.ok(files.includes('LICENSE'), 'a redistributed binary should carry its licence')
    assert.ok(!files.some((f) => f.startsWith('packages/') && f.includes('/src/')), 'no source')
    assert.ok(!files.some((f) => f.includes('test')), 'tests are not part of the distribution')
  })

  test('the README the install instructions live in is actually shipped', () => {
    // `files` listing a README that does not exist is a silent packaging bug: npm skips it
    // and the installed package has no documentation at all.
    const files = ROOT_PKG.files as string[]
    for (const f of files) {
      if (!f.endsWith('.md')) continue
      assert.ok(existsSync(join(REPO_ROOT, ...f.split('/'))), `${f} is listed in files but does not exist`)
    }
  })

  test('the root declares the engine, because the root is what gets installed', () => {
    const engines = ROOT_PKG.engines as { node: string }
    assert.match(engines.node, />=22/)
  })

  test('the repository URLs point at the owner who publishes it, in every manifest', () => {
    // They said `anomalyco/anvil`, which is not this repository's owner. A `repository` URL is
    // what a bug report's "view source" link resolves to, so a wrong one sends a reader to
    // somebody else's code.
    //
    // All three manifests, not just the root: the plugin manifest kept the wrong account for a
    // while this test read only the root, which is the shape a test has when it cannot fail.
    for (const [name, pkg] of [
      ['package.json', ROOT_PKG],
      ['packages/cli/package.json', CLI_PKG],
      ['packages/plugin-opencode/package.json', PLUGIN_PKG],
    ] as const) {
      const repo = pkg.repository as { url: string } | undefined
      assert.ok(repo !== undefined, `${name} should declare a repository`)
      assert.match(repo.url, /github\.com\/tecruz\//, `${name} points at the wrong account`)
      assert.match(pkg.homepage as string, /github\.com\/tecruz\//, `${name} homepage`)
      assert.match((pkg.bugs as { url: string }).url, /github\.com\/tecruz\//, `${name} bugs url`)
    }
  })

  test('every published manifest agrees on the version', () => {
    // Three version fields is two chances to ship a binary that reports the wrong release.
    for (const [name, pkg] of [
      ['packages/cli', CLI_PKG],
      ['packages/plugin-opencode', PLUGIN_PKG],
    ] as const) {
      assert.equal(pkg.version, ROOT_PKG.version, `${name} version drifted from the root`)
    }
  })

  test('the engine floor is where running TypeScript directly became unflagged', () => {
    // `node scripts/gen-playbooks.ts` runs at install time via `prepare`, and the whole test
    // suite runs `.ts` files through `node --test`. Type stripping stopped needing
    // `--experimental-strip-types` in 22.18, so a floor of 22.6 promised a git install that
    // fails on the user's first command.
    for (const [name, pkg] of [
      ['root', ROOT_PKG],
      ['packages/cli', CLI_PKG],
    ] as const) {
      const engines = pkg.engines as { node: string }
      assert.match(engines.node, /22\.(1[89]|[2-9]\d)/, `${name} engines floor is below the type-stripping floor`)
    }
  })
})

describe('publishable package', () => {
  test('the CLI package keeps its own bin for a future registry release', () => {
    // ADR-0006's layout decision stands -- the bundle lives in packages/cli/dist and the bin
    // points at it -- even though the git channel ships from the root. Both can be true: the
    // root is the install unit today, and `packages/cli` remains a coherent publish target if
    // the registry is ever wanted.
    assert.equal(CLI_PKG.private, undefined, 'a private package cannot be published')
    assert.notEqual(CLI_PKG.name, ROOT_PKG.name, 'two manifests must not share a name')
    assert.deepEqual(CLI_PKG.bin, { anvil: './dist/cli.js' })
  })

  test('the bin is what people type, and it is unscoped', () => {
    // A scoped `@anvil/cli` installs as `anvil` via the bin key but shows up in `npm ls` as
    // a scope the user never chose. The bin is what people type, so it stays unscoped.
    assert.equal((CLI_PKG.bin as Record<string, string>).anvil, './dist/cli.js')
  })

  test('the version in the bundle is the version in the published package.json', () => {
    // `npm_package_version` is only set for the package npm is running a script *in*, and
    // the build runs from the root, which is private and versionless. So a build that
    // trusted it alone shipped a binary reporting 0.1.0-dev forever.
    const bundle = join(CLI_DIR, 'dist', 'cli.js')
    if (!haveBuild(bundle)) return
    const out = execFileSync(process.execPath, [bundle, 'version', '--json'], {
      encoding: 'utf8',
    })
    const parsed = JSON.parse(out) as { data: { version: string } }
    assert.equal(
      parsed.data.version,
      ROOT_PKG.version,
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
    if (!haveBuild(bundle)) return
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
    if (!haveBuild(join(PLUGIN_DIR, 'dist'))) return
    assert.ok(existsSync(entry), `${entry} is missing; the build did not emit the entry point`)
  })

  test('the documentation it lists exists, so the published plugin is not missing its README', () => {
    // The same defect the root manifest had, in the manifest nobody was reading: `files`
    // naming a README that does not exist is a silent packaging bug -- npm skips it, and
    // the installed package has no documentation at all. A published plugin whose README
    // says nothing about how to install it is a plugin nobody can install.
    const files = PLUGIN_PKG.files as string[]
    for (const f of files) {
      if (f.startsWith('dist/')) continue
      assert.ok(existsSync(join(PLUGIN_DIR, ...f.split('/'))), `${f} is listed in files but does not exist`)
    }
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
    if (!haveBuild(bundle)) return
    const source = readFileSync(bundle, 'utf8')
    assert.match(
      source,
      /from\s*["']@opencode-ai\/plugin["']/,
      "the SDK should be imported, not inlined; a vendored copy breaks the host's tool registry",
    )
  })

  test('the plugin exposes its tools and its compaction hook', () => {
    // A plugin that compiles and exports nothing useful is a packaging success and a
    // product failure, and neither the bundle nor the typecheck can tell.
    const bundle = join(PLUGIN_DIR, 'dist', 'index.js')
    if (!haveBuild(bundle)) return
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
  test('npm pack -> npm install -> the installed binary does real work', {
    timeout: 300_000,
  }, async () => {
    const packDir = tempDir('anvil-pack-')
    // `runProcess`, not `spawnSync(..., { shell: true })`: the project resolved the
    // Windows-shim problem for the CLI, and its own test should not reintroduce it (or the
    // DEP0190 deprecation warning) by going through a shell. The arguments here are
    // controlled, so the shim path passes the safety check untouched.
    //
    // Packed from the **root**, because that is the manifest npm packs for a git dependency
    // and therefore the tarball a user actually receives. Packing `packages/cli` would test
    // an artifact nobody installs.
    const packed = await runProcess('npm', ['pack', '--pack-destination', packDir], { cwd: REPO_ROOT })
    assert.equal(packed.exitCode, 0, `npm pack failed: ${packed.stderr}`)

    const tarball = join(packDir, `${String(ROOT_PKG.name)}-${String(ROOT_PKG.version)}.tgz`)
    assert.ok(existsSync(tarball), `expected ${tarball} to exist`)

    // A consumer project, so the install resolves exactly as a user's would.
    const consumer = tempDir('anvil-consumer-')
    writeFileSync(
      join(consumer, 'package.json'),
      JSON.stringify({
        name: 'consumer',
        private: true,
        scripts: { test: 'node -e "process.exit(0)"' },
      }),
      'utf8',
    )
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: consumer,
        encoding: 'utf8',
        stdio: 'pipe',
      })
    git('init', '-q', '-b', 'main')
    git('add', '-A')
    git('-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-qm', 'init')

    const installed = await runProcess('npm', ['install', '--no-save', tarball], { cwd: consumer })
    assert.equal(installed.exitCode, 0, `npm install failed: ${installed.stderr}`)

    // The bin shim, not the bundle path. On Windows npm writes an anvil.cmd, and this is
    // exactly where a package that only works when invoked as `node dist/cli.js` breaks.
    const bin = join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? 'anvil.cmd' : 'anvil')
    assert.ok(existsSync(bin), `bin shim missing at ${bin}`)

    const run = async (...args: string[]): Promise<{ status: number; stdout: string; stderr: string }> => {
      // Through `runProcess` here too: on Windows `anvil.cmd` is a cmd shim, and running
      // it via a shell would mask exactly the breakage this test exists to catch.
      const r = await runProcess(bin, args, {
        cwd: consumer,
        env: { ...process.env, NO_COLOR: '1' },
      })
      return { status: r.exitCode, stdout: r.stdout, stderr: r.stderr }
    }

    // 1. It reports its own version, which is what a user pastes into a bug report.
    const version = await run('version', '--json')
    assert.equal(version.status, 0, `version failed: ${version.stderr}`)
    assert.equal((JSON.parse(version.stdout) as { data: { version: string } }).data.version, ROOT_PKG.version)

    // 2. The JSON envelope survives bundling and minification.
    const doctor = await run('doctor', '--json')
    assert.equal(doctor.status, 0, `doctor failed: ${doctor.stderr}`)
    const envelope = JSON.parse(doctor.stdout) as {
      schemaVersion: number
      ok: boolean
    }
    assert.equal(envelope.schemaVersion, 1)
    assert.equal(envelope.ok, true)

    // 3. Real work in a real repo: create a ticket, claim it, verify the crew. This is the
    //    path that exercises playbooks, profile, the worktree registry and the process
    //    layer, and it is the only way to know the bundle is complete rather than merely
    //    importable.
    const created = await run('issue', 'create', 'Real install smoke task')
    assert.equal(created.status, 0, `issue create failed: ${created.stderr}`)

    const claimed = await run('claim', 'local-1')
    assert.equal(claimed.status, 0, `claim failed: ${claimed.stderr}`)
    assert.match(claimed.stdout, /claimed local-1/)

    // Windows shim handling, end to end, on a real `npm run` from an installed bundle. This
    // is the defect that made the tool non-functional on Windows, and the unit tests cannot
    // see it because they run from the repo rather than from node_modules.
    const verified = await run('crew', 'verify')
    assert.equal(verified.status, 0, `crew verify failed: ${verified.stderr}\n${verified.stdout}`)
    assert.match(verified.stdout, /pass/)
  })
})
