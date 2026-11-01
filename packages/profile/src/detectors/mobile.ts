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
import { asObject, asString, evidence, findLine, looseVersion, readJson } from '../manifest.ts'
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
  matches: (ctx) => hasFile(ctx, 'package.json'),
  detect(ctx, draft) {
    const manifest = readJson(ctx, 'package.json')
    const text = read(ctx, 'package.json')
    if (manifest === null || text === null) return
    const deps = { ...asObject(manifest.dependencies ?? null), ...asObject(manifest.devDependencies ?? null) }

    if ('react-native' in deps || 'expo' in deps) {
      addStack(draft, {
        id: 'react-native',
        version: looseVersion(asString(deps['react-native'] ?? deps.expo ?? null)),
        evidence: [evidence('package.json', findLine(text, /"react-native"\s*:|"expo"\s*:/))],
      })
    }

    // Expo is a stack of its own: a managed Expo app has no native project to detect, so the
    // dependency (or the `expo` key in `app.json`) is the only evidence it exists.
    const expoConfig = EXPO_CONFIGS.find((f) => hasFile(ctx, f))
    const expoInConfig = expoConfig !== undefined && /"expo"\s*:/.test(read(ctx, expoConfig) ?? '')
    if ('expo' in deps || expoInConfig) {
      const where = 'expo' in deps ? evidence('package.json', findLine(text, /"expo"\s*:/)) : (expoConfig as string)
      addStack(draft, { id: 'expo', version: looseVersion(asString(deps.expo ?? null)), evidence: [where] })
    }
  },
}

/** `<UseMaui>true</UseMaui>`, the `Microsoft.Maui` SDK, or a `MauiProgram` entry point. */
const MAUI_MARKER = /<UseMaui>\s*true\s*<\/UseMaui>|Microsoft\.Maui|MauiProgram/

export const mauiDetector: Detector = {
  id: 'maui',
  title: '.NET MAUI',
  priority: 52,
  matches: (ctx) => filesUnder(ctx, '').some((f) => f.endsWith('.csproj')),
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
  },
}

export const mobileDetectors: readonly Detector[] = [flutterDetector, reactNativeDetector, mauiDetector]
