/**
 * Rule behavior that depends on caller-supplied context.
 *
 * The golden suite audits profiles with `audit(profile)`, which is the "matching was not
 * run" path. These tests exercise the two answers that path cannot represent: a registry
 * match, and a registry that was consulted and had nothing.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'

import { audit, type ReadinessReport } from '@anvil/audit'
import { buildProfile, type ProjectProfile } from '@anvil/profile'

const temps: string[] = []
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'anvil-rules-'))
  temps.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, ...rel.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return dir
}

const VCS = { root: '', host: null, remote: null, defaultBranch: null }

function profileOf(files: Record<string, string>, maxFiles?: number): ProjectProfile {
  const dir = repo(files)
  return buildProfile(dir, { ...VCS, root: dir }, maxFiles === undefined ? {} : { maxFiles }).profile
}

function finding(report: ReadinessReport, id: string) {
  const found = report.findings.find((f) => f.id === id)
  assert.ok(found !== undefined, `expected a finding for ${id}`)
  return found
}

describe('PLAYBOOK distinguishes not-asked from no-match', () => {
  const files = {
    'package.json': JSON.stringify({ name: 'app', devDependencies: { typescript: '^5.9.0' } }),
    'src/index.ts': 'export const app = 1\n',
  }

  test('not run is na, not a warning about the repository', () => {
    assert.equal(finding(audit(profileOf(files)), 'PLAYBOOK').status, 'na')
  })

  test('a match passes and carries the match evidence', () => {
    const report = audit(profileOf(files), {
      playbookMatches: [{ id: 'node', evidence: ['package.json'] }],
    })
    const playbook = finding(report, 'PLAYBOOK')
    assert.equal(playbook.status, 'pass')
    assert.match(playbook.detail, /node/)
    assert.deepEqual(playbook.evidence, ['package.json'])
  })

  test('a consulted registry with no match warns', () => {
    const playbook = finding(audit(profileOf(files), { playbookMatches: [] }), 'PLAYBOOK')
    assert.equal(playbook.status, 'warn')
    assert.match(playbook.detail, /No matching playbook/)
  })
})

describe('profile completeness is part of the report', () => {
  test('a truncated walk appears in degraded', () => {
    const report = audit(profileOf({ 'a.ts': 'export {}\n', 'b.ts': 'export {}\n' }, 1))
    assert.ok(report.degraded.some((d) => d.reason.includes('stopped at 1 files')))
  })

  test('the STYLE_GUIDE title names what it actually checks', () => {
    const report = audit(profileOf({ 'README.md': '# app\n' }))
    assert.equal(finding(report, 'STYLE_GUIDE').title, 'Architecture decision records present')
  })
})

describe('a probed MCP file is visible to the rule', () => {
  test('.vscode/mcp.json passes MCP even though .vscode is not walked', () => {
    const profile = profileOf({
      'package.json': '{}',
      '.vscode/mcp.json': '{"servers":{}}',
      '.vscode/settings.json': '{}',
    })
    const mcp = finding(audit(profile), 'MCP')
    assert.equal(mcp.status, 'pass')
    assert.deepEqual(mcp.evidence, ['.vscode/mcp.json'])
  })
})

describe('AGENT_CONFIG catches rot that the profile walker cannot see', () => {
  const scripts = JSON.stringify({ scripts: { test: 'node --test', lint: 'biome check' } })

  test('commands, links and instruction globs that resolve are a pass', () => {
    const profile = profileOf({
      'package.json': scripts,
      'AGENTS.md': '# App\n\nRun `npm test`.\n',
      'docs/README.md': '# Docs\n',
      '.opencode/commands/check.md': 'Run `npm run test` and `npm run lint`.\n',
      '.agents/skills/verify/SKILL.md': 'See [the docs](../../../docs/README.md).\n\n```bash\nnpm run test\n```\n',
      'opencode.json': JSON.stringify({ instructions: ['AGENTS.md', 'docs/*.md'] }),
    })
    const config = finding(audit(profile), 'AGENT_CONFIG')
    assert.equal(config.status, 'pass', config.detail)
    assert.match(config.detail, /resolve/)
  })

  test('a deleted npm script, a moved link and an empty glob are reported together', () => {
    const profile = profileOf({
      'package.json': scripts,
      'AGENTS.md': '# App\n',
      '.opencode/commands/check.md': 'Run `npm run test:changed`.\n',
      '.agents/skills/verify/SKILL.md': 'See [the missing doc](../../../docs/gone.md).\n',
      'opencode.json': JSON.stringify({ instructions: ['AGENTS.md', 'docs/*.md'] }),
    })
    const config = finding(audit(profile), 'AGENT_CONFIG')
    assert.equal(config.status, 'warn')
    assert.match(config.detail, /test:changed/)
    assert.match(config.detail, /gone\.md/)
    assert.match(config.detail, /matches no tracked file/)
    assert.ok(config.evidence.some((e) => e.startsWith('.opencode/commands/check.md:')))
    assert.ok(config.evidence.some((e) => e.startsWith('.agents/skills/verify/SKILL.md:')))
    assert.ok(config.evidence.some((e) => e.startsWith('opencode.json:')))
  })

  test('a bare npm test with no test script is stale', () => {
    const profile = profileOf({
      'package.json': JSON.stringify({ scripts: { lint: 'biome check' } }),
      '.opencode/commands/check.md': 'Run `npm test` first.\n',
    })
    const config = finding(audit(profile), 'AGENT_CONFIG')
    assert.equal(config.status, 'warn')
    assert.match(config.detail, /test/)
  })

  test('nothing to check is na, not a warning', () => {
    const profile = profileOf({
      'package.json': scripts,
      'src/index.ts': 'export const app = 1\n',
    })
    assert.equal(finding(audit(profile), 'AGENT_CONFIG').status, 'na')
  })
})
