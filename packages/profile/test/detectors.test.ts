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
    const ids = stacksOf({ 'libs/core/CMakeLists.txt': 'project(core LANGUAGES CXX)\n' })
    assert.ok(ids.includes('cpp'), ids.join(', '))
  })

  test('a Meson project is cpp and meson', () => {
    const ids = stacksOf({ 'meson.build': "project('app', 'cpp')\n" })
    assert.ok(ids.includes('cpp'), ids.join(', '))
    assert.ok(ids.includes('meson'), ids.join(', '))
  })

  test('a vcpkg manifest is a package manager stack, not a build system', () => {
    const ids = stacksOf({
      'CMakeLists.txt': 'project(app LANGUAGES CXX)\n',
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
