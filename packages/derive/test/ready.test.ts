import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import {
  buildReadyReport,
  isInsideRepository,
  isRunnableExecutable,
  probeArgsFor,
  type ReadyEnvironment,
  systemEnvironment,
} from '@anvil/derive'
import type { MatchResult } from '@anvil/playbooks'
import { emptyProfile, type ProjectProfile } from '@anvil/profile'

const temps: string[] = []
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

function profileOf(overrides: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    ...emptyProfile('/repo', { host: null, remote: null, defaultBranch: null, root: '/repo' }),
    // Most tests are about the environment, not the instruction file; a present AGENTS.md
    // keeps the context need from dominating the report status. The dedicated test below
    // covers the absent case.
    instructions: [{ path: 'AGENTS.md', category: 'agents', bytes: 512 }],
    ...overrides,
  }
}

/**
 * An environment backed by explicit answers, so a test never depends on what happens to be on
 * the machine running it.
 */
function env(
  options: {
    found?: readonly string[]
    probes?: Record<string, { ok: boolean; version: string | null; inconclusive?: boolean }>
    runnable?: readonly string[]
    /** Declared variable names and the values the fake environment holds for them. */
    variables?: Record<string, string>
  } = {},
): ReadyEnvironment {
  const found = new Set(options.found ?? [])
  const runnable = new Set(options.runnable ?? [])
  return {
    // A system path, outside the profiled repository, so the containment guard does not fire.
    resolve: (bin) => (found.has(bin) ? `/usr/local/bin/${bin}` : null),
    // The probe receives the resolved path; tests key their answers by the binary name.
    probe: async (execPath) => options.probes?.[execPath.replace(/^.*[\\/]/, '')] ?? { ok: true, version: null },
    isRunnable: (absPath) => runnable.has(absPath),
    envStatus: (name) => {
      const value = options.variables?.[name]
      if (value === undefined) return 'missing'
      return value === '' ? 'empty' : 'present'
    },
  }
}

/**
 * A launcher that records the interpreter the probe pinned and succeeds.
 *
 * Injecting it makes the interpreter guard observable: a probe that is refused must record
 * nothing, and a probe that runs must record the exact interpreter anvil chose. Without it a
 * missing fake shim would make the probe inconclusive for the wrong reason.
 */
function recordingRunner(launches: string[]) {
  return async (_bin: string, _args?: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
    const interpreter = options?.env?.ComSpec
    if (interpreter !== undefined) launches.push(interpreter)
    return { stdout: '1.2.3', stderr: '', exitCode: 0 }
  }
}

/** An environment that fails the test if touched: proof that a path spawned nothing. */
function untouchedEnv(): ReadyEnvironment {
  return {
    resolve(bin) {
      throw new Error(`environment.resolve called for ${bin} without --check`)
    },
    async probe(bin) {
      throw new Error(`environment.probe called for ${bin} without --check`)
    },
    isRunnable(absPath) {
      throw new Error(`environment.isRunnable called for ${absPath} without --check`)
    },
    envStatus(name) {
      throw new Error(`environment.envStatus called for ${name} without --check`)
    },
  }
}

function playbookMatch(id: string, verify: string[]): MatchResult {
  return {
    playbook: { id, verify: { build: [], test: verify, testFast: [], lint: [], format: [], typecheck: [] } },
    reasons: [],
    confidence: 1,
  } as unknown as MatchResult
}

const noDeclared = { commands: [], tools: [], env: [] }

describe('isRunnableExecutable', () => {
  test('a non-executable file is not runnable, and a real executable is', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-runnable-'))
    temps.push(dir)
    const doc = join(dir, 'README.md')
    writeFileSync(doc, 'not a program')
    assert.equal(isRunnableExecutable(doc, process.platform), false, 'a document is not a tool')

    const exe = join(dir, process.platform === 'win32' ? 'probe.cmd' : 'probe.sh')
    writeFileSync(exe, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n')
    if (process.platform !== 'win32') chmodSync(exe, 0o755)
    assert.equal(isRunnableExecutable(exe, process.platform), true)
    assert.equal(isRunnableExecutable(join(dir, 'missing'), process.platform), false)
  })
})

describe('probeArgsFor', () => {
  test('uses a tool-specific probe where --version is wrong', () => {
    assert.deepEqual(probeArgsFor('go'), ['version'])
    assert.deepEqual(probeArgsFor('go.exe'), ['version'])
    assert.deepEqual(probeArgsFor('C:\\tools\\go.exe'), ['version'])
    assert.deepEqual(probeArgsFor('xcodebuild'), ['-version'])
    assert.deepEqual(probeArgsFor('node'), ['--version'])
  })
})

describe('isInsideRepository', () => {
  test('a directory whose name starts with two dots is still inside', () => {
    // `..tools` is a committed directory name, not a step out of the repository. Treating it
    // as external is a containment bypass: a binary there would be treated as system code and
    // executed.
    assert.equal(isInsideRepository('/repo', join('/repo', '..tools', 'evil.exe')), true)
    assert.equal(isInsideRepository('/repo', join('/repo', '..cache', 'tool')), true)
  })

  test('a real step out of the repository is outside', () => {
    assert.equal(isInsideRepository('/repo', join('/repo', '..', 'outside', 'tool')), false)
    assert.equal(isInsideRepository('/repo', '/repo'), false, 'the root itself is not a tool')
  })
})

