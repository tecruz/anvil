/**
 * Android and Kotlin Multiplatform detection.
 *
 * These exist because the two ecosystems share a build system and a language with plain JVM
 * projects, and the first cut of the `android` match got that wrong: `android.yaml` matched on
 * the `gradle` dependency and a bare `**\/build.gradle.kts`, so *every* Gradle project was an
 * Android project. Spring Petclinic -- a Gradle Java build -- was offered Compose performance
 * guidance, and a Kotlin Multiplatform module with no Android target matched the same way.
 *
 * The fix is a detector that claims Android only on Android evidence: the Android Gradle Plugin
 * id, an `AndroidManifest.xml`, an `android { }` block, or an `android.*` property in
 * `gradle.properties`. The negative tests below are the point of the file -- a false Android
 * match is confident and wrong, which is the failure this tool exists to prevent.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { buildProfile } from '@anvil/profile'

const temps: string[] = []
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'anvil-detectors-'))
  temps.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, ...rel.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return dir
}

/** The stack ids a set of files produces. */
function stacksOf(files: Record<string, string>): string[] {
  const dir = repo(files)
  const { profile } = buildProfile(dir, { root: dir, host: null, remote: null, defaultBranch: null })
  return profile.stacks.map((s) => s.id)
}

function profileOf(files: Record<string, string>) {
  const dir = repo(files)
  return buildProfile(dir, { root: dir, host: null, remote: null, defaultBranch: null }).profile
}

const MANIFEST = '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application /></manifest>\n'

describe('the Android detector claims Android, and only Android', () => {
  test('the Android Gradle Plugin in a module build file is evidence', () => {
    // The Kotlin DSL and the module file: the plugin lives in `app/build.gradle.kts`, and a
    // probe that only read the root missed it.
    const ids = stacksOf({
      gradlew: '',
      'settings.gradle.kts': 'rootProject.name = "app"\ninclude(":app")\n',
      'build.gradle.kts': 'plugins { id("com.android.application") version "8.9.0" apply false }\n',
      'app/build.gradle.kts': 'plugins { id("com.android.application") }\n',
    })
    assert.ok(ids.includes('android'), `expected android in ${ids.join(', ')}`)
  })

  test('the Groovy DSL spelling is evidence too', () => {
    const ids = stacksOf({
      gradlew: '',
      'app/build.gradle': "plugins { id 'com.android.library' }\n",
    })
    assert.ok(ids.includes('android'), `expected android in ${ids.join(', ')}`)
  })

  test('a manifest with no build file at all is evidence', () => {
    const ids = stacksOf({ 'app/src/main/AndroidManifest.xml': MANIFEST })
    assert.ok(ids.includes('android'), `expected android in ${ids.join(', ')}`)
  })

  test('an androidx property in gradle.properties is evidence', () => {
    const ids = stacksOf({
      'gradle.properties': 'android.useAndroidX=true\nandroid.enableJetifier=true\n',
      'build.gradle.kts': 'plugins { id("com.android.application") }\n',
    })
    assert.ok(ids.includes('android'), `expected android in ${ids.join(', ')}`)
  })

  test('a plain JVM Gradle project is NOT Android', () => {
    // The Spring Petclinic shape: `plugins { id 'java' }`, no manifest, no AGP, no androidx.
    const ids = stacksOf({
      gradlew: '',
      'build.gradle': 'plugins { id "java" }\n',
      'src/main/java/com/acme/App.java': 'package com.acme;\npublic class App {}\n',
    })
    assert.ok(!ids.includes('android'), `a Gradle Java build matched android: ${ids.join(', ')}`)
    assert.ok(ids.includes('gradle'), 'it is still a Gradle build')
  })

  test('a Kotlin JVM Gradle project is NOT Android', () => {
    const ids = stacksOf({
      gradlew: '',
      'build.gradle.kts': 'plugins { kotlin("jvm") version "2.1.0" }\n',
      'src/main/kotlin/App.kt': 'class App\n',
    })
    assert.ok(!ids.includes('android'), `Kotlin/JVM matched android: ${ids.join(', ')}`)
  })

  test('the word "android" in prose is not evidence', () => {
    const ids = stacksOf({
      gradlew: '',
      'build.gradle.kts': '// TODO: port this to android eventually\nplugins { kotlin("jvm") }\n',
      'README.md': 'This service will be used by the android client.\n',
    })
    assert.ok(!ids.includes('android'), `prose matched android: ${ids.join(', ')}`)
  })
})

describe('Kotlin Multiplatform is distinct from Android', () => {
  test('a KMP module with no Android target is not Android', () => {
    const ids = stacksOf({
      gradlew: '',
      'settings.gradle.kts': 'rootProject.name = "shared"\n',
      'build.gradle.kts':
        'plugins { kotlin("multiplatform") version "2.1.0" }\nkotlin { jvm(); iosArm64(); iosSimulatorArm64() }\n',
      'src/commonMain/kotlin/Shared.kt': 'class Shared\n',
    })
    assert.ok(!ids.includes('android'), `KMP matched android: ${ids.join(', ')}`)
    assert.ok(ids.includes('kotlin-multiplatform'), `expected the KMP stack, got ${ids.join(', ')}`)
  })

  test('a KMP module targeting Android is both, because it is both', () => {
    const ids = stacksOf({
      gradlew: '',
      'build.gradle.kts':
        'plugins { kotlin("multiplatform") version "2.1.0"; id("com.android.library") }\nkotlin { androidTarget(); iosArm64() }\n',
    })
    assert.ok(ids.includes('kotlin-multiplatform'), `expected KMP in ${ids.join(', ')}`)
    assert.ok(ids.includes('android'), `expected android in ${ids.join(', ')}`)
  })
})

