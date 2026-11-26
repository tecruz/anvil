import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  type CurrentEvidenceRecord,
  evidenceMatchesPlan,
  evidencePlanMatches,
  isCurrentEvidenceRecord,
  isLegacyEvidenceRecord,
  type LegacyEvidenceRecord,
  planDigestFor,
  planDigestForEntries,
  selectVerificationRecords,
  VERIFICATION_EVIDENCE_MAX_BYTES,
  verdictFor,
} from '../src/verification-evidence.ts'

const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

function record(overrides: Partial<CurrentEvidenceRecord> = {}): CurrentEvidenceRecord {
  return {
    schemaVersion: 2,
    claim: 'local-1',
    repository: '0123456789abcdef',
    commit: COMMIT,
    clean: true,
    cwd: 'packages/sub',
    commands: [{ command: 'npm test', exitCode: 0, exitObserved: true }],
    planDigest: planDigestFor('packages/sub', ['npm test']),
    startedAt: '2026-11-26T10:00:00.000Z',
    completedAt: '2026-11-26T10:00:05.000Z',
    outcome: 'passed',
    ...overrides,
  }
}

function legacy(overrides: Partial<LegacyEvidenceRecord> = {}): LegacyEvidenceRecord {
  return {
    command: 'npm test',
    revision: `${COMMIT}-dirty`,
    exitCode: 0,
    timestamp: '2026-11-26T10:00:05.000Z',
    ...overrides,
  }
}

describe('verification evidence contract', () => {
  test('a clean, observed, matching check is current', () => {
    assert.equal(verdictFor(record(), COMMIT), 'current')
  })

  test('a dirty tree can never be current, even at the same commit', () => {
    assert.equal(verdictFor(record({ clean: false, commit: null }), COMMIT), 'stale')
    assert.equal(verdictFor(record({ clean: false }), COMMIT), 'stale')
  })

  test('an unknown commit or an unobserved exit cannot be current', () => {
    assert.equal(verdictFor(record({ commit: null }), COMMIT), 'stale')
    assert.equal(verdictFor(record(), null), 'stale')
    assert.equal(
      verdictFor(record({ commands: [{ command: 'npm test', exitCode: null, exitObserved: false }] }), COMMIT),
      'incomplete',
    )
  })

  test('a different commit is stale and a changed plan has a different digest', () => {
    assert.equal(verdictFor(record(), 'ffffffffffffffffffffffffffffffffffffffff'), 'stale')
    assert.notEqual(planDigestFor('packages/sub', ['npm test']), planDigestFor('packages/sub', ['npm run test']))
    assert.notEqual(planDigestFor('packages/sub', ['npm test']), planDigestFor('', ['npm test']))
    assert.equal(isCurrentEvidenceRecord(record({ planDigest: 'not-a-digest' })), false)
  })

  test('a failed command is failed, not current', () => {
    assert.equal(
      verdictFor(
        record({
          outcome: 'failed',
          commands: [{ command: 'npm test', exitCode: 1, exitObserved: true }],
        }),
        COMMIT,
      ),
      'failed',
    )
  })

  test('legacy rows are history and never current', () => {
    assert.equal(verdictFor(legacy(), COMMIT), 'legacy')
    assert.equal(isLegacyEvidenceRecord(legacy()), true)
    assert.equal(isCurrentEvidenceRecord(legacy()), false)
  })

  test('a record whose command or directory changed is rejected outright', () => {
    const bad = record({ cwd: '../outside' })
    assert.equal(isCurrentEvidenceRecord(bad), false)
    const unknownExit = record({ commands: [{ command: 'npm test', exitCode: null, exitObserved: true }] })
    assert.equal(isCurrentEvidenceRecord(unknownExit), false)
  })

  test('selection keeps the newest bounded facts and drops incomplete rows under pressure', () => {
    const rows = [legacy({ timestamp: '2026-11-26T09:00:00.000Z' }), record()]
    const selected = selectVerificationRecords(rows)
    assert.equal(selected.length, 2)
    const huge = record({
      commands: Array.from({ length: 20 }, () => ({ command: 'x'.repeat(200), exitCode: 0, exitObserved: true })),
    })
    const bounded = selectVerificationRecords([huge, ...rows])
    assert.ok(Buffer.byteLength(`${JSON.stringify(bounded, null, 2)}\n`) <= VERIFICATION_EVIDENCE_MAX_BYTES)
  })
})

describe('plan matching for mixed directories', () => {
  const plan = [
    { cmd: 'npm run verify:ci', dir: 'ci' },
    { cmd: 'npm test', dir: 'packages/api' },
  ]
  const mixed = (): CurrentEvidenceRecord =>
    record({
      cwd: 'ci',
      planDigest: planDigestForEntries(plan),
      commands: plan.map((entry) => ({ command: entry.cmd, exitCode: 0, exitObserved: true, dir: entry.dir })),
    })

  test('a mixed-directory plan matches only when every directory matches', () => {
    assert.equal(evidencePlanMatches(mixed(), plan), true)
    assert.equal(evidenceMatchesPlan(mixed(), plan, COMMIT), true)
    assert.equal(
      evidencePlanMatches(mixed(), [
        { cmd: 'npm run verify:ci', dir: '' },
        { cmd: 'npm test', dir: 'packages/api' },
      ]),
      false,
    )
    assert.equal(
      evidencePlanMatches(mixed(), [
        { cmd: 'npm run verify:ci', dir: 'ci' },
        { cmd: 'npm test', dir: 'other' },
      ]),
      false,
    )
  })

  test('a stale commit never satisfies the plan', () => {
    assert.equal(evidencePlanMatches(mixed(), plan), true, 'the plan still matches')
    assert.equal(evidenceMatchesPlan(mixed(), plan, 'f'.repeat(40)), false, 'but the verdict is stale')
    assert.equal(evidenceMatchesPlan(mixed(), plan, null), false, 'an unknown commit is stale too')
  })

  test('pre-mixed evidence written with a single cwd stays readable', () => {
    const old = record({ cwd: 'packages/sub', planDigest: planDigestFor('packages/sub', ['npm test']) })
    assert.equal(evidencePlanMatches(old, [{ cmd: 'npm test', dir: 'packages/sub' }]), true)
    assert.equal(evidenceMatchesPlan(old, [{ cmd: 'npm test', dir: 'packages/sub' }], COMMIT), true)
  })
})