describe('buildReadyReport: status vocabulary', () => {
  test('a declared command is unknown, not verified: declaring is not observing', async () => {
    const report = await buildReadyReport({
      profile: profileOf(),
      matches: [],
      declared: { commands: [{ kind: 'test', cmd: 'make check' }], tools: [], env: [] },
      check: false,
      environment: env(),
    })
    const command = report.commands[0]
    assert.equal(command?.source, 'declared')
    assert.equal(command?.status, 'unknown')
    assert.equal(report.status, 'unknown')
  })

  test('a detected command is verified, and carries its evidence', async () => {
    const report = await buildReadyReport({
      profile: profileOf({
        commands: { test: [{ cmd: 'npm test', source: 'detected', evidence: 'package.json:12' }] },
      }),
      matches: [],
      declared: noDeclared,
      check: false,
      environment: env(),
    })
    assert.equal(report.commands[0]?.source, 'detected')
    assert.equal(report.commands[0]?.status, 'verified')
    assert.equal(report.commands[0]?.evidence, 'package.json:12')
    // The command is verified, but its runner (`npm`) is not, without --check.
    assert.equal(report.status, 'unknown')
  })

  test('an inferred command keeps its source and is unknown, never verified', async () => {
    const report = await buildReadyReport({
      profile: profileOf({
        commands: { test: [{ cmd: 'cargo test', source: 'inferred' }] },
      }),
      matches: [],
      declared: noDeclared,
      check: false,
      environment: env(),
    })
    assert.equal(report.commands[0]?.source, 'inferred')
    assert.equal(report.commands[0]?.status, 'unknown')
    assert.equal(report.status, 'unknown')
  })
})

