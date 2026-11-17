/**
 * Packaging tests.
 *
 * These exist because a package that works from a checkout and fails from an install is the
 * single most common way a CLI ships broken, and nothing in the unit suite would catch it.
 * Every assertion here is about the *tarball* and the *installed binary*, not about source.
 */

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runProcess } from '@anvil/core'
import { checkHandshake } from '../../../scripts/check-mcp-handshake.ts'

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
    // A scoped `@anvil-workflows/cli` installs as `anvil` via the bin key but shows up in
    // `npm ls` as a scope the user never chose. The bin is what people type, so it stays unscoped.
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

  test('the packed tarball contains only the allowlisted files', {
    timeout: 120_000,
  }, async () => {
    const packDir = tempDir('anvil-pack-contents-')
    const packed = await runProcess('npm', ['pack', '--pack-destination', packDir], { cwd: REPO_ROOT })
    assert.equal(packed.exitCode, 0, `npm pack failed: ${packed.stderr}`)

    const tarball = join(packDir, `${String(ROOT_PKG.name)}-${String(ROOT_PKG.version)}.tgz`)
    assert.ok(existsSync(tarball), `expected ${tarball} to exist`)

    // List the tarball's contents. Every path must be inside the package root and match the
    // `files` allowlist: the bundle, the licence, the README, and the manifest itself.
    const listed = await runProcess('tar', ['tzf', tarball])
    assert.equal(listed.exitCode, 0, `tar failed: ${listed.stderr}`)

    const allowed = new Set([
      'package/',
      'package/package.json',
      'package/README.md',
      'package/LICENSE',
      'package/packages/cli/dist/cli.js',
    ])
    const paths = listed.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')

    for (const path of paths) {
      assert.ok(
        allowed.has(path) || path.startsWith('package/packages/cli/dist/'),
        `tarball contains an unexpected path: ${path}`,
      )
    }

    // No source, tests, fixtures, transcripts, credentials, or build-tool dependencies.
    const forbidden = [
      '/src/',
      '/test/',
      '/fixtures/',
      '/eval-results/',
      '/.anvil/',
      'node_modules',
      '.git',
      '.tsbuildinfo',
    ]
    for (const path of paths) {
      for (const bad of forbidden) {
        assert.ok(!path.includes(bad), `tarball contains ${bad}: ${path}`)
      }
    }
  })
})

interface JsonRpcLine {
  jsonrpc: '2.0'
  id?: unknown
  result?: unknown
  error?: { code: number; message: string }
}

/**
 * How long a first-run MCP handshake may take before the child is killed.
 *
 * Without it a regression that leaves the server waiting for more input after stdin closes
 * hangs the suite until the test runner's timeout, and the failure names the timeout rather
 * than the broken handshake.
 */
const MCP_HANDSHAKE_TIMEOUT_MS = 30_000

/**
 * Drive one real MCP handshake over an installed bundle's stdio.
 *
 * Through `node` and the bundle path rather than the npm shim, because on Windows a `.cmd`
 * cannot be given a stdin stream usefully. The shim itself is covered by the version and
 * doctor runs above, so this test adds the one thing those cannot: that the transport
 * survived bundling, `--ignore-scripts`, and installation away from the checkout.
 *
 * Every failure path settles the returned promise. A `JSON.parse` thrown inside the `close`
 * handler used to escape as an uncaught exception and leave the promise pending, so a
 * malformed response hung the test instead of failing it with the bytes that were wrong.
 */
function mcpHandshake(bundle: string, cwd: string): Promise<JsonRpcLine[]> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [bundle, 'mcp'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: MCP_HANDSHAKE_TIMEOUT_MS,
    })
    let stdout = ''
    let stderr = ''
    let settled = false

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      fail(error)
    })
    child.on('close', (code, signal) => {
      if (code !== 0) {
        const reason =
          signal === null ? `exited ${code}` : `was killed by ${signal} (timeout ${MCP_HANDSHAKE_TIMEOUT_MS}ms)`
        fail(new Error(`anvil mcp ${reason}: ${stderr}`))
        return
      }
      try {
        const lines = stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line) as JsonRpcLine)
        if (settled) return
        settled = true
        resolvePromise(lines)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        fail(new Error(`anvil mcp wrote a line that is not JSON (${detail}): ${stdout}`))
      }
    })
    child.stdin.end(
      `${[
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'package-smoke', version: '1' },
          },
        }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      ].join('\n')}\n`,
    )
  })
}

