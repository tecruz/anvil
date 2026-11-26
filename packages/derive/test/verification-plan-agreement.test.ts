/**
 * One nested, declared task must produce the same verification command and directory in
 * every artifact an agent reads and in the plan the runners execute. A disagreement here is
 * the exact failure the shared `@anvil/profile` plan exists to prevent: AGENTS.md can tell
 * the agent to run one command while `crew verify` or `ship` runs another.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { audit } from '@anvil/audit'
import { buildBrief, buildReadyReport, generateAgentsFile, generateVerifySkill } from '@anvil/derive'
import type { MatchResult } from '@anvil/playbooks'
import { emptyProfile, type ProjectProfile, verificationPlan } from '@anvil/profile'

const DECLARED = {
  commands: [{ kind: 'test' as const, cmd: 'make verify:ci', dir: 'engine' }],
  tools: [],
  env: [],
  services: [],
  references: [],
  credentials: [],
  access: [],
  hardware: [],
}
const matches: readonly MatchResult[] = []

function profile(): ProjectProfile {
  return {
    ...emptyProfile('/repo', { host: null, remote: null, defaultBranch: null, root: '/repo' }),
    projectDir: 'engine',
    commands: {
      test: [{ cmd: 'npm test', source: 'documented', evidence: 'package.json:12' }],
    },
  }
}

describe('guidance agrees with the effective verification plan', () => {
  test('the shared plan picks the declared command in its own directory', () => {
    const plan = verificationPlan(profile(), DECLARED.commands)
    const primary = plan.commands.find((entry) => entry.kind === 'test')
    assert.equal(primary?.cmd, 'make verify:ci')
    assert.equal(primary?.dir, 'engine')
    assert.deepEqual(plan.conflicts, [{ kind: 'test', declared: 'make verify:ci', detected: 'npm test' }])
  })

  test('the brief marks that same command primary, in the same directory', () => {
    const brief = buildBrief({
      profile: profile(),
      report: audit(profile()),
      matches,
      target: 'all',
      read: () => null,
      declared: DECLARED,
    })
    const primary = brief.commands.find((command) => command.primary === true && command.kind === 'test')
    assert.equal(primary?.cmd, 'make verify:ci')
    assert.equal(primary?.dir, 'engine')
  })

  test('generated AGENTS.md and the verify skill run that command from that directory', () => {
    const agents = generateAgentsFile({ profile: profile(), matches, declared: DECLARED })
    assert.match(agents.content, /`make verify:ci`/)
    assert.match(agents.content, /engine\//)

    const skill = generateVerifySkill({ profile: profile(), matches, declared: DECLARED })
    assert.ok(skill, 'a declared test command generates the verification skill')
    assert.match(skill.content, /cd engine && make verify:ci/)
  })

  test('the ready report carries the declared command and its directory', async () => {
    const report = await buildReadyReport({ profile: profile(), matches, declared: DECLARED, check: false })
    const declared = report.commands.find((command) => command.cmd === 'make verify:ci')
    assert.equal(declared?.dir, 'engine')
    assert.equal(declared?.source, 'declared')
  })
})
