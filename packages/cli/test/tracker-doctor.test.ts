/**
 * `anvil doctor` surfaces tracker candidates, and only configuration resolves a provider.
 *
 * The first half pins the informational surface: JSON data, text, and no effect on the
 * readiness score, grade, findings, threshold or exit code. The second half pins the
 * separation the issue asks for: files pointing at GitLab and Jira do not make resolution
 * choose either one.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { defaultConfig } from '@anvil/core'
import { detectTrackerCandidates } from '@anvil/profile'
import { ticketProviderFor } from '../src/tickets.ts'

const CLI = join(import.meta.dirname, '..', 'src', 'main.ts')

const temps: string[] = []
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

function repo(files: Record<string, string>): string {
  const dir = temp('anvil-tracker-doctor-')
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, ...rel.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return dir
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

function runAnvil(args: string[]): RunResult {
  const configHome = temp('anvil-tracker-config-')
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, NO_COLOR: '1', ANVIL_CONFIG_HOME: configHome },
    })
    return { code: 0, stdout, stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

interface DoctorData {
  score: number
  grade: string
  findings: Array<{ id: string; status: string; severity: string }>
  tracker: {
    state: string
    reason: string
    candidates: Array<{
      kind: string
      confidence: string
      evidence: Array<{ file: string; line: number; excerpt: string }>
    }>
  }
}

function doctorData(result: RunResult): DoctorData {
  return (JSON.parse(result.stdout) as { data: DoctorData }).data
}

const PLAIN = {
  'package.json': '{"name":"plain","scripts":{"test":"node --test"}}\n',
  'README.md': '# Plain repository\n',
}

describe('doctor surfaces tracker candidates as information', () => {
  test('the JSON envelope carries data.tracker with evidence', () => {
    const dir = repo({
      ...PLAIN,
      '.github/ISSUE_TEMPLATE/bug.md': 'name: Bug report\n',
    })
    const result = runAnvil(['doctor', '--profile', dir, '--json'])
    assert.equal(result.code, 0, result.stdout + result.stderr)

    const data = doctorData(result)
    assert.equal(data.tracker.state, 'candidates')
    assert.equal(data.tracker.candidates[0]?.kind, 'github')
    assert.equal(data.tracker.candidates[0]?.confidence, 'detected')
    assert.ok(data.tracker.candidates[0]?.evidence.some((entry) => entry.file === '.github/ISSUE_TEMPLATE/bug.md'))
    assert.ok(data.tracker.candidates[0]?.evidence.every((entry) => entry.excerpt.length > 0))
  })

  test('the text output names the informational section and both candidates', () => {
    const dir = repo({
      ...PLAIN,
      '.github/ISSUE_TEMPLATE/bug.md': 'name: Bug report\n',
      'CONTRIBUTING.md': 'Track work in https://acme.atlassian.net/browse/PROJ-1\n',
    })
    const result = runAnvil(['doctor', '--profile', dir])
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /Ticket tracker \(informational\)/)
    assert.match(result.stdout, /unconfirmed/)
    assert.match(result.stdout, /github\s+detected/)
    assert.match(result.stdout, /jira\s+documented/)
  })

  test('an empty repository still reports na with a reason', () => {
    const dir = repo(PLAIN)
    const data = doctorData(runAnvil(['doctor', '--profile', dir, '--json']))
    assert.equal(data.tracker.state, 'na')
    assert.match(data.tracker.reason, /No local evidence/)
  })
})

describe('tracker detection never changes the readiness verdict', () => {
  // `.gitlab/issue_templates/` is invisible to the profile's walk, so the only difference
  // between these repositories is the tracker evidence doctor now prints.
  const baseline = repo({ ...PLAIN })
  const withTracker = repo({
    ...PLAIN,
    '.gitlab/issue_templates/bug.md': '## Summary\n\nDescribe the bug.\n',
  })

  test('the two repositories differ only in the tracker section', () => {
    const before = doctorData(runAnvil(['doctor', '--profile', baseline, '--json']))
    const after = doctorData(runAnvil(['doctor', '--profile', withTracker, '--json']))
    assert.equal(before.tracker.state, 'na')
    assert.equal(after.tracker.state, 'candidates')
    assert.deepEqual(after.findings, before.findings)
    assert.equal(after.score, before.score)
    assert.equal(after.grade, before.grade)
  })

  test('score, grade and every --fail-on threshold are identical', () => {
    for (const threshold of ['info', 'low', 'medium', 'high', 'blocker']) {
      const before = runAnvil(['doctor', '--profile', baseline, '--json', '--fail-on', threshold])
      const after = runAnvil(['doctor', '--profile', withTracker, '--json', '--fail-on', threshold])
      assert.equal(after.code, before.code, `exit code changed at --fail-on ${threshold}`)
      assert.equal(doctorData(after).score, doctorData(before).score)
      assert.equal(doctorData(after).grade, doctorData(before).grade)
    }
  })
})

describe('provider resolution does not read tracker detection', () => {
  test('GitLab and Jira evidence still resolves local, and config still wins', async () => {
    const dir = repo({
      ...PLAIN,
      '.gitlab/issue_templates/bug.md': '## Summary\n',
      'CONTRIBUTING.md': 'File a ticket at https://acme.atlassian.net/browse/PROJ-1\n',
      'README.md': 'Issues live at https://gitlab.com/acme/widgets/-/issues\n',
    })

    const detection = detectTrackerCandidates(dir, 'https://github.com/acme/widgets.git')
    assert.equal(detection.state, 'unconfirmed')
    assert.deepEqual(
      detection.candidates.map((candidate) => candidate.kind),
      ['gitlab', 'jira'],
    )

    let ghCalls = 0
    const gh = {
      run: async () => {
        ghCalls++
        return { stdout: '', stderr: '', exitCode: 1 }
      },
    }

    const fallback = await ticketProviderFor(dir, { ref: '7' }, { config: defaultConfig(), host: null, gh })
    assert.equal(fallback.id, 'local')
    assert.equal(fallback.source, 'default')

    const configured = await ticketProviderFor(
      dir,
      { ref: '7' },
      { config: { ...defaultConfig(), provider: { ...defaultConfig().provider, default: 'github' } }, host: null, gh },
    )
    assert.equal(configured.id, 'github')
    assert.equal(configured.source, 'config')
    assert.equal(ghCalls, 0, 'resolution made no transport call and did not consult the files')
  })
})