describe('buildReadyReport: tools come from the project commands', () => {
  test('a command runner is a required tool; a missing one blocks', async () => {
    const report = await buildReadyReport({
      profile: profileOf({
        commands: { test: [{ cmd: 'pytest -q', source: 'documented', evidence: 'README.md:9' }] },
      }),
      matches: [],
      declared: noDeclared,
      check: true,
      environment: env({ found: [] }),
    })
    const tool = report.tools.find((t) => t.id === 'pytest')
    assert.equal(tool?.required, true)
    assert.equal(tool?.source, 'command')
    assert.equal(tool?.status, 'missing')
    assert.equal(report.status, 'blocked')
  })

  test('without --check nothing is spawned and every tool is unknown', async () => {
    const report = await buildReadyReport({
      profile: profileOf({ commands: { test: [{ cmd: 'pytest', source: 'detected', evidence: 'x:1' }] } }),
      matches: [],
      declared: { commands: [], tools: [{ id: 'make' }], env: [] },
      check: false,
      environment: untouchedEnv(),
    })
    assert.ok(report.tools.every((t) => t.status === 'unknown'))
    assert.equal(report.checked, false)
    assert.equal(report.status, 'unknown')
  })

  test('a repository-controlled path tool is never executed, only checked', async () => {
    const report = await buildReadyReport({
      profile: profileOf({ commands: { test: [{ cmd: './gradlew test', source: 'detected', evidence: 'x:1' }] } }),
      matches: [],
      declared: noDeclared,
      check: true,
      // probe throws if called: a path tool must not be executed.
      environment: {
        resolve: (bin) => {
          throw new Error(`PATH lookup used for a path tool: ${bin}`)
        },
        probe: async (bin) => {
          throw new Error(`path tool executed: ${bin}`)
        },
        isRunnable: (absPath) => absPath.replace(/\\/g, '/').endsWith('/repo/gradlew'),
      },
    })
    const tool = report.tools.find((t) => t.id === './gradlew')
    assert.equal(tool?.path, true)
    assert.equal(tool?.status, 'available')
  })

  test('a required tool that resolves but fails to run is blocked, not verified', async () => {
    const report = await buildReadyReport({
      profile: profileOf({ commands: { test: [{ cmd: 'broken-tool test', source: 'detected', evidence: 'x:1' }] } }),
      matches: [],
      declared: noDeclared,
      check: true,
      environment: env({ found: ['broken-tool'], probes: { 'broken-tool': { ok: false, version: null } } }),
    })
    assert.equal(report.tools[0]?.status, 'unavailable')
    assert.equal(report.status, 'blocked')
  })

  test('an inconclusive probe (timeout) is unknown, not a false blocker', async () => {
    const report = await buildReadyReport({
      profile: profileOf({ commands: { test: [{ cmd: 'slow-tool test', source: 'detected', evidence: 'x:1' }] } }),
      matches: [],
      declared: noDeclared,
      check: true,
      environment: env({
        found: ['slow-tool'],
        probes: { 'slow-tool': { ok: false, version: null, inconclusive: true } },
      }),
    })
    assert.equal(report.tools[0]?.status, 'unknown')
    assert.equal(report.status, 'unknown')
  })

  test('a bare name that resolves inside the repository is never executed', async () => {
    const repoBin = join('/repo', 'node_modules', '.bin', 'evil.cmd')
    const report = await buildReadyReport({
      profile: profileOf(),
      matches: [],
      declared: { commands: [], tools: [{ id: 'evil' }], env: [] },
      check: true,
      environment: {
        resolve: () => repoBin,
        probe: async (bin) => {
          throw new Error(`executed repository code: ${bin}`)
        },
        isRunnable: (absPath) => absPath === repoBin,
      },
    })
    const tool = report.tools.find((t) => t.id === 'evil')
    assert.equal(tool?.path, true, 'a repository-resolved bare name is treated as repository-controlled')
    assert.equal(tool?.status, 'available')
  })

  test('a bare name that resolves to a `..name` directory inside the repository is not executed', async () => {
    const repoBin = join('/repo', '..tools', 'evil.exe')
    const report = await buildReadyReport({
      profile: profileOf(),
      matches: [],
      declared: { commands: [], tools: [{ id: 'evil' }], env: [] },
      check: true,
      environment: {
        resolve: () => repoBin,
        probe: async (execPath) => {
          throw new Error(`executed repository code: ${execPath}`)
        },
        isRunnable: (absPath) => absPath === repoBin,
      },
    })
    const tool = report.tools.find((t) => t.id === 'evil')
    assert.equal(tool?.path, true, 'the `..tools` directory is inside the repository')
    assert.equal(tool?.status, 'available')
  })

  test('the resolved path is the one probed, not the bare name', async () => {
    const seen: string[] = []
    const report = await buildReadyReport({
      profile: profileOf(),
      matches: [],
      declared: { commands: [], tools: [{ id: 'node' }], env: [] },
      check: true,
      environment: {
        resolve: () => '/usr/local/bin/node',
        probe: async (execPath) => {
          seen.push(execPath)
          return { ok: true, version: '1.2.3' }
        },
        isRunnable: () => false,
      },
    })
    assert.deepEqual(seen, ['/usr/local/bin/node'], 'the checked path is the one executed')
    assert.equal(report.tools[0]?.status, 'available')
  })

  test('a repository-controlled shim interpreter makes the probe inconclusive, not a run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anvil-comspec-'))
    temps.push(root)
    const fakeComspec = join(root, 'cmd.exe')
    writeFileSync(fakeComspec, '')
    const launches: string[] = []
    const environment = systemEnvironment({
      platform: 'win32',
      containmentRoot: root,
      env: { ComSpec: fakeComspec, PATHEXT: '.cmd', PATH: root },
      runner: recordingRunner(launches),
    })
    const probe = await environment.probe(join(root, '..', 'outside', 'tool.cmd'))
    assert.equal(probe.ok, false)
    assert.equal(probe.inconclusive, true, 'an interpreter anvil cannot trust is not executed')
    assert.deepEqual(launches, [], 'the guard blocked the probe; a failed spawn did not')
  })

  test('a shim with no interpreter configured is not run through a repository cmd.exe', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anvil-nocomspec-'))
    temps.push(root)
    // No ComSpec: the fallback must be resolved and refused here, not left to the bare name
    // `cmd.exe`, whose lookup can land back inside the repository.
    writeFileSync(join(root, 'cmd.exe'), '')
    const launches: string[] = []
    const environment = systemEnvironment({
      platform: 'win32',
      containmentRoot: root,
      env: { PATH: root, PATHEXT: '.exe;.cmd' },
      runner: recordingRunner(launches),
    })
    const probe = await environment.probe(join(root, '..', 'outside', 'tool.cmd'))
    assert.equal(probe.ok, false)
    assert.equal(probe.inconclusive, true)
    assert.deepEqual(launches, [], 'the fallback was refused before it reached the launcher')
  })

  test('a bare configured interpreter is resolved and refused when it lands in the repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anvil-barecomspec-'))
    temps.push(root)
    writeFileSync(join(root, 'cmd.exe'), '')
    // `ComSpec=cmd.exe` is a bare name. It must be resolved here -- not handed to the spawn --
    // so a PATH that points into the repository cannot decide the interpreter.
    const launches: string[] = []
    const environment = systemEnvironment({
      platform: 'win32',
      containmentRoot: root,
      env: { ComSpec: 'cmd.exe', PATH: root, PATHEXT: '.exe;.cmd' },
      runner: recordingRunner(launches),
    })
    const probe = await environment.probe(join(root, '..', 'outside', 'tool.cmd'))
    assert.equal(probe.ok, false)
    assert.equal(probe.inconclusive, true)
    assert.deepEqual(launches, [], 'the resolved name was refused before it reached the launcher')
  })

  test('a configured interpreter with an extension is resolved exactly, not by PATHEXT order', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anvil-exact-comspec-'))
    const tools = mkdtempSync(join(tmpdir(), 'anvil-exact-tools-'))
    temps.push(root, tools)
    // `cmd.com` sorts first in PATHEXT, but the configuration named `cmd.exe`.
    writeFileSync(join(tools, 'cmd.com'), '')
    writeFileSync(join(tools, 'cmd.exe'), '')
    const launches: string[] = []
    const environment = systemEnvironment({
      platform: 'win32',
      containmentRoot: root,
      env: { ComSpec: 'cmd.exe', PATH: tools, PATHEXT: '.com;.exe' },
      runner: recordingRunner(launches),
    })
    const probe = await environment.probe(join(root, '..', 'outside', 'tool.cmd'))
    assert.equal(probe.ok, true)
    assert.deepEqual(
      launches.map((p) => p.toLowerCase()),
      [join(tools, 'cmd.exe').toLowerCase()],
      'the filename that was configured is the one pinned',
    )
  })

  test('a configured interpreter is not given a second extension', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anvil-double-comspec-'))
    const tools = mkdtempSync(join(tmpdir(), 'anvil-double-tools-'))
    temps.push(root, tools)
    // A PATH lookup that appends PATHEXT would select `cmd.exe.exe` over `cmd.exe`.
    writeFileSync(join(tools, 'cmd.exe.exe'), '')
    writeFileSync(join(tools, 'cmd.exe'), '')
    const launches: string[] = []
    const environment = systemEnvironment({
      platform: 'win32',
      containmentRoot: root,
      env: { ComSpec: 'cmd.exe', PATH: tools, PATHEXT: '.exe' },
      runner: recordingRunner(launches),
    })
    const probe = await environment.probe(join(root, '..', 'outside', 'tool.cmd'))
    assert.equal(probe.ok, true)
    assert.deepEqual(
      launches.map((p) => p.toLowerCase()),
      [join(tools, 'cmd.exe').toLowerCase()],
      'the exact configured filename wins over an appended extension',
    )
  })

  test('a configured interpreter whose exact file is absent is refused, not substituted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anvil-missing-comspec-'))
    const tools = mkdtempSync(join(tmpdir(), 'anvil-missing-tools-'))
    temps.push(root, tools)
    // Only `cmd.com` exists. Stripping the configured extension would silently select it.
    writeFileSync(join(tools, 'cmd.com'), '')
    const launches: string[] = []
    const environment = systemEnvironment({
      platform: 'win32',
      containmentRoot: root,
      env: { ComSpec: 'cmd.exe', PATH: tools, PATHEXT: '.com;.exe' },
      runner: recordingRunner(launches),
    })
    const probe = await environment.probe(join(root, '..', 'outside', 'tool.cmd'))
    assert.equal(probe.ok, false)
    assert.equal(probe.inconclusive, true)
    assert.deepEqual(launches, [], 'a different executable is never substituted for the configured one')
  })

  test('an interpreter inside the repository does not block a native executable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anvil-native-'))
    temps.push(root)
    const environment = systemEnvironment({
      platform: 'win32',
      containmentRoot: root,
      // `node` is a native executable, so the `.cmd` interpreter guard must not apply to it.
      env: { ...process.env, ComSpec: join(root, 'cmd.exe') },
    })
    const probe = await environment.probe(process.execPath)
    assert.equal(probe.ok, true, 'a native executable is probed regardless of ComSpec')
  })

  test('a repository-local symlink that points outside is never executed', async (t) => {
    const external = mkdtempSync(join(tmpdir(), 'anvil-symlink-target-'))
    const repo = mkdtempSync(join(tmpdir(), 'anvil-symlink-repo-'))
    temps.push(external, repo)
    writeFileSync(join(external, 'tool'), '')
    const link = join(repo, 'linked-tools')
    try {
      symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      t.skip('directory symlinks are unavailable here')
      return
    }
    const entry = join(link, 'tool')
    const report = await buildReadyReport({
      profile: profileOf({ root: repo }),
      matches: [],
      declared: { commands: [], tools: [{ id: 'linked' }], env: [] },
      check: true,
      environment: {
        resolve: () => entry,
        probe: async (execPath) => {
          throw new Error(`executed repository-controlled symlink: ${execPath}`)
        },
        isRunnable: (absPath) => absPath === entry,
      },
    })
    const tool = report.tools.find((x) => x.id === 'linked')
    assert.equal(tool?.path, true, 'a repository-local symlink is repository-controlled')
    assert.equal(tool?.status, 'available')
  })

  test('an alias of the repository does not hide a repository-owned symlink', async (t) => {
    const repo = mkdtempSync(join(tmpdir(), 'anvil-alias-repo-'))
    const external = mkdtempSync(join(tmpdir(), 'anvil-alias-target-'))
    const aliasParent = mkdtempSync(join(tmpdir(), 'anvil-alias-'))
    temps.push(repo, external, aliasParent)
    mkdirSync(join(repo, 'linked-tools'), { recursive: true })
    writeFileSync(join(external, 'tool'), '')
    const alias = join(aliasParent, 'repo-alias')
    try {
      symlinkSync(repo, alias, process.platform === 'win32' ? 'junction' : 'dir')
      symlinkSync(join(external, 'tool'), join(repo, 'linked-tools', 'go'), 'file')
    } catch {
      t.skip('directory or file symlinks are unavailable here')
      return
    }
    // The profile root is the alias; the executable path is the physical repository path, and
    // the entry is a symlink pointing outside. Canonicalizing the entry hides the repository,
    // so containment must also consult the directory that holds it.
    const candidate = join(repo, 'linked-tools', 'go')
    const probes: string[] = []
    const report = await buildReadyReport({
      profile: profileOf({ root: alias }),
      matches: [],
      declared: { commands: [], tools: [{ id: 'go' }], env: [] },
      check: true,
      environment: {
        resolve: () => candidate,
        probe: async (execPath) => {
          probes.push(execPath)
          return { ok: true, version: null }
        },
        isRunnable: () => true,
      },
    })
    assert.deepEqual(probes, [], 'the aliased repository owns the symlink, so it is never probed')
    assert.equal(report.tools[0]?.path, true)
  })

  test('an absolute path tool is checked exactly where it points', async () => {
    const absolute = join(tmpdir(), 'anvil-abs-tool', process.platform === 'win32' ? 'node.exe' : 'node')
    const checked: string[] = []
    const report = await buildReadyReport({
      profile: profileOf(),
      matches: [],
      declared: { commands: [], tools: [{ id: 'node-abs', bin: absolute }], env: [] },
      check: true,
      environment: {
        resolve: () => {
          throw new Error('an absolute path must not be resolved on PATH')
        },
        probe: async () => {
          throw new Error('an absolute path tool must not be executed')
        },
        isRunnable: (absPath) => {
          checked.push(absPath)
          return absPath === absolute
        },
      },
    })
    assert.deepEqual(checked, [absolute], 'the repository must not be joined onto an absolute path')
    assert.equal(report.tools[0]?.path, true)
    assert.equal(report.tools[0]?.status, 'available')
  })

  test('only the first declared command for a kind is required', async () => {
    const report = await buildReadyReport({
      profile: profileOf(),
      matches: [],
      declared: {
        commands: [
          { kind: 'test', cmd: 'node check.js' },
          { kind: 'test', cmd: 'unused-runner test' },
        ],
        tools: [],
        env: [],
      },
      check: true,
      environment: env({ found: ['node'] }),
    })
    assert.equal(report.tools.find((t) => t.id === 'node')?.required, true)
    assert.equal(
      report.tools.find((t) => t.id === 'unused-runner')?.required,
      false,
      'a second declaration of the same kind is an alternative, not a need',
    )
    assert.equal(report.status, 'unknown', 'the primary declared command is still unobserved')
  })

  test('a relative tool is looked up in its declared working directory', async () => {
    const expected = join('/repo', 'engine', './check.cmd')
    const checked: string[] = []
    const report = await buildReadyReport({
      profile: profileOf(),
      matches: [],
      declared: { commands: [{ kind: 'test', cmd: './check.cmd test', dir: 'engine' }], tools: [], env: [] },
      check: true,
      environment: {
        resolve: () => {
          throw new Error('a path tool must not be resolved on PATH')
        },
        probe: async () => {
          throw new Error('a path tool must not be executed')
        },
        isRunnable: (absPath) => {
          checked.push(absPath)
          return absPath === expected
        },
      },
    })
    assert.deepEqual(checked, [expected])
    const tool = report.tools.find((t) => t.bin === './check.cmd')
    assert.equal(tool?.dir, 'engine')
    assert.equal(tool?.status, 'available')
  })

  test('an overridden inferred runner is not required', async () => {
    const report = await buildReadyReport({
      profile: profileOf({ commands: { test: [{ cmd: 'obsolete-runner test', source: 'inferred' }] } }),
      matches: [],
      declared: { commands: [{ kind: 'test', cmd: 'node check.js' }], tools: [], env: [] },
      check: true,
      environment: env({ found: ['node'] }),
    })
    assert.equal(report.tools.find((t) => t.id === 'obsolete-runner')?.required, false)
    assert.equal(report.tools.find((t) => t.id === 'node')?.required, true)
    assert.equal(report.status, 'unknown', 'the declared command is still unobserved')
  })

  test('an inferred-only runner is optional, not a blocker', async () => {
    const report = await buildReadyReport({
      profile: profileOf({ commands: { test: [{ cmd: 'cargo test', source: 'inferred' }] } }),
      matches: [],
      declared: noDeclared,
      check: true,
      environment: env({ found: [] }),
    })
    assert.equal(report.tools.find((t) => t.id === 'cargo')?.required, false)
    assert.equal(report.status, 'unknown')
  })
})

