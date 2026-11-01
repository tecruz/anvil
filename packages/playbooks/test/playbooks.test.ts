import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { audit } from '@anvil/audit'
import {
  buildPlan,
  loadBuiltins,
  loadPlaybooks,
  loadPlaybooksFromDirectory,
  matchPlaybooks,
  type Plan,
  parsePlaybook,
  parsePlaybookFiles,
  parseYamlSubset,
  rankSuggestions,
  type Suggestion,
  validatePlaybook,
} from '@anvil/playbooks'
import { buildProfile, matchesAny, type ProjectProfile } from '@anvil/profile'

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
    const { playbook, issues } = validatePlaybook(parseYamlSubset(`${MINIMAL}\nriskGlob: ['**/x']\n`))
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
    const { issues } = validatePlaybook(parseYamlSubset(`${MINIMAL}\nofficial:\n  docs:\n    - label: x\n`))
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
    assert.throws(() => parsePlaybook('id: BAD\ntitle: X\nmatch:\n  files: [a]\n', 'thing.yaml'), /thing\.yaml/)
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

  test('covers every ecosystem the detectors emit, plus the file-only ones', () => {
    // The registry grew from 3 to 24, so this is now a coverage claim rather than a snapshot. A
    // new ecosystem with no playbook shows up in `plan` as a matched stack with no guidance at
    // all, which is worse than not detecting it. The QA and mobile frameworks are one playbook
    // per tool, because a repository that runs Playwright has no use for the Cypress
    // documentation, and a Flutter app has none for Xcode's.
    const ids = playbooks.map((p) => p.id).sort()
    assert.deepEqual(ids, [
      'android',
      'ci',
      'cpp',
      'cypress',
      'docker',
      'dotnet',
      'elixir',
      'flutter',
      'go',
      'ios',
      'jvm',
      'kubernetes',
      'maestro',
      'maui',
      'node',
      'php',
      'playwright',
      'python',
      'qa',
      'react-native',
      'ruby',
      'rust',
      'swift',
      'terraform',
      'webdriverio',
    ])
  })

  test('the three original seed playbooks survived the expansion', () => {
    // They are the ones with the most battle-testing behind them, so an accidental
    // rename during the expansion would silently change every existing plan.
    const ids = playbooks.map((p) => p.id)
    for (const seed of ['jvm', 'node', 'python']) {
      assert.ok(ids.includes(seed), `${seed} should still be in the registry`)
    }
  })

  test('no playbook suggests a changed-files subset that cannot run as given', () => {
    // Found by auditing okhttp, spring-petclinic and nowinandroid: all three were told they
    // had a documented fast test subset, with a command naming a task none of them
    // defines. The registry carried the command (`./gradlew test --tests "*Changed*"`) and
    // the JVM detector copied it in, so the defect survived the detector being fixed.
    //
    // A `testFast` suggestion is a command a reader may run verbatim, so its mechanism has
    // to exist in the ecosystem. These three forms all need something the repository has to
    // define first, and each of them selects zero tests when it does not:
    //
    //   - a `*Changed` test task / `*Changed*` name filter (Gradle, Maven, PHPUnit, xUnit,
    //     Swift, pytest -k, go -run): filters on a test *name*.
    //   - `--target <stage>` (docker): a build stage the Dockerfile has to declare.
    //   - `npm run test:<x>`: a script the package has to declare.
    const notRunnable = [
      /--tests?\s+["']?\*Changed/i,
      /-D(?:it\.)?test=\*?Changed/i,
      /--filter[= ]=?["']?<?Changed/i,
      /\s-k\s+changed\b/i,
      /-run\s+Changed\b/,
      /--target\s+\w+/,
      /npm run test:\w+/,
    ]
    for (const p of playbooks) {
      for (const cmd of p.verify.testFast) {
        for (const re of notRunnable) {
          assert.ok(
            !re.test(cmd),
            `${p.id} suggests \`${cmd}\`, which needs a task, stage or script the repository has to define first`,
          )
        }
      }
    }
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

  test('every playbook contributes something actionable', () => {
    // A playbook that matches a repository has to say something about it. Most say how to
    // verify it; the cross-cutting ones -- the `qa` playbook, which holds what every
    // browser-test repository needs while the per-tool playbooks hold the command --
    // say which paths are risky instead. A playbook that does neither is dead weight.
    for (const p of playbooks) {
      const verify = Object.values(p.verify).reduce((n, v) => n + v.length, 0)
      assert.ok(verify > 0 || p.riskGlobs.length > 0, `${p.id} declares neither verify commands nor risk globs`)
    }
  })
})

describe('registry files are clean text', () => {
  test('no playbook contains a non-printable control character', () => {
    for (const file of readdirSync(REGISTRY_DIR).filter((f) => /\.ya?ml$/.test(f))) {
      const text = readFileSync(join(REGISTRY_DIR, file), 'utf8')
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i)
        const invalid =
          code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || (code >= 127 && code <= 159)
        assert.ok(
          !invalid,
          `${file} contains U+${code.toString(16).toUpperCase().padStart(4, '0')} at offset ${String(i)}`,
        )
      }
    }
  })
})

