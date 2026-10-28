import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { limitTranscript, redactTranscript, type ScenarioResult, sanitizeResult } from '../eval.ts'

function secretPresent(text: string): boolean {
  return /sk-[A-Za-z0-9]{20,}|sk-or-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,}/.test(text)
}

describe('transcript redaction', () => {
  test('redacts OpenAI-style keys', () => {
    const out = redactTranscript('the key is sk-1234567890abcdef1234567890abcdef')
    assert.ok(!secretPresent(out), 'secret must be redacted')
    assert.match(out, /\[redacted\]/)
  })

  test('redacts OpenRouter keys', () => {
    const out = redactTranscript('token: sk-or-1234567890abcdef1234567890abcdef')
    assert.ok(!secretPresent(out), 'secret must be redacted')
    assert.match(out, /\[redacted\]/)
  })

  test('redacts GitHub personal access tokens', () => {
    const out = redactTranscript('ghp_1234567890abcdef1234567890abcdef1234')
    assert.ok(!secretPresent(out), 'secret must be redacted')
    assert.match(out, /\[redacted\]/)
  })

  test('redacts GitHub fine-grained tokens', () => {
    const out = redactTranscript('github_pat_1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ')
    assert.ok(!secretPresent(out), 'secret must be redacted')
    assert.match(out, /\[redacted\]/)
  })

  test('leaves ordinary text unchanged', () => {
    const text = 'the agent ran npm test and it passed'
    assert.equal(redactTranscript(text), text)
  })

  test('size-limits long transcripts keeping head and tail', () => {
    const long = 'x'.repeat(200_000)
    const out = limitTranscript(long)
    assert.ok(out.length < long.length, 'truncated')
    assert.match(out, /\[transcript truncated/)
    assert.match(out, /^x{32000}/, 'keeps head')
    assert.match(out, /x{32000}$/, 'keeps tail')
  })

  test('does not truncate short transcripts', () => {
    const text = 'short transcript'
    assert.equal(limitTranscript(text), text)
  })

  test('redacts and limits combined', () => {
    // Use a long string of whitespace-padded words that won't match secret patterns
    const filler = ' word'.repeat(20_000)
    const withSecret = `key sk-1234567890abcdef1234567890abcdef${filler}`
    const out = limitTranscript(redactTranscript(withSecret))
    assert.ok(!secretPresent(out), 'secret must be redacted')
    assert.match(out, /\[transcript truncated/)
  })

  test('sanitizes errors, verifier output, and transcripts before persistence', () => {
    const secret = 'sk-1234567890abcdef1234567890abcdef'
    const result: ScenarioResult = {
      scenario: 'tiny-code-change',
      size: 'tiny',
      kind: 'code-change',
      variant: 'bare',
      model: 'fake-agent',
      modelRole: null,
      opencodeVersion: null,
      scenarioHash: 'scenario-hash',
      sourceHash: 'source-hash',
      verifyCount: 1,
      hiddenVerifyCount: 0,
      verified: false,
      hiddenVerified: null,
      verifyExitCodes: [1],
      costUsd: null,
      tokens: null,
      durationMs: 1,
      transcript: `transcript ${secret}`,
      verifyOutput: `verifier ${secret}`,
      error: `agent ${secret}`,
    }
    const safe = sanitizeResult(result)
    assert.ok(!secretPresent(safe.transcript), 'transcript must be redacted')
    assert.ok(!secretPresent(safe.verifyOutput ?? ''), 'verifier output must be redacted')
    assert.ok(!secretPresent(safe.error ?? ''), 'error must be redacted')
  })
})
