/**
 * Bounded observations for a failed verification attempt.
 *
 * The grading attestation deliberately records only the one command that counts as evidence.
 * That is enough to decide a result and not enough to explain it. These tests pin the nearby
 * question: a near-miss command is retained with its reported exit status and a relative
 * directory, while unrelated shell activity is not retained at all.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { type AgentExecution, observeVerificationAttempts } from '../eval.ts'

test('near-miss verification commands are retained, with a relative directory', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'anvil-verification-attempts-'))
  try {
    const executions: AgentExecution[] = [
      { command: 'npm install', exitCode: 0 },
      {
        command: `cd ${join(workdir, 'packages', 'sub')} && node verfy.js`,
        exitCode: 127,
      },
      { command: 'node ./verify.js', exitCode: 1 },
    ]
    const attempts = observeVerificationAttempts(['node verify.js'], executions, workdir)

    assert.equal(attempts.length, 2, 'only commands naming the check script are retained')
    assert.equal(attempts[0]?.matched, false, 'a typo is a near miss, not evidence')
    assert.equal(attempts[0]?.exitCode, 127, 'the reported status is worth knowing')
    assert.equal(attempts[0]?.cwdHint, 'packages/sub', 'the named directory is relative to the worktree')
    assert.match(attempts[0]?.command ?? '', /node verfy\.js/)
    assert.ok(!(attempts[0]?.command ?? '').includes(workdir), 'a host worktree path must not be published')

    assert.equal(attempts[1]?.matched, true, 'the declared command is still recognised after ./ normalization')
    assert.equal(attempts[1]?.cwdHint, undefined, 'no cwd was named, so none is claimed')
  } finally {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('a tool-reported cwd wins over a directory guessed from the command text', () => {
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
      ],
      workdir,
      'packages/sub',
    )
    assert.equal(attempts[0]?.cwdHint, 'packages/elsewhere', 'the tool event is more direct than the command')
    assert.equal(attempts[0]?.matched, true, 'the directory-bound form still matches the declared check')
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
