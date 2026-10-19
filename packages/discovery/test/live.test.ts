/**
 * The live discovery contract suite.
 *
 * The mocked suite proves the parser and fallback logic against recorded shapes. It cannot
 * prove two things that have broken quietly in this repo before: that the argv `searchGitHub`
 * builds is one the installed `gh` actually accepts (a fake runner accepts any argv), and
 * that the API answer today still looks like the fixture (a fixture is a snapshot of someone's
 * memory of an answer).
 *
 * So this suite runs against the real world, behind `ANVIL_LIVE=1`, and never in default CI:
 *
 *   1. **Flag contract** (no auth, no network). Record the argv, ask the real binary.
 *   2. **Live behaviour** (network). One real search through `gh` when it is installed and
 *      authenticated, else the REST fallback, asserting the transports answer rather than
 *      merely agreeing with a fake.
 *
 *   ANVIL_LIVE=1    run this suite
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { runProcess } from '@anvil/core'
import { type FetchImpl, type GhRun, searchGitHub } from '@anvil/discovery'

const LIVE = process.env.ANVIL_LIVE === '1'

const realFetch: FetchImpl = async (url, init) => {
  const res = await fetch(url, { headers: init.headers, signal: init.signal })
  return { status: res.status, text: () => res.text() }
}

const synthetic = JSON.stringify({
  total_count: 1,
  items: [
    {
      full_name: 'android/androidify',
      html_url: 'https://github.com/android/androidify',
      description: 'Android samples',
      stargazers_count: 1234,
      owner: { login: 'android', type: 'Organization' },
    },
  ],
})

/**
 * Whether a search can be made with someone's credentials.
 *
 * Anonymous search is capped at ten requests a minute, and a shared CI address is well past
 * that by the time a job runs, so an unauthenticated search fails for reasons that have
 * nothing to do with the code. The suite therefore asks a question it can answer: is there a
 * credential to use?
 */
async function hasAuth(): Promise<boolean> {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? ''
  if (token !== '') return true
  try {
    const res = await runProcess('gh', ['auth', 'status'])
    return res.exitCode === 0
  } catch {
    return false
  }
}

describe('the discovery argv contract (live)', { skip: LIVE ? false : 'set ANVIL_LIVE=1' }, () => {
  test('the argv anvil builds is accepted by the installed gh', async () => {
    const captured: string[][] = []
    const gh: GhRun = async (args) => {
      captured.push(args)
      return { stdout: synthetic, stderr: '', exitCode: 0 }
    }

    const found = await searchGitHub('org:android', { gh, fetchImpl: realFetch, cwd: '.' })
    assert.ok(found !== null, 'the injected gh answered with a shape the parser rejected')
    assert.equal(found.via, 'gh')
    assert.equal(captured.length, 1)
    const argv = captured[0] ?? []
    assert.ok(argv.length > 0)

    const help = await runProcess('gh', ['api', '--help'])
    const text = `${help.stdout}\n${help.stderr}`
    assert.match(text, /usage/i, `gh api --help produced no usage: ${text.slice(0, 200)}`)
    for (const arg of argv) {
      if (!arg.startsWith('--')) continue
      assert.ok(text.includes(arg), `gh api does not accept ${arg}  [${argv.join(' ')}]`)
    }
  })

  test('a real search returns results through a real transport', async (t) => {
    if (!(await hasAuth())) {
      t.skip('no gh authentication and no token: an anonymous search is rate-limited to ten a minute')
      return
    }
    const found = await searchGitHub('org:android', {
      fetchImpl: realFetch,
      cwd: '.',
      token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
      perQuery: 3,
    })
    assert.ok(found !== null, 'both transports failed; this is a network or credential problem, not a parsing one')
    assert.ok(found.via === 'gh' || found.via === 'api', `unexpected transport: ${String(found.via)}`)
    assert.ok(found.results.length > 0, `github answered ${found.detail} -- the query shape may have changed`)
  })
})
