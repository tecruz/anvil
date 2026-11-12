import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { EvalSkillSpec } from '../../packages/cli/src/eval-gate.ts'
import { installScenarioSkill } from '../eval.ts'

const source = fileURLToPath(new URL('../../', import.meta.url))
const cli = join(source, 'packages', 'cli', 'src', 'main.ts')
const skill: EvalSkillSpec = { source: 'eval/skills/skill-guidance/SKILL.md', name: 'release-notes' }
const temps: string[] = []

after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
}

/** A fresh copy of the fixture, committed, exactly as `prepareRepo` leaves it. */
function fixture(): string {
  const workdir = mkdtempSync(join(tmpdir(), 'anvil-eval-skill-install-'))
  temps.push(workdir)
  cpSync(join(source, 'eval/repos/skill-guidance'), workdir, { recursive: true })
  git(workdir, 'init', '--initial-branch=main')
  git(workdir, 'add', '-A')
  git(workdir, '-c', 'user.email=eval@anvil.local', '-c', 'user.name=anvil eval', 'commit', '-m', 'initial')
  return workdir
}

describe('installing a scenario skill through the approved apply path', () => {
  test('the fixture does not contain the skill source, so neither variant can read it', () => {
    assert.equal(existsSync(join(source, 'eval/repos/skill-guidance/.anvil-eval-skill-source.md')), false)
    assert.equal(existsSync(join(source, 'eval/repos/skill-guidance/.agents')), false)
  })

  test('installs and verifies the skill, then leaves only the committed artifact', async () => {
    const workdir = fixture()
    const result = await installScenarioSkill(skill, workdir, cli)
    assert.equal(result.ok, true, result.reason)

    const installed = join(workdir, '.agents', 'skills', 'release-notes', 'SKILL.md')
    const content = readFileSync(installed, 'utf8')
    assert.match(content, /^---\nname: release-notes\n/m)
    assert.match(content, /release-line contract in `README\.md`/)
    assert.equal(
      existsSync(join(workdir, '.anvil-eval-skill-source.md')),
      false,
      'the staged source must not remain next to the installed artifact',
    )
    assert.equal(git(workdir, 'status', '--porcelain').trim(), '', 'the harness leaves a clean worktree')
    assert.match(git(workdir, 'log', '--oneline', '-1'), /install the skill/)

    // The staging commit is amended away, so the skill text is not recoverable from the
    // worktree's history; only the installed artifact the comparison is about remains.
    assert.doesNotMatch(git(workdir, 'log', '--all', '--name-only', '--pretty=format:'), /anvil-eval-skill-source/)

    // The installed bytes are part of the commit, so an agent that runs `git status` is not
    // looking at an uncommitted file the harness left behind.
    assert.match(git(workdir, 'ls-files'), /\.agents\/skills\/release-notes\/SKILL\.md/)
  })

  test('a second install is refused, because the destination is create-only', async () => {
    const workdir = fixture()
    const first = await installScenarioSkill(skill, workdir, cli)
    assert.equal(first.ok, true, first.reason)

    const second = await installScenarioSkill(skill, workdir, cli)
    assert.equal(second.ok, false)
    assert.match(second.reason, /already exists/)
    assert.equal(
      readFileSync(join(workdir, '.agents', 'skills', 'release-notes', 'SKILL.md'), 'utf8'),
      readFileSync(join(source, 'eval/skills/skill-guidance/SKILL.md'), 'utf8'),
      'the refused attempt did not rewrite the installed bytes',
    )
  })

  test('a missing source is reported, not thrown into the harness', async () => {
    const workdir = fixture()
    const result = await installScenarioSkill(
      { source: 'eval/skills/missing/SKILL.md', name: 'release-notes' },
      workdir,
      cli,
    )
    assert.equal(result.ok, false)
    assert.match(result.reason, /could not be read/)
    assert.equal(existsSync(join(workdir, '.agents')), false)
  })

  test('both variants see the contract, and the skill carries the procedure', () => {
    // Fairness guard: the required behaviour must be visible to both variants, or the
    // comparison measures missing information instead of skill-guided work.
    const readme = readFileSync(join(source, 'eval/repos/skill-guidance/README.md'), 'utf8')
    assert.match(readme, /v<version>/)
    assert.match(readme, /\(pre-release\)/)
    assert.match(readme, /TypeError/)

    // The skill must not be an answer sheet: it describes the procedure, and the exact
    // contract stays in the repository both variants can read.
    const skillText = readFileSync(join(source, 'eval/skills/skill-guidance/SKILL.md'), 'utf8')
    assert.match(skillText, /README\.md/)
    assert.match(skillText, /npm test/)
    assert.doesNotMatch(skillText, /v<version>|\(pre-release\)/)
  })
})
