import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { formatCost, lookupSessionCosts, parseCcusageSessions } from '../src/cost.ts'

/**
 * Cost is read from ccusage, the host's usage ledger.
 *
 * The tests here pin the two properties that matter: anvil does not price anything itself
 * (it reports what the ledger says), and a ledger that is absent, broken or shaped
 * differently is a note rather than a failure.
 */

const REPORT = JSON.stringify({
  sessions: [
    {
      sessionId: 'ses_one',
      inputTokens: 100,
      outputTokens: 200,
      totalTokens: 300,
      totalCost: 1.25,
      firstActivity: '2026-01-01T00:00:00.000Z',
      lastActivity: '2026-01-01T01:00:00.000Z',
      modelsUsed: ['glm-4.7'],
    },
    {
      sessionId: 'ses_two',
      totalTokens: 900,
      totalCost: 0.5,
      modelsUsed: ['glm-4.7', 'gpt-5'],
    },
  ],
  totals: { totalCost: 1.75, totalTokens: 1200 },
})

describe('parseCcusageSessions', () => {
  test('reads the cost and the tokens of each session', () => {
    const parsed = parseCcusageSessions(REPORT)
    assert.ok(parsed !== null)
    assert.equal(parsed.get('ses_one')?.costUsd, 1.25)
    assert.equal(parsed.get('ses_one')?.tokens, 300)
    assert.deepEqual(parsed.get('ses_two')?.models, ['glm-4.7', 'gpt-5'])
  })

  test('a report with no sessions is an answer, not a failure', () => {
    // "No sessions" and "this is not a report" are different answers, and the difference
    // is the whole point of returning null for the second one.
    const parsed = parseCcusageSessions(JSON.stringify({ sessions: [], totals: {} }))
    assert.ok(parsed !== null)
    assert.equal(parsed.size, 0)
  })

  test('something that is not a report is null', () => {
    assert.equal(parseCcusageSessions('not json'), null)
    assert.equal(parseCcusageSessions(JSON.stringify({ hello: 'world' })), null)
    assert.equal(parseCcusageSessions(JSON.stringify([1, 2, 3])), null)
  })

  test('a session with no cost is reported as unknown cost, not as zero', () => {
    // Zero is a claim about the price. "Not priced" is a claim about the report.
    const parsed = parseCcusageSessions(JSON.stringify({ sessions: [{ sessionId: 'ses_x' }] }))
    assert.equal(parsed?.get('ses_x')?.costUsd, null)
  })

  test('unknown fields are ignored rather than fatal', () => {
    const parsed = parseCcusageSessions(
      JSON.stringify({ sessions: [{ sessionId: 'ses_x', totalCost: 2, somethingNew: true }], future: {} }),
    )
    assert.equal(parsed?.get('ses_x')?.costUsd, 2)
  })
})

describe('lookupSessionCosts', () => {
  test('reports the cost of the sessions asked for, and only those', async () => {
    const calls: string[][] = []
    const report = await lookupSessionCosts(['ses_one', 'ses_missing'], async (argv) => {
      calls.push([...argv])
      return { ok: true, stdout: REPORT, stderr: '' }
    })
    assert.equal(report.available, true)
    assert.equal(report.sessions.get('ses_one')?.costUsd, 1.25)
    assert.equal(report.sessions.has('ses_missing'), false)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], ['ccusage', 'opencode', 'session', '--json'])
  })

  test('a ledger that is not installed is a note, not a failure', async () => {
    // Anvil does not depend on ccusage. A machine without it still gets a status report.
    const report = await lookupSessionCosts(['ses_one'], async () => ({
      ok: false,
      stdout: '',
      stderr: 'Command not found: ccusage',
    }))
    assert.equal(report.available, false)
    assert.match(report.reason ?? '', /ccusage/)
    assert.equal(report.sessions.size, 0)
  })

  test('the generic command is tried when the opencode one is not there', async () => {
    // An older ccusage has no per-source session report, and the generic one reads every
    // detected source -- including opencode.
    const calls: string[][] = []
    const report = await lookupSessionCosts(['ses_one'], async (argv) => {
      calls.push([...argv])
      if (argv[1] === 'opencode') return { ok: false, stdout: '', stderr: 'unknown command' }
      return { ok: true, stdout: REPORT, stderr: '' }
    })
    assert.equal(report.available, true)
    assert.equal(report.sessions.get('ses_one')?.costUsd, 1.25)
    assert.deepEqual(calls[1], ['ccusage', 'session', '--json'])
  })

  test('no sessions means no lookup at all', async () => {
    let called = false
    const report = await lookupSessionCosts([], async () => {
      called = true
      return { ok: true, stdout: REPORT, stderr: '' }
    })
    assert.equal(called, false)
    assert.equal(report.available, false)
    assert.match(report.reason ?? '', /no agent session/)
  })
})

describe('formatCost', () => {
  test('shows a small cost with enough precision to be worth reading', () => {
    assert.equal(formatCost({ sessionId: 's', costUsd: 0.0004, tokens: 1, models: [] }), '$0.0004')
    assert.equal(formatCost({ sessionId: 's', costUsd: 1.25, tokens: 1, models: [] }), '$1.25')
    assert.equal(formatCost({ sessionId: 's', costUsd: 0, tokens: 1, models: [] }), '$0.00')
  })

  test('an unknown cost is a dash, not a zero', () => {
    assert.equal(formatCost(undefined), '-')
    assert.equal(formatCost({ sessionId: 's', costUsd: null, tokens: null, models: [] }), '-')
  })
})
