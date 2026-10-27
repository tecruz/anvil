/**
 * The Model Context Protocol surface.
 *
 * MCP is a transport, not a second implementation of the CLI. Every tool call spawns the
 * same `anvil ... --json` entry point a human would run, captures its envelope, and
 * returns the command's payload. That costs one process per call, which is irrelevant
 * for a control surface that agents poll every few minutes, and buys two things:
 *
 *   1. no parallel code path to keep in sync as commands change; and
 *   2. no command output can accidentally reach stdout, because the child owns its own
 *      stdout and this module writes only protocol lines to the server's.
 *
 * The transport is newline-delimited JSON-RPC 2.0 over stdio, as MCP specifies. There is no
 * SDK dependency to install: the protocol used here is four methods and a tool result shape.
 */

import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { runProcess, VERSION } from '@anvil/core'

/** Protocol revisions this server understands, newest first. */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const

const SUPPORTED_PROTOCOL = new Set<string>(PROTOCOL_VERSIONS)

type JsonRpcId = string | number | null

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: JsonRpcId
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface ToolContext {
  defaultCwd: string
}

interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  build(input: Record<string, unknown>, context: ToolContext): { args: string[]; cwd: string }
}

export interface McpInvokeResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** Runs the CLI with `args` from `cwd`. Injectable so protocol tests need no subprocess. */
export type McpInvoke = (args: string[], cwd: string) => Promise<McpInvokeResult>

export interface McpServerOptions {
  /** Defaults to spawning this CLI. Tests provide a fake. */
  invoke?: McpInvoke
  /** Working directory used when a tool call does not name one. */
  defaultCwd: string
  version?: string
}

class McpArgumentError extends Error {}

const CWD_SCHEMA = {
  type: 'string',
  description: "Directory to run in. Defaults to the server's working directory.",
} as const

const TOOLS: McpTool[] = [
  {
    name: 'anvil_doctor',
    description:
      "Audit this repository's AI readiness and return the same report `anvil doctor --json` produces. Read-only.",
    inputSchema: {
      type: 'object',
      properties: { cwd: CWD_SCHEMA },
      additionalProperties: false,
    },
    build(input, context) {
      return { args: ['doctor', '--json'], cwd: readCwd(input, context) }
    },
  },
  {
    name: 'anvil_plan',
    description: 'Return ranked, tiered fixes for this repository, equivalent to `anvil plan --json`. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: CWD_SCHEMA,
        limit: {
          type: 'integer',
          minimum: 1,
          description: 'Return at most this many suggestions.',
        },
        tier: {
          type: 'string',
          enum: ['derived', 'official', 'community'],
          description: 'Only return suggestions from this tier.',
        },
        includeSatisfied: {
          type: 'boolean',
          description: 'Keep suggestions the repository already satisfies.',
        },
      },
      additionalProperties: false,
    },
    build(input, context) {
      const args = ['plan', '--json']
      const limit = input.limit
      if (limit !== undefined) {
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
          throw new McpArgumentError('limit must be a positive integer')
        }
        args.push('--limit', String(limit))
      }
      const tier = input.tier
      if (tier !== undefined) {
        if (tier !== 'derived' && tier !== 'official' && tier !== 'community') {
          throw new McpArgumentError('tier must be derived, official or community')
        }
        args.push('--tier', tier)
      }
      if (input.includeSatisfied !== undefined) {
        if (typeof input.includeSatisfied !== 'boolean') {
          throw new McpArgumentError('includeSatisfied must be a boolean')
        }
        if (input.includeSatisfied) args.push('--include-satisfied')
      }
      return { args, cwd: readCwd(input, context) }
    },
  },
  {
    name: 'anvil_crew_status',
    description:
      'Report every claimed worktree, its agent, and whether that agent is still alive, equivalent to `anvil crew status --json`. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: CWD_SCHEMA,
        cost: {
          type: 'boolean',
          description: 'Include per-session cost when ccusage is available.',
        },
      },
      additionalProperties: false,
    },
    build(input, context) {
      const args = ['crew', 'status', '--json']
      if (input.cost !== undefined) {
        if (typeof input.cost !== 'boolean') {
          throw new McpArgumentError('cost must be a boolean')
        }
        if (input.cost) args.push('--cost')
      }
      return { args, cwd: readCwd(input, context) }
    },
  },
]

function readCwd(input: Record<string, unknown>, context: ToolContext): string {
  const cwd = input.cwd
  if (cwd === undefined) return context.defaultCwd
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new McpArgumentError('cwd must be a non-empty string')
  }
  return resolve(context.defaultCwd, cwd)
}

