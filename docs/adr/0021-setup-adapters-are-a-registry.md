# ADR-0021: Setup adapters are a closed registry, and they never write

- Status: accepted
- Date: 2026-11-16
- Milestone: post-M6
- Extends: [ADR-0018](0018-approved-local-skill-installation.md), [ADR-0019](0019-approval-authority-is-a-user-owned-store.md), [ADR-0020](0020-application-is-a-journaled-transition.md)

## Context

ADR-0018, ADR-0019 and ADR-0020 built one complete integration path: `local-skill/v1` plans
one create-only copy, approval is a single-use grant in a user-owned store, and application
is a journaled transition with an independent verifier. Issue #41 asks for that contract to
hold on more than one supported integration path, and names discovery-resource approval and
a reviewable configuration diff as the gaps.

The implementation had grown a second, implicit registry: the adapter name was a constant,
the CLI compared it by hand in three places, the grant parser hard-rejected every other id,
and plan resolution called the local-skill builder directly. Adding a second adapter that way
would mean editing the CLI, the grant parser and the journal parser independently. Each edit
is a place where a new adapter can be wired into planning while skipping approval, or into
application while skipping the verifier.

There is also a correctness trap in the existing writer. `local-skill` reports `mutated`
only after a publish returns, so an exception inside the publisher is classified `failed`
even though the destination may already exist. The earlier directory creation saves that
case today, but the framework must not depend on an adapter's internal ordering to decide
whether the repository changed.

## Decision

**Every executable setup adapter is registered in one closed list, and adapters describe
work rather than performing it.**

- `packages/derive/src/setup-adapters.ts` names every adapter (`SETUP_ADAPTERS`), resolves a
  CLI name (`resolveSetupAdapter`), resolves a saved plan's adapter id
  (`findSetupAdapterForPlan`, `resolveSetupPlan`) and is the only place that dispatches on an
  adapter. An unknown name is a usage error that names the supported list; an unknown plan
  adapter is an `invalid` plan, never a fallback.
- An adapter declares its stable id (`local-skill/v1`), its CLI name, its behaviour
  fingerprint, how to validate CLI inputs and recover the same bounded inputs from untrusted
  saved JSON, how to build an inspect-only plan, and the ordered declarative operations that
  plan contains. The framework owns locking, revalidation, grant consumption, the journal,
  mutation and verification.
- **Adapters do not write and do not open network connections.** `local-skill` already reads
  only a repository-relative regular file. A future adapter that needs remote bytes must
  fetch them in a separate explicit command and plan from a frozen, content-addressed record,
  so `plan`, `validate`, `approve` and `apply` stay offline.
- **The fingerprint is a contract.** A golden test pins `local-skill`'s fingerprint and the
  plan envelope, so an accidental descriptor or field change fails instead of silently
  keeping old approvals valid. Changing adapter behaviour and changing the golden value are
  the same commit.
- **Existing local-skill bytes do not change.** Plans, the behaviour fingerprint and v1 grant
  records are byte-identical; saved plans and in-flight grants remain valid. `local-skill`
  continues to write v1 grants. A generic v2 grant and journal, with adapter-specific
  `bindings` and a per-operation `attempting` state, are added for adapters that need them
  rather than retrofitted onto the shipped v1 path.
- **Failure classification belongs to the framework.** Once a mutating primitive reaches
  `attempting`, an exception is `partial`; `failed` is reserved for a known no-mutation
  outcome. An adapter cannot report `failed` on the framework's behalf. The legacy
  `local-skill` writer keeps its current classification until the generic writer replaces it
  in the adapter that needs it, and that difference is documented.
- **`init --apply` and `playbook add` are not setup adapters.** They keep their own
  contracts. `init --apply` is a reviewed-diff staging lifecycle with best-effort rollback;
  `playbook add --force` is a user-scope registry edit. Neither gains a setup grant by
  proximity.

## Consequences

- A new adapter cannot reach the CLI, grant parser or journal parser without being added to
  the registry; the registry is the list of supported integration paths.
- Plan resolution and grant grading have one dispatch point, so a plan naming an
  unregistered adapter is refused consistently in `validate`, `approve` and `apply`.
- The CLI's `--adapter` error now names the supported list instead of one hard-coded name.
  This is the only user-visible change of the refactor.
- The registry stores a fingerprint per adapter, but v1 grants remain local-skill-only. A v2
  grant must bind the adapter's canonical binding object, recompute its binding digest on
  read and compare it with the rebuilt plan; the registry supplies the parse and bind
  functions rather than each command re-implementing them.
- Testability improves: the registry can be exercised without a terminal or a repository
  write, and each adapter's failure boundaries can be driven through the same framework.
- The adapter interface is deliberately narrow. It cannot express install scripts, package
  manager calls, service starts or arbitrary file writes, because those effects cannot be
  named, hashed and verified by the contract that already exists.

## Alternatives rejected

- **Keep per-command adapter checks.** Three independent comparisons are three chances to
  forget one; a second adapter would be planned by one command and rejected by another.
- **Let an adapter implement its own apply.** That moves locking, grant consumption and
  failure classification into every adapter, and makes "every adapter journals before its
  first mutation" unverifiable.
- **Add a generic "run this command" adapter.** Its permissions, network access and file
  effects are unknowable from the command text, and approval would launder that ignorance.
  ADR-0018 rejected this for the same reason.
- **Migrate local-skill to a new grant shape now.** It would invalidate in-flight grants and
  saved plans for no gain, and it would make this refactor a behavioral change rather than a
  structural one. v1 stays readable.
- **Treat `init --apply` as an adapter.** It already has a reviewed-diff lifecycle, replaces
  files and rolls back; forcing it into create-only grant semantics would change a heavily
  used command to satisfy a naming preference.
