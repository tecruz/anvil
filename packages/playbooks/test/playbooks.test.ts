import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp } from 'node:fs/promises'

import {
  buildPlan,
  loadBuiltins,
  loadPlaybooksFromDirectory,
  matchPlaybooks,
  parsePlaybook,
  parsePlaybookFiles,
  rankSuggestions,
  validatePlaybook,
  parseYamlSubset,
  type Plan,
  type Playbook,
  type Suggestion,
} from '@anvil/playbooks'
import { buildProfile, type ProjectProfile } from '@anvil/profile'
import { audit } from '@anvil/audit'

const here = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(here, '..', '..', '..')
const REGISTRY_DIR = join(REPO_ROOT, 'registry', 'playbooks')

const MINIMAL = `
id: toy
title: Toy
priority: 10
match:
  files: ['toy.toml']
`

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'anvil-pb-'))
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe('playbook validation', () => {
  test('accepts a minimal playbook', () => {
    const { playbook, issues } = validatePlaybook(parseYamlSubset(MINIMAL))
    assert.deepEqual(issues, [])
    assert.equal(playbook?.id, 'toy')
    assert.equal(playbook?.priority, 10)
  })

  test('rejects unknown keys rather than ignoring a typo', () => {
    // A typo in `riskGlobs` would silently stop covering a technology's dangerous
    // paths, with nothing reporting the loss.
    const { playbook, issues } = validatePlaybook(
      parseYamlSubset(`${MINIMAL}\nriskGlob: ['**/x']\n`),
    )
    assert.equal(playbook, null)
    assert.ok(issues.some((i) => i.path === 'riskGlob' && i.message === 'unknown key'))
  })

  test('rejects an unknown nested key with a dotted path', () => {
    const { issues } = validatePlaybook(parseYamlSubset(`${MINIMAL}\nverify:\n  buidl: ['x']\n`))
    assert.ok(issues.some((i) => i.path === 'verify.buidl'))
  })

  test('rejects a playbook that matches nothing', () => {
    const { issues } = validatePlaybook(parseYamlSubset('id: x\ntitle: X\nmatch:\n  files: []\n'))
    assert.ok(issues.some((i) => i.message.includes('must match something')))
  })

  test('rejects a missing id', () => {
    const { issues } = validatePlaybook(parseYamlSubset('title: X\nmatch:\n  files: [a]\n'))
    assert.ok(issues.some((i) => i.path === 'id'))
  })

  test('rejects a non-lowercase id', () => {
    const { issues } = validatePlaybook(parseYamlSubset('id: My Id\ntitle: X\nmatch:\n  files: [a]\n'))
    assert.ok(issues.some((i) => i.path === 'id' && i.message.includes('lowercase')))
  })

  test('requires url and why on resources', () => {
    const { issues } = validatePlaybook(
      parseYamlSubset(`${MINIMAL}\nofficial:\n  docs:\n    - label: x\n`),
    )
    assert.ok(issues.some((i) => i.path === 'official.docs[0].url'))
    assert.ok(issues.some((i) => i.path === 'official.docs[0].why'))
  })

  test('accepts a community entry without a url and derives one from the repo', () => {
    const { playbook } = validatePlaybook(
      parseYamlSubset(`${MINIMAL}\ncommunity:\n  - repo: 'acme/thing'\n    why: good\n`),
    )
    assert.equal(playbook?.community[0]?.url, 'https://github.com/acme/thing')
  })

  test('reports every issue at once', () => {
    const { issues } = validatePlaybook(parseYamlSubset('id: BAD\nnope: 1\nalsoNope: 2\n'))
    assert.ok(issues.length >= 3)
  })

  test('parsePlaybook throws an AnvilError naming the file', () => {
    assert.throws(
      () => parsePlaybook('id: BAD\ntitle: X\nmatch:\n  files: [a]\n', 'thing.yaml'),
      /thing\.yaml/,
    )
  })

  test('parsePlaybook reports an unparseable file rather than guessing', () => {
    assert.throws(() => parsePlaybook('id: x\n  bad indent here\n', 'thing.yaml'), /thing\.yaml/)
  })
})

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe('built-in registry', () => {
  const { playbooks, warnings } = loadBuiltins()

  test('loads without warnings', () => {
    assert.deepEqual(warnings, [])
    assert.ok(playbooks.length >= 3)
  })

  test('has the three seed playbooks', () => {
    const ids = playbooks.map((p) => p.id).sort()
    assert.deepEqual(ids, ['jvm', 'node', 'python'])
  })

  test('every playbook has at least one usable resource', () => {
    for (const p of playbooks) {
      const total =
        p.official.docs.length +
        p.official.skills.length +
        p.official.mcp.length +
        p.official.styleGuides.length +
        p.community.length
      assert.ok(total > 0, `${p.id} offers no resources at all`)
    }
  })

  test('every resource explains why it is worth reading', () => {
    for (const p of playbooks) {
      const all = [
        ...p.official.docs,
        ...p.official.skills,
        ...p.official.agents,
        ...p.official.mcp,
        ...p.official.styleGuides,
        ...p.official.migrationGuides,
        ...p.community,
      ]
      for (const r of all) {
        assert.ok(r.why.trim().length > 10, `${p.id}: ${r.label} has no meaningful "why"`)
      }
    }
  })

  test('every resource url is absolute https', () => {
    for (const p of playbooks) {
      const all = [
        ...p.official.docs,
        ...p.official.skills,
        ...p.official.agents,
        ...p.official.mcp,
        ...p.official.styleGuides,
        ...p.official.migrationGuides,
        ...p.community,
      ]
      for (const r of all) {
        assert.match(r.url, /^https:\/\//, `${p.id}: ${r.label} -> ${r.url}`)
      }
    }
  })

  test('every playbook declares verify commands', () => {
    for (const p of playbooks) {
      const total = Object.values(p.verify).reduce((n, v) => n + v.length, 0)
      assert.ok(total > 0, `${p.id} declares no verify commands`)
    }
  })
})

describe('generated file is in sync with the YAML sources', () => {
  // If someone edits a playbook and forgets `npm run gen:playbooks`, the change silently
  // does not exist. This is the guard.
  test('generated.ts matches registry/playbooks/*.yaml', async () => {
    const generated = await import('@anvil/playbooks/generated')
    const onDisk = new Map<string, string>()
    for (const file of readdirSync(REGISTRY_DIR).filter((f) => /\.ya?ml$/.test(f)).sort()) {
      onDisk.set(file, readFileSync(join(REGISTRY_DIR, file), 'utf8'))
    }
    assert.deepEqual(
      [...generated.generatedPlaybookFiles.entries()],
      [...onDisk.entries()],
      'generated playbooks are stale; run `npm run gen:playbooks`',
    )
  })
})

describe('user playbook directory', () => {
  test('merges over the built-ins by id', () => {
    const dir = tempDir()
    try {
      writeFileSync(
        join(dir, 'node.yaml'),
        'id: node\ntitle: Company node rules\npriority: 99\nmatch:\n  files: ["package.json"]\n',
      )
      const { playbooks } = loadPlaybooksFromDirectory(dir)
      const node = playbooks.find((p) => p.id === 'node')
      assert.equal(node?.title, 'Company node rules')
      assert.equal(playbooks.length, 3, 'overrides rather than appends')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('adds a new id without removing built-ins', () => {
    const dir = tempDir()
    try {
      writeFileSync(join(dir, 'acme.yaml'), 'id: acme\ntitle: Acme\nmatch:\n  files: ["acme.toml"]\n')
      const { playbooks } = loadPlaybooksFromDirectory(dir)
      assert.equal(playbooks.length, 4)
      assert.ok(playbooks.some((p) => p.id === 'acme'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a broken user playbook warns without taking down the built-ins', () => {
    const dir = tempDir()
    try {
      writeFileSync(join(dir, 'broken.yaml'), 'id: BROKEN\n')
      const { playbooks, warnings } = loadPlaybooksFromDirectory(dir)
      assert.equal(playbooks.length, 3, 'built-ins still load')
      assert.equal(warnings.length, 1)
      assert.match(warnings[0] ?? '', /broken\.yaml/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a missing directory warns rather than throwing', () => {
    const { playbooks, warnings } = loadPlaybooksFromDirectory(join(tempDir(), 'nope'))
    assert.equal(playbooks.length, 3)
    assert.ok(warnings.some((w) => w.includes('not found')))
  })

  test('an empty directory warns', () => {
    const { warnings } = loadPlaybooksFromDirectory(tempDir())
    assert.ok(warnings.some((w) => w.includes('no .yaml playbooks')))
  })
})

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function profileFor(fixture: string): ProjectProfile {
  return buildProfile(join(REPO_ROOT, 'fixtures', fixture), {
    root: join(REPO_ROOT, 'fixtures', fixture),
    host: null,
    remote: null,
    defaultBranch: null,
  }).profile
}

describe('matching', () => {
  const { playbooks } = loadBuiltins()

  test('a Node repo matches the node playbook with file and dep evidence', () => {
    const matches = matchPlaybooks(profileFor('node-npm'), playbooks)
    const node = matches.find((m) => m.playbook.id === 'node')
    assert.ok(node, 'expected the node playbook to match')
    const kinds = new Set(node.reasons.map((r) => r.kind))
    assert.ok(kinds.has('file'))
    assert.ok(kinds.has('dep'))
  })

  test('a Python repo does not match the node playbook', () => {
    const matches = matchPlaybooks(profileFor('python-django'), playbooks)
    assert.equal(matches.find((m) => m.playbook.id === 'node'), undefined)
    assert.ok(matches.find((m) => m.playbook.id === 'python'))
  })

  test('a Gradle repo matches jvm', () => {
    const matches = matchPlaybooks(profileFor('jvm-gradle'), playbooks)
    assert.ok(matches.find((m) => m.playbook.id === 'jvm'))
  })

  test('higher priority sorts first when several match', () => {
    const generic = parsePlaybook(
      'id: generic\ntitle: G\npriority: 1\nmatch:\n  files: ["package.json"]\n',
      'g.yaml',
    )
    const specific = parsePlaybook(
      'id: specific\ntitle: S\npriority: 99\nmatch:\n  files: ["package.json"]\n',
      's.yaml',
    )
    const matches = matchPlaybooks(profileFor('node-npm'), [generic, specific])
    assert.equal(matches[0]?.playbook.id, 'specific')
  })

  test('an unmatched repo yields no playbooks, not a guess', () => {
    const matches = matchPlaybooks(profileFor('cold-empty'), playbooks)
    assert.equal(matches.length, 0)
  })

  test('a dep wildcard matches a language the detectors infer from extensions', () => {
    // Playbook authors write `deps: [kotlin]`; `kotlin` is a *language* here, not a
    // stack. Matching languages as well as stacks is what makes that mean anything.
    const pb = parsePlaybook('id: p\ntitle: P\nmatch:\n  deps: ["kot*"]\n', 'p.yaml')
    const matches = matchPlaybooks(profileFor('jvm-gradle'), [pb])
    assert.equal(matches.length, 1)
    assert.equal(matches[0]?.reasons[0]?.kind, 'lang')
    assert.equal(matches[0]?.reasons[0]?.matched, 'kotlin')
  })

  test('a language-only match scores lower than a declared stack', () => {
    const byStack = parsePlaybook('id: s\ntitle: S\npriority: 50\nmatch:\n  deps: ["gradle"]\n', 's.yaml')
    const byLang = parsePlaybook('id: l\ntitle: L\npriority: 50\nmatch:\n  deps: ["kot*"]\n', 'l.yaml')
    const matches = matchPlaybooks(profileFor('jvm-gradle'), [byLang, byStack])
    assert.equal(matches[0]?.playbook.id, 's')
  })
})

// ---------------------------------------------------------------------------
// Plan and ranking
// ---------------------------------------------------------------------------

function planFor(fixture: string): Plan {
  const profile = profileFor(fixture)
  const { playbooks, warnings } = loadBuiltins()
  return buildPlan(audit(profile), profile, matchPlaybooks(profile, playbooks), warnings)
}

describe('plan', () => {
  const plan = planFor('python-django')

  test('reports the readiness score and grade through', () => {
    assert.ok(plan.score >= 0 && plan.score <= 100)
    assert.ok(['A', 'B', 'C', 'D', 'F'].includes(plan.grade))
  })

  test('derives suggestions from failing findings that carry a fix', () => {
    assert.ok(plan.counts.derived > 0)
    const derived = plan.suggestions.filter((s) => s.tier === 'derived')
    assert.ok(derived.every((s) => s.rule !== undefined))
  })

  test('ranks derived before official before community', () => {
    const order = plan.suggestions.map((s) => s.tier)
    const firstOfficial = order.indexOf('official')
    const lastDerived = order.lastIndexOf('derived')
    const firstCommunity = order.indexOf('community')
    const lastOfficial = order.lastIndexOf('official')
    if (firstOfficial !== -1) assert.ok(lastDerived < firstOfficial)
    if (firstCommunity !== -1) assert.ok(lastOfficial < firstCommunity)
  })

  test('counts match the suggestion list', () => {
    assert.equal(plan.counts.derived, plan.suggestions.filter((s) => s.tier === 'derived').length)
    assert.equal(plan.counts.official, plan.suggestions.filter((s) => s.tier === 'official').length)
    assert.equal(plan.counts.community, plan.suggestions.filter((s) => s.tier === 'community').length)
  })

  test('every suggestion has an id, tier and confidence in range', () => {
    for (const s of plan.suggestions) {
      assert.ok(s.id.length > 0)
      assert.ok(['derived', 'official', 'community'].includes(s.tier))
      assert.ok(s.confidence >= 0 && s.confidence <= 1, `${s.id} confidence ${s.confidence}`)
    }
  })

  test('suggestion ids are unique', () => {
    const ids = plan.suggestions.map((s) => s.id)
    assert.equal(new Set(ids).size, ids.length)
  })

  test('playbook-sourced guidance links back to the playbook that supplied it', () => {
    // A `fix:` suggestion comes from a rule, so it has no playbook. Everything a
    // playbook contributes must say which playbook, or its provenance is lost.
    for (const s of plan.suggestions.filter((x) => !x.id.startsWith('fix:'))) {
      assert.ok(s.playbook !== undefined, `${s.id} has no playbook attribution`)
    }
  })

  test('a repo with no matched playbook still gets derived suggestions', () => {
    const cold = planFor('cold-empty')
    assert.equal(cold.playbooks.length, 0)
    assert.ok(cold.counts.derived > 0, 'derived fixes do not need external guidance')
    assert.equal(cold.counts.official, 0)
  })

  test('rankSuggestions is stable for equal inputs', () => {
    const a: Suggestion = { id: 'a', tier: 'derived', title: 'a', detail: '', evidence: [], confidence: 0.5 }
    const b: Suggestion = { id: 'b', tier: 'derived', title: 'b', detail: '', evidence: [], confidence: 0.5 }
    assert.deepEqual(
      rankSuggestions([b, a]).map((s) => s.id),
      rankSuggestions([a, b]).map((s) => s.id),
    )
  })

  test('blocker findings outrank a lower-severity fix within a tier', () => {
    const sorted = rankSuggestions([
      { id: 'low', tier: 'derived', title: '', detail: '', evidence: [], confidence: 0.9, severity: 'low' },
      { id: 'blocker', tier: 'derived', title: '', detail: '', evidence: [], confidence: 0.1, severity: 'blocker' },
    ])
    assert.equal(sorted[0]?.id, 'blocker')
  })
})

describe('parsePlaybookFiles', () => {
  test('sorts deterministically and collects failures as warnings', () => {
    const files = new Map([
      ['b.yaml', 'id: b\ntitle: B\nmatch:\n  files: [b]\n'],
      ['a.yaml', 'id: a\ntitle: A\nmatch:\n  files: [a]\n'],
      ['z.yaml', 'not a playbook\n'],
    ])
    const { playbooks, warnings } = parsePlaybookFiles(files)
    assert.deepEqual(playbooks.map((p) => p.id), ['a', 'b'])
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /z\.yaml/)
  })
})

void mkdtemp
