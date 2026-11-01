/**
 * Cross-technology check: mobile layouts.
 *
 * The repository already proves attribution works across eight server-side ecosystems on
 * real clones. Mobile is the shape none of those exercises:
 *
 *   - the same repository is often two platforms at once (one Android manifest, one iOS
 *     shell), so `plan` has to speak about both without merging them into one story;
 *   - a cross-platform framework (Flutter, React Native, .NET MAUI) hides the native code,
 *     so the platform detector sees nothing and the framework is what should name the tools;
 *   - a Gradle build looks like an Android build without being one (a plain JVM project and
 *     a Kotlin Multiplatform module are the two real cases).
 *
 * The behaviour is pinned by blocking tests: a regression fails CI. The cases that once failed
 * started life as `todo` reproducers while the defect was open; they are now real assertions.
 * Fixtures are real directories on disk, not in-memory stubs, so the walk, the manifest readers
 * and the glob matcher are all exercised for real. Nothing is executed: the check is
 * `profile` -> `plan` -> `brief`, exactly the deterministic half of the pipeline.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { emptyReport } from '@anvil/audit'
import { buildBrief } from '@anvil/derive'
import { buildPlan, loadBuiltins, matchPlaybooks, type Suggestion } from '@anvil/playbooks'
import { buildProfile, matchesGlob, type ProjectProfile } from '@anvil/profile'

const temps: string[] = []
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

/** A disposable repository holding exactly these files. */
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'anvil-mobile-'))
  temps.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, ...rel.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return dir
}

interface Analyzed {
  profile: ProjectProfile
  matches: ReturnType<typeof matchPlaybooks>
  plan: ReturnType<typeof buildPlan>
  brief: ReturnType<typeof buildBrief>
  ids: string[]
}

/**
 * Run the deterministic pipeline over a fixture, exactly as `anvil plan` and `anvil brief`
 * do, against one shared profile so the two can be compared.
 */
function analyze(files: Record<string, string>): Analyzed {
  const dir = repo(files)
  const profile = buildProfile(dir, { root: dir, host: null, remote: null, defaultBranch: null }).profile
  const matches = matchPlaybooks(profile, loadBuiltins().playbooks)
  const report = emptyReport()
  const plan = buildPlan(report, profile, matches)
  const brief = buildBrief({ profile, report, matches, target: 'all', read: (p) => files[p] ?? null })
  return { profile, matches, plan, brief, ids: matches.map((m) => m.playbook.id) }
}

const MANIFEST = '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application /></manifest>\n'

/** An Android application module, in the layout the Android tooling actually writes. */
const ANDROID_APP: Record<string, string> = {
  gradlew: '',
  'settings.gradle.kts': 'include(":app")\n',
  'build.gradle.kts': 'plugins { id("com.android.application") version "8.9.0" apply false }\n',
  'app/build.gradle.kts': 'plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }\n',
  'app/src/main/AndroidManifest.xml': MANIFEST,
  'app/src/main/MainActivity.kt':
    'package com.example\n\nimport androidx.compose.runtime.Composable\n\n@Composable\nfun App() {}\n',
}

/** The iOS shell a cross-platform project commits: an Xcode project and a Podfile. */
const IOS_SHELL: Record<string, string> = {
  'ios/Runner.xcodeproj/project.pbxproj': '// !$*UTF8*$!\n{ objects = {}; }\n',
  'ios/Runner/AppDelegate.swift': 'import UIKit\nclass AppDelegate {}\n',
  'ios/Podfile': "platform :ios, '16.0'\n",
}

const validTrust = new Set(['official-publisher', 'local-install', 'third-party'])

/** True when a technology is a detected stack or a matched playbook. */
function detected(a: Analyzed, id: string): boolean {
  return a.profile.stacks.some((s) => s.id === id) || a.ids.includes(id)
}

/** The invariants that must hold for any fixture, mobile or not. */
function assertPlanInvariants(a: Analyzed, label: string): void {
  assert.deepEqual(
    a.brief.playbooks.map((p) => p.id),
    a.ids,
    `${label}: the brief and the plan must agree on which playbooks matched`,
  )
  for (const s of a.plan.suggestions) {
    if (s.external !== true) continue
    assert.ok(
      s.trust !== undefined && validTrust.has(s.trust),
      `${label}: external suggestion "${s.title}" has no publisher evidence`,
    )
  }
  assert.deepEqual(
    buildPlan(emptyReport(), a.profile, a.matches),
    a.plan,
    `${label}: the plan must be deterministic across two runs`,
  )
}

