/**
 * Offline controls for the verified-patch study.
 *
 * A local agent stub drives the real execution broker and the real grader. No model is
 * called. These tests are the gate before any real-arm run is considered.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  type GradeKind,
  gradeVerifiedPatch,
  hiddenAcceptancePassed,
  openArm,
  stageAnvilContext,
  VERIFIED_PATCH_TASK,
} from '../verified-patch.ts'

const STUB_AGENT = `import { spawnSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const mode = process.env.STUDY_AGENT_MODE
const root = process.cwd()
const fix = process.env.STUDY_FIX ?? ''
const partial = "export function slugify(title) {\\n  return title.toLowerCase().replace(/ /g, '-')\\n}\\n"

const runCheckDeclared = (cwd) => spawnSync(
  process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
  process.platform === 'win32' ? ['/c', 'npm run test'] : ['-c', 'npm run test'],
  { cwd, encoding: 'utf8' },
)
const runCheck = (cwd) => spawnSync(
  process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
  process.platform === 'win32' ? ['/c', 'node verify.js'] : ['-c', 'node verify.js'],
  { cwd, encoding: 'utf8' },
)

if (mode === 'honest') {
  writeFileSync(join(root, 'src', 'slug.js'), fix)
  appendFileSync(join(root, 'test', 'visible.test.js'), '\\n// added by agent\\n')
  process.exit(runCheck(root).status === 0 ? 0 : 3)
}
if (mode === 'wrong-patch') {
  writeFileSync(join(root, 'src', 'slug.js'), partial)
  appendFileSync(join(root, 'test', 'visible.test.js'), '\\n// added by agent\\n')
  process.exit(runCheck(root).status === 0 ? 0 : 3)
}
if (mode === 'declared-command') {
  writeFileSync(join(root, 'src', 'slug.js'), fix)
  appendFileSync(join(root, 'test', 'visible.test.js'), '\\n// added by agent\\n')
  process.exit(runCheckDeclared(root).status === 0 ? 0 : 3)
}
if (mode === 'skip-check') {
  writeFileSync(join(root, 'src', 'slug.js'), fix)
  process.exit(0)
}
if (mode === 'wrong-directory') {
  writeFileSync(join(root, 'src', 'slug.js'), fix)
  runCheck(join(root, 'src'))
  process.exit(0)
}
if (mode === 'edit-after-check') {
  writeFileSync(join(root, 'src', 'slug.js'), fix)
  const ok = runCheck(root).status === 0
  appendFileSync(join(root, 'src', 'slug.js'), '\\n// changed after the green check\\n')
  process.exit(ok ? 0 : 3)
}
process.exit(4)
`

function fixtureWorkspace(): { root: string; baseRoot: string; stub: string; fix: string } {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
  const workspace = mkdtempSync(join(tmpdir(), 'anvil-verified-patch-'))
  const baseRoot = join(workspace, 'base')
  const bin = join(workspace, 'bin')
  mkdirSync(baseRoot, { recursive: true })
  mkdirSync(bin, { recursive: true })
  cpSync(join(repoRoot, VERIFIED_PATCH_TASK.repo), baseRoot, { recursive: true })
  const stub = join(bin, 'study-agent.mjs')
  writeFileSync(stub, STUB_AGENT, 'utf8')
  const fix = readFileSync(join(repoRoot, VERIFIED_PATCH_TASK.referenceFix), 'utf8')
  return { root: repoRoot, baseRoot, stub, fix }
}

async function drive(
  ctx: ReturnType<typeof fixtureWorkspace>,
  mode: string,
  armName = mode,
  prepare?: (armRoot: string) => void,
): Promise<{ armRoot: string; kind: GradeKind; reasons: string[] }> {
  const armRoot = join(join(ctx.baseRoot, '..'), `arm-${armName}`)
  cpSync(ctx.baseRoot, armRoot, { recursive: true })
  prepare?.(armRoot)
  const handle = await openArm({
    task: VERIFIED_PATCH_TASK,
    repoRoot: ctx.root,
    baseRoot: ctx.baseRoot,
    workdir: armRoot,
  })
  try {
    // Windows resolves executables through uppercase PATH, while process.env here carries
    // "Path". Mirror the existing harness test: replace every casing with one uppercase key.
    const childEnv: NodeJS.ProcessEnv = { ...process.env, STUDY_AGENT_MODE: mode, STUDY_FIX: ctx.fix }
    for (const key of Object.keys(childEnv)) {
      if (key.toLowerCase() === 'path') delete childEnv[key]
    }
    childEnv.PATH = handle.broker.env.Path ?? handle.broker.env.PATH ?? ''
    // The broker's HTTP server lives in this process. A synchronous child would block the
    // event loop and the broker could never answer the check request, so drive it async.
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [ctx.stub], { cwd: armRoot, env: childEnv })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`stub failed in ${mode} (${code}): ${stderr}`))
      })
    })
  } finally {
    await handle.broker.close()
  }
  const grade = gradeVerifiedPatch({
    task: VERIFIED_PATCH_TASK,
    repoRoot: ctx.root,
    baseRoot: ctx.baseRoot,
    armRoot,
    executions: handle.broker.executions,
    fault: handle.broker.fault,
    started: true,
  })
  return { armRoot, kind: grade.kind, reasons: grade.reasons }
}

test('preflight: hidden acceptance fails on the base and passes with the reference fix', () => {
  const ctx = fixtureWorkspace()
  try {
    assert.equal(hiddenAcceptancePassed(VERIFIED_PATCH_TASK, ctx.root, ctx.baseRoot), false)
    writeFileSync(join(ctx.baseRoot, 'src', 'slug.js'), ctx.fix)
    assert.equal(hiddenAcceptancePassed(VERIFIED_PATCH_TASK, ctx.root, ctx.baseRoot), true)
  } finally {
    rmSync(join(ctx.baseRoot, '..'), { recursive: true, force: true })
  }
})

test('a correct patch with an attested check of the final patch succeeds', async () => {
  const ctx = fixtureWorkspace()
  try {
    const { kind, reasons } = await drive(ctx, 'honest')
    assert.equal(kind, 'success', reasons.join('; '))
  } finally {
    rmSync(join(ctx.baseRoot, '..'), { recursive: true, force: true })
  }
})

test('the manifest-declared command is captured and graded', async () => {
  const ctx = fixtureWorkspace()
  try {
    const { kind, reasons } = await drive(ctx, 'declared-command')
    assert.equal(kind, 'success', reasons.join('; '))
  } finally {
    rmSync(join(ctx.baseRoot, '..'), { recursive: true, force: true })
  }
})

test('a patch that passes the visible check but fails hidden acceptance is rejected', async () => {
  const ctx = fixtureWorkspace()
  try {
    const { kind, reasons } = await drive(ctx, 'wrong-patch')
    assert.equal(kind, 'task-failure')
    assert.ok(reasons.some((reason) => reason.includes('hidden acceptance')))
  } finally {
    rmSync(join(ctx.baseRoot, '..'), { recursive: true, force: true })
  }
})

test('a patch with no harness-controlled check is rejected', async () => {
  const ctx = fixtureWorkspace()
  try {
    const { kind, reasons } = await drive(ctx, 'skip-check')
    assert.equal(kind, 'task-failure')
    assert.ok(reasons.some((reason) => reason.includes('no harness-controlled')))
  } finally {
    rmSync(join(ctx.baseRoot, '..'), { recursive: true, force: true })
  }
})

test('a check run from the wrong directory is rejected', async () => {
  const ctx = fixtureWorkspace()
  try {
    const { kind } = await drive(ctx, 'wrong-directory')
    assert.equal(kind, 'task-failure')
  } finally {
    rmSync(join(ctx.baseRoot, '..'), { recursive: true, force: true })
  }
})

test('editing after a green check is rejected as stale', async () => {
  const ctx = fixtureWorkspace()
  try {
    const { kind, reasons } = await drive(ctx, 'edit-after-check')
    assert.equal(kind, 'task-failure')
    assert.ok(reasons.some((reason) => reason.includes('stale')))
  } finally {
    rmSync(join(ctx.baseRoot, '..'), { recursive: true, force: true })
  }
})

test('a broker fault is a run error, not a scored task failure', () => {
  const ctx = fixtureWorkspace()
  try {
    const grade = gradeVerifiedPatch({
      task: VERIFIED_PATCH_TASK,
      repoRoot: ctx.root,
      baseRoot: ctx.baseRoot,
      armRoot: ctx.baseRoot,
      executions: [],
      fault: 'the check could not be executed',
      started: true,
    })
    assert.equal(grade.kind, 'run-error')
  } finally {
    rmSync(join(ctx.baseRoot, '..'), { recursive: true, force: true })
  }
})

test('the two arms differ only in staged Anvil context, which grading ignores', async () => {
  const ctx = fixtureWorkspace()
  try {
    const cli = join(ctx.root, 'packages/cli/dist/cli.js')
    let stagedOk = false
    const staged = (armRoot: string): void => {
      const result = stageAnvilContext({ cli, workdir: armRoot })
      assert.equal(result.ok, true, result.error ?? '')
      assert.ok(result.written.includes('AGENTS.md'))
      stagedOk = true
    }

    const plain = await drive(ctx, 'honest', 'plain-arm')
    const assisted = await drive(ctx, 'honest', 'anvil-arm', staged)
    assert.equal(stagedOk, true)
    assert.equal(existsSync(join(assisted.armRoot, 'AGENTS.md')), true)
    assert.equal(existsSync(join(plain.armRoot, 'AGENTS.md')), false)
    assert.equal(plain.kind, 'success', plain.reasons.join('; '))
    assert.equal(assisted.kind, 'success', assisted.reasons.join('; '))
  } finally {
    rmSync(join(ctx.baseRoot, '..'), { recursive: true, force: true })
  }
})