describe('buildReadyReport: a required declared tool drives blocked', () => {
  test('a missing required tool is blocked and proposes the declared install command', async () => {
    const report = await buildReadyReport({
      profile: profileOf(),
      matches: [],
      declared: {
        commands: [],
        tools: [{ id: 'make', reason: 'the build', required: true, install: 'apt-get install -y make' }],
        env: [],
      },
      check: true,
      environment: env({ found: [] }),
    })
    assert.equal(report.tools[0]?.status, 'missing')
    assert.equal(report.status, 'blocked')
    const action = report.actions.find((a) => a.id === 'install:make')
    assert.ok(action, 'an install action is proposed')
    assert.equal(action.command, 'apt-get install -y make')
    assert.equal(action.requiresApproval, true)
  })

  test('a missing required tool with no declared install proposes no fabricated command', async () => {
    const report = await buildReadyReport({
      profile: profileOf(),
      matches: [],
      declared: { commands: [], tools: [{ id: 'mystery-tool' }], env: [] },
      check: true,
      environment: env({ found: [] }),
    })
    const action = report.actions.find((a) => a.id === 'provide:mystery-tool')
    assert.ok(action)
    assert.equal(action.command, null, 'anvil must not guess an install line')
  })

  test('an available tool is verified and reports its version', async () => {
    const report = await buildReadyReport({
      profile: profileOf(),
      matches: [],
      declared: { commands: [], tools: [{ id: 'make' }], env: [] },
      check: true,
      environment: env({ found: ['make'], probes: { make: { ok: true, version: '4.4.1' } } }),
    })
    assert.equal(report.tools[0]?.status, 'available')
    assert.equal(report.tools[0]?.version, '4.4.1')
    assert.equal(report.status, 'verified')
  })

  test('an optional playbook tool that is missing does not block', async () => {
    const report = await buildReadyReport({
      profile: profileOf(),
      matches: [playbookMatch('playwright', ['npx playwright test'])],
      declared: noDeclared,
      check: true,
      environment: env({ found: [] }),
    })
    const tool = report.tools.find((t) => t.id === 'npx')
    assert.equal(tool?.required, false)
    assert.equal(tool?.status, 'missing')
    assert.equal(report.status, 'unknown', 'missing optional tool is reported, but not a blocker')
    assert.equal(report.actions.length, 0)
  })
})