function externalWithTrust(plan: ReturnType<typeof buildPlan>, trust: Suggestion['trust']): Suggestion[] {
  return plan.suggestions.filter((s) => s.external === true && s.trust === trust)
}

describe('mobile layouts the tool handles today', () => {
  test('an Android app matches android and jvm, with no unattributed resource', () => {
    const a = analyze(ANDROID_APP)

    assert.ok(a.ids.includes('android'), `android should match; got ${a.ids.join(', ')}`)
    assert.ok(a.ids.includes('jvm'), 'an Android Gradle build is also a JVM build')
    assert.equal(a.profile.stacks.find((s) => s.id === 'gradle') !== undefined, true)

    assertPlanInvariants(a, 'android-compose')

    // The publisher is read from the URL, and developer.android.com is a declared domain.
    assert.ok(
      externalWithTrust(a.plan, 'official-publisher').some((s) =>
        (s.url ?? '').startsWith('https://developer.android.com/'),
      ),
      'Android documentation should be labelled as first-party',
    )
  })

  test('an Android app in Groovy DSL matches the same playbooks', () => {
    const a = analyze({
      gradlew: '',
      'settings.gradle': 'include ":app"\n',
      'build.gradle': 'plugins { id "com.android.application" version "8.9.0" apply false }\n',
      'app/build.gradle': 'plugins { id "com.android.application" }\n',
      'app/src/main/AndroidManifest.xml': MANIFEST,
      'app/src/main/MainActivity.java':
        'package com.example;\n\nimport android.app.Activity;\n\npublic class MainActivity extends Activity {}\n',
    })

    assert.ok(a.ids.includes('android'), `got ${a.ids.join(', ')}`)
    assert.ok(a.ids.includes('jvm'))
    assertPlanInvariants(a, 'android-views')
  })

  test('a SwiftPM package matches swift and records its real commands', () => {
    const a = analyze({
      'Package.swift': '// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: "App")\n',
      'Sources/App.swift': 'import SwiftUI\nstruct App {}\n',
      'Tests/AppTests.swift': 'import XCTest\nfinal class AppTests: XCTestCase {}\n',
    })

    assert.deepEqual(a.ids, ['swift'])
    assertPlanInvariants(a, 'ios-swiftpm')

    // The commands carry evidence: they are the toolchain's own subcommands, named by the
    // manifest that exists in the repository.
    const build = a.profile.commands.build?.[0]
    assert.equal(build?.cmd, 'swift build')
    assert.equal(build?.source, 'detected')
    assert.equal(build?.evidence, 'Package.swift')
  })

  test('a Swift package with native shells matches swift once, and ios too', () => {
    const a = analyze({
      'Package.swift': '// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: "App")\n',
      'Sources/App.swift': 'import SwiftUI\nstruct App {}\n',
      ...IOS_SHELL,
    })

    assert.equal(a.ids.filter((id) => id === 'swift').length, 1, 'the SwiftPM package is one playbook')
    assert.ok(a.ids.includes('ios'), 'the committed Xcode project and Podfile are the ios playbook')
    assertPlanInvariants(a, 'ios-native-shells')
  })
})

