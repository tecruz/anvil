/**
 * `anvil dashboard` — an explicit, local-only, read-only overview of a repository.
 *
 * The command is the only thing that knows how anvil stores state. The dashboard package
 * receives a read-only staging view and a CLI invoker; it never writes to the repository,
 * runs a verify command, or fetches guidance from the network.
 */

import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { AnvilError, ErrorCode, parseCliArgs } from '@anvil/core'
import { createDashboardServer, type StagedView } from '@anvil/dashboard'
import { diffFile, inspectStaging, readRepoFile, readStaged, renderUnifiedDiff, summarize } from '@anvil/derive'
import { createCliInvoker } from '../mcp.ts'
import type { Command } from './types.ts'

function parsePort(value: unknown): number {
  if (value === undefined) return 0
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new AnvilError(ErrorCode.Usage, `Invalid --port: ${String(value)}`, {
      hint: 'Expected a port number between 0 and 65535; 0 asks the OS for a free port.',
    })
  }
  const port = Number(value)
  if (port > 65535) {
    throw new AnvilError(ErrorCode.Usage, `Invalid --port: ${value}`, {
      hint: 'Expected a port number between 0 and 65535.',
    })
  }
  return port
}

/** Read the staging bundle without changing it. Any read failure becomes a source error. */
function stagedView(repoRoot: string): StagedView {
  const state = inspectStaging(repoRoot)
  const manifest = state.manifest
  if (!state.exists || manifest === null) {
    return { exists: false, createdAt: null, inputHash: null, files: [], summary: { files: 0, added: 0, removed: 0 } }
  }

  const diffs = []
  for (const file of manifest.files) {
    const staged = readStaged(repoRoot, file)
    const before = readRepoFile(repoRoot, file.path)
    const diff = diffFile({ path: file.path, before, after: staged ?? '' })
    if (diff !== null) diffs.push(diff)
  }
  const totals = summarize(diffs)
  return {
    exists: true,
    createdAt: manifest.createdAt,
    inputHash: manifest.inputHash,
    files: manifest.files.map((file) => {
      const staged = readStaged(repoRoot, file) ?? ''
      const before = readRepoFile(repoRoot, file.path)
      const diff = diffFile({ path: file.path, before, after: staged })
      return {
        path: file.path,
        diff: diff === null ? '' : renderUnifiedDiff([diff]),
        edited: state.tampered.includes(file.path),
      }
    }),
    summary: totals,
  }
}

export const dashboardCommand: Command = {
  name: 'dashboard',
  summary: 'Start a local, read-only overview of readiness, context and parallel work.',
  usage: 'anvil dashboard [--repo <dir>] [--port <n>]',
  details: [
    'Serves a small read-only page over the same JSON contracts the CLI prints. It does not',
    'replace any command, and it never builds, tests, sets up, claims, ships or fetches',
    'guidance. Refresh re-reads the CLI output; the page is a snapshot, not a live agent view.',
    '',
    'The server binds to 127.0.0.1 only. Open the one-time URL it prints; the session token',
    'is then kept in an HttpOnly cookie. Stop it with Ctrl+C.',
    '',
    '--repo <dir>  repository to show; defaults to the current repository',
    '--port <n>    port to bind; 0 (the default) asks the OS for a free port',
  ].join('\n'),
  flags: {
    json: { type: 'boolean', short: 'j' },
    help: { type: 'boolean', short: 'h' },
    repo: { type: 'string' },
    port: { type: 'string' },
  },

  async run(ctx, rawArgs) {
    const args = parseCliArgs(rawArgs, dashboardCommand.flags)
    const port = parsePort(args.values.port)
    const target = typeof args.values.repo === 'string' ? args.values.repo : undefined
    const repoRoot = target === undefined ? ctx.repoRoot : resolve(ctx.cwd, target)
    if (repoRoot === null || repoRoot === '') {
      throw new AnvilError(ErrorCode.NotAGitRepo, 'Not inside a git repository', {
        hint: 'Run `anvil dashboard` inside a repository, or pass --repo <dir>.',
      })
    }
    if (!existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) {
      throw new AnvilError(ErrorCode.NotAGitRepo, `No such repository directory: ${repoRoot}`, {
        hint: 'Pass an existing repository root to --repo.',
      })
    }

    const server = await createDashboardServer({
      cwd: repoRoot,
      port,
      invoke: createCliInvoker(),
      readStaged: () => stagedView(repoRoot),
    })

    ctx.out(
      {
        schemaVersion: 1,
        url: server.url,
        repository: repoRoot,
        note: 'Local, read-only. Open the URL once; stop with Ctrl+C.',
      },
      () =>
        [
          `${ctx.style.green('dashboard')} ${server.url}`,
          `  repository  ${repoRoot}`,
          '',
          '  Local and read-only. Open the URL once; stop with Ctrl+C.',
        ].join('\n'),
    )
  },
}
