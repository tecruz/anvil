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
