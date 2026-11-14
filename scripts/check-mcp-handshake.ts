/**
 * `node scripts/check-mcp-handshake.ts` -- validate the handshake a real client would accept.
 *
 * One implementation, because two copies drift. The release workflow runs this before it
 * publishes, and the packaging test imports `checkHandshake`, so its regression cases
 * exercise the same code the release gate runs rather than a lookalike.
 *
 * The check is deliberately stricter than "a response arrived". A JSON-RPC error, a `result`
 * that is `null` or `{}`, an unsupported protocol version, an array-valued capability, or a
 * tool without an object `inputSchema` all reach a client as a server it cannot use. A
 * publish cannot be undone, so the gate asserts the shape the MCP schema promises.
 *
 * Usage: `node scripts/check-mcp-handshake.ts <responses.jsonl>`
 */

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** Protocol revisions the server implements, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const

/** Tools the release smoke test calls its artifact healthy for. */
export const REQUIRED_TOOLS = ['anvil_doctor', 'anvil_plan', 'anvil_crew_status'] as const

/** A handshake that failed validation. The message names the field that failed. */
export class HandshakeError extends Error {}

/** What a passing check reports, so the caller has something to log. */
export interface HandshakeSummary {
  protocolVersion: string
  toolCount: number
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HandshakeError(`${what} is not a JSON object: ${JSON.stringify(value)}`)
  }
  return value as Record<string, unknown>
}

function describeError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return JSON.stringify(error)
}

