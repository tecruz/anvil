/**
 * Cross-platform mobile frameworks: Flutter, React Native (and Expo), .NET MAUI.
 *
 * Each shares a base language and toolchain with something else -- Dart with nothing anvil
 * knows, React Native with Node, MAUI with .NET -- and each hides the platform behind a
 * framework, so a repository can be a mobile app with no `AndroidManifest.xml` and no Xcode
 * project at all (a managed Expo app is exactly this). The stack is the framework's own marker:
 * the `flutter` dependency in `pubspec.yaml`, `react-native`/`expo` in `package.json`, and
 * `<UseMaui>` in a csproj.
 *
 * The detections are deliberately narrow. A React *web* app depends on `react` and `react-dom`,
 * never `react-native`, so it must not match; a plain .NET project has no `<UseMaui>`. The
 * negative cases are the point, and they are pinned in `packages/profile/test/detectors.test.ts`.
 */

import { join } from 'node:path'
import { addCommand, addStack, type Detector, type DetectorContext, filesUnder, hasFile } from '../detector.ts'
import { asString, evidence, findLine, looseVersion, maskXmlComments } from '../manifest.ts'
import { applicationManifests, firstNamedFileInDirs, manifestDir } from '../packageManifests.ts'
import { readText } from '../walk.ts'

function read(ctx: DetectorContext, rel: string): string | null {
  return readText(join(ctx.root, ctx.resolve(rel))).text
}

/**
 * Blank C# comments and string/character literals without moving anything.
 *
 * `MauiProgram` appears in prose, in documentation strings, in log messages, and inside the
 * expression of an interpolated string. None of those is the application entry point. Masking
 * walks each literal the way C# tokenizes it -- verbatim, interpolated (including nested literals
 * inside the interpolation) and raw (any number of quotes) -- so a real declaration survives and
 * nothing else does.
 */
function maskCSharp(text: string): string {
  const out = text.split('')
  const blank = (from: number, to: number): void => {
    for (let j = from; j < to; j++) if (out[j] !== '\n') out[j] = ' '
  }

  /** End offset of the interpolation expression that starts just past its opening `{`. */
  function interpolationEnd(start: number): number {
    let depth = 1
    let i = start
    while (i < text.length) {
      const ch = text[i] as string
      if (ch === '"' || ch === "'" || ch === '$' || ch === '@') {
        const end = literalEnd(i)
        if (end !== null) {
          i = end
          continue
        }
      }
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) return i + 1
      }
      i++
    }
    return text.length
  }

  /** End offset of the literal starting at `start`, or null when none starts there. */
  function literalEnd(start: number): number | null {
    let i = start
    let interpolated = false
    let verbatim = false
    while (i < text.length && (text[i] === '$' || text[i] === '@')) {
      if (text[i] === '$') interpolated = true
      else verbatim = true
      i++
    }
    const quote = text[i]
    if (quote !== '"' && quote !== "'") return null
    // A raw string is never verbatim, so `@""""` is an empty escaped-quote verbatim literal,
    // not a raw string with a four-quote delimiter.
    if (quote === '"' && !verbatim) {
      let quotes = 0
      while (text[i + quotes] === '"') quotes++
      if (quotes >= 3) {
        const delimiter = '"'.repeat(quotes)
        i += quotes
        while (i < text.length && !text.startsWith(delimiter, i)) i++
        return Math.min(text.length, i + quotes)
      }
    }
    if (quote === "'") {
      i++
      while (i < text.length) {
        const ch = text[i] as string
        if (ch === '\\') {
          i += 2
          continue
        }
        if (ch === "'") return i + 1
        i++
      }
      return text.length
    }
    i++
    while (i < text.length) {
      const ch = text[i] as string
      if (interpolated && ch === '{') {
        if (text[i + 1] === '{') {
          i += 2
          continue
        }
        i = interpolationEnd(i + 1)
        continue
      }
      if (interpolated && ch === '}' && text[i + 1] === '}') {
        i += 2
        continue
      }
      if (verbatim) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            i += 2
            continue
          }
          return i + 1
        }
        i++
        continue
      }
      if (ch === '\\') {
        i += 2
        continue
      }
      if (ch === '"') return i + 1
      i++
    }
    return text.length
  }

  let i = 0
  while (i < text.length) {
    const ch = text[i] as string
    if (ch === '/' && text[i + 1] === '/') {
      const start = i
      while (i < text.length && text[i] !== '\n') i++
      blank(start, i)
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const start = i
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i = Math.min(text.length, i + 2)
      blank(start, i)
      continue
    }
    if (ch === '"' || ch === "'" || ch === '$' || ch === '@') {
      const end = literalEnd(i)
      if (end !== null) {
        blank(i, end)
        i = end
        continue
      }
    }
    i++
  }
  return out.join('')
}

/** The 1-based line an offset falls on. */
function lineOf(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++
  return line
}

/** A `flutter:` (or `flutter_test:`) dependency, or `sdk: flutter` under one. */
const FLUTTER_DEPENDENCY = /^\s*flutter(?:_test)?:\s*$|^\s*sdk:\s*flutter\s*$/m

