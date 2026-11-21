/**
 * Go, Rust, JVM and .NET detectors.
 *
 * Grouped in one module because each is a short signature match plus a small set of
 * conventional commands. The interesting shared problem is the *build command*: all four
 * have canonical invocations, but none of them are guaranteed to be what the project uses.
 * Gradle in particular has `./gradlew`, `./gradlew :module:test`, and `gradle` (system),
 * only the first of which is safe to assume -- and it only exists when the wrapper is
 * committed, which is a finding in itself.
 */

import { join, posix } from 'node:path'
import {
  addCommand,
  addModule,
  addStack,
  addTool,
  type Detector,
  type DetectorContext,
  filesUnder,
  hasFile,
  markDepsAnalysed,
  setMonorepo,
} from '../detector.ts'
import { evidence, findLine, maskXmlComments } from '../manifest.ts'
import type { CommandEntry } from '../types.ts'
import { readText } from '../walk.ts'
import { nodeDetector } from './node.ts'
import { pythonDetector } from './python.ts'

function read(ctx: DetectorContext, rel: string): string | null {
  return readText(join(ctx.root, ctx.resolve(rel))).text
}

/** Only use ./gradlew when the wrapper is actually committed. */
function gradlew(ctx: DetectorContext): { cmd: string; wrapper: boolean } {
  const wrapper = hasFile(ctx, 'gradlew') || hasFile(ctx, 'gradlew.bat')
  return { cmd: wrapper ? './gradlew' : 'gradle', wrapper }
}

/**
 * A Gradle task the project defines that runs a changed-files subset of the tests.
 *
 * The two ways a build spells this are a task whose name says so (`testChanged`,
 * `changedTests`, `testAffected`) and a `Test` task filtered on `*Changed*`. Both are read
 * out of the build files, so the command names a task that exists rather than one invented
 * from a convention -- which is the whole point: a command naming a task the build does not
 * define selects nothing and fails.
 */
