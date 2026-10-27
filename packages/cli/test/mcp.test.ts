import assert from 'node:assert/strict'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { type McpInvoke, type McpInvokeResult, serveMcp } from '../src/mcp.ts'

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: unknown
  result?: unknown
  error?: { code: number; message: string }
}

async function send(lines: string[], invoke: McpInvoke): Promise<JsonRpcResponse[]> {
  const input = new PassThrough()
  const output = new PassThrough()
  const chunks: string[] = []
  output.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')))

  const done = serveMcp(input, output, {
    invoke,
    defaultCwd: process.cwd(),
    version: '1.0.0',
  })

  for (const line of lines) input.write(`${line}\n`)
  input.end()
  await done

  return chunks
    .join('')
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as JsonRpcResponse)
}

function envelope(data: unknown, ok = true, exitCode = 0): McpInvokeResult {
  return {
    exitCode,
    stdout: JSON.stringify({ schemaVersion: 1, ok, command: 'anvil', data }),
    stderr: '',
  }
}

function recordingInvoke(result: (args: string[]) => McpInvokeResult): {
  invoke: McpInvoke
  calls: Array<{ args: string[]; cwd: string }>
} {
  const calls: Array<{ args: string[]; cwd: string }> = []
  const invoke: McpInvoke = async (args, cwd) => {
    calls.push({ args, cwd })
    return result(args)
  }
  return { invoke, calls }
}

test('initialize, tools/list, a successful tool call and a failed one', async () => {
  const { invoke, calls } = recordingInvoke((args) => {
    if (args[0] === 'doctor') return envelope({ score: 95, checks: [] })
    return {
      exitCode: 1,
      stdout: JSON.stringify({
        schemaVersion: 1,
        ok: false,
        command: 'plan',
        error: { code: 'E_NOT_A_REPO', message: 'Not a repo', hint: 'Run inside git' },
      }),
      stderr: '',
    }
  })

  const responses = await send(
    [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'anvil_doctor', arguments: {} } }),
      JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'anvil_plan', arguments: {} } }),
    ],
    invoke,
  )

  assert.equal(responses.length, 4, 'a notification produces no response')

  const initialized = responses[0]?.result as {
    protocolVersion: string
    serverInfo: { name: string; version: string }
  }
  assert.equal(responses[0]?.id, 1)
  assert.equal(initialized.protocolVersion, '2024-11-05')
  assert.equal(initialized.serverInfo.name, 'anvil')
  assert.equal(initialized.serverInfo.version, '1.0.0')

  const listed = responses[1]?.result as { tools: Array<{ name: string }> }
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ['anvil_crew_status', 'anvil_doctor', 'anvil_plan'])

  const doctor = responses[2]?.result as {
    content: Array<{ type: string; text: string }>
    structuredContent: { score: number }
  }
  assert.equal(responses[2]?.id, 3)
  assert.equal(doctor.content[0]?.type, 'text')
  assert.equal(doctor.structuredContent.score, 95)
  assert.deepEqual(calls[0], { args: ['doctor', '--json'], cwd: process.cwd() })

  const plan = responses[3]?.result as { isError: boolean; content: Array<{ text: string }> }
  assert.equal(responses[3]?.id, 4)
  assert.equal(plan.isError, true)
  assert.match(plan.content[0]?.text ?? '', /Not a repo/)
})

test('tool arguments become CLI flags and a resolved cwd', async () => {
  const { invoke, calls } = recordingInvoke(() => envelope({ suggestions: [] }))

  const responses = await send(
    [
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'anvil_plan',
          arguments: { cwd: 'fixtures/repo', limit: 2, tier: 'official', includeSatisfied: true },
        },
      }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'anvil_crew_status', arguments: { cwd: 'fixtures/crew', cost: true } },
      }),
    ],
    invoke,
  )

  assert.equal(responses.length, 2)
  assert.deepEqual(calls[0]?.args, ['plan', '--json', '--limit', '2', '--tier', 'official', '--include-satisfied'])
  assert.equal(calls[0]?.cwd, join(process.cwd(), 'fixtures', 'repo'))
  assert.deepEqual(calls[1]?.args, ['crew', 'status', '--json', '--cost'])
  assert.equal(calls[1]?.cwd, join(process.cwd(), 'fixtures', 'crew'))
})

test('protocol errors are reported, not swallowed', async () => {
  const { invoke } = recordingInvoke(() => envelope({}))
  const responses = await send(
    ['{not json', JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'resources/list' })],
    invoke,
  )

  assert.equal(responses[0]?.id, null)
  assert.equal(responses[0]?.error?.code, -32700)

  assert.equal(responses[1]?.id, 2)
  assert.equal(responses[1]?.error?.code, -32601)
})

test('an unknown tool is an argument error, not a successful empty result', async () => {
  const { invoke, calls } = recordingInvoke(() => envelope({}))
  const responses = await send(
    [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'anvil_nope' } })],
    invoke,
  )

  assert.equal(responses[0]?.error?.code, -32602)
  assert.equal(calls.length, 0)
})

test('an unknown argument is rejected instead of silently ignored', async () => {
  // A schema with `additionalProperties: false` is a promise to the client. Ignoring a
  // misspelled flag means the caller believes an option was honoured and it never was.
  const { invoke, calls } = recordingInvoke(() => envelope({}))
  const responses = await send(
    [
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'anvil_doctor', arguments: { cwd: '.', verbose: true } },
      }),
    ],
    invoke,
  )

  assert.equal(responses[0]?.error?.code, -32602)
  assert.match(responses[0]?.error?.message ?? '', /Unknown property: verbose/)
  assert.equal(calls.length, 0)
})

test('non-object call arguments are an argument error', async () => {
  const { invoke, calls } = recordingInvoke(() => envelope({}))
  const responses = await send(
    [
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'anvil_doctor', arguments: 'nope' },
      }),
    ],
    invoke,
  )

  assert.equal(responses[0]?.error?.code, -32602)
  assert.equal(calls.length, 0)
})
