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

## What still needs Windows CI evidence

The local suite cannot reproduce a loaded two-core CI runner, and the original failure was
intermittent. Stability is therefore **not yet established** by a local run. It needs
several consecutive green `windows-latest` runs of the full required check, especially
`setup-apply.test.ts`; only the maintainer can trigger those workflow runs. Until that
evidence exists, this document records a bounded and better-diagnosed timeout, not proof
that the flake is gone. No workflow file was changed.
