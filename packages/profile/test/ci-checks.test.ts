/**
 * CI verification checks are detected from workflow files, not invented from convention.
 *
 * The brief uses these to tell the fast local loop apart from the merge gate. These tests
 * keep that boundary honest: a setup step is not a check, an emulator script is a device
 * check, and every result carries the workflow line that produced it.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { buildProfile, detectCiChecks } from '@anvil/profile'

const temps: string[] = []
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'anvil-ci-checks-'))
  temps.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, ...rel.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return dir
}

const WORKFLOW = `name: CI
jobs:
  build:
    steps:
      - name: Grant execute permission
        run: chmod +x gradlew
      - name: Run unit tests with Kover
        run: ./gradlew koverXmlReport koverHtmlReport --no-daemon
      - name: Format
        run: ./gradlew spotlessCheck --no-daemon
      - name: Block scalar setup
        run: |
          echo ignored
  device:
    steps:
      - name: Generate coverage
        uses: reactivecircus/android-emulator-runner@v2
        with:
          script: ./gradlew jacocoCombinedReport --no-daemon
`

describe('detectCiChecks', () => {
  test('records run and emulator script commands with their workflow line and scope', () => {
    const dir = repo({ '.github/workflows/ci.yml': WORKFLOW })
    const checks = detectCiChecks(dir, new Set(['.github/workflows/ci.yml']))

    assert.deepEqual(
      checks.map((check) => [check.cmd, check.scope]),
      [
        ['./gradlew jacocoCombinedReport --no-daemon', 'device'],
        ['./gradlew koverXmlReport koverHtmlReport --no-daemon', 'ci'],
        ['./gradlew spotlessCheck --no-daemon', 'ci'],
      ],
    )
    assert.equal(checks[0]?.evidence, '.github/workflows/ci.yml:19')
    assert.equal(checks[1]?.evidence, '.github/workflows/ci.yml:8')
  })

  test('returns no checks when no workflow ran a command', () => {
    const dir = repo({ '.github/workflows/ci.yml': 'name: CI\njobs:\n  build:\n    runs-on: ubuntu-latest\n' })
    assert.deepEqual(detectCiChecks(dir, new Set(['.github/workflows/ci.yml'])), [])
  })

  test('setup, cleanup, release and provenance steps are not checks', () => {
    const workflow = `jobs:
  build:
    steps:
      - run: npm test
      - run: rm -rf eval-results/latest.json
      - run: npm publish dist/pkg.tgz --provenance
      - run: sha256sum --check SHA256SUMS
      - run: git push origin main
      - run: npm ci
      - run: node --version
      - run: |
          node --input-type=commonjs <<'NODE
          const fs = require('node:fs');
          NODE
          npm test
`
    const dir = repo({ '.github/workflows/fixture.yml': workflow })
    const checks = detectCiChecks(dir, new Set(['.github/workflows/fixture.yml']))
    assert.deepEqual(
      checks.map((check) => check.cmd),
      ['npm test'],
    )
  })

  test('a block scalar and an inline run step are both read with the step working directory', () => {
    const workflow = `jobs:
  build:
    steps:
      - name: Block
        working-directory: packages/b
        run: |
          npm test
          echo not-a-check
      - run: npm run lint
`
    const dir = repo({ '.github/workflows/fixture.yml': workflow })
    const checks = detectCiChecks(dir, new Set(['.github/workflows/fixture.yml']))
    assert.deepEqual(
      checks.map((check) => [check.cmd, check.dir ?? null]),
      [
        ['npm test', 'packages/b'],
        ['npm run lint', null],
      ],
    )
  })

  test('device scope belongs to the emulator step and does not leak to the next step', () => {
    const workflow = `jobs:
  build:
    steps:
      - uses: reactivecircus/android-emulator-runner@v2
        with:
          script: ./gradlew jacocoCombinedReport
      - id: host_check
        run: npm test
      - name: Test
        run: npm test
        env:
          script: npm run not-a-step
`
    const dir = repo({ '.github/workflows/fixture.yml': workflow })
    const checks = detectCiChecks(dir, new Set(['.github/workflows/fixture.yml']))
    assert.deepEqual(
      checks.map((check) => [check.cmd, check.scope]),
      [
        ['./gradlew jacocoCombinedReport', 'device'],
        ['npm test', 'ci'],
      ],
    )
  })

  test('compound steps, version probes and clean scripts are not checks', () => {
    const workflow = `jobs:
  build:
    steps:
      - run: node -v
      - run: npm run clean
      - run: npm test&&npm publish
      - run: npm test; npm pack
      - run: npm test & npm publish
      - run: npm test
`
    const dir = repo({ '.github/workflows/fixture.yml': workflow })
    const checks = detectCiChecks(dir, new Set(['.github/workflows/fixture.yml']))
    assert.deepEqual(
      checks.map((check) => check.cmd),
      ['npm test'],
    )
  })

  test('only with.script on an emulator step is an executed device check', () => {
    const workflow = `jobs:
  build:
    steps:
      - uses: reactivecircus/android-emulator-runner@v2
        env:
          script: npm run not-executed
        with:
          script: ./gradlew on-device
`
    const dir = repo({ '.github/workflows/fixture.yml': workflow })
    const checks = detectCiChecks(dir, new Set(['.github/workflows/fixture.yml']))
    assert.deepEqual(
      checks.map((check) => [check.cmd, check.scope]),
      [['./gradlew on-device', 'device']],
    )
  })

  test('heredoc text inside a block scalar is not a workflow step', () => {
    const workflow = `jobs:
  build:
    steps:
      - run: |
          cat <<'EOF'
          one
          two
          three
          four
          run: npm run not-executed
          EOF
      - run: npm test
`
    const dir = repo({ '.github/workflows/fixture.yml': workflow })
    const checks = detectCiChecks(dir, new Set(['.github/workflows/fixture.yml']))
    assert.deepEqual(
      checks.map((check) => check.cmd),
      ['npm test'],
    )
  })

  test('working-directory written after run still belongs to that step', () => {
    const workflow = `jobs:
  build:
    steps:
      - run: npm test
        working-directory: packages/web # repository-relative
      - name: lint
        working-directory: packages/core
        run: npm run lint
`
    const dir = repo({ '.github/workflows/fixture.yml': workflow })
    const checks = detectCiChecks(dir, new Set(['.github/workflows/fixture.yml']))
    assert.deepEqual(
      checks.map((check) => [check.cmd, check.dir ?? null]),
      [
        ['npm test', 'packages/web'],
        ['npm run lint', 'packages/core'],
      ],
    )
  })

  test('a commented env mapping ends with context on an emulator step', () => {
    const workflow = `jobs:
  build:
    steps:
      - uses: reactivecircus/android-emulator-runner@v2
        with:
          script: npm run test:device
        env: # data only
          script: npm run not-executed
`
    const dir = repo({ '.github/workflows/fixture.yml': workflow })
    const checks = detectCiChecks(dir, new Set(['.github/workflows/fixture.yml']))
    assert.deepEqual(
      checks.map((check) => check.cmd),
      ['npm run test:device'],
    )
  })

  test('a heredoc body is skipped, including with a stripped block scalar', () => {
    const workflow = `jobs:
  build:
    steps:
      - run: |-
          cat <<'EOF'
          - run: npm run not-executed
          npm run also-not-executed
          EOF
      - run: npm test
`
    const dir = repo({ '.github/workflows/fixture.yml': workflow })
    const checks = detectCiChecks(dir, new Set(['.github/workflows/fixture.yml']))
    assert.deepEqual(
      checks.map((check) => check.cmd),
      ['npm test'],
    )
  })

  test('a compound command written in prose is not a documented command', () => {
    const dir = repo({ 'README.md': 'Run `npm test&&npm publish` to check and release.\n' })
    const { profile } = buildProfile(dir, { root: dir, host: null, remote: null, defaultBranch: null })
    const all = Object.values(profile.commands)
      .flat()
      .map((entry) => entry?.cmd)
    assert.ok(!all.some((cmd) => typeof cmd === 'string' && /&&|\|\||[|;]/.test(cmd)))
  })

  test('device checks survive the cap even when ordinary checks come first', () => {
    const steps = Array.from({ length: 12 }, (_, i) => `      - run: npm run check${String(i)}\n`).join('')
    const workflow = `jobs:\n  build:\n    steps:\n${steps}      - name: Device\n        uses: reactivecircus/android-emulator-runner@v2\n        with:\n          script: ./gradlew connectedDebugAndroidTest\n`
    const dir = repo({ '.github/workflows/fixture.yml': workflow })
    const checks = detectCiChecks(dir, new Set(['.github/workflows/fixture.yml']))
    assert.equal(checks.length, 12)
    assert.equal(checks[0]?.scope, 'device')
    assert.equal(checks[0]?.cmd, './gradlew connectedDebugAndroidTest')
  })
})
