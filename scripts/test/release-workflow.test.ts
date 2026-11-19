/**
 * Guard the release workflow's no-publish rehearsal path.
 *
 * `.github/workflows/**` is high-risk: a stray edit can publish bytes from a manual run, and
 * a release cannot be undone. These assertions read the source text rather than a parsed
 * document -- the repository declares no YAML dependency -- and check the guards in the
 * context of the step or job they belong to, so a guard elsewhere in the file cannot satisfy
 * them.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8')

/** One `- name:` step, from its marker to the next step, so a guard must be in that step. */
function step(name: string): string {
  const marker = `- name: ${name}`
  const start = workflow.indexOf(marker)
  assert.notEqual(start, -1, `the release workflow has no step named ${name}`)
  const next = workflow.indexOf('\n      - name:', start + marker.length)
  return workflow.slice(start, next === -1 ? workflow.length : next)
}

/** One top-level job, so token permissions in one job cannot satisfy a guard on another. */
function job(name: string): string {
  const jobs = [...workflow.matchAll(/^ {2}([a-z][a-z-]*):$/gm)]
  const index = jobs.findIndex((match) => match[1] === name)
  assert.notEqual(index, -1, `the release workflow has no job named ${name}`)
  const found = jobs[index]
  assert.ok(found !== undefined)
  const end = jobs[index + 1]?.index ?? workflow.length
  return workflow.slice(found.index, end)
}

/** Build a minimal gzipped tar containing one package/package.json entry. */
function tarballWithSummary(pkg: { name: string; version: string }): Buffer {
  const body = Buffer.from(JSON.stringify(pkg))
  const header = Buffer.alloc(512)
  header.write('package/package.json', 0, 100, 'utf8')
  header.write('0000644\0', 100, 8)
  header.write('0000000\0', 108, 8)
  header.write('0000000\0', 116, 8)
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12)
  header.write('00000000000\0', 136, 12)
  header.fill(0x20, 148, 156)
  header.write('0', 156, 1)
  header.write('ustar\0', 257, 6)
  header.write('00', 263, 2)
  const sum = [...header].reduce((total, byte) => total + byte, 0)
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512)
  body.copy(padded)
  return gzipSync(Buffer.concat([header, padded, Buffer.alloc(1024)]))
}

