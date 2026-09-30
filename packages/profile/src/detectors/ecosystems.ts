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

import { join } from 'node:path'
import {
  addCommand,
  addModule,
  addStack,
  addTool,
  type Detector,
  type DetectorContext,
  filesUnder,
  hasFile,
  setMonorepo,
} from '../detector.ts'
import { evidence, findLine } from '../manifest.ts'
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

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

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
      for (const f of ctx.files) {
        if (!f.endsWith('/go.mod')) continue
        const path = f === 'go.mod' ? '.' : f.slice(0, -'/go.mod'.length)
        const inner = read(ctx, f)
        const name = inner === null ? path : (/^module\s+(\S+)/m.exec(inner)?.[1] ?? path)
        addModule(draft, { id: name, path, kind: 'package', deps: [] })
      }
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
      addCommand(draft, 'build', {
        cmd: 'make build',
        source: 'detected',
        evidence: 'Makefile',
      })
    }
  },
}

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

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
      for (const f of ctx.files) {
        if (!f.endsWith('/Cargo.toml')) continue
        const path = f === 'Cargo.toml' ? '.' : f.slice(0, -'/Cargo.toml'.length)
        const inner = read(ctx, f)
        const name = inner === null ? path : (/^\s*name\s*=\s*["']([^"']+)["']/m.exec(inner)?.[1] ?? path)
        addModule(draft, { id: name, path, kind: 'crate', deps: [] })
      }
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
      if (hasFile(ctx, 'gradlew')) {
        addCommand(draft, 'testFast', {
          cmd: `${cmd} test --tests '*Changed'`,
          source: 'inferred',
        })
      }

      // Subprojects from settings.gradle `include(...)`.
      const settings = gradleFiles.find((f) => f.startsWith('settings.gradle'))
      if (settings !== undefined) {
        const text = read(ctx, settings)
        if (text !== null) {
          const inc = /include\s*\(?\s*([^)]*)\)?/m.exec(text)
          if (inc !== null) {
            const members = [...inc[1]!.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1] as string)
            for (const m of members) addModule(draft, { id: m, path: m, kind: 'project', deps: [] })
            if (draft.monorepo !== null) draft.monorepo.members = members
          }
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
      if (hasFile(ctx, 'mvnw'))
        addCommand(draft, 'testFast', {
          cmd: `${mvn} test -Dit.test=*Changed*`,
          source: 'inferred',
        })
      setMonorepo(draft, { tool: 'maven', evidence: 'pom.xml', members: [] })
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
  nodeDetector,
  pythonDetector,
  goDetector,
  rustDetector,
  dotnetDetector,
]
