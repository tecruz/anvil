/**
 * Tracker-candidate detection.
 *
 * The tests are about the shape of the claim, not a happy path: each evidence source, the
 * `na` answer, the ambiguity answer, the guess label, the bounds and the symlink refusal.
 * The detector is offline by construction; the last group proves it does not write and does
 * not reach the network.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { detectTrackerCandidates, TRACKER_LIMITS } from '@anvil/profile'

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
  const dir = temp('anvil-trackers-')
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, ...rel.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return dir
}

const GITHUB_REMOTE = 'https://github.com/acme/widgets.git'

function kinds(detection: ReturnType<typeof detectTrackerCandidates>): string[] {
  return detection.candidates.map((candidate) => candidate.kind)
}

function evidenceFiles(detection: ReturnType<typeof detectTrackerCandidates>): string[] {
  return detection.candidates.flatMap((candidate) => candidate.evidence.map((entry) => entry.file))
}

function snapshot(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      const path = join(dir, entry.name)
      const stat = lstatSync(path)
      if (entry.isDirectory()) {
        out.push(`dir ${childRel} ${stat.mtimeMs}`)
        walk(path, childRel)
      } else {
        const digest = createHash('sha256').update(readFileSync(path)).digest('hex')
        out.push(`file ${childRel} ${stat.size} ${stat.mtimeMs} ${digest}`)
      }
    }
  }
  walk(root, '')
  return out
}

describe('each evidence source produces a candidate', () => {
  test('a GitHub issue template is detected, and the matching remote is cited', () => {
    const dir = repo({
      '.git/config': [
        '[core]',
        '\trepositoryformatversion = 0',
        '[remote "origin"]',
        `\turl = ${GITHUB_REMOTE}`,
        '\tfetch = +refs/heads/*:refs/remotes/origin/*',
      ].join('\n'),
      '.github/ISSUE_TEMPLATE/bug.md': '---\nname: Bug report\nabout: Something is broken\n---\n',
    })

    const detection = detectTrackerCandidates(dir, GITHUB_REMOTE)
    assert.equal(detection.state, 'candidates')
    assert.deepEqual(kinds(detection), ['github'])
    const github = detection.candidates[0]
    assert.equal(github?.confidence, 'detected')
    assert.ok(github?.evidence.some((entry) => entry.file === '.github/ISSUE_TEMPLATE/bug.md'))
    const remote = github?.evidence.find((entry) => entry.file === '.git/config')
    assert.ok(remote !== undefined, 'the remote is cited as corroboration')
    assert.ok(remote.line > 0, 'the remote citation points at the URL line')
    assert.match(remote.excerpt, /github\.com\/acme\/widgets/)
  })

  test('a remote credential is never quoted in evidence', () => {
    const secretRemote = 'https://octocat:ghp_SECRET123@github.com/acme/widgets.git'
    const template = { '.github/ISSUE_TEMPLATE/bug.md': '---\nname: Bug\n---\n' }
    const withConfig = repo({ ...template, '.git/config': `[remote "origin"]\n\turl = ${secretRemote}\n` })
    const withoutConfig = repo(template)
    for (const dir of [withConfig, withoutConfig]) {
      const detection = detectTrackerCandidates(dir, secretRemote)
      const text = JSON.stringify(detection)
      assert.doesNotMatch(text, /SECRET123|octocat/)
      assert.match(text, /github\.com\/acme\/widgets/)
    }
  })

  test('a GitLab issue template is detected', () => {
    const dir = repo({
      '.gitlab/issue_templates/bug.md': '## Summary\n\nWhat happened?\n',
    })
    const detection = detectTrackerCandidates(dir, null)
    assert.equal(detection.state, 'candidates')
    assert.deepEqual(kinds(detection), ['gitlab'])
    assert.equal(detection.candidates[0]?.confidence, 'detected')
    assert.ok(evidenceFiles(detection).includes('.gitlab/issue_templates/bug.md'))
  })

  const docs: ReadonlyArray<{ name: string; file: string; body: string; kind: string }> = [
    {
      name: 'a README linking to GitHub issues',
      file: 'README.md',
      body: 'Bugs go to https://github.com/acme/widgets/issues please.\n',
      kind: 'github',
    },
    {
      name: 'a CONTRIBUTING linking to GitLab issues',
      file: 'CONTRIBUTING.md',
      body: 'Open an issue at https://gitlab.com/acme/widgets/-/issues.\n',
      kind: 'gitlab',
    },
    {
      name: 'a SECURITY naming Jira',
      file: 'SECURITY.md',
      body: 'Report security issues in Jira: https://acme.atlassian.net/browse/SEC-1\n',
      kind: 'jira',
    },
    {
      name: 'a README naming Linear',
      file: 'README.md',
      body: 'Our issue tracker lives at https://linear.app/acme/team/ENG.\n',
      kind: 'linear',
    },
  ]

  for (const source of docs) {
    test(`${source.name} is documented`, () => {
      const detection = detectTrackerCandidates(repo({ [source.file]: source.body }), null)
      assert.equal(detection.state, 'candidates')
      assert.deepEqual(kinds(detection), [source.kind])
      assert.equal(detection.candidates[0]?.confidence, 'documented')
      const evidence = detection.candidates[0]?.evidence[0]
      assert.equal(evidence?.file, source.file)
      assert.equal(evidence?.line, 1)
    })
  }
})

describe('ambiguity is reported, not resolved', () => {
  test('a GitHub template plus a Jira document is unconfirmed, and both are listed', () => {
    const dir = repo({
      '.github/ISSUE_TEMPLATE/bug.md': 'name: Bug\n',
      'CONTRIBUTING.md': 'File a ticket at https://acme.atlassian.net/browse/PROJ-1 before sending a PR.\n',
    })
    const detection = detectTrackerCandidates(dir, GITHUB_REMOTE)

    assert.equal(detection.state, 'unconfirmed')
    assert.deepEqual(kinds(detection), ['github', 'jira'])
    assert.match(detection.reason, /No winner is chosen/)
    assert.ok(detection.candidates.every((candidate) => candidate.evidence.length > 0))
    // Deterministic order is stable across runs, and is not a ranking by confidence.
    assert.deepEqual(kinds(detectTrackerCandidates(dir, GITHUB_REMOTE)), ['github', 'jira'])
  })

  test('a bare GitHub remote is na, not a GitHub Issues candidate', () => {
    const dir = repo({
      '.git/config': '[remote "origin"]\n\turl = https://github.com/acme/widgets.git\n',
    })
    const detection = detectTrackerCandidates(dir, GITHUB_REMOTE)

    assert.equal(detection.state, 'na')
    assert.deepEqual(detection.candidates, [])
    assert.match(detection.reason, /github remote is a code host/)
  })

  test('no evidence at all is na with a reason', () => {
    const detection = detectTrackerCandidates(repo({ 'package.json': '{"name":"plain"}\n' }), null)
    assert.equal(detection.state, 'na')
    assert.deepEqual(detection.candidates, [])
    assert.match(detection.reason, /No local evidence of a ticket tracker/)
  })
})

describe('issue-key conventions are a labelled guess', () => {
  test('PROJ-123 produces a jira candidate at inferred confidence', () => {
    const detection = detectTrackerCandidates(
      repo({ 'README.md': 'Reference the work as PROJ-123 in your pull request.\n' }),
      null,
    )

    assert.equal(detection.state, 'candidates')
    assert.deepEqual(kinds(detection), ['jira'])
    const jira = detection.candidates[0]
    assert.equal(jira?.confidence, 'inferred')
    assert.match(detection.reason, /guess/i)
    assert.match(jira?.evidence[0]?.excerpt ?? '', /guess/i)
  })

  test('ordinary standards such as UTF-8 and RFC-2119 are not issue keys', () => {
    const detection = detectTrackerCandidates(
      repo({ 'README.md': 'Files are UTF-8 and the prose follows RFC-2119 and SHA-256.\n' }),
      null,
    )
    assert.equal(detection.state, 'na')
    assert.deepEqual(detection.candidates, [])
  })
})

describe('the detector is bounded', () => {
  test('at most the configured number of template citations is emitted', () => {
    const files: Record<string, string> = {}
    for (let index = 0; index < 30; index++) {
      files[`.github/ISSUE_TEMPLATE/template-${String(index).padStart(2, '0')}.md`] = `name: Template ${index}\n`
    }
    const detection = detectTrackerCandidates(repo(files), null)
    const github = detection.candidates.find((candidate) => candidate.kind === 'github')
    assert.equal(github?.evidence.length, TRACKER_LIMITS.maxEvidencePerCandidate)
  })

  test('a template larger than the per-file bound is skipped, not truncated into evidence', () => {
    const dir = repo({
      '.github/ISSUE_TEMPLATE/aaa-huge.md': 'x'.repeat(TRACKER_LIMITS.maxFileBytes + 1),
      '.github/ISSUE_TEMPLATE/zzz-small.md': 'name: Small\n',
    })
    const detection = detectTrackerCandidates(dir, null)
    assert.ok(evidenceFiles(detection).includes('.github/ISSUE_TEMPLATE/zzz-small.md'))
    assert.ok(!evidenceFiles(detection).includes('.github/ISSUE_TEMPLATE/aaa-huge.md'))
  })

  test('an excerpt stays inside the character bound', () => {
    const long = `See https://github.com/acme/widgets/issues ${'a'.repeat(500)}`
    const detection = detectTrackerCandidates(repo({ 'README.md': long }), null)
    for (const entry of detection.candidates.flatMap((candidate) => candidate.evidence)) {
      assert.ok(entry.excerpt.length <= TRACKER_LIMITS.maxExcerptChars, `excerpt was ${entry.excerpt.length}`)
    }
  })
})

describe('symlinks cannot escape the repository', () => {
  function tryLink(target: string, path: string, kind: 'file' | 'dir'): boolean {
    try {
      symlinkSync(target, path, process.platform === 'win32' && kind === 'dir' ? 'junction' : kind)
      return true
    } catch {
      return false
    }
  }

  test('a symlinked document is not read', (t) => {
    const outside = temp('anvil-trackers-outside-')
    writeFileSync(join(outside, 'secret.md'), 'https://github.com/evil/evil/issues\n', 'utf8')
    const dir = repo({ 'package.json': '{"name":"safe"}\n' })
    if (!tryLink(join(outside, 'secret.md'), join(dir, 'README.md'), 'file')) {
      t.skip('file symlinks are unavailable here')
      return
    }

    const detection = detectTrackerCandidates(dir, null)
    assert.equal(detection.state, 'na')
    assert.deepEqual(detection.candidates, [])
  })

  test('a symlinked template directory is refused', (t) => {
    const outside = temp('anvil-trackers-outside-')
    mkdirSync(join(outside, 'templates'), { recursive: true })
    writeFileSync(join(outside, 'templates', 'bug.md'), 'name: Bug\n', 'utf8')
    const dir = repo({ 'package.json': '{"name":"safe"}\n' })
    mkdirSync(join(dir, '.github'), { recursive: true })
    if (!tryLink(join(outside, 'templates'), join(dir, '.github', 'ISSUE_TEMPLATE'), 'dir')) {
      t.skip('directory symlinks are unavailable here')
      return
    }

    const detection = detectTrackerCandidates(dir, null)
    assert.equal(detection.state, 'na')
    assert.deepEqual(detection.candidates, [])
  })

  test('a symlinked template file is ignored by the walk', (t) => {
    const outside = temp('anvil-trackers-outside-')
    writeFileSync(join(outside, 'secret.md'), 'name: Bug\n', 'utf8')
    const dir = repo({ '.github/ISSUE_TEMPLATE/real.md': 'name: Real\n' })
    if (!tryLink(join(outside, 'secret.md'), join(dir, '.github', 'ISSUE_TEMPLATE', 'link.md'), 'file')) {
      t.skip('file symlinks are unavailable here')
      return
    }

    const detection = detectTrackerCandidates(dir, null)
    assert.ok(evidenceFiles(detection).includes('.github/ISSUE_TEMPLATE/real.md'))
    assert.ok(!evidenceFiles(detection).includes('.github/ISSUE_TEMPLATE/link.md'))
  })
})

describe('detection is read-only and offline', () => {
  test('it writes no file and changes no mtime', () => {
    const dir = repo({
      '.github/ISSUE_TEMPLATE/bug.md': 'name: Bug\n',
      'CONTRIBUTING.md': 'Ask in https://acme.atlassian.net/browse/PROJ-1 or see PROJ-123.\n',
      'package.json': '{"name":"untouched"}\n',
    })
    const before = snapshot(dir)
    detectTrackerCandidates(dir, GITHUB_REMOTE)
    assert.deepEqual(snapshot(dir), before)
  })

  test('it makes no network call', async () => {
    const dir = repo({ 'README.md': 'https://github.com/acme/widgets/issues\n' })
    const original = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      throw new Error('network forbidden')
    }) as typeof fetch
    try {
      const detection = detectTrackerCandidates(dir, GITHUB_REMOTE)
      assert.equal(detection.state, 'candidates')
    } finally {
      globalThis.fetch = original
    }
    assert.equal(calls, 0)
  })

  test('the module imports no network or process-launching builtin', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'trackers.ts'), 'utf8')
    assert.doesNotMatch(source, /node:(?:child_process|http|https|net|dns|tls)/)
  })
})
