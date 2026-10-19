/**
 * `anvil playbook check`.
 *
 * The check is the mitigation for playbook rot, and a rot check has one overriding
 * requirement: it must not cry wolf. A check that fails on a rate limit, a bot wall or a
 * flaky network gets disabled, and a disabled rot check is worse than none, because every
 * dashboard that counts green runs reads as coverage.
 *
 * So the classification is pinned here as tightly as the fetching is, and the network is
 * injected -- these tests never open a socket.
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  checkPlaybooks,
  checkStructure,
  classifyStatus,
  collectUrls,
  loadBuiltins,
  type Playbook,
  type ProbeFetch,
  type Problem,
  probeUrls,
} from '@anvil/playbooks'

function playbook(overrides: Partial<Playbook> = {}): Playbook {
  return {
    id: 'test',
    title: 'Test',
    priority: 50,
    match: { files: ['package.json'], deps: [], importPrefixes: [] },
    official: {
      docs: [{ label: 'Docs', url: 'https://example.test/docs', why: 'because' }],
      skills: [],
      agents: [],
      mcp: [],
      styleGuides: [],
      migrationGuides: [],
    },
    community: [],
    verify: { build: [], test: ['npm test'], testFast: [], lint: [], format: [], typecheck: [] },
    conventions: { moduleLayout: null, testNaming: null, reviewFocus: [] },
    riskGlobs: [],
    discover: { officialOrgs: [], keywords: [], mcp: [] },
    source: 'test.yaml',
    ...overrides,
  }
}

function messages(problems: Problem[]): string {
  return problems.map((p) => `${p.level} ${p.where}: ${p.message}`).join('\n')
}

describe('the built-in registry is clean', () => {
  const { playbooks, warnings } = loadBuiltins()

  test('every built-in playbook loads', () => {
    assert.equal(
      warnings.length,
      0,
      messages(warnings.map((w) => ({ level: 'warn' as const, where: 'load', message: w, fix: '' }))),
    )
    assert.ok(playbooks.length >= 15, `expected the full registry, saw ${playbooks.length}`)
  })

  test('no structural errors', () => {
    // The shipped registry must pass its own check, offline, deterministically. This is the
    // assertion that keeps `playbook check` credible: a rot check that fails on the
    // registry it ships with is a check nobody runs.
    const problems = checkStructure(playbooks)
    const errors = problems.filter((p) => p.level === 'error')
    assert.deepEqual(
      errors.map((e) => `${e.where}: ${e.message}`),
      [],
    )
  })

  test('every url is absolute https', () => {
    for (const { url, where } of collectUrls(playbooks)) {
      assert.match(url, /^https:\/\//, `${where}: ${url}`)
    }
  })
})

describe('classifyStatus', () => {
  // The whole design of the check lives in this function: which statuses are rot, and
  // which are merely the internet being the internet.
  test('2xx and 3xx are fine', () => {
    for (const s of [200, 204, 301, 302, 307]) assert.equal(classifyStatus(s), 'ok', String(s))
  })

  test('404 and 410 are rot, and nothing else is', () => {
    assert.equal(classifyStatus(404), 'gone')
    assert.equal(classifyStatus(410), 'gone')
  })

  test('403 from a bot wall is unconfirmed, not rot', () => {
    // A great many documentation sites answer HEAD with 403 and serve the page to a
    // browser. Reporting that as a dead link is how a rot check loses its credibility.
    assert.equal(classifyStatus(403), 'unconfirmed')
    assert.equal(classifyStatus(401), 'unconfirmed')
  })

  test('rate limits, server errors and odd methods are unconfirmed', () => {
    for (const s of [405, 418, 429, 500, 502, 503]) {
      assert.equal(classifyStatus(s), 'unconfirmed', String(s))
    }
  })
})

describe('checkStructure', () => {
  test('a url that is not absolute https is an error', () => {
    const problems = checkStructure([
      playbook({
        official: {
          ...playbook().official,
          docs: [{ label: 'Docs', url: 'example.test/docs', why: 'because' }],
        },
      }),
    ])
    assert.equal(problems.length, 1)
    assert.equal(problems[0]?.level, 'error')
    assert.match(problems[0]?.message ?? '', /absolute https/)
  })

  test('a resource with no why is a warning, not an error', () => {
    // The plan is explicit that a list of unexplained links is browsing, not guidance --
    // but it is not a broken registry, so it must not fail a CI gate.
    const problems = checkStructure([
      playbook({
        official: { ...playbook().official, docs: [{ label: 'Docs', url: 'https://example.test/', why: '  ' }] },
      }),
    ])
    assert.equal(problems.filter((p) => p.level === 'error').length, 0)
    assert.equal(problems.filter((p) => p.level === 'warn').length, 1)
  })

  test('a risk glob claimed twice is reported with the winner named', () => {
    const problems = checkStructure([
      playbook({ id: 'jvm', priority: 60, riskGlobs: ['**/build.gradle.kts'] }),
      playbook({ id: 'android', priority: 85, riskGlobs: ['**/build.gradle.kts'] }),
    ])
    const glob = problems.find((p) => p.message.includes('claimed by 2'))
    assert.ok(glob !== undefined, messages(problems))
    assert.equal(glob.level, 'warn')
    assert.match(glob.fix ?? '', /android wins/, 'the higher-priority playbook should be named')
  })

  test('the same url in two playbooks is reported once', () => {
    const url = 'https://example.test/shared'
    const problems = checkStructure([
      playbook({ id: 'a', official: { ...playbook().official, docs: [{ label: 'x', url, why: 'y' }] } }),
      playbook({ id: 'b', official: { ...playbook().official, docs: [{ label: 'x', url, why: 'y' }] } }),
    ])
    const dupe = problems.find((p) => /cited .* times across 2 playbooks/.test(p.message))
    assert.ok(dupe !== undefined, messages(problems))
  })

  test('one playbook citing a url twice is not reported as two playbooks', () => {
    // The count was per citation while the id list was deduplicated, so a single owner
    // produced "cited by 2 playbooks (solo)" -- two numbers describing different things.
    const url = 'https://example.test/twice'
    const docs = [
      { label: 'x', url, why: 'y' },
      { label: 'z', url, why: 'y' },
    ]
    const problems = checkStructure([playbook({ id: 'solo', official: { ...playbook().official, docs } })])
    const dupe = problems.find((p) => p.message.includes(url))
    assert.ok(dupe !== undefined, messages(problems))
    assert.match(dupe.message, /same playbook \(solo\)/)
    assert.ok(!/2 playbooks/.test(dupe.message), dupe.message)
  })

  test('a risk glob two equal-priority playbooks claim is a note, not a warning', () => {
    // Naming a winner alphabetically is advice nobody should act on, and a warning here made
    // `--warnings` fail on the registry this project ships. A tie is reported as a tie.
    const problems = checkStructure([
      playbook({ id: 'one', priority: 60, riskGlobs: ['**/Dockerfile*'] }),
      playbook({ id: 'two', priority: 60, riskGlobs: ['**/Dockerfile*'] }),
    ])
    const glob = problems.find((p) => p.message.includes('claimed by 2'))
    assert.ok(glob !== undefined, messages(problems))
    assert.equal(glob.level, 'info')
    assert.match(glob.fix ?? '', /tie at priority/)
  })

  test('a duplicate id names the files, because the diagnosis is which one to open', () => {
    const problems = checkStructure([
      playbook({ id: 'same', source: '/one/same.yaml' }),
      playbook({ id: 'same', source: '/two/same.yaml' }),
    ])
    const dupe = problems.find((p) => p.message.includes('duplicate playbook id'))
    assert.ok(dupe !== undefined, messages(problems))
    assert.equal(dupe.level, 'error')
    assert.match(dupe.fix ?? '', /one\/same\.yaml/)
    assert.match(dupe.fix ?? '', /two\/same\.yaml/)
  })

  test('a verify command that assumes a committed wrapper is a note', () => {
    const problems = checkStructure([
      playbook({ verify: { ...playbook().verify, build: ['./gradlew assembleDebug'] } }),
    ])
    const note = problems.find((p) => p.level === 'info')
    assert.ok(note !== undefined, messages(problems))
    assert.match(note.message, /wrapper/)
  })

  test('a playbook offering nothing is a warning', () => {
    const empty = playbook()
    const problems = checkStructure([
      {
        ...empty,
        official: { docs: [], skills: [], agents: [], mcp: [], styleGuides: [], migrationGuides: [] },
        community: [],
      },
    ])
    assert.ok(
      problems.some((p) => p.message.includes('no resources')),
      messages(problems),
    )
  })
})