const HANDSHAKE_TOOLS = ['anvil_doctor', 'anvil_plan', 'anvil_crew_status'] as const

const VALID_INITIALIZE = {
  protocolVersion: '2025-06-18',
  serverInfo: { name: 'anvil', version: '0.1.0' },
  capabilities: { tools: { listChanged: false } },
}

function validTools(): unknown[] {
  return HANDSHAKE_TOOLS.map((name) => ({
    name,
    inputSchema: { type: 'object', properties: {}, required: [] },
  }))
}

/** The two responses a healthy server produces, with one side overridable per case. */
function handshake(overrides: { init?: unknown; listResult?: unknown } = {}): unknown[] {
  return [
    { jsonrpc: '2.0', id: 1, result: overrides.init === undefined ? VALID_INITIALIZE : overrides.init },
    {
      jsonrpc: '2.0',
      id: 2,
      result: overrides.listResult === undefined ? { tools: validTools() } : overrides.listResult,
    },
  ]
}

function without(messages: unknown[], field: string): unknown[] {
  return messages.map((message) => {
    const copy = { ...(message as Record<string, unknown>) }
    delete copy[field]
    return copy
  })
}

/**
 * Regression cases for `scripts/check-mcp-handshake.ts`, the module `release.yml` runs before
 * publishing. Testing it here rather than a local copy is the point: a green suite has to mean
 * the release gate rejected these shapes.
 */