describe('non-mobile controls must not drift into mobile guidance', () => {
  test('a plain JVM Gradle project is jvm, and not android', () => {
    // The Spring Petclinic shape: a Gradle Java build. It shares the build system with Android
    // and shares nothing else, so offering it Compose guidance is confident and wrong.
    const a = analyze({
      gradlew: '',
      'build.gradle': 'plugins { id "java" }\n',
      'src/main/App.java': 'public class App {}\n',
    })
    assert.ok(a.ids.includes('jvm'), `got ${a.ids.join(', ')}`)
    assert.ok(!a.ids.includes('android'), `a Gradle Java build matched android: ${a.ids.join(', ')}`)
    assertPlanInvariants(a, 'control-jvm-groovy')
  })

  test('a Kotlin Multiplatform module without an Android target is not android', () => {
    const a = analyze({
      gradlew: '',
      'settings.gradle.kts': 'rootProject.name = "Shared"\n',
      'build.gradle.kts':
        'plugins { kotlin("multiplatform") version "2.1.0" }\nkotlin { jvm(); iosArm64(); iosSimulatorArm64() }\n',
      'src/commonMain/kotlin/Shared.kt': 'class Shared\n',
    })
    assert.ok(!a.ids.includes('android'), `KMP matched android: ${a.ids.join(', ')}`)
    assert.ok(
      a.profile.stacks.some((s) => s.id === 'kotlin-multiplatform'),
      'the KMP targets are a stack, so the repository is not left unidentified',
    )
    assertPlanInvariants(a, 'control-kmp')
  })

  test('a Swift server package is not offered iOS-only advice', () => {
    const a = analyze({
      'Package.swift':
        '// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: "Server")\n',
      'Sources/Server.swift': 'import Foundation\nprint("server")\n',
    })
    assert.deepEqual(a.ids, ['swift'])
    assert.ok(!a.ids.includes('android'))
    assertPlanInvariants(a, 'control-swift-server')
  })

  test('a React web app is node, and never android or swift', () => {
    const a = analyze({
      'package.json': JSON.stringify({
        name: 'web',
        dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
        scripts: { build: 'vite build', test: 'vitest run' },
      }),
      'src/App.tsx': 'export default function App() { return null }\n',
    })
    assert.ok(a.ids.includes('node'))
    assert.ok(!a.ids.includes('android') && !a.ids.includes('swift'))
    assertPlanInvariants(a, 'control-react-web')

    // A resource filed under `official.mcp` is still attributed by its URL: Context7 is
    // hosted by upstash, which is not one of the node playbook's seeds.
    const context7 = a.plan.suggestions.find((s) => (s.url ?? '').includes('upstash/context7'))
    assert.equal(context7?.trust, 'third-party')
  })

  test('a plain .NET project is dotnet, and never swift', () => {
    const a = analyze({
      'App.csproj':
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>\n',
      'Program.cs': 'System.Console.WriteLine("server");\n',
    })
    assert.ok(a.ids.includes('dotnet'))
    assert.ok(!a.ids.includes('swift'))
    assertPlanInvariants(a, 'control-dotnet-console')
  })
})

// ===========================================================================
// The gaps this check found, now fixed. Each of these was a `todo` reproducer
// while the defect was open; they are blocking assertions now.
// ===========================================================================