describe('probeUrls', () => {
  const statuses: Record<string, number> = {
    'https://ok.test/': 200,
    'https://gone.test/': 404,
    'https://walled.test/': 403,
  }
  const calls: Array<{ url: string; method: string }> = []
  const fakeFetch: ProbeFetch = async (url, init) => {
    calls.push({ url, method: init.method })
    const status = statuses[url]
    if (status === undefined) throw new TypeError('fetch failed')
    return { status }
  }

  test('classifies each url and never throws on a transport failure', async () => {
    const out = await probeUrls(Object.keys(statuses), { fetchImpl: fakeFetch })
    assert.equal(out.get('https://ok.test/')?.outcome, 'ok')
    assert.equal(out.get('https://gone.test/')?.outcome, 'gone')
    assert.equal(out.get('https://walled.test/')?.outcome, 'unconfirmed')
  })

  test('a network failure is unconfirmed, not a failure', async () => {
    const out = await probeUrls(['https://nowhere.test/'], { fetchImpl: fakeFetch })
    assert.equal(out.get('https://nowhere.test/')?.outcome, 'unconfirmed')
    assert.match(out.get('https://nowhere.test/')?.detail ?? '', /fetch failed/)
  })

  test('falls back to GET when the method itself is refused', async () => {
    calls.length = 0
    const out = await probeUrls(['https://ok.test/'], {
      fetchImpl: async (url, init) => {
        calls.push({ url, method: init.method })
        return { status: init.method === 'HEAD' ? 405 : 200 }
      },
    })
    assert.equal(out.get('https://ok.test/')?.outcome, 'ok')
    assert.deepEqual(
      calls.map((c) => c.method),
      ['HEAD', 'GET'],
    )
  })

  test('probes each distinct url once, whatever the citation count', async () => {
    calls.length = 0
    await probeUrls(['https://ok.test/', 'https://ok.test/', 'https://ok.test/'], { fetchImpl: fakeFetch })
    assert.equal(calls.length, 1)
  })

  test('concurrency is bounded', async () => {
    let inFlight = 0
    let peak = 0
    const urls = Array.from({ length: 12 }, (_, i) => `https://n${i}.test/`)
    await probeUrls(urls, {
      concurrency: 3,
      fetchImpl: async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight--
        return { status: 200 }
      },
    })
    assert.ok(peak <= 3, `peak concurrency was ${peak}, expected at most 3`)
    assert.ok(peak > 1, 'it should actually run in parallel')
  })
})

