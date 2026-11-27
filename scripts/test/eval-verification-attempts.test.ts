/**
 * Bounded observations for a failed verification attempt.
 *
 * The grading attestation deliberately records only the one command that counts as evidence.
 * That is enough to decide a result and not enough to explain it. These tests pin the nearby
 * question: an invocation of the check is retained as a runner, a script name, an effective
 * directory and an exit status — while a file read, an extra argument or a shell chain is
 * classified rather than copied into a committed record.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MAX_VERIFICATION_ATTEMPT_CWD_HINT, parseRunRecordResult } from '../../packages/cli/src/eval-gate.ts'
import {
  type AgentExecution,
  observeVerificationAttempts,
  parseOpenCodeRunEvents,
  type ScenarioResult,
  sanitizeResult,
} from '../eval.ts'

/** A minimal run-record result so a retained observation can be parsed as it will be on resume. */
function recordWith(verificationAttempts: unknown): Record<string, unknown> {
  return {
    scenario: 'nested-stale-verification',
    variant: 'bare',
    model: null,
    modelRole: null,
    scenarioHash: 'scenario',
    sourceHash: 'source',
    verifyCount: 1,
    hiddenVerifyCount: 0,
    attempts: [],
    verified: false,
    hiddenVerified: null,
    verifyExitCodes: [1],
    repetition: 0,
    costUsd: null,
    tokens: null,
    durationMs: null,
    transcript: '',
    verificationAttempts,
  }
}

