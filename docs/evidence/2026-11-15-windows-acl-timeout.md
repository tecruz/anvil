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

## Most likely cause: the 20-second tool bound

Recorded 2026-11-16 from the original job log and every CI run since the fix merged. No run
was triggered or re-run for this record; every run below is an ordinary pull-request or
`main` run, attempt 1.

The evidence points to the 20-second bound, but it cannot prove it. What the log shows:

- The refusal came from the test fixture's first approval-store call
  (`setup-apply.test.ts:69` → `prepareSetupApprovalStore` → `ensureStoreRoot`, refusing at
  `setup-approval.ts:749` at `f0c28c9`). The fixture creates the store directory with
  `mkdtempSync` before that call, so `ensureStoreRoot` skipped hardening and the refusal is
  the first protection read of an existing directory: one PowerShell invocation
  (`readWindowsAcl`). No other Windows tool had been started in that test.
- The whole test took 20,053 ms, and the per-call bound was `timeout: 20_000`
  (`setup-approval.ts:514` at `f0c28c9`). That is a whole-test duration, not a measured
  subprocess duration, but the only work before the refusal was file-system set-up and
  that one call, so the call itself most likely ran for close to 20 seconds.
- A read that fails for another reason (PowerShell exits with an error, or prints output
  `readWindowsAcl` cannot use) ends whenever PowerShell finishes; ending this close to the
  kill deadline would be a coincidence. A kill at the deadline is the expected outcome of
  a slow start or a stalled query.

What it cannot show: the old `runWindowsTool` discarded the error (`setup-approval.ts:509-520`
at `f0c28c9`), so there is no recorded `ETIMEDOUT`, exit code or subprocess timing, and even a
confirmed timeout would not say whether PowerShell start-up or the ACL query itself was slow.
The conclusion is therefore "most likely a timeout of that single ACL read", not a proven
cause, and nothing recorded later can prove what that historical call did. The code that
replaced it (#57, #62) reports a timeout as "could not be read within N ms", so a future
failure of this kind will at least say which kind it is.

How long the affected test normally takes: in the 26 green Windows jobs below, "applies a
current plan once…" took 10.4–20.4 s (median 14.5 s) for the whole test,
which starts PowerShell for each ACL read and `icacls.exe` for each hardening.

## Stability since the fix

Every run of the CI workflow (`ci.yml`) from `465c1ce` (the 60-second bound) merging on
2026-11-15 16:48 UTC up to this record, oldest first. The inventory comes from
`gh run list --workflow ci.yml`, which lists exactly these 13 runs in that window, each
`completed`, `success` and attempt 1 (no re-run, failure or cancellation); the per-job data
comes from each job's log. Every run is on a commit that contains `465c1ce`.
Each cell is the job id, its conclusion, the affected test's duration and the full suite's
`ℹ tests` and `ℹ fail` totals from that job's log.

| Run | Commit | Branch | `windows-latest` | `windows-latest (Node LTS)` |
|---|---|---|---|---|
| 43737538331 | `465c1ce` | main | 132883346806: success, 10.9 s, 1884 tests, 0 failed | 132883346767: success, 12.9 s, 1884 tests, 0 failed |
| 43742764097 | `29d4bde` | feat/42-context-questions | 132899336195: success, 13.2 s, 1894 tests, 0 failed | 132899336286: success, 16.4 s, 1894 tests, 0 failed |
| 43748807543 | `01bb28a` | main | 132917953050: success, 15.0 s, 1894 tests, 0 failed | 132917953001: success, 17.8 s, 1894 tests, 0 failed |
| 43749095812 | `5ed3ea4` | fix/ready-requirement-ids | 132918830665: success, 12.9 s, 1898 tests, 0 failed | 132918830816: success, 11.0 s, 1898 tests, 0 failed |
| 43751638005 | `3c5ebf2` | fix/ready-requirement-ids | 132926680571: success, 20.4 s, 1911 tests, 0 failed | 132926680357: success, 15.7 s, 1911 tests, 0 failed |
| 43752856882 | `b1bfe0d` | fix/ready-requirement-ids | 132930439770: success, 15.2 s, 1911 tests, 0 failed | 132930439718: success, 14.3 s, 1911 tests, 0 failed |
| 43756505868 | `fdb240e` | main | 132941658568: success, 14.6 s, 1911 tests, 0 failed | 132941658507: success, 13.2 s, 1911 tests, 0 failed |
| 43763421018 | `1cd5f49` | feat/github-issues-selection | 132963059895: success, 10.4 s, 1972 tests, 0 failed | 132963059883: success, 17.8 s, 1972 tests, 0 failed |
| 43765514563 | `84b3b7c` | fix/60-acl-timeout-reasons | 132969591598: success, 11.7 s, 1914 tests, 0 failed | 132969591585: success, 12.3 s, 1914 tests, 0 failed |
| 43772328231 | `6c6db17` | fix/60-acl-timeout-reasons | 132990800620: success, 16.5 s, 1914 tests, 0 failed | 132990800604: success, 16.6 s, 1914 tests, 0 failed |
| 43773323490 | `79b7acd` | main | 132993875504: success, 14.5 s, 1914 tests, 0 failed | 132993875555: success, 16.1 s, 1914 tests, 0 failed |
| 43779655744 | `d0b9065` | feat/github-issues-selection | 133013725365: success, 11.9 s, 1997 tests, 0 failed | 133013725153: success, 13.9 s, 1997 tests, 0 failed |
| 43785562890 | `5e3cb6d` | docs/45-windows-acl-evidence | 133032285378: success, 14.5 s, 1914 tests, 0 failed | 133032285534: success, 16.6 s, 1914 tests, 0 failed |

That is 13 consecutive CI runs and 26 consecutive Windows jobs, each with zero failed tests
and no "could not be read within" or "could not be restricted within" message in its log.
It is evidence of stability on the runners this repository actually uses, not proof that a
slower host can never reach 60 seconds; a host that does is refused with the timeout named,
and `ANVIL_APPROVAL_TOOL_TIMEOUT_MS` raises the bound for it.

## Fail-closed behaviour

Unchanged. A timeout is `unknown`, never `active`; a store or record whose protection cannot
be confirmed in time is refused, and nothing is repaired. On 2026-11-16 one more path was
aligned: when a reservation loses a race to another transition, `consumeSetupApproval`
re-reads the winner's record and, if that read times out or cannot be inspected, now reports
status `unknown` with the reason instead of status `consumed` and "This grant has already been
used." Both refuse the attempt (`reserved: false`). The visible difference is in reporting:
with no application journal, `anvil setup apply` now returns a refusal naming the inspection
problem rather than `interrupted` ("already reserved"), because nothing shows the attempt
was reserved. No path gains authority and nothing is repaired.
