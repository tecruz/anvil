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
import { asString, evidence, findLine, looseVersion } from '../manifest.ts'
import { applicationManifests, firstNamedFile } from '../packageManifests.ts'
import { readText } from '../walk.ts'

function read(ctx: DetectorContext, rel: string): string | null {
  return readText(join(ctx.root, ctx.resolve(rel))).text
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
    for (const manifest of applicationManifests(ctx)) {
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

    const expoConfig = firstNamedFile(ctx, EXPO_CONFIGS)
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
 * enables the workload (`<UseMaui>true</UseMaui>`), uses the MAUI SDK, or has the `MauiProgram`
 * entry point the workload requires.
 */
const MAUI_MARKER = /<UseMaui>\s*true\s*<\/UseMaui>|<Project[^>]*Sdk\s*=\s*["'][^"']*Microsoft\.Maui\.Sdk|MauiProgram/

export const mauiDetector: Detector = {
  id: 'maui',
  title: '.NET MAUI',
  priority: 52,
  matches: (ctx) => filesUnder(ctx, '').some((f) => f.endsWith('.csproj') || f.endsWith('.cs')),
  detect(ctx, draft) {
    for (const file of filesUnder(ctx, '').filter((f) => f.endsWith('.csproj'))) {
      const text = read(ctx, file)
      if (text === null) continue
      const line = findLine(text, MAUI_MARKER)
      if (line === null) continue
      // No build/test command: MAUI is a .NET workload, and the `dotnet` detector already emits
      // the `dotnet build` / `dotnet test` the SDK provides.
      addStack(draft, { id: 'maui', version: null, evidence: [evidence(file, line)] })
      return
    }

    // `MauiProgram` is the entry point the workload generates into a `.cs` file, so a project
    // that only enables the workload through it has no marker in the csproj at all.
    for (const file of filesUnder(ctx, '').filter((f) => f.endsWith('.cs'))) {
      const text = read(ctx, file)
      if (text === null) continue
      const line = findLine(text, /\bMauiProgram\b/)
      if (line === null) continue
      addStack(draft, { id: 'maui', version: null, evidence: [evidence(file, line)] })
      return
    }
  },
}

export const mobileDetectors: readonly Detector[] = [flutterDetector, reactNativeDetector, mauiDetector]