describe('release workflow rehearsal', () => {
  test('both a version tag and a manual dispatch trigger the workflow', () => {
    assert.ok(workflow.includes('workflow_dispatch:'), 'a manual rehearsal must be possible')
    assert.ok(workflow.includes("tags: ['v*']"), 'a tag must still trigger a real release')
  })

  test('only the tag-gated publish job can reach npm and OIDC', () => {
    const publish = job('publish')
    assert.match(
      publish,
      /if: \$\{\{ github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\) \}\}/,
      'publication requires a real version tag',
    )
    assert.match(publish, /needs: release/, 'publication depends on the tested artifact')
    assert.match(publish, /id-token: write/, 'only the publish job gets OIDC')
    assert.match(publish, /secrets\.NPM_TOKEN/)
    assert.match(publish, /run: npm publish/)

    const prepare = job('release')
    assert.doesNotMatch(prepare, /^\s+run: npm publish/m, 'preparation never publishes')
    assert.doesNotMatch(prepare, /secrets\.NPM_TOKEN/, 'preparation never sees the token')
    assert.doesNotMatch(prepare, /id-token: write/, 'preparation never gets OIDC')
    assert.match(prepare, /contents: read/)

    const beforeJobs = workflow.slice(0, workflow.indexOf('\njobs:'))
    assert.doesNotMatch(beforeJobs, /id-token: write/, 'OIDC is not granted at workflow scope')
  })

  test('publication consumes the artifact that was tested, without rebuilding', () => {
    const upload = step('retain the tested tarball, checksum and draft release notes')
    const download = step('recover the tested artifact')
    assert.match(upload, /actions\/upload-artifact@[0-9a-f]{40}/)
    assert.match(download, /actions\/download-artifact@[0-9a-f]{40}/)
    assert.match(download, /path: dist/)
    assert.match(download, /artifact-ids: \$\{\{ needs\.release\.outputs\.artifact_id \}\}/)
    assert.match(download, /merge-multiple: true/, 'one artifact ID must be extracted directly into dist')
    const publish = job('publish')
    assert.match(publish, /node scripts\/verify-release-artifact\.mjs/)
    assert.doesNotMatch(publish, /npm ci|npm run check|npm pack/, 'the publish job must not rebuild')
  })

  test('a publish-only retry cannot look for an artifact under a new run attempt', () => {
    const prepare = job('release')
    for (const output of ['artifact_id', 'checksum', 'source_sha']) {
      assert.match(prepare, new RegExp(`^ {6}${output}:`, 'm'), `preparation must export ${output}`)
    }
    assert.match(prepare, /artifact_id: \$\{\{ steps\.upload_evidence\.outputs\['artifact-id'\] \}\}/)
    const publish = job('publish')
    assert.doesNotMatch(publish, /github\.run_attempt/, 'attempt is not part of artifact identity')
    assert.match(publish, /EXPECTED_CHECKSUM: \$\{\{ needs\.release\.outputs\.checksum \}\}/)
    assert.match(publish, /SOURCE_SHA: \$\{\{ needs\.release\.outputs\.source_sha \}\}/)
    const verify = step('verify the artifact before publication')
    assert.match(verify, /node scripts\/verify-release-artifact\.mjs/)
    assert.match(verify, /EXPECTED_CHECKSUM: \$\{\{ needs\.release\.outputs\.checksum \}\}/)
  })

  test('the artifact verifier accepts intact bytes and rejects changes', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'anvil-release-verify-'))
    const artifactDir = join(workspace, 'dist')
    mkdirSync(artifactDir)
    try {
      const tarball = join(artifactDir, 'anvil-workflows-cli-0.1.0.tgz')
      const bytes = tarballWithSummary({ name: '@anvil-workflows/cli', version: '0.1.0' })
      writeFileSync(tarball, bytes)
      const checksum = createHash('sha256').update(bytes).digest('hex')
      writeFileSync(join(artifactDir, 'SHA256SUMS'), `${checksum}  anvil-workflows-cli-0.1.0.tgz\n`)
      writeFileSync(join(artifactDir, 'RELEASE_NOTES.md'), 'Source commit: `source-sha`\n')

      const env = {
        ...process.env,
        ARTIFACT_DIR: artifactDir,
        EXPECTED_CHECKSUM: checksum,
        SOURCE_SHA: 'source-sha',
        TAG_VERSION: 'v0.1.0',
      }
      const run = (): { status: number | null; output: string } => {
        const result = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'verify-release-artifact.mjs')], {
          cwd: repoRoot,
          env,
          encoding: 'utf8',
        })
        return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` }
      }
      const nested = join(artifactDir, 'release-evidence-1')
      mkdirSync(nested)
      cpSync(tarball, join(nested, 'anvil-workflows-cli-0.1.0.tgz'))
      rmSync(tarball)
      assert.notEqual(run().status, 0, 'a tarball nested under the artifact name must not pass')
      cpSync(join(nested, 'anvil-workflows-cli-0.1.0.tgz'), tarball)
      const intact = run()
      assert.equal(intact.status, 0, `the intact artifact must pass: ${intact.output}`)

      writeFileSync(tarball, tarballWithSummary({ name: '@anvil-workflows/cli', version: '0.1.1' }))
      const changed = run()
      assert.notEqual(changed.status, 0, 'modified bytes must fail')
      assert.match(changed.output, /checksum/i)

      writeFileSync(tarball, bytes)
      writeFileSync(join(artifactDir, 'RELEASE_NOTES.md'), 'Source commit: `other-sha`\n')
      assert.notEqual(run().status, 0, 'a mismatched source commit must fail')
    } finally {
      rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  test('a rehearsal takes its candidate version from the manifest, not a tag', () => {
    assert.ok(workflow.includes('GITHUB_EVENT_NAME'), 'the provenance step must read the event name')
    assert.ok(
      workflow.includes("require('./packages/cli/package.json').version"),
      'a dispatch has no tag, so the manifest is the candidate version',
    )
  })

  test('rehearsal evidence is named apart from a real release', () => {
    assert.match(step('retain the tested tarball, checksum and draft release notes'), /'rehearsal-'/)
    const publish = job('publish')
    assert.doesNotMatch(publish, /rehearsal-/, 'publication never consumes rehearsal evidence')
  })

  test('the job summary claims retention only after the upload succeeds', () => {
    const upload = workflow.indexOf('- name: retain the tested tarball, checksum and draft release notes')
    const summary = workflow.indexOf('- name: retain the release evidence in the job summary')
    assert.ok(upload !== -1 && summary > upload, 'the success summary comes after the upload')
    assert.match(step('retain the release evidence in the job summary'), /Evidence retained/)
  })

  test('least-privilege permissions and SHA-pinned actions are unchanged', () => {
    const pins = [...workflow.matchAll(/uses: ([^\s]+)/g)].map((match) => match[1])
    assert.ok(pins.length > 0, 'expected at least one action')
    for (const pin of pins) assert.match(pin ?? '', /@[0-9a-f]{40}$/)
  })
})