describe('generated file is in sync with the YAML sources', () => {
  // If someone edits a playbook and forgets `npm run gen:playbooks`, the change silently
  // does not exist. This is the guard.
  test('generated.ts matches registry/playbooks/*.yaml', async () => {
    const generated = await import('@anvil/playbooks/generated')
    const onDisk = new Map<string, string>()
    for (const file of readdirSync(REGISTRY_DIR)
      .filter((f) => /\.ya?ml$/.test(f))
      .sort()) {
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
  /**
   * The built-in count, read rather than hardcoded.
   *
   * These tests were written when the registry had exactly three playbooks and asserted
   * `length === 3`. Growing the registry broke them, and the tempting fix -- editing 3 to 15
   * -- would have re-broken them on the next addition. A test that encodes a count the
   * project intends to grow is a test that will be deleted or weakened instead of fixed.
   */
  const builtinCount = (): number => loadBuiltins().playbooks.length

  test('the default user directory is loaded without any environment variable', () => {
    // `anvil playbook add` writes to the home directory, so a playbook installed the
    // obvious way has to be picked up the obvious way. Before this, only ANVIL_PLAYBOOKS
    // was read and an installed playbook was invisible.
    const home = tempDir()
    const dir = join(home, '.anvil', 'playbooks')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'acme.yaml'),
      'id: acme\ntitle: ACME\npriority: 65\nmatch:\n  files: ["acme.config.yaml"]\n',
    )
    const { playbooks } = loadPlaybooks({ ANVIL_CONFIG_HOME: home } as NodeJS.ProcessEnv)
    assert.ok(
      playbooks.some((p) => p.id === 'acme'),
      'the installed playbook should be active',
    )
  })

  test('a user playbook adds to the built-ins rather than replacing them', () => {
    // The bug this pins: the multi-directory loader started from an empty map, so adding
    // one company playbook silently reduced the registry from fifteen to one. A user would
    // have discovered it as "anvil suddenly has no Terraform guidance".
    const home = tempDir()
    const dir = join(home, '.anvil', 'playbooks')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'acme.yaml'),
      'id: acme\ntitle: ACME\npriority: 65\nmatch:\n  files: ["acme.config.yaml"]\n',
    )
    const { playbooks } = loadPlaybooks({ ANVIL_CONFIG_HOME: home } as NodeJS.ProcessEnv)
    assert.equal(playbooks.length, builtinCount() + 1)
    for (const id of ['node', 'terraform', 'python']) {
      assert.ok(
        playbooks.some((p) => p.id === id),
        `${id} should still be registered`,
      )
    }
  })

  test('a user playbook can override a built-in by id', () => {
    const home = tempDir()
    const dir = join(home, '.anvil', 'playbooks')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'node.yaml'),
      'id: node\ntitle: Company node rules\npriority: 99\nmatch:\n  files: ["package.json"]\n',
    )
    const { playbooks } = loadPlaybooks({ ANVIL_CONFIG_HOME: home } as NodeJS.ProcessEnv)
    assert.equal(playbooks.filter((p) => p.id === 'node').length, 1)
    assert.equal(playbooks.find((p) => p.id === 'node')?.title, 'Company node rules')
  })

  test('an absent default directory is not a warning', () => {
    // Everybody hits this before they have added anything; warning about it would mean the
    // first thing every user sees is a complaint about a directory they never made.
    const { playbooks, warnings } = loadPlaybooks({
      ANVIL_CONFIG_HOME: tempDir(),
    } as NodeJS.ProcessEnv)
    assert.equal(warnings.length, 0)
    assert.equal(playbooks.length, builtinCount())
  })

  test('an explicitly configured directory that is missing does warn', () => {
    const { warnings } = loadPlaybooks({
      ANVIL_CONFIG_HOME: tempDir(),
      ANVIL_PLAYBOOKS: join(tempDir(), 'does-not-exist'),
    } as NodeJS.ProcessEnv)
    assert.ok(
      warnings.some((w) => w.includes('playbook directory not found')),
      warnings.join('; '),
    )
  })

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
      assert.equal(playbooks.length, builtinCount(), 'overrides rather than appends')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('adds a new id without removing built-ins', () => {
    const dir = tempDir()
    try {
      writeFileSync(join(dir, 'acme.yaml'), 'id: acme\ntitle: Acme\nmatch:\n  files: ["acme.toml"]\n')
      const { playbooks } = loadPlaybooksFromDirectory(dir)
      assert.equal(playbooks.length, builtinCount() + 1)
      assert.ok(playbooks.some((p) => p.id === 'acme'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("no playbook claims another ecosystem's framework", () => {
    // A `laravel` dep entry in the Ruby playbook made every PHP project match it, so
    // `plan` confidently recommended the Rails security guide to a Laravel codebase. A
    // cross-ecosystem match is worse than no match: it is confident and wrong, and the
    // reader has no reason to check.
    const { playbooks } = loadBuiltins()
    const owner: Record<string, string> = {
      laravel: 'php',
      rails: 'ruby',
      phoenix: 'elixir',
      django: 'python',
      fastapi: 'python',
      flask: 'python',
      'android-jetpack': 'android',
    }
    for (const pb of playbooks) {
      for (const dep of pb.match.deps) {
        const claimed = owner[dep]
        if (claimed === undefined) continue
        assert.equal(pb.id, claimed, `${pb.id} claims \`${dep}\`, which belongs to the ${claimed} playbook`)
      }
    }
  })

  test('a framework is matched by its own playbook, not by a same-named neighbour', () => {
    // The same defect, seen from the repo side: a Laravel fixture must not pick up Ruby.
    const profile = profileFor('php-laravel')
    const { playbooks } = loadBuiltins()
    const ids = matchPlaybooks(profile, playbooks).map((m) => m.playbook.id)
    assert.ok(ids.includes('php'), 'a Laravel project is a PHP project')
    assert.ok(!ids.includes('ruby'), `a Laravel project matched ruby; got ${ids.join(', ')}`)
  })

  test('a broken user playbook warns without taking down the built-ins', () => {
    const dir = tempDir()
    try {
      writeFileSync(join(dir, 'broken.yaml'), 'id: BROKEN\n')
      const { playbooks, warnings } = loadPlaybooksFromDirectory(dir)
      assert.equal(playbooks.length, builtinCount(), 'built-ins still load')
      assert.equal(warnings.length, 1)
      assert.match(warnings[0] ?? '', /broken\.yaml/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a missing directory warns rather than throwing', () => {
    const { playbooks, warnings } = loadPlaybooksFromDirectory(join(tempDir(), 'nope'))
    assert.equal(playbooks.length, builtinCount())
    assert.ok(warnings.some((w) => w.includes('not found')))
  })

  test('an empty directory warns', () => {
    const { warnings } = loadPlaybooksFromDirectory(tempDir())
    assert.ok(warnings.some((w) => w.includes('no .yaml playbooks')))
  })

  test('two files claiming one id is reported, because the merge drops one of them', () => {
    // The merge is keyed by id, so of two files claiming `acme` only one is ever used -- and
    // the surviving playbook looks perfectly fine, so nothing downstream could see it. The
    // structural check could not catch it either: it receives the list *after* the merge.
    const dir = tempDir()
    try {
      writeFileSync(join(dir, 'one.yaml'), 'id: acme\ntitle: One\nmatch:\n  files: ["a.txt"]\n')
      writeFileSync(join(dir, 'two.yaml'), 'id: acme\ntitle: Two\nmatch:\n  files: ["a.txt"]\n')
      const { playbooks, warnings } = loadPlaybooksFromDirectory(dir)
      const acme = playbooks.filter((p) => p.id === 'acme')
      assert.equal(acme.length, 1, 'the merge still collapses them; that is why this is reported')
      assert.ok(
        warnings.some((w) => /duplicate playbook id "acme"/.test(w)),
        `expected a duplicate-id warning, got ${JSON.stringify(warnings)}`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a later layer replacing an earlier one is the documented override, not a warning', () => {
    const company = tempDir()
    const home = tempDir()
    try {
      writeFileSync(join(company, 'node.yaml'), 'id: node\ntitle: Company node\nmatch:\n  files: ["package.json"]\n')
      mkdirSync(join(home, '.anvil', 'playbooks'), { recursive: true })
      writeFileSync(
        join(home, '.anvil', 'playbooks', 'mine.yaml'),
        'id: mine\ntitle: Mine\nmatch:\n  files: ["x.txt"]\n',
      )
      const { playbooks, warnings } = loadPlaybooks({
        ANVIL_CONFIG_HOME: home,
        ANVIL_PLAYBOOKS: company,
      } as NodeJS.ProcessEnv)
      assert.equal(playbooks.find((p) => p.id === 'mine')?.title, 'Mine')
      assert.equal(playbooks.find((p) => p.id === 'node')?.title, 'Company node')
      assert.ok(
        !warnings.some((w) => /duplicate/.test(w)),
        `an override is not a duplicate: ${JSON.stringify(warnings)}`,
      )
    } finally {
      rmSync(company, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
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
    assert.equal(
      matches.find((m) => m.playbook.id === 'node'),
      undefined,
    )
    assert.ok(matches.find((m) => m.playbook.id === 'python'))
  })

  test('a Gradle repo matches jvm', () => {
    const matches = matchPlaybooks(profileFor('jvm-gradle'), playbooks)
    assert.ok(matches.find((m) => m.playbook.id === 'jvm'))
  })

  test('higher priority sorts first when several match', () => {
    const generic = parsePlaybook('id: generic\ntitle: G\npriority: 1\nmatch:\n  files: ["package.json"]\n', 'g.yaml')
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

  test('a lone .rb file is a language, not a Ruby project', () => {
    // ripgrep ships a Homebrew formula under pkg/brew, so the profile infers the `ruby`
    // language. Matching the ruby playbook on it offered Rails security guides to a Rust
    // repository. The playbook requires a real Ruby manifest now.
    const dir = tempDir()
    try {
      mkdirSync(join(dir, 'pkg', 'brew'), { recursive: true })
      writeFileSync(join(dir, 'pkg', 'brew', 'ripgrep-bin.rb'), 'class RipgrepBin < Formula\nend\n')
      writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "ripgrep"\nversion = "14.1.0"\n')
      const profile = buildProfile(dir, { root: dir, host: null, remote: null, defaultBranch: null }).profile
      const ids = matchPlaybooks(profile, playbooks).map((m) => m.playbook.id)
      assert.ok(ids.includes('rust'), `it is still a Rust project; got ${ids.join(', ')}`)
      assert.ok(!ids.includes('ruby'), `a lone .rb file matched ruby: ${ids.join(', ')}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a Dart package with no Flutter dependency is not a Flutter project', () => {
    // A `pubspec.yaml` is a Dart package. Matching the flutter playbook on the file alone
    // offered the Flutter cookbook and `flutter build` to a package with no Flutter SDK.
    const dir = tempDir()
    try {
      writeFileSync(join(dir, 'pubspec.yaml'), 'name: pure_dart\ndependencies:\n  http: ^1.2.0\n')
      mkdirSync(join(dir, 'lib'), { recursive: true })
      writeFileSync(join(dir, 'lib', 'main.dart'), 'void main() {}\n')
      const profile = buildProfile(dir, { root: dir, host: null, remote: null, defaultBranch: null }).profile
      const ids = matchPlaybooks(profile, playbooks).map((m) => m.playbook.id)
      assert.ok(!ids.includes('flutter'), `pure Dart matched flutter: ${ids.join(', ')}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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

  // ------------------------------------------------------------------------
  // Risk globs are conditional on the repo having such a file
  // ------------------------------------------------------------------------

  test('a risk glob is only suggested when the repo has a file matching it', () => {
    // The unbounded-guidance defect: a Node repo with no pnpm lockfile and no Dockerfile
    // was being told to treat `**/pnpm-lock.yaml` and `**/Dockerfile*` as high-risk. Advice
    // about files that do not exist is not advice, it is noise.
    const { playbooks } = loadBuiltins()
    const profile = profileFor('node-npm')
    const matches = matchPlaybooks(profile, playbooks)
    const plan = buildPlan(audit(profile), profile, matches)
    const risks = plan.suggestions.filter((s) => s.id.startsWith('risk:'))

    for (const r of risks) {
      const glob = r.id.split(':').slice(2).join(':')
      assert.ok(matchesAny(profile.files, glob), `${r.id} is suggested but no file in node-npm matches ${glob}`)
    }
  })

  test('a risk glob that the repo does have cites the file as evidence', () => {
    // Otherwise the suggestion is a generic assertion; the reader cannot check it.
    const { playbooks } = loadBuiltins()
    const profile = profileFor('node-npm')
    const matches = matchPlaybooks(profile, playbooks)
    const plan = buildPlan(audit(profile), profile, matches)
    const pkg = plan.suggestions.find((s) => s.id === 'risk:node:**/package.json')
    assert.ok(pkg !== undefined, 'node-npm has a package.json, so this glob should apply')
    assert.ok(
      pkg.evidence.some((e) => e === 'package.json'),
      `evidence should name the file, got ${JSON.stringify(pkg.evidence)}`,
    )
  })

  test('conditional risk globs cut the official tier down, not the derived tier', () => {
    // The point of the fix: an actionable list, derived work first. If gating risk globs
    // also removed derived fixes the plan would be losing real work, not noise.
    const p = planFor('node-npm')
    const riskCount = p.suggestions.filter((s) => s.id.startsWith('risk:')).length
    assert.ok(riskCount > 0, 'the node fixture does have a package.json, so some apply')
    assert.ok(p.counts.official < p.counts.derived + p.counts.official, 'sanity: counts are still computed')
    const allRiskGlobs = loadBuiltins()
      .playbooks.filter((pb) => pb.id === 'node')
      .flatMap((pb) => pb.riskGlobs)
    assert.ok(
      riskCount < allRiskGlobs.length,
      `expected only the globs that apply (${riskCount} of ${allRiskGlobs.length})`,
    )
  })

  test('a risk glob declared by two playbooks is suggested once', () => {
    // An Android repo matches both `jvm` and `android`, and both declare
    // `**/build.gradle.kts`. Printed twice, the same advice reads as two concerns; the
    // higher-priority playbook keeps it, which is the one with the specific Android rules.
    const { playbooks } = loadBuiltins()
    const profile = profileFor('jvm-gradle')
    const matches = matchPlaybooks(profile, playbooks)
    assert.ok(matches.length > 1, 'this fixture should match more than one playbook')
    const plan = buildPlan(audit(profile), profile, matches)
    const globs = plan.suggestions
      .filter((s) => s.id.startsWith('risk:'))
      .map((s) => s.id.split(':').slice(2).join(':'))
    assert.equal(new Set(globs).size, globs.length, `duplicate risk globs: ${globs.join(', ')}`)
  })

  test('the higher-priority playbook wins a contested risk glob', () => {
    const { playbooks } = loadBuiltins()
    const profile = profileFor('jvm-gradle')
    const matches = matchPlaybooks(profile, playbooks)
    const winner = matches[0]?.playbook.id
    const plan = buildPlan(audit(profile), profile, matches)
    const contested = plan.suggestions.find((s) => s.id === `risk:${winner}:**/build.gradle.kts`)
    assert.ok(contested !== undefined, `expected ${winner} to own **/build.gradle.kts`)
  })

  test('a cold repo gets no risk suggestions even from a matched playbook', () => {
    const { playbooks } = loadBuiltins()
    const profile = profileFor('cold-empty')
    const plan = buildPlan(audit(profile), profile, matchPlaybooks(profile, playbooks), [])
    assert.equal(plan.suggestions.filter((s) => s.id.startsWith('risk:')).length, 0)
  })

  test('rankSuggestions is stable for equal inputs', () => {
    const a: Suggestion = {
      id: 'a',
      tier: 'derived',
      title: 'a',
      detail: '',
      evidence: [],
      confidence: 0.5,
      provenance: 'curated',
    }
    const b: Suggestion = {
      id: 'b',
      tier: 'derived',
      title: 'b',
      detail: '',
      evidence: [],
      confidence: 0.5,
      provenance: 'curated',
    }
    assert.deepEqual(
      rankSuggestions([b, a]).map((s) => s.id),
      rankSuggestions([a, b]).map((s) => s.id),
    )
  })

  test('blocker findings outrank a lower-severity fix within a tier', () => {
    const sorted = rankSuggestions([
      {
        id: 'low',
        tier: 'derived',
        title: '',
        detail: '',
        evidence: [],
        confidence: 0.9,
        provenance: 'curated',
        severity: 'low',
      },
      {
        id: 'blocker',
        tier: 'derived',
        title: '',
        detail: '',
        evidence: [],
        confidence: 0.1,
        provenance: 'curated',
        severity: 'blocker',
      },
    ])
    assert.equal(sorted[0]?.id, 'blocker')
  })
})

// ---------------------------------------------------------------------------
// The QA playbooks
// ---------------------------------------------------------------------------

describe('qa playbooks', () => {
  /** A repository with the given files, which may live in subdirectories. */
  function repoWith(files: Record<string, string>): ProjectProfile {
    const dir = tempDir()
    try {
      for (const [name, body] of Object.entries(files)) {
        const path = join(dir, name)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, body)
      }
      return buildProfile(dir, { root: dir, host: null, remote: null, defaultBranch: null }).profile
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const PLAYWRIGHT_CONFIG = "export default { testDir: './e2e' }\n"

  test('a repository with a playwright config matches the playwright and qa playbooks', () => {
    const { playbooks } = loadBuiltins()
    const profile = repoWith({ 'playwright.config.ts': PLAYWRIGHT_CONFIG, 'package.json': '{}' })
    const ids = matchPlaybooks(profile, playbooks).map((m) => m.playbook.id)
    assert.ok(ids.includes('playwright'), `expected playwright, saw ${ids.join(', ')}`)
    assert.ok(ids.includes('qa'), `expected qa, saw ${ids.join(', ')}`)
  })

  test('a playwright repository is not offered the cypress documentation', () => {
    // The rule that made the QA playbooks one per tool: guidance that does not apply to
    // this repository is noise, and noise is what teaches a reader to skip the plan.
    const { playbooks } = loadBuiltins()
    const profile = repoWith({ 'playwright.config.ts': PLAYWRIGHT_CONFIG, 'package.json': '{}' })
    const plan = buildPlan(audit(profile), profile, matchPlaybooks(profile, playbooks))
    const titles = plan.suggestions.map((s) => s.title)
    assert.ok(!titles.some((t) => /cypress/i.test(t)), `unexpected Cypress guidance: ${titles.join(', ')}`)
  })

  test('a cypress repository is not offered the playwright documentation', () => {
    const { playbooks } = loadBuiltins()
    const profile = repoWith({ 'cypress.config.ts': PLAYWRIGHT_CONFIG, 'package.json': '{}' })
    const plan = buildPlan(audit(profile), profile, matchPlaybooks(profile, playbooks))
    const titles = plan.suggestions.map((s) => s.title)
    assert.ok(!titles.some((t) => /playwright/i.test(t)), `unexpected Playwright guidance: ${titles.join(', ')}`)
  })

  test('a maestro repository is recognised by its flow directory', () => {
    // Maestro has no config file of its own beyond an optional `config.yaml`, and the
    // documented home for the flows is `.maestro/`. The walk used to skip every hidden
    // directory, so the playbook could never match and the risk glob could never fire.
    const { playbooks } = loadBuiltins()
    const profile = repoWith({ '.maestro/login.yaml': 'appId: com.example.app\n', 'package.json': '{}' })
    const ids = matchPlaybooks(profile, playbooks).map((m) => m.playbook.id)
    assert.ok(ids.includes('maestro'), `expected maestro, saw ${ids.join(', ')}`)
    assert.ok(ids.includes('qa'), `expected qa, saw ${ids.join(', ')}`)
  })
})

// ---------------------------------------------------------------------------
// Satisfaction: guidance the repository already follows
// ---------------------------------------------------------------------------

describe('satisfiedBy', () => {
  /** A playbook whose one resource is satisfied by a file the repo may or may not have. */
  const PLAYBOOK = `
id: toy
title: Toy
priority: 10
match:
  files: ['toy.toml']
official:
  docs:
    - label: Toy docs
      url: 'https://example.com/toy'
      why: Because.
      satisfiedBy: ['**/toy-rc.toml']
`

  test('accepts a resource that declares satisfiedBy globs', () => {
    const { playbook, issues } = validatePlaybook(parseYamlSubset(PLAYBOOK))
    assert.deepEqual(issues, [])
    assert.deepEqual(playbook?.official.docs[0]?.satisfiedBy, ['**/toy-rc.toml'])
  })

  test('rejects satisfiedBy that is not a list', () => {
    const { issues } = validatePlaybook(
      parseYamlSubset(`${PLAYBOOK.replace("satisfiedBy: ['**/toy-rc.toml']", 'satisfiedBy: nope')}`),
    )
    assert.ok(issues.some((i) => i.path === 'official.docs[0].satisfiedBy'))
  })

  test('rejects a satisfiedBy glob that is not repo-relative', () => {
    const { issues } = validatePlaybook(
      parseYamlSubset(`${PLAYBOOK.replace("satisfiedBy: ['**/toy-rc.toml']", "satisfiedBy: ['/etc/passwd']")}`),
    )
    assert.ok(issues.some((i) => i.path === 'official.docs[0].satisfiedBy[0]'))
  })

  test('rejects an empty satisfiedBy glob', () => {
    const { issues } = validatePlaybook(
      parseYamlSubset(`${PLAYBOOK.replace("satisfiedBy: ['**/toy-rc.toml']", "satisfiedBy: ['']")}`),
    )
    assert.ok(issues.some((i) => i.path === 'official.docs[0].satisfiedBy[0]'))
  })

  /** A toy repo, with or without the file that satisfies the playbook's only resource. */
  function toyProfile(withRc: boolean): ProjectProfile {
    const dir = tempDir()
    try {
      writeFileSync(join(dir, 'toy.toml'), 'name = "toy"\n')
      if (withRc) writeFileSync(join(dir, 'toy-rc.toml'), 'mode = "strict"\n')
      return buildProfile(dir, { root: dir, host: null, remote: null, defaultBranch: null }).profile
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('a resource the repository already satisfies is left out of the plan', () => {
    const profile = toyProfile(true)
    const pb = parsePlaybook(PLAYBOOK, 'toy.yaml')
    const plan = buildPlan(audit(profile), profile, matchPlaybooks(profile, [pb]))
    assert.equal(plan.suggestions.filter((s) => s.id.startsWith('official:')).length, 0)
  })

  test('the count of what was left out is reported', () => {
    // The omission is a decision, and a decision the reader cannot see is one they cannot
    // check. The count is part of the plan's contract.
    const profile = toyProfile(true)
    const pb = parsePlaybook(PLAYBOOK, 'toy.yaml')
    const plan = buildPlan(audit(profile), profile, matchPlaybooks(profile, [pb]))
    assert.equal(plan.satisfied, 1)
  })

  test('the resource is offered when the repository does not satisfy it', () => {
    const profile = toyProfile(false)
    const pb = parsePlaybook(PLAYBOOK, 'toy.yaml')
    const plan = buildPlan(audit(profile), profile, matchPlaybooks(profile, [pb]))
    assert.equal(plan.suggestions.filter((s) => s.id.startsWith('official:')).length, 1)
    assert.equal(plan.satisfied, 0)
  })

  test('--include-satisfied keeps it, and names the file that satisfied it', () => {
    const profile = toyProfile(true)
    const pb = parsePlaybook(PLAYBOOK, 'toy.yaml')
    const plan = buildPlan(audit(profile), profile, matchPlaybooks(profile, [pb]), [], new Map(), {
      includeSatisfied: true,
    })
    const kept = plan.suggestions.filter((s) => s.id.startsWith('official:'))
    assert.equal(kept.length, 1)
    assert.ok(
      kept[0]?.evidence.includes('toy-rc.toml'),
      `evidence should name the file, got ${JSON.stringify(kept[0]?.evidence)}`,
    )
  })

  test('a community resource is satisfied the same way', () => {
    const profile = toyProfile(true)
    const pb = parsePlaybook(
      `${PLAYBOOK}\ncommunity:\n  - repo: 'acme/thing'\n    why: Because.\n    satisfiedBy: ['**/toy-rc.toml']\n`,
      'toy.yaml',
    )
    const plan = buildPlan(audit(profile), profile, matchPlaybooks(profile, [pb]))
    // Filtered by id, not by tier: a derived fix can also have `community` as its origin,
    // and this test is about the playbook's own community resource.
    assert.equal(plan.suggestions.filter((s) => s.id.startsWith('community:')).length, 0)
    assert.equal(plan.satisfied, 2)
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
    assert.deepEqual(
      playbooks.map((p) => p.id),
      ['a', 'b'],
    )
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /z\.yaml/)
  })
})

void mkdtemp
