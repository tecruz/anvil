/**
 * The setup adapter registry.
 *
 * Every adapter that can be planned, approved and applied is named here, and only here. The
 * CLI resolves `--adapter`, plan resolution and grant grading through this module, so a new
 * adapter cannot be wired into one command while bypassing the plan -> grant -> apply ->
 * verify contract.
 *
 * An adapter never writes. It validates bounded inputs, reads current state, returns a plan
 * with declarative operations, and can independently verify the resulting artifact. The
 * framework owns locking, revalidation, grant consumption, the journal and writes.
 *
 * `local-skill/v1` keeps its plan bytes, behaviour fingerprint and v1 grant bytes. Every other
 * adapter uses grant and journal v2, where the grant binds the adapter's canonical binding
 * object rather than adapter-specific top-level fields.
 */
import { AnvilError, ErrorCode } from '@anvil/core'
import type { SetupRepositoryState } from './setup.ts'
import {
  buildSetupExecutionPlan,
  extractSetupExecutionRequest,
  LOCAL_SKILL_ADAPTER,
  LOCAL_SKILL_ADAPTER_FINGERPRINT,
  PINNED_SKILL_ADAPTER,
  resolveSetupExecutionPlan,
  SetupExecutionError,
  type SetupExecutionOperation,
  type SetupExecutionPlan,
  type SetupExecutionPlanResolution,
  type SetupExecutionRequest,
} from './setup-execution.ts'
import {
  buildPinnedSkillPlan,
  extractPinnedSkillRequest,
  PINNED_SKILL_ADAPTER_FINGERPRINT,
  type PinnedSkillRequest,
  parsePinnedSkillBindings,
  parsePinnedSkillRequest,
  pinnedSkillBindings,
  pinnedSkillRequestFromBindings,
  resolvePinnedSkillPlan,
} from './setup-pinned-skill.ts'

/** The CLI names a reviewer passes to `--adapter`. The list is closed. */
export const SETUP_ADAPTERS = ['local-skill', 'pinned-skill'] as const
export type SetupAdapterName = (typeof SETUP_ADAPTERS)[number]

/** The bounded inputs the CLI accepts; each adapter returns its own member of the union. */
export type SetupAdapterRequest = SetupExecutionRequest | PinnedSkillRequest

/** Store location and clock for adapters that read the protected cache. */
export interface SetupAdapterBuildOptions {
  env?: NodeJS.ProcessEnv
}

/** The artifact a plan targets. Journal v2 records this as `subject`. */
export interface SetupPlanSubject {
  kind: 'skill'
  id: string
  destination: string
}

/** The approved artifact identity a v2 grant binding names, used for replay verification. */
export interface SetupApprovedArtifact extends SetupPlanSubject {
  sha256: string
  bytes: number
}

/**
 * One registered adapter.
 *
 * `bindings` is what a v2 grant duplicates: the adapter's canonical claim about the plan.
 * `parseBindings` is the strict nested schema for that claim, and `planFromBindings` rebuilds
 * a plan from it, so inspecting a grant never trusts a saved plan.
 */
export interface SetupAdapterDefinition {
  /** Stable plan adapter id, for example `local-skill/v1`. */
  id: string
  /** The CLI name, which must be one entry of {@link SETUP_ADAPTERS}. */
  cliName: SetupAdapterName
  /** Digest of the behaviour descriptor; a change invalidates prior approvals. */
  fingerprint: string
  /** Validate CLI values and return only the bounded adapter inputs. */
  parseRequest(values: Record<string, unknown>): SetupAdapterRequest
  /** Recover the same bounded inputs from an untrusted saved plan. */
  extractRequest(saved: unknown): SetupAdapterRequest
  /** Build an inspect-only plan. Never writes. */
  build(
    repository: SetupRepositoryState,
    request: SetupAdapterRequest,
    options?: SetupAdapterBuildOptions,
  ): SetupExecutionPlan
  /** The declarative operations the framework executes, in order. */
  operations(plan: SetupExecutionPlan): readonly SetupExecutionOperation[]
  /** Rebuild a saved plan from its bounded inputs and compare it with current state. */
  resolve(
    saved: unknown,
    repository: SetupRepositoryState,
    options?: SetupAdapterBuildOptions,
  ): SetupExecutionPlanResolution
  /** The canonical binding a v2 grant duplicates. */
  bindings(plan: SetupExecutionPlan): Record<string, unknown>
  /** Strict parser for a v2 grant's `bindings` object; null when malformed. */
  parseBindings(value: unknown): Record<string, unknown> | null
  /** Rebuild a plan from a v2 grant's bindings, with no saved plan involved. */
  planFromBindings(
    repository: SetupRepositoryState,
    bindings: Record<string, unknown>,
    options?: SetupAdapterBuildOptions,
  ): SetupExecutionPlan
  /** The artifact a plan targets, recorded in journal v2. */
  subject(plan: SetupExecutionPlan): SetupPlanSubject
  /**
   * The approved artifact a grant binding names, without rebuilding a create-only plan.
   * Replay verification uses this so a successful install stays reportable after the
   * destination exists.
   */
  approvedArtifact(bindings: Record<string, unknown>): SetupApprovedArtifact | null
}