describe('the MCP handshake is validated, not just observed', () => {
  test('a complete handshake passes and reports what it saw', () => {
    assert.deepEqual(checkHandshake(handshake()), { protocolVersion: '2025-06-18', toolCount: 3 })
  })

  test('omitting the optional listChanged still passes', () => {
    checkHandshake(
      handshake({
        init: { ...VALID_INITIALIZE, capabilities: { tools: {} } },
      }),
    )
  })

  test('a malformed initialize is rejected', () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ['a null result', null, /not a JSON object/],
      ['an empty result', {}, /unsupported protocol version/],
      ['an unsupported protocol version', { ...VALID_INITIALIZE, protocolVersion: '1999-01-01' }, /unsupported/],
      [
        'a missing server name',
        { ...VALID_INITIALIZE, serverInfo: { version: '0.1.0' } },
        /identify the server as anvil/,
      ],
      ['a missing server version', { ...VALID_INITIALIZE, serverInfo: { name: 'anvil' } }, /no server version/],
      [
        'an empty server version',
        { ...VALID_INITIALIZE, serverInfo: { name: 'anvil', version: '' } },
        /no server version/,
      ],
      ['a missing tools capability', { ...VALID_INITIALIZE, capabilities: {} }, /capabilities\.tools/],
      ['a null tools capability', { ...VALID_INITIALIZE, capabilities: { tools: null } }, /capabilities\.tools/],
      ['an array-valued tools capability', { ...VALID_INITIALIZE, capabilities: { tools: [] } }, /capabilities\.tools/],
      ['a non-object tools capability', { ...VALID_INITIALIZE, capabilities: { tools: false } }, /capabilities\.tools/],
      [
        'a non-boolean listChanged',
        { ...VALID_INITIALIZE, capabilities: { tools: { listChanged: 'yes' } } },
        /listChanged/,
      ],
    ]
    for (const [what, result, expected] of cases) {
      assert.throws(() => checkHandshake(handshake({ init: result })), expected, `${what} must be rejected`)
    }
  })

  test('an incomplete tool list is rejected', () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ['a missing tools array', {}, /no tools array/],
      ['a null tools array', { tools: null }, /no tools array/],
      ['a non-array tools value', { tools: 'anvil_doctor' }, /no tools array/],
      ['a null tool entry', { tools: [null] }, /is not a JSON object/],
      ['a tool with no name', { tools: [{ name: '' }] }, /has no name/],
      ['a tool with no inputSchema', { tools: HANDSHAKE_TOOLS.map((name) => ({ name })) }, /inputSchema/],
      [
        'a tool whose inputSchema is not an object',
        { tools: HANDSHAKE_TOOLS.map((name) => ({ name, inputSchema: 'nope' })) },
        /inputSchema/,
      ],
      [
        'a tool whose inputSchema is not an object schema',
        { tools: HANDSHAKE_TOOLS.map((name) => ({ name, inputSchema: { type: 'string' } })) },
        /not an object schema/,
      ],
      [
        'a tool whose inputSchema.properties is not an object',
        { tools: HANDSHAKE_TOOLS.map((name) => ({ name, inputSchema: { type: 'object', properties: 42 } })) },
        /inputSchema\.properties/,
      ],
      [
        'a tool whose inputSchema.required holds non-strings',
        {
          tools: HANDSHAKE_TOOLS.map((name) => ({
            name,
            inputSchema: { type: 'object', required: [42] },
          })),
        },
        /inputSchema\.required/,
      ],
      ['a missing required tool', { tools: validTools().slice(0, 1) }, /missing anvil_plan/],
    ]
    for (const [what, result, expected] of cases) {
      assert.throws(() => checkHandshake(handshake({ listResult: result })), expected, `${what} must be rejected`)
    }
  })

  test('a notification between the responses is accepted', () => {
    // MCP servers may log while the handshake is in flight. A notification has no `id`, and
    // treating it as a response would reject a healthy server.
    checkHandshake([
      handshake()[0],
      {
        jsonrpc: '2.0',
        method: 'notifications/message',
        params: { level: 'info', data: 'server initialized' },
      },
      handshake()[1],
    ])
  })

  test('a malformed envelope is rejected before any payload is read', () => {
    assert.throws(() => checkHandshake(without(handshake(), 'jsonrpc')), /JSON-RPC 2\.0/)
    assert.throws(() => checkHandshake(without(handshake(), 'id')), /no request id/)
    assert.throws(() => checkHandshake([]), /no responses/)
    assert.throws(() => checkHandshake('not a list'), /not a list/)
  })

  test('a response that answers no request the handshake sent is rejected', () => {
    // The id set is closed: id 7 answers nothing in this transcript, so a server that emitted
    // it is not the one the smoke test describes.
    assert.throws(
      () => checkHandshake([...handshake(), { jsonrpc: '2.0', id: 7, result: {} }]),
      /no request id the handshake sent/,
    )
  })

  test('a response carrying neither result nor error is rejected', () => {
    assert.throws(() => checkHandshake([handshake()[0], { jsonrpc: '2.0', id: 2 }]), /exactly one of result or error/)
  })

  test('a response carrying both result and error is rejected', () => {
    assert.throws(
      () =>
        checkHandshake([
          handshake()[0],
          { jsonrpc: '2.0', id: 2, result: { tools: validTools() }, error: { code: -1, message: 'both' } },
        ]),
      /exactly one of result or error/,
    )
  })

  test('a second response for the same request is rejected, not shadowed by the first', () => {
    // This is the failure the earlier `find`-by-id implementation hid: a healthy first answer
    // made a later failure for the same id invisible to the gate.
    assert.throws(
      () => checkHandshake([...handshake(), { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'late' } }]),
      /more than one response with id 1/,
    )
  })

  test('a notification must not carry an id or a blank method', () => {
    assert.throws(
      () => checkHandshake([{ jsonrpc: '2.0', id: 7, method: 'notifications/message' }]),
      /must not carry a request id/,
    )
    assert.throws(() => checkHandshake([{ jsonrpc: '2.0', method: '' }]), /notification method/)
  })

  test('a JSON-RPC error is rejected with its message', () => {
    assert.throws(
      () =>
        checkHandshake([
          { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'boom' } },
          { jsonrpc: '2.0', id: 2, result: { tools: validTools() } },
        ]),
      /boom/,
    )
  })
})

/** The filename npm gives the scoped package: @anvil-workflows/cli -> anvil-workflows-cli-0.1.0.tgz */
function tarballName(): string {
  return `${String(CLI_PKG.name).replace('@', '').replace('/', '-')}-${String(CLI_PKG.version)}.tgz`
}

