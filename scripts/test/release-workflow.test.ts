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
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

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
    const publish = job('publish')
    assert.match(publish, /sha256sum --check SHA256SUMS/)
    assert.doesNotMatch(publish, /npm ci|npm run check|npm pack/, 'the publish job must not rebuild')
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
    assert.doesNotMatch(step('recover the tested artifact'), /'rehearsal-'/, 'a tag has no rehearsal prefix')
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
