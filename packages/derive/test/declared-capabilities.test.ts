import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { audit } from '@anvil/audit'
import { buildBrief, generateAgentsFile, generateVerifySkill } from '@anvil/derive'
import type { MatchResult } from '@anvil/playbooks'
import { emptyProfile, type ProjectProfile } from '@anvil/profile'

/**
 * Declared capabilities must reach the artifacts an agent actually reads, not only the
 * `anvil ready` report. These tests pin that: a project anvil cannot detect on its own still
 * gets its commands into AGENTS.md and the verify skill.
 */

function profileOf(overrides: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    ...emptyProfile('/repo', { host: null, remote: null, defaultBranch: null, root: '/repo' }),
    ...overrides,
  }
}

const noMatches: readonly MatchResult[] = []

describe('declared capabilities reach generated context', () => {
  test('AGENTS.md includes a declared command and says where it came from', () => {
    const artifact = generateAgentsFile({
      profile: profileOf(),
      matches: noMatches,
      declared: {
        commands: [{ kind: 'test', cmd: 'mystery-cli check', dir: 'engine' }],
        tools: [],
        env: [],
        services: [],
        references: [],
      },
    })
    assert.match(artifact.content, /- \*\*Test:\*\* `mystery-cli check` _\(declared\)_ \(from `engine\/`\)/)
    assert.match(artifact.content, /Some of these are declared in `anvil\.config\.json`/)
  })

  test('the verify skill is generated from a declared test command, with its directory', () => {
    const artifact = generateVerifySkill({
      profile: profileOf(),
      matches: noMatches,
      declared: {
        commands: [{ kind: 'test', cmd: 'mystery-cli check', dir: 'engine' }],
        tools: [],
        env: [],
        services: [],
        references: [],
      },
    })
    assert.ok(artifact, 'a declared test command is enough to generate the skill')
    assert.match(artifact.content, /cd engine && mystery-cli check/)
  })

  test('with no declarations, no declared note appears', () => {
    const artifact = generateAgentsFile({
      profile: profileOf({
        commands: { test: [{ cmd: 'npm test', source: 'detected', evidence: 'package.json:12' }] },
      }),
      matches: noMatches,
    })
    assert.doesNotMatch(artifact.content, /declared in `anvil\.config\.json`/)
  })

  test('a generated shell directory is quoted so a space in the path is safe', () => {
    const artifact = generateVerifySkill({
      profile: profileOf(),
      matches: noMatches,
      declared: {
        commands: [{ kind: 'test', cmd: 'node check.js', dir: 'engine tools' }],
        tools: [],
        env: [],
        services: [],
        references: [],
      },
    })
    assert.ok(artifact)
    assert.match(artifact.content, /cd 'engine tools' && node check\.js/)
  })

  test('an explicit repository-root command keeps its directory in AGENTS.md', () => {
    const artifact = generateAgentsFile({
      profile: profileOf({ projectDir: 'engine' }),
      matches: noMatches,
      declared: {
        commands: [{ kind: 'test', cmd: 'node root-check.js', dir: '' }],
        tools: [],
        env: [],
        services: [],
        references: [],
      },
    })
    assert.match(artifact.content, /- \*\*Test:\*\* `node root-check\.js` _\(declared\)_ \(from the repository root\)/)
  })

  test('the verify skill starts at the repository root, so a root-override command runs there', () => {
    // The skill used to say "run from that directory" and then emit a bare repository-root
    // command, which fails when the reader follows the instruction.
    const artifact = generateVerifySkill({
      profile: profileOf({ projectDir: 'engine' }),
      matches: noMatches,
      declared: {
        commands: [{ kind: 'test', cmd: 'node root-check.js', dir: '' }],
        tools: [],
        env: [],
        services: [],
        references: [],
      },
    })
    assert.ok(artifact)
    assert.match(artifact.content, /Run the commands below from the repository root/)
    assert.match(artifact.content, /\nnode root-check\.js\n/, 'a root-override command has no cd')
    assert.doesNotMatch(artifact.content, /cd .* && node root-check\.js/)
  })

  test('the brief carries declared commands with their directory and precedence', () => {
    const profile = profileOf({
      commands: { test: [{ cmd: 'npm test', source: 'detected', evidence: 'package.json:12' }] },
    })
    const brief = buildBrief({
      profile,
      report: audit(profile),
      matches: noMatches,
      target: 'all',
      read: () => null,
      declared: {
        commands: [{ kind: 'test', cmd: 'make check', dir: 'engine' }],
        tools: [],
        env: [],
        services: [],
        references: [],
      },
    })
    const declared = brief.commands.find((c) => c.source === 'declared')
    assert.equal(declared?.cmd, 'make check')
    assert.equal(declared?.dir, 'engine')
    assert.equal(declared?.primary, true, 'the declared command is the one anvil uses for its kind')
    const detected = brief.commands.find((c) => c.source === 'detected')
    assert.equal(detected?.primary, false, 'the detected command is kept, but demoted')
  })
})