async function listTarball(tarball: string): Promise<string[]> {
  const listed = await runProcess('tar', ['tzf', tarball])
  assert.equal(listed.exitCode, 0, `tar failed: ${listed.stderr}`)
  return listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/**
 * The registry artifact (ADR-0012).
 *
 * `npm pack --workspace @anvil-workflows/cli` is what `release.yml` publishes, and nothing above packs
 * it: the suite above packs the *root*, which is the git-install unit and a different
 * artifact. A wrong bin path, a `files` allowlist that omits the bundle, or a workspace whose
 * bytes only work from a checkout would otherwise be discovered by a user after a publish --
 * and a publish cannot be undone.
 *
 * The workspace is packed once exactly as the workflow invokes it, to prove the target
 * resolves, and then from a temporary copy staged the way the workflow stages it (root
 * README and LICENSE beside the manifest), which is the artifact that is installed. The
 * temporary copy matters: staging into the checkout made two concurrent runs delete each
 * other's files, and delete any edit made while packing.
 */
describe('the registry tarball (ADR-0012)', () => {
  test('the workspace resolves and ships the bundle', { timeout: 300_000 }, async () => {
    if (!haveBuild(join(CLI_DIR, 'dist'))) return

    const packDir = tempDir('anvil-registry-workspace-pack-')
    const packed = await runProcess(
      'npm',
      ['pack', '--workspace', String(CLI_PKG.name), '--pack-destination', packDir],
      {
        cwd: REPO_ROOT,
      },
    )
    assert.equal(packed.exitCode, 0, `npm pack --workspace failed: ${packed.stderr}`)

    const tarball = join(packDir, tarballName())
    assert.ok(existsSync(tarball), `expected ${tarball} to exist`)
    const paths = await listTarball(tarball)
    const allowed = new Set([
      'package/',
      'package/package.json',
      'package/README.md',
      'package/LICENSE',
      'package/dist/cli.js',
    ])
    for (const path of paths) {
      assert.ok(allowed.has(path), `the workspace tarball contains an unexpected path: ${path}`)
    }
    for (const required of ['package/dist/cli.js', 'package/package.json']) {
      assert.ok(paths.includes(required), `the workspace tarball is missing ${required}`)
    }
  })

  test('the staged artifact installs without scripts and exercises the installed CLI', {
    timeout: 300_000,
  }, async () => {
    if (!haveBuild(join(CLI_DIR, 'dist'))) return

    const packDir = tempDir('anvil-registry-pack-')
    // `release.yml` stages the root licence and README beside the workspace manifest, because
    // npm only takes those from the package directory. Build that layout in a temp directory
    // rather than in the checkout.
    const packageDir = tempDir('anvil-registry-package-')
    mkdirSync(join(packageDir, 'dist'), { recursive: true })
    copyFileSync(join(CLI_DIR, 'package.json'), join(packageDir, 'package.json'))
    copyFileSync(join(CLI_DIR, 'dist', 'cli.js'), join(packageDir, 'dist', 'cli.js'))
    for (const file of ['LICENSE', 'README.md']) {
      copyFileSync(join(REPO_ROOT, file), join(packageDir, file))
    }

    const packed = await runProcess('npm', ['pack', '--pack-destination', packDir], { cwd: packageDir })
    assert.equal(packed.exitCode, 0, `npm pack failed: ${packed.stderr}`)

    const tarball = join(packDir, tarballName())
    assert.ok(existsSync(tarball), `expected ${tarball} to exist`)
    const paths = await listTarball(tarball)

    // ADR-0012's allowlist, and the four documents the release deliberately carries.
    const allowed = new Set([
      'package/',
      'package/package.json',
      'package/README.md',
      'package/LICENSE',
      'package/dist/cli.js',
    ])
    for (const path of paths) {
      assert.ok(allowed.has(path), `registry tarball contains an unexpected path: ${path}`)
    }
    for (const required of ['package/dist/cli.js', 'package/package.json', 'package/README.md', 'package/LICENSE']) {
      assert.ok(paths.includes(required), `registry tarball is missing ${required}`)
    }

    // A clean consumer: no workspace links, no devDependencies, and `--ignore-scripts`
    // because a registry install must not need an install step of its own. The git
    // channel's `prepare` build is what this channel exists to replace.
    const consumer = tempDir('anvil-registry-consumer-')
    writeFileSync(
      join(consumer, 'package.json'),
      JSON.stringify({ name: 'consumer', private: true, type: 'module', scripts: { test: 'node --test' } }),
      'utf8',
    )
    const fixtureFiles = new Map([
      ['.gitignore', 'node_modules/\n.anvil/\n'],
      ['README.md', '# Consumer\n\nVerify with `npm test`.\n'],
      ['smoke.test.js', "import { test } from 'node:test'\ntest('consumer smoke', () => {})\n"],
    ])
    for (const [path, content] of fixtureFiles) writeFileSync(join(consumer, path), content, 'utf8')
    const installed = await runProcess('npm', ['install', '--no-save', '--ignore-scripts', tarball], {
      cwd: consumer,
    })
    assert.equal(installed.exitCode, 0, `npm install failed: ${installed.stderr}`)

    const git = (...args: string[]) => execFileSync('git', args, { cwd: consumer, encoding: 'utf8', stdio: 'pipe' })
    git('init', '-q', '-b', 'main')
    git('add', '-A')
    git('-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-qm', 'consumer fixture')

    const installedBin = join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? 'anvil.cmd' : 'anvil')
    assert.ok(existsSync(installedBin), `bin shim missing at ${installedBin}`)
    const runInstalled = (...args: string[]) =>
      runProcess(installedBin, args, { cwd: consumer, env: { ...process.env, NO_COLOR: '1' } })
    const reported = await runInstalled('version', '--json')
    assert.equal(reported.exitCode, 0, `version failed: ${reported.stderr}`)
    assert.equal(
      (JSON.parse(reported.stdout) as { data: { version: string } }).data.version,
      String(CLI_PKG.version),
      'the installed binary reports a different version than the tarball that carried it',
    )

    const help = await runInstalled('--help')
    assert.equal(help.exitCode, 0, `help failed: ${help.stderr}`)
    assert.match(help.stdout, /\bdoctor\b/)
    assert.match(help.stdout, /\binit\b/)

    const doctor = await runInstalled('doctor', '--json')
    assert.equal(doctor.exitCode, 0, `doctor failed: ${doctor.stderr}`)
    const report = JSON.parse(doctor.stdout) as { schemaVersion: number; ok: boolean }
    assert.equal(report.schemaVersion, 1)
    assert.equal(report.ok, true)

    // Exercise generation through the registry shim, not the checkout's source or bundle.
    // Staging must leave final artifacts absent; apply must install that validated bundle
    // without changing the consumer's existing files.
    const generatedPaths = ['AGENTS.md', '.agents/skills/verify-change/SKILL.md', '.opencode/commands/review-change.md']
    const staged = await runInstalled('init', '--json')
    assert.equal(staged.exitCode, 0, `init failed: ${staged.stderr}`)
    const proposal = JSON.parse(staged.stdout) as {
      ok: boolean
      data: { staged: boolean; applied: boolean; artifacts: Array<{ path: string }> }
    }
    assert.equal(proposal.ok, true)
    assert.equal(proposal.data.staged, true)
    assert.equal(proposal.data.applied, false)
    assert.deepEqual(proposal.data.artifacts.map((artifact) => artifact.path).sort(), [...generatedPaths].sort())
    for (const path of generatedPaths)
      assert.equal(existsSync(join(consumer, path)), false, `${path} was applied early`)

    const applied = await runInstalled('init', '--apply', '--json')
    assert.equal(applied.exitCode, 0, `apply failed: ${applied.stderr}`)
    const application = JSON.parse(applied.stdout) as {
      ok: boolean
      data: { applied: boolean; written: string[] }
    }
    assert.equal(application.ok, true)
    assert.equal(application.data.applied, true)
    assert.deepEqual([...application.data.written].sort(), [...generatedPaths].sort())
    for (const path of generatedPaths) assert.ok(existsSync(join(consumer, path)), `apply omitted ${path}`)
    assert.match(readFileSync(join(consumer, 'AGENTS.md'), 'utf8'), /npm test/)
    assert.equal(existsSync(join(consumer, '.anvil', 'staging')), false, 'apply did not clear staging')
    for (const [path, content] of fixtureFiles) assert.equal(readFileSync(join(consumer, path), 'utf8'), content)

    const installedBundle = join(consumer, 'node_modules', ...String(CLI_PKG.name).split('/'), 'dist', 'cli.js')
    assert.ok(existsSync(installedBundle), `the tarball did not install ${installedBundle}`)
    const responses = await mcpHandshake(installedBundle, consumer)
    checkHandshake(responses)
  })
})
