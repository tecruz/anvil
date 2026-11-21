/**
 * Pilot verifiers read only the agent-written report, so they can be graded without the
 * local pinned clones. This matters: the extended-scenario suite skips those clones on a
 * clean checkout, which would otherwise hide a verifier that no canned answer can pass.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { tokenizeCommand } from '../../packages/core/src/args.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const scenarios = (
  JSON.parse(readFileSync(join(root, 'eval/scenarios.json'), 'utf8')) as {
    scenarios: Array<{
      id: string
      solution: { from: string }
      verify: string[]
      hiddenVerify: string[]
    }>
  }
).scenarios.filter((s) => s.id.startsWith('pilot-'))

function grade(command: string, cwd: string): boolean {
  const [bin, ...args] = tokenizeCommand(command)
  assert.ok(bin, 'a verifier must have a command')
  return spawnSync(bin, args, { cwd, encoding: 'utf8' }).status === 0
}

describe('pilot report verifiers', () => {
  for (const scenario of scenarios) {
    const dir = mkdtempSync(join(tmpdir(), 'pilot-verifier-'))
    after(() => rmSync(dir, { recursive: true, force: true }))

    const report = join(dir, '.anvil-eval-report.json')
    const canned = JSON.parse(readFileSync(join(root, scenario.solution.from), 'utf8')) as Record<string, unknown>
    const commands = [...scenario.verify, ...scenario.hiddenVerify]

    test(`${scenario.id}: the known-good report passes every verifier`, () => {
      writeFileSync(report, JSON.stringify(canned))
      for (const command of commands) {
        assert.equal(grade(command, dir), true, `verifier must accept the known-good report: ${command}`)
      }
    })

    test(`${scenario.id}: a no-op fails grading`, () => {
      writeFileSync(report, '{}')
      for (const command of commands) {
        assert.equal(grade(command, dir), false, `verifier must reject an empty report: ${command}`)
      }
    })

    test(`${scenario.id}: a false handoff is rejected`, () => {
      // An invented owner, a missing source citation and a wrong command are the three
      // failure shapes the ground-truth cards warn about.
      writeFileSync(
        report,
        JSON.stringify({ ...canned, owner: 'someone@example.com', source: '', command: 'echo done' }),
      )
      for (const command of commands) {
        assert.equal(grade(command, dir), false, `verifier must reject a false handoff: ${command}`)
      }
    })
  }
})
