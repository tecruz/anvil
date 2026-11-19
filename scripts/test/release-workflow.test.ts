/**
 * Guard the release workflow's no-publish rehearsal path.
 *
 * `.github/workflows/**` is high-risk: a stray edit can publish bytes from a manual run, and
 * a release cannot be undone. These assertions read the source text rather than a parsed
 * document -- the repository declares no YAML dependency -- and check the guards in the
 * context of the step they belong to, so a guard elsewhere in the file cannot satisfy them.
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

describe('release workflow rehearsal', () => {
  test('both a version tag and a manual dispatch trigger the workflow', () => {
    assert.ok(workflow.includes('workflow_dispatch:'), 'a manual rehearsal must be possible')
    assert.ok(workflow.includes("tags: ['v*']"), 'a tag must still trigger a real release')
  })

  test('publication is guarded on the publish step and skipped on dispatch', () => {
    const publish = step('publish the tested tarball to npm')
    assert.ok(publish.includes('npm publish'), 'the step must actually publish on a tag')
    assert.ok(publish.includes("github.event_name != 'workflow_dispatch'"), 'only a tag push may reach npm publish')
  })

  test('a rehearsal takes its candidate version from the manifest, not a tag', () => {
    assert.ok(workflow.includes('GITHUB_EVENT_NAME'), 'the provenance step must read the event name')
    assert.ok(
      workflow.includes("require('./packages/cli/package.json').version"),
      'a dispatch has no tag, so the manifest is the candidate version',
    )
  })

  test('rehearsal evidence is named apart from a real release', () => {
    assert.ok(workflow.includes("'rehearsal-'"), 'a dispatch artifact must not look like a release artifact')
  })

  test('least-privilege permissions and SHA-pinned actions are unchanged', () => {
    assert.match(workflow, /^ {2}contents: read$/m)
    assert.match(workflow, /^ {2}id-token: write/m)
    const pins = [...workflow.matchAll(/uses: ([^\s]+)/g)].map((match) => match[1])
    assert.ok(pins.length > 0, 'expected at least one action')
    for (const pin of pins) assert.match(pin ?? '', /@[0-9a-f]{40}$/)
  })
})
