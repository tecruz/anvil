import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { AnvilError } from '@anvil/core'
import {
  buildSetupExecutionPlan,
  extractSetupExecutionRequest,
  isSafeSetupExecutionPath,
  LOCAL_SKILL_ADAPTER,
  MAX_SOURCE_BYTES,
  SetupExecutionError,
  type SetupRepositoryState,
  validateSetupExecutionPlan,
} from '@anvil/derive'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'anvil-execution-'))
  roots.push(root)
  return root
}
function repository(root: string, overrides: Partial<SetupRepositoryState> = {}): SetupRepositoryState {
  return { root, head: 'a'.repeat(40), worktree: 'clean', ...overrides }
}
function skill(name = 'my-skill', body = 'Do the thing.\n'): string {
  return `---\nname: ${name}\ndescription: A test skill for ${name}.\n---\n\n# ${name}\n\n${body}`
}
function write(root: string, path: string, content: string | Buffer): void {
  const target = join(root, ...path.split('/'))
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, content)
}
function plan(root: string, sourcePath = 'skill.md', name = 'my-skill') {
  return buildSetupExecutionPlan({ repository: repository(root), sourcePath, name })
}

/** Test-side canonicalization, also used to model an attacker recomputing a digest. */
function recanonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(recanonicalize)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [key, recanonicalize(entry)]),
  )
}
function rehash(value: object): Record<string, unknown> {
  const { digest: _digest, ...payload } = value as Record<string, unknown>
  return {
    ...payload,
    digest: createHash('sha256')
      .update(JSON.stringify(recanonicalize(payload)))
      .digest('hex'),
  }
}