function localRequest(request: SetupAdapterRequest): SetupExecutionRequest {
  if (request.adapter !== LOCAL_SKILL_ADAPTER) {
    throw new AnvilError(ErrorCode.Internal, 'The local-skill adapter received another adapter request.')
  }
  return request
}

function pinnedRequest(request: SetupAdapterRequest): PinnedSkillRequest {
  if (request.adapter !== PINNED_SKILL_ADAPTER) {
    throw new AnvilError(ErrorCode.Internal, 'The pinned-skill adapter received another adapter request.')
  }
  return request
}

const LOCAL_BINDING_KEYS = ['skill', 'source'] as const
const LOCAL_SOURCE_KEYS = ['bytes', 'path', 'sha256'] as const
const LOCAL_SKILL_KEYS = ['destination', 'name'] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

/**
 * `local-skill/v1`: copy one repository-local `SKILL.md` to `.agents/skills/<name>/SKILL.md`.
 * The implementation stays in `setup-execution.ts` so its plan and grant bytes are unchanged.
 */
const LOCAL_SKILL: SetupAdapterDefinition = {
  id: LOCAL_SKILL_ADAPTER,
  cliName: 'local-skill',
  fingerprint: LOCAL_SKILL_ADAPTER_FINGERPRINT,
  parseRequest(values) {
    const source = values.source
    const name = values.name
    if (typeof source !== 'string' || source === '') {
      throw new AnvilError(ErrorCode.Usage, '--adapter local-skill requires --source <repo-relative-file>', {
        hint: 'The source must be a file inside this repository.',
      })
    }
    if (typeof name !== 'string' || name === '') {
      throw new AnvilError(ErrorCode.Usage, '--adapter local-skill requires --name <skill-name>', {
        hint: 'The name must match the skill name in its frontmatter.',
      })
    }
    return { adapter: LOCAL_SKILL_ADAPTER, name, sourcePath: source }
  },
  extractRequest: extractSetupExecutionRequest,
  build(repository, request) {
    const local = localRequest(request)
    return buildSetupExecutionPlan({ repository, sourcePath: local.sourcePath, name: local.name })
  },
  operations: (plan) => plan.operations,
  resolve: (saved, repository) => resolveSetupExecutionPlan(saved, repository),
  bindings(plan) {
    if (plan.adapter !== LOCAL_SKILL_ADAPTER) {
      throw new AnvilError(ErrorCode.Internal, 'The local-skill adapter received another adapter plan.')
    }
    return {
      source: { path: plan.source.path, sha256: plan.source.sha256, bytes: plan.source.bytes },
      skill: { name: plan.skill.name, destination: plan.skill.destination },
    }
  },
  parseBindings(value) {
    if (!isPlainObject(value) || !hasExactKeys(value, LOCAL_BINDING_KEYS)) return null
    const source = value.source
    const skill = value.skill
    if (
      !isPlainObject(source) ||
      !hasExactKeys(source, LOCAL_SOURCE_KEYS) ||
      typeof source.path !== 'string' ||
      typeof source.sha256 !== 'string' ||
      typeof source.bytes !== 'number'
    ) {
      return null
    }
    if (
      !isPlainObject(skill) ||
      !hasExactKeys(skill, LOCAL_SKILL_KEYS) ||
      typeof skill.name !== 'string' ||
      typeof skill.destination !== 'string'
    ) {
      return null
    }
    return { source, skill }
  },
  planFromBindings(repository, bindings) {
    const parsed = LOCAL_SKILL.parseBindings(bindings)
    if (parsed === null) throw new AnvilError(ErrorCode.Internal, 'The local-skill bindings are malformed.')
    const source = parsed.source as { path: string }
    const skill = parsed.skill as { name: string }
    return buildSetupExecutionPlan({ repository, sourcePath: source.path, name: skill.name })
  },
  subject(plan) {
    if (plan.adapter !== LOCAL_SKILL_ADAPTER) {
      throw new AnvilError(ErrorCode.Internal, 'The local-skill adapter received another adapter plan.')
    }
    return { kind: 'skill', id: plan.skill.name, destination: plan.skill.destination }
  },
  approvedArtifact(bindings) {
    const parsed = LOCAL_SKILL.parseBindings(bindings)
    if (parsed === null) return null
    const source = parsed.source as { path: string; sha256: string; bytes: number }
    const skill = parsed.skill as { name: string; destination: string }
    return { kind: 'skill', id: skill.name, destination: skill.destination, sha256: source.sha256, bytes: source.bytes }
  },
}

