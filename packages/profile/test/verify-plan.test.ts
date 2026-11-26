import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { verificationPlan } from '../src/verify-plan.ts'

const profile = {
  projectDir: 'services/api',
  commands: {
    testFast: [{ cmd: 'npm run unit', source: 'documented' as const, evidence: 'README.md:12' }],
    test: [{ cmd: 'npm test', source: 'documented' as const, evidence: 'README.md:10' }],
    typecheck: [{ cmd: 'npm run types', source: 'detected' as const, evidence: 'package.json:8' }],
  },
}

describe('the shared verification plan', () => {
  test('detected commands keep their directory, source and evidence', () => {
    const plan = verificationPlan(profile)
    assert.deepEqual(
      plan.commands.map((entry) => [entry.cmd, entry.dir, entry.source, entry.evidence]),
      [
        ['npm run unit', 'services/api', 'documented', 'README.md:12'],
        ['npm test', 'services/api', 'documented', 'README.md:10'],
        ['npm run types', 'services/api', 'detected', 'package.json:8'],
      ],
    )
    assert.deepEqual(plan.conflicts, [])
  })

  test('an owner declaration wins and the conflict stays visible', () => {
    const plan = verificationPlan(profile, [
      { kind: 'test', cmd: 'npm run verify:ci', dir: 'ci' },
      { kind: 'build', cmd: 'make build' },
    ])
    const testEntry = plan.commands.find((entry) => entry.kind === 'test')
    assert.equal(testEntry?.cmd, 'npm run verify:ci')
    assert.equal(testEntry?.dir, 'ci')
    assert.equal(testEntry?.source, 'declared')
    assert.equal(testEntry?.evidence, 'anvil.config.json')
    assert.deepEqual(plan.conflicts, [{ kind: 'test', declared: 'npm run verify:ci', detected: 'npm test' }])
    const build = plan.commands.find((entry) => entry.kind === 'build')
    assert.equal(build?.dir, 'services/api', 'a declaration without dir keeps the detected project directory')
  })

  test('a duplicate command is not run twice and a pure plan is deterministic', () => {
    const declared = [{ kind: 'test' as const, cmd: 'npm run unit' }]
    const first = verificationPlan(profile, declared)
    const second = verificationPlan(profile, declared)
    assert.equal(new Set(first.commands.map((entry) => entry.cmd)).size, first.commands.length)
    assert.deepEqual(first, second)
  })
})
