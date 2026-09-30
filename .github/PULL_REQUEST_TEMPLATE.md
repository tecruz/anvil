<!--
  What a reviewer needs from an anvil PR, in the order they need it.

  Every section below maps to something anvil checks or does, so a complete template here
  produces a complete `anvil ship` later. An empty section is a signal: if "How this was
  verified" is empty, nobody ran anything, and the reviewer has to guess.
-->

## What this changes

<!-- One or two sentences. What an agent needs to know to work on this next? -->

Closes #

## Why

<!-- The problem, not the solution. Link the ticket if there is one. -->

## How this was verified

<!--
  The command, and its result. anvil reads this back when it generates a PR, and CI
  re-runs exactly these commands -- `CI_PARITY` checks that what is documented here is
  what CI actually runs, so a divergence is reported rather than discovered in review.
-->

- [ ] `npm run check` (lint, typecheck, suite, build)
- [ ] or: the project's own `npm test`, plus what it does not cover

## Risk

<!--
  An agent should not have to work this out. If the diff touches a path the project
  marks as high risk -- migrations, IaC, CI, lockfiles, auth -- say so here and say what
  you did about it. anvil adds the same checklist automatically when the repository
  documents its risk map in `AGENTS.md`.
-->

- [ ] No high-risk paths touched
- [ ] High-risk paths touched, and named here:

## Notes for the reviewer

<!--
  Anything that is not obvious from the diff: a workaround, a thing deliberately left
  out, a follow-up that should be a separate ticket. The most common useful entry here is
  "here is what I could not verify".
-->

- [ ] Nothing to add
