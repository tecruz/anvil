import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { parseOpenCodeRunEvents, run } from '../eval.ts'

const temps: string[] = []
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

describe('eval harness process environment', () => {
  test('parses OpenCode JSON tool events, not prose claims, as executed commands', () => {
    const output = [
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'node' } }),
      JSON.stringify({
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'bash',
          state: { status: 'completed', input: { command: 'node run-check.js' } },
        },
      }),
      JSON.stringify({
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'bash',
          state: { status: 'running', input: { command: 'node not-completed.js' } },
        },
      }),
      JSON.stringify({
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'read',
          state: { status: 'completed', input: { command: 'node not-a-shell.js' } },
        },
      }),
    ].join('\n')

    assert.deepEqual(parseOpenCodeRunEvents(output), {
      text: 'node',
      completedCommands: ['node run-check.js'],
    })
  })

  test('run sets PWD to the subprocess cwd, not the inherited PWD', async () => {
    const inherited = process.env.PWD ?? process.cwd()
    const scenario = temp('anvil-eval-scenario-')
    assert.notEqual(scenario, inherited, 'scenario must differ from the inherited directory')

    const result = await run(
      'node',
      ['-e', 'console.log(JSON.stringify({ pwd: process.env.PWD, cwd: process.cwd() }))'],
      scenario,
      { timeoutMs: 5000 },
    )

    assert.equal(result.ok, true, result.stderr || result.output)
    const reported = JSON.parse(result.stdout.trim())

    // OpenCode 2 prefers inherited PWD over cwd. The harness must override PWD so
    // the agent works in the scenario fixture, not in the directory that launched
    // the harness (the parent / repo checkout).
    assert.equal(reported.pwd, scenario, 'PWD must point at the subprocess cwd')
    assert.notEqual(reported.pwd, inherited, 'PWD must not be the inherited directory')
  })
})
