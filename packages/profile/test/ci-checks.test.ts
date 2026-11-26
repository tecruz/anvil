/**
 * Workflow references are citations, not runnable commands.
 *
 * The profile records the `file:line` of workflow keys that mention a command. It does not decide
 * which step runs, in which directory, or whether it passed. These tests keep that boundary: any
 * valid YAML — including deploy jobs, folded job names and workflow expressions — is simply a set
 * of lines a reader can open.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { buildProfile, detectWorkflowReferences } from '@anvil/profile'

const temps: string[] = []
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'anvil-workflow-refs-'))
  temps.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, ...rel.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return dir
}

const file = '.github/workflows/ci.yml'

describe('detectWorkflowReferences', () => {
  test('records run and emulator script lines, not the text beside them', () => {
    const dir = repo({
      [file]: `name: CI
jobs:
  build:
    steps:
      - run: npm test
      - name: Device
        uses: reactivecircus/android-emulator-runner@v2
        with:
          script: ./gradlew connectedDebugAndroidTest
`,
    })
    assert.deepEqual(detectWorkflowReferences(dir, new Set([file])), [
      { file, line: 5 },
      { file, line: 9 },
    ])
  })

  test('a release, deploy or expression step is still only a citation', () => {
    const dir = repo({
      [file]: `jobs:
    delivery:
        runs-on: ubuntu-latest
        name: >-
          Deploy staging
        steps:
            - run: node scripts/promote.mjs
              working-directory: \${{ matrix.package }}
            - run: ./gradlew assembleRelease --no-daemon
            - run: python3 scripts/sync-docs-versions.py
`,
    })
    assert.deepEqual(detectWorkflowReferences(dir, new Set([file])), [
      { file, line: 7 },
      { file, line: 9 },
      { file, line: 10 },
    ])
  })

  test('non-workflow files and non-YAML files are ignored', () => {
    const dir = repo({
      'README.md': 'run: npm test\n',
      '.github/workflows/notes.txt': 'run: npm test\n',
      [file]: 'name: CI\njobs:\n  build:\n    runs-on: ubuntu-latest\n',
    })
    assert.deepEqual(detectWorkflowReferences(dir, new Set(['README.md', '.github/workflows/notes.txt', file])), [])
  })

  test('a heredoc line is cited too, never treated as a command to run', () => {
    const dir = repo({
      [file]: `jobs:
  build:
    steps:
      - run: |
          cat <<'EOF'
          run: npm run not-a-step
          EOF
`,
    })
    assert.deepEqual(detectWorkflowReferences(dir, new Set([file])), [
      { file, line: 4 },
      { file, line: 6 },
    ])
  })

  test('a profile exposes workflow references without turning them into checks', () => {
    const dir = repo({ [file]: 'jobs:\n  build:\n    steps:\n      - run: npm test\n' })
    const { profile } = buildProfile(dir, { root: dir, host: null, remote: null, defaultBranch: null })
    assert.deepEqual(profile.workflowReferences, [{ file, line: 4 }])
    assert.equal('ciChecks' in profile, false)
  })
})
