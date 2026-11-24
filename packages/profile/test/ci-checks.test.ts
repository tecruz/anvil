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
import { detectCiChecks } from '@anvil/profile'

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
        ['./gradlew koverXmlReport koverHtmlReport --no-daemon', 'ci'],
        ['./gradlew spotlessCheck --no-daemon', 'ci'],
        ['./gradlew jacocoCombinedReport --no-daemon', 'device'],
      ],
    )
    assert.equal(checks[0]?.evidence, '.github/workflows/ci.yml:8')
    assert.equal(checks[2]?.evidence, '.github/workflows/ci.yml:19')
  })

  test('returns no checks when no workflow ran a command', () => {
    const dir = repo({ '.github/workflows/ci.yml': 'name: CI\njobs:\n  build:\n    runs-on: ubuntu-latest\n' })
    assert.deepEqual(detectCiChecks(dir, new Set(['.github/workflows/ci.yml'])), [])
  })
})