describe('setup execution plans', () => {
  test('a valid local skill produces a deterministic, inspect-only plan and exact content', () => {
    const root = scratch()
    const content = skill()
    write(root, 'skills/source.md', content)
    const first = plan(root, 'skills/source.md')
    const second = plan(root, 'skills/source.md')
    assert.deepEqual(first, second)
    assert.match(first.digest, /^[a-f0-9]{64}$/)
    assert.equal(first.kind, 'setup-execution-plan')
    assert.equal(first.adapter, LOCAL_SKILL_ADAPTER)
    assert.equal(first.status, 'proposed')
    assert.equal(first.executed, false)
    assert.equal(first.approval, 'not-granted')
    assert.equal(first.executionSupported, false)
    assert.equal(first.skill.name, 'my-skill')
    assert.equal(first.skill.destination, '.agents/skills/my-skill/SKILL.md')
    assert.equal(first.source.path, 'skills/source.md')
    assert.equal(first.source.content, content)
    assert.equal(first.source.bytes, Buffer.byteLength(content))
    assert.equal(first.source.sha256, createHash('sha256').update(content).digest('hex'))
    assert.deepEqual(
      first.operations.map((operation) => [operation.kind, operation.path, operation.precondition]),
      [
        ['ensure-directory', '.agents', 'absent-or-real-directory'],
        ['ensure-directory', '.agents/skills', 'absent-or-real-directory'],
        ['create-directory', '.agents/skills/my-skill', 'absent'],
        ['write-file', '.agents/skills/my-skill/SKILL.md', 'absent'],
      ],
    )
    const writeOperation = first.operations[3]
    assert.equal(writeOperation?.kind, 'write-file')
    if (writeOperation?.kind === 'write-file') {
      assert.equal(writeOperation.overwrite, false)
      assert.equal(writeOperation.publish, 'temp-file-no-replace')
      assert.equal(writeOperation.source, 'skills/source.md')
      assert.equal(writeOperation.sha256, first.source.sha256)
    }
    assert.deepEqual(first.effects, {
      kind: 'filesystem-only',
      directories: ['.agents', '.agents/skills', '.agents/skills/my-skill'],
      files: [
        {
          path: '.agents/skills/my-skill/SKILL.md',
          sha256: first.source.sha256,
          bytes: first.source.bytes,
        },
      ],
      overwrite: false,
      delete: false,
      processes: false,
      network: false,
      credentials: false,
    })
    assert.equal(first.verification.id, 'local-skill-installed/v1')
    assert.match(first.verification.proves, /does not prove that an agent loaded/)
    assert.match(first.warnings.join('\n'), /Inspection only/)
    assert.match(first.warnings.join('\n'), /create-only|No downloads/)
    // Plan and validation never create the destination.
    assert.equal(validateSetupExecutionPlan(JSON.parse(JSON.stringify(first)), second).status, 'current')
    assert.equal(
      validateSetupExecutionPlan(Object.fromEntries(Object.entries(first).reverse()), second).status,
      'current',
    )
    assert.equal(extractSetupExecutionRequest(first).sourcePath, 'skills/source.md')
    assert.equal(extractSetupExecutionRequest(first).name, 'my-skill')
    assert.equal(existsSync(join(root, '.agents')), false)
  })

  test('changing source bytes, name, repository state or adapter behaviour makes a saved plan stale', () => {
    const root = scratch()
    write(root, 'skill.md', skill())
    const saved = plan(root)
    assert.equal(validateSetupExecutionPlan(saved, plan(root)).status, 'current')

    write(root, 'skill.md', skill('my-skill', 'A different body.\n'))
    assert.equal(validateSetupExecutionPlan(saved, plan(root)).status, 'stale')

    write(root, 'skill.md', skill('other-skill'))
    assert.equal(validateSetupExecutionPlan(saved, plan(root, 'skill.md', 'other-skill')).status, 'stale')

    write(root, 'skill.md', skill())
    assert.equal(validateSetupExecutionPlan(saved, plan(root)).status, 'current')

    assert.equal(
      validateSetupExecutionPlan(
        saved,
        buildSetupExecutionPlan({
          repository: repository(root, { head: 'b'.repeat(40) }),
          sourcePath: 'skill.md',
          name: 'my-skill',
        }),
      ).status,
      'stale',
    )

    const secondRoot = scratch()
    write(secondRoot, 'skill.md', skill())
    assert.equal(
      validateSetupExecutionPlan(
        saved,
        buildSetupExecutionPlan({
          repository: repository(secondRoot),
          sourcePath: 'skill.md',
          name: 'my-skill',
        }),
      ).status,
      'stale',
    )

    const changedAdapter = rehash({ ...saved, adapterFingerprint: 'changed' })
    assert.equal(validateSetupExecutionPlan(changedAdapter, plan(root)).status, 'stale')
  })

  test('tampering without a digest, forged fields and recomputed digests never validate as current', () => {
    const root = scratch()
    write(root, 'skill.md', skill())
    const saved = plan(root)
    const tampered = structuredClone(saved)
    tampered.operations[0]!.path = 'elsewhere'
    assert.equal(validateSetupExecutionPlan(tampered, saved).status, 'invalid')
    assert.equal(validateSetupExecutionPlan(rehash(tampered), saved).status, 'stale')
    for (const forged of [
      rehash({ ...saved, approved: true }),
      rehash({ ...saved, approval: 'granted' }),
      rehash({ ...saved, executed: true }),
      rehash({ ...saved, executionSupported: true }),
    ]) {
      const validation = validateSetupExecutionPlan(forged, saved)
      assert.notEqual(validation.status, 'current')
      assert.equal(validation.approval, 'not-granted')
      assert.equal(validation.executed, false)
    }
    for (const invalid of [
      null,
      [],
      { data: saved },
      { ...saved, schemaVersion: 2 },
      { ...saved, digest: 'wrong' },
      { ...saved, extra: undefined },
    ]) {
      assert.equal(validateSetupExecutionPlan(invalid, saved).status, 'invalid')
    }
    let deep: unknown = null
    for (let i = 0; i < 55; i++) deep = [deep]
    assert.equal(validateSetupExecutionPlan({ ...saved, extra: deep }, saved).status, 'invalid')
  })

  test('dirty, missing-HEAD and unknown repository state never validate as current', () => {
    const root = scratch()
    write(root, 'skill.md', skill())
    for (const state of [
      repository(root, { worktree: 'dirty' }),
      repository(root, { worktree: 'unknown' }),
      repository(root, { head: null }),
    ]) {
      const current = buildSetupExecutionPlan({ repository: state, sourcePath: 'skill.md', name: 'my-skill' })
      assert.equal(validateSetupExecutionPlan(current, current).status, 'unknown')
      assert.match(current.warnings.join('\n'), /not a clean commit/)
    }
  })

  test('source paths are strict, repository-relative and never inside .git', () => {
    for (const unsafe of [
      '',
      '/absolute.md',
      '\\absolute.md',
      'C:skill.md',
      'C:\\skill.md',
      '../outside.md',
      'dir/../../outside.md',
      'dir//skill.md',
      './skill.md',
      'dir/./skill.md',
      'dir\\skill.md',
      'bad\0path.md',
      '.git/config',
      'dir/.git/config',
      '.git./config',
      '.git /config',
      'dir/.GIT./config',
      '.. /outside.md',
      'dir/.. /outside.md',
      'dir/',
    ]) {
      assert.equal(isSafeSetupExecutionPath(unsafe), false, unsafe)
    }
    for (const safe of ['skill.md', 'docs/skills/a.md', ' skill.md ', 'dir with space/ skill.md ', '.gitignore']) {
      assert.equal(isSafeSetupExecutionPath(safe), true, safe)
    }
    const root = scratch()
    write(root, 'skill.md', skill())
    for (const unsafe of ['../outside.md', '/tmp/skill.md', 'C:\\skill.md', '.git/config']) {
      assert.throws(() => plan(root, unsafe), AnvilError)
    }
  })

  test('missing, non-regular, oversized and non-UTF-8 sources are refused', () => {
    const root = scratch()
    const cases: Array<[string, string | Buffer, SetupExecutionError['validationStatus']]> = [
      ['missing.md', 'not written', 'stale'],
      ['invalid.md', Buffer.from([0xff, 0xfe, 0xfd]), 'stale'],
    ]
    for (const [path, content, status] of cases) {
      if (content !== 'not written') write(root, path, content)
      assert.throws(
        () => plan(root, path),
        (error: unknown) => error instanceof SetupExecutionError && error.validationStatus === status,
        path,
      )
    }
    mkdirSync(join(root, 'directory.md'))
    assert.throws(
      () => plan(root, 'directory.md'),
      (error: unknown) => error instanceof SetupExecutionError && error.validationStatus === 'stale',
    )
    write(root, 'large.md', 'a'.repeat(MAX_SOURCE_BYTES + 1))
    assert.throws(
      () => plan(root, 'large.md'),
      (error: unknown) => error instanceof SetupExecutionError && error.validationStatus === 'stale',
    )
  })

  test('a source that is a file symlink is refused', (t) => {
    const root = scratch()
    const outside = scratch()
    write(outside, 'skill.md', skill())
    try {
      symlinkSync(join(outside, 'skill.md'), join(root, 'linked.md'))
    } catch {
      t.skip('file symlinks are unavailable here')
      return
    }
    assert.throws(
      () => plan(root, 'linked.md'),
      (error: unknown) => error instanceof SetupExecutionError && error.validationStatus === 'unknown',
    )
  })

  test('a source path through a directory symlink or junction is refused', (t) => {
    const root = scratch()
    const target = join(root, 'real-skills')
    mkdirSync(target)
    write(root, 'real-skills/skill.md', skill())
    try {
      symlinkSync(target, join(root, 'linked-skills'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      t.skip('directory links are unavailable here')
      return
    }
    assert.throws(
      () => plan(root, 'linked-skills/skill.md'),
      (error: unknown) => error instanceof SetupExecutionError && error.validationStatus === 'unknown',
    )
  })

  test('invalid skill metadata is refused rather than planned', () => {
    const root = scratch()
    const cases: Array<[string, string]> = [
      ['no-frontmatter.md', '# Just a body\n'],
      ['missing-name.md', '---\ndescription: Desc.\n---\n\nBody\n'],
      ['mismatch.md', skill('different-name')],
      ['no-description.md', '---\nname: my-skill\n---\n\nBody\n'],
      ['empty-body.md', '---\nname: my-skill\ndescription: Desc.\n---\n\n'],
      ['long-description.md', `---\nname: my-skill\ndescription: ${'x'.repeat(1025)}\n---\n\nBody\n`],
    ]
    for (const [path, content] of cases) {
      write(root, path, content)
      assert.throws(
        () => plan(root, path),
        (error: unknown) => error instanceof SetupExecutionError && error.validationStatus === 'stale',
        path,
      )
    }
    write(root, 'valid.md', skill())
    for (const name of ['', 'Uppercase', 'under_score', 'double--hyphen', '../escape', 'with space']) {
      assert.throws(() => plan(root, 'valid.md', name), AnvilError, name)
    }
  })

  test('an existing destination or an unsafe destination parent is never overwritten or followed', (t) => {
    const root = scratch()
    write(root, 'skill.md', skill())
    mkdirSync(join(root, '.agents', 'skills', 'my-skill'), { recursive: true })
    assert.throws(
      () => plan(root),
      (error: unknown) => error instanceof SetupExecutionError && error.validationStatus === 'stale',
    )
    rmSync(join(root, '.agents'), { recursive: true, force: true })
    write(root, '.agents', 'a file blocks the parent')
    assert.throws(
      () => plan(root),
      (error: unknown) => error instanceof SetupExecutionError && error.validationStatus === 'stale',
    )
    rmSync(join(root, '.agents'))
    mkdirSync(join(root, '.agents'))
    write(root, '.agents/skills', 'a file blocks the skills directory')
    assert.throws(
      () => plan(root),
      (error: unknown) => error instanceof SetupExecutionError && error.validationStatus === 'stale',
    )
    rmSync(join(root, '.agents'), { recursive: true, force: true })

    const outside = scratch()
    mkdirSync(join(outside, 'skills'))
    try {
      symlinkSync(join(outside, 'skills'), join(root, '.agents'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      t.skip('directory links are unavailable here')
      return
    }
    assert.throws(
      () => plan(root),
      (error: unknown) => error instanceof SetupExecutionError && error.validationStatus === 'unknown',
    )
    // `recursive` removes the junction itself; the directory it points at is untouched.
    rmSync(join(root, '.agents'), { recursive: true, force: true })
    assert.equal(readdirSync(join(outside, 'skills')).length, 0)
    try {
      mkdirSync(join(root, '.agents'))
      symlinkSync(
        join(outside, 'skills'),
        join(root, '.agents', 'skills'),
        process.platform === 'win32' ? 'junction' : 'dir',
      )
    } catch {
      t.skip('directory links are unavailable here')
      return
    }
    assert.throws(
      () => plan(root),
      (error: unknown) => error instanceof SetupExecutionError && error.validationStatus === 'unknown',
    )
  })

  test('unrelated existing skills are allowed; only the requested directory must be absent', () => {
    const root = scratch()
    write(root, 'skill.md', skill())
    mkdirSync(join(root, '.agents', 'skills', 'already-there'), { recursive: true })
    const result = plan(root)
    assert.equal(result.skill.destination, '.agents/skills/my-skill/SKILL.md')
    assert.throws(
      () => buildSetupExecutionPlan({ repository: repository(root), sourcePath: 'skill.md', name: 'already-there' }),
      SetupExecutionError,
    )
  })

  test('exact source bytes and whitespace-bearing filenames survive into the plan', () => {
    const root = scratch()
    const content = `\ufeff${skill().replace(/\n/g, '\r\n')}`
    write(root, 'dir with space/ skill.md ', content)
    const result = plan(root, 'dir with space/ skill.md ')
    assert.equal(result.source.content, content)
    assert.equal(result.source.content.charCodeAt(0), 0xfeff)
    assert.match(result.source.content, /\r\n/)
    assert.equal(result.source.bytes, Buffer.byteLength(content))
    assert.equal(result.source.sha256, createHash('sha256').update(Buffer.from(content)).digest('hex'))
  })

  test('saved request extraction accepts only the bounded adapter inputs', () => {
    const root = scratch()
    write(root, 'skill.md', skill())
    const saved = plan(root)
    assert.deepEqual(extractSetupExecutionRequest(saved), {
      adapter: LOCAL_SKILL_ADAPTER,
      name: 'my-skill',
      sourcePath: 'skill.md',
    })
    const cases: unknown[] = [
      null,
      [],
      { ...saved, schemaVersion: 2 },
      { ...saved, kind: 'setup-plan' },
      { ...saved, adapter: 'other/v1' },
      { ...saved, digest: undefined },
      { ...saved, skill: undefined },
      { ...saved, skill: { name: 'Uppercase', destination: '.agents/skills/Uppercase/SKILL.md' } },
      { ...saved, skill: { name: 'my-skill', destination: '.agents/skills/other/SKILL.md' } },
      { ...saved, source: { path: '../outside.md' } },
      { ...saved, source: { path: '.git/config' } },
      { ...saved, source: {} },
    ]
    for (const value of cases) {
      assert.throws(() => extractSetupExecutionRequest(value), AnvilError)
    }
  })
})