export const flutterDetector: Detector = {
  id: 'flutter',
  title: 'Flutter',
  priority: 52,
  matches: (ctx) => hasFile(ctx, 'pubspec.yaml'),
  detect(ctx, draft) {
    const pubspec = read(ctx, 'pubspec.yaml')
    if (pubspec === null) return
    const line = findLine(pubspec, FLUTTER_DEPENDENCY)
    if (line === null) return
    addStack(draft, { id: 'flutter', version: null, evidence: [evidence('pubspec.yaml', line)] })

    // Flutter's own subcommands, applicable because the pubspec declares the SDK. `build` has no
    // platform-independent form -- it is `flutter build apk` or `flutter build ios` -- so it is
    // marked inferred and the reader picks.
    addCommand(draft, 'install', { cmd: 'flutter pub get', source: 'detected', evidence: 'pubspec.yaml' })
    addCommand(draft, 'test', { cmd: 'flutter test', source: 'detected', evidence: 'pubspec.yaml' })
    addCommand(draft, 'lint', { cmd: 'flutter analyze', source: 'detected', evidence: 'pubspec.yaml' })
    addCommand(draft, 'build', { cmd: 'flutter build apk', source: 'inferred' })
  },
}

/** Expo's config files, which a managed app ships instead of native projects. */
const EXPO_CONFIGS = ['app.json', 'app.config.js', 'app.config.ts', 'app.config.mjs'] as const

export const reactNativeDetector: Detector = {
  id: 'react-native',
  title: 'React Native / Expo',
  priority: 52,
  matches: (ctx) => filesUnder(ctx, '').some((f) => f === 'package.json' || f.endsWith('/package.json')),
  detect(ctx, draft) {
    const manifests = applicationManifests(ctx)
    const dirs = [...new Set(manifests.map((manifest) => manifestDir(manifest)))]
    for (const manifest of manifests) {
      if ('react-native' in manifest.deps || 'expo' in manifest.deps) {
        addStack(draft, {
          id: 'react-native',
          version: looseVersion(asString(manifest.deps['react-native'] ?? manifest.deps.expo ?? null)),
          evidence: [evidence(manifest.path, findLine(manifest.text, /"react-native"\s*:|"expo"\s*:/))],
        })
      }

      // Expo is a stack of its own: a managed Expo app has no native project to detect, so the
      // dependency (or the `expo` key in `app.json`) is the only evidence it exists.
      if ('expo' in manifest.deps) {
        addStack(draft, {
          id: 'expo',
          version: looseVersion(asString(manifest.deps.expo ?? null)),
          evidence: [evidence(manifest.path, findLine(manifest.text, /"expo"\s*:/))],
        })
      }
    }

    const expoConfig = firstNamedFileInDirs(ctx, EXPO_CONFIGS, dirs)
    if (expoConfig !== null && /"expo"\s*:/.test(read(ctx, expoConfig) ?? '')) {
      addStack(draft, { id: 'expo', version: null, evidence: [expoConfig] })
    }
  },
}

/**
 * A MAUI application marker, not just any package whose name starts with `Microsoft.Maui`.
 *
 * `Microsoft.Maui.Graphics` is a drawing library usable from a plain console app, and matching
 * the bare prefix classified exactly that as a MAUI application. A project is MAUI when it
 * enables the workload (`<UseMaui>true</UseMaui>`) or uses the MAUI SDK. The generated
 * `MauiProgram` entry point is handled separately: it must be an actual declaration, not a
 * mention in a comment or a string.
 */
const MAUI_MARKER = /<UseMaui>\s*true\s*<\/UseMaui>|<Project[^>]*Sdk\s*=\s*["'][^"']*Microsoft\.Maui\.Sdk/

/** `class MauiProgram`, `partial class MauiProgram`, `record MauiProgram`, and so on. */
const MAUI_PROGRAM_DECLARATION = /\b(?:class|struct|record(?:\s+(?:class|struct))?)\s+MauiProgram\b/

export const mauiDetector: Detector = {
  id: 'maui',
  title: '.NET MAUI',
  priority: 52,
  matches: (ctx) => filesUnder(ctx, '').some((f) => f.endsWith('.csproj') || f.endsWith('.cs')),
  detect(ctx, draft) {
    for (const file of filesUnder(ctx, '').filter((f) => f.endsWith('.csproj'))) {
      const text = read(ctx, file)
      if (text === null) continue
      const line = findLine(maskXmlComments(text), MAUI_MARKER)
      if (line === null) continue
      // No build/test command: MAUI is a .NET workload, and the `dotnet` detector already emits
      // the `dotnet build` / `dotnet test` the SDK provides.
      addStack(draft, { id: 'maui', version: null, evidence: [evidence(file, line)] })
      return
    }

    // `MauiProgram` is the entry point the workload generates into a `.cs` file, so a project
    // that only enables the workload through it has no marker in the csproj at all. The search
    // spans lines because the keyword and the name may be split (`class\nMauiProgram`).
    for (const file of filesUnder(ctx, '').filter((f) => f.endsWith('.cs'))) {
      const text = read(ctx, file)
      if (text === null) continue
      const match = MAUI_PROGRAM_DECLARATION.exec(maskCSharp(text))
      if (match === null) continue
      addStack(draft, { id: 'maui', version: null, evidence: [evidence(file, lineOf(text, match.index))] })
      return
    }
  },
}

export const mobileDetectors: readonly Detector[] = [flutterDetector, reactNativeDetector, mauiDetector]