describe('checkPlaybooks', () => {
  const dying = playbook({
    id: 'dying',
    official: { ...playbook().official, docs: [{ label: 'Gone', url: 'https://gone.test/', why: 'was useful' }] },
  })

  test('a dead link is an error and fails the check', async () => {
    const report = await checkPlaybooks([dying], {
      probe: true,
      fetchImpl: async () => ({ status: 404 }),
    })
    assert.equal(report.ok, false)
    assert.equal(report.counts.error, 1)
    assert.match(report.problems[0]?.message ?? '', /dead link/)
  })

  test('an unconfirmed link does not fail the check', async () => {
    // A 403 or a timeout must not turn a red build, or people will pass --offline forever
    // and then rot arrives unnoticed.
    const report = await checkPlaybooks([dying], {
      probe: true,
      fetchImpl: async () => ({ status: 403 }),
    })
    assert.equal(report.ok, true)
    assert.equal(report.urls[0]?.outcome, 'unconfirmed')
  })

  test('offline mode reports urls without probing them', async () => {
    let called = false
    const report = await checkPlaybooks([dying], {
      probe: false,
      fetchImpl: async () => {
        called = true
        return { status: 200 }
      },
    })
    assert.equal(called, false)
    assert.equal(report.ok, true)
    assert.match(report.urls[0]?.detail ?? '', /not probed/)
  })

  test('the report names which playbooks cite a dead link', async () => {
    const report = await checkPlaybooks([dying], { probe: true, fetchImpl: async () => ({ status: 410 }) })
    const url = report.urls.find((u) => u.outcome === 'gone')
    assert.deepEqual(url?.citedBy, ['dying'])
  })
})
