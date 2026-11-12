import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import type { EvalRunRecord, EvalScenario } from '../../packages/cli/src/eval-gate.ts'
import { completedResultsFromRecord, isCheckCommand, observeSkillAccess, parseOpenCodeRunEvents, run } from '../eval.ts'

const temps: string[] = []
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

describe('eval harness process environment', () => {
  test('parses OpenCode 2 shell events, with the exit status the tool observed', () => {
    // The exact shape `@opencode/cli@2.1.4` writes: the tool is named `shell`, and
    // the structured output -- including the exit status -- sits under
    // `state.metadata.metadata`.
    const output = [
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'node' } }),
      JSON.stringify({
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'shell',
          state: {
            status: 'completed',
            input: { command: 'node run-check.js' },
            metadata: { metadata: { status: 'completed', truncated: false, exit: 1 } },
          },
        },
      }),
      JSON.stringify({
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'shell',
          state: { status: 'running', input: { command: 'node not-completed.js' } },
        },
      }),
      JSON.stringify({
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'read',
          state: { status: 'completed', input: { command: 'node not-a-shell.js' } },
        },
      }),
    ].join('\n')

    assert.deepEqual(parseOpenCodeRunEvents(output), {
      text: 'node',
      executions: [{ command: 'node run-check.js', exitCode: 1 }],
      reads: [],
      skills: [],
    })
  })

  test('parses OpenCode 1 bash events, which report the exit status one level up', () => {
    const output = [
      JSON.stringify({
        type: 'tool',
        part: {
          type: 'tool',
          tool: 'bash',
          state: {
            status: 'completed',
            input: { command: 'node run-check.js' },
            metadata: { output: '(no output)', exit: 1, truncated: false },
          },
        },
      }),
    ].join('\n')

    assert.deepEqual(parseOpenCodeRunEvents(output).executions, [{ command: 'node run-check.js', exitCode: 1 }])
  })

  test('a shell event with no readable exit status is reported as unknown, not as a pass', () => {
    const output = JSON.stringify({
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'shell',
        state: { status: 'completed', input: { command: 'node run-check.js' } },
      },
    })

    assert.deepEqual(parseOpenCodeRunEvents(output).executions, [{ command: 'node run-check.js', exitCode: null }])
  })

  test('a completed read reports the file it opened, and an unfinished one does not', () => {
    const output = [
      JSON.stringify({
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'read',
          state: { status: 'completed', input: { filePath: '.agents/skills/release-notes/SKILL.md' } },
        },
      }),
      JSON.stringify({
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'read',
          state: { status: 'running', input: { filePath: 'README.md' } },
        },
      }),
    ].join('\n')

    assert.deepEqual(parseOpenCodeRunEvents(output).reads, [{ path: '.agents/skills/release-notes/SKILL.md' }])
  })

  test('a completed native skill load reports the id, and an unfinished one does not', () => {
    const output = [
      JSON.stringify({
        type: 'tool_use',
        part: { type: 'tool', tool: 'skill', state: { status: 'completed', input: { id: 'release-notes' } } },
      }),
      JSON.stringify({
        type: 'tool_use',
        part: { type: 'tool', tool: 'skill', state: { status: 'running', input: { id: 'other-skill' } } },
      }),
    ].join('\n')

    assert.deepEqual(parseOpenCodeRunEvents(output).skills, [{ id: 'release-notes' }])
  })

  test('the check command is matched on its arguments, not on its spelling', () => {
    assert.equal(isCheckCommand('node run-check.js', 'node run-check.js'), true)
    assert.equal(isCheckCommand('node run-check.js', 'node ./run-check.js'), true)
    assert.equal(isCheckCommand('node run-check.js', 'node  run-check.js'), true)
    assert.equal(isCheckCommand('node run-check.js', 'node "run-check.js"'), true)
    assert.equal(isCheckCommand('node run-check.js', ' \tnode\t./run-check.js\t '), true)
    assert.equal(isCheckCommand('node run-check.js literal', 'node ./run-check.js ./literal'), false)

    // A different script, an extra argument, or a compound command is a different
    // command: the exit status of a compound is the status of its last part.
    assert.equal(isCheckCommand('node run-check.js', 'node other-check.js'), false)
    assert.equal(isCheckCommand('node run-check.js', 'node run-check.js --force'), false)
    assert.equal(isCheckCommand('node run-check.js', 'node run-check.js && echo done'), false)
    assert.equal(isCheckCommand('node run-check.js', 'echo node run-check.js'), false)
    assert.equal(isCheckCommand('node run-check.js', ''), false)
  })

  test('a local executable is not equivalent to a PATH-resolved executable', () => {
    for (const command of ['./node run-check.js', '.\\node run-check.js', '"node" run-check.js']) {
      assert.equal(isCheckCommand('node run-check.js', command), false, command)
    }
    assert.equal(isCheckCommand('./node run-check.js', 'node run-check.js'), false)
  })

  test('malformed or compound shell source cannot be flattened into check arguments', () => {
    const commands = [
      'node "run-check.js',
      "node 'run-check.js",
      'node\nrun-check.js',
      'node\r\nrun-check.js',
      'node run-check.js\n',
      'node\vrun-check.js',
      'node\u2028run-check.js',
      'node run-check.js\0',
      'node "run-check".js',
      'node run-check.js; echo done',
      'node run-check.js|echo done',
      'node run-check.js>report.txt',
      'node $(echo run-check.js)',
      'node `echo run-check.js`',
      'node "$CHECK_SCRIPT"',
      'node %CHECK_SCRIPT%',
      '& node run-check.js',
    ]
    for (const command of commands) {
      assert.equal(isCheckCommand('node run-check.js', command), false, JSON.stringify(command))
    }
  })

  test('shell-dependent quotes and escapes fail closed regardless of the host OS', () => {
    for (const command of ['node .\\run-check.js', 'node ".\\run-check.js"', "node 'run-check.js'"]) {
      assert.equal(isCheckCommand('node run-check.js', command), false, command)
    }
  })

  test('run sets PWD to the subprocess cwd, not the inherited PWD', async () => {
    const inherited = process.env.PWD ?? process.cwd()
    const scenario = temp('anvil-eval-scenario-')
    assert.notEqual(scenario, inherited, 'scenario must differ from the inherited directory')

    const result = await run(
      'node',
      ['-e', 'console.log(JSON.stringify({ pwd: process.env.PWD, cwd: process.cwd() }))'],
      scenario,
      { timeoutMs: 5000 },
    )

    assert.equal(result.ok, true, result.stderr || result.output)
    const reported = JSON.parse(result.stdout.trim())

    // OpenCode 2 prefers inherited PWD over cwd. The harness must override PWD so
    // the agent works in the scenario fixture, not in the directory that launched
    // the harness (the parent / repo checkout).
    assert.equal(reported.pwd, scenario, 'PWD must point at the subprocess cwd')
    assert.notEqual(reported.pwd, inherited, 'PWD must not be the inherited directory')
  })
})

