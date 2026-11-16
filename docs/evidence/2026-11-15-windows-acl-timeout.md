# Windows ACL timeout follow-up — 2026-11-15

## What failed

The 2026-11-14 merge-gate run 43640518600 (job 132586862144) failed one Windows test,
`packages/derive/test/setup-apply.test.ts:146`, after 20,053 ms with `PREFLIGHT_FAILED`:
"The approval directory access control list cannot be read". The duration was consistent
with the fixed 20-second `timeout` on the Windows ACL tool, but the log could not prove a
timeout: `runWindowsTool` caught every error and returned `null`, so a slow runner and a
genuinely unreadable ACL produced the same refusal. The failure is tracked as issue #45.

## What changed

- The default bound is now `WINDOWS_TOOL_TIMEOUT_MS` (60 seconds) instead of 20 seconds.
  It remains finite and bounded.
- `ANVIL_APPROVAL_TOOL_TIMEOUT_MS` is a process-level override, bounded to 1–300,000 ms.
  It exists for a slow Windows host and to exercise the timeout branch in a test without
  waiting a minute. It is not repository configuration, and an invalid value falls back to
  the default rather than removing the bound.
- `runWindowsTool` classifies `ETIMEDOUT`, and the ACL reader carries that classification
  through to the refusal message. A timeout now reads "could not be read within N ms; it
  is refused rather than trusted", while a non-timeout failure keeps "cannot be read".
  A store-hardening timeout is reported separately as well.
- The apply command's repository-lock wait is now 120 seconds rather than the 20-second
  default. The holder performs several bounded ACL operations, so the old wait could expire
  while it was still working on a loaded runner. The wait remains bounded and grants no
  authority.
- Fail-closed behaviour is unchanged. A timeout is still `unknown` (never `active`), a
  save still refuses after removing the directories it created, and no ACL is repaired.

## Local verification

Run on Windows x64, Node `v24.13.0`:

```text
node --test --test-reporter=spec packages/derive/test/setup-approval.test.ts
  28 tests, 24 pass, 0 fail, 4 skipped (POSIX-only)

node --test --test-reporter=spec packages/derive/test/setup-apply.test.ts
  24 tests, 24 pass, 0 fail, 0 skipped

node --test --test-reporter=spec --test-name-pattern="exceeds its bound|hardening timeout" packages/derive/test/setup-approval.test.ts
  2 tests, 2 pass, 0 fail
```

The new tests force a 1 ms bound. The read test asserts the result is `unknown` with a
timeout message and not the unreadable message, then that the same store becomes `active`
again once the bound is restored. The hardening test asserts the refusal and that the store
directory created by the attempt is removed.

## Root cause: the 20-second tool bound, not an unreadable ACL

Recorded 2026-11-16 from the original job log and every `windows-latest` CI job since the
fix merged. No run was triggered or re-run for this record; every row below is an ordinary
pull-request or `main` run.

The original failure is a timeout. The stack in job 132586862144 shows the refusal came
from the test fixture's first approval-store setup (`setup-apply.test.ts:69` →
`prepareSetupApprovalStore` → `ensureStoreRoot` at `setup-approval.ts:749`, the protection
read right after the store was created and hardened). The whole test, fixture included,
took 20,053 ms; the per-call bound was `timeout: 20_000` (`setup-approval.ts:514` at
`f0c28c9`). So the failing ACL read itself ran for roughly 20 seconds, and all other work
in the test fit in the remaining ~53 ms. A genuinely unreadable ACL makes PowerShell exit
with an error when it reaches the read, at whatever time its start-up took; ending 53 ms
after the kill deadline would be a coincidence, while a kill at the deadline is expected.
The read was killed by the bound on a slow runner, and the old `runWindowsTool` reported the
kill as "cannot be read". This is an inference from timing and the call stack, because the
old code discarded the error; the code that replaced it (#57, #62) now reports a timeout
as "could not be read within N ms" so a recurrence names itself.

How long the test normally takes: in the 24 green `windows-latest` jobs below, "applies a
current plan once…" took 10.4–20.4 s (median about 14.4 s) for the whole test, which runs
several PowerShell ACL reads and hardenings, each a cold PowerShell start. On a loaded
two-core runner one such start reaching 20 s is plausible, and that is the failure seen.

## Stability since the fix

Every CI run on a commit containing `465c1ce` (the 60-second bound), oldest first. Both
Windows legs passed in each; the duration is the test above.

| Run | Commit | Branch | `windows-latest` | `windows-latest (Node LTS)` |
|---|---|---|---|---|
| 43737538331 | `465c1ce` | main | 10.9 s | 12.9 s |
| 43742764097 | `29d4bde` | feat/42-context-questions | 13.2 s | 16.4 s |
| 43748807543 | `01bb28a` | main | 15.0 s | 17.8 s |
| 43749095812 | `5ed3ea4` | fix/ready-requirement-ids | 12.9 s | 11.0 s |
| 43751638005 | `3c5ebf2` | fix/ready-requirement-ids | 20.4 s | 15.7 s |
| 43752856882 | `b1bfe0d` | fix/ready-requirement-ids | 15.2 s | 14.3 s |
| 43756505868 | `fdb240e` | main | 14.6 s | 13.2 s |
| 43763421018 | `1cd5f49` | feat/github-issues-selection | 10.4 s | 17.8 s |
| 43765514563 | `84b3b7c` | fix/60-acl-timeout-reasons | 11.7 s | 12.3 s |
| 43772328231 | `6c6db17` | fix/60-acl-timeout-reasons | 16.5 s | 16.6 s |
| 43773323490 | `79b7acd` | main | 14.5 s | 16.1 s |
| 43779655744 | `d0b9065` | feat/github-issues-selection | 11.9 s | 13.9 s |

That is 12 consecutive runs and 24 consecutive Windows jobs, with no failure of any
setup-approval or setup-apply test and no timeout message. It is evidence of stability on
the runners this repository actually uses, not proof that a slower host can never reach 60
seconds; a host that does is refused with the timeout named, and
`ANVIL_APPROVAL_TOOL_TIMEOUT_MS` raises the bound for it.

## Fail-closed behaviour

Unchanged. A timeout is still `unknown`, never `active`; a store or record whose protection
cannot be confirmed in time is refused, and nothing is repaired. Only the bound and the
message changed.