describe('buildReadyReport: declared version ranges', () => {
  test('a reported version inside the range is available', async () => {
    const report = await buildReadyReport({
      profile: profileOf(),
      matches: [],
      declared: { commands: [], tools: [{ id: 'node', version: '>=20 <21' }], env: [] },
      check: true,
      environment: env({ found: ['node'], probes: { node: { ok: true, version: '20.11.1' } } }),
    })
    const tool = report.tools[0]
    assert.equal(tool?.status, 'available')
    assert.equal(tool?.version, '20.11.1')
    assert.equal(tool?.versionRange, '>=20 <21')
    assert.equal(report.status, 'verified')
  })

  test('a two-component version in probe output is read, not discarded', async () => {
    const environment = systemEnvironment({
      platform: 'win32',
      env: {},
      // Some tools report `Xcode 15.0`; a declared `>=15` must still be comparable.
      runner: async () => ({ stdout: 'Xcode 15.0\nBuild version 15A240d', stderr: '', exitCode: 0 }),
    })
    const probe = await environment.probe('C:\\external\\xcodebuild.exe')
    assert.equal(probe.ok, true)
    assert.equal(probe.version, '15.0')
  })

  test('a version glued to a prefix, as Go prints it, is still read', async () => {
    const environment = systemEnvironment({
      platform: 'win32',
      env: {},
      runner: async () => ({ stdout: 'go version go1.22.1 windows/amd64', stderr: '', exitCode: 0 }),
    })
    const probe = await environment.probe('C:\\external\\go.exe')
    assert.equal(probe.ok, true)
    assert.equal(probe.version, '1.22.1')
  })

  test('a well-formed version with build metadata is read intact', async () => {
    for (const version of ['1.2.3+build.5', '1.2.3-beta.1+build.5']) {
      const environment = systemEnvironment({
        platform: 'win32',
        env: {},
        runner: async () => ({ stdout: `tool ${version}`, stderr: '', exitCode: 0 }),
      })
      const probe = await environment.probe('C:\\external\\tool.exe')
      assert.equal(probe.ok, true, version)
      assert.equal(probe.version, version)
    }
  })

  test('an unsupported suffix or a fourth component is not shortened into a comparable version', async () => {
    for (const output of [
      'Python 3.13.0rc1',
      'Microsoft Windows [Version 10.0.19045.3803]',
      // A dangling or malformed suffix must not fall back to the bare `1.2.3` match.
      'tool 1.2.3+',
      'tool 1.2.3-',
      'tool 1.2.3-rc_1',
      'tool 1.2.3+build_meta',
      'tool 1.2.3-rc.1+.',
      // A malformed first candidate must not be skipped; the number after it, or a
      // dependency version named later, is not this tool's version.
      'tool 1.2.3-rc_4.5.6',
      'tool 1.2.3+build_meta4.5.6',
      'tool 1.2.3rc1 (dependency 4.5.6)',
    ]) {
      const environment = systemEnvironment({
        platform: 'win32',
        env: {},
        runner: async () => ({ stdout: output, stderr: '', exitCode: 0 }),
      })
      const probe = await environment.probe('C:\\external\\tool.exe')
      assert.equal(probe.ok, true, output)
      assert.equal(probe.version, null, `${output} must not become a shorter version that passes`)
    }
  })

  test('a malformed first candidate is not skipped for a later version', async () => {
    // The suffix contains `4.5.6`; if extraction resumed scanning it would report a pass
    // against a range this tool never satisfied.
    const system = systemEnvironment({
      platform: 'win32',
      env: {},
      runner: async () => ({ stdout: 'tool 1.2.3-rc_4.5.6', stderr: '', exitCode: 0 }),
    })
    const report = await buildReadyReport({
      profile: profileOf(),
      matches: [],
      declared: { commands: [], tools: [{ id: 'tool', version: '4.5.6' }], env: [] },
      check: true,
      environment: {
        resolve: () => 'C:\\external\\tool.exe',
        isRunnable: () => true,
        probe: (execPath) => system.probe(execPath),
      },
    })
    assert.equal(report.tools[0]?.version, null)
    assert.equal(report.tools[0]?.status, 'unknown')
    assert.equal(report.status, 'unknown')
  })

  test('an unsupported version suffix is unknown against an exact requirement', async () => {
    const system = systemEnvironment({
      platform: 'win32',
      env: {},
      runner: async () => ({ stdout: 'Python 3.13.0rc1', stderr: '', exitCode: 0 }),
    })
    const report = await buildReadyReport({
      profile: profileOf(),
      matches: [],
      declared: { commands: [], tools: [{ id: 'python', version: '3.13.0' }], env: [] },
      check: true,
      environment: {
        resolve: () => 'C:\\external\\python.exe',
        isRunnable: () => true,
        probe: (execPath) => system.probe(execPath),
      },
    })
    assert.equal(report.tools[0]?.version, null)
    assert.equal(report.tools[0]?.status, 'unknown')
  })

  test('a reported version outside the range is incompatible and blocks', async () => {
    const report = await buildReadyReport({
      profile: profileOf(),
      matches: [],
      declared: { commands: [], tools: [{ id: 'node', version: '>=22' }], env: [] },
      check: true,
      environment: env({ found: ['node'], probes: { node: { ok: true, version: '20.11.1' } } }),
    })
    const tool = report.tools[0]
    assert.equal(tool?.status, 'incompatible')
    assert.equal(report.status, 'blocked')
    assert.equal(tool?.required, true)
    const action = report.actions.find((a) => a.id === 'upgrade:node')
    assert.ok(action)
    assert.equal(action.command, null, 'no install line is fabricated')
    assert.match(action.reason, />=22/)
  })

  test('an incompatible tool proposes the owner-declared install command', async () => {
    const report = await buildReadyReport({
      profile: profileOf(),
      matches: [],
      declared: {
        commands: [],
        tools: [{ id: 'node', version: '>=22', install: 'install-node-22' }],
        env: [],
      },
      check: true,
      environment: env({ found: ['node'], probes: { node: { ok: true, version: '20.11.1' } } }),
    })
    const action = report.actions.find((a) => a.id === 'upgrade:node')
    assert.equal(action?.command, 'install-node-22')
    assert.equal(action?.requiresApproval, true)
  })

  test('a comparable version that cannot be read is unknown, not incompatible', async () => {
    for (const version of [null, 'nightly']) {
      const report = await buildReadyReport({
        profile: profileOf(),
        matches: [],
        declared: { commands: [], tools: [{ id: 'node', version: '>=20' }], env: [] },
        check: true,
        environment: env({ found: ['node'], probes: { node: { ok: true, version } } }),
      })
      const tool = report.tools[0]
      assert.equal(tool?.status, 'unknown', String(version))
      assert.equal(report.status, 'unknown', String(version))
      assert.equal(report.summary.blocked, 0, `${String(version)} must not invent a blocker`)
    }
  })

  test('a path tool with a version range is unknown: its version is never observed', async () => {
    const report = await buildReadyReport({
      profile: profileOf(),
      matches: [],
      declared: { commands: [], tools: [{ id: 'gradlew', bin: './gradlew', version: '>=8' }], env: [] },
      check: true,
      environment: {
        resolve: () => {
          throw new Error('a path tool must not be resolved on PATH')
        },
        probe: async () => {
          throw new Error('a repository-controlled tool must not be executed')
        },
        isRunnable: () => true,
      },
    })
    assert.equal(report.tools[0]?.status, 'unknown')
    assert.equal(report.tools[0]?.version, null)
    assert.equal(report.status, 'unknown')
  })

  test('an optional incompatible tool is reported but does not block', async () => {
    const report = await buildReadyReport({
      profile: profileOf(),
      matches: [],
      declared: { commands: [], tools: [{ id: 'node', version: '>=22', required: false }], env: [] },
      check: true,
      environment: env({ found: ['node'], probes: { node: { ok: true, version: '20.11.1' } } }),
    })
    assert.equal(report.tools[0]?.status, 'incompatible')
    assert.equal(report.status, 'unknown', 'nothing required was identified')
    assert.equal(report.summary.blocked, 0)
    assert.equal(report.actions.length, 0)
  })

  test('without --check a range is carried but compatibility is unknown', async () => {
    const report = await buildReadyReport({
      profile: profileOf(),
      matches: [],
      declared: { commands: [], tools: [{ id: 'node', version: '^20' }], env: [] },
      check: false,
      environment: untouchedEnv(),
    })
    assert.equal(report.tools[0]?.status, 'unknown')
    assert.equal(report.tools[0]?.versionRange, '^20')
    assert.equal(report.status, 'unknown')
  })
})