describe('skill access observation', () => {
  const skill = { source: 'eval/skills/skill-guidance/SKILL.md', name: 'release-notes' }
  const root = process.platform === 'win32' ? 'C:\\repo' : '/repo'
  const none = { executions: [], reads: [], skills: [] }

  test('a read of the installed file is observed, however the path is written', () => {
    for (const path of [
      '.agents/skills/release-notes/SKILL.md',
      process.platform === 'win32'
        ? 'C:\\repo\\.agents\\skills\\release-notes\\SKILL.md'
        : '/repo/.agents/skills/release-notes/SKILL.md',
    ]) {
      assert.equal(observeSkillAccess(skill, { ...none, reads: [{ path }] }, root), 'observed', path)
    }
  })

  test('a read from another checkout is not this run’s artifact', () => {
    const path =
      process.platform === 'win32'
        ? 'C:/different-repository/.agents/skills/release-notes/SKILL.md'
        : '/different-repository/.agents/skills/release-notes/SKILL.md'
    assert.equal(observeSkillAccess(skill, { ...none, reads: [{ path }] }, root), 'not-observed')
  })

  test('a copy inside the repository is a different file', () => {
    assert.equal(
      observeSkillAccess(skill, { ...none, reads: [{ path: 'copy/.agents/skills/release-notes/SKILL.md' }] }, root),
      'not-observed',
    )
  })

  test('a sibling skill with a longer name is not this artifact', () => {
    assert.equal(
      observeSkillAccess(
        skill,
        {
          ...none,
          reads: [{ path: '.agents/skills/release-notes-other/SKILL.md' }],
          skills: [{ id: 'release-notes-other' }],
        },
        root,
      ),
      'not-observed',
    )
  })

  test('a shell command that merely names the path is not access evidence', () => {
    for (const command of [
      'cat .agents/skills/release-notes/SKILL.md',
      'echo .agents/skills/release-notes/SKILL.md',
      'rm .agents/skills/release-notes/SKILL.md',
    ]) {
      assert.equal(observeSkillAccess(skill, { ...none, executions: [{ command }] }, root), 'not-observed', command)
    }
  })

  test('a native load alone stays unknown, because another source can shadow the id', () => {
    assert.equal(observeSkillAccess(skill, { ...none, skills: [{ id: 'release-notes' }] }, root), 'unknown')
  })

  test('a native load with a read of the installed file is observed', () => {
    assert.equal(
      observeSkillAccess(
        skill,
        {
          ...none,
          reads: [{ path: '.agents/skills/release-notes/SKILL.md' }],
          skills: [{ id: 'release-notes' }],
        },
        root,
      ),
      'observed',
    )
  })

  test('no tool events at all stays unknown, because absence is not proof of non-use', () => {
    assert.equal(observeSkillAccess(skill, none, root), 'unknown')
  })
})