/** Parse newline-delimited JSON-RPC, naming the line that is not JSON. */
export function parseResponses(text: string): unknown[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line, index) => {
      try {
        return JSON.parse(line)
      } catch (error) {
        throw new HandshakeError(
          `response ${index} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    })
}

/**
 * The ids the release handshake sends, in order: `initialize`, then `tools/list`.
 *
 * The set is closed on purpose. A response with any other id answers a request this check
 * never made, so accepting it would mean accepting a transcript that does not describe the
 * handshake under test.
 */
const EXPECTED_RESPONSE_IDS: readonly number[] = [1, 2]

/**
 * Validate the envelope of every message and index the responses by id.
 *
 * Envelope checks come first: a malformed `jsonrpc`, a response without an id, a notification
 * that carries one, a duplicate id, or a response carrying neither `result` nor `error` is
 * wrong whatever the payload says. Duplicates matter because `find` on the raw list silently
 * reports the first response and hides a later failure for the same request.
 */
function indexResponses(responses: readonly unknown[]): Map<number, Record<string, unknown>> {
  const byId = new Map<number, Record<string, unknown>>()
  for (const [index, message] of responses.entries()) {
    const response = asObject(message, `message ${index}`)
    if (response.jsonrpc !== '2.0') {
      throw new HandshakeError(`message ${index} does not declare JSON-RPC 2.0`)
    }
    if (response.method !== undefined) {
      if (typeof response.method !== 'string' || response.method === '') {
        throw new HandshakeError(`message ${index} has a malformed notification method`)
      }
      if (response.id !== undefined) {
        throw new HandshakeError(`message ${index} is a notification and must not carry a request id`)
      }
      continue
    }
    const id = response.id
    if (typeof id !== 'number' || !EXPECTED_RESPONSE_IDS.includes(id)) {
      throw new HandshakeError(`message ${index} has no request id the handshake sent: ${JSON.stringify(id)}`)
    }
    // JSON-RPC 2.0: a response carries exactly one of `result` or `error`. `result: null` still
    // counts as present, and the payload check below reports it as the wrong shape.
    const hasResult = response.result !== undefined
    const hasError = response.error !== undefined
    if (hasResult === hasError) {
      throw new HandshakeError(`message ${index} (id ${id}) must carry exactly one of result or error`)
    }
    if (byId.has(id)) {
      throw new HandshakeError(`the handshake has more than one response with id ${id}`)
    }
    byId.set(id, response)
  }
  return byId
}

/**
 * Validate the responses an MCP client would have received.
 *
 * Every message must be JSON-RPC 2.0; a response needs an id and a notification must not
 * have one. `initialize` must return a result a client can use, and `tools/list` must
 * describe every tool completely enough to call it.
 */
export function checkHandshake(messages: unknown): HandshakeSummary {
  if (!Array.isArray(messages)) {
    throw new HandshakeError('the handshake is not a list of JSON-RPC messages')
  }
  if (messages.length === 0) {
    throw new HandshakeError('the handshake produced no responses')
  }

  // Envelope first: a malformed `jsonrpc`, a response without a requested id, a duplicate id,
  // or a notification carrying one is wrong whatever the payload says. A notification (no
  // `id`, a `method`) is legitimate traffic between the two responses this check requires, so
  // it is accepted rather than mistaken for a response with a missing id.
  const byId = indexResponses(messages)

  const initialize = byId.get(1)
  if (initialize === undefined) throw new HandshakeError('initialize produced no response')
  if (initialize.error !== undefined) {
    throw new HandshakeError(`initialize returned an error: ${describeError(initialize.error)}`)
  }
  const init = asObject(initialize.result, 'initialize result')

  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(init.protocolVersion as (typeof SUPPORTED_PROTOCOL_VERSIONS)[number])) {
    throw new HandshakeError(
      `initialize agreed to an unsupported protocol version: ${JSON.stringify(init.protocolVersion)}`,
    )
  }
  const serverInfo = asObject(init.serverInfo, 'initialize serverInfo')
  if (serverInfo.name !== 'anvil') {
    throw new HandshakeError(`initialize did not identify the server as anvil: ${JSON.stringify(serverInfo.name)}`)
  }
  if (typeof serverInfo.version !== 'string' || serverInfo.version === '') {
    throw new HandshakeError(`initialize reported no server version: ${JSON.stringify(serverInfo.version)}`)
  }
  const capabilities = asObject(init.capabilities, 'initialize capabilities')
  const toolsCapability = asObject(capabilities.tools, 'initialize capabilities.tools')
  // `listChanged` is optional in MCP 2025-06-18. A server may offer tools without promising
  // list-change notifications; what it must not do is send a non-boolean value.
  if (toolsCapability.listChanged !== undefined && typeof toolsCapability.listChanged !== 'boolean') {
    throw new HandshakeError(
      `initialize advertised a non-boolean listChanged: ${JSON.stringify(toolsCapability.listChanged)}`,
    )
  }

  const listed = byId.get(2)
  if (listed === undefined) throw new HandshakeError('tools/list produced no response')
  if (listed.error !== undefined) {
    throw new HandshakeError(`tools/list returned an error: ${describeError(listed.error)}`)
  }
  const list = asObject(listed.result, 'tools/list result')
  if (!Array.isArray(list.tools)) {
    throw new HandshakeError(`tools/list returned no tools array: ${JSON.stringify(list.tools)}`)
  }

  const names: string[] = []
  for (const [index, tool] of list.tools.entries()) {
    const entry = asObject(tool, `tools/list entry ${index}`)
    if (typeof entry.name !== 'string' || entry.name === '') {
      throw new HandshakeError(`tools/list entry ${index} has no name`)
    }
    const inputSchema = asObject(entry.inputSchema, `tools/list entry ${index} (${entry.name}) inputSchema`)
    if (inputSchema.type !== 'object') {
      throw new HandshakeError(
        `tools/list entry ${index} (${entry.name}) has an inputSchema that is not an object schema`,
      )
    }
    // The schema fields a client may relay to a model: wrong types here are a tool call that
    // fails at first use, long after this gate went green.
    if (
      inputSchema.properties !== undefined &&
      (typeof inputSchema.properties !== 'object' ||
        inputSchema.properties === null ||
        Array.isArray(inputSchema.properties))
    ) {
      throw new HandshakeError(`tools/list entry ${index} (${entry.name}) has a non-object inputSchema.properties`)
    }
    if (
      inputSchema.required !== undefined &&
      (!Array.isArray(inputSchema.required) || inputSchema.required.some((name) => typeof name !== 'string'))
    ) {
      throw new HandshakeError(
        `tools/list entry ${index} (${entry.name}) has an inputSchema.required that is not a list of names`,
      )
    }
    names.push(entry.name)
  }

  for (const required of REQUIRED_TOOLS) {
    if (!names.includes(required)) throw new HandshakeError(`tools/list is missing ${required}`)
  }

  return { protocolVersion: init.protocolVersion as string, toolCount: names.length }
}

function main(): void {
  const file = process.argv[2]
  if (file === undefined) {
    process.stderr.write('usage: node scripts/check-mcp-handshake.ts <responses.jsonl>\n')
    process.exit(2)
  }

  let summary: HandshakeSummary
  try {
    summary = checkHandshake(parseResponses(readFileSync(file, 'utf8')))
  } catch (error) {
    if (error instanceof HandshakeError) {
      process.stderr.write(`::error::${error.message}\n`)
      process.exit(1)
    }
    // A missing or unreadable file is a usage problem, not a bug in this script: report it
    // with the same `::error::` shape instead of letting an uncaught fs error print a stack
    // trace that says nothing about which file was wrong.
    const code = (error as NodeJS.ErrnoException).code
    if (typeof code === 'string') {
      process.stderr.write(`::error::cannot read ${file}: ${code}\n`)
      process.exit(1)
    }
    throw error
  }
  process.stdout.write(`mcp handshake: ${summary.protocolVersion}, ${summary.toolCount} tools\n`)
}

// Only run the CLI when executed directly; importing this module must not read stdin or exit.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
