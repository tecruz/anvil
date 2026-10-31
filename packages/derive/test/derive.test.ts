import assert from 'node:assert/strict'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { audit } from '@anvil/audit'
import {
  applyStaging,
  buildBrief,
  checkApplyPreconditions,
  clearStaging,
  type GeneratedArtifact,
  generateAgentsFile,
  generateReviewCommand,
  generateVerifySkill,
  hashInputs,
  inspectStaging,
  readManifest,
  readRepoFile,
  readStaged,
  sha256,
  validateAll,
  validateArtifact,
  writeStaging,
} from '@anvil/derive'
import { loadBuiltins, matchPlaybooks } from '@anvil/playbooks'
import { buildProfile, type ProjectProfile } from '@anvil/profile'

const here = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(here, '..', '..', '..')
const FIXTURES = join(REPO_ROOT, 'fixtures')

const temps: string[] = []
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

function copyTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name)
    const to = join(dest, entry.name)
    if (entry.isDirectory()) copyTree(from, to)
    else copyFileSync(from, to)
  }
}

function materialize(fixture: string): string {
  const dir = mkdtempSync(join(tmpdir(), `anvil-m2b-${fixture}-`))
  temps.push(dir)
  copyTree(join(FIXTURES, fixture), dir)
  return dir
}

function profileIn(root: string): ProjectProfile {
  return buildProfile(root, {
    root,
    host: null,
    remote: null,
    defaultBranch: null,
  }).profile
}

function matchesFor(profile: ProjectProfile) {
  return matchPlaybooks(profile, loadBuiltins().playbooks)
}

// ===========================================================================
// The test that matters: anvil must improve what it measures.
// ===========================================================================

