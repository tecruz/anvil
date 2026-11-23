/**
 * `anvil dashboard` — an explicit, local-only overview of a repository.
 *
 * The command is the only thing that knows how anvil stores state. The dashboard package
 * receives a read-only staging view and a CLI invoker. The page is read-only by default; the
 * three confirm-gated Work-view actions call that same invoker with fixed CLI argv, so all
 * approval checks stay in the CLI. It never fetches guidance from the network.
 */

import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { AnvilError, ErrorCode, parseCliArgs } from '@anvil/core'
import { createDashboardServer, type DashboardInvoke, type StagedFileView, type StagedView } from '@anvil/dashboard'
import { diffFile, inspectStaging, readRepoFile, readStaged, renderUnifiedDiff, summarize } from '@anvil/derive'
import { createCliInvoker, DASHBOARD_ACTION_TIMEOUT_MS } from '../mcp.ts'
import { evidenceStore, headRevision, readVerificationEvidence } from './crew.ts'
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

/** Read the staging bundle without changing it. A per-file read failure stays an error. */
export function stagedView(repoRoot: string): StagedView {
  const state = inspectStaging(repoRoot)
  const manifest = state.manifest
  if (!state.exists || manifest === null) {
    return { exists: false, createdAt: null, inputHash: null, files: [], summary: { files: 0, added: 0, removed: 0 } }
  }

  const diffs = []
  const files: StagedFileView[] = []
  for (const file of manifest.files) {
    const edited = state.tampered.includes(file.path)
    const staged = readStaged(repoRoot, file)
    if (staged === null) {
      // A missing, unreadable or unsafe staged file is not an empty file. Rendering an empty
      // file would fabricate a deletion diff and make a broken bundle look intentionally edited.
      files.push({
        path: file.path,
        diff: '',
        edited,
        error: `Staged file could not be read: ${file.stagedPath}`,
      })
      continue
    }
    const before = readRepoFile(repoRoot, file.path)
    const diff = diffFile({ path: file.path, before, after: staged })
    if (diff !== null) diffs.push(diff)
    files.push({
      path: file.path,
      diff: diff === null ? '' : renderUnifiedDiff([diff]),
      edited,
      error: null,
    })
  }
  return {
    exists: true,
    createdAt: manifest.createdAt,
    inputHash: manifest.inputHash,
    files,
    summary: summarize(diffs),
  }
}

export interface DashboardInvokers {
  /** Short runner for the read-only snapshot sources. */
  invoke: DashboardInvoke
  /** Long runner for the three gated actions, which may run multi-minute verification. */
  invokeAction: DashboardInvoke
}

/**
 * Two invokers, one transport. Snapshot reads stay fast; an action gets enough time for the
 * CLI's ten-minute-per-check verification budget. The timeouts and entry are injectable so
 * tests can prove a slow check survives on the action runner with a short wait.
 */
export function dashboardInvokers(
  options: { entry?: string; snapshotTimeoutMs?: number; actionTimeoutMs?: number } = {},
): DashboardInvokers {
  const { entry, snapshotTimeoutMs, actionTimeoutMs = DASHBOARD_ACTION_TIMEOUT_MS } = options
  // exactOptionalPropertyTypes: omit undefined keys rather than passing them through.
  const invokeOptions = {
    ...(entry === undefined ? {} : { entry }),
    ...(snapshotTimeoutMs === undefined ? {} : { timeoutMs: snapshotTimeoutMs }),
  }
  return {
    invoke: createCliInvoker(invokeOptions),
    invokeAction: createCliInvoker({ ...invokeOptions, timeoutMs: actionTimeoutMs }),
  }
}

export const dashboardCommand: Command = {
  name: 'dashboard',
  summary: 'Start a local overview with a task brief, readiness, context and work, with gated actions.',
  usage: 'anvil dashboard [--repo <dir>] [--port <n>]',
  details: [
    'Serves a small page over the same JSON contracts the CLI prints. It does not replace any',
    'command. Refresh re-reads the CLI output; the page is a snapshot, not a live agent view.',
    '',
    'The Task brief is the entry point: paste a ticket or task text, or pick a repository',
    'suggestion. The brief names files to start from, checks, approval gates quoted from the',
    'task, blockers and unknowns. It reads only the cached snapshot, stores nothing and never',
    'starts a CLI process. Repository, Context and Work stay available as read-only views.',
    '',
    'The page is read-only by default. The Work view offers three explicit, confirm-gated',
    'actions: Claim <ticket>, Verify crew, and Ship <claim key> --probe. Each runs the same',
    'CLI command through the same approval checks; a refusal is shown beside the snapshot.',
    'See ADR-0026.',
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

    // Resolve the bounded evidence store and sample the HEAD commit once with read-only Git
    // flags. A page load or refresh never launches Git: a brief only reads the cached snapshot.
    const store = evidenceStore(repoRoot)
    const currentRevision = await headRevision(repoRoot)
    const { invoke, invokeAction } = dashboardInvokers()
    const server = await createDashboardServer({
      cwd: repoRoot,
      port,
      invoke,
      invokeAction,
      readStaged: () => stagedView(repoRoot),
      currentRevision,
      ...(store === null ? {} : { readVerification: () => readVerificationEvidence(store) }),
    })

    ctx.out(
      {
        schemaVersion: 1,
        url: server.url,
        repository: repoRoot,
        note: 'Local; read-only by default with three confirm-gated Work actions. Open the URL once; stop with Ctrl+C.',
      },
      () =>
        [
          `${ctx.style.green('dashboard')} ${server.url}`,
          `  repository  ${repoRoot}`,
          '',
          '  Local; read-only by default. Open the URL once; stop with Ctrl+C.',
        ].join('\n'),
    )
  },
}
