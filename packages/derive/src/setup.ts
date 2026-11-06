/**
 * Content-addressed setup proposals. There is deliberately no executor or approval writer.
 *
 * Only owner-declared install commands are supported. Their text is opaque: it is neither
 * tokenized nor expanded, and its permissions, file effects and immutable resource identity
 * cannot be inferred. A digest detects changes; it is not an authorization token or sandbox.
 */
import { createHash } from 'node:crypto'
import { AnvilError, ErrorCode, type ProjectConfig } from '@anvil/core'

export interface SetupRepositoryState {
  /** Physical directory, not a remote URL (which could contain credentials). */
  root: string
  head: string | null
  worktree: 'clean' | 'dirty' | 'unknown'
}

export interface SetupPlanAction {
  id: string
  source: string
  kind: 'repository-install' | 'tool-install'
  tool: string | null
  /** Exact owner-declared text. Never parsed, expanded or executed. */
  command: string
  /** Repository-relative, resolved from the plan's repository root; '' means root. */
  cwd: string
  required: boolean
  /** A requirement is not a pin, even if it names an exact version. */
  versionRange: string | null
  immutableRef: null
  permissions: null
  fileChanges: null
  requiresApproval: true
  verification: 'not-run'
}

export interface SetupPlan {
  schemaVersion: 1
  kind: 'setup-plan'
  status: 'proposed'
  executed: false
  approval: 'not-granted'
  executionSupported: false
  repository: SetupRepositoryState
  /** Hash of effective declarations and the default command working directory. */
  inputsDigest: string
  actions: SetupPlanAction[]
  warnings: string[]
  digest: string
}

export interface SetupPlanValidation {
  schemaVersion: 1
  status: 'current' | 'stale' | 'invalid' | 'unknown'
  /** Even a current plan does not authorize any execution. */
  approval: 'not-granted'
  executed: false
  reason: string
}

/** Canonical JSON: object insertion order is irrelevant; array order remains significant. */
function canonical(value: unknown, depth = 0): string {
  if (depth > 50) throw new Error('Plan is too deeply nested')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${Array.from(value, (entry) => canonical(entry, depth + 1)).join(',')}]`
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('Expected JSON data')
  }
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key], depth + 1)}`)
    .join(',')}}`
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function checkedDirectory(dir: string): string {
  if (
    /^[\\/]/.test(dir) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(dir) ||
    /[\u0000-\u001f]/.test(dir) ||
    dir.split(/[/\\]/).includes('..')
  ) {
    throw new AnvilError(ErrorCode.ConfigInvalid, 'A setup command needs a repository-relative working directory', {
      hint: 'Use a directory inside the project; setup plans do not support absolute paths or parent traversal.',
    })
  }
  return dir
}

export function buildSetupPlan(options: {
  repository: SetupRepositoryState
  declared: ProjectConfig
  projectDir: string
}): SetupPlan {
  const { declared, projectDir } = options
  const actions: SetupPlanAction[] = []
  let hasPrimaryInstall = false
  function add(
    action: Pick<SetupPlanAction, 'id' | 'source' | 'kind' | 'tool' | 'command' | 'cwd' | 'required' | 'versionRange'>,
  ) {
    actions.push({
      ...action,
      cwd: checkedDirectory(action.cwd),
      immutableRef: null,
      permissions: null,
      fileChanges: null,
      requiresApproval: true,
      verification: 'not-run',
    })
  }
  declared.commands.forEach((command, index) => {
    if (command.kind !== 'install') return
    add({
      id: `command:${index}`,
      source: `project.commands[${index}]`,
      kind: 'repository-install',
      tool: null,
      command: command.cmd,
      cwd: command.dir ?? projectDir,
      required: !hasPrimaryInstall,
      versionRange: null,
    })
    hasPrimaryInstall = true
  })
  declared.tools.forEach((tool, index) => {
    if (tool.install === undefined || tool.install.trim() === '') return
    add({
      id: `tool:${index}`,
      source: `project.tools[${index}].install`,
      kind: 'tool-install',
      tool: tool.id,
      command: tool.install,
      cwd: projectDir,
      required: tool.required ?? true,
      versionRange: tool.version ?? null,
    })
  })
  const warnings = [
    'Commands are owner declarations, not evidence that setup is needed or will succeed.',
    'Permissions, file changes and immutable resource references are unknown; no execution or approval is supported.',
    'Command text is shown verbatim. Do not embed credentials; environment values are never expanded into a plan.',
    'Repository state covers HEAD and Git status, not ignored files, external tools, credentials or network state.',
  ]
  if (actions.length === 0) warnings.push('No owner-declared install commands; no setup commands were invented.')
  if (options.repository.head === null || options.repository.worktree !== 'clean') {
    warnings.push('Repository state is not a clean commit; this proposal cannot pass current-plan validation.')
  }
  const payload = {
    schemaVersion: 1 as const,
    kind: 'setup-plan' as const,
    status: 'proposed' as const,
    executed: false as const,
    approval: 'not-granted' as const,
    executionSupported: false as const,
    repository: { ...options.repository },
    inputsDigest: digest({ declared, projectDir }),
    actions,
    warnings,
  }
  return { ...payload, digest: digest(payload) }
}

/**
 * Compare untrusted saved JSON with a freshly generated plan. Equality is intentionally
 * strict: extra keys, changed commands or different repository/declaration inputs all fail.
 * This only validates a proposal; there are no accepted approval records in this slice.
 */
export function validateSetupPlan(saved: unknown, current: SetupPlan): SetupPlanValidation {
  const result = (status: SetupPlanValidation['status'], reason: string): SetupPlanValidation => ({
    schemaVersion: 1,
    status,
    approval: 'not-granted',
    executed: false,
    reason,
  })
  if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) {
    return result('invalid', 'Expected a setup-plan JSON object, not an approval or an envelope.')
  }
  const { digest: recordedDigest, ...payload } = saved as Record<string, unknown>
  if (payload.schemaVersion !== 1 || payload.kind !== 'setup-plan' || typeof recordedDigest !== 'string') {
    return result('invalid', 'Unsupported setup-plan format.')
  }
  try {
    if (digest(payload) !== recordedDigest)
      return result('invalid', 'The saved plan digest does not match its contents.')
    // Compare the entire object, not just an attacker-supplied digest. This also rejects extra
    // fields (including forged approvals) and malformed structures with recomputed digests.
    if (canonical(saved) !== canonical(current)) {
      return result('stale', 'The saved plan differs from the current repository state or effective declarations.')
    }
  } catch {
    return result('invalid', 'The saved plan is not supported JSON data.')
  }
  if (current.repository.head === null || current.repository.worktree !== 'clean') {
    return result('unknown', 'A clean repository commit is needed to validate a current proposal.')
  }
  return result('current', 'The proposal matches current inputs. This is not approval or evidence of successful setup.')
}