describe('buildReadyReport: declared environment variables', () => {
  const declaredEnv = (env: Array<{ name: string; reason?: string; required?: boolean }>) => ({
    commands: [],
    tools: [],
    env,
  })

  test('a present variable verifies, and its value never enters the report', async () => {
    const report = await buildReadyReport({
      profile: profileOf(),
      matches: [],
      declared: declaredEnv([{ name: 'DATABASE_URL', reason: 'the database' }]),
      check: true,
      environment: env({ variables: { DATABASE_URL: 'postgres://user:pw@host/db' } }),
    })
    assert.equal(report.env[0]?.status, 'present')
    assert.equal(report.status, 'verified')
    assert.equal(report.actions.length, 0)
    assert.ok(!JSON.stringify(report).includes('postgres://user:pw@host/db'), 'a value is never copied')
  })

  test('a missing required variable blocks and proposes no command', async () => {
    const report = await buildReadyReport({
      profile: profileOf(),
      matches: [],
      declared: declaredEnv([{ name: 'API_TOKEN', reason: 'the API' }]),
      check: true,
      environment: env(),
    })
    assert.equal(report.env[0]?.status, 'missing')
    assert.equal(report.status, 'blocked')
    const action = report.actions.find((a) => a.id === 'set:API_TOKEN')
    assert.ok(action, 'a set action is proposed')
    assert.equal(action.command, null, 'anvil must not invent an export line')
    assert.match(action.reason, /API_TOKEN/)
  })

  test('an empty value is not a pass', async () => {
    const report = await buildReadyReport({
      profile: profileOf(),
      matches: [],
      declared: declaredEnv([{ name: 'API_TOKEN' }]),
      check: true,
      environment: env({ variables: { API_TOKEN: '' } }),
    })
    assert.equal(report.env[0]?.status, 'empty')
    assert.equal(report.status, 'blocked')
    assert.ok(report.actions.some((a) => a.id === 'set:API_TOKEN'))
  })

  test('an optional missing variable is reported but does not block', async () => {
    const report = await buildReadyReport({
      profile: profileOf(),
      matches: [],
      declared: declaredEnv([{ name: 'OPTIONAL_FLAG', required: false }]),
      check: true,
      environment: env(),
    })
    assert.equal(report.env[0]?.status, 'missing')
    assert.equal(report.status, 'unknown', 'nothing required was identified')
    assert.equal(report.summary.blocked, 0)
    assert.equal(report.actions.length, 0)
  })

  test('without --check nothing is read and every variable is unknown', async () => {
    const report = await buildReadyReport({
      profile: profileOf(),
      matches: [],
      declared: declaredEnv([{ name: 'API_TOKEN' }]),
      check: false,
      environment: untouchedEnv(),
    })
    assert.equal(report.env[0]?.status, 'unknown')
    assert.equal(report.status, 'unknown')
  })
})

