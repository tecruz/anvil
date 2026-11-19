/**
 * The task brief's contract tests.
 *
 * They use a DashboardSnapshot shaped like the CLI envelopes, so no process runs and no
 * repository is touched. The cases that matter are the honest ones: a suggestion with file
 * evidence, pasted ticket text that names a file and a feature, a missing tool, and the
 * sources that make an answer unknown rather than empty.
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  buildTaskBrief,
  type DashboardSnapshot,
  type DashboardSource,
  MAX_TASK_TEXT,
  TaskInputError,
} from '@anvil/dashboard'

const FILES = [
  'README.md',
  'AGENTS.md',
  'app/src/main/kotlin/com/example/CountryDetailScreen.kt',
  'app/src/main/kotlin/com/example/UnvisitedConfirmationDialog.kt',
  'app/src/main/kotlin/com/example/VisitStatusCard.kt',
  'app/src/main/kotlin/com/example/NotesCard.kt',
  'app/src/main/kotlin/com/example/RatingCard.kt',
  'app/src/main/kotlin/com/example/Theme.kt',
  'app/src/test/kotlin/com/example/CountryDetailScreenDialogsTest.kt',
  'app/src/test/kotlin/com/example/ThemeTest.kt',
]

function source<T>(data: T): DashboardSource<T> {
  return { ok: true, data, error: null, fetchedAt: '2026-11-19T10:00:00.000Z', command: 'anvil test --json' }
}

interface SnapshotOptions {
  profileOk?: boolean
  checked?: boolean
  truncated?: boolean
  failedDetectors?: number
  commands?: unknown[]
  suggestions?: unknown[]
}

function makeSnapshot(options: SnapshotOptions = {}): DashboardSnapshot {
  const profileOk = options.profileOk ?? true
  const profile = {
    root: '/repo',
    projectDir: 'app',
    files: FILES,
    commands: { test: [{ cmd: 'npm test', source: 'documented', evidence: 'README.md:3' }] },
    diagnostics: {
      truncated: options.truncated ?? false,
      fileLimit: 20000,
      failedDetectors: Array.from({ length: options.failedDetectors ?? 0 }, (_, index) => ({
        id: `detector-${String(index)}`,
        error: 'failed',
      })),
    },
  }
  return {
    schemaVersion: 1,
    fetchedAt: '2026-11-19T10:00:00.000Z',
    repository: {
      doctor: source({ score: 91, grade: 'A', findings: [], degraded: [] }),
      ready: source({
        status: 'blocked',
        root: '/repo',
        projectDir: 'app',
        checked: options.checked ?? true,
        commands: options.commands ?? [
          { kind: 'testFast', cmd: 'npm run test:changed', source: 'documented', evidence: 'AGENTS.md:12', dir: 'app' },
          { kind: 'test', cmd: 'npm test', source: 'documented', evidence: 'README.md:3', dir: 'app' },
          { kind: 'lint', cmd: 'npm run lint', source: 'documented', evidence: 'AGENTS.md:11', dir: 'app' },
          { kind: 'build', cmd: 'npm run build', source: 'detected', evidence: 'package.json:5', dir: 'app' },
        ],
        tools: [{ id: 'java', bin: 'java', required: true, status: 'missing', reason: 'not on PATH' }],
        env: [],
        services: [],
        references: [],
        credentials: [],
        access: [],
        hardware: [],
        context: [],
      }),
      plan: source({
        score: 91,
        satisfied: 0,
        suggestions: options.suggestions ?? [
          {
            id: 'fix:TEST_FAST',
            tier: 'derived',
            title: 'A changed-files test subset is documented',
            detail: 'Document a changed-files test command.',
            evidence: ['README.md:3'],
          },
        ],
      }),
      profile: profileOk
        ? source(profile)
        : {
            ok: false,
            data: null,
            error: 'profile exploded',
            fetchedAt: '2026-11-19T10:00:00.000Z',
            command: 'anvil profile --json',
          },
    },
    context: {
      brief: source(null),
      staged: source({
        exists: false,
        createdAt: null,
        inputHash: null,
        files: [],
        summary: { files: 0, added: 0, removed: 0 },
      }),
    },
    work: { crew: source({ crew: [] }) },
    verification: { status: 'unavailable', reason: 'not persisted' },
    notes: [],
  }
}

const TICKET =
  'Remove visit status. Notes and rating are lost when marking a country as unvisited. Update CountryDetailScreen.kt.'

describe('buildTaskBrief', () => {
  test('ticket text finds named and related files, checks and blockers', () => {
    const brief = buildTaskBrief(makeSnapshot(), { text: TICKET })

    assert.equal(brief.source.text, TICKET)
    assert.equal(brief.source.suggestionId, null)
    assert.match(brief.title, /^Remove visit status/)
    assert.equal(brief.objective, TICKET)
    assert.equal(brief.generatedAt, '2026-11-19T10:00:00.000Z')

    const paths = brief.startHere.map((item) => item.path)
    assert.equal(paths[0], 'app/src/main/kotlin/com/example/CountryDetailScreen.kt')
    assert.ok(paths.includes('app/src/main/kotlin/com/example/UnvisitedConfirmationDialog.kt'))
    assert.ok(paths.includes('app/src/main/kotlin/com/example/VisitStatusCard.kt'))
    assert.ok(paths.includes('app/src/main/kotlin/com/example/NotesCard.kt'))
    assert.ok(paths.includes('app/src/main/kotlin/com/example/RatingCard.kt'))
    assert.ok(paths.includes('app/src/test/kotlin/com/example/CountryDetailScreenDialogsTest.kt'))
    assert.equal(brief.startHere[0]?.kind, 'source')

    assert.deepEqual(
      brief.howToCheck.map((check) => check.kind),
      ['testFast', 'test', 'lint', 'build'],
    )
    assert.equal(brief.howToCheck[0]?.cmd, 'npm run test:changed')
    assert.equal(brief.howToCheck[0]?.cwd, 'app')
    assert.equal(brief.howToCheck[0]?.source, 'documented')

    assert.deepEqual(brief.blockers, [{ label: 'java', status: 'missing', reason: 'not on PATH' }])
    const unknowns = brief.unknowns.join('\n')
    assert.match(unknowns, /not validated against a tracker/)
    assert.match(unknowns, /Approval gates/)
    assert.match(unknowns, /read-only/)
    assert.match(unknowns, /Verification history/)
  })

  test('a pasted ticket is split into a title and body without repeating it', () => {
    const multiline = buildTaskBrief(makeSnapshot(), {
      text: 'Remove visit status\n\nNotes and rating are lost.',
    })
    assert.equal(multiline.title, 'Remove visit status')
    assert.equal(multiline.objective, 'Notes and rating are lost.')

    const oneLine = buildTaskBrief(makeSnapshot(), { text: 'Remove visit status' })
    assert.equal(oneLine.title, 'Remove visit status')
    assert.equal(oneLine.objective, '')
  })

  test('a plan suggestion uses its file:line evidence and is labelled an engineering improvement', () => {
    const brief = buildTaskBrief(makeSnapshot(), { suggestionId: 'fix:TEST_FAST' })

    assert.equal(brief.source.suggestionId, 'fix:TEST_FAST')
    assert.equal(brief.source.text, null)
    assert.equal(brief.title, 'A changed-files test subset is documented')
    assert.equal(brief.objective, 'Document a changed-files test command.')
    assert.deepEqual(brief.startHere, [
      { path: 'README.md', reason: 'evidence named by the suggestion', kind: 'evidence' },
    ])
    assert.match(brief.unknowns.join('\n'), /engineering improvement/)
    assert.doesNotMatch(brief.unknowns.join('\n'), /not validated against a tracker/)
  })

  test('an unprobed environment and a failed profile are unknown, not empty', () => {
    const brief = buildTaskBrief(makeSnapshot({ checked: false, profileOk: false, commands: [] }), {
      text: 'Update README.md',
    })

    assert.deepEqual(brief.startHere, [])
    const unknowns = brief.unknowns.join('\n')
    assert.match(unknowns, /was not probed/)
    assert.match(unknowns, /profile source failed/)
    assert.match(unknowns, /No verification command/)
    assert.match(unknowns, /README\.md/)
  })

  test('a truncated profile says the file index may be incomplete', () => {
    const brief = buildTaskBrief(makeSnapshot({ truncated: true, failedDetectors: 1 }), {
      text: 'Update README.md',
    })
    const unknowns = brief.unknowns.join('\n')
    assert.match(unknowns, /file limit/)
    assert.match(unknowns, /1 profile detector\(s\) failed/)
  })

  test('it refuses ambiguous, empty and unknown input', () => {
    assert.throws(() => buildTaskBrief(makeSnapshot(), {}), TaskInputError)
    assert.throws(() => buildTaskBrief(makeSnapshot(), { text: 'x', suggestionId: 'fix:TEST_FAST' }), TaskInputError)
    assert.throws(() => buildTaskBrief(makeSnapshot(), { suggestionId: 'fix:NOT_THERE' }), TaskInputError)
    assert.throws(() => buildTaskBrief(makeSnapshot(), { text: 'x'.repeat(MAX_TASK_TEXT + 1) }), TaskInputError)
    assert.throws(() => buildTaskBrief(makeSnapshot(), { suggestionId: '../etc' }), TaskInputError)
  })

  test('a named path outside the index is reported, not silently dropped', () => {
    const brief = buildTaskBrief(makeSnapshot(), { text: 'Add src/new-widget.tsx and wire it into README.md.' })
    assert.deepEqual(
      brief.startHere.map((item) => item.path),
      ['README.md'],
    )
    assert.match(brief.unknowns.join('\n'), /src\/new-widget\.tsx.*not in the file index/)
  })
})
