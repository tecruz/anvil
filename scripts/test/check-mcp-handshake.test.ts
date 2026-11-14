/**
 * Tests for `scripts/check-mcp-handshake.ts` as a program.
 *
 * The packaging test imports `checkHandshake` and covers the rules. This file covers the
 * other half: the transcript parser and the exit codes `release.yml` depends on. A gate that
 * returns 0 on a rejected handshake publishes a broken artifact with a green check, so the
 * exit codes are part of the contract rather than an implementation detail.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { HandshakeError, parseResponses } from '../check-mcp-handshake.ts'

const SCRIPT = fileURLToPath(new URL('../check-mcp-handshake.ts', import.meta.url))

const temps: string[] = []
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

function fixture(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'anvil-handshake-'))
  temps.push(dir)
  const file = join(dir, name)
  writeFileSync(file, content, 'utf8')
  return file
}

const TOOLS = ['anvil_doctor', 'anvil_plan', 'anvil_crew_status'].map((name) => ({
  name,
  inputSchema: { type: 'object' },
}))

const VALID: readonly [Record<string, unknown>, Record<string, unknown>] = [
  {
    jsonrpc: '2.0',
    id: 1,
    result: {
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'anvil', version: '0.1.0' },
      capabilities: { tools: {} },
    },
  },
  { jsonrpc: '2.0', id: 2, result: { tools: TOOLS } },
]

const VALID_TEXT = `${VALID.map((message) => JSON.stringify(message)).join('\n')}\n`

function cli(...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  })
}

describe('parseResponses', () => {
  test('parses one response per line and ignores blank lines', () => {
    assert.deepEqual(parseResponses(`{"id":1}\n\n   \n{"id":2}\n`), [{ id: 1 }, { id: 2 }])
  })

  test('accepts CRLF line endings', () => {
    // GitHub runners on Windows write CRLF; a `\r` left on a line would break JSON.parse.
    assert.deepEqual(parseResponses('{"id":1}\r\n{"id":2}\r\n'), [{ id: 1 }, { id: 2 }])
  })

  test('an empty transcript is an empty list', () => {
    assert.deepEqual(parseResponses('\n \n'), [])
  })

  test('names the line that is not JSON', () => {
    assert.throws(
      () => parseResponses('{"id":1}\n{not json\n'),
      (error: unknown) => error instanceof HandshakeError && /response 1 is not JSON/.test(error.message),
    )
  })
})

describe('the checker CLI', () => {
  test('a valid handshake exits 0 and prints the summary', () => {
    const result = cli(fixture('valid.jsonl', VALID_TEXT))
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /mcp handshake: 2025-06-18, 3 tools/)
  })

  test('a valid handshake with an interleaved notification still exits 0', () => {
    const withNotification = [
      VALID[0],
      { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'ready' } },
      VALID[1],
    ]
    const text = `${withNotification.map((message) => JSON.stringify(message)).join('\n')}\n`
    const result = cli(fixture('notified.jsonl', text))
    assert.equal(result.status, 0, result.stderr)
  })

  test('a rejected handshake exits 1 and names the field', () => {
    const broken = [
      {
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2025-06-18',
          serverInfo: { name: 'anvil', version: '0.1.0' },
          capabilities: { tools: [] },
        },
      },
      { jsonrpc: '2.0', id: 2, result: { tools: TOOLS } },
    ]
    const text = `${broken.map((message) => JSON.stringify(message)).join('\n')}\n`
    const result = cli(fixture('broken.jsonl', text))
    assert.equal(result.status, 1)
    assert.match(result.stderr, /^::error::/)
    assert.match(result.stderr, /capabilities\.tools/)
  })

  test('a transcript that is not JSON exits 1 and names the line', () => {
    const result = cli(fixture('not-json.jsonl', 'not json at all\n'))
    assert.equal(result.status, 1)
    assert.match(result.stderr, /response 0 is not JSON/)
  })

  test('no file is a usage error, not a failed handshake', () => {
    const result = cli()
    assert.equal(result.status, 2)
    assert.match(result.stderr, /usage:/)
  })

  test('a missing file is a clean failure, not a stack trace', () => {
    const missing = join(tmpdir(), `anvil-handshake-missing-${process.pid}.jsonl`)
    const result = cli(missing)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /^::error::cannot read /)
    assert.doesNotMatch(result.stderr, /\n\s+at /, 'an uncaught fs error would print a stack trace')
  })
})