export function createCliInvoker(): McpInvoke {
  return async (args, cwd) => {
    const entry = process.argv[1]
    if (entry === undefined) {
      throw new Error('cannot locate the anvil entry point')
    }
    const result = await runProcess(process.execPath, [entry, ...args], {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      timeoutMs: 120_000,
    })
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === 'string' || typeof value === 'number'
}

function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function textResult(text: string, isError = false, structuredContent?: Record<string, unknown>) {
  return {
    content: [{ type: 'text', text }],
    ...(structuredContent === undefined ? {} : { structuredContent }),
    ...(isError ? { isError: true } : {}),
  }
}

function describeEnvelopeFailure(envelope: Record<string, unknown>, exitCode: number): string {
  const error = isRecord(envelope.error) ? envelope.error : null
  if (error === null) {
    return `anvil exited with code ${exitCode} and no error details.`
  }
  const message = typeof error.message === 'string' ? error.message : 'anvil failed'
  const hint = typeof error.hint === 'string' ? `\n${error.hint}` : ''
  const code = typeof error.code === 'string' ? `\ncode: ${error.code}` : ''
  return `${message}${hint}${code}`
}

async function callTool(
  name: string,
  input: Record<string, unknown>,
  invoke: McpInvoke,
  context: ToolContext,
): Promise<object> {
  const tool = TOOLS.find((candidate) => candidate.name === name)
  if (tool === undefined) {
    throw new McpArgumentError(`Unknown tool: ${name}`)
  }

  const schema = tool.inputSchema as { properties?: Record<string, unknown>; additionalProperties?: boolean }
  if (schema.additionalProperties === false && schema.properties !== undefined) {
    const allowed = new Set(Object.keys(schema.properties))
    for (const key of Object.keys(input)) {
      if (!allowed.has(key)) {
        throw new McpArgumentError(`Unknown property: ${key}`)
      }
    }
  }

  const { args, cwd } = tool.build(input, context)
  let result: McpInvokeResult
  try {
    result = await invoke(args, cwd)
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown)
    return textResult(`anvil could not be run: ${message}`, true)
  }

  let envelope: unknown
  try {
    envelope = JSON.parse(result.stdout.trim())
  } catch {
    const detail = (result.stderr.trim() || result.stdout.trim()).slice(0, 4000)
    return textResult(`anvil exited with code ${result.exitCode} and did not return JSON.\n${detail}`, true)
  }

  if (!isRecord(envelope)) {
    return textResult('anvil returned a JSON value that is not an envelope.', true)
  }

  const ok = envelope.ok === true && result.exitCode === 0
  if (!ok) {
    const text = describeEnvelopeFailure(envelope, result.exitCode)
    return textResult(text, true, {
      error: isRecord(envelope.error) ? envelope.error : { message: text },
    })
  }

  const data = envelope.data
  if (!isRecord(data)) {
    return textResult(JSON.stringify(data ?? null, null, 2))
  }
  return textResult(JSON.stringify(data, null, 2), false, data)
}

async function handleMessage(
  message: unknown,
  invoke: McpInvoke,
  context: ToolContext,
  version: string,
): Promise<JsonRpcResponse | null> {
  if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError(isRecord(message) && isId(message.id) ? message.id : null, -32600, 'Invalid Request')
  }

  const hasId = Object.hasOwn(message, 'id')
  if (!hasId) return null
  const id = isId(message.id) ? message.id : null
  const request = message as unknown as JsonRpcRequest

  try {
    switch (request.method) {
      case 'initialize': {
        const params = isRecord(request.params) ? request.params : {}
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : null
        const protocolVersion =
          requested !== null && SUPPORTED_PROTOCOL.has(requested) ? requested : PROTOCOL_VERSIONS[0]
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'anvil', version },
            instructions: 'Read-only repository controls. Start with anvil_doctor, then anvil_plan for ranked fixes.',
          },
        }
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} }
      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: TOOLS.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
          },
        }
      case 'tools/call': {
        const params = isRecord(request.params) ? request.params : {}
        if (typeof params.name !== 'string') {
          return rpcError(id, -32602, 'tools/call requires a tool name')
        }
        if (params.arguments !== undefined && !isRecord(params.arguments)) {
          return rpcError(id, -32602, 'tools/call arguments must be an object')
        }
        const args = isRecord(params.arguments) ? params.arguments : {}
        try {
          return { jsonrpc: '2.0', id, result: await callTool(params.name, args, invoke, context) }
        } catch (thrown) {
          if (thrown instanceof McpArgumentError) {
            return rpcError(id, -32602, thrown.message)
          }
          throw thrown
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${request.method}`)
    }
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown)
    return rpcError(id, -32603, `Internal error: ${message}`)
  }
}

/**
 * Read one JSON-RPC message per line until stdin closes.
 *
 * Requests are handled sequentially on purpose. The protocol allows concurrency, but every
 * tool call runs a process that mutates or reads the same repository; serialising them makes
 * `doctor` followed by `plan` deterministic and keeps output order equal to input order.
 */
export async function serveMcp(input: Readable, output: Writable, options: McpServerOptions): Promise<void> {
  const invoke = options.invoke ?? createCliInvoker()
  const context = { defaultCwd: options.defaultCwd }
  const version = options.version ?? VERSION
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })

  for await (const line of lines) {
    if (line.trim() === '') continue
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      output.write(`${JSON.stringify(rpcError(null, -32700, 'Parse error'))}\n`)
      continue
    }
    const response = await handleMessage(message, invoke, context, version)
    if (response !== null) output.write(`${JSON.stringify(response)}\n`)
  }
}