describe('self-referential: init must improve the readiness score', () => {
  // The one test that proves the tool does anything. If `init` did not raise `doctor`'s
  // score, the audit would be measuring something generation cannot affect, and the whole
  // premise would be wrong.
  for (const fixture of ['node-npm', 'python-django', 'go-module', 'node-workspace', 'cold-empty']) {
    test(`${fixture}: doctor -> init --apply -> doctor scores strictly higher`, () => {
      const dir = materialize(fixture)

      const before = audit(profileIn(dir)).score

      // Build and apply, exactly as `anvil init` / `anvil init --apply` do.
      const profile = profileIn(dir)
      const report = audit(profile)
      const matches = matchesFor(profile)
      const { playbooks } = loadBuiltins()

      const artifacts: GeneratedArtifact[] = [generateAgentsFile({ profile, matches })]
      const skill = generateVerifySkill({ profile, matches })
      if (skill !== null) artifacts.push(skill)
      const command = generateReviewCommand({ profile, matches })
      if (command !== null) artifacts.push(command)

      const validation = validateAll(artifacts)
      assert.ok(validation.ok, `generated artifacts must validate: ${JSON.stringify(validation.errors)}`)

      const inputHash = hashInputs({
        profile: { ...profile, files: undefined, root: undefined },
        report: { score: report.score, findings: report.findings },
        playbookIds: playbooks.map((p) => p.id),
      })
      writeStaging(dir, { inputHash, generator: 'test' }, new Map(artifacts.map((a) => [a.path, a.content])))

      const manifest = inspectStaging(dir).manifest
      assert.ok(manifest !== null)
      const check = checkApplyPreconditions(dir, manifest, inputHash)
      assert.ok(check.ok, `preconditions failed: ${check.reason}`)

      for (const a of artifacts) {
        const target = join(dir, a.path)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, a.content, 'utf8')
      }

      const after = audit(profileIn(dir)).score
      assert.ok(after > before, `expected ${after} > ${before} for ${fixture}`)

      // A rising score is not enough on its own: the audit can improve by clearing a
      // cosmetic rule while the blocker that matters most stays failing. `AGENTS_COMMANDS`
      // is the reason AGENTS.md exists, so generating it must clear that blocker.
      //
      // Only asserted for repos that have code: with no source files the rule is `na`
      // (there are no commands to document), so a generated AGENTS.md has nothing to fix.
      const finalReport = audit(profileIn(dir))
      const hasCode = finalReport.findings.some((f) => f.id === 'AGENTS_COMMANDS' && f.status !== 'na')
      if (hasCode) {
        const blocker = finalReport.findings.find((f) => f.id === 'AGENTS_COMMANDS')
        assert.equal(
          blocker?.status,
          'pass',
          `AGENTS_COMMANDS must pass after init for ${fixture}; the audit failed to recognize its own generated output`,
        )
      }
    })
  }

  test('cold-empty is the strongest case: an empty repo gains the most', () => {
    const dir = materialize('cold-empty')
    const before = audit(profileIn(dir)).score
    const profile = profileIn(dir)
    const matches = matchesFor(profile)
    const artifact = generateAgentsFile({ profile, matches })
    writeFileSync(join(dir, artifact.path), artifact.content, 'utf8')
    const after = audit(profileIn(dir)).score
    assert.ok(after > before, `expected ${after} > ${before}`)
  })

  test('a project in a subdirectory says where to run the commands from', () => {
    // `cargo test` is written the way cargo writes it: relative to the project. Printed
    // without the directory, it is a command that fails, and it fails in the most expensive
    // way -- it looks right.
    const dir = mkdtempSync(join(tmpdir(), 'anvil-subdir-'))
    try {
      mkdirSync(join(dir, 'engine', 'src'), { recursive: true })
      mkdirSync(join(dir, 'engine', 'tests'), { recursive: true })
      writeFileSync(join(dir, 'engine', 'Cargo.toml'), '[package]\nname = "engine"\nversion = "0.1.0"\n')
      writeFileSync(join(dir, 'engine', 'src', 'lib.rs'), 'pub fn go() {}\n')
      writeFileSync(join(dir, 'engine', 'tests', 'it.rs'), '#[test]\nfn t() {}\n')
      const profile = profileIn(dir)
      assert.equal(profile.projectDir, 'engine')
      const content = generateAgentsFile({ profile, matches: matchesFor(profile) }).content
      assert.match(content, /The project lives in `engine\/`/)
      assert.match(content, /cargo test/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a project at the root says nothing about directories', () => {
    const profile = profileIn(materialize('rust-crate'))
    assert.equal(profile.projectDir, '')
    const content = generateAgentsFile({ profile, matches: matchesFor(profile) }).content
    assert.doesNotMatch(content, /The project lives in/)
  })

  test('the skill and the review command carry the directory too, not just AGENTS.md', () => {
    // The subdirectory fix landed in the AGENTS.md template only, so the two artifacts that
    // *execute* the same commands -- the verify skill's bash fences and the review command's
    // `!` injection -- still emitted a bare `cargo test`, which fails at the repository root.
    // Getting it right in one of three templates leaves the other two actively misleading.
    const dir = mkdtempSync(join(tmpdir(), 'anvil-subdir-'))
    try {
      mkdirSync(join(dir, 'engine', 'src'), { recursive: true })
      mkdirSync(join(dir, 'engine', 'tests'), { recursive: true })
      writeFileSync(join(dir, 'engine', 'Cargo.toml'), '[package]\nname = "engine"\nversion = "0.1.0"\n')
      writeFileSync(join(dir, 'engine', 'src', 'lib.rs'), 'pub fn go() {}\n')
      writeFileSync(join(dir, 'engine', 'tests', 'it.rs'), '#[test]\nfn t() {}\n')
      const profile = profileIn(dir)
      assert.equal(profile.projectDir, 'engine')

      const skill = generateVerifySkill({ profile, matches: matchesFor(profile) })
      assert.ok(skill !== null, 'a verify skill is generated when there is a test command')
      assert.match(skill.content, /cd engine && cargo test/, 'the skill must run from the project dir')
      assert.match(skill.content, /The project lives in `engine\/`/)

      const review = generateReviewCommand({ profile, matches: matchesFor(profile) })
      assert.ok(review !== null, 'a review command is generated when there is a test command')
      assert.match(review.content, /!`cd engine && cargo test`/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a root project emits plain commands, with no cd prefix', () => {
    const profile = profileIn(materialize('rust-crate'))
    const skill = generateVerifySkill({ profile, matches: matchesFor(profile) })
    if (skill === null) return
    assert.ok(!/cd /.test(skill.content), skill.content)
  })
})

describe('idempotence', () => {
  test('generating twice from the same inputs produces identical bytes', () => {
    const dir = materialize('node-npm')
    const profile = profileIn(dir)
    const matches = matchesFor(profile)
    const a = generateAgentsFile({ profile, matches })
    const b = generateAgentsFile({
      profile: profileIn(dir),
      matches: matchesFor(profileIn(dir)),
    })
    assert.equal(sha256(a.content), sha256(b.content))
  })

  test('self-citations point at the row that carries them, even after the layout moves', () => {
    // The command evidence is read from the AGENTS.md on disk before the template lays out
    // the new file, so a citation like `AGENTS.md:8` describes the *old* layout. Without a
    // second pass, adding a section above the command table makes every self-citation lie.
    const dir = mkdtempSync(join(tmpdir(), 'anvil-self-cite-'))
    try {
      writeFileSync(
        join(dir, 'package.json'),
        `${JSON.stringify(
          { name: 'self-cite', version: '1.0.0', scripts: { test: 'node --test', lint: 'eslint .' } },
          null,
          2,
        )}\n`,
      )
      writeFileSync(
        join(dir, 'AGENTS.md'),
        [
          '# Local notes',
          '',
          'Some prose that will not survive regeneration.',
          '',
          'Run `npm test` before sending a change.',
          '',
          'Run `npm run lint` before sending a change.',
          '',
        ].join('\n'),
      )

      const first = generateAgentsFile({ profile: profileIn(dir), matches: matchesFor(profileIn(dir)) })
      const cited = [...first.content.matchAll(/^- \*\*.*`AGENTS\.md:(\d+)`$/gm)]
      assert.ok(cited.length >= 2, first.content)
      const lines = first.content.split('\n')
      for (const match of cited) {
        const line = lines[Number(match[1]) - 1]
        assert.ok(line?.startsWith('- **'), `AGENTS.md:${match[1]} does not point at a command row`)
        assert.ok(line?.endsWith(`\`AGENTS.md:${match[1]}\``), 'the row must cite itself')
      }

      // The generated file is now the input. Regenerating must be byte-identical: the
      // citations describe the file being read, not a layout that no longer exists.
      writeFileSync(join(dir, 'AGENTS.md'), first.content, 'utf8')
      const second = generateAgentsFile({
        profile: profileIn(dir),
        matches: matchesFor(profileIn(dir)),
      })
      assert.equal(second.content, first.content)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the input hash is stable across runs', () => {
    const dir = materialize('node-workspace')
    const h1 = hashInputsFrom(dir)
    const h2 = hashInputsFrom(dir)
    assert.equal(h1, h2)
  })

  test('a second apply is a no-op because the content already matches', () => {
    const dir = materialize('node-npm')
    const { inputHash, artifact } = stageOnce(dir)
    writeFileSync(join(dir, artifact.path), artifact.content, 'utf8')
    const manifest = inspectStaging(dir).manifest
    assert.ok(manifest !== null)
    const check = checkApplyPreconditions(dir, manifest, inputHash)
    assert.ok(check.ok, check.reason)
  })
})

function hashInputsFrom(dir: string): string {
  const profile = profileIn(dir)
  const report = audit(profile)
  const { playbooks } = loadBuiltins()
  return hashInputs({
    profile: { ...profile, files: undefined, root: undefined },
    report: { score: report.score, findings: report.findings },
    playbookIds: playbooks.map((p) => p.id),
  })
}

function stageOnce(dir: string): {
  inputHash: string
  artifact: GeneratedArtifact
} {
  const profile = profileIn(dir)
  const matches = matchesFor(profile)
  const artifact = generateAgentsFile({ profile, matches })
  const report = audit(profile)
  const { playbooks } = loadBuiltins()
  const inputHash = hashInputs({
    profile: { ...profile, files: undefined, root: undefined },
    report: { score: report.score, findings: report.findings },
    playbookIds: playbooks.map((p) => p.id),
  })
  writeStaging(dir, { inputHash, generator: 'test' }, new Map([[artifact.path, artifact.content]]))
  return { inputHash, artifact }
}

// ===========================================================================
// Staging lifecycle
// ===========================================================================

describe('staging lifecycle', () => {
  test('init writes nothing into the repository', () => {
    const dir = materialize('node-npm')
    const { artifact } = stageOnce(dir)
    assert.equal(existsSync(join(dir, artifact.path)), false, 'staging must not touch the repo')
    assert.ok(existsSync(join(dir, '.anvil', 'staging', 'manifest.json')))
  })

  test('a stale bundle is refused rather than applied', () => {
    const dir = materialize('node-npm')
    const { inputHash } = stageOnce(dir)
    const manifest = inspectStaging(dir).manifest
    assert.ok(manifest !== null)
    const check = checkApplyPreconditions(dir, manifest, 'a-different-hash')
    assert.equal(check.ok, false)
    assert.match(check.reason ?? '', /stale/)
    assert.match(check.hint ?? '', /Re-run/)
    assert.notEqual(inputHash, 'a-different-hash')
  })

  test('applying is refused when a target file changed in the repository', () => {
    const dir = materialize('node-npm')
    const { inputHash } = stageOnce(dir)
    // Someone edits AGENTS.md *after* it was staged: the repo moved under the bundle.
    writeFileSync(join(dir, 'AGENTS.md'), 'hand written by a human\n', 'utf8')
    const manifest = inspectStaging(dir).manifest
    assert.ok(manifest !== null)
    const check = checkApplyPreconditions(dir, manifest, inputHash)
    assert.equal(check.ok, false)
    assert.match(check.reason ?? '', /AGENTS\.md changed in the repository/)
  })

  test('applying is allowed when the target file does not exist yet', () => {
    const dir = materialize('node-npm')
    const { inputHash } = stageOnce(dir)
    const manifest = inspectStaging(dir).manifest
    assert.ok(manifest !== null)
    assert.equal(checkApplyPreconditions(dir, manifest, inputHash).ok, true)
  })

  test('a file that already existed and was reviewed as a diff may be replaced', () => {
    // The bug this pins: the precondition used to compare the repository against the
    // *staged* content, so any repo that already had an AGENTS.md could never be
    // applied to -- the tool refused forever, with a message claiming the file had
    // changed when it never had. Recording the repo-side hash at staging time is what
    // separates "the repo moved" from "the repo always differed".
    const dir = materialize('node-npm')
    writeFileSync(join(dir, 'AGENTS.md'), '# Pre-existing\n\nWeak notes.\n', 'utf8')
    const { inputHash } = stageOnce(dir)
    const manifest = inspectStaging(dir).manifest
    assert.ok(manifest !== null)
    assert.equal(checkApplyPreconditions(dir, manifest, inputHash).ok, true)
  })

  test('a file that appears in the repository after staging is refused', () => {
    // The mirror image of the case above: a file that did not exist when anvil staged,
    // and now does, is the human (or a teammate) racing the apply.
    const dir = materialize('node-npm')
    const { inputHash } = stageOnce(dir)
    writeFileSync(join(dir, 'AGENTS.md'), 'written after init ran\n', 'utf8')
    const manifest = inspectStaging(dir).manifest
    assert.ok(manifest !== null)
    assert.equal(checkApplyPreconditions(dir, manifest, inputHash).ok, false)
  })

  test('a manifest that points outside the repository is ignored entirely', () => {
    // `.anvil/staging/` is a directory inside a repository anvil was told to run in, and
    // the threat model is a repo anvil does not own: a committed manifest whose `path`
    // entries are `../..` would make `--apply` write attacker-chosen bytes outside the
    // repo, creating parent directories as it went. Reading such a manifest must yield
    // nothing, not a bundle.
    const dir = materialize('node-npm')
    const staging = join(dir, '.anvil', 'staging')
    mkdirSync(join(staging, 'files'), { recursive: true })
    const payload = join(staging, 'files', 'payload.md')
    writeFileSync(payload, 'attacker content\n', 'utf8')
    const manifestPath = join(staging, 'manifest.json')
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        inputHash: 'whatever',
        createdAt: new Date().toISOString(),
        generator: 'attacker',
        files: [
          {
            path: '../../escaped.md',
            stagedPath: 'files/payload.md',
            sha256: sha256('attacker content\n'),
            bytes: 17,
            repoSha256: null,
          },
        ],
      }),
      'utf8',
    )

    assert.equal(readManifest(dir), null, 'a traversing manifest must not be usable')
    assert.equal(checkApplyPreconditions(dir, readManifest(dir), 'whatever').ok, false)
  })

  test('a symlinked directory cannot be used to write outside the repository', (t) => {
    // `isSafeRepoRelativePath` stops `..` and absolute paths in the manifest, but a
    // checked-out repository can commit `docs` as a symlink to another directory. The
    // write target is then a valid relative path that still lands outside the repo.
    const dir = materialize('node-npm')
    const outside = mkdtempSync(join(tmpdir(), 'anvil-outside-'))
    temps.push(outside)
    try {
      symlinkSync(outside, join(dir, 'linkdir'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      t.skip(`symlinks are unavailable here: ${String(error)}`)
      return
    }

    const staging = join(dir, '.anvil', 'staging')
    mkdirSync(join(staging, 'files'), { recursive: true })
    const content = 'attacker content\n'
    writeFileSync(join(staging, 'files', 'payload.md'), content, 'utf8')
    const manifest = {
      schemaVersion: 1 as const,
      inputHash: 'whatever',
      createdAt: new Date().toISOString(),
      generator: 'attacker',
      files: [
        {
          path: 'linkdir/escaped.md',
          stagedPath: 'files/payload.md',
          sha256: sha256(content),
          bytes: content.length,
          repoSha256: null,
        },
      ],
    }

    writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest), 'utf8')

    assert.equal(readManifest(dir)?.files.length, 1, 'the manifest itself is well-formed')
    assert.throws(() => applyStaging(dir, manifest), /outside repository/)
    assert.equal(existsSync(join(outside, 'escaped.md')), false, 'nothing may be written outside the repo')
  })

  test('a staged symlink is not read as content', (t) => {
    const dir = materialize('node-npm')
    const outside = mkdtempSync(join(tmpdir(), 'anvil-secret-'))
    temps.push(outside)
    const secret = join(outside, 'secret.txt')
    writeFileSync(secret, 'do not exfiltrate\n', 'utf8')
    stageOnce(dir)
    const staged = join(dir, '.anvil', 'staging', 'files', 'AGENTS.md')
    rmSync(staged)
    try {
      symlinkSync(secret, staged)
    } catch (error) {
      t.skip(`symlinks are unavailable here: ${String(error)}`)
      return
    }

    const state = inspectStaging(dir)
    assert.ok(state.tampered.includes('AGENTS.md'), 'a symlinked staged file is not trusted')
    const manifest = state.manifest
    assert.ok(manifest !== null)
    assert.throws(() => applyStaging(dir, manifest), /disappeared/)
    assert.doesNotMatch(readRepoFile(dir, 'AGENTS.md') ?? '', /do not exfiltrate/)
  })

  test('a symlinked parent directory cannot be used to read outside the repository', (t) => {
    // Prove that the attack path exists before checking the guarded reader. Omitting
    // `files/` here used to test a missing path instead of traversing the actual link.
    const dir = materialize('node-npm')
    const outside = mkdtempSync(join(tmpdir(), 'anvil-secret-parent-'))
    temps.push(outside)
    const secret = join(outside, 'synthetic-secret.txt')
    writeFileSync(secret, 'do not exfiltrate\n', 'utf8')
    stageOnce(dir)
    const stagingFiles = join(dir, '.anvil', 'staging', 'files')
    const linkDir = join(stagingFiles, 'linked-parent')
    try {
      symlinkSync(outside, linkDir, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      t.skip(`symlinks are unavailable here: ${String(error)}`)
      return
    }

    const manifest = inspectStaging(dir).manifest
    assert.ok(manifest !== null)
    const entry = manifest.files.find((f) => f.path === 'AGENTS.md')
    assert.ok(entry !== undefined, 'AGENTS.md is staged')
    // Repoint the entry at a file that only exists through the symlinked parent.
    entry.stagedPath = 'files/linked-parent/synthetic-secret.txt'
    writeFileSync(join(dir, '.anvil', 'staging', 'manifest.json'), JSON.stringify(manifest), 'utf8')
    assert.equal(readFileSync(join(dir, '.anvil', 'staging', entry.stagedPath), 'utf8'), 'do not exfiltrate\n')

    const content = readStaged(dir, entry)
    assert.equal(content, null, 'content reached through a symlinked parent must not be read')
    assert.deepEqual(inspectStaging(dir).tampered, ['AGENTS.md'])
    assert.throws(() => applyStaging(dir, manifest), /disappeared/)
    assert.doesNotMatch(readRepoFile(dir, 'AGENTS.md') ?? '', /do not exfiltrate/)
  })

  for (const linkedDirectory of ['.anvil', '.anvil/staging']) {
    test(`a symlinked ${linkedDirectory} cannot become a trusted staging root`, (t) => {
      const dir = materialize('node-npm')
      stageOnce(dir)
      const manifest = readManifest(dir)
      assert.ok(manifest !== null)
      const entry = manifest.files[0]
      assert.ok(entry !== undefined)

      const outside = mkdtempSync(join(tmpdir(), 'anvil-linked-staging-'))
      temps.push(outside)
      const original = join(dir, ...linkedDirectory.split('/'))
      const relocated = join(outside, 'relocated')
      renameSync(original, relocated)
      try {
        symlinkSync(relocated, original, process.platform === 'win32' ? 'junction' : 'dir')
      } catch (error) {
        t.skip(`symlinks are unavailable here: ${String(error)}`)
        return
      }

      const stagedPath = join(dir, '.anvil', 'staging', entry.stagedPath)
      writeFileSync(stagedPath, 'do not exfiltrate\n', 'utf8')
      assert.equal(readFileSync(stagedPath, 'utf8'), 'do not exfiltrate\n', 'the attack path must exist')
      assert.equal(readManifest(dir), null, 'a manifest behind a staging-root symlink is not trusted')
      assert.equal(readStaged(dir, entry), null, 'the repository, not the linked directory, is the trust root')
      assert.equal(inspectStaging(dir).exists, false)
      assert.throws(() => applyStaging(dir, manifest), /disappeared/)
      assert.equal(readRepoFile(dir, 'AGENTS.md'), null, 'external content must never be copied into the repo')
    })
  }

  test('a missing staging directory is an unreadable staged file, not an exception', () => {
    const dir = materialize('node-npm')
    const manifest = writeStaging(dir, { inputHash: 'test', generator: 'test' }, new Map([['AGENTS.md', '# Agents\n']]))
    const entry = manifest.files[0]
    assert.ok(entry !== undefined)
    rmSync(join(dir, '.anvil', 'staging'), { recursive: true })
    assert.equal(readStaged(dir, entry), null)
    assert.throws(() => applyStaging(dir, manifest), /disappeared/)
  })

  test('a dangling parent link is unreadable without throwing during inspection', (t) => {
    const dir = materialize('node-npm')
    stageOnce(dir)
    const manifest = readManifest(dir)
    assert.ok(manifest !== null)
    const entry = manifest.files[0]
    assert.ok(entry !== undefined)
    const outside = mkdtempSync(join(tmpdir(), 'anvil-dangling-staging-'))
    temps.push(outside)
    const link = join(dir, '.anvil', 'staging', 'files', 'dangling-parent')
    try {
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      t.skip(`symlinks are unavailable here: ${String(error)}`)
      return
    }
    rmSync(outside, { recursive: true })
    entry.stagedPath = 'files/dangling-parent/AGENTS.md'
    writeFileSync(join(dir, '.anvil', 'staging', 'manifest.json'), JSON.stringify(manifest))
    assert.equal(readStaged(dir, entry), null)
    assert.deepEqual(inspectStaging(dir).tampered, ['AGENTS.md'])
    assert.throws(() => applyStaging(dir, manifest), /disappeared/)
  })

  test('a symlinked manifest is ignored rather than read outside the repository', (t) => {
    const dir = materialize('node-npm')
    stageOnce(dir)
    const outside = mkdtempSync(join(tmpdir(), 'anvil-linked-manifest-'))
    temps.push(outside)
    const manifestPath = join(dir, '.anvil', 'staging', 'manifest.json')
    const relocated = join(outside, 'manifest.json')
    renameSync(manifestPath, relocated)
    try {
      symlinkSync(relocated, manifestPath)
    } catch (error) {
      t.skip(`symlinks are unavailable here: ${String(error)}`)
      return
    }
    assert.equal(readManifest(dir), null)
    assert.equal(inspectStaging(dir).exists, false)
  })

  test('a repository reached through a directory alias can still read its own staging', (t) => {
    const dir = materialize('node-npm')
    stageOnce(dir)
    const parent = mkdtempSync(join(tmpdir(), 'anvil-repo-alias-'))
    temps.push(parent)
    const alias = join(parent, 'repo')
    try {
      symlinkSync(dir, alias, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      t.skip(`symlinks are unavailable here: ${String(error)}`)
      return
    }
    const manifest = readManifest(dir)
    assert.ok(manifest !== null)
    const entry = manifest.files[0]
    assert.ok(entry !== undefined)
    assert.deepEqual(readManifest(alias), manifest)
    assert.equal(readStaged(alias, entry), readStaged(dir, entry))
    assert.deepEqual(inspectStaging(alias).tampered, [])
  })

  test('a missing bundle is a clear error, not a crash', () => {
    const dir = materialize('node-npm')
    const check = checkApplyPreconditions(dir, null, 'whatever')
    assert.equal(check.ok, false)
    assert.match(check.reason ?? '', /No staging bundle/)
  })

  test('editing a staged file is reported as tampered but is not an error', () => {
    const dir = materialize('node-npm')
    stageOnce(dir)
    const staged = join(dir, '.anvil', 'staging', 'files', 'AGENTS.md')
    writeFileSync(staged, 'edited by the agent\n', 'utf8')
    const state = inspectStaging(dir)
    assert.deepEqual(state.tampered, ['AGENTS.md'])
  })

  test('an edited staged file is what gets applied', () => {
    // The intended workflow: anvil provides a baseline, the agent improves it, and the
    // agent's version is what lands. Editing staged files is not tampering; it is the
    // design.
    const dir = materialize('node-npm')
    const { inputHash } = stageOnce(dir)
    const staged = join(dir, '.anvil', 'staging', 'files', 'AGENTS.md')
    const improved = `${readFileSync(staged, 'utf8')}\n## Improved by the agent\n\n- extra guidance\n`
    writeFileSync(staged, improved, 'utf8')

    const manifest = inspectStaging(dir).manifest
    assert.ok(manifest !== null)
    const check = checkApplyPreconditions(dir, manifest, inputHash)
    assert.ok(check.ok, `an agent's edits must not block apply: ${check.reason}`)

    const written = applyStaging(dir, manifest)
    assert.deepEqual(written, ['AGENTS.md'])
    const onDisk = readRepoFile(dir, 'AGENTS.md')
    assert.ok(onDisk !== null)
    assert.match(onDisk, /Improved by the agent/, "the agent's version must be what lands")
    assert.match(onDisk, /## Commands/, 'and the verified baseline must survive')
  })

  test('apply validates every staged file before writing any of them', () => {
    // A partial apply is worse than no apply: file 1 on disk with file 2 missing leaves
    // the repo in an unreviewable half-state. applyStaging must read all content and
    // resolve all targets before writing the first byte.
    const dir = materialize('node-npm')
    const manifest = writeStaging(
      dir,
      { inputHash: 'test', generator: 'test' },
      new Map([
        ['AGENTS.md', '# Agents\n'],
        ['src/keep.js', 'export const keep = 1\n'],
      ]),
    )
    assert.ok(manifest !== null)

    // Remove the staged content of the second file after staging.
    rmSync(join(dir, '.anvil', 'staging', 'files', 'src', 'keep.js'))

    assert.throws(() => applyStaging(dir, manifest), /disappeared/)

    // Nothing may have been written: neither the good file nor the missing one.
    assert.equal(readRepoFile(dir, 'AGENTS.md'), null)
    assert.equal(readRepoFile(dir, 'src/keep.js'), null)
  })
})

describe('staging mutation containment', () => {
  for (const linkedDirectory of ['.anvil', '.anvil/staging']) {
    for (const location of ['external', 'internal', 'dangling']) {
      for (const operation of ['write', 'clear']) {
        test(`${operation} refuses ${location} links at ${linkedDirectory} before mutating anything`, (t) => {
          const dir = mkdtempSync(join(tmpdir(), 'anvil-staging-mutation-'))
          const outside = mkdtempSync(join(tmpdir(), 'anvil-staging-external-'))
          temps.push(dir, outside)
          const target = join(location === 'internal' ? dir : outside, 'linked-target')
          const targetStaging = linkedDirectory === '.anvil' ? join(target, 'staging') : target
          mkdirSync(join(targetStaging, 'files'), { recursive: true })
          const sentinel = join(targetStaging, 'sentinel.txt')
          const marker = 'synthetic data that must survive\n'
          writeFileSync(sentinel, marker)
          writeFileSync(join(outside, 'neighbor.txt'), marker)
          const link = join(dir, ...linkedDirectory.split('/'))
          mkdirSync(dirname(link), { recursive: true })
          try {
            symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
          } catch (error) {
            t.skip(`symlinks are unavailable here: ${String(error)}`)
            return
          }
          if (location === 'dangling') rmSync(target, { recursive: true })
          assert.equal(lstatSync(link).isSymbolicLink(), true, 'the attack must use an actual link')
          if (location !== 'dangling') {
            assert.equal(readFileSync(join(dir, '.anvil', 'staging', 'sentinel.txt'), 'utf8'), marker)
          }

          assert.throws(
            () =>
              operation === 'write'
                ? writeStaging(dir, { inputHash: 'test', generator: 'test' }, new Map([['AGENTS.md', '# Agents\n']]))
                : clearStaging(dir),
            { code: 'PREFLIGHT_FAILED' },
          )
          assert.equal(lstatSync(link).isSymbolicLink(), true, 'refusal must leave the link untouched')
          assert.equal(readFileSync(join(outside, 'neighbor.txt'), 'utf8'), marker)
          if (location === 'dangling') {
            assert.equal(existsSync(target), false, 'a dangling target must not be created')
          } else {
            assert.equal(readFileSync(sentinel, 'utf8'), marker, 'existing target data must not be removed')
            assert.deepEqual(readdirSync(targetStaging).sort(), ['files', 'sentinel.txt'])
            assert.deepEqual(readdirSync(join(targetStaging, 'files')), [], 'no artifacts may be written to the target')
          }
        })
      }
    }
  }

  for (const blockedDirectory of ['.anvil', '.anvil/staging']) {
    for (const operation of ['write', 'clear']) {
      test(`${operation} refuses a non-directory at ${blockedDirectory} without deleting it`, () => {
        const dir = mkdtempSync(join(tmpdir(), 'anvil-staging-file-'))
        temps.push(dir)
        const blocked = join(dir, ...blockedDirectory.split('/'))
        mkdirSync(dirname(blocked), { recursive: true })
        writeFileSync(blocked, 'preserve this file\n')
        assert.throws(
          () =>
            operation === 'write'
              ? writeStaging(dir, { inputHash: 'test', generator: 'test' }, new Map([['AGENTS.md', '# Agents\n']]))
              : clearStaging(dir),
          { code: 'PREFLIGHT_FAILED' },
        )
        assert.equal(readFileSync(blocked, 'utf8'), 'preserve this file\n')
      })
    }
  }

  test('normal creation, replacement and idempotent cleanup still work with missing directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-staging-normal-'))
    temps.push(dir)
    clearStaging(dir)
    assert.equal(existsSync(join(dir, '.anvil')), false, 'cleanup must not create missing directories')
    writeStaging(dir, { inputHash: 'first', generator: 'test' }, new Map([['AGENTS.md', '# First\n']]))
    writeStaging(dir, { inputHash: 'second', generator: 'test' }, new Map([['AGENTS.md', '# Second\n']]))
    assert.equal(readManifest(dir)?.inputHash, 'second')
    assert.equal(readFileSync(join(dir, '.anvil', 'staging', 'files', 'AGENTS.md'), 'utf8'), '# Second\n')
    clearStaging(dir)
    clearStaging(dir)
    assert.equal(existsSync(join(dir, '.anvil', 'staging')), false)
  })

  for (const operation of ['write', 'clear']) {
    test(`${operation} removes links inside a real staging directory without following their targets`, (t) => {
      const dir = mkdtempSync(join(tmpdir(), 'anvil-staging-child-link-'))
      const outside = mkdtempSync(join(tmpdir(), 'anvil-staging-child-target-'))
      temps.push(dir, outside)
      writeStaging(dir, { inputHash: 'first', generator: 'test' }, new Map([['AGENTS.md', '# Agents\n']]))
      const marker = 'external target must survive\n'
      writeFileSync(join(outside, 'sentinel.txt'), marker)
      const link = join(dir, '.anvil', 'staging', 'files', 'linked-child')
      try {
        symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
      } catch (error) {
        t.skip(`symlinks are unavailable here: ${String(error)}`)
        return
      }
      assert.equal(readFileSync(join(link, 'sentinel.txt'), 'utf8'), marker)
      if (operation === 'write') {
        writeStaging(dir, { inputHash: 'second', generator: 'test' }, new Map([['AGENTS.md', '# Updated\n']]))
      } else {
        clearStaging(dir)
      }
      assert.equal(existsSync(link), false)
      assert.equal(readFileSync(join(outside, 'sentinel.txt'), 'utf8'), marker)
      assert.deepEqual(readdirSync(outside), ['sentinel.txt'])
    })
  }

  test('a repository directory alias supports staging creation and cleanup', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-staging-alias-target-'))
    const parent = mkdtempSync(join(tmpdir(), 'anvil-staging-alias-'))
    temps.push(dir, parent)
    const alias = join(parent, 'repo')
    try {
      symlinkSync(dir, alias, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      t.skip(`symlinks are unavailable here: ${String(error)}`)
      return
    }
    writeStaging(alias, { inputHash: 'alias', generator: 'test' }, new Map([['AGENTS.md', '# Agents\n']]))
    assert.equal(readManifest(dir)?.inputHash, 'alias')
    clearStaging(alias)
    assert.equal(existsSync(join(dir, '.anvil', 'staging')), false)
    assert.equal(lstatSync(alias).isSymbolicLink(), true, 'the caller alias itself remains supported')
  })
})

// ===========================================================================
// The validator: the actual product feature
// ===========================================================================

describe('artifact validation', () => {
  test('accepts a well-formed agent', () => {
    const v = validateArtifact(
      '.opencode/agents/reviewer.md',
      '---\ndescription: Reviews code\nmode: subagent\n---\n\nYou review code carefully.\n',
    )
    assert.ok(v.ok, v.errors.join('; '))
  })

  test('rejects an agent with no description, which opencode requires', () => {
    const v = validateArtifact('.opencode/agents/x.md', '---\nmode: subagent\n---\n\nbody\n')
    assert.equal(v.ok, false)
    assert.ok(v.errors.some((e) => e.includes('description')))
  })

  test('rejects an invalid agent mode', () => {
    const v = validateArtifact('.opencode/agents/x.md', '---\ndescription: d\nmode: bogus\n---\n\nbody\n')
    assert.ok(v.errors.some((e) => e.includes('mode')))
  })

  test('rejects an unterminated frontmatter block', () => {
    const v = validateArtifact('.opencode/agents/x.md', '---\ndescription: d\nbody without closing\n')
    assert.ok(v.errors.some((e) => e.includes('not closed')))
  })

  test('rejects a command with no body', () => {
    const v = validateArtifact('.opencode/commands/x.md', '---\ndescription: d\n---\n')
    assert.ok(v.errors.some((e) => e.includes('no template body')))
  })

  test('accepts a valid skill', () => {
    const v = validateArtifact(
      '.agents/skills/verify-change/SKILL.md',
      '---\nname: verify-change\ndescription: Run the test suite before claiming done.\n---\n\n# Verify\n\nSteps.\n',
    )
    assert.ok(v.ok, v.errors.join('; '))
  })

  test('rejects a skill name that does not match the required pattern', () => {
    const v = validateArtifact(
      '.agents/skills/Verify_Change/SKILL.md',
      '---\nname: Verify_Change\ndescription: d\n---\n\nbody\n',
    )
    assert.ok(v.errors.some((e) => e.includes('must match')))
  })

  test('rejects a skill whose name does not match its directory', () => {
    // This is the failure opencode hides: the skill simply never appears.
    const v = validateArtifact(
      '.agents/skills/verify-change/SKILL.md',
      '---\nname: verify-something-else\ndescription: d\n---\n\nbody\n',
    )
    assert.ok(v.errors.some((e) => e.includes('must equal the containing directory')))
  })

  test('rejects a skill with no description', () => {
    const v = validateArtifact('.agents/skills/thing/SKILL.md', '---\nname: thing\n---\n\nbody\n')
    assert.ok(v.errors.some((e) => e.includes('description')))
  })

  test('rejects an over-long skill description', () => {
    const v = validateArtifact(
      '.agents/skills/thing/SKILL.md',
      `---\nname: thing\ndescription: ${'x'.repeat(1100)}\n---\n\nbody\n`,
    )
    assert.ok(v.errors.some((e) => e.includes('1024')))
  })

  test('warns that an empty AGENTS.md is worse than none', () => {
    const v = validateArtifact('AGENTS.md', '')
    assert.equal(v.ok, false)
  })

  test('warns when AGENTS.md uses @file references without saying to read them', () => {
    const v = validateArtifact('AGENTS.md', 'See @docs/style.md for conventions.\n')
    assert.ok(v.warnings.some((w) => w.includes('@file')))
  })

  test('does not warn when AGENTS.md instructs reading the references', () => {
    const v = validateArtifact('AGENTS.md', 'Use your Read tool to load @docs/style.md when relevant.\n')
    assert.equal(v.warnings.length, 0)
  })

  test('warns when AGENTS.md is over the instruction budget', () => {
    // The same threshold the audit rule fails on, so a file `anvil doctor` rejects cannot
    // be written by `anvil init --apply` without the writer being told why.
    const v = validateArtifact('AGENTS.md', 'x'.repeat(41_000))
    assert.ok(
      v.warnings.some((w) => w.includes('tokens') && w.includes('skill')),
      `expected a budget warning, got ${JSON.stringify(v.warnings)}`,
    )
  })

  test('measures the budget in bytes, so non-ASCII guidance gets the same verdict', () => {
    // 20_500 `é` characters are 41_000 bytes: under the limit by character count, over it
    // on disk, which is the number the audit sees.
    const v = validateArtifact('AGENTS.md', 'é'.repeat(20_500))
    assert.ok(
      v.warnings.some((w) => w.includes('tokens') && w.includes('skill')),
      `expected a budget warning, got ${JSON.stringify(v.warnings)}`,
    )
  })

  test('does not warn about an AGENTS.md inside the budget', () => {
    const v = validateArtifact('AGENTS.md', 'x'.repeat(4_000))
    assert.equal(v.warnings.length, 0)
  })

  test('classifies each artifact kind by path', () => {
    for (const [path, kind] of [
      ['.opencode/agents/a.md', 'agent'],
      ['.opencode/commands/c.md', 'command'],
      ['.agents/skills/s/SKILL.md', 'skill'],
      ['AGENTS.md', 'agents-file'],
    ] as const) {
      const v = validateArtifact(path, '---\nname: s\ndescription: d\n---\n\nbody\n')
      assert.equal(v.kind, kind, path)
    }
  })

  test('an unrecognized path is an error, not a silent pass', () => {
    const v = validateArtifact('random/file.txt', 'hello')
    assert.equal(v.ok, false)
  })
})

describe('generated artifacts are valid', () => {
  for (const fixture of ['node-npm', 'python-django', 'go-module', 'jvm-gradle', 'node-workspace', 'dotnet-sln']) {
    test(`${fixture}: every generated artifact validates`, () => {
      const dir = materialize(fixture)
      const profile = profileIn(dir)
      const matches = matchesFor(profile)
      const artifacts: GeneratedArtifact[] = [generateAgentsFile({ profile, matches })]
      const skill = generateVerifySkill({ profile, matches })
      if (skill !== null) artifacts.push(skill)
      const command = generateReviewCommand({ profile, matches })
      if (command !== null) artifacts.push(command)

      const summary = validateAll(artifacts)
      assert.ok(summary.ok, `${fixture}: ${summary.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`)
    })
  }
})

describe('generated AGENTS.md contains only verifiable claims', () => {
  test('never states a command the profile did not detect', () => {
    const dir = materialize('go-module')
    const profile = profileIn(dir)
    const artifact = generateAgentsFile({
      profile,
      matches: matchesFor(profile),
    })
    const backticked = [...artifact.content.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string)
    const known = new Set(
      Object.values(profile.commands)
        .flat()
        .map((c) => c.cmd),
    )
    const knownGlobish = /^[a-z][\w./-]*$/ // not a command: a path, glob, or identifier
    for (const token of backticked) {
      if (knownGlobish.test(token)) continue
      if (known.has(token)) continue
      // Anything command-shaped must have come from the profile.
      if (/^(go|cargo|npm|pnpm|yarn|bun|make|pytest|dotnet|gradlew?|mvnw?|ruff|mypy|tsc|eslint)\b/.test(token)) {
        assert.ok(known.has(token), `AGENTS.md mentions "${token}" which the profile did not detect`)
      }
    }
  })

  test('labels inferred commands as inferred', () => {
    const dir = materialize('rust-crate')
    const profile = profileIn(dir)
    const artifact = generateAgentsFile({
      profile,
      matches: matchesFor(profile),
    })
    assert.match(artifact.content, /\(inferred\)/)
    assert.match(artifact.content, /inferred from ecosystem convention/)
  })

  test('includes the module map for a monorepo', () => {
    const dir = materialize('node-workspace')
    const profile = profileIn(dir)
    const artifact = generateAgentsFile({
      profile,
      matches: matchesFor(profile),
    })
    assert.match(artifact.content, /## Layout/)
    assert.match(artifact.content, /@acme\/core/)
  })

  test('lists high-risk paths when they exist', () => {
    const dir = materialize('python-django')
    const profile = profileIn(dir)
    const artifact = generateAgentsFile({
      profile,
      matches: matchesFor(profile),
    })
    assert.match(artifact.content, /## High-risk paths/)
    assert.match(artifact.content, /migrations/)
  })

  test('omits sections it has no evidence for', () => {
    const dir = materialize('cold-empty')
    const profile = profileIn(dir)
    const artifact = generateAgentsFile({
      profile,
      matches: matchesFor(profile),
    })
    assert.doesNotMatch(artifact.content, /## Commands/)
    assert.doesNotMatch(artifact.content, /## Layout/)
  })
})

describe('brief', () => {
  test('carries the verified commands with evidence', () => {
    const dir = materialize('node-npm')
    const profile = profileIn(dir)
    const brief = buildBrief({
      profile,
      report: audit(profile),
      matches: matchesFor(profile),
      target: 'agents',
      read: (p) => readRepoFile(dir, p),
    })
    const test0 = brief.commands.find((c) => c.kind === 'test')
    assert.ok(test0)
    assert.ok(test0.evidence !== null)
    assert.match(test0.evidence, /package\.json:\d+/)
  })

  test('lists the gaps so a model cannot contradict the repository', () => {
    const dir = materialize('cold-empty')
    const profile = profileIn(dir)
    const brief = buildBrief({
      profile,
      report: audit(profile),
      matches: matchesFor(profile),
      target: 'agents',
      read: () => null,
    })
    assert.ok(brief.gaps.length > 0)
    assert.ok(brief.gaps.some((g) => g.includes('AGENTS')))
  })

  test('never includes a secret-shaped file in the excerpts', () => {
    const dir = materialize('node-npm')
    writeFileSync(join(dir, '.env'), 'SECRET_TOKEN=abc123\n', 'utf8')
    const profile = profileIn(dir)
    const brief = buildBrief({
      profile,
      report: audit(profile),
      matches: matchesFor(profile),
      target: 'all',
      read: (p) => readRepoFile(dir, p),
    })
    assert.ok(!brief.excerpts.some((e) => e.path.includes('.env')))
    const serialized = JSON.stringify(brief)
    assert.ok(!serialized.includes('abc123'), 'a secret value must never reach the brief')
  })

  test('includes the matched playbook guidance', () => {
    const dir = materialize('node-npm')
    const profile = profileIn(dir)
    const brief = buildBrief({
      profile,
      report: audit(profile),
      matches: matchesFor(profile),
      target: 'all',
      read: () => null,
    })
    assert.ok(brief.playbooks.some((p) => p.id === 'node'))
    assert.ok(brief.playbooks[0]!.guidance.length > 0)
  })

  test('a locally installed skill is cited by path, not dropped for having no url', () => {
    // A local-scan skill has an empty url: dropping it for that hid the one source that
    // works with no network. Its SKILL.md path is the citation instead.
    const dir = materialize('node-npm')
    const profile = profileIn(dir)
    const brief = buildBrief({
      profile,
      report: audit(profile),
      matches: matchesFor(profile),
      target: 'all',
      read: () => null,
      live: new Map([
        [
          'node',
          [
            {
              label: 'node-review',
              url: '',
              why: 'Installed on this machine at ~/.agents/skills/node-review/SKILL.md.',
              section: 'skills',
              trust: 'local-install',
              install: '~/.agents/skills/node-review/SKILL.md',
              source: 'local-scan',
            },
          ],
        ],
      ]),
    })

    const live = brief.playbooks.flatMap((p) => p.guidance).filter((g) => g.provenance === 'live')
    assert.equal(live.length, 1)
    assert.equal(live[0]?.label, 'node-review')
    assert.equal(live[0]?.install, '~/.agents/skills/node-review/SKILL.md')
  })

  test('carries warnings through, so a dropped cache is not silent', () => {
    const dir = materialize('node-npm')
    const profile = profileIn(dir)
    const brief = buildBrief({
      profile,
      report: audit(profile),
      matches: matchesFor(profile),
      target: 'agents',
      read: () => null,
      warnings: ['discovery cache for node is stale; its entries were ignored'],
    })
    assert.deepEqual(brief.warnings, ['discovery cache for node is stale; its entries were ignored'])
  })
})