test('a near-miss invocation is retained without its raw command or extra arguments', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'anvil-verification-attempts-'))
  try {
    const executions: AgentExecution[] = [
      { command: 'npm install', exitCode: 0 },
      {
        command: `cd "${join(workdir, 'packages', 'sub')}" && node verfy.js`,
        exitCode: 127,
      },
      { command: 'node ./verify.js', exitCode: 1 },
      { command: 'node verify.js --password hunter2', exitCode: 1 },
    ]
    const attempts = observeVerificationAttempts(['node verify.js'], executions, workdir)

    assert.equal(attempts.length, 3, 'only invocations of the declared check are retained')
    assert.equal(attempts[0]?.runner, 'node')
    assert.equal(attempts[0]?.script, 'verfy.js')
    assert.equal(attempts[0]?.shape, 'simple')
    assert.equal(attempts[0]?.matched, false, 'a typo is a near miss, not evidence')
    assert.equal(attempts[0]?.exitCode, 127)
    assert.equal(attempts[0]?.cwdHint, 'packages/sub')

    assert.equal(attempts[1]?.matched, true, 'the declared command survives ./ normalization')
    assert.equal(attempts[1]?.cwdHint, '.', 'the worktree root is named, not called outside')

    assert.equal(attempts[2]?.shape, 'extra-arguments')
    assert.ok(!JSON.stringify(attempts).includes('hunter2'), 'an argument must never reach the record')
    assert.ok(!JSON.stringify(attempts).includes(workdir), 'a host worktree path must not be published')
  } finally {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('reading a script is not an attempt to invoke it', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'anvil-verification-read-'))
  try {
    const attempts = observeVerificationAttempts(
      ['node verify.js'],
      [
        { command: 'cat verify.js', exitCode: 0 },
        { command: 'node verfy.js', exitCode: 127 },
      ],
      workdir,
    )
    assert.equal(attempts.length, 1, 'a file read must not be mistaken for a check')
    assert.equal(attempts[0]?.script, 'verfy.js')
  } finally {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('an explicit cd is resolved from the shell starting directory', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'anvil-verification-cwd-'))
  try {
    const attempts = observeVerificationAttempts(
      ['node verify.js'],
      [
        {
          command: 'cd packages/sub && node verify.js',
          exitCode: 2,
          cwd: join(workdir, 'packages', 'elsewhere'),
        },
        { command: 'node "verify.js', exitCode: 1 },
        { command: 'cd "$HOME" && node verify.js', exitCode: 1 },
        { command: 'cd "packages/sub project" && node verify.js', exitCode: 1 },
        { command: 'cd - && node verify.js', exitCode: 1 },
      ],
      workdir,
      'packages/sub',
    )
    assert.equal(
      attempts[0]?.cwdHint,
      'packages/elsewhere/packages/sub',
      'the command names a directory relative to the shell, not to the worktree root',
    )
    assert.equal(
      attempts[0]?.matched,
      true,
      'matched is a command-text match; the broker checks the effective directory separately',
    )
    assert.equal(attempts[1]?.shape, 'unparsed')
    assert.equal(attempts[1]?.cwdHint, undefined, 'an uninterpretable command claims no directory')
    assert.equal(attempts[2]?.cwdHint, undefined, 'a shell expansion cannot be resolved to a directory')
    assert.equal(attempts[3]?.cwdHint, 'packages/sub project', 'a quoted literal path may contain spaces')
    assert.equal(attempts[4]?.cwdHint, undefined, 'cd - is shell state, not a directory name')
  } finally {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('a path on another drive is outside the worktree, not a retained hint', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'anvil-verification-drive-'))
  try {
    const attempts = observeVerificationAttempts(
      ['node verify.js'],
      [
        { command: 'node verify.js', exitCode: 1, cwd: 'Z:/private/example' },
        { command: 'node verify.js', exitCode: 1, cwd: '\\\\server\\share\\private' },
      ],
      workdir,
    )
    assert.equal(attempts.length, 2)
    assert.ok(
      attempts.every((attempt) => attempt.cwdHint === '<outside-worktree>'),
      'a foreign drive or UNC path must never be published as a relative hint',
    )
  } finally {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('only a direct runner-script invocation counts', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'anvil-verification-operand-'))
  try {
    const attempts = observeVerificationAttempts(
      ['node verify.js'],
      [
        { command: 'node helper.js verify.js', exitCode: 0 },
        { command: 'node helper.ts verify.js', exitCode: 0 },
        { command: 'node --require verify.js helper.js', exitCode: 0 },
        { command: 'node --version; cat verify.js', exitCode: 0 },
        { command: 'pwd && node verify.js', exitCode: 0 },
        { command: 'node verfy.js', exitCode: 127 },
      ],
      workdir,
    )
    assert.equal(attempts.length, 1, 'a later argument, option value or chained command is not attributed')
    assert.equal(attempts[0]?.script, 'verfy.js', 'the runner’s own operand must be the near miss')
  } finally {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('a non-integral tool exit status is unknown and round-trips', () => {
  const events = parseOpenCodeRunEvents(
    `${JSON.stringify({
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'shell',
        state: {
          status: 'completed',
          input: { command: 'node verify.js' },
          metadata: { metadata: { exit: 0.5 } },
        },
      },
    })}\n`,
  )
  const attempts = observeVerificationAttempts(['node verify.js'], events.executions, process.cwd())
  assert.equal(attempts.length, 1)
  assert.equal(attempts[0]?.exitCode, null, 'a fractional status is not a process exit code')

  const parsed = parseRunRecordResult(recordWith(attempts), 3)
  assert.equal(typeof parsed, 'object', `the harness must be able to parse its own record: ${String(parsed)}`)
  assert.equal(typeof parsed === 'object' ? parsed.verificationAttempts?.[0]?.exitCode : undefined, null)
})

test('a chained invocation carries no check exit status', () => {
  const attempts = observeVerificationAttempts(
    ['node verify.js'],
    [{ command: 'node verify.js; false', exitCode: 1 }],
    process.cwd(),
  )
  assert.equal(attempts.length, 1)
  assert.equal(attempts[0]?.shape, 'compound')
  assert.equal(attempts[0]?.exitCode, null, 'the chain status belongs to its last command')
})

test('a deep directory hint is bounded on write and accepted on read', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'anvil-verification-deep-'))
  try {
    const deep = join(workdir, ...Array.from({ length: 40 }, (_, index) => `segment-${index}`))
    const attempts = observeVerificationAttempts(
      ['node verify.js'],
      [{ command: 'node verify.js', exitCode: 1, cwd: deep }],
      workdir,
    )
    assert.ok((attempts[0]?.cwdHint?.length ?? 0) > MAX_VERIFICATION_ATTEMPT_CWD_HINT)

    const sanitized = sanitizeResult({ transcript: '', verificationAttempts: attempts } as ScenarioResult)
    const hint = sanitized.verificationAttempts?.[0]?.cwdHint
    assert.equal(hint?.length, MAX_VERIFICATION_ATTEMPT_CWD_HINT, 'writer and reader must share the cap')

    const attempt = {
      runner: 'node',
      script: 'verify.js',
      shape: 'simple',
      cwdHint: hint,
      exitCode: 1,
      matched: false,
    }
    const record = recordWith([attempt])
    const parsed = parseRunRecordResult(record)
    assert.equal(typeof parsed, 'object', `a bounded hint must round-trip: ${String(parsed)}`)
    assert.equal(typeof parsed === 'object' ? parsed.verificationAttempts?.[0]?.cwdHint : undefined, hint)
    assert.equal(
      typeof parseRunRecordResult(recordWith([{ ...attempt, cwdHint: `${hint}x` }])),
      'string',
      'an overlong hint must still be rejected',
    )
  } finally {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('a scenario without a script command produces no observations', () => {
  assert.deepEqual(
    observeVerificationAttempts(['npm test'], [{ command: 'npm test', exitCode: 1 }], process.cwd()),
    [],
    'a non-script check has no script name to look for; the attestation remains the record',
  )
})
