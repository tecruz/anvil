import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { CrewVerifyResult } from '@anvil/worktrees/crew'
import { currentRecordFor, type EvidenceStore } from '../src/commands/crew.ts'
import { isCurrentEvidenceRecord, planDigestForEntries, verdictFor } from '../src/verification-evidence.ts'

const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const store: EvidenceStore = { root: '/repo', key: '0123456789abcdef' }

function result(overrides: Partial<CrewVerifyResult['results'][number]> = {}): CrewVerifyResult['results'][number] {
  return {
    key: 'local-1',
    worktree: '/repo-worktrees/local-1',
    ok: true,
    commands: [
      {
        command: 'npm test',
        cwd: '/repo-worktrees/local-1',
        ok: true,
        code: 0,
        exitObserved: true,
        revision: COMMIT,
        revisionAfter: COMMIT,
        startedAt: '2026-11-26T10:00:00.000Z',
        completedAt: '2026-11-26T10:00:05.000Z',
        detail: '',
      },
    ],
    ...overrides,
  }
}

describe('crew verification recording', () => {
  test('commands in different directories keep their own directory in the evidence', () => {
    const base = result().commands[0]!
    const mixed = result({
      commands: [
        { ...base, command: 'npm run verify:ci', logicalCwd: 'ci' },
        { ...base, command: 'npm test', logicalCwd: 'packages/api' },
      ],
    })

    const record = currentRecordFor(mixed, store)
    assert.ok(record !== null)
    assert.equal(record.cwd, 'ci', 'the top-level cwd stays readable for older readers')
    assert.deepEqual(
      record.commands.map((command) => command.dir),
      ['ci', 'packages/api'],
    )
    assert.equal(
      record.planDigest,
      planDigestForEntries([
        { cmd: 'npm run verify:ci', dir: 'ci' },
        { cmd: 'npm test', dir: 'packages/api' },
      ]),
    )
    assert.notEqual(
      record.planDigest,
      planDigestForEntries([
        { cmd: 'npm run verify:ci', dir: '' },
        { cmd: 'npm test', dir: 'packages/api' },
      ]),
      'a changed directory is a different plan',
    )
    assert.equal(verdictFor(record, COMMIT), 'current')
  })

  test('a branch that moved during the check cannot yield a current record', () => {
    const base = result().commands[0]!
    const moved = result({
      commands: [{ ...base, logicalCwd: 'packages/api', revisionAfter: 'f'.repeat(40) }],
    })
    assert.equal(currentRecordFor(moved, store), null)
  })

  test('a clean, stable worktree produces a current record bound to its own directory', () => {
    const record = currentRecordFor(result(), store)
    assert.ok(record !== null)
    assert.equal(isCurrentEvidenceRecord(record), true)
    assert.equal(record.cwd, '')
    assert.equal(record.commit, COMMIT)
    assert.equal(record.clean, true)
    assert.equal(record.planDigest, planDigestForEntries([{ cmd: 'npm test', dir: '' }]))
    assert.equal(verdictFor(record, COMMIT), 'current')
  })

  test('a nested project directory is recorded relative to the worktree', () => {
    const nested = result({
      commands: [
        {
          command: 'node verify.js',
          cwd: '/repo-worktrees/local-1/packages/sub',
          ok: true,
          code: 0,
          exitObserved: true,
          revision: COMMIT,
          revisionAfter: COMMIT,
          startedAt: '2026-11-26T10:00:00.000Z',
          completedAt: '2026-11-26T10:00:05.000Z',
          detail: '',
        },
      ],
    })
    const record = currentRecordFor(nested, store)
    assert.equal(record?.cwd, 'packages/sub')
  })

  test('a dirty or moved tree records no current commit', () => {
    const dirty = currentRecordFor(
      result({
        commands: [
          { ...result().commands[0]!, revision: `${COMMIT}-dirty`, revisionAfter: `${COMMIT}-dirty` },
          { ...result().commands[0]!, revision: `${COMMIT}-dirty`, revisionAfter: `${COMMIT}-dirty` },
        ],
      }),
      store,
    )
    assert.equal(dirty?.clean, false)
    assert.equal(dirty?.commit, null)
    assert.equal(verdictFor(dirty!, COMMIT), 'stale')

    const moved = currentRecordFor(
      result({
        commands: [{ ...result().commands[0]!, revisionAfter: 'ffffffffffffffffffffffffffffffffffffffff' }],
      }),
      store,
    )
    assert.equal(moved, null)
  })

  test('an unobserved exit is recorded without inventing a zero', () => {
    const record = currentRecordFor(
      result({
        ok: false,
        commands: [{ ...result().commands[0]!, ok: false, exitObserved: false, code: 1 }],
      }),
      store,
    )
    assert.equal(record?.commands[0]?.exitCode, null)
    assert.equal(record?.commands[0]?.exitObserved, false)
    assert.equal(verdictFor(record!, COMMIT), 'incomplete')
  })
})