/** `pinned-skill/v1`: install one SKILL.md pinned to a GitHub commit, from the protected cache. */
const PINNED_SKILL: SetupAdapterDefinition = {
  id: PINNED_SKILL_ADAPTER,
  cliName: 'pinned-skill',
  fingerprint: PINNED_SKILL_ADAPTER_FINGERPRINT,
  parseRequest: parsePinnedSkillRequest,
  extractRequest: extractPinnedSkillRequest,
  build(repository, request, options) {
    return buildPinnedSkillPlan({
      repository,
      request: pinnedRequest(request),
      ...(options?.env === undefined ? {} : { env: options.env }),
    })
  },
  operations: (plan) => plan.operations,
  resolve: (saved, repository, options) => resolvePinnedSkillPlan(saved, repository, options?.env ?? process.env),
  bindings(plan) {
    if (plan.adapter !== PINNED_SKILL_ADAPTER) {
      throw new AnvilError(ErrorCode.Internal, 'The pinned-skill adapter received another adapter plan.')
    }
    return { ...pinnedSkillBindings(plan) }
  },
  parseBindings(value) {
    const parsed = parsePinnedSkillBindings(value)
    return parsed === null ? null : { ...parsed }
  },
  planFromBindings(repository, bindings, options) {
    const parsed = parsePinnedSkillBindings(bindings)
    if (parsed === null) throw new AnvilError(ErrorCode.Internal, 'The pinned-skill bindings are malformed.')
    return buildPinnedSkillPlan({
      repository,
      request: pinnedSkillRequestFromBindings(parsed),
      ...(options?.env === undefined ? {} : { env: options.env }),
    })
  },
  subject(plan) {
    if (plan.adapter !== PINNED_SKILL_ADAPTER) {
      throw new AnvilError(ErrorCode.Internal, 'The pinned-skill adapter received another adapter plan.')
    }
    return { kind: 'skill', id: plan.skill.name, destination: plan.skill.destination }
  },
  approvedArtifact(bindings) {
    const parsed = parsePinnedSkillBindings(bindings)
    if (parsed === null) return null
    return {
      kind: 'skill',
      id: parsed.skill.name,
      destination: parsed.skill.destination,
      sha256: parsed.content.sha256,
      bytes: parsed.content.bytes,
    }
  },
}

/** Every registered adapter, keyed by its CLI name. */
const REGISTRY: Record<SetupAdapterName, SetupAdapterDefinition> = {
  'local-skill': LOCAL_SKILL,
  'pinned-skill': PINNED_SKILL,
}

/** The supported `--adapter` values, for error text and usage. */
export function setupAdapterList(): string {
  return SETUP_ADAPTERS.join(', ')
}

/**
 * Resolve a CLI adapter name to its registered definition.
 *
 * An unknown or unregistered name is a usage error that names what *is* supported, rather
 * than silently falling back to an adapter the reviewer did not ask for.
 */
export function resolveSetupAdapter(name: string): SetupAdapterDefinition {
  const definition = Object.hasOwn(REGISTRY, name) ? REGISTRY[name as SetupAdapterName] : undefined
  if (definition === undefined) {
    throw new AnvilError(ErrorCode.Usage, `Unsupported setup adapter "${name}"`, {
      hint: `Use --adapter ${setupAdapterList()}.`,
    })
  }
  return definition
}

/** The adapter registered for a plan's stable id, or null. */
export function findSetupAdapterById(id: string): SetupAdapterDefinition | null {
  for (const name of SETUP_ADAPTERS) {
    if (REGISTRY[name].id === id) return REGISTRY[name]
  }
  return null
}

/** The adapter that owns a saved plan's `adapter` id, or null when it is not registered. */
export function findSetupAdapterForPlan(saved: unknown): SetupAdapterDefinition | null {
  if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) return null
  const adapter = (saved as Record<string, unknown>).adapter
  if (typeof adapter !== 'string') return null
  return findSetupAdapterById(adapter)
}

function invalidResolution(reason: string): SetupExecutionPlanResolution {
  return {
    plan: null,
    validation: {
      schemaVersion: 1,
      status: 'invalid',
      approval: 'not-granted',
      executed: false,
      reason,
    },
  }
}

/**
 * Resolve a saved plan through its registered adapter.
 *
 * Dispatch happens on the untrusted plan's `adapter` id, but the adapter then rebuilds from
 * bounded inputs, so a plan cannot choose its own authority or supply its own destination.
 */
export function resolveSetupPlan(
  saved: unknown,
  repository: SetupRepositoryState,
  options: SetupAdapterBuildOptions = {},
): SetupExecutionPlanResolution {
  const adapter = findSetupAdapterForPlan(saved)
  if (adapter === null) return invalidResolution('Unsupported setup execution adapter.')
  try {
    return adapter.resolve(saved, repository, options)
  } catch (cause) {
    if (cause instanceof SetupExecutionError) {
      return {
        plan: null,
        validation: {
          schemaVersion: 1,
          status: cause.validationStatus,
          approval: 'not-granted',
          executed: false,
          reason: cause.message,
        },
      }
    }
    if (cause instanceof AnvilError) return invalidResolution(cause.message)
    throw cause
  }
}
