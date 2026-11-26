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
  buildTaskMap,
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
  workflowReferences?: unknown[]
  suggestions?: unknown[]
  modules?: unknown[]
  unanalysedDeps?: unknown[]
  files?: string[]
}

function makeSnapshot(options: SnapshotOptions = {}): DashboardSnapshot {
  const profileOk = options.profileOk ?? true
  const profile = {
    root: '/repo',
    projectDir: 'app',
    files: options.files ?? FILES,
    modules: options.modules ?? [],
    workflowReferences: options.workflowReferences ?? [],
    commands: { test: [{ cmd: 'npm test', source: 'documented', evidence: 'README.md:3' }] },
    diagnostics: {
      unanalysedDeps: options.unanalysedDeps ?? [],
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
            detail:
              'Document a changed-files test command -- A test command is available but no changed-files subset is documented.',
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
    verification: {
      status: 'unavailable',
      verdict: 'none',
      reason: 'not persisted',
      currentRevision: null,
      incompleteCount: 0,
      evidence: [],
    },
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

    assert.deepEqual(brief.blockers, [{ label: 'java', status: 'missing', reason: 'not on PATH', grantedBy: null }])
    assert.deepEqual(brief.gates, [])
    assert.deepEqual(brief.readiness, { ok: true, checked: true, status: 'blocked' })
    const unknowns = brief.unknowns.join('\n')
    assert.match(unknowns, /not validated against a tracker/)
    assert.match(unknowns, /No approval gate was found/)
    assert.match(unknowns, /read-only/)
    assert.match(unknowns, /Verification history/)
  })

  test('workflow sources are read-only citations, never runnable checks', () => {
    const snapshot = makeSnapshot({
      commands: [],
      workflowReferences: [
        { file: '.github/workflows/ci.yml', line: 45 },
        { file: '.github/workflows/ci.yml', line: 233 },
        { file: '.github/workflows/ci.yml', line: 274 },
      ],
    })
    const brief = buildTaskBrief(snapshot, { text: 'Localize the map accessibility descriptions' })
    assert.deepEqual(brief.howToCheck, [])
    assert.deepEqual(brief.workflowReferences, [
      { file: '.github/workflows/ci.yml', line: 45 },
      { file: '.github/workflows/ci.yml', line: 233 },
      { file: '.github/workflows/ci.yml', line: 274 },
    ])
    const unknowns = brief.unknowns.join('\n')
    assert.match(unknowns, /read-only sources, not checks/)
    assert.match(unknowns, /TalkBack/)
    assert.doesNotMatch(unknowns, /complete/i)
  })

  test('a profile without workflow references says CI coverage is unknown, not empty', () => {
    const brief = buildTaskBrief(makeSnapshot({ commands: [] }), { text: 'Verify the change' })
    assert.deepEqual(brief.workflowReferences, [])
    assert.match(brief.unknowns.join('\n'), /CI coverage is unknown, not empty/)
  })

  test('a declared check in a nested directory outranks a stale root README command', () => {
    // Acceptance case: the nested-project fixture. The root README points at a retired
    // command; the owner-declared check lives in packages/sub. The brief must follow the
    // declaration and carry its working directory, not the stale prose.
    const snapshot = makeSnapshot({
      commands: [
        { kind: 'test', cmd: 'node verify.js', source: 'declared', evidence: 'anvil.config.json', dir: 'packages/sub' },
        { kind: 'test', cmd: 'npm run test:old', source: 'documented', evidence: 'README.md:8', dir: '' },
      ],
    })

    const brief = buildTaskBrief(snapshot, { text: 'Find and run the supported verification check' })
    assert.equal(brief.howToCheck[0]?.cmd, 'node verify.js')
    assert.equal(brief.howToCheck[0]?.scope, 'local')
    assert.equal(brief.howToCheck[0]?.source, 'declared')
    assert.equal(brief.howToCheck[0]?.evidence, 'anvil.config.json')
    assert.equal(brief.howToCheck[0]?.cwd, 'packages/sub')
    assert.ok(!brief.howToCheck.some((check) => check.cmd === 'npm run test:old'))
  })

  test('the approval gate a ticket states is quoted, with what may start first', () => {
    // The acceptance wording from CountryTracker #132, which allows the audit first.
    const brief = buildTaskBrief(makeSnapshot(), {
      text: [
        'Review the visual experience of the main user flows.',
        '',
        '## Acceptance criteria',
        '- The audit and proposal are approved before implementation; priority improvements are documented.',
        '- All existing flows remain functional.',
      ].join('\n'),
    })

    assert.deepEqual(brief.gates, [
      {
        kind: 'approval',
        startNow: 'audit and proposal',
        waitFor: 'implementation',
        evidence: 'The audit and proposal are approved before implementation; priority improvements are documented.',
      },
    ])
    assert.match(brief.unknowns.join('\n'), /quoted from the pasted text/)
    assert.doesNotMatch(brief.unknowns.join('\n'), /No approval gate was found/)
  })

  test('a gate that only names approval blocks nothing specific and invents nothing', () => {
    const brief = buildTaskBrief(makeSnapshot(), {
      text: 'Update the design system. Implementation requires approval from the security team.',
    })
    assert.equal(brief.gates.length, 1)
    assert.equal(brief.gates[0]?.waitFor, null)
    assert.match(brief.gates[0]?.evidence ?? '', /requires approval/)
  })

  test('an explicit "before" gate names what waits without inventing what may start', () => {
    for (const text of [
      'Approval is required before merge.',
      'Sign-off required before merge.',
      'Do not merge without approval.',
      'Do not merge without approval; no approval required for the audit.',
    ]) {
      const brief = buildTaskBrief(makeSnapshot(), { text })
      assert.equal(brief.gates.length, 1, text)
      assert.equal(brief.gates[0]?.startNow, null, text)
      assert.equal(brief.gates[0]?.waitFor, 'merge', text)
    }
  })

  test('a waiver is quoted as an absence, never applied as a gate', () => {
    for (const text of [
      'Implementation should not wait for approval.',
      'No approval required for implementation.',
      'Approval is not required for this change.',
      "We don't need approval to ship this.",
    ]) {
      const brief = buildTaskBrief(makeSnapshot(), { text })
      assert.deepEqual(brief.gates, [], text)
      assert.match(brief.unknowns.join('\n'), /says approval is not required/, text)
      assert.ok(
        brief.unknowns.some((note) => note.includes(text)),
        text,
      )
      assert.doesNotMatch(brief.unknowns.join('\n'), /No approval gate was found/, text)
    }
  })

  test('a clause-local waiver does not suppress an explicit gate in another clause', () => {
    const text = 'No approval is required to audit, but implementation requires approval.'
    const brief = buildTaskBrief(makeSnapshot(), { text })
    assert.equal(brief.gates.length, 1, text)
    assert.equal(brief.gates[0]?.kind, 'approval')
    assert.match(brief.gates[0]?.evidence ?? '', /implementation requires approval/)

    const waiverNote = brief.unknowns.find((note) => /says approval is not required/.test(note))
    assert.ok(waiverNote, 'the waiver is still quoted as a note')
    assert.match(waiverNote ?? '', /No approval is required to audit/)
    assert.doesNotMatch(
      waiverNote ?? '',
      /implementation requires approval/,
      'the waiver must not label the whole sentence',
    )
  })

  test('waivers joined without a comma still leave a later explicit gate in place', () => {
    for (const text of [
      'No approval is required to audit but implementation requires approval.',
      'No approval is required to audit, whereas implementation requires approval.',
      'No approval is required to audit, and implementation requires approval.',
      'No approval is required to audit and implementation requires approval.',
      'Implementation requires approval and no approval is required to audit.',
      'No approval is required to audit and approval is required before implementation.',
      'Implementation requires approval and approval is optional for the audit.',
      'No approval is required to audit and do not implement without approval.',
      'Implementation requires approval; no approval is required to audit.',
    ]) {
      const brief = buildTaskBrief(makeSnapshot(), { text })
      assert.equal(brief.gates.length, 1, text)
      assert.equal(brief.gates[0]?.kind, 'approval', text)
      const waiverNote = brief.unknowns.find((note) => /says approval is not required/.test(note))
      assert.ok(waiverNote, `the waiver is still quoted as a note: ${text}`)
      assert.doesNotMatch(waiverNote ?? '', /implementation requires approval/i, text)
    }
  })

  test('a pure waiver and a single explicit gate keep their existing readings', () => {
    const waived = buildTaskBrief(makeSnapshot(), { text: 'No approval is required for the audit.' })
    assert.deepEqual(waived.gates, [])
    assert.match(waived.unknowns.join('\n'), /says approval is not required/)

    const gated = buildTaskBrief(makeSnapshot(), { text: 'Implementation requires approval before merge.' })
    assert.equal(gated.gates.length, 1)
    assert.equal(gated.gates[0]?.waitFor, 'merge')
    assert.match(gated.gates[0]?.evidence ?? '', /requires approval before merge/)
  })

  test('uncertain approval wording is shown without assigning a gate', () => {
    for (const text of [
      'Approval might be needed before implementation.',
      'Implementation may require approval.',
      'Is approval required before merge?',
      'If approval is required before merge, ask the team.',
      'The proposal was approved before implementation.',
      'The proposal was not approved before implementation.',
    ]) {
      const brief = buildTaskBrief(makeSnapshot(), { text })
      assert.deepEqual(brief.gates, [], text)
      assert.match(brief.unknowns.join('\n'), /mentioned but not stated as a requirement/, text)
      assert.ok(
        brief.unknowns.some((note) => note.includes(text)),
        text,
      )
    }
  })

  test('a gate written inside a longer sentence keeps both halves', () => {
    const brief = buildTaskBrief(makeSnapshot(), {
      text: 'Note that the audit is approved before implementation, so start there.',
    })
    assert.equal(brief.gates.length, 1)
    assert.equal(brief.gates[0]?.startNow, 'audit')
    assert.equal(brief.gates[0]?.waitFor, 'implementation')
  })

  test('ordinary review prose is not turned into an approval gate', () => {
    const brief = buildTaskBrief(makeSnapshot(), {
      text: 'Review the list screen and fix the spacing. A reviewer should read the diff.',
    })
    assert.deepEqual(brief.gates, [])
    assert.match(brief.unknowns.join('\n'), /No approval gate was found/)
  })

  test('a failed readiness source is unknown, not a clean report', () => {
    const snapshot = makeSnapshot()
    snapshot.repository.ready = {
      ok: false,
      data: null,
      error: 'ready exploded',
      fetchedAt: '2026-11-19T10:00:00.000Z',
      command: 'anvil ready --json',
    }
    const brief = buildTaskBrief(snapshot, { text: 'Update README.md' })

    assert.deepEqual(brief.blockers, [])
    assert.deepEqual(brief.readiness, { ok: false, checked: false, status: null })
    assert.match(brief.unknowns.join('\n'), /anvil ready. failed|`anvil ready` failed/)
  })

  test('an exact path outranks a lookalike that only shares its ending', () => {
    const snapshot = makeSnapshot()
    const profile = snapshot.repository.profile.data as { files: string[] }
    profile.files = ['examples/src/auth.ts', 'src/auth.ts']

    const brief = buildTaskBrief(snapshot, { text: 'Change src/auth.ts so the token refresh retries.' })

    assert.deepEqual(
      brief.startHere.map((item) => item.path),
      ['src/auth.ts', 'examples/src/auth.ts'],
    )
    assert.equal(brief.startHere[0]?.reason, 'named in the task text')
    assert.equal(brief.startHere[1]?.reason, 'matches the end of a repository path')
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
    // The plan's own title is the observed state; the brief names the action instead.
    assert.equal(brief.title, 'Document a changed-files test command')
    assert.equal(brief.objective, 'A test command is available but no changed-files subset is documented.')
    assert.deepEqual(brief.startHere, [
      { path: 'README.md', reason: 'evidence named by the suggestion', kind: 'evidence' },
    ])
    assert.match(brief.unknowns.join('\n'), /engineering improvement/)
    assert.match(brief.unknowns.join('\n'), /carries no approval gate or owner/)
    assert.doesNotMatch(brief.unknowns.join('\n'), /No approval gate was found in the pasted text/)
    assert.doesNotMatch(brief.unknowns.join('\n'), /not validated against a tracker/)
  })

  test('an unprobed environment and a failed profile are unknown, not empty', () => {
    const brief = buildTaskBrief(makeSnapshot({ checked: false, profileOk: false, commands: [] }), {
      text: 'Update README.md',
    })

    assert.deepEqual(brief.startHere, [])
    const unknowns = brief.unknowns.join('\n')
    assert.match(unknowns, /profile source failed/)
    assert.match(unknowns, /No verification command/)
    assert.match(unknowns, /README\.md/)
    // A failed profile is unknown coverage, not "every detected check is shown".
    assert.deepEqual(brief.workflowReferences, [])
    assert.match(unknowns, /Workflow sources are unknown/)
    assert.equal(brief.readiness.checked, false)
  })

  test('recorded verification is shown as a bounded snapshot, not a current pass', () => {
    const snapshot = makeSnapshot({ checked: true })
    snapshot.verification = {
      status: 'recorded',
      verdict: 'legacy',
      reason: 'Recorded by an explicit, bounded verification run.',
      currentRevision: null,
      incompleteCount: 0,
      evidence: [
        {
          command: 'npm test',
          revision: 'abcdef1234',
          exitCode: 0,
          timestamp: '2026-11-20T10:00:00.000Z',
          matchesCurrent: false,
          format: 1,
          verdict: 'legacy',
          cwd: null,
          planDigest: null,
          claim: null,
          clean: null,
        },
      ],
    }
    const brief = buildTaskBrief(snapshot, { text: 'Update README.md' })

    assert.deepEqual(brief.verification, snapshot.verification)
    assert.match(brief.unknowns.join('\n'), /not a claim that the current worktree passes/)
  })

  test('an unprobed environment is reported once, in the blockers section', () => {
    const brief = buildTaskBrief(makeSnapshot({ checked: false }), { text: 'Update README.md' })

    const unprobed = brief.unknowns.filter((entry) => /was not probed/.test(entry))
    assert.equal(unprobed.length, 0)
    assert.deepEqual(brief.readiness, { ok: true, checked: false, status: 'blocked' })
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
    // The cap is on the raw text: padding with 4,001 spaces then a real character must not trim
    // down to a one-character task that slips past the documented 4,000-character limit.
    assert.throws(() => buildTaskBrief(makeSnapshot(), { text: `${' '.repeat(MAX_TASK_TEXT + 1)}x` }), TaskInputError)
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

describe('the task-centred 2D map', () => {
  const modules = [
    { id: 'app', path: 'app', kind: 'package', deps: ['core'] },
    { id: 'core', path: 'core', kind: 'package', deps: [] },
    { id: 'tools', path: 'tools', kind: 'package', deps: [] },
  ]

  test('shows the task subgraph plus one hop, with evidence on every node', () => {
    const snapshot = makeSnapshot({ modules })
    const brief = buildTaskBrief(snapshot, { text: 'Fix CountryDetailScreen.kt dialog state' })
    const map = buildTaskMap(snapshot, brief)
    const labels = map.nodes.map((node) => node.label)
    assert.ok(labels.includes('app/src/main/kotlin/com/example/CountryDetailScreen.kt'), labels.join(', '))
    assert.ok(labels.includes('app'), labels.join(', '))
    assert.ok(labels.includes('core'), labels.join(', '))
    assert.ok(!labels.includes('tools'), 'an unrelated module must not enter the task subgraph')
    assert.ok(
      map.nodes.some((node) => node.kind === 'check'),
      labels.join(', '),
    )
    assert.ok(
      map.nodes.every((node) => node.evidence !== null),
      JSON.stringify(map.nodes),
    )
    assert.ok(
      map.edges.some((edge) => edge.from === 'module:app' && edge.to === 'module:core' && edge.evidence !== null),
      JSON.stringify(map.edges),
    )
  })

  test('the root module at path "." contains a nested task file', () => {
    // A single-module repo reports its module at path '.'. A nested file such as
    // src/server.ts is inside it, so the map must carry the module node and a containment edge.
    const snapshot = makeSnapshot({
      files: ['src/server.ts', 'README.md'],
      modules: [{ id: 'acme-api', path: '.', kind: 'package', deps: [] }],
    })
    const brief = buildTaskBrief(snapshot, { text: 'Update src/server.ts' })
    assert.ok(
      brief.startHere.some((item) => item.path === 'src/server.ts'),
      'the nested file must be matched',
    )
    const map = buildTaskMap(snapshot, brief)
    assert.ok(
      map.nodes.some((node) => node.id === 'module:acme-api' && node.kind === 'module'),
      JSON.stringify(map.nodes),
    )
    assert.ok(
      map.edges.some(
        (edge) => edge.from === 'file:src/server.ts' && edge.to === 'module:acme-api' && edge.label === 'located in',
      ),
      JSON.stringify(map.edges),
    )
  })

  test('an unanalysed module is a visible unknown, not an absent dependency', () => {
    const snapshot = makeSnapshot({
      modules,
      unanalysedDeps: [{ id: 'app', path: 'app', reason: 'no dependency resolver for this ecosystem' }],
    })
    const brief = buildTaskBrief(snapshot, { text: 'Fix CountryDetailScreen.kt dialog state' })
    const map = buildTaskMap(snapshot, brief)
    assert.equal(map.hasUnknown, true)
    assert.ok(map.nodes.some((node) => node.kind === 'unknown' && node.label.includes('unknown dependencies for app')))
    assert.ok(map.edges.some((edge) => edge.label === 'dependencies unknown'))
  })

  test('an older profile without coverage data says dependency coverage is unknown', () => {
    const snapshot = makeSnapshot({ modules })
    const profile = snapshot.repository.profile.data as Record<string, unknown>
    delete profile.diagnostics
    const brief = buildTaskBrief(snapshot, { text: 'Fix CountryDetailScreen.kt dialog state' })
    const map = buildTaskMap(snapshot, brief)
    assert.equal(map.hasUnknown, true)
    assert.ok(map.nodes.some((node) => node.id === 'unknown:coverage' && node.evidence === null))
  })

  test('a failed profile adds no invented module nodes', () => {
    const snapshot = makeSnapshot({ profileOk: false, modules })
    const brief = buildTaskBrief(snapshot, { text: 'Fix CountryDetailScreen.kt dialog state' })
    const map = buildTaskMap(snapshot, brief)
    assert.equal(
      map.nodes.some((node) => node.kind === 'module'),
      false,
    )
    assert.equal(
      map.nodes.some((node) => node.kind === 'file'),
      false,
    )
    assert.ok(map.nodes.some((node) => node.kind === 'check'))
    assert.ok(map.nodes.some((node) => node.id === 'unknown:coverage'))
  })
})

describe('the blocker handoff', () => {
  test('names only measured blockers and never guesses an owner', () => {
    const snapshot = makeSnapshot()
    const brief = buildTaskBrief(snapshot, { text: 'Fix CountryDetailScreen.kt dialog state' })
    assert.equal(brief.handoff.available, true)
    assert.match(brief.handoff.text, /Blocker handoff/)
    assert.match(brief.handoff.text, /java \(missing\): not on PATH/)
    assert.match(brief.handoff.text, /Owner: unknown/)
    assert.doesNotMatch(brief.handoff.text, /@/)
    assert.ok(brief.handoff.sources.includes('anvil ready --json'))
  })

  test('a failed readiness source says so instead of producing a clean handoff', () => {
    const snapshot = makeSnapshot({ checked: false })
    snapshot.repository.ready = { ...snapshot.repository.ready, ok: false }
    const brief = buildTaskBrief(snapshot, { text: 'Fix CountryDetailScreen.kt dialog state' })
    assert.equal(brief.handoff.available, false)
    assert.match(brief.handoff.text, /anvil ready failed/)
    assert.match(brief.handoff.text, /Owner: unknown/)
  })

  test('a contact declared in the readiness report is carried into the handoff', () => {
    const snapshot = makeSnapshot()
    const ready = snapshot.repository.ready.data as Record<string, unknown>
    ready.credentials = [{ id: 'npm-token', status: 'missing', required: true, grantedBy: 'platform team', env: [] }]
    const brief = buildTaskBrief(snapshot, { text: 'Fix CountryDetailScreen.kt dialog state' })
    assert.ok(brief.blockers.some((blocker) => blocker.grantedBy === 'platform team'))
    assert.match(brief.handoff.text, /Declared contact: platform team/)
    assert.match(brief.handoff.text, /not inferred/)
  })

  test('an aggregate blocked status with no named cause is not a measured handoff', () => {
    const snapshot = makeSnapshot({ checked: true, commands: [] })
    const ready = snapshot.repository.ready.data as Record<string, unknown>
    ready.status = 'blocked'
    ready.tools = []
    const brief = buildTaskBrief(snapshot, { text: 'Fix CountryDetailScreen.kt dialog state' })
    assert.equal(brief.handoff.available, false)
    assert.match(brief.handoff.text, /no individual need named a cause/)
  })

  test('a declared CODEOWNERS path is cited as routing, not as an owner', () => {
    const snapshot = makeSnapshot()
    const profile = snapshot.repository.profile.data as Record<string, unknown>
    profile.docs = { codeowners: '.github/CODEOWNERS' }
    const brief = buildTaskBrief(snapshot, { text: 'Fix CountryDetailScreen.kt dialog state' })
    assert.match(brief.handoff.text, /declared review routing at \.github\/CODEOWNERS/)
    assert.match(brief.handoff.text, /Owner: unknown/)
    assert.ok(brief.handoff.sources.some((source) => source.includes('docs.codeowners')))
  })

  test('an unprobed environment produces no measured handoff', () => {
    const snapshot = makeSnapshot({ checked: false, commands: [] })
    const ready = snapshot.repository.ready.data as Record<string, unknown>
    ready.status = 'unknown'
    ready.tools = []
    const brief = buildTaskBrief(snapshot, { text: 'Fix CountryDetailScreen.kt dialog state' })
    assert.equal(brief.blockers.length, 0)
    assert.equal(brief.handoff.available, false)
    assert.match(brief.handoff.text, /environment was not probed/)
  })
})