describe('resumed results keep every recorded fact', () => {
  const record: EvalRunRecord = {
    schemaVersion: 3,
    runId: 'run-1',
    startedAt: '2026-11-11T00:00:00.000Z',
    completedAt: '2026-11-11T00:01:00.000Z',
    completionState: 'completed',
    commitSha: null,
    implementation: 'impl-hash',
    bundleDigest: null,
    harnessDigest: 'harness-hash',
    models: [{ id: 'fake-agent', role: 'small' }],
    opencodeVersion: null,
    nodeVersion: null,
    publishTranscripts: false,
    subset: false,
    repetitions: 1,
    seed: 'seed',
    order: 'alternate',
    scenarioHashes: { 'skill-guidance': { scenarioHash: 'scenario-hash', sourceHash: 'source-hash' } },
    runKeys: ['skill-guidance/anvil/fake-agent/0'],
    executionOrder: ['skill-guidance/anvil/fake-agent/0'],
    results: [
      {
        scenario: 'skill-guidance',
        variant: 'anvil',
        model: 'fake-agent',
        modelRole: null,
        scenarioHash: 'scenario-hash',
        sourceHash: 'source-hash',
        verifyCount: 1,
        hiddenVerifyCount: 1,
        attempts: [
          { startedAt: '2026-11-11T00:00:00.000Z', completedAt: '2026-11-11T00:00:30.000Z', state: 'completed' },
        ],
        verified: true,
        hiddenVerified: true,
        verifyExitCodes: [0, 0],
        repetition: 0,
        costUsd: null,
        tokens: null,
        durationMs: 30_000,
        transcript: '',
        skillInstall: 'verified',
        skillAccess: 'observed',
      },
    ],
  }
  const scenarios = [
    {
      id: 'skill-guidance',
      size: 'tiny',
      kind: 'code-change',
      repo: 'eval/repos/skill-guidance',
      task: 'Implement releaseLine.',
      verify: ['npm test'],
      hiddenVerify: ['node --test test/hidden-release.test.js'],
      expect: { verified: true },
    },
  ] as EvalScenario[]

  test('a resumed report keeps skillInstall and skillAccess', () => {
    const [result] = completedResultsFromRecord(record, scenarios)
    assert.equal(result?.skillInstall, 'verified')
    assert.equal(result?.skillAccess, 'observed')
    assert.equal(result?.verified, true)
    assert.equal(result?.hiddenVerified, true)
  })
})
