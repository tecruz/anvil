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
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
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

  test('a symlinked document is reported as not read', (t) => {
    const outside = temp('anvil-trackers-outside-')
    writeFileSync(join(outside, 'secret.md'), 'nothing here\n', 'utf8')
    const dir = repo({ 'package.json': '{"name":"safe"}\n' })
    if (!tryLink(join(outside, 'secret.md'), join(dir, 'CONTRIBUTING.md'), 'file')) {
      t.skip('file symlinks are unavailable here')
      return
    }
    const detection = detectTrackerCandidates(dir, null)
    assert.equal(detection.state, 'na')
    assert.match(detection.reason, /partial: not read .*CONTRIBUTING\.md/)
  })

  test('a hard-linked document is not read, because it may name a file outside the tree', (t) => {
    const outside = temp('anvil-trackers-outside-')
    writeFileSync(join(outside, 'secret.md'), 'https://github.com/evil/evil/issues\n', 'utf8')
    const dir = repo({ 'package.json': '{"name":"safe"}\n' })
    try {
      linkSync(join(outside, 'secret.md'), join(dir, 'README.md'))
    } catch {
      t.skip('hard links are unavailable here')
      return
    }
    const detection = detectTrackerCandidates(dir, null)
    assert.equal(detection.state, 'na')
    assert.match(detection.reason, /not read .*README\.md/)
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

describe('review regressions', () => {
  test('a credential in a documented link or template is never quoted', () => {
    const dir = repo({
      'CONTRIBUTING.md': 'File bugs at https://alice:SECRET@acme.atlassian.net/browse/PROJ-1\n',
      '.github/ISSUE_TEMPLATE/config.yml': 'contact_links:\n  - url: https://bob:TOKEN@linear.app/acme/team\n',
    })
    const text = JSON.stringify(detectTrackerCandidates(dir, null))
    assert.doesNotMatch(text, /SECRET|TOKEN|alice|bob/)
    assert.match(text, /\*\*\*@acme\.atlassian\.net/)
  })

  test('a template config that routes issues elsewhere is unconfirmed, not GitHub', () => {
    const dir = repo({
      '.github/ISSUE_TEMPLATE/config.yml': [
        'blank_issues_enabled: false',
        'contact_links:',
        '  - name: Report a bug',
        '    url: https://linear.app/acme/team/ENG',
      ].join('\n'),
    })
    const detection = detectTrackerCandidates(dir, GITHUB_REMOTE)
    assert.equal(detection.state, 'unconfirmed')
    assert.deepEqual(kinds(detection), ['github', 'linear'])
    assert.equal(detection.candidates[1]?.confidence, 'documented')
  })

  test('a bare product name is a labelled mention, and a Confluence link is not Jira', () => {
    const mention = detectTrackerCandidates(repo({ 'README.md': 'We do not use Jira.\n' }), null)
    assert.deepEqual(kinds(mention), ['jira'])
    assert.equal(mention.candidates[0]?.confidence, 'inferred')
    assert.match(mention.candidates[0]?.evidence[0]?.excerpt ?? '', /a mention, not proof of use/)
    const wiki = detectTrackerCandidates(
      repo({ 'README.md': 'See https://acme.atlassian.net/wiki/spaces/ENG\n' }),
      null,
    )
    assert.equal(wiki.state, 'na')
  })

  test('the template bound is applied after sorting, and a partial scan says so', () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < TRACKER_LIMITS.maxTemplateFiles + 5; i++) {
      files[`.github/ISSUE_TEMPLATE/t${String(i).padStart(2, '0')}.md`] = 'name: T\n'
    }
    // Only in a file past the bound in sorted order: never read, whatever readdir returns.
    files['.github/ISSUE_TEMPLATE/zz-last.md'] = 'Tracked as PROJ-9\n'
    const detection = detectTrackerCandidates(repo(files), null)
    assert.deepEqual(kinds(detection), ['github'])
    assert.match(detection.reason, new RegExp(`only the first ${String(TRACKER_LIMITS.maxTemplateFiles)} files`))
  })

  test('a documented candidate keeps the citation that made it documented', () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < TRACKER_LIMITS.maxEvidencePerCandidate + 2; i++) {
      files[`.github/ISSUE_TEMPLATE/a${String(i)}.md`] = `Seen as KEY-${String(i + 1)}\n`
    }
    files['SECURITY.md'] = 'Report at https://acme.atlassian.net/browse/SEC\n'
    const detection = detectTrackerCandidates(repo(files), null)
    const jira = detection.candidates.find((candidate) => candidate.kind === 'jira')
    assert.equal(jira?.confidence, 'documented')
    assert.ok(jira?.evidence.some((entry) => entry.file === 'SECURITY.md'))
    assert.ok((jira?.evidence.length ?? 0) <= TRACKER_LIMITS.maxEvidencePerCandidate)
  })

  test("an issues link on the remote's own Enterprise host is GitHub evidence", () => {
    const dir = repo({ 'CONTRIBUTING.md': 'Issues: https://github.acme.com/acme/widgets/issues\n' })
    const detection = detectTrackerCandidates(dir, 'git@github.acme.com:acme/widgets.git')
    assert.deepEqual(kinds(detection), ['github'])
    assert.equal(detection.candidates[0]?.confidence, 'documented')
    // A host that is not this repository's remote is not trusted the same way.
    assert.equal(detectTrackerCandidates(dir, null).state, 'na')
  })

  test('github in a remote path or userinfo is not a GitHub host', () => {
    const files = { '.gitlab/issue_templates/bug.md': 'Bug\n', '.github/ISSUE_TEMPLATE/bug.md': 'Bug\n' }
    for (const remote of [
      'https://git.example.com/mirror/github.com/x.git',
      'https://github.x:pw@git.example.com/a/b.git',
    ]) {
      const github = detectTrackerCandidates(repo(files), remote).candidates.find((c) => c.kind === 'github')
      assert.ok(!(github?.evidence ?? []).some((entry) => entry.file === '.git/config'), remote)
    }
  })

  test('the remote citation stays inside the excerpt bound', () => {
    const remote = `https://github.com/acme/${'w'.repeat(400)}.git`
    const dir = repo({ '.github/ISSUE_TEMPLATE/bug.md': 'Bug\n' })
    const github = detectTrackerCandidates(dir, remote).candidates[0]
    for (const entry of github?.evidence ?? []) {
      assert.ok(entry.excerpt.length <= TRACKER_LIMITS.maxExcerptChars, entry.excerpt)
    }
  })

  test('scheme-relative and @-containing credentials are redacted in full', () => {
    const dir = repo({
      'CONTRIBUTING.md': [
        'See //alice:SECRET@acme.atlassian.net/browse/PROJ-1',
        'Or https://alice:p@SECRET2@acme.atlassian.net/browse/PROJ-2',
      ].join('\n'),
    })
    assert.doesNotMatch(JSON.stringify(detectTrackerCandidates(dir, null)), /SECRET|alice/)
  })

  test('a Jira-looking path in prose is not a documented tracker URL', () => {
    const detection = detectTrackerCandidates(repo({ 'README.md': 'Code lives in src/jira/software today.\n' }), null)
    const jira = detection.candidates.find((candidate) => candidate.kind === 'jira')
    assert.notEqual(jira?.confidence, 'documented')
  })

  test('an unreadable template directory makes the scan partial, not silent', (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      t.skip('POSIX permissions are not enforced here')
      return
    }
    const dir = repo({ '.github/ISSUE_TEMPLATE/bug.md': 'Bug\n', 'README.md': 'nothing\n' })
    const github = join(dir, '.github')
    chmodSync(github, 0o000)
    try {
      const detection = detectTrackerCandidates(dir, null)
      assert.match(detection.reason, /partial: not read .*\.github/)
    } finally {
      chmodSync(github, 0o755)
    }
  })

  test('a stronger citation replaces a weaker one when a file has used its allowance', () => {
    const lines = ['KEY-1', 'KEY-2', 'KEY-3', 'KEY-4', 'Tracker: https://acme.atlassian.net/browse/KEY']
    const detection = detectTrackerCandidates(repo({ 'CONTRIBUTING.md': `${lines.join('\n')}\n` }), null)
    const jira = detection.candidates.find((candidate) => candidate.kind === 'jira')
    assert.equal(jira?.confidence, 'documented')
    assert.ok(jira?.evidence.some((entry) => /atlassian\.net\/browse/.test(entry.excerpt)))
    assert.ok((jira?.evidence.length ?? 0) <= TRACKER_LIMITS.maxEvidencePerFile)
  })

  test('advice never suggests confirming a provider anvil does not have', () => {
    const jira = detectTrackerCandidates(repo({ 'README.md': 'https://acme.atlassian.net/browse/X\n' }), null)
    assert.match(jira.reason, /no jira provider/)
    assert.doesNotMatch(jira.reason, /provider\.default: "jira"/)
    const github = detectTrackerCandidates(repo({ 'README.md': 'https://github.com/a/b/issues\n' }), null)
    assert.match(github.reason, /provider\.default: "github"/)
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

  test('no write, network or process call happens during detection', () => {
    // Spy on the CommonJS builtins and push the spies into the ESM bindings, so any module
    // the detector reaches -- not just trackers.ts -- is covered for the whole call.
    const require = createRequire(import.meta.url)
    const targets: Array<[Record<string, unknown>, string, string[]]> = [
      [
        require('node:fs'),
        'fs',
        [
          'writeFileSync',
          'appendFileSync',
          'mkdirSync',
          'mkdtempSync',
          'renameSync',
          'rmSync',
          'rmdirSync',
          'unlinkSync',
          'copyFileSync',
          'cpSync',
          'symlinkSync',
          'linkSync',
          'writeSync',
          'truncateSync',
          'ftruncateSync',
          'utimesSync',
          'chmodSync',
          'chownSync',
          'createWriteStream',
          'writeFile',
          'appendFile',
          'mkdir',
          'rm',
          'unlink',
          'rename',
          'open',
          'write',
        ],
      ],
      [
        require('node:fs').promises,
        'fs.promises',
        [
          'writeFile',
          'appendFile',
          'mkdir',
          'rm',
          'unlink',
          'rename',
          'open',
          'copyFile',
          'cp',
          'symlink',
          'link',
          'truncate',
        ],
      ],
      [
        require('node:child_process'),
        'child_process',
        ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'],
      ],
      [require('node:net'), 'net', ['connect', 'createConnection']],
      [require('node:tls'), 'tls', ['connect']],
      [require('node:http'), 'http', ['request', 'get']],
      [require('node:https'), 'https', ['request', 'get']],
      [require('node:http2'), 'http2', ['connect']],
      [require('node:dns'), 'dns', ['lookup', 'resolve']],
    ]
    const dir = repo({
      '.github/ISSUE_TEMPLATE/bug.md': 'name: Bug\n',
      'CONTRIBUTING.md': 'https://acme.atlassian.net/browse/PROJ-1 and https://github.com/acme/widgets/issues\n',
    })
    const calls: string[] = []
    const restore: Array<() => void> = []
    // openSync is only a write when its flags ask for one; reads go through it too.
    const fsModule = require('node:fs') as Record<string, unknown>
    const openSync = fsModule.openSync as (path: unknown, flags?: unknown, mode?: unknown) => number
    fsModule.openSync = (path: unknown, flags?: unknown, mode?: unknown) => {
      if (flags !== undefined && flags !== 'r' && flags !== 0) {
        calls.push('fs.openSync(write)')
        throw new Error('write forbidden during detection')
      }
      return openSync(path, flags, mode)
    }
    restore.push(() => {
      fsModule.openSync = openSync
    })
    for (const [mod, name, fns] of targets) {
      for (const fn of fns) {
        const original = mod[fn]
        if (typeof original !== 'function') continue
        // Record and refuse: the real call never runs, so a regression cannot have a side
        // effect before the assertion reports it.
        mod[fn] = () => {
          calls.push(`${name}.${fn}`)
          throw new Error(`${name}.${fn} forbidden during detection`)
        }
        restore.push(() => {
          mod[fn] = original
        })
      }
    }
    syncBuiltinESMExports()
    try {
      detectTrackerCandidates(dir, GITHUB_REMOTE)
    } finally {
      for (const undo of restore) undo()
      syncBuiltinESMExports()
    }
    assert.deepEqual(calls, [])
  })

  test('provider resolution and the ticket commands never import the detector', () => {
    const root = join(import.meta.dirname, '..', '..', '..')
    const sources = [
      ...readdirSync(join(root, 'packages', 'providers', 'src')).map((f) =>
        join(root, 'packages', 'providers', 'src', f),
      ),
      join(root, 'packages', 'cli', 'src', 'tickets.ts'),
      join(root, 'packages', 'cli', 'src', 'commands', 'work.ts'),
      join(root, 'packages', 'cli', 'src', 'commands', 'crew.ts'),
      join(root, 'packages', 'cli', 'src', 'commands', 'ship.ts'),
      join(root, 'packages', 'worktrees', 'src', 'ship.ts'),
    ].filter((path) => path.endsWith('.ts'))
    assert.ok(sources.length > 3)
    for (const path of sources) {
      assert.doesNotMatch(readFileSync(path, 'utf8'), /detectTrackerCandidates|trackers\.ts/, path)
    }
  })

  test('the module imports no network or process-launching builtin', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'trackers.ts'), 'utf8')
    assert.doesNotMatch(source, /node:(?:child_process|http|https|net|dns|tls)/)
  })
})
