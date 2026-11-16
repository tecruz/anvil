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
 * `local-skill/v1` is the only registered adapter in this slice. Its plan bytes, behaviour
 * fingerprint and v1 grant bytes are unchanged by being routed through the registry.
 */
import { AnvilError, ErrorCode } from '@anvil/core'
import type { SetupRepositoryState } from './setup.ts'
import {
  buildSetupExecutionPlan,
  extractSetupExecutionRequest,
  LOCAL_SKILL_ADAPTER,
  LOCAL_SKILL_ADAPTER_FINGERPRINT,
  resolveSetupExecutionPlan,
  SetupExecutionError,
  type SetupExecutionOperation,
  type SetupExecutionPlan,
  type SetupExecutionPlanResolution,
  type SetupExecutionRequest,
} from './setup-execution.ts'

/** The CLI names a reviewer passes to `--adapter`. The list is closed. */
export const SETUP_ADAPTERS = ['local-skill'] as const
export type SetupAdapterName = (typeof SETUP_ADAPTERS)[number]

/**
 * One registered adapter.
 *
 * `Plan` is the adapter's own plan shape; the common envelope is shared, and adapter-specific
 * fields sit beside it. `Request` is the bounded input set that is saved in a plan and
 * extracted again before any filesystem read.
 */
export interface SetupAdapterDefinition<
  Request = SetupExecutionRequest,
  Plan extends SetupExecutionPlan = SetupExecutionPlan,
> {
  /** Stable plan adapter id, for example `local-skill/v1`. */
  id: string
  /** The CLI name, which must be one entry of {@link SETUP_ADAPTERS}. */
  cliName: SetupAdapterName
  /** Digest of the behaviour descriptor; a change invalidates prior approvals. */
  fingerprint: string
  /** Validate CLI values and return only the bounded adapter inputs. */
  parseRequest(values: Record<string, unknown>): Request
  /** Recover the same bounded inputs from an untrusted saved plan. */
  extractRequest(saved: unknown): Request
  /** Build an inspect-only plan. Never writes and never touches the network. */
  build(repository: SetupRepositoryState, request: Request): Plan
  /** The declarative operations the framework executes, in order. */
  operations(plan: Plan): readonly SetupExecutionOperation[]
  /** Rebuild a saved plan from its bounded inputs and compare it with current state. */
  resolve(saved: unknown, repository: SetupRepositoryState): SetupExecutionPlanResolution
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
    return buildSetupExecutionPlan({ repository, sourcePath: request.sourcePath, name: request.name })
  },
  operations: (plan) => plan.operations,
  resolve: resolveSetupExecutionPlan,
}

/** Every registered adapter, keyed by its CLI name. */
const REGISTRY: Record<SetupAdapterName, SetupAdapterDefinition> = {
  'local-skill': LOCAL_SKILL,
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

/** The adapter that owns a saved plan's `adapter` id, or null when it is not registered. */
export function findSetupAdapterForPlan(saved: unknown): SetupAdapterDefinition | null {
  if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) return null
  const adapter = (saved as Record<string, unknown>).adapter
  if (typeof adapter !== 'string') return null
  for (const name of SETUP_ADAPTERS) {
    if (REGISTRY[name].id === adapter) return REGISTRY[name]
  }
  return null
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
export function resolveSetupPlan(saved: unknown, repository: SetupRepositoryState): SetupExecutionPlanResolution {
  const adapter = findSetupAdapterForPlan(saved)
  if (adapter === null) return invalidResolution('Unsupported setup execution adapter.')
  try {
    return adapter.resolve(saved, repository)
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