function gradleChangedTestTask(
  ctx: DetectorContext,
  gradleFiles: readonly string[],
): { name: string; file: string; line: number | null } | null {
  // `(register|create|task)("name"...)` and `task name(...)`, plus `name = tasks.register`.
  const declared = /(?:tasks\s*\.\s*(?:register|create)|(?:register|create|task)\s*\(\s*|task\s+)["']?([A-Za-z][\w]*)/g
  // A filter on `*Changed*`/`*Affected*` only means "changed files" in a `Test` task.
  const filtersChanged =
    /includeTestsMatching\s*\(\s*["'][^"']*(?:Changed|Affected)[^"']*["']|includeTestsMatching\s*\(\s*.*changedTests|--tests\s+["'][^"']*Changed/i

  for (const file of gradleFiles) {
    const text = read(ctx, file)
    if (text === null) continue
    for (const m of text.matchAll(declared)) {
      const name = m[1] as string
      if (!/(changed|affected)/i.test(name)) continue
      return { name, file, line: findLine(text, new RegExp(`\\b${name}\\b`)) }
    }
    if (filtersChanged.test(text)) {
      const line = findLine(text, /includeTestsMatching|--tests/)
      return { name: 'test', file, line }
    }
  }
  return null
}

/**
 * The first Gradle build file that applies a plugin.
 *
 * Tooling is configured in the module that uses it (`app/build.gradle.kts`) and usually has
 * no config file of its own, so probing only root-level `spotless.gradle` / `config/checkstyle`
 * reported "no linter configured" for a repository whose module applies detekt and whose
 * AGENTS.md documents `./gradlew detekt`. The plugin id (or version-catalog alias) is matched
 * rather than any mention, and `apply false` declarations are skipped: `ktlint(...)` inside a
 * Spotless block configures formatting, it does not create the ktlint plugin's `ktlintCheck`
 * task.
 */
function gradlePluginFile(ctx: DetectorContext, buildFiles: readonly string[], plugin: RegExp): string | null {
  for (const file of buildFiles) {
    const text = read(ctx, file)
    if (text === null) continue
    for (const line of text.split('\n')) {
      if (/apply\s+false/.test(line)) continue
      if (plugin.test(line)) return file
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Android and Kotlin Multiplatform
// ---------------------------------------------------------------------------

/** Every Gradle build file: the modules and the settings that enumerate them. */
function gradleBuildFiles(ctx: DetectorContext): string[] {
  return filesUnder(ctx, '').filter((f) => /(^|\/)(?:build|settings)\.gradle(?:\.kts)?$/.test(f))
}

/**
 * The plugin that makes a Gradle build an *Android* build.
 *
 * This exists because `android.yaml` used to match on the `gradle` dependency and a bare
 * `**\/build.gradle.kts`, which is every Gradle project ever written. Spring Petclinic -- a
 * Gradle Java build -- was matched as Android and offered Compose performance guidance, and a
 * Kotlin Multiplatform module with no Android target was matched the same way. The evidence
 * for Android is the Android Gradle Plugin id, not the build system.
 */
const ANDROID_PLUGIN =
  /com\.android\.(?:application|library|test|dynamic-feature|asset-pack)|com\.android\.tools\.build:gradle/

/** One manifest or plugin line is Android evidence; the first found is the citation. */
function androidEvidence(ctx: DetectorContext): string | null {
  const manifest = filesUnder(ctx, '').find((f) => f === 'AndroidManifest.xml' || f.endsWith('/AndroidManifest.xml'))
  if (manifest !== undefined) return manifest

  for (const file of gradleBuildFiles(ctx)) {
    const text = read(ctx, file)
    if (text === null) continue
    const plugin = findLine(text, ANDROID_PLUGIN)
    if (plugin !== null) return evidence(file, plugin)
    // An `android { }` block with no plugin line in this file: the plugin is applied by a
    // convention plugin or a parent, and the block is still a statement about Android.
    const block = findLine(text, /\bandroid\s*\{/)
    if (block !== null) return evidence(file, block)
  }

  const props = read(ctx, 'gradle.properties')
  if (props !== null) {
    const line = findLine(props, /^\s*android\./)
    if (line !== null) return evidence('gradle.properties', line)
  }
  return null
}

export const androidDetector: Detector = {
  id: 'android',
  title: 'Android',
  // After `jvm`, so a shared Gradle build claims names first; the stack is additive either way.
  priority: 65,
  matches: (ctx) => androidEvidence(ctx) !== null,
  detect(ctx, draft) {
    const evidencePath = androidEvidence(ctx)
    if (evidencePath === null) return
    addStack(draft, { id: 'android', version: null, evidence: [evidencePath] })
  },
}

/**
 * Kotlin Multiplatform, detected separately so it is not mistaken for Android.
 *
 * A KMP module shares the Gradle build system and the `kotlin` language with an Android one,
 * but it targets iOS, JVM and native too. The two are frequently *and* legitimately both
 * (a KMP module with an `androidTarget`), which is why this is its own stack rather than a
 * correction to `android`: a repository can be both, and the plan should say so.
 */
const KMP_PLUGIN =
  /kotlin\s*\(\s*["']multiplatform["']\s*\)|kotlin-multiplatform|kotlin\.multiplatform|ios(?:Arm64|X64|SimulatorArm64)\s*\(/

export const kotlinMultiplatformDetector: Detector = {
  id: 'kotlin-multiplatform',
  title: 'Kotlin Multiplatform',
  priority: 66,
  matches: (ctx) => gradleBuildFiles(ctx).length > 0,
  detect(ctx, draft) {
    for (const file of gradleBuildFiles(ctx)) {
      const text = read(ctx, file)
      if (text === null) continue
      const line = findLine(text, KMP_PLUGIN)
      if (line !== null) {
        addStack(draft, { id: 'kotlin-multiplatform', version: null, evidence: [evidence(file, line)] })
        return
      }
    }
  },
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

/**
 * Workspace-internal `require` edges from one `go.mod`.
 *
 * Only module paths already present in this workspace count, and the current module is never
 * its own dependency. A `require` inside a commented line is ignored, so a commented-out
 * edge cannot silently appear in the module graph.
 */
function goWorkspaceRequires(mod: string, members: ReadonlySet<string>, self: string): string[] {
  const out = new Set<string>()
  let block = false
  for (const raw of mod.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim()
    if (line === '') continue
    if (/^require\s*\(/.test(line)) {
      block = true
      continue
    }
    if (block && line === ')') {
      block = false
      continue
    }
    const name = /^require\s+(\S+)/.exec(line)?.[1] ?? (block ? /^(\S+)\s+v\S+/.exec(line)?.[1] : undefined)
    if (name === undefined || name === self || !members.has(name)) continue
    out.add(name)
  }
  return [...out].sort()
}

/**
 * Directories named by `use` in a `go.work`.
 *
 * Only these are workspace members. Scanning every `go.mod` in the tree would add an
 * unrelated checkout or an example module to the graph, and would let a `require` create a
 * dependency edge to one. Both spellings are read: `use ./one` and a parenthesised block.
 */
function goWorkMembers(text: string): string[] {
  const out: string[] = []
  let block = false
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim()
    if (line === '') continue
    if (/^use\s*\(/.test(line)) {
      block = true
      continue
    }
    if (block && line === ')') {
      block = false
      continue
    }
    const value = /^use\s+(\S+)/.exec(line)?.[1] ?? (block ? line.split(/\s+/)[0] : undefined)
    if (value === undefined) continue
    const path = posix.normalize(value.replace(/\\/g, '/')).replace(/\/+$/, '')
    out.push(path === '.' || path === '' ? '.' : path)
  }
  return [...new Set(out)]
}

export const goDetector: Detector = {
  id: 'go',
  title: 'Go',
  priority: 50,
  matches: (ctx) => hasFile(ctx, 'go.mod') || hasFile(ctx, 'go.work'),
  detect(ctx, draft) {
    const mod = read(ctx, 'go.mod')
    if (mod !== null) {
      addStack(draft, {
        id: 'go',
        // The `go` directive is a language version, not a toolchain version; take the
        // minor as the closest verifiable thing.
        version: /^\s*go\s+1\.(\d+)/m.exec(mod)?.[1] !== undefined ? `1.${/^\s*go\s+1\.(\d+)/m.exec(mod)?.[1]}` : null,
        evidence: [evidence('go.mod', findLine(mod, /^module\s+/))],
      })
    }
    if (hasFile(ctx, 'go.work')) {
      setMonorepo(draft, { tool: 'go-work', evidence: 'go.work', members: [] })
      const work = read(ctx, 'go.work')
      const modules: Array<{ id: string; path: string; mod: string | null }> = []
      for (const path of work === null ? [] : goWorkMembers(work)) {
        const manifest = path === '.' ? 'go.mod' : `${path}/go.mod`
        // A declared member with no manifest is not a module. A manifest that exists but cannot
        // be read is different: keep it as a module with unknown deps, never mark it analysed.
        if (!ctx.files.has(ctx.resolve(manifest))) continue
        const inner = read(ctx, manifest)
        const name = inner === null ? path : (/^module\s+(\S+)/m.exec(inner)?.[1] ?? path)
        addModule(draft, { id: name, path, kind: 'package', deps: [] })
        modules.push({ id: name, path, mod: inner })
      }
      // A `require` of another declared member is an internal edge. External requirements are
      // deliberately not inferred as graph nodes: they are not modules here.
      const ids = new Set(modules.map((m) => m.id))
      for (const module of modules) {
        if (module.mod === null) continue
        const deps = goWorkspaceRequires(module.mod, ids, module.id)
        const existing = draft.modules.find((m) => m.id === module.id)
        if (existing !== undefined) existing.deps = deps
        markDepsAnalysed(draft, module.id)
      }
      if (draft.monorepo !== null) draft.monorepo.members = [...ids]
    }

    // A fast subset exists only if the project says so: `go test -short`, or a
    // `TestShort` guard. Both are searched for rather than assumed.
    const hasShort = filesUnder(ctx, '').some((f) => {
      if (!f.endsWith('_test.go')) return false
      const t = read(ctx, f)
      return t !== null && /testing\.Short\(\)/.test(t)
    })
    addCommand(draft, 'test', {
      cmd: 'go test ./...',
      source: 'detected',
      evidence: 'go.mod',
    })
    if (hasShort) {
      addCommand(draft, 'testFast', {
        cmd: 'go test -short ./...',
        source: 'detected',
        evidence: 'testing.Short() guard found',
      })
    }
    if (hasFile(ctx, '.golangci.yml') || hasFile(ctx, '.golangci.yaml')) {
      addTool(draft, 'lint', 'golangci-lint')
      addCommand(draft, 'lint', {
        cmd: 'golangci-lint run',
        source: 'detected',
        evidence: '.golangci.yml',
      })
    }
    if (hasFile(ctx, 'Makefile')) {
      // No `make build` here any more. It was emitted for any repository with a Makefile,
      // so a project whose Makefile defines only `deploy` was told to build with a target
      // that does not exist -- labelled `detected`, with evidence `Makefile` and no claim
      // that `build` was in it. The language-agnostic pass reads the real targets instead
      // (`detectMakefileCommands`), so this is emitted when a `build` target is actually
      // defined, with the line it is defined on.
    }
  },
}

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

/**
 * Internal edges declared as Cargo path dependencies.
 *
 * Only a literal `path = "..."` inside a dependency table counts: it names a directory in
 * this workspace, so the edge is declared rather than inferred. Registry dependencies are
 * not workspace nodes and are deliberately ignored. The name of the crate is not trusted as
 * an edge; the resolved directory is.
 */
type CargoDependencyEntry = { name: string; path: string | null; workspace: boolean }

/** Read dependency entries from a Cargo manifest, including `[dependencies.name]` tables. */
function cargoDependencyEntries(manifest: string, workspaceSection: boolean): CargoDependencyEntry[] {
  const out: CargoDependencyEntry[] = []
  let inSection = false
  let sectionCrate: string | null = null
  let entry = ''
  const flush = (): void => {
    if (!inSection) return
    const name = sectionCrate ?? /^\s*([A-Za-z0-9_-]+)\s*=/.exec(entry)?.[1] ?? null
    if (name === null) return
    const path = /path\s*=\s*["']([^"']+)["']/.exec(entry)?.[1] ?? null
    const workspace = /\bworkspace\s*=\s*true\b/.test(entry)
    if (path !== null || workspace) out.push({ name, path, workspace })
  }
  for (const raw of manifest.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim()
    if (line.startsWith('[')) {
      flush()
      entry = ''
      const table = /^\[(.+)\]$/.exec(line)?.[1] ?? ''
      const prefixes = workspaceSection
        ? ['workspace.dependencies']
        : ['dependencies', 'dev-dependencies', 'build-dependencies']
      let rest: string | null = null
      for (const prefix of prefixes) {
        if (table === prefix) rest = ''
        else if (table.startsWith(`${prefix}.`)) rest = table.slice(prefix.length + 1)
        // Target-scoped tables such as [target.'cfg(unix)'.dependencies] also declare deps.
        else if (table.endsWith(`.${prefix}`)) rest = ''
        else {
          const scoped = table.indexOf(`.${prefix}.`)
          if (scoped >= 0) rest = table.slice(scoped + prefix.length + 2)
        }
        if (rest !== null) break
      }
      inSection = rest !== null
      sectionCrate = rest === '' || rest === null ? null : (rest.split('.')[0] ?? null)
      continue
    }
    if (!inSection || line === '') continue
    if (/^[A-Za-z0-9_-]+\s*=/.test(line)) flush()
    entry += `${entry === '' ? '' : '\n'}${line}`
  }
  flush()
  return out
}

function cargoPathDependencies(
  manifest: string,
  cratePath: string,
  paths: ReadonlySet<string>,
  workspacePaths: ReadonlyMap<string, string> = new Map(),
): string[] {
  const out = new Set<string>()
  const add = (path: string, base: string): void => {
    const normalized = posix.normalize(posix.join(base, path)).replace(/\/+$/, '')
    if (normalized !== '' && paths.has(normalized)) out.add(normalized)
  }
  for (const entry of cargoDependencyEntries(manifest, false)) {
    if (entry.path !== null) add(entry.path, cratePath)
    else if (entry.workspace) {
      const shared = workspacePaths.get(entry.name)
      // A [workspace.dependencies] path is relative to the workspace root, not the member.
      if (shared !== undefined) add(shared, '.')
    }
  }
  return [...out].sort()
}

export const rustDetector: Detector = {
  id: 'rust',
  title: 'Rust',
  priority: 50,
  matches: (ctx) => hasFile(ctx, 'Cargo.toml'),
  detect(ctx, draft) {
    const cargo = read(ctx, 'Cargo.toml')
    addStack(draft, {
      id: 'rust',
      version: null,
      evidence: [evidence('Cargo.toml', cargo === null ? null : findLine(cargo, /^\[package\]/))],
    })

    if (cargo !== null && /\[workspace\]/.test(cargo)) {
      setMonorepo(draft, {
        tool: 'cargo-workspace',
        evidence: evidence('Cargo.toml', findLine(cargo, /\[workspace\]/)),
        members: [],
      })
      const crates: Array<{ id: string; path: string; manifest: string | null }> = []
      for (const f of ctx.files) {
        if (!f.endsWith('/Cargo.toml')) continue
        const path = f === 'Cargo.toml' ? '.' : f.slice(0, -'/Cargo.toml'.length)
        const inner = read(ctx, f)
        const name = inner === null ? path : (/^\s*name\s*=\s*["']([^"']+)["']/m.exec(inner)?.[1] ?? path)
        addModule(draft, { id: name, path, kind: 'crate', deps: [] })
        crates.push({ id: name, path, manifest: inner })
      }
      // A path dependency on another crate in this workspace is a declared internal edge.
      // A manifest that cannot be read stays unknown rather than becoming an empty list.
      const paths = new Set(crates.map((crate) => crate.path))
      const idByPath = new Map(crates.map((crate) => [crate.path, crate.id]))
      // A member can inherit a path from [workspace.dependencies] with `workspace = true`;
      // resolve that shared declaration against the workspace root before looking for edges.
      const workspacePaths = new Map<string, string>()
      if (cargo !== null) {
        for (const entry of cargoDependencyEntries(cargo, true)) {
          if (entry.path !== null) workspacePaths.set(entry.name, entry.path)
        }
      }
      for (const crate of crates) {
        if (crate.manifest === null) continue
        const pathsFound = cargoPathDependencies(crate.manifest, crate.path, paths, workspacePaths)
        const deps = [...new Set(pathsFound.map((path) => idByPath.get(path) ?? path))].filter((id) => id !== crate.id)
        const existing = draft.modules.find((module) => module.id === crate.id)
        if (existing !== undefined) existing.deps = deps.sort()
        markDepsAnalysed(draft, crate.id)
      }
      if (draft.monorepo !== null) draft.monorepo.members = crates.map((crate) => crate.id)
    }

    const commands: Array<['build' | 'test' | 'testFast' | 'lint' | 'format', CommandEntry]> = [
      ['build', { cmd: 'cargo build', source: 'inferred' }],
      ['test', { cmd: 'cargo test', source: 'inferred' }],
      ['format', { cmd: 'cargo fmt --check', source: 'inferred' }],
    ]
    for (const [kind, entry] of commands) addCommand(draft, kind, entry)

    if (hasFile(ctx, 'clippy.toml') || (cargo !== null && /clippy/.test(cargo))) {
      addCommand(draft, 'lint', {
        cmd: 'cargo clippy --all-targets -- -D warnings',
        source: 'inferred',
      })
    }
    // `cargo nextest run` is the fast path; its presence is a real, checkable signal.
    if (cargo !== null && /nextest/.test(cargo)) {
      addCommand(draft, 'testFast', {
        cmd: 'cargo nextest run',
        source: 'detected',
        evidence: 'Cargo.toml',
      })
    } else if (hasFile(ctx, '.config/nextest.toml')) {
      addCommand(draft, 'testFast', {
        cmd: 'cargo nextest run',
        source: 'detected',
        evidence: '.config/nextest.toml',
      })
    }
    if (hasFile(ctx, 'rust-toolchain.toml') || hasFile(ctx, 'rust-toolchain')) {
      addStack(draft, {
        id: 'rust-toolchain',
        version: null,
        evidence: ['rust-toolchain.toml'],
      })
    }
  },
}

// ---------------------------------------------------------------------------
// JVM (Gradle / Maven)
// ---------------------------------------------------------------------------

/**
 * The POMs a Maven reactor builds: the root plus every `<module>` it declares, recursively.
 *
 * A reactor parent commonly has `<packaging>pom</packaging>` and no dependencies of its own;
 * the Spring Boot starter lives in `api/pom.xml`. Probing only the root therefore reports the
 * repository as plain Maven/JVM. The module paths are relative to the POM that declares them,
 * and nested reactors are followed the same way.
 */
function mavenReactorPoms(ctx: DetectorContext, rootPom: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const queue = [rootPom]
  while (queue.length > 0) {
    const pom = queue.shift() as string
    if (seen.has(pom)) continue
    seen.add(pom)
    if (!ctx.files.has(pom)) continue
    out.push(pom)

    const text = read(ctx, pom)
    if (text === null) continue
    const dir = pom.slice(0, pom.lastIndexOf('/') + 1)
    for (const match of maskXmlComments(text).matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)) {
      const module = (match[1] as string).trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
      if (module !== '') queue.push(`${dir}${module}/pom.xml`)
    }
  }
  return out
}

/** Blank Groovy/Kotlin comments, keeping strings and newlines so offsets and evidence survive. */
function maskGradleComments(text: string): string {
  const out = text.split('')
  const n = text.length
  const blank = (from: number, to: number): void => {
    for (let j = from; j < to; j++) if (out[j] !== '\n') out[j] = ' '
  }
  let i = 0
  while (i < n) {
    const ch = text[i] as string
    if (ch === '/' && text[i + 1] === '/') {
      const start = i
      while (i < n && text[i] !== '\n') i++
      blank(start, i)
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      // Kotlin block comments nest. Stopping at the first `*/` treats the rest of the real
      // comment as code, so a dependency written after it can become a false edge.
      const start = i
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (text[i] === '/' && text[i + 1] === '*') {
          depth++
          i += 2
        } else if (text[i] === '*' && text[i + 1] === '/') {
          depth--
          i += 2
        } else i++
      }
      blank(start, Math.min(n, i))
      continue
    }
    if (ch === '"' || ch === "'") {
      const quote = ch
      // Kotlin raw strings and Groovy triple-quoted strings run across lines; skipping them as
      // a unit keeps a `//` or `"` inside from being read as a comment or the end of a string.
      if (text.startsWith(quote.repeat(3), i)) {
        const close = text.indexOf(quote.repeat(3), i + 3)
        i = close < 0 ? n : close + 3
        continue
      }
      i++
      while (i < n && text[i] !== quote) {
        if (text[i] === '\\') i++
        i++
      }
      i++
      continue
    }
    i++
  }
  return out.join('')
}

/**
 * Blank the contents of string literals while keeping their quotes and source offsets.
 *
 * Remaps are matched structurally, so text that only looks like an assignment inside a string
 * must not be read as one. Keeping the quotes lets the matched span's value be read from the
 * original source.
 */
function maskGradleStrings(text: string): string {
  const out = text.split('')
  const n = text.length
  const blank = (from: number, to: number): void => {
    for (let j = from; j < to; j++) if (text[j] !== '\n') out[j] = '\u0000'
  }
  let i = 0
  while (i < n) {
    const ch = text[i] as string
    // Groovy slashy strings use `/.../`. Without masking them, a documented dependency inside a
    // string becomes a real edge. Only a slash in string position is treated this way, so normal
    // division is not mistaken for a literal.
    if (ch === '/' && text[i + 1] !== '/' && text[i + 1] !== '*') {
      let previous = i - 1
      while (previous >= 0 && /[ \t]/.test(text[previous] as string)) previous--
      const before = previous < 0 ? '' : (text[previous] as string)
      if (before === '' || '=(:,'.includes(before)) {
        let end = i + 1
        while (end < n && text[end] !== '\n') {
          if (text[end] === '\\') {
            end += 2
            continue
          }
          if (text[end] === '/') break
          end++
        }
        if (end < n && text[end] === '/') {
          blank(i + 1, end)
          i = end + 1
          continue
        }
      }
    }
    if (ch !== '"' && ch !== "'") {
      i++
      continue
    }
    const quote = ch
    // Kotlin raw strings (`"""`) and Groovy triple-quoted strings span lines. Their contents are
    // data, so a remap written inside one must not be read as an assignment.
    if (text.startsWith(quote.repeat(3), i)) {
      const close = text.indexOf(quote.repeat(3), i + 3)
      blank(i + 3, close < 0 ? n : close)
      i = close < 0 ? n : close + 3
      continue
    }
    i++
    while (i < n && text[i] !== quote) {
      if (text[i] === '\\' && i + 1 < n) {
        out[i] = '\u0000'
        out[i + 1] = '\u0000'
        i += 2
        continue
      }
      if (text[i] !== '\n') out[i] = '\u0000'
      i++
    }
    if (i < n) i++
  }
  return out.join('')
}

/** A Gradle project path always starts with `:`, whichever DSL wrote it. */
function gradlePath(id: string): string {
  return id.startsWith(':') ? id : `:${id}`
}

/** The index one past the end of the statement at `start`, respecting brackets. */
function gradleStatementEnd(text: string, start: number): number {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const ch = text[i] as string
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return i
      depth--
    } else if (depth === 0 && (ch === '\n' || ch === ';')) return i
  }
  return text.length
}

/** The index of the brace that closes the one at `open`, or -1. */
function gradleMatchingBrace(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const ch = text[i] as string
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Subproject directories remapped from their Gradle path with `project(":api").projectDir`.
 *
 * The include declares the project path, but `projectDir = file("services/api")` moves its build
 * file. Following only the path misreads the module as missing and loses its plugins. The value
 * is relative to the settings file that declares it, so a nested `app/settings.gradle.kts` with
 * `file("../services/api")` names `services/api` in the repository.
 */
function gradleProjectDirs(text: string, baseDir: string): Map<string, string | null> {
  const out = new Map<string, string | null>()
  const masked = maskGradleStrings(maskGradleComments(text))
  const normalize = (path: string): string => {
    const value = path.trim().replace(/\\/g, '/')
    const resolved = value.startsWith('/') ? value : posix.join(baseDir, value)
    return posix.normalize(resolved).replace(/^\.\//, '').replace(/\/+$/, '')
  }
  /**
   * The directory a remap RHS names, or null when it is computed. Only `file("...")` and a bare
   * string are static; taking the first literal out of `file("x") + suffix` invents a path. The
   * RHS spans to the end of the statement, so a `file(` whose argument is on the next line is
   * read whole.
   */
  const remap = (from: number, to: number): string | null => {
    const span = masked.slice(from, to)
    const leading = span.length - span.trimStart().length
    const rhs = span.trim()
    const match = /^file\s*\(\s*(['"])(\u0000*)\1\s*\)$/d.exec(rhs) ?? /^(['"])(\u0000*)\1$/d.exec(rhs)
    const content = match?.indices?.[2]
    if (match === null || content === undefined) return null
    const start = from + leading + content[0]
    return text.slice(start, start + (content[1] - content[0]))
  }
  // Both assignment spellings, in source order, so a later one replaces or invalidates an
  // earlier remap of the same project.
  const remaps: Array<{ index: number; id: string; value: string | null }> = []
  const literal = /project\s*\(\s*(['"])([^'"]*)\1\s*\)\s*\.\s*projectDir\s*=\s*/dg
  for (const match of masked.matchAll(literal)) {
    const id = match.indices?.[2]
    if (id === undefined) continue
    const at = (match.index ?? 0) + match[0].length
    remaps.push({
      index: match.index ?? 0,
      id: text.slice(id[0], id[1]),
      value: remap(at, gradleStatementEnd(masked, at)),
    })
  }
  const block = /project\s*\(\s*(['"])([^'"]*)\1\s*\)\s*\{/dg
  for (const match of masked.matchAll(block)) {
    const id = match.indices?.[2]
    if (id === undefined) continue
    const open = (match.index ?? 0) + match[0].length - 1
    const close = gradleMatchingBrace(masked, open)
    if (close < 0) continue
    const body = masked.slice(open + 1, close)
    const projectDir = /\bprojectDir\s*=\s*/d.exec(body)
    if (projectDir?.index === undefined) continue
    const at = open + 1 + projectDir.index + projectDir[0].length
    remaps.push({
      index: match.index ?? 0,
      id: text.slice(id[0], id[1]),
      value: remap(at, gradleStatementEnd(masked, at)),
    })
  }
  remaps.sort((a, b) => a.index - b.index)
  for (const { id, value } of remaps) {
    const path = gradlePath(id)
    // A later assignment whose value is not static leaves the project's directory unknown. It is
    // recorded as null so a caller does not fall back to the declared path, which could name an
    // unrelated directory.
    out.set(path, value === null ? null : normalize(value))
  }
  return out
}

/** Gradle dependency configurations whose `project(...)` arguments are internal edges. */
function gradleDependencyCall(name: string): boolean {
  const known = new Set([
    'add',
    'implementation',
    'api',
    'compileOnly',
    'runtimeOnly',
    'annotationProcessor',
    'kapt',
    'ksp',
    'testImplementation',
    'testCompileOnly',
    'testRuntimeOnly',
    'androidTestImplementation',
    'androidTestCompileOnly',
    'androidTestRuntimeOnly',
  ])
  return known.has(name) || /(?:Implementation|CompileOnly|RuntimeOnly|Api)$/.test(name)
}

/** The index of the `)` closing the `(` at `open`, or -1. */
function gradleMatchingParen(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

type GradleDeps = { deps: string[]; unsupported: boolean }

/**
 * Read one `dependencies { ... }` body.
 *
 * Strings are masked before structure is read, so a `dependencies` block, a `}` or a
 * `project(":x")` inside a literal cannot create an edge or end a block early. Masking preserves
 * offsets, so literal values are read from the original source by index.
 *
 * Only a `project(...)` inside a dependency configuration call is an edge. A lookup assigned to
 * a variable and then passed to a configuration, an interpolated path, an unknown configuration
 * and a non-literal argument leave coverage unknown rather than a confident empty list.
 */
function gradleDependenciesBody(
  text: string,
  bodyStart: number,
  body: string,
  target: string,
  members: ReadonlySet<string>,
): GradleDeps {
  const out = new Set<string>()
  let unsupported = false
  const literal = /(['"])(\u0000*)\1\s*\)/
  const namedLiteral = /path\s*=\s*(['"])(\u0000*)\1\s*\)/
  const literalProject = /\bproject\s*\(\s*(['"])(\u0000*)\1\s*\)/dg
  const namedProject = /\bproject\s*\(\s*path\s*=\s*(['"])(\u0000*)\1\s*\)/dg
  const isLookup = (before: string): boolean => /(?:=|\bval\b|\bvar\b)\s*$/.test(before)

  // A lookup stored in a variable and later passed to a configuration cannot be resolved
  // without evaluating code; record it so that use can be reported as unknown.
  const assigned = new Map<string, string>()
  for (const match of body.matchAll(/\b(?:val|var)\s+([A-Za-z_]\w*)\s*=\s*project\s*\(\s*(['"])(\u0000*)\2\s*\)/dg)) {
    const span = match.indices?.[3]
    if (span === undefined) continue
    assigned.set(match[1] ?? '', text.slice(bodyStart + span[0], bodyStart + span[1]))
  }

  const addProjectArgument = (raw: string, before: string, after: string, config: string): void => {
    // A project call inside a larger expression is a lookup used to build some other value,
    // not a direct dependency argument.
    if (before.trim() !== '' && !/,$/.test(before.trim())) {
      unsupported = true
      return
    }
    if (after.trim() !== '' && !/^[,)]/.test(after.trim())) {
      // A project lookup used in an expression is not an edge, but it may feed a dependency;
      // leave coverage unknown instead of claiming a confident empty list.
      unsupported = true
      return
    }
    if (raw.includes('$')) {
      unsupported = true // interpolated Kotlin/Groovy string
      return
    }
    if (!gradleDependencyCall(config)) {
      // An unknown configuration could hide a dependency; never report a confident negative.
      unsupported = true
      return
    }
    // Gradle resolves a project path without a leading ':' relative to the declaring project:
    // `project("core")` in `:app` means `:app:core`, never `:core`. Only an absolute `:core`
    // selects the root-level module. Do not fall back to a different member with the same tail.
    const id = raw.startsWith(':') ? gradlePath(raw) : target === ':' ? `:${raw}` : `${target}:${raw}`
    if (id === target || !members.has(id)) return
    out.add(id)
  }

  for (const call of body.matchAll(/\b([A-Za-z_][\w.-]*)\s*\(/g)) {
    const name = call[1] ?? ''
    const callAt = call.index ?? 0
    // A bare project lookup (`val other = project(":x")`) is not a dependency declaration.
    if (name === 'project' && isLookup(body.slice(0, callAt))) continue
    const open = callAt + call[0].length - 1
    const close = gradleMatchingParen(body, open)
    if (close < 0) {
      unsupported = true
      continue
    }
    const argsStart = open + 1
    const args = body.slice(argsStart, close)
    const recognized = gradleDependencyCall(name)

    for (const pattern of [literalProject, namedProject]) {
      for (const match of args.matchAll(pattern)) {
        const span = match.indices?.[2]
        if (span === undefined) continue
        const raw = text.slice(bodyStart + argsStart + span[0], bodyStart + argsStart + span[1])
        addProjectArgument(raw, args.slice(0, match.index), args.slice(match.index + match[0].length), name)
      }
    }

    for (const match of args.matchAll(/\bproject\s*\(\s*/g)) {
      const rest = args.slice(match.index + match[0].length)
      if (literal.test(rest) || namedLiteral.test(rest)) continue
      unsupported = true
    }
    if (recognized) {
      // Gradle's type-safe `projects.core` accessors cannot be resolved without evaluating the
      // generated model; do not silently report "no dependencies".
      if (/\bprojects\s*\./.test(args)) unsupported = true
      for (const variable of assigned.keys()) {
        if (new RegExp(`\\b${variable}\\b`).test(args)) unsupported = true
      }
    }
  }

  // Groovy also allows `implementation project(":core")` without parentheses around the call.
  for (const pattern of [
    /\b([A-Za-z_][\w.-]*)\s+project\s*\(\s*(['"])(\u0000*)\2\s*\)/dg,
    /\b([A-Za-z_][\w.-]*)\s+project\s*\(\s*path\s*=\s*(['"])(\u0000*)\3\s*\)/dg,
  ]) {
    for (const match of body.matchAll(pattern)) {
      const span = match.indices?.[3]
      if (span === undefined) continue
      const raw = text.slice(bodyStart + span[0], bodyStart + span[1])
      // Groovy statements have no closing parenthesis; the declaration ends at the newline or
      // semicolon, which is what the "whole argument" check must look at.
      const after = body.slice(match.index + match[0].length).split(/[\n;]/, 1)[0] ?? ''
      addProjectArgument(raw, '', after, match[1] ?? '')
    }
  }

  // Groovy command expressions also allow `implementation projects.core`.
  for (const match of body.matchAll(/\b([A-Za-z_][\w.-]*)\s+(projects\s*\.[A-Za-z_][\w.]*)/g)) {
    if (gradleDependencyCall(match[1] ?? '')) unsupported = true
  }
  return { deps: [...out].sort(), unsupported }
}

/** Parse the `dependencies` blocks in a region of masked Gradle source. */
function gradleDependenciesIn(
  text: string,
  content: string,
  from: number,
  to: number,
  target: string,
  members: ReadonlySet<string>,
  skipRanges: ReadonlyArray<readonly [number, number]> = [],
): GradleDeps {
  const out = new Set<string>()
  let unsupported = false
  const region = content.slice(from, to)
  for (const block of region.matchAll(/\bdependencies\s*\{/g)) {
    const open = from + (block.index ?? 0) + block[0].length - 1
    if (skipRanges.some(([start, end]) => open >= start && open <= end)) continue
    const close = gradleMatchingBrace(content, open)
    if (close < 0 || close > to) {
      unsupported = true
      continue
    }
    const parsed = gradleDependenciesBody(text, open + 1, content.slice(open + 1, close), target, members)
    for (const dep of parsed.deps) out.add(dep)
    unsupported ||= parsed.unsupported
  }
  return { deps: [...out].sort(), unsupported }
}

/** Internal edges declared in a Gradle build file, including `project(":api") { ... }` blocks. */
function gradleProjectDependencies(
  text: string,
  members: ReadonlySet<string>,
  self: string,
  includeOwn = true,
): GradleDeps {
  const content = maskGradleStrings(maskGradleComments(text))
  // A `project("...") { ... }` block configures a different module; its nested `dependencies`
  // block must not be attributed to the script that happens to contain it.
  const ranges: Array<readonly [number, number]> = []
  for (const block of content.matchAll(/\bproject\s*\(\s*(['"])(\u0000+)\1\s*\)\s*\{/dg)) {
    const open = (block.index ?? 0) + block[0].length - 1
    const close = gradleMatchingBrace(content, open)
    if (close >= 0) ranges.push([open, close])
  }
  const own = includeOwn
    ? gradleDependenciesIn(text, content, 0, content.length, self, members, ranges)
    : { deps: [] as string[], unsupported: false }
  for (const block of content.matchAll(/\bproject\s*\(\s*(['"])(\u0000+)\1\s*\)\s*\{/dg)) {
    const span = block.indices?.[2]
    if (span === undefined) continue
    const id = text.slice(span[0], span[1])
    if (id.includes('$')) {
      // An interpolated selector cannot be resolved statically.
      own.unsupported = true
      continue
    }
    // A block configures one named project. Never attribute its dependencies to every member.
    if (id !== self || !members.has(id)) continue
    const open = (block.index ?? 0) + block[0].length - 1
    const close = gradleMatchingBrace(content, open)
    if (close < 0) continue
    const nested = gradleDependenciesIn(text, content, open + 1, close, id, members)
    for (const dep of nested.deps) own.deps.push(dep)
    own.unsupported ||= nested.unsupported
  }
  own.deps = [...new Set(own.deps)].sort()
  return own
}

/**
 * True when a root build file declares project dependencies for an unknown set of modules
 * (`subprojects { ... }` / `allprojects { ... }`). Those edges cannot be attributed safely, so
 * every member's coverage must stay unknown rather than becoming a confident empty list.
 */
/** True when a root script selects a project with a computed rather than literal name. */
function gradleRootComputedProjectSelector(text: string): boolean {
  const content = maskGradleStrings(maskGradleComments(text))
  for (const match of content.matchAll(/\bproject\s*\(\s*(['"])(\u0000*)\1\s*\)/dg)) {
    const open = (match.index ?? 0) + match[0].length - 1
    if (!/^\s*\{/.test(content.slice(open + 1))) continue
    const span = match.indices?.[2]
    if (span === undefined) return true
    // A masked literal can hide interpolation; read the original value to see it.
    if (text.slice(span[0], span[1]).includes('$')) return true
  }
  for (const match of content.matchAll(/\bproject\s*\(/g)) {
    const open = (match.index ?? 0) + match[0].length - 1
    const close = gradleMatchingParen(content, open)
    if (close < 0 || !/^\s*\{/.test(content.slice(close + 1))) continue
    if (!/^\s*(['"])\u0000+\1\s*$/.test(content.slice(open + 1, close))) return true
  }
  return false
}

/**
 * Project-specific `buildFileName` declarations in a settings file.
 *
 * A `null` value means the name is computed and the effective build script is unknown, so no
 * module's dependency list can be trusted. The ordinary DSL and the `project(":x") { ... }`
 * form are both read; a script that renames the default is not parsed from the default name.
 */
type GradleScriptSelection = { names: Map<string, string | null>; ambiguous: boolean }

/**
 * Custom script selection is read-only but deliberately conservative.
 *
 * A settings file that writes `buildFileName` changes which script Gradle evaluates. Resolving
 * that write safely would require evaluating arbitrary Kotlin/Groovy, so any write makes every
 * module's dependency coverage unknown. Comparisons (`==`) are not writes and are ignored.
 */
function gradleBuildFileNameSelection(text: string): GradleScriptSelection {
  const masked = maskGradleStrings(maskGradleComments(text))
  const writes = [...masked.matchAll(/\bbuildFileName\s*=\s*(?!=)/g)].length
  const compound = [...masked.matchAll(/\bbuildFileName\s*[+*/-]=/g)].length
  // Groovy allows command-style calls without parentheses, so the method name alone is the signal.
  const setters = [...masked.matchAll(/\bsetBuildFileName\b/g)].length
  return { names: new Map(), ambiguous: writes > 0 || compound > 0 || setters > 0 }
}

function gradleRootWideProjectDeps(text: string, members: ReadonlySet<string>): boolean {
  const content = maskGradleStrings(maskGradleComments(text))
  for (const block of content.matchAll(/\b(?:subprojects|allprojects)\s*\{/g)) {
    const open = (block.index ?? 0) + block[0].length - 1
    const close = gradleMatchingBrace(content, open)
    if (close < 0) continue
    const parsed = gradleDependenciesIn(text, content, open + 1, close, '', members)
    if (parsed.deps.length > 0 || parsed.unsupported) return true
  }
  return false
}

/**
 * Subproject paths declared by `include` in a Gradle settings file.
 *
 * Both DSLs are common: Groovy's parenthesis-free `include ":app", ":core"` and Kotlin's
 * `include(":app")`, the latter often split across lines when a repository lists its modules. Each
 * declaration is read where it appears, so a second `include` is not dropped, and comments and
 * strings are skipped so a commented-out module is not followed.
 */
function gradleIncludes(text: string): string[] {
  const out: string[] = []
  const source = maskGradleComments(text)
  const n = source.length
  let i = 0
  while (i < n) {
    const ch = source[i] as string
    if (ch === '"' || ch === "'") {
      const quote = ch
      // A raw string is one literal, however many quotes its contents hold. Skipping it as a
      // unit is what keeps an `include` written inside it from declaring a module.
      if (source.startsWith(quote.repeat(3), i)) {
        const close = source.indexOf(quote.repeat(3), i + 3)
        i = close < 0 ? n : close + 3
        continue
      }
      i++
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') i++
        i++
      }
      i++
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i
      while (j < n && /[A-Za-z0-9_]/.test(source[j] as string)) j++
      const word = source.slice(i, j)
      i = j
      if (word !== 'include') continue
      while (i < n && /\s/.test(source[i] as string)) i++
      if (source[i] === '(') {
        i++
        let depth = 1
        while (i < n && depth > 0) {
          const c = source[i] as string
          if (c === '"' || c === "'") {
            const quote = c
            if (source.startsWith(quote.repeat(3), i)) {
              const close = source.indexOf(quote.repeat(3), i + 3)
              i = close < 0 ? n : close + 3
              continue
            }
            i++
            let value = ''
            while (i < n && source[i] !== quote) {
              if (source[i] === '\\') {
                value += source[i + 1] ?? ''
                i += 2
                continue
              }
              value += source[i]
              i++
            }
            i++
            out.push(value)
            continue
          }
          if (c === '(') depth++
          else if (c === ')') depth--
          i++
        }
        continue
      }
      // Groovy's parenthesis-free form: `include ":app", ":core"`.
      while (i < n && source[i] !== '\n') {
        const c = source[i] as string
        if (c === '"' || c === "'") {
          const quote = c
          if (source.startsWith(quote.repeat(3), i)) {
            const close = source.indexOf(quote.repeat(3), i + 3)
            i = close < 0 ? n : close + 3
            continue
          }
          i++
          let value = ''
          while (i < n && source[i] !== quote && source[i] !== '\n') {
            if (source[i] === '\\') {
              value += source[i + 1] ?? ''
              i += 2
              continue
            }
            value += source[i]
            i++
          }
          if (source[i] === quote) i++
          out.push(value)
          continue
        }
        i++
      }
      continue
    }
    i++
  }
  return out
}

export const jvmDetector: Detector = {
  id: 'jvm',
  title: 'JVM (Gradle / Maven)',
  priority: 60,
  matches: (ctx) =>
    hasFile(ctx, 'build.gradle') ||
    hasFile(ctx, 'build.gradle.kts') ||
    hasFile(ctx, 'pom.xml') ||
    hasFile(ctx, 'settings.gradle') ||
    hasFile(ctx, 'settings.gradle.kts'),
  detect(ctx, draft) {
    const gradleFiles = ['build.gradle.kts', 'build.gradle', 'settings.gradle.kts', 'settings.gradle'].filter((f) =>
      hasFile(ctx, f),
    )
    const maven = hasFile(ctx, 'pom.xml')
    const pomText = maven ? read(ctx, 'pom.xml') : null
    let gradleMembers: string[] = []
    const gradleRemaps = new Map<string, string | null>()

    if (gradleFiles.length > 0) {
      addStack(draft, {
        id: 'gradle',
        version: null,
        evidence: [gradleFiles[0] as string],
      })
      const { cmd, wrapper } = gradlew(ctx)
      setMonorepo(draft, {
        tool: 'gradle',
        evidence: gradleFiles[0] as string,
        members: [],
      })

      addCommand(draft, 'build', {
        cmd: `${cmd} build`,
        source: wrapper ? 'detected' : 'inferred',
      })
      addCommand(draft, 'test', {
        cmd: `${cmd} test`,
        source: wrapper ? 'detected' : 'inferred',
      })
      // A changed-files test subset needs a task the project actually defines; without one
      // this is a genuine readiness gap, which the TEST_FAST rule should report.
      //
      // It used to emit `./gradlew test --tests '*Changed'` whenever the wrapper was
      // committed, which is how okhttp, spring-petclinic and nowinandroid were all reported
      // as having a documented fast subset. None of them defines a `*Changed` task: the
      // command selects zero tests and Gradle fails it. A committed wrapper says the build
      // is reproducible and nothing whatsoever about which tasks exist.
      const changedTask = gradleChangedTestTask(ctx, gradleFiles)
      if (changedTask !== null && hasFile(ctx, 'gradlew')) {
        addCommand(draft, 'testFast', {
          cmd: `./gradlew ${changedTask.name}`,
          source: 'detected',
          evidence: evidence(changedTask.file, changedTask.line),
        })
      }

      // Subprojects from settings.gradle `include(...)`. Every declaration counts: a project
      // lists `include(":core")` and `include(":api")` on separate lines, or spells them as one
      // multiline call, and the Spring probe below only visits the modules collected here.
      const settings = gradleFiles.find((f) => f.startsWith('settings.gradle'))
      if (settings !== undefined) {
        const text = read(ctx, settings)
        if (text !== null) {
          const settingsPath = ctx.resolve(settings)
          const settingsDir = settingsPath.includes('/') ? settingsPath.slice(0, settingsPath.lastIndexOf('/')) : ''
          const remaps = gradleProjectDirs(text, settingsDir)
          // Membership, module ids and build-file paths all use the same canonical `:a:b` form.
          // Without this, `include("api")` reports `api` in the workspace but `:api` in the graph.
          const members = gradleIncludes(text).map(gradlePath)
          const ids = new Set(members)
          // A project's directory defaults to the path implied by its Gradle id, relative to the
          // settings file. A computed projectDir is unknown: do not fall back to the default path,
          // which may name a decoy outside this build.
          const directories = new Map<string, string | null>()
          for (const id of members) {
            const declared = id.replace(/^:+/, '').replace(/:/g, '/')
            const dir = remaps.has(id) ? (remaps.get(id) ?? null) : posix.join(settingsDir, declared)
            directories.set(id, dir === null ? null : posix.normalize(dir).replace(/^\.\//, '').replace(/\/+$/, ''))
          }
          for (const [id, dir] of directories) {
            addModule(draft, { id, path: dir ?? '', kind: 'project', deps: [] })
          }
          // Gradle evaluates exactly one script per project. When both DSL variants exist, or a
          // computed buildFileName is used, the chosen script cannot be determined safely.
          const scriptSelection = gradleBuildFileNameSelection(text)
          const buildFileNames = scriptSelection.names
          const chooseScript = (dir: string | null, id: string): { file: string | undefined; ambiguous: boolean } => {
            if (dir === null) return { file: undefined, ambiguous: true }
            // The project directory may be nested under the detected root; resolve every probe
            // through the detector context rather than assuming repository-root paths.
            const has = (file: string): boolean => ctx.files.has(ctx.resolve(file))
            const resolve = (file: string): string => ctx.resolve(file)
            const prefix = dir === '' || dir === '.' ? '' : `${dir}/`
            const explicit = buildFileNames.get(id)
            if (explicit === null) return { file: undefined, ambiguous: true }
            if (explicit !== undefined) {
              const file = `${prefix}${explicit}`
              return has(file) ? { file: resolve(file), ambiguous: false } : { file: undefined, ambiguous: true }
            }
            const candidates = ['build.gradle.kts', 'build.gradle'].map((name) => `${prefix}${name}`).filter(has)
            if (candidates.length > 1) return { file: undefined, ambiguous: true }
            return { file: candidates[0] === undefined ? undefined : resolve(candidates[0]), ambiguous: false }
          }
          const rootChoice = chooseScript('', '')
          const effectiveScripts = new Set<string>()
          if (rootChoice.file !== undefined) effectiveScripts.add(rootChoice.file)
          const choices = new Map<string, ReturnType<typeof chooseScript>>()
          for (const [id, dir] of directories) {
            const choice = chooseScript(dir, id)
            choices.set(id, choice)
            if (choice.file !== undefined) effectiveScripts.add(choice.file)
          }
          // If any custom-script write was seen, no script can be trusted; do not even read them.
          const buildTexts = scriptSelection.ambiguous
            ? []
            : [...effectiveScripts]
                .sort()
                .map((file) => read(ctx, file))
                .filter((value): value is string => value !== null)
          // A wide or computed selector can add dependencies to an unknown set of modules, so no
          // module's empty list can be trusted in that case.
          const rootWide =
            scriptSelection.ambiguous ||
            buildTexts.some((body) => gradleRootWideProjectDeps(body, ids) || gradleRootComputedProjectSelector(body))
          // An unresolved script for any project can configure any other project, so every
          // member's dependency list becomes untrustworthy.
          const scriptAmbiguous =
            rootChoice.ambiguous ||
            [...directories].filter(([, dir]) => dir !== null).some(([id]) => choices.get(id)?.ambiguous === true)
          for (const [id, dir] of directories) {
            const deps = new Set<string>()
            const choice = choices.get(id) ?? { file: undefined, ambiguous: true }
            let unsupported = rootWide || scriptAmbiguous || (dir !== null && choice.ambiguous)
            let ownReadable = false
            if (!scriptSelection.ambiguous && choice.file !== undefined) {
              const body = read(ctx, choice.file)
              if (body !== null) {
                ownReadable = true
                const resolved = gradleProjectDependencies(body, ids, id)
                for (const dep of resolved.deps) deps.add(dep)
                unsupported ||= resolved.unsupported
              }
            }
            for (const body of buildTexts) {
              const fromBlock = gradleProjectDependencies(body, ids, id, false)
              for (const dep of fromBlock.deps) deps.add(dep)
              unsupported ||= fromBlock.unsupported
            }
            if (unsupported) {
              draft.depsUnknownReasons.set(id, 'unsupported Gradle dependency syntax; dependencies left unknown')
              continue
            }
            const existing = draft.modules.find((module) => module.id === id)
            if (existing !== undefined) existing.deps = [...deps].sort()
            if (ownReadable) markDepsAnalysed(draft, id)
          }
          if (draft.monorepo !== null) draft.monorepo.members = members
          gradleMembers = members
          for (const [id, dir] of directories) gradleRemaps.set(id, dir)
        }
      }
      if (!wrapper) {
        // Worth surfacing: without the wrapper the build is not reproducible.
        addStack(draft, {
          id: 'gradle-no-wrapper',
          version: null,
          evidence: ['(gradlew absent)'],
        })
      }

      // Tooling applied by a Gradle plugin. The task each plugin contributes is what makes
      // the command runnable, so the tool and the command are recorded together.
      const buildFiles = [...ctx.files].filter((f) => /(^|\/)build\.gradle(?:\.kts)?$/.test(f))
      const source = wrapper ? 'detected' : 'inferred'
      const detekt = gradlePluginFile(ctx, buildFiles, /(?:io\.gitlab\.arturbosch\.detekt|libs\.plugins\.detekt)\b/)
      if (detekt !== null) {
        addTool(draft, 'lint', 'detekt')
        addCommand(draft, 'lint', { cmd: `${cmd} detekt`, source, evidence: detekt })
      }
      const spotless = gradlePluginFile(ctx, buildFiles, /(?:com\.diffplug\.spotless|libs\.plugins\.spotless)\b/)
      if (spotless !== null) {
        addTool(draft, 'formatter', 'spotless')
        addCommand(draft, 'format', { cmd: `${cmd} spotlessCheck`, source, evidence: spotless })
      }
      const ktlint = gradlePluginFile(ctx, buildFiles, /(?:org\.jlleitschuh\.gradle\.ktlint|libs\.plugins\.ktlint)\b/)
      if (ktlint !== null) {
        addTool(draft, 'lint', 'ktlint')
        addTool(draft, 'formatter', 'ktlint')
        addCommand(draft, 'lint', { cmd: `${cmd} ktlintCheck`, source, evidence: ktlint })
        addCommand(draft, 'format', { cmd: `${cmd} ktlintFormat`, source, evidence: ktlint })
      }
      const checkstyle = gradlePluginFile(ctx, buildFiles, /\bcheckstyle\b/)
      if (checkstyle !== null) {
        addTool(draft, 'lint', 'checkstyle')
        addCommand(draft, 'lint', { cmd: `${cmd} checkstyleMain`, source, evidence: checkstyle })
      }
    }

    if (maven) {
      addStack(draft, { id: 'maven', version: null, evidence: ['pom.xml'] })
      const mvn = hasFile(ctx, 'mvnw') ? './mvnw' : 'mvn'
      addCommand(draft, 'build', {
        cmd: `${mvn} -q package -DskipTests`,
        source: hasFile(ctx, 'mvnw') ? 'detected' : 'inferred',
      })
      addCommand(draft, 'test', {
        cmd: `${mvn} -q test`,
        source: hasFile(ctx, 'mvnw') ? 'detected' : 'inferred',
      })
      // Maven has no changed-files filter of its own. Surefire's `-Dtest` takes a *name
      // pattern*, so `-Dit.test=*Changed*` presumes this project renames the tests it cares
      // about -- and `it.test` is failsafe's property, not surefire's, so it is the wrong
      // flag for `mvn test` besides. Only a plugin that genuinely selects by changed file
      // counts as evidence, because that is the thing the command would be invoking.
      const mavenSubset = /buildmate|git-diff|changed-files|changedfiles/i.test(pomText ?? '') && hasFile(ctx, 'mvnw')
      if (mavenSubset) {
        addCommand(draft, 'testFast', {
          cmd: `${mvn} test -Dtest='*Changed*'`,
          source: 'inferred',
        })
      }
      setMonorepo(draft, { tool: 'maven', evidence: 'pom.xml', members: [] })
    }

    // Spring Boot is a framework on top of the build, and the marker is the starter it pulls in.
    // A plain JVM project that happens to be a web service is not a Spring project: the framework's
    // conventions -- auto-configuration, the application context, the request lifecycle -- are not
    // inferable from `build.gradle`.
    //
    // A Maven reactor's parent POM usually declares only `<modules>`; the starter is in a module.
    // Following the reactor is what makes `api/pom.xml` evidence, with its real path.
    const springFiles = new Set<string>()
    if (maven) {
      for (const file of mavenReactorPoms(ctx, ctx.resolve('pom.xml'))) springFiles.add(file)
    }
    // Only the detected Gradle build and the subprojects it declares. Scanning every
    // `build.gradle` in the tree lets an unreferenced `examples/` build add Spring guidance to a
    // Maven project that never builds it.
    if (gradleFiles.length > 0) {
      for (const name of ['build.gradle', 'build.gradle.kts']) {
        if (hasFile(ctx, name)) springFiles.add(ctx.resolve(name))
      }
      for (const member of gradleMembers) {
        const remap = gradleRemaps.get(gradlePath(member))
        // The project's directory was remapped to a computed value, so it is unknown. Probing the
        // declared path could read a directory the build never uses.
        if (remap === null) continue
        const path = remap ?? member.replace(/^:+/, '').replace(/:/g, '/')
        for (const name of [`${path}/build.gradle`, `${path}/build.gradle.kts`]) {
          if (ctx.files.has(ctx.resolve(name))) springFiles.add(ctx.resolve(name))
        }
      }
    }
    for (const file of springFiles) {
      const text = read(ctx, file)
      if (text === null) continue
      // A commented-out plugin is not applied. POMs use XML comments and Gradle build files use
      // `//`/`/* */`, so each is masked before the marker is looked for; line numbers survive.
      const content = file.endsWith('.xml') ? maskXmlComments(text) : maskGradleComments(text)
      const line = findLine(content, /spring-boot-starter|org\.springframework\.boot/)
      if (line === null) continue
      addStack(draft, { id: 'spring-boot', version: null, evidence: [evidence(file, line)] })
      break
    }

    for (const f of ctx.files) {
      if (f.startsWith('.github/workflows/') && f.endsWith('.yml')) addTool(draft, 'ci', f)
    }
    if (hasFile(ctx, 'config/spotless') || hasFile(ctx, 'spotless.gradle') || hasFile(ctx, 'spotless.gradle.kts')) {
      addTool(draft, 'formatter', 'spotless')
    }
    if (hasFile(ctx, 'config/checkstyle') || hasFile(ctx, 'checkstyle.xml')) addTool(draft, 'lint', 'checkstyle')
  },
}

// ---------------------------------------------------------------------------
// .NET
// ---------------------------------------------------------------------------

export const dotnetDetector: Detector = {
  id: 'dotnet',
  title: '.NET',
  priority: 50,
  matches: (ctx) =>
    filesUnder(ctx, '').some((f) => f.endsWith('.csproj') || f.endsWith('.fsproj')) || hasFile(ctx, 'global.json'),
  detect(ctx, draft) {
    const projects = filesUnder(ctx, '').filter((f) => f.endsWith('.csproj') || f.endsWith('.fsproj'))
    addStack(draft, {
      id: 'dotnet',
      version: null,
      evidence: [projects[0] ?? 'global.json'],
    })

    for (const p of projects) {
      const dir = p.slice(0, p.lastIndexOf('/') + 1) || '.'
      const id = p.replace(/\.(cs|fs)proj$/, '').replace(/\//g, ':')
      addModule(draft, { id, path: dir, kind: 'project', deps: [] })
    }

    // ASP.NET Core is a .NET workload with its own SDK marker. A plain .NET project is not a web
    // application, and the framework's guidance -- middleware order, the request pipeline, the
    // hosting model -- does not apply to a console app.
    for (const p of projects) {
      const text = read(ctx, p)
      if (text === null) continue
      const line = findLine(text, /Microsoft\.NET\.Sdk\.Web/i)
      if (line === null) continue
      addStack(draft, { id: 'aspnet', version: null, evidence: [evidence(p, line)] })
      break
    }

    if (hasFile(ctx, 'global.json')) {
      setMonorepo(draft, { tool: 'sln', evidence: 'global.json', members: [] })
    }

    addCommand(draft, 'build', { cmd: 'dotnet build', source: 'inferred' })
    addCommand(draft, 'test', { cmd: 'dotnet test', source: 'inferred' })
    if (hasFile(ctx, 'Directory.Build.props') || hasFile(ctx, '.editorconfig')) {
      addTool(draft, 'formatter', 'dotnet format')
    }
    for (const f of ctx.files) {
      if (f.startsWith('.github/workflows/') && f.endsWith('.yml')) addTool(draft, 'ci', f)
    }
  },
}

export const ecosystemDetectors: readonly Detector[] = [
  jvmDetector,
  androidDetector,
  kotlinMultiplatformDetector,
  nodeDetector,
  pythonDetector,
  goDetector,
  rustDetector,
  dotnetDetector,
]
