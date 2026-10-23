/**
 * `GhForgeTransport.pushBranch` is the one place anvil pushes, and the one place the
 * claimed worktree's pre-push hook must be opened. The hook itself is tested with real git
 * in `@anvil/worktrees`; this pins the other half of the contract -- that the push runs
 * with the marker and only for this command.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { SHIP_GUARD_ENV } from '@anvil/core'
import { GhForgeTransport, type RunResult } from '@anvil/providers'

describe('the forge push transport', () => {
  test('pushes the branch and sets its upstream with the ship marker', async () => {
    const calls: Array<{ args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = []
    const transport = new GhForgeTransport({
      runGit: async (args, options): Promise<RunResult> => {
        calls.push({ args, ...options })
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    })

    const result = await transport.pushBranch({ cwd: '/tmp/wt', branch: 'feat/local-1' })

    assert.equal(result.ok, true)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0]?.args, ['push', '-u', 'origin', 'feat/local-1'])
    assert.equal(calls[0]?.cwd, '/tmp/wt')
    assert.equal(calls[0]?.env[SHIP_GUARD_ENV], '1')
  })

  test('reports the git failure instead of claiming the push happened', async () => {
    const transport = new GhForgeTransport({
      runGit: async (): Promise<RunResult> => ({
        stdout: '',
        stderr: 'remote: denied',
        exitCode: 1,
      }),
    })

    const result = await transport.pushBranch({ cwd: '/tmp/wt', branch: 'feat/local-1' })

    assert.equal(result.ok, false)
    assert.match(result.detail, /remote: denied/)
  })
})