describe('the mobile framework detectors do not overreach', () => {
  test('a React web app is not React Native', () => {
    const ids = stacksOf({
      'package.json': JSON.stringify({ name: 'web', dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' } }),
      'src/App.tsx': 'export default function App() { return null }\n',
    })
    assert.ok(!ids.includes('react-native') && !ids.includes('expo'), ids.join(', '))
  })

  test('a plain .NET project is not MAUI', () => {
    const ids = stacksOf({
      'App.csproj':
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>\n',
      'Program.cs': 'System.Console.WriteLine("x");\n',
    })
    assert.ok(!ids.includes('maui'), ids.join(', '))
  })

  test('a Dart package with no Flutter dependency is not Flutter', () => {
    const ids = stacksOf({
      'pubspec.yaml': 'name: pure_dart\ndependencies:\n  http: ^1.0.0\n',
      'lib/x.dart': 'void main() {}\n',
    })
    assert.ok(!ids.includes('flutter'), ids.join(', '))
  })

  test('a Flutter app is detected through its pubspec', () => {
    const ids = stacksOf({ 'pubspec.yaml': 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n' })
    assert.ok(ids.includes('flutter'), ids.join(', '))
  })

  test('a React Native app is detected from its dependency', () => {
    const ids = stacksOf({
      'package.json': JSON.stringify({ name: 'rn', dependencies: { 'react-native': '0.79.0', react: '19.0.0' } }),
      'App.tsx': 'export default 1\n',
    })
    assert.ok(ids.includes('react-native'), ids.join(', '))
  })

  test('a MAUI project is detected from <UseMaui>', () => {
    const ids = stacksOf({
      'App.csproj':
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFrameworks>net10.0-android;net10.0-ios</TargetFrameworks><UseMaui>true</UseMaui></PropertyGroup></Project>\n',
    })
    assert.ok(ids.includes('maui'), ids.join(', '))
  })

  test('Microsoft.Maui.Graphics alone is not a MAUI application', () => {
    // The drawing library is usable from a plain console app; it does not enable the workload.
    const ids = stacksOf({
      'Console.csproj':
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><PackageReference Include="Microsoft.Maui.Graphics" Version="10.0.0" /></ItemGroup></Project>\n',
    })
    assert.ok(!ids.includes('maui'), ids.join(', '))
  })

  test('the MAUI SDK and a MauiProgram entry point are application evidence', () => {
    assert.ok(
      stacksOf({
        'App.csproj': '<Project Sdk="Microsoft.Maui.Sdk/10.0.0"><PropertyGroup /></Project>\n',
      }).includes('maui'),
    )
    assert.ok(
      stacksOf({
        'App.csproj':
          '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0-android</TargetFramework></PropertyGroup></Project>\n',
        'MauiProgram.cs': 'public static class MauiProgram { }\n',
      }).includes('maui'),
    )
  })

  test('a MauiProgram mention in a comment or string is not an entry point', () => {
    const ids = stacksOf({
      'Console.csproj':
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>\n',
      'Program.cs':
        '// This library can be initialized from MauiProgram or any other entry point.\nSystem.Console.WriteLine("MauiProgram");\n',
    })
    assert.ok(!ids.includes('maui'), `a comment or string matched MAUI: ${ids.join(', ')}`)
  })

  test('a MauiProgram token inside an interpolated string is not a declaration', () => {
    const ids = stacksOf({
      'Console.csproj':
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>\n',
      'Program.cs':
        'var label = $"{string.Join("class MauiProgram", new[] {"a", "b"})}";\nSystem.Console.WriteLine(label);\n',
    })
    assert.ok(!ids.includes('maui'), `an interpolated string matched MAUI: ${ids.join(', ')}`)
  })

  test('a MauiProgram token inside a raw string literal is not a declaration', () => {
    const ids = stacksOf({
      'Console.csproj':
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>\n',
      'Program.cs': 'var text = """"\npublic class MauiProgram { }\n"""";\n',
    })
    assert.ok(!ids.includes('maui'), `a raw string matched MAUI: ${ids.join(', ')}`)
  })

  test('a verbatim string containing a quote does not hide the entry point', () => {
    const ids = stacksOf({ 'MauiProgram.cs': 'var quote = @"""";\npublic static class MauiProgram { }\n' })
    assert.ok(ids.includes('maui'), `a verbatim string swallowed the file: ${ids.join(', ')}`)
  })

  test('a MauiProgram declaration split across lines is still an entry point', () => {
    const ids = stacksOf({ 'MauiProgram.cs': 'public static class\nMauiProgram\n{ }\n' })
    assert.ok(ids.includes('maui'), ids.join(', '))
  })

  test('a commented-out UseMaui element is not a MAUI marker', () => {
    const ids = stacksOf({
      'App.csproj':
        '<Project Sdk="Microsoft.NET.Sdk"><!-- <UseMaui>true</UseMaui> --><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>\n',
    })
    assert.ok(!ids.includes('maui'), `a commented-out marker matched MAUI: ${ids.join(', ')}`)
  })

  test('an Xcode project is xcode, not swift', () => {
    const ids = stacksOf({
      'App.xcodeproj/project.pbxproj': '// !$*UTF8*$!\n{ objects = {}; }\n',
      'App/App.swift': 'import UIKit\n',
    })
    assert.ok(ids.includes('xcode'), ids.join(', '))
    assert.ok(!ids.includes('swift'), 'no Package.swift, so this is not a SwiftPM package')
  })
})

describe('the C/C++ detector keys on the build system', () => {
  test('a CMake project is cpp and cmake', () => {
    const ids = stacksOf({
      'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.28)\nproject(app LANGUAGES CXX)\n',
      'src/main.cpp': 'int main() { return 0; }\n',
    })
    assert.ok(ids.includes('cpp'), ids.join(', '))
    assert.ok(ids.includes('cmake'), ids.join(', '))
  })

  test('a nested CMakeLists.txt is found, not only the root one', () => {
    const ids = stacksOf({
      'libs/core/CMakeLists.txt': 'project(core LANGUAGES CXX)\n',
      'libs/core/main.cpp': 'int main() { return 0; }\n',
    })
    assert.ok(ids.includes('cpp'), ids.join(', '))
  })

  test('a Meson project is cpp and meson', () => {
    const ids = stacksOf({
      'meson.build': "project('app', 'cpp')\n",
      'main.cpp': 'int main() { return 0; }\n',
    })
    assert.ok(ids.includes('cpp'), ids.join(', '))
    assert.ok(ids.includes('meson'), ids.join(', '))
  })

  test('a vcpkg manifest is a package manager stack, not a build system', () => {
    const ids = stacksOf({
      'CMakeLists.txt': 'project(app LANGUAGES CXX)\n',
      'main.cpp': 'int main() { return 0; }\n',
      'vcpkg.json': '{ "name": "app", "version": "1.0.0" }\n',
    })
    assert.ok(ids.includes('vcpkg'), ids.join(', '))
    assert.ok(ids.includes('cpp'), ids.join(', '))
  })

  test('bare C++ sources with no build system are not a C/C++ project', () => {
    // A vendored reference implementation or a native addon is the C/C++ *language*, not a
    // project with a build and a test command to offer.
    const ids = stacksOf({
      'src/thing.cpp': 'int f() { return 1; }\n',
      'src/thing.h': 'int f();\n',
    })
    assert.ok(!ids.includes('cpp'), ids.join(', '))
    assert.ok(!ids.includes('cmake'), ids.join(', '))
  })

  test('a CMake project that builds only Swift is not a C/C++ project', () => {
    // swift-argument-parser enables C in CMake only to work around GNUInstallDirs.
    const ids = stacksOf({
      'CMakeLists.txt': 'project(swift-argument-parser LANGUAGES C Swift)\n',
      'Package.swift': '// swift-tools-version: 6.0\n',
      'Sources/App/main.swift': 'print("hello")\n',
    })
    assert.ok(!ids.includes('cpp'), ids.join(', '))
    assert.ok(!ids.includes('cmake'), ids.join(', '))
    assert.ok(ids.includes('swift'), ids.join(', '))
  })

  test('a Meson project with no C/C++ source is not a C/C++ project', () => {
    const ids = stacksOf({ 'meson.build': "project('app', 'swift')\n" })
    assert.ok(!ids.includes('cpp'), ids.join(', '))
    assert.ok(!ids.includes('meson'), ids.join(', '))
  })

  test('a Node native addon with C++ sources but no build system is not C/C++', () => {
    // node-addon-api's integration is node-gyp/npm, not CMake.
    const ids = stacksOf({
      'package.json': JSON.stringify({ name: 'addon', gypfile: true }),
      'binding.gyp': '{ "targets": [] }\n',
      'src/addon.cpp': 'int f() { return 1; }\n',
    })
    assert.ok(!ids.includes('cpp'), ids.join(', '))
    assert.ok(!ids.includes('cmake'), ids.join(', '))
  })
})

describe('Shell and PowerShell are projects only when they signal it', () => {
  test('a lone script is not a shell project', () => {
    const ids = stacksOf({ 'scripts/deploy.sh': '#!/bin/sh\necho deploy\n' })
    assert.ok(!ids.includes('shell-project'), ids.join(', '))
  })

  test('a .shellcheckrc is a shell project', () => {
    const ids = stacksOf({ '.shellcheckrc': 'shell=bash\n', 'bin/tool.sh': '#!/bin/bash\n' })
    assert.ok(ids.includes('shell-project'), ids.join(', '))
  })

  test('a Bats suite is a shell project', () => {
    const ids = stacksOf({ 'test/app.bats': '#!/usr/bin/env bats\n' })
    assert.ok(ids.includes('shell-project'), ids.join(', '))
  })

  test('five scripts are a shell project', () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 5; i++) files[`scripts/s${String(i)}.sh`] = '#!/bin/sh\n'
    const ids = stacksOf(files)
    assert.ok(ids.includes('shell-project'), ids.join(', '))
  })

  test('a PowerShell module manifest is a PowerShell project', () => {
    const ids = stacksOf({
      'Module.psd1': "@{RootModule='Module.psm1'}\n",
      'Module.psm1': 'function Get-Thing {}\n',
    })
    assert.ok(ids.includes('powershell-project'), ids.join(', '))
  })

  test('a lone .ps1 is not a PowerShell project', () => {
    const ids = stacksOf({ 'install.ps1': 'Write-Host "hi"\n' })
    assert.ok(!ids.includes('powershell-project'), ids.join(', '))
  })
})

describe('frontend frameworks are matched from dependencies, not from "it is Node"', () => {
  test('a React web app is react', () => {
    const ids = stacksOf({
      'package.json': JSON.stringify({ dependencies: { react: '19.0.0', 'react-dom': '19.0.0' } }),
      'src/App.tsx': 'export default function App() { return null }\n',
    })
    assert.ok(ids.includes('react'), ids.join(', '))
  })

  test('a React Native app is not React web', () => {
    const ids = stacksOf({
      'package.json': JSON.stringify({ dependencies: { react: '19.0.0', 'react-native': '0.79.0' } }),
      'App.tsx': 'export default 1\n',
    })
    assert.ok(!ids.includes('react'), `React Native matched the web React stack: ${ids.join(', ')}`)
    assert.ok(ids.includes('react-native'), ids.join(', '))
  })

  test('a next.config.ts file is Next.js', () => {
    const ids = stacksOf({ 'next.config.ts': 'export default {}\n' })
    assert.ok(ids.includes('nextjs'), ids.join(', '))
  })

  test('an @angular/core dependency is Angular', () => {
    const ids = stacksOf({ 'package.json': JSON.stringify({ dependencies: { '@angular/core': '20.0.0' } }) })
    assert.ok(ids.includes('angular'), ids.join(', '))
  })

  test('an Express service matches no frontend framework', () => {
    const ids = stacksOf({
      'package.json': JSON.stringify({ dependencies: { express: '5.0.0' } }),
      'src/server.js': 'const express = require("express")\n',
    })
    for (const id of ['react', 'nextjs', 'angular', 'vue', 'svelte', 'astro', 'nestjs']) {
      assert.ok(!ids.includes(id), `${id} matched an Express service: ${ids.join(', ')}`)
    }
  })
})

describe('workspace application manifests contribute framework stacks', () => {
  test('npm workspaces are read from their member manifests, with their real paths', () => {
    const profile = profileOf({
      'package.json': JSON.stringify({ private: true, workspaces: ['apps/*'] }),
      'apps/web/package.json': JSON.stringify({ dependencies: { react: '19.0.0', 'react-dom': '19.0.0' } }),
      'apps/mobile/package.json': JSON.stringify({
        dependencies: { react: '19.0.0', 'react-native': '0.81.0', expo: '54.0.0' },
      }),
    })
    const ids = profile.stacks.map((s) => s.id)
    for (const id of ['react', 'react-native', 'expo']) {
      assert.ok(ids.includes(id), `expected ${id} in ${ids.join(', ')}`)
    }
    const react = profile.stacks.find((s) => s.id === 'react')
    assert.ok(
      react?.evidence.some((e) => e.startsWith('apps/web/package.json')),
      `React evidence should name the workspace member: ${JSON.stringify(react?.evidence)}`,
    )
  })

  test('pnpm-workspace.yaml is read, not only the npm workspaces field', () => {
    // create-t3-turbo's shape: the root package.json has orchestration scripts only, and
    // pnpm-workspace.yaml is where the members are named.
    const profile = profileOf({
      'package.json': JSON.stringify({ private: true, packageManager: 'pnpm@10.19.0' }),
      'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n\ncatalog:\n  react: 19.1.4\n',
      'apps/nextjs/package.json': JSON.stringify({
        dependencies: { next: '16.0.0', react: '19.1.4', 'react-dom': '19.1.4' },
      }),
      'apps/expo/package.json': JSON.stringify({
        dependencies: { expo: '54.0.0', 'react-native': '0.81.0', react: '19.1.4' },
      }),
    })
    const ids = profile.stacks.map((s) => s.id)
    for (const id of ['nextjs', 'react', 'react-native', 'expo']) {
      assert.ok(ids.includes(id), `expected ${id} in ${ids.join(', ')}`)
    }
  })

  test('a repository with no root package.json is a collection of applications', () => {
    // expo/examples: independent example apps, no workspace owner.
    const ids = stacksOf({
      'blank/package.json': JSON.stringify({ dependencies: { expo: '57.0.1', 'react-native': '0.86.0' } }),
      'with-router/package.json': JSON.stringify({ dependencies: { expo: '57.0.1', 'react-native': '0.86.0' } }),
    })
    assert.ok(ids.includes('expo'), ids.join(', '))
    assert.ok(ids.includes('react-native'), ids.join(', '))
  })

  test('a nested manifest no workspace declares is not selected', () => {
    // The root is a single package. A fixture or example tree must not claim its stacks.
    const ids = stacksOf({
      'package.json': JSON.stringify({ name: 'tool', dependencies: { express: '5.0.0' } }),
      'examples/demo/package.json': JSON.stringify({ dependencies: { react: '19.0.0', 'react-dom': '19.0.0' } }),
    })
    assert.ok(!ids.includes('react'), `an undeclared nested manifest matched react: ${ids.join(', ')}`)
  })

  test('an undeclared nested app does not contribute an Expo config', () => {
    const ids = stacksOf({
      'package.json': JSON.stringify({ name: 'api', dependencies: { express: '5.0.0' } }),
      'examples/demo/package.json': JSON.stringify({ dependencies: { expo: '54.0.0' } }),
      'examples/demo/app.json': JSON.stringify({ expo: { name: 'demo', slug: 'demo' } }),
    })
    assert.ok(!ids.includes('expo'), `an undeclared nested config matched expo: ${ids.join(', ')}`)
    assert.ok(!ids.includes('react-native'), `an undeclared nested config matched react-native: ${ids.join(', ')}`)
  })

  test('an undeclared nested app does not contribute frontend configs or tools', () => {
    const profile = profileOf({
      'package.json': JSON.stringify({ name: 'api', dependencies: { express: '5.0.0' } }),
      'examples/demo/package.json': JSON.stringify({ dependencies: { next: '16.0.0' } }),
      'examples/demo/next.config.js': 'module.exports = {}\n',
      'examples/demo/vite.config.js': 'export default {}\n',
      'examples/demo/eslint.config.js': 'export default []\n',
    })
    const ids = profile.stacks.map((s) => s.id)
    for (const id of ['nextjs', 'vite']) {
      assert.ok(!ids.includes(id), `an undeclared nested config matched ${id}: ${ids.join(', ')}`)
    }
    assert.ok(
      !profile.tooling.lint.includes('eslint'),
      `an undeclared nested config added eslint: ${profile.tooling.lint.join(', ')}`,
    )
  })

  test('a declared workspace member still contributes its configs', () => {
    const ids = stacksOf({
      'package.json': JSON.stringify({ private: true, workspaces: ['apps/*'] }),
      'apps/web/package.json': JSON.stringify({
        dependencies: { next: '16.0.0', react: '19.0.0', 'react-dom': '19.0.0' },
      }),
      'apps/web/next.config.js': 'module.exports = {}\n',
    })
    assert.ok(ids.includes('nextjs'), `a declared workspace config was missed: ${ids.join(', ')}`)
  })

  test('an unparseable root manifest still owns its own config files', () => {
    const ids = stacksOf({
      'package.json': '{ "name": "web", }\n',
      'next.config.js': 'module.exports = {}\n',
    })
    assert.ok(ids.includes('nextjs'), `the root config beside a broken manifest was dropped: ${ids.join(', ')}`)
  })

  test('an unparseable root manifest does not reopen a tree-wide config scan', () => {
    const ids = stacksOf({
      'package.json': '{ "name": "api", }\n',
      'examples/demo/package.json': JSON.stringify({ dependencies: { next: '16.0.0' } }),
      'examples/demo/next.config.js': 'module.exports = {}\n',
    })
    assert.ok(!ids.includes('nextjs'), `an unparseable root reopened the scan: ${ids.join(', ')}`)
  })

  test('an unparseable root manifest does not let a broken nested app own its config', () => {
    const ids = stacksOf({
      'package.json': '{ "name": "api", }\n',
      'examples/demo/package.json': '{ "name": "demo", }\n',
      'examples/demo/next.config.js': 'module.exports = {}\n',
    })
    assert.ok(!ids.includes('nextjs'), `a broken nested app claimed its config: ${ids.join(', ')}`)
  })

  test('the resolved project manifest owns the fallback, whatever its path', () => {
    // No root manifest: the one nested manifest is the project, so its own config is evidence.
    const own = stacksOf({
      'app/package.json': '{ "name": "app", }\n',
      'app/next.config.js': 'module.exports = {}\n',
    })
    assert.ok(own.includes('nextjs'), `the resolved project's config was dropped: ${own.join(', ')}`)

    // A second broken manifest is a sibling, not the project: its config must not be read.
    const sibling = stacksOf({
      'app/package.json': '{ "name": "app", }\n',
      'examples/demo/package.json': '{ "name": "demo", }\n',
      'examples/demo/next.config.js': 'module.exports = {}\n',
    })
    assert.ok(!sibling.includes('nextjs'), `a sibling broken manifest claimed the project: ${sibling.join(', ')}`)
  })
})

describe('AI and backend frameworks are matched from their own marker', () => {
  test('a notebook is jupyter', () => {
    const ids = stacksOf({ 'analysis.ipynb': '{"cells":[],"nbformat":4,"nbformat_minor":5}\n' })
    assert.ok(ids.includes('jupyter'), ids.join(', '))
  })

  test('a declared torch dependency is pytorch', () => {
    const ids = stacksOf({ 'pyproject.toml': '[project]\nname="m"\nversion="0.1.0"\ndependencies=["torch>=2.5"]\n' })
    assert.ok(ids.includes('pytorch'), ids.join(', '))
  })

  test('a comment that mentions torch is not a dependency declaration', () => {
    const ids = stacksOf({
      'pyproject.toml':
        '[project]\nname="plain"\nversion="0.1.0"\ndependencies=[]\n# Does not use torch or transformers.\n',
    })
    assert.ok(!ids.includes('pytorch'), ids.join(', '))
    assert.ok(!ids.includes('huggingface'), ids.join(', '))
  })

  test('a linter tool table is not a dependency declaration', () => {
    const ids = stacksOf({
      'pyproject.toml':
        '[project]\nname="plain"\nversion="0.1.0"\ndependencies=[]\n\n[tool.ruff.lint.isort]\nknown-third-party=["torch", "transformers"]\n',
    })
    assert.ok(!ids.includes('pytorch'), ids.join(', '))
    assert.ok(!ids.includes('huggingface'), ids.join(', '))
  })

  test('optional dependencies, dependency groups and Poetry tables are declarations', () => {
    assert.ok(
      stacksOf({
        'pyproject.toml':
          '[project]\nname="m"\nversion="0.1.0"\ndependencies=[]\n[project.optional-dependencies]\ntrain=["torch>=2.5"]\n',
      }).includes('pytorch'),
    )
    assert.ok(
      stacksOf({
        'pyproject.toml': '[dependency-groups]\ndev=["transformers>=4"]\n',
      }).includes('huggingface'),
    )
    assert.ok(
      stacksOf({
        'pyproject.toml': '[tool.poetry.dependencies]\npython="^3.12"\ntorch="^2.5"\n',
      }).includes('pytorch'),
    )
  })

  test('requirements.txt ignores comments and options', () => {
    assert.ok(
      !stacksOf({
        'requirements.txt': '# torch is not used\n-r other.txt\n--index-url https://example.test\n',
      }).includes('pytorch'),
    )
    assert.ok(stacksOf({ 'requirements.txt': 'torch>=2.5\n' }).includes('pytorch'))
  })

  test('a setup.py literal requirement is read, but unrelated strings are not', () => {
    assert.ok(
      stacksOf({
        'setup.py': 'from setuptools import setup\nsetup(name="m", install_requires=["torch>=2.5"])\n',
      }).includes('pytorch'),
    )
    assert.ok(
      !stacksOf({
        'setup.py': 'from setuptools import setup\nsetup(name="m", description="does not use torch")\n',
      }).includes('pytorch'),
    )
  })

  test('setup.py resolves requirement variables, tuples and concatenation', () => {
    assert.ok(
      stacksOf({
        'setup.py':
          'from setuptools import setup\nrequirements = ["torch>=2.5"]\nsetup(name="m", install_requires=requirements)\n',
      }).includes('pytorch'),
    )
    assert.ok(
      stacksOf({
        'setup.py': 'from setuptools import setup\nsetup(name="m", install_requires=("torch>=2.5",))\n',
      }).includes('pytorch'),
    )
    assert.ok(
      stacksOf({
        'setup.py':
          'from setuptools import setup\nruntime = ["requests"]\nextras = ["torch>=2.5"]\nsetup(name="m", install_requires=list(runtime) + extras)\n',
      }).includes('pytorch'),
    )
  })

  test('setup.py reusing a name for its derived list still resolves the original', () => {
    assert.ok(
      stacksOf({
        'setup.py':
          'from setuptools import setup\nrequirements = ["torch>=2.5"]\nrequirements = list(requirements)\nsetup(name="m", install_requires=requirements)\n',
      }).includes('pytorch'),
    )
  })

  test('setup.py reads extras populated with deps_list, as diffusers does', () => {
    const ids = stacksOf({
      'setup.py': [
        'from setuptools import setup',
        'deps = {name: name for name in ["torch", "transformers", "accelerate"]}',
        'def deps_list(*pkgs):',
        '    return [deps[pkg] for pkg in pkgs]',
        'extras = {}',
        'extras["torch"] = deps_list("torch", "accelerate")',
        'extras["test"] = deps_list("transformers")',
        'install_requires = [deps["accelerate"]]',
        'setup(name="m", install_requires=list(install_requires), extras_require=extras)',
        '',
      ].join('\n'),
    })
    assert.ok(ids.includes('pytorch'), `expected pytorch in ${ids.join(', ')}`)
    assert.ok(ids.includes('huggingface'), `expected huggingface in ${ids.join(', ')}`)
  })

  test('setup.py honors escapes in single-quoted strings', () => {
    assert.ok(
      stacksOf({
        'setup.py':
          "from setuptools import setup\nsetup(name='m', description='A trainer\\'s model', install_requires=['torch>=2.5'])\n",
      }).includes('pytorch'),
    )
  })

  test('setup.py ignores function-local and post-call rebindings', () => {
    assert.ok(
      !stacksOf({
        'setup.py':
          'from setuptools import setup\nrequirements = ["requests"]\ndef unused():\n    requirements = ["torch>=2.5"]\nsetup(name="m", install_requires=requirements)\n',
      }).includes('pytorch'),
    )
    assert.ok(
      !stacksOf({
        'setup.py':
          'from setuptools import setup\nrequirements = ["requests"]\nsetup(name="m", install_requires=requirements)\nrequirements = ["torch>=2.5"]\n',
      }).includes('pytorch'),
    )
    assert.ok(
      !stacksOf({
        'setup.py':
          'from setuptools import setup\nextras = {"train": ["torch>=2.5"]}\nextras["train"] = ["requests"]\nsetup(name="m", extras_require=extras)\n',
      }).includes('pytorch'),
    )
  })

  test('setup.py resolves a reference as of its assignment, not the call', () => {
    assert.ok(
      !stacksOf({
        'setup.py':
          'from setuptools import setup\nrequirements = ["requests"]\ninstall_requires = requirements\nrequirements = ["torch>=2.5"]\nsetup(name="m", install_requires=install_requires)\n',
      }).includes('pytorch'),
    )
  })

  test('setup.py reads requirements built in the function that calls setup', () => {
    assert.ok(
      stacksOf({
        'setup.py':
          'from setuptools import setup\ndef main():\n    install_requires = ["torch>=2.5"]\n    setup(name="m", install_requires=install_requires)\nif __name__ == "__main__":\n    main()\n',
      }).includes('pytorch'),
    )
  })

  test('a helper that rebinds its varargs is not a projection', () => {
    assert.ok(
      !stacksOf({
        'setup.py': [
          'from setuptools import setup',
          'def dependencies(*pkgs):',
          '    pkgs = ("requests",)',
          '    return [pkg for pkg in pkgs]',
          'setup(name="m", install_requires=dependencies("torch"))',
          '',
        ].join('\n'),
      }).includes('pytorch'),
    )
  })

  test('a required helper parameter is not read as a package', () => {
    assert.ok(
      !stacksOf({
        'setup.py': [
          'from setuptools import setup',
          'def dependencies(group, *pkgs):',
          '    return [pkg for pkg in pkgs]',
          'setup(name="m", install_requires=dependencies("torch", "requests"))',
          '',
        ].join('\n'),
      }).includes('pytorch'),
    )
  })

  test('a global helper reads its own scope, not a caller-local name', () => {
    assert.ok(
      stacksOf({
        'setup.py': [
          'from setuptools import setup',
          'deps = {"torch": "torch>=2.5"}',
          'def dependencies(*pkgs):',
          '    return [deps[pkg] for pkg in pkgs]',
          'def main():',
          '    deps = {"requests": "requests"}',
          '    setup(name="m", install_requires=dependencies("torch"))',
          'if __name__ == "__main__":',
          '    main()',
          '',
        ].join('\n'),
      }).includes('pytorch'),
    )
  })

  test('a dict alias sees mutations made through the base after the alias', () => {
    assert.ok(
      stacksOf({
        'setup.py': [
          'from setuptools import setup',
          'extras = {}',
          'install_requires = extras',
          'extras["torch"] = "torch>=2.5"',
          'setup(name="m", install_requires=install_requires)',
          '',
        ].join('\n'),
      }).includes('pytorch'),
    )
  })

  test('a dict alias does not see a mutation made after the base was rebound', () => {
    assert.ok(
      !stacksOf({
        'setup.py': [
          'from setuptools import setup',
          'extras = {}',
          'install_requires = extras',
          'extras = {}',
          'extras["torch"] = "torch>=2.5"',
          'setup(name="m", install_requires=install_requires)',
          '',
        ].join('\n'),
      }).includes('pytorch'),
    )
  })

  test('setup.py accepts an aliased setuptools import', () => {
    assert.ok(
      stacksOf({
        'setup.py': 'from setuptools import setup as configure\nconfigure(name="m", install_requires=["torch>=2.5"])\n',
      }).includes('pytorch'),
    )
  })

  test('setup.py reads a keyword dictionary passed with **', () => {
    assert.ok(
      stacksOf({
        'setup.py':
          'from setuptools import setup\nkwargs = dict(name="m", install_requires=["torch>=2.5"])\nsetup(**kwargs)\n',
      }).includes('pytorch'),
    )
  })

  test('a keyword dictionary sees mutations made before setup', () => {
    assert.ok(
      stacksOf({
        'setup.py': [
          'from setuptools import setup',
          'kwargs = {}',
          'kwargs["install_requires"] = ["torch>=2.5"]',
          'setup(**kwargs)',
          '',
        ].join('\n'),
      }).includes('pytorch'),
    )
  })

  test('a keyword dictionary does not see a mutation made after setup', () => {
    assert.ok(
      !stacksOf({
        'setup.py': [
          'from setuptools import setup',
          'kwargs = {"install_requires": ["requests"]}',
          'setup(**kwargs)',
          'kwargs["install_requires"] = ["torch>=2.5"]',
          '',
        ].join('\n'),
      }).includes('pytorch'),
    )
  })

  test('a keyword dictionary value resolves where it was written, not at the call', () => {
    assert.ok(
      !stacksOf({
        'setup.py': [
          'from setuptools import setup',
          'requirements = ["requests"]',
          'kwargs = {"install_requires": requirements}',
          'requirements = ["torch>=2.5"]',
          'setup(**kwargs)',
          '',
        ].join('\n'),
      }).includes('pytorch'),
    )
  })

  test('a dict captured in a keyword dictionary still sees a later mutation', () => {
    assert.ok(
      stacksOf({
        'setup.py': [
          'from setuptools import setup',
          'extras = {}',
          'kwargs = {"extras_require": extras}',
          'extras["train"] = ["torch>=2.5"]',
          'setup(**kwargs)',
          '',
        ].join('\n'),
      }).includes('pytorch'),
    )
  })

  test('a dict captured in a keyword dictionary does not keep an overwritten entry', () => {
    assert.ok(
      !stacksOf({
        'setup.py': [
          'from setuptools import setup',
          'extras = {"train": ["torch>=2.5"]}',
          'kwargs = {"extras_require": extras}',
          'extras["train"] = ["requests"]',
          'setup(**kwargs)',
          '',
        ].join('\n'),
      }).includes('pytorch'),
    )
  })

  test('a mapping aliased before unpacking sees mutations made through the base', () => {
    assert.ok(
      stacksOf({
        'setup.py': [
          'from setuptools import setup',
          'kwargs = {}',
          'options = kwargs',
          'kwargs["install_requires"] = ["torch>=2.5"]',
          'setup(**options)',
          '',
        ].join('\n'),
      }).includes('pytorch'),
    )
  })

  test('a keyword dictionary keeps the latest write across a mapping and its alias', () => {
    assert.ok(
      !stacksOf({
        'setup.py': [
          'from setuptools import setup',
          'kwargs = {"install_requires": ["torch>=2.5"]}',
          'options = kwargs',
          'options["install_requires"] = ["torch>=2.5"]',
          'kwargs["install_requires"] = ["requests"]',
          'setup(**options)',
          '',
        ].join('\n'),
      }).includes('pytorch'),
    )
  })

  test('a keyword dictionary sees a write through an alias reassigned the mapping', () => {
    assert.ok(
      !stacksOf({
        'setup.py': [
          'from setuptools import setup',
          'kwargs = {"install_requires": ["torch>=2.5"]}',
          'options = kwargs',
          'options = {}',
          'options = kwargs',
          'options["install_requires"] = ["requests"]',
          'setup(**kwargs)',
          '',
        ].join('\n'),
      }).includes('pytorch'),
    )
  })

  test('a helper mapping parameter is the caller argument, not a same-named global', () => {
    const helper = [
      'from setuptools import setup',
      'dependencies = {"requests": "requests"}',
      'def deps_list(dependencies, *pkgs):',
      '    return [dependencies[pkg] for pkg in pkgs]',
    ]
    const positive = stacksOf({
      'setup.py': [...helper, 'setup(name="m", install_requires=deps_list({"torch": "torch>=2.5"}, "torch"))', ''].join(
        '\n',
      ),
    })
    assert.ok(positive.includes('pytorch'), `the parameter argument was ignored: ${positive.join(', ')}`)
    const negative = stacksOf({
      'setup.py': [
        ...helper,
        'setup(name="m", install_requires=deps_list({"requests": "requests"}, "torch"))',
        '',
      ].join('\n'),
    })
    assert.ok(!negative.includes('pytorch'), `the global mapping was used instead: ${negative.join(', ')}`)
  })

  test('a subscript override written through an alias replaces the base entry', () => {
    const ids = stacksOf({
      'setup.py': [
        'from setuptools import setup',
        'extras = {"train": ["torch>=2.5"]}',
        'install_requires = extras',
        'install_requires["train"] = ["requests"]',
        'setup(name="m", install_requires=install_requires)',
        '',
      ].join('\n'),
    })
    assert.ok(!ids.includes('pytorch'), `the overridden requirement was kept: ${ids.join(', ')}`)
  })

  test('a subscript override written through a name that aliases the base replaces the entry', () => {
    const ids = stacksOf({
      'setup.py': [
        'from setuptools import setup',
        'extras = {"train": ["torch>=2.5"]}',
        'alias = extras',
        'alias["train"] = ["requests"]',
        'setup(name="m", extras_require=extras)',
        '',
      ].join('\n'),
    })
    assert.ok(!ids.includes('pytorch'), `the alias override was ignored: ${ids.join(', ')}`)
  })

  test('an override written through a second-hand alias replaces the base entry', () => {
    const ids = stacksOf({
      'setup.py': [
        'from setuptools import setup',
        'extras = {"train": ["torch>=2.5"]}',
        'alias = extras',
        'second = alias',
        'second["train"] = ["requests"]',
        'setup(name="m", extras_require=extras)',
        '',
      ].join('\n'),
    })
    assert.ok(!ids.includes('pytorch'), `the second-hand alias override was ignored: ${ids.join(', ')}`)
  })

  test('an alias reassigned the same object still records its later write', () => {
    assert.ok(
      !stacksOf({
        'setup.py': [
          'from setuptools import setup',
          'extras = {"train": ["torch>=2.5"]}',
          'alias = extras',
          'alias = extras',
          'alias["train"] = ["requests"]',
          'setup(name="m", extras_require=extras)',
          '',
        ].join('\n'),
      }).includes('pytorch'),
    )
  })

  test('an alias detached and reattached records a write made after it reattached', () => {
    assert.ok(
      stacksOf({
        'setup.py': [
          'from setuptools import setup',
          'extras = {}',
          'alias = extras',
          'alias = {}',
          'alias = extras',
          'alias["train"] = ["torch>=2.5"]',
          'setup(name="m", extras_require=extras)',
          '',
        ].join('\n'),
      }).includes('pytorch'),
    )
  })

  test('too many aliases to enumerate drops the entry rather than guessing', () => {
    const lines = ['from setuptools import setup', 'extras = {"train": ["torch>=2.5"]}']
    for (let i = 0; i < 256; i++) lines.push(`a${i} = extras`)
    lines.push('second = a0', 'second["train"] = ["requests"]', 'setup(name="m", extras_require=extras)', '')
    assert.ok(!stacksOf({ 'setup.py': lines.join('\n') }).includes('pytorch'))
  })

  test('a self-assignment does not end an alias object lifetime', () => {
    assert.ok(
      !stacksOf({
        'setup.py': [
          'from setuptools import setup',
          'extras = {"train": ["torch>=2.5"]}',
          'alias = extras',
          'alias = alias',
          'alias["train"] = ["requests"]',
          'setup(name="m", extras_require=extras)',
          '',
        ].join('\n'),
      }).includes('pytorch'),
    )
  })

  test('a self-assignment does not end the base object lifetime', () => {
    assert.ok(
      !stacksOf({
        'setup.py': [
          'from setuptools import setup',
          'extras = {"train": ["torch>=2.5"]}',
          'alias = extras',
          'extras = extras',
          'extras["train"] = ["requests"]',
          'setup(name="m", extras_require=alias)',
          '',
        ].join('\n'),
      }).includes('pytorch'),
    )
  })

  test('budget exhaustion in a keyword dictionary drops the mapping rather than guessing', () => {
    const lines = ['from setuptools import setup', 'kwargs = {"install_requires": ["torch>=2.5"]}', 'options = kwargs']
    for (let i = 0; i < 256; i++) lines.push(`a${i} = kwargs`)
    lines.push(
      'options["install_requires"] = ["torch>=2.5"]',
      'kwargs["install_requires"] = ["requests"]',
      'setup(name="m", **options)',
      '',
    )
    assert.ok(!stacksOf({ 'setup.py': lines.join('\n') }).includes('pytorch'))
  })

  test('an alias override of another key leaves the base entry alone', () => {
    assert.ok(
      stacksOf({
        'setup.py': [
          'from setuptools import setup',
          'extras = {"train": ["torch>=2.5"]}',
          'alias = extras',
          'alias["eval"] = ["requests"]',
          'setup(name="m", extras_require=extras)',
          '',
        ].join('\n'),
      }).includes('pytorch'),
    )
  })

  test('a projection helper does not see an entry a later subscript overrode', () => {
    assert.ok(
      !stacksOf({
        'setup.py': [
          'from setuptools import setup',
          'deps = {"torch": "torch>=2.5"}',
          'deps["torch"] = "requests"',
          'def deps_list(*pkgs):',
          '    return [deps[pkg] for pkg in pkgs]',
          'setup(name="m", install_requires=deps_list("torch"))',
          '',
        ].join('\n'),
      }).includes('pytorch'),
    )
  })

  test('a projection helper sees an override written through an alias', () => {
    assert.ok(
      !stacksOf({
        'setup.py': [
          'from setuptools import setup',
          'deps = {"torch": "torch>=2.5"}',
          'table = deps',
          'table["torch"] = "requests"',
          'def deps_list(*pkgs):',
          '    return [deps[pkg] for pkg in pkgs]',
          'setup(name="m", install_requires=deps_list("torch"))',
          '',
        ].join('\n'),
      }).includes('pytorch'),
    )
  })

  test('a projection helper still reads an entry that was not overridden', () => {
    assert.ok(
      stacksOf({
        'setup.py': [
          'from setuptools import setup',
          'deps = {"torch": "torch>=2.5", "vision": "torchvision"}',
          'deps["vision"] = "requests"',
          'def deps_list(*pkgs):',
          '    return [deps[pkg] for pkg in pkgs]',
          'setup(name="m", install_requires=deps_list("torch"))',
          '',
        ].join('\n'),
      }).includes('pytorch'),
    )
  })

  test('a projection helper over a comprehension table sees a later override', () => {
    assert.ok(
      !stacksOf({
        'setup.py': [
          'from setuptools import setup',
          'deps = {name: name for name in ("torch", "vision")}',
          'deps["torch"] = "requests"',
          'def deps_list(*pkgs):',
          '    return [deps[pkg] for pkg in pkgs]',
          'setup(name="m", install_requires=deps_list("torch"))',
          '',
        ].join('\n'),
      }).includes('pytorch'),
    )
  })

  test('a projection helper over a comprehension table keeps an entry that was not overridden', () => {
    assert.ok(
      stacksOf({
        'setup.py': [
          'from setuptools import setup',
          'deps = {name: name for name in ("torch", "vision")}',
          'deps["vision"] = "requests"',
          'def deps_list(*pkgs):',
          '    return [deps[pkg] for pkg in pkgs]',
          'setup(name="m", install_requires=deps_list("torch"))',
          '',
        ].join('\n'),
      }).includes('pytorch'),
    )
  })

  test('a projection helper sees a write through an alias reassigned the table', () => {
    assert.ok(
      !stacksOf({
        'setup.py': [
          'from setuptools import setup',
          'deps = {name: name for name in ("torch",)}',
          'table = deps',
          'table = {}',
          'table = deps',
          'table["torch"] = "requests"',
          'def deps_list(*pkgs):',
          '    return [deps[pkg] for pkg in pkgs]',
          'setup(name="m", install_requires=deps_list("torch"))',
          '',
        ].join('\n'),
      }).includes('pytorch'),
    )
  })

  test('a deep alias chain stops at the depth limit instead of overflowing', () => {
    const lines = ['from setuptools import setup', 'a0 = []']
    for (let i = 1; i <= 4000; i++) lines.push(`a${i} = a${i - 1}`)
    lines.push('setup(name="m", install_requires=a4000)', '')
    const ids = stacksOf({ 'setup.py': lines.join('\n') })
    assert.ok(!ids.includes('pytorch'), ids.join(', '))
  })

  test('a helper named deps_list is read by its shape, not its name', () => {
    assert.ok(
      !stacksOf({
        'setup.py': [
          'from setuptools import setup',
          'def deps_list(*groups):',
          '    dependencies = {"torch": ["requests"]}',
          '    return [dep for group in groups for dep in dependencies[group]]',
          'setup(name="m", install_requires=deps_list("torch"))',
          '',
        ].join('\n'),
      }).includes('pytorch'),
    )
  })

  test('setup.py resolves a subscript concatenated with a list', () => {
    assert.ok(
      stacksOf({
        'setup.py':
          'from setuptools import setup\nextras = {"base": ["requests"]}\nsetup(name="m", install_requires=extras["base"] + ["torch>=2.5"])\n',
      }).includes('pytorch'),
    )
  })

  test('setup.py ignores commented-out requirements and brackets in comments', () => {
    assert.ok(
      !stacksOf({
        'setup.py':
          'from setuptools import setup\nsetup(name="m", install_requires=[\n    # "torch>=2.5",\n    "requests",\n])\n',
      }).includes('pytorch'),
    )
    assert.ok(
      stacksOf({
        'setup.py':
          'from setuptools import setup\nsetup(name="m", install_requires=[\n    # keep the closing ] below all dependencies\n    "torch>=2.5",\n])\n',
      }).includes('pytorch'),
    )
  })

  test('quoted TOML dependency keys are declarations', () => {
    assert.ok(
      stacksOf({
        'pyproject.toml':
          '[project]\nname="m"\nversion="0.1.0"\ndependencies=[]\n[project.optional-dependencies]\n"train"=["torch>=2.5"]\n',
      }).includes('pytorch'),
    )
    assert.ok(
      stacksOf({
        'pyproject.toml':
          '[tool.poetry]\nname="m"\nversion="0.1.0"\n[tool.poetry.dependencies]\npython="^3.12"\n"torch"="^2.5"\n',
      }).includes('pytorch'),
    )
  })

  test('uv development dependencies are a key in [tool.uv]', () => {
    const ids = stacksOf({
      'pyproject.toml':
        '[project]\nname="m"\nversion="0.1.0"\ndependencies=[]\n\n[tool.uv]\ndev-dependencies=["torch>=2.5"]\n',
    })
    assert.ok(ids.includes('pytorch'), ids.join(', '))
  })

  test('a dependency-group reference is not a package name', () => {
    const ids = stacksOf({
      'pyproject.toml': '[dependency-groups]\ntorch=["requests"]\ndev=[{include-group="torch"}]\n',
    })
    assert.ok(!ids.includes('pytorch'), `a group reference matched torch: ${ids.join(', ')}`)
  })

  test('a Spring Boot starter is spring-boot', () => {
    const ids = stacksOf({
      'pom.xml':
        '<project><parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.5.0</version></parent></project>\n',
      'src/main/java/App.java': 'class App {}\n',
    })
    assert.ok(ids.includes('spring-boot'), ids.join(', '))
  })

  test('a plain Maven project is not Spring Boot', () => {
    const ids = stacksOf({
      'pom.xml': '<project><groupId>com.acme</groupId><artifactId>app</artifactId></project>\n',
      'src/main/java/App.java': 'class App {}\n',
    })
    assert.ok(!ids.includes('spring-boot'), ids.join(', '))
  })

  test('a commented-out Gradle plugin is not Spring Boot', () => {
    const ids = stacksOf({
      'settings.gradle': 'rootProject.name = "app"\ninclude(":api")\n',
      'build.gradle': 'plugins { id "java" }\n',
      'api/build.gradle': '// plugins { id "org.springframework.boot" version "3.5.0" }\nplugins { id "java" }\n',
    })
    assert.ok(!ids.includes('spring-boot'), `a commented-out plugin was applied: ${ids.join(', ')}`)
  })

  test('a Spring Boot starter in a Maven reactor module is detected, with its path', () => {
    const profile = profileOf({
      'pom.xml': '<project><packaging>pom</packaging><modules><module>api</module></modules></project>\n',
      'api/pom.xml':
        '<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>\n',
    })
    const spring = profile.stacks.find((s) => s.id === 'spring-boot')
    assert.ok(spring, `expected spring-boot in ${profile.stacks.map((s) => s.id).join(', ')}`)
    assert.ok(
      spring.evidence.some((e) => e.startsWith('api/pom.xml:')),
      `evidence should name the module POM: ${JSON.stringify(spring.evidence)}`,
    )
  })

  test('a nested Maven reactor is followed recursively', () => {
    const ids = stacksOf({
      'pom.xml': '<project><packaging>pom</packaging><modules><module>services</module></modules></project>\n',
      'services/pom.xml': '<project><packaging>pom</packaging><modules><module>api</module></modules></project>\n',
      'services/api/pom.xml':
        '<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter</artifactId></dependency></dependencies></project>\n',
    })
    assert.ok(ids.includes('spring-boot'), ids.join(', '))
  })

  test('a plain Maven reactor is still not Spring Boot', () => {
    const ids = stacksOf({
      'pom.xml': '<project><packaging>pom</packaging><modules><module>api</module></modules></project>\n',
      'api/pom.xml': '<project><groupId>com.acme</groupId><artifactId>api</artifactId></project>\n',
    })
    assert.ok(!ids.includes('spring-boot'), ids.join(', '))
  })

  test('a commented-out Maven module is not followed', () => {
    const ids = stacksOf({
      'pom.xml': '<project><modules><!-- <module>unused</module> --><module>core</module></modules></project>\n',
      'core/pom.xml': '<project><groupId>com.acme</groupId><artifactId>core</artifactId></project>\n',
      'unused/pom.xml':
        '<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter</artifactId></dependency></dependencies></project>\n',
    })
    assert.ok(!ids.includes('spring-boot'), `a commented-out module was followed: ${ids.join(', ')}`)
  })

  test('an undeclared Gradle build does not make a Maven project Spring Boot', () => {
    const ids = stacksOf({
      'pom.xml': '<project><groupId>com.acme</groupId><artifactId>app</artifactId></project>\n',
      'examples/unused/build.gradle': 'plugins { id "org.springframework.boot" version "3.5.0" }\n',
    })
    assert.ok(!ids.includes('spring-boot'), `an unrelated Gradle build matched Spring Boot: ${ids.join(', ')}`)
  })

  test('a declared Gradle subproject is probed for Spring Boot', () => {
    const ids = stacksOf({
      'settings.gradle': 'rootProject.name = "app"\ninclude(":api")\n',
      'build.gradle': 'plugins { id "java" }\n',
      'api/build.gradle': 'plugins { id "org.springframework.boot" version "3.5.0" }\n',
    })
    assert.ok(ids.includes('spring-boot'), ids.join(', '))
  })

  test('every Gradle include is read, not just the first', () => {
    assert.ok(
      stacksOf({
        'settings.gradle': 'rootProject.name = "app"\ninclude(":core")\ninclude(":api")\n',
        'build.gradle': 'plugins { id "java" }\n',
        'core/build.gradle': 'plugins { id "java" }\n',
        'api/build.gradle': 'plugins { id "org.springframework.boot" version "3.5.0" }\n',
      }).includes('spring-boot'),
    )
  })

  test('a multiline Gradle include lists every module', () => {
    assert.ok(
      stacksOf({
        'settings.gradle.kts': 'rootProject.name = "app"\ninclude(\n    ":core",\n    ":api",\n)\n',
        'build.gradle.kts': 'plugins { id("java") }\n',
        'core/build.gradle.kts': 'plugins { id("java") }\n',
        'api/build.gradle.kts': 'plugins { id("org.springframework.boot") version "3.5.0" }\n',
      }).includes('spring-boot'),
    )
  })

  test('a comment inside a Gradle include does not end the list', () => {
    assert.ok(
      stacksOf({
        'settings.gradle.kts': 'rootProject.name = "app"\ninclude(\n    ":core", // keep this )\n    ":api",\n)\n',
        'build.gradle.kts': 'plugins { id("java") }\n',
        'core/build.gradle.kts': 'plugins { id("java") }\n',
        'api/build.gradle.kts': 'plugins { id("org.springframework.boot") version "3.5.0" }\n',
      }).includes('spring-boot'),
    )
  })

  test('a Gradle project whose directory is remapped is still probed', () => {
    assert.ok(
      stacksOf({
        'settings.gradle':
          'rootProject.name = "app"\ninclude(":api")\nproject(":api").projectDir = file("services/api")\n',
        'build.gradle': 'plugins { id "java" }\n',
        'services/api/build.gradle': 'plugins { id "org.springframework.boot" version "3.5.0" }\n',
      }).includes('spring-boot'),
    )
  })

  test('a Gradle remap written inside a string is not followed', () => {
    assert.ok(
      !stacksOf({
        'settings.gradle':
          'rootProject.name = "app"\nval sample = "project(\':api\').projectDir = file(\'services/api\')"\ninclude(":api")\n',
        'build.gradle': 'plugins { id "java" }\n',
        'services/api/build.gradle': 'plugins { id "org.springframework.boot" version "3.5.0" }\n',
      }).includes('spring-boot'),
    )
  })

  test('a Gradle include without a leading colon matches its remapped project', () => {
    assert.ok(
      stacksOf({
        'settings.gradle':
          'rootProject.name = "app"\ninclude("api")\nproject(":api").projectDir = file("services/api")\n',
        'build.gradle': 'plugins { id "java" }\n',
        'services/api/build.gradle': 'plugins { id "org.springframework.boot" version "3.5.0" }\n',
      }).includes('spring-boot'),
    )
  })

  test('a Gradle remap with a parent segment is normalized', () => {
    assert.ok(
      stacksOf({
        'settings.gradle':
          'rootProject.name = "app"\ninclude(":api")\nproject(":api").projectDir = file("services/duplicate/../api")\n',
        'build.gradle': 'plugins { id "java" }\n',
        'services/api/build.gradle': 'plugins { id "org.springframework.boot" version "3.5.0" }\n',
      }).includes('spring-boot'),
    )
  })

  test('a Gradle remap written inside a Kotlin raw string is not followed', () => {
    assert.ok(
      !stacksOf({
        'settings.gradle.kts': [
          'rootProject.name = "app"',
          'val sample = """',
          'project(":api").projectDir = file("services/api")',
          '"""',
          'include(":api")',
          '',
        ].join('\n'),
        'build.gradle.kts': 'plugins { id("java") }\n',
        'services/api/build.gradle.kts': 'plugins { id("org.springframework.boot") version "3.5.0" }\n',
      }).includes('spring-boot'),
    )
  })

  test('a Gradle include written inside a Kotlin raw string is not followed', () => {
    assert.ok(
      !stacksOf({
        'settings.gradle.kts': [
          'rootProject.name = "app"',
          'val sample = """',
          'val x = "a',
          'include ":fake"',
          '"""',
          'include(":api")',
          '',
        ].join('\n'),
        'build.gradle.kts': 'plugins { id("java") }\n',
        'fake/build.gradle.kts': 'plugins { id("org.springframework.boot") version "3.5.0" }\n',
        'api/build.gradle.kts': 'plugins { id("java") }\n',
      }).includes('spring-boot'),
    )
  })

  test('a computed Gradle remap is not read as its first literal', () => {
    assert.ok(
      !stacksOf({
        'settings.gradle':
          'rootProject.name = "app"\ninclude(":api")\nproject(":api").projectDir = file("services/api") + suffix\n',
        'build.gradle': 'plugins { id "java" }\n',
        'services/api/build.gradle': 'plugins { id "org.springframework.boot" version "3.5.0" }\n',
      }).includes('spring-boot'),
    )
  })

  test('a bare-string Gradle remap is followed', () => {
    assert.ok(
      stacksOf({
        'settings.gradle': 'rootProject.name = "app"\ninclude(":api")\nproject(":api").projectDir = "services/api"\n',
        'build.gradle': 'plugins { id "java" }\n',
        'services/api/build.gradle': 'plugins { id "org.springframework.boot" version "3.5.0" }\n',
      }).includes('spring-boot'),
    )
  })

  test('a nested settings file anchors its remap to its own directory', () => {
    assert.ok(
      stacksOf({
        'app/settings.gradle.kts':
          'rootProject.name = "app"\ninclude(":api")\nproject(":api").projectDir = file("../services/api")\n',
        'app/build.gradle.kts': 'plugins { id("java") }\n',
        'services/api/build.gradle.kts': 'plugins { id("org.springframework.boot") version "3.5.0" }\n',
      }).includes('spring-boot'),
    )
  })

  test('a multiline Gradle remap is followed', () => {
    assert.ok(
      stacksOf({
        'settings.gradle.kts':
          'rootProject.name = "app"\ninclude(":api")\nproject(":api").projectDir = file(\n    "services/api"\n)\n',
        'build.gradle.kts': 'plugins { id("java") }\n',
        'services/api/build.gradle.kts': 'plugins { id("org.springframework.boot") version "3.5.0" }\n',
      }).includes('spring-boot'),
    )
  })

  test('a multiline Gradle remap inside a project block is followed', () => {
    assert.ok(
      stacksOf({
        'settings.gradle.kts':
          'rootProject.name = "app"\ninclude(":api")\nproject(":api") {\n    projectDir = file(\n        "services/api"\n    )\n}\n',
        'build.gradle.kts': 'plugins { id("java") }\n',
        'services/api/build.gradle.kts': 'plugins { id("org.springframework.boot") version "3.5.0" }\n',
      }).includes('spring-boot'),
    )
  })

  test('a later computed remap invalidates an earlier static one', () => {
    assert.ok(
      !stacksOf({
        'settings.gradle':
          'rootProject.name = "app"\ninclude(":api")\nproject(":api").projectDir = file("services/api")\nval actual = file("other/api")\nproject(":api").projectDir = actual\n',
        'build.gradle': 'plugins { id "java" }\n',
        'services/api/build.gradle': 'plugins { id "org.springframework.boot" version "3.5.0" }\n',
      }).includes('spring-boot'),
    )
  })

  test('an unknown Gradle remap does not fall back to the declared directory', () => {
    assert.ok(
      !stacksOf({
        'settings.gradle.kts':
          'include(":api")\nproject(":api").projectDir = file("services/api")\nval actualDir = file("other/api")\nproject(":api").projectDir = actualDir\n',
        'build.gradle.kts': 'plugins { id("java") }\n',
        // The declared path holds a Spring build, but the project was moved elsewhere.
        'api/build.gradle.kts': 'plugins { id("org.springframework.boot") version "3.5.0" }\n',
        'other/api/build.gradle.kts': 'plugins { id("java") }\n',
      }).includes('spring-boot'),
    )
  })

  test('a commented-out Gradle include is not followed', () => {
    assert.ok(
      !stacksOf({
        'settings.gradle': 'rootProject.name = "app"\n// include(":unused")\ninclude(":core")\n',
        'build.gradle': 'plugins { id "java" }\n',
        'core/build.gradle': 'plugins { id "java" }\n',
        'unused/build.gradle': 'plugins { id "org.springframework.boot" version "3.5.0" }\n',
      }).includes('spring-boot'),
    )
  })

  test('Microsoft.NET.Sdk.Web is aspnet', () => {
    const ids = stacksOf({
      'App.csproj':
        '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>\n',
    })
    assert.ok(ids.includes('aspnet'), ids.join(', '))
  })

  test('a plain .NET console app is not aspnet', () => {
    const ids = stacksOf({
      'App.csproj':
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>\n',
    })
    assert.ok(!ids.includes('aspnet'), ids.join(', '))
  })
})