describe('buildReadyReport: context and conflicts stay visible', () => {
  test('no instruction file is blocked and proposes `anvil init`', async () => {
    const report = await buildReadyReport({
      profile: profileOf({ instructions: [] }),
      matches: [],
      declared: noDeclared,
      check: false,
      environment: env(),
    })
    assert.equal(report.context[0]?.status, 'blocked')
    assert.equal(report.status, 'blocked')
    const action = report.actions.find((a) => a.id === 'init-context')
    assert.equal(action?.command, 'anvil init')
  })

  test('a global-only instruction file is unknown, not verified project context', async () => {
    const report = await buildReadyReport({
      profile: profileOf({
        instructions: [{ path: '/home/dev/.config/AGENTS.md', category: 'global', bytes: 512 }],
      }),
      matches: [],
      declared: noDeclared,
      check: false,
      environment: env(),
    })
    assert.equal(report.context[0]?.status, 'unknown')
    assert.equal(report.status, 'unknown')
    assert.ok(
      report.actions.some((a) => a.id === 'init-context'),
      'offers to stage repository context',
    )
  })

  test('a project with nothing to verify is unknown, never verified', async () => {
    const report = await buildReadyReport({
      profile: profileOf(),
      matches: [],
      declared: noDeclared,
      check: true,
      environment: env(),
    })
    assert.equal(report.status, 'unknown')
  })

  test('a declared command that overlaps a detected one warns rather than hiding either', async () => {
    const report = await buildReadyReport({
      profile: profileOf({
        commands: { test: [{ cmd: 'npm test', source: 'detected', evidence: 'package.json:12' }] },
      }),
      matches: [],
      declared: { commands: [{ kind: 'test', cmd: 'make check' }], tools: [], env: [] },
      check: false,
      environment: env(),
    })
    assert.equal(report.commands.length, 2, 'both the declared and the detected command survive')
    assert.ok(
      report.warnings.some((w) => w.includes('overrides the detected')),
      'the overlap is stated in a warning',
    )
  })

  test('an incomplete profile is reported as unknown, never scored as verified', async () => {
    const report = await buildReadyReport({
      profile: profileOf({
        commands: { test: [{ cmd: 'npm test', source: 'detected', evidence: 'package.json:12' }] },
        diagnostics: { truncated: true, fileLimit: 20000, failedDetectors: [] },
      }),
      matches: [],
      declared: noDeclared,
      check: false,
      environment: env(),
    })
    assert.equal(report.status, 'unknown')
    assert.ok(report.warnings.some((w) => w.includes('stopped at 20000 files')))
  })
})
