/**
 * Choose the version a release run claims and whether it is a rehearsal.
 *
 * Run from the repository root; stdout is appended to `$GITHUB_OUTPUT`.
 *
 * Environment:
 *   GITHUB_REF  full ref the run targets (`refs/tags/v1.2.3`, `refs/heads/main`, ...)
 *
 * A `v*` tag is the claim being released, or rehearsed by a dispatch on that tag. Anything
 * else -- a branch dispatch -- has no tag to compare against, so the candidate comes from the
 * workspace manifest and the run is a rehearsal. One decision produces both values, so the
 * version the identity gate compares and the flag that selects the gate cannot disagree.
 *
 * `tags: ['v*']` also matches the bare tag `v`, which claims no version. That is an error, not
 * a rehearsal: falling back to the manifest would let preparation retain evidence that claims
 * a tag it never checked.
 */
import { readFileSync } from 'node:fs'

const ref = process.env.GITHUB_REF
if (!ref) throw new Error('GITHUB_REF is required')

const releaseTag = /^refs\/tags\/v(.*)$/.exec(ref)
if (releaseTag !== null) {
  const tag = releaseTag[1] ?? ''
  if (tag === '') throw new Error('the release tag claims no version; name it like v1.2.3')
  console.log(`version=${tag}`)
  console.log('rehearsal=0')
} else {
  const version = JSON.parse(readFileSync('packages/cli/package.json', 'utf8')).version
  if (!version) throw new Error('the workspace manifest has no version')
  console.log(`version=${version}`)
  console.log('rehearsal=1')
}
