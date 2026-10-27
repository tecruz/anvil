import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { limitTranscript, redactTranscript } from '../eval.ts'

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
})
