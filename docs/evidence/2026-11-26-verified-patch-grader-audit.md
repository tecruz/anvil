# 2026-11-26 — verified-patch grader audit

Status: **harness defect found and fixed; no study rerun and no new effectiveness claim.**

The [pilot results](2026-11-26-verified-patch-results.md) reported five pairs where neither arm
solved `node-tiny-slugify`. Before interpreting those failures as evidence about the workflows,
the grader was audited offline. No model was called and the predeclared stop rule was not
revisited.

## Finding 1 — the second task's check could never pass

The broker executes the captured `verifyScript` with
`node --input-type=module --eval <source>`. The manifest named `package.json` as that script:

```
"name": "node-tiny",
        ^
SyntaxError: Unexpected token ':'
```

The JSON manifest is data, not a program. Execution exited 1 for every arm, while grading
requires an attested execution with `exitCode === 0`. **No correct patch could satisfy that
condition**, so the five "neither succeeded" pairs are harness failures, not agent failures.
The results document already declined to attribute them; this makes the reason concrete.

Preflight missed it because it only checked that hidden acceptance failed on the base and
passed with the reference fix -- it never executed the broker's captured script.

## Finding 2 — the assisted arm was context-only

The assisted arm ran `anvil init` and `anvil init --apply` and wrote a hand-built
`.anvil/ticket.md`. It never called `claim`, `crew up`, `crew verify --record` or `ship`. The
[pilot plan](2026-11-26-verified-patch-pilot-plan.md) already declared this explicitly, so the
run was a context-only comparison, not the real claim-to-verification workflow. No result from
it can support a claim about evidence recording or shipping.

## Fix

- Added `eval/repos/node-tiny/verify.js`, a real ES-module script that runs the fixture's
  visible check, and pointed `eval/verified-patch-tasks.json` at it.
- Added `verifyScriptExecutable()` to `scripts/verified-patch-run.ts`. Preflight now parses the
  captured source as an ES module and refuses a task whose check is not executable JS. A
  negative-control test pins the regression by naming `package.json` as the script.
- The ticket bundle now renders the shared `@anvil/profile` verification plan, and `ship`
  pins the verified commit, so a future study can stage a real claim whose guidance and
  runner agree before any effectiveness question is asked again.

## Consequence

The pilot verdict stands: **insufficient evidence**, with one saturated task and one impossible
task. Nothing here changes the direction claim. Any further effectiveness study needs a new
predeclared design, with a preflight that exercises the broker and a real claim lifecycle.