describe('the cross-technology gaps are closed', () => {
  test('a recursive glob matches a pattern at any depth', () => {
    // Found with a real Android repository, whose manifest lives at
    // `app/src/main/AndroidManifest.xml`. The matcher used to turn `**/` into an optional
    // *single* segment, so anything two levels deep was invisible to every `**/` pattern.
    assert.equal(matchesGlob('app/src/main/AndroidManifest.xml', '**/AndroidManifest.xml'), true)
    assert.equal(matchesGlob('apps/mobile/ios/App/Info.plist', '**/Info.plist'), true)
    assert.equal(matchesGlob('.maestro/flows/login.yaml', '**/.maestro/**'), true)
    assert.equal(matchesGlob('apps/mobile/e2e/wdio.conf.ts', '**/wdio.conf.*'), true)
  })

  test('an Xcode-only app is a stack, and is not offered SwiftPM commands', () => {
    const a = analyze({
      'App.xcodeproj/project.pbxproj': '// !$*UTF8*$!\n{ objects = {}; }\n',
      'App/App.swift': 'import SwiftUI\nstruct App {}\n',
      'App/Info.plist': '<plist />\n',
    })

    assert.ok(
      a.profile.stacks.some((s) => s.id === 'xcode'),
      `expected an xcode stack; stacks=${a.profile.stacks.map((s) => s.id).join(',')}`,
    )
    assert.ok(a.ids.includes('ios'), `expected the ios playbook; got ${a.ids.join(', ')}`)
    assert.ok(!a.ids.includes('swift'), 'an Xcode app is not a SwiftPM package')
    // `swift build` / `swift test` need a Package.swift this repository does not have.
    const swiftpm = a.plan.suggestions.filter(
      (s) => s.id.startsWith('verify:swift:') && /swift (build|test)/.test(s.detail),
    )
    assert.deepEqual(swiftpm, [], 'SwiftPM commands must not be offered without a Package.swift')
    assertPlanInvariants(a, 'ios-xcode-only')
  })

  test('a Flutter project is detected and guided', () => {
    const a = analyze({
      'pubspec.yaml': 'name: mobile_app\nenvironment:\n  sdk: ^3.5.0\ndependencies:\n  flutter:\n    sdk: flutter\n',
      'lib/main.dart': "import 'package:flutter/material.dart';\nvoid main() {}\n",
      'AGENTS.md': 'Run `flutter analyze` and `flutter test`.\n',
    })
    assert.ok(detected(a, 'flutter'), `Flutter left no trace: ${a.ids.join(',')}`)
    assert.equal(a.profile.commands.test?.[0]?.cmd, 'flutter test')
    assert.equal(a.profile.commands.lint?.[0]?.cmd, 'flutter analyze')
    assertPlanInvariants(a, 'flutter')
  })

  test('a React Native project is detected and guided beyond generic node', () => {
    const a = analyze({
      'package.json': JSON.stringify({
        name: 'mobile',
        dependencies: { 'react-native': '0.79.0', react: '19.0.0' },
      }),
      'App.tsx': 'import { View } from "react-native"\nexport default View\n',
      ...ANDROID_APP,
      ...IOS_SHELL,
    })
    assert.ok(detected(a, 'react-native'), `React Native left no trace: ${a.ids.join(',')}`)
    // The native shells are still seen, so the plan speaks about both platforms.
    assert.ok(a.profile.stacks.some((s) => s.id === 'android'))
    assertPlanInvariants(a, 'react-native')
  })

  test('a managed Expo app is detected without any native project', () => {
    const a = analyze({
      'package.json': JSON.stringify({
        name: 'mobile',
        dependencies: { expo: '~53.0.0', 'react-native': '0.79.0', react: '19.0.0' },
        scripts: { test: 'jest' },
      }),
      'app.json': JSON.stringify({ expo: { name: 'Probe', slug: 'probe' } }),
      'app/index.tsx': 'export default function App() { return null }\n',
    })
    assert.ok(
      a.profile.stacks.some((s) => s.id === 'expo'),
      'the expo stack is the only platform signal',
    )
    assert.ok(detected(a, 'react-native'), `got ${a.ids.join(', ')}`)
    assertPlanInvariants(a, 'expo-managed')
  })

  test('a .NET MAUI project is detected and guided beyond generic dotnet', () => {
    const a = analyze({
      'App.csproj':
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFrameworks>net10.0-android;net10.0-ios</TargetFrameworks><UseMaui>true</UseMaui></PropertyGroup></Project>\n',
      'MauiProgram.cs': 'using Microsoft.Maui;\nclass MauiProgram {}\n',
      'Platforms/Android/AndroidManifest.xml': MANIFEST,
    })
    assert.ok(
      a.profile.stacks.some((s) => s.id === 'maui'),
      `stacks=${a.profile.stacks.map((s) => s.id).join(',')}`,
    )
    assert.ok(detected(a, 'maui'), `got ${a.ids.join(', ')}`)
    assertPlanInvariants(a, 'maui')
  })

  test('Maestro flows nested under .maestro/ match the QA playbooks', () => {
    const a = analyze({ '.maestro/flows/login.yaml': 'appId: com.example.app\n' })
    assert.ok(a.ids.includes('maestro'), `got ${a.ids.join(', ')}`)
    assert.ok(a.ids.includes('qa'))
  })

  test('an Appium/WDIO config in a mobile subdirectory matches webdriverio', () => {
    const a = analyze({ 'apps/mobile/e2e/wdio.conf.ts': 'export const config = {}\n' })
    assert.ok(a.ids.includes('webdriverio'), `got ${a.ids.join(', ')}`)
    assert.ok(a.ids.includes('qa'))
  })

  test('the conventional .detoxrc.js is recognised as a QA signal', () => {
    const a = analyze({ '.detoxrc.js': 'module.exports = {}\n' })
    assert.ok(a.ids.includes('qa'), `got ${a.ids.join(', ')}`)
  })
})
