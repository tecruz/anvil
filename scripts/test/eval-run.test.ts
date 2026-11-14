import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { EvalRunRecord, EvalScenario } from '../../packages/cli/src/eval-gate.ts'
import {
  atomicWriteJson,
  captureInstalledSkill,
  completedResultsFromRecord,
  explainSkillAccess,
  type InstalledSkillArtifact,
  isCheckCommand,
  observeSkillAccess,
  parseOpenCodeRunEvents,
  run,
} from '../eval.ts'

const temps: string[] = []
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

/**
 * Rewrite a file until the host records a new `ctime`.
 *
 * Two back-to-back writes can land in the same file-clock tick, and a comparison that
 * relies on `ctime` then has nothing to see. A real agent process always starts after
 * that tick, so waiting one out models the run instead of the test's own speed. If the
 * host never moves the clock, the caller skips rather than asserting on a platform limit.
 */
function rewriteAcrossClockTick(path: string, content: string, capturedCtime: bigint): boolean {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    writeFileSync(path, content, 'utf8')
    if (statSync(path, { bigint: true }).ctimeNs !== capturedCtime) return true
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
  }
  return false
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
  const none = { executions: [], reads: [], skills: [] }

  /** A worktree with the skill installed, as a verified install leaves it. */
  function installedRoot(): string {
    const root = temp('anvil-eval-skill-access-')
    const directory = join(root, '.agents', 'skills', skill.name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'SKILL.md'), '# release notes\n', 'utf8')
    return root
  }

  /** The identity the harness captures before the agent runs. */
  function capture(root: string): InstalledSkillArtifact {
    const installed = captureInstalledSkill(root, skill.name)
    assert.notEqual(installed, null, 'the fixture must contain the installed skill')
    return installed as InstalledSkillArtifact
  }

  function installedPath(root: string): string {
    return join(root, '.agents', 'skills', skill.name, 'SKILL.md')
  }

  test('a read of the installed file is observed, however the path is written', () => {
    const root = installedRoot()
    const installed = capture(root)
    for (const path of ['.agents/skills/release-notes/SKILL.md', installedPath(root)]) {
      assert.equal(observeSkillAccess(skill, { ...none, reads: [{ path }] }, root, installed), 'observed', path)
    }
  })

  test('a read from another checkout is not this run’s artifact', () => {
    const root = installedRoot()
    const other = installedRoot()
    assert.equal(
      observeSkillAccess(skill, { ...none, reads: [{ path: installedPath(other) }] }, root, capture(root)),
      'not-observed',
    )
  })

  test('a copy inside the repository is a different file', () => {
    const root = installedRoot()
    const copy = join(root, 'copy', '.agents', 'skills', skill.name)
    mkdirSync(copy, { recursive: true })
    writeFileSync(join(copy, 'SKILL.md'), '# release notes\n', 'utf8')
    assert.equal(
      observeSkillAccess(
        skill,
        { ...none, reads: [{ path: 'copy/.agents/skills/release-notes/SKILL.md' }] },
        root,
        capture(root),
      ),
      'not-observed',
    )
  })

  test('a sibling skill with a longer name is not this artifact', () => {
    const root = installedRoot()
    assert.equal(
      observeSkillAccess(
        skill,
        {
          ...none,
          reads: [{ path: '.agents/skills/release-notes-other/SKILL.md' }],
          skills: [{ id: 'release-notes-other' }],
        },
        root,
        capture(root),
      ),
      'not-observed',
    )
  })

  test('a shell command that merely names the path is not access evidence', () => {
    const root = installedRoot()
    const installed = capture(root)
    for (const command of [
      'cat .agents/skills/release-notes/SKILL.md',
      'echo .agents/skills/release-notes/SKILL.md',
      'rm .agents/skills/release-notes/SKILL.md',
    ]) {
      assert.equal(
        observeSkillAccess(skill, { ...none, executions: [{ command }] }, root, installed),
        'not-observed',
        command,
      )
    }
  })

  test('a native load alone stays unknown, because another source can shadow the id', () => {
    const root = installedRoot()
    assert.equal(
      observeSkillAccess(skill, { ...none, skills: [{ id: 'release-notes' }] }, root, capture(root)),
      'unknown',
    )
  })

  test('a native load with a read of the installed file is observed', () => {
    const root = installedRoot()
    assert.equal(
      observeSkillAccess(
        skill,
        {
          ...none,
          reads: [{ path: '.agents/skills/release-notes/SKILL.md' }],
          skills: [{ id: 'release-notes' }],
        },
        root,
        capture(root),
      ),
      'observed',
    )
  })

  test('no tool events at all stays unknown, because absence is not proof of non-use', () => {
    const root = installedRoot()
    assert.equal(observeSkillAccess(skill, none, root, capture(root)), 'unknown')
  })

  test('records why each verdict was reached, so an unknown can be investigated later', () => {
    const root = installedRoot()
    const installed = capture(root)
    assert.deepEqual(explainSkillAccess(skill, none, root, installed), {
      access: 'unknown',
      reason: 'no-tool-events',
    })
    assert.deepEqual(explainSkillAccess(skill, { ...none, skills: [{ id: 'release-notes' }] }, root, installed), {
      access: 'unknown',
      reason: 'native-load-unattributable',
    })
    assert.deepEqual(explainSkillAccess(skill, { ...none, reads: [{ path: installedPath(root) }] }, root, null), {
      access: 'unknown',
      reason: 'artifact-not-attributable',
    })
    assert.deepEqual(explainSkillAccess(skill, { ...none, reads: [{ path: installedPath(root) }] }, root, installed), {
      access: 'observed',
      reason: 'read-of-installed-artifact',
    })
    assert.deepEqual(explainSkillAccess(skill, { ...none, reads: [{ path: 'README.md' }] }, root, installed), {
      access: 'not-observed',
      reason: 'no-read-of-installed-artifact',
    })
  })

  test('a redirected installed path cannot attribute a read, not even of that path', () => {
    // The attack: read a copy elsewhere in the repository, then point the installed path at
    // it. Comparing paths after the agent finishes would describe the replacement.
    const root = installedRoot()
    const installed = capture(root)
    const other = installedRoot()
    rmSync(join(root, '.agents', 'skills', skill.name), { recursive: true, force: true })
    symlinkSync(
      join(other, '.agents', 'skills', skill.name),
      join(root, '.agents', 'skills', skill.name),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    assert.equal(
      observeSkillAccess(skill, { ...none, reads: [{ path: installedPath(other) }] }, root, installed),
      'unknown',
    )
    assert.equal(
      observeSkillAccess(skill, { ...none, reads: [{ path: installedPath(root) }] }, root, installed),
      'unknown',
    )
  })

  test('a read alias redirected after the read is not this run’s artifact', () => {
    // The attack: read a copy, then replace that copy's directory with a junction to the
    // unchanged installed skill. Resolving the reported read now would point it at the
    // artifact and call the earlier read access.
    const root = installedRoot()
    const installed = capture(root)
    const copy = join(root, 'copy', '.agents', 'skills', skill.name)
    mkdirSync(copy, { recursive: true })
    writeFileSync(join(copy, 'SKILL.md'), '# release notes\n', 'utf8')
    const read = { path: 'copy/.agents/skills/release-notes/SKILL.md' }

    assert.equal(observeSkillAccess(skill, { ...none, reads: [read] }, root, installed), 'not-observed')

    rmSync(copy, { recursive: true, force: true })
    symlinkSync(join(root, '.agents', 'skills', skill.name), copy, process.platform === 'win32' ? 'junction' : 'dir')

    assert.equal(observeSkillAccess(skill, { ...none, reads: [read] }, root, installed), 'not-observed')
    // The installed path itself still names the same file, so a read of it stays observed.
    assert.equal(
      observeSkillAccess(skill, { ...none, reads: [{ path: installedPath(root) }] }, root, installed),
      'observed',
    )
  })

  test('a same-path replacement with different content is not the artifact', () => {
    // A pathname snapshot would still match after the file is swapped. The digest captured
    // before the agent is what says whether the bytes read were the artifact.
    const root = installedRoot()
    const installed = capture(root)
    writeFileSync(installedPath(root), '# something else\n', 'utf8')

    assert.equal(
      observeSkillAccess(skill, { ...none, reads: [{ path: installedPath(root) }] }, root, installed),
      'unknown',
    )
    // The identity was captured, so this is not the `installed === null` path: the artifact
    // changed after capture and the reason says exactly that.
    assert.deepEqual(explainSkillAccess(skill, { ...none, reads: [{ path: installedPath(root) }] }, root, installed), {
      access: 'unknown',
      reason: 'artifact-not-attributable',
    })
  })

  test('a read after the original bytes are restored is not the artifact', (t) => {
    // A comparison of endpoint bytes cannot see this: the agent overwrites the artifact,
    // reads the replacement, then restores the original content before exiting. The
    // identity captured before the run no longer describes what the read returned.
    const root = installedRoot()
    const installed = capture(root)
    const target = installedPath(root)
    writeFileSync(target, '# something else\n', 'utf8')
    // The agent read the replacement here.
    if (!rewriteAcrossClockTick(target, '# release notes\n', installed.ctimeNs)) {
      t.skip('the host file clock did not record a rewrite')
      return
    }

    assert.equal(observeSkillAccess(skill, { ...none, reads: [{ path: target }] }, root, installed), 'unknown')
  })

  test('rewriting the same bytes at the same path is not the same artifact', (t) => {
    // Even identical bytes describe a new write. The artifact was verified before the run,
    // and a file whose change time moved is no longer provably what the agent read.
    const root = installedRoot()
    const installed = capture(root)
    const target = installedPath(root)
    if (!rewriteAcrossClockTick(target, '# release notes\n', installed.ctimeNs)) {
      t.skip('the host file clock did not record a rewrite')
      return
    }

    assert.equal(observeSkillAccess(skill, { ...none, reads: [{ path: target }] }, root, installed), 'unknown')
  })

  test('a FIFO at the installed path is rejected without blocking', {
    skip: process.platform === 'win32' ? 'FIFOs are POSIX-only' : false,
  }, (t) => {
    // Reading a FIFO waits for a writer. Verification runs after the agent timeout, so a
    // blocking read here would leave the whole harness stuck instead of recording a verdict.
    const root = installedRoot()
    const target = installedPath(root)
    rmSync(target)
    const made = spawnSync('mkfifo', [target])
    if (made.error !== undefined || made.status !== 0) {
      t.skip('mkfifo is unavailable')
      return
    }
    const moduleUrl = new URL('../eval.ts', import.meta.url).href
    const script = `import { captureInstalledSkill } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(captureInstalledSkill(${JSON.stringify(root)}, ${JSON.stringify(skill.name)})))`
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 5000,
    })

    assert.equal(child.error, undefined, child.error?.message)
    assert.equal(child.status, 0, child.stderr)
    assert.equal(JSON.parse(child.stdout), null)
  })

  test('a removed installed artifact cannot be attributed', () => {
    const root = installedRoot()
    const installed = capture(root)
    rmSync(join(root, '.agents'), { recursive: true, force: true })
    assert.equal(
      observeSkillAccess(skill, { ...none, reads: [{ path: installedPath(root) }] }, root, installed),
      'unknown',
    )
    // `installed` is non-null; the re-capture is what fails, and the reason records that.
    assert.deepEqual(explainSkillAccess(skill, { ...none, reads: [{ path: installedPath(root) }] }, root, installed), {
      access: 'unknown',
      reason: 'artifact-not-attributable',
    })
  })

  test('an uncaptured identity attributes nothing', () => {
    const root = installedRoot()
    assert.equal(observeSkillAccess(skill, { ...none, reads: [{ path: installedPath(root) }] }, root, null), 'unknown')
  })
})

