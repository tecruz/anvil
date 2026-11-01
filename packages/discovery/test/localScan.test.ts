/**
 * The local scan.
 *
 * Two of these tests exist because they pin defects that were found by running the thing
 * against a real machine rather than by reading it, and both were silent: the command
 * reported a plausible number of found skills and no error anywhere.
 *
 *   - A plain multi-line YAML scalar truncated at the first line. These files are written
 *     that way constantly, and the technology name is usually on line two, so the symptom
 *     was "found 13 of 18 Android skills" with nothing to look at.
 *   - A skill installed under two tool directories was reported twice, because the dedupe
 *     key was the install path. The same skill in `~/.agents/skills` and `~/.claude/skills`
 *     is one skill.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { discoverLocal, scanLocalSkills, skillMatchesSeeds, skillSearchRoots } from '@anvil/discovery'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'anvil-scan-'))
}

function skill(root: string, dir: string, body: string): string {
  const skillDir = join(root, dir)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), body, 'utf8')
  return skillDir
}

const FLAT_SCALAR = `---
name: adaptive
description: Instructions to make or update an app's UI so that it adapts to different
  Android devices including phones, tablets, foldables, laptops, desktop, TV, Auto
  and XR.
---
`

const FOLDED_SCALAR = `---
name: navigation
description: >-
  Learn how to install and migrate to Jetpack Navigation 3, which replaces
  Navigation 2 with a Scenes API.
---
`

const SEQUENTIAL_KEYWORDS = `---
name: engage
description: Helps developers resolve Play Engage SDK implementation issues.
license: Complete terms in LICENSE.txt
metadata:
  author: Google LLC
  last-updated: '2026-05-15'
keywords:
- android
- engage sdk
---
`

const NO_FRONTMATTER = `# Just a document

Prose about Android that is not frontmatter at all.
`

describe('scanLocalSkills', () => {
  test('finds a skill and reads its name and description', () => {
    const h = home()
    try {
      const root = join(h, '.agents', 'skills')
      skill(root, 'navigation-3', FOLDED_SCALAR)
      const found = scanLocalSkills({ env: { ANVIL_CONFIG_HOME: h } as NodeJS.ProcessEnv })
      assert.equal(found.length, 1)
      assert.equal(found[0]?.name, 'navigation')
      assert.match(found[0]?.description ?? '', /Navigation 3/)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('a multi-line plain scalar keeps every line', () => {
    // The defect this pins: reading only the first line of the value dropped the words
    // `Android devices`, so the skill never matched the android playbook and the count came
    // back short with no error.
    const h = home()
    try {
      const root = join(h, '.agents', 'skills')
      skill(root, 'adaptive', FLAT_SCALAR)
      const found = scanLocalSkills({ env: { ANVIL_CONFIG_HOME: h } as NodeJS.ProcessEnv })
      const description = found[0]?.description ?? ''
      assert.match(description, /adapts to different Android devices/, `got: ${description}`)
      assert.match(description, /TV, Auto and XR/)
      assert.ok(
        skillMatchesSeeds(found[0]!, ['android']),
        'the technology name is on line two, so the match has to see it',
      )
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('a folded block scalar is read, and not treated as an empty value', () => {
    const h = home()
    try {
      const root = join(h, '.agents', 'skills')
      skill(root, 'nav', FOLDED_SCALAR)
      const found = scanLocalSkills({ env: { ANVIL_CONFIG_HOME: h } as NodeJS.ProcessEnv })
      assert.match(found[0]?.description ?? '', /Navigation 3/)
      assert.ok(skillMatchesSeeds(found[0]!, ['navigation']))
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('a nested key-value list contributes to the match haystack', () => {
    // Play's Engage SDK is an Android library whose description never says "Android". Its
    // keywords list does, so a matcher reading only `description` misses it -- which is a
    // real skill on a real machine, not a synthetic one.
    const h = home()
    try {
      const root = join(h, '.agents', 'skills')
      skill(root, 'engage-sdk-integration', SEQUENTIAL_KEYWORDS)
      const found = scanLocalSkills({ env: { ANVIL_CONFIG_HOME: h } as NodeJS.ProcessEnv })
      const one = found[0]
      assert.ok(one !== undefined)
      assert.match(one.haystack, /android/, `haystack was: ${one.haystack}`)
      assert.ok(skillMatchesSeeds(one, ['android']))
      // And the conventional description is still the description, not the whole record.
      assert.doesNotMatch(one.description, /author/)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('a file with no frontmatter still yields a skill, described by its first prose line', () => {
    const h = home()
    try {
      const root = join(h, '.agents', 'skills')
      skill(root, 'plain', NO_FRONTMATTER)
      const found = scanLocalSkills({ env: { ANVIL_CONFIG_HOME: h } as NodeJS.ProcessEnv })
      assert.equal(found.length, 1)
      assert.equal(found[0]?.name, 'plain', 'the directory name is the fallback name')
      assert.match(found[0]?.description ?? '', /Prose about Android/)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('a directory with no SKILL.md is not a skill', () => {
    const h = home()
    try {
      const root = join(h, '.agents', 'skills')
      mkdirSync(join(root, 'references'), { recursive: true })
      writeFileSync(join(root, 'references', 'notes.md'), 'not a skill', 'utf8')
      assert.equal(scanLocalSkills({ env: { ANVIL_CONFIG_HOME: h } as NodeJS.ProcessEnv }).length, 0)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('the same skill in two tool directories is found twice, by path', () => {
    // Deduplication happens upstream, by name. This test pins that the scan does *not*
    // silently collapse them: the copy count is information, and `run.ts` reports it.
    const h = home()
    try {
      skill(join(h, '.agents', 'skills'), 'styles', FOLDED_SCALAR)
      skill(join(h, '.claude', 'skills'), 'styles', FOLDED_SCALAR)
      const found = scanLocalSkills({ env: { ANVIL_CONFIG_HOME: h } as NodeJS.ProcessEnv })
      assert.equal(found.length, 2)
      assert.notEqual(found[0]?.path, found[1]?.path)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('every standard root is searched, and a missing one is not an error', () => {
    const h = home()
    try {
      const roots = skillSearchRoots({ ANVIL_CONFIG_HOME: h } as NodeJS.ProcessEnv)
      assert.equal(roots.length, 3)
      assert.deepEqual(
        scanLocalSkills({ env: { ANVIL_CONFIG_HOME: h } as NodeJS.ProcessEnv }),
        [],
        'no directories exist yet, which is the normal case',
      )
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })
})

describe('skillMatchesSeeds', () => {
  const skillOf = (haystack: string) => ({
    name: 'x',
    description: '',
    haystack,
    path: '',
    root: '',
  })

  test('matches a whole word', () => {
    assert.ok(skillMatchesSeeds(skillOf('Skills for Android devices'), ['android']))
  })

  test('does not match inside a longer word', () => {
    // The substring version matched "android" inside "androidx", and "gradle" inside
    // "upgradable", which is how a Go or Node skill ended up in an Android plan.
    assert.equal(skillMatchesSeeds(skillOf('Compose for androidx libraries'), ['android']), false)
    assert.equal(skillMatchesSeeds(skillOf('The module is upgradable'), ['gradle']), false)
  })

  test('is case-insensitive, because frontmatter is not consistent about case', () => {
    assert.ok(skillMatchesSeeds(skillOf('Native ANDROID tooling'), ['android']))
  })

  test('ignores a term too short to be meaningful', () => {
    // "go" is three characters and would match "google", "django" and "mongo".
    assert.equal(skillMatchesSeeds(skillOf('a go and a django app'), ['go']), false)
  })

  test('an empty skill list matches nothing rather than everything', () => {
    assert.equal(skillMatchesSeeds(skillOf('anything'), []), false)
  })
})

describe('discoverLocal: publisher evidence', () => {
  test('an installed skill is official-tiered but labelled local-install', () => {
    const h = home()
    try {
      skill(join(h, '.agents', 'skills'), 'adaptive', FLAT_SCALAR)

      const { entries } = discoverLocal(
        'android',
        { officialOrgs: ['android'], keywords: [], mcp: [] },
        { env: { ANVIL_CONFIG_HOME: h } as NodeJS.ProcessEnv },
      )

      assert.equal(entries.length, 1)
      // A file on disk proves it is installed, not who wrote it. Both facts are reported.
      assert.equal(entries[0]?.tier, 'official')
      assert.equal(entries[0]?.trust, 'local-install')
      assert.equal(entries[0]?.source, 'local-scan')
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })
})

describe('local skill matching uses identity terms, not search phrases', () => {
  // The defect these pin, found on the authoring machine: a CI playbook whose keyword was
  // "workflow validation" matched a Jetpack Compose skill because its description contained
  // the ordinary word "workflow", and a Terraform playbook matched a testing skill through
  // "infrastructure". The keyword is what the network is asked; it is not what a skill is.
  function withSkill(dir: string, body: string): { env: NodeJS.ProcessEnv } {
    const h = home()
    skill(join(h, '.agents', 'skills'), dir, body)
    return { env: { ANVIL_CONFIG_HOME: h } as NodeJS.ProcessEnv }
  }

  test('a search keyword head does not match a local skill', () => {
    const { env } = withSkill(
      'compose-skill',
      '---\nname: compose-skill\ndescription: Compose UI for Android apps, with a flexible workflow.\n---\n',
    )
    const result = discoverLocal(
      'ci',
      { officialOrgs: [], keywords: ['workflow validation'], mcp: [], localMatch: [] },
      { env },
    )
    assert.equal(result.entries.length, 0, 'the word "workflow" is not evidence of a CI skill')
  })

  test('a keyword head that names another technology does not leak in', () => {
    const { env } = withSkill(
      'testing-setup',
      '---\nname: testing-setup\ndescription: Set up a testing infrastructure with unit tests.\n---\n',
    )
    const result = discoverLocal(
      'terraform',
      { officialOrgs: [], keywords: ['infrastructure agent skills'], mcp: [], localMatch: [] },
      { env },
    )
    assert.equal(result.entries.length, 0, 'the word "infrastructure" is not Terraform evidence')
  })

  test('an explicit local-match term is what surfaces a skill', () => {
    const { env } = withSkill(
      'ts-tools',
      '---\nname: ts-tools\ndescription: Everyday helpers for a TypeScript monorepo.\n---\n',
    )
    const result = discoverLocal(
      'node',
      { officialOrgs: [], keywords: [], mcp: [], localMatch: ['typescript'] },
      { env },
    )
    assert.equal(result.entries.length, 1)
    assert.equal(result.entries[0]?.label, 'ts-tools')
  })

  test('the playbook id alone still matches a skill named after it', () => {
    const { env } = withSkill(
      'navigation',
      '---\nname: navigation\ndescription: Navigation patterns for Android apps.\n---\n',
    )
    const result = discoverLocal('android', { officialOrgs: [], keywords: [], mcp: [], localMatch: [] }, { env })
    assert.equal(result.entries.length, 1)
  })
})