describe('fake-agent skill-access wiring', () => {
  test('records the reason beside every skill verdict without touching the real repository', {
    timeout: 600_000,
  }, () => {
    const source = fileURLToPath(new URL('../../', import.meta.url))
    const workspace = mkdtempSync(join(tmpdir(), 'anvil-eval-skill-wiring-'))
    const root = join(workspace, 'repo')
    const runtime = join(workspace, 'runtime')
    mkdirSync(root)
    mkdirSync(runtime)
    try {
      // Run the real harness in an isolated copy. The fake agent never calls a model, and
      // every result -- checkpoints and run.json -- lands under the copy, never this repo.
      const skip = new Set(['node_modules', 'dist', '.git'])
      for (const path of [
        'packages',
        'eval',
        'scripts/eval.ts',
        'scripts/eval-check-broker.ts',
        'scripts/build.mjs',
        'package.json',
        'package-lock.json',
      ]) {
        cpSync(join(source, path), join(root, path), {
          recursive: true,
          filter: (entry) => !skip.has(basename(entry)),
        })
      }
      symlinkSync(
        join(source, 'node_modules'),
        join(root, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir',
      )
      // The child has to be hermetic through its environment alone. The developer's global
      // Git config may enable signing or hooks that the copied harness's commits do not
      // expect, and the harness's temp dirs must land under this test's runtime dir.
      const gitConfig = join(workspace, 'gitconfig')
      const hooks = join(workspace, 'hooks')
      writeFileSync(gitConfig, '')
      mkdirSync(hooks)
      const env: NodeJS.ProcessEnv = { ...process.env, TMP: runtime, TEMP: runtime, TMPDIR: runtime }
      delete env.ANVIL_EVAL
      // The harness must run fixture test discovery, not inherit this parent's test context.
      delete env.NODE_TEST_CONTEXT
      for (const key of Object.keys(env)) {
        if (key.startsWith('GIT_CONFIG_KEY_') || key.startsWith('GIT_CONFIG_VALUE_')) delete env[key]
      }
      delete env.GIT_DIR
      delete env.GIT_WORK_TREE
      delete env.GIT_INDEX_FILE
      env.GIT_CONFIG_GLOBAL = gitConfig
      env.GIT_CONFIG_NOSYSTEM = '1'
      env.GIT_CONFIG_COUNT = '3'
      env.GIT_CONFIG_KEY_0 = 'commit.gpgsign'
      env.GIT_CONFIG_VALUE_0 = 'false'
      env.GIT_CONFIG_KEY_1 = 'core.hooksPath'
      env.GIT_CONFIG_VALUE_1 = hooks
      env.GIT_CONFIG_KEY_2 = 'tag.gpgsign'
      env.GIT_CONFIG_VALUE_2 = 'false'
      // The harness passes user.name/user.email with `git -c` on its own commits; this gives
      // any commit the anvil CLI makes in the child an identity without a global config.
      env.GIT_AUTHOR_NAME = 'anvil eval'
      env.GIT_AUTHOR_EMAIL = 'eval@anvil.local'
      env.GIT_COMMITTER_NAME = 'anvil eval'
      env.GIT_COMMITTER_EMAIL = 'eval@anvil.local'
      const invocation = spawnSync(
        process.execPath,
        ['scripts/eval.ts', '--fake-agent', '--scenario', 'skill-guidance'],
        { cwd: root, env, encoding: 'utf8', timeout: 540_000 },
      )
      assert.equal(invocation.error, undefined, invocation.error?.message)
      assert.equal(invocation.status, 0, `${invocation.stdout}\n${invocation.stderr}`)

      const record = JSON.parse(readFileSync(join(root, 'eval-results', 'run.json'), 'utf8')) as EvalRunRecord
      assert.equal(record.results.length, 2)
      const bare = record.results.find((result) => result.variant === 'bare')!
      const anvil = record.results.find((result) => result.variant === 'anvil')!

      assert.equal(bare.skillInstall, 'not-installed')
      assert.equal(bare.skillAccess, 'not-installed')
      assert.equal(bare.skillAccessReason, 'not-installed')
      assert.equal(anvil.skillInstall, 'verified')
      assert.equal(anvil.skillAccess, 'unknown')
      assert.equal(anvil.skillAccessReason, 'no-tool-events')
    } finally {
      rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
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
        skillAccessReason: 'read-of-installed-artifact',
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

  test('a resumed report keeps skillInstall, skillAccess and the access reason', () => {
    const [result] = completedResultsFromRecord(record, scenarios)
    assert.equal(result?.skillInstall, 'verified')
    assert.equal(result?.skillAccess, 'observed')
    assert.equal(result?.skillAccessReason, 'read-of-installed-artifact')
    assert.equal(result?.verified, true)
    assert.equal(result?.hiddenVerified, true)
  })
})

describe('atomicWriteJson failure handling', () => {
  const failingRename = (error: Error) => () => {
    throw error
  }

  test('a failed rename leaves the previous checkpoint intact with no temp file', () => {
    const dir = temp('anvil-eval-atomic-existing-')
    const target = join(dir, 'checkpoint.json')
    const previous = { schemaVersion: 3, value: 'previous' }
    const next = { schemaVersion: 3, value: 'next' }
    atomicWriteJson(target, previous)
    const bytes = readFileSync(target, 'utf8')
    const failure = Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })

    let thrown: unknown
    try {
      atomicWriteJson(target, next, failingRename(failure))
    } catch (error) {
      thrown = error
    }

    assert.equal(thrown, failure)
    assert.equal(readFileSync(target, 'utf8'), bytes)
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), previous)
    assert.deepEqual(readdirSync(dir), ['checkpoint.json'])
  })

  test('a failed rename on a fresh path leaves no target and no temp file', () => {
    const dir = temp('anvil-eval-atomic-fresh-')
    const target = join(dir, 'checkpoint.json')
    const failure = Object.assign(new Error('EBUSY: resource busy, rename'), { code: 'EBUSY' })

    let thrown: unknown
    try {
      atomicWriteJson(target, { schemaVersion: 3, value: 'next' }, failingRename(failure))
    } catch (error) {
      thrown = error
    }

    assert.equal(thrown, failure)
    assert.equal(existsSync(target), false)
    assert.deepEqual(readdirSync(dir), [])
  })
})
