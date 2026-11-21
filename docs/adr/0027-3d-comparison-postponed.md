# ADR-0027: The 3D comparison is postponed

- Status: accepted
- Date: 2026-11-21

## Context

Issue #89 proposed a 3D projection behind a flag, evaluated against list + 2D on the same
first-contribution tasks. Issue #91 requires a separate comparison record and an ADR before any
default changes. The pilot worktree has pinned ground-truth cards and hermetic scenarios, but it
has no 3D prototype, no participant workflow, and no comparative measurements. The maintainer
confirmed on 2026-11-21 that the 3D decision should be postponed.

A 3D view would add a new rendering path to a single-file, dependency-free dashboard. Without a
shared graph renderer and measured tasks, a prototype could not be compared fairly with the
existing list and task-centred 2D view. Treating preference or an unattended agent run as evidence
would violate the pilot's measurement rules.

## Decision

Do not build or enable 3D as part of this pilot. Keep the list and task-centred 2D map as the only
supported views. Record the absence of a 3D prototype, participants and comparative results as
insufficient evidence, not as a negative verdict. Revisit 3D only after all of the following exist:

1. a flagged prototype sharing the same graph data and evidence links as the 2D view;
2. a predeclared comparison protocol with participants new to the three fixtures;
3. time-to-module, time-to-verification-path and accuracy measurements for both conditions; and
4. a separate comparison record demonstrating that 3D beats list + 2D without an accuracy
   regression.

No default changes until a new ADR accepts that evidence.

## Consequences

- ADR-0025's read-only dashboard boundary is unchanged; this ADR does not ship or enable a view.
- The task-centred 2D map exists only on the unmerged `feat/task-brief` branch at this decision.
- The #91 real-agent pilot run compared Anvil-generated CLI context with a bare checkout; it did not exercise the 2D map or 3D.
- The pilot report must say `insufficient evidence` for the visualization question.
- Future 3D work is a separate, opt-in experiment with its own review and evidence.

## Alternatives rejected

- **Ship 3D behind a flag without evaluation**: the flag would create a second rendering path and
  an unmeasured claim.
- **Use the agent pilot as a 3D comparison**: the existing scenarios do not exercise a 3D view, and
  an unattended agent is not the participant population the question requires.
- **Infer a verdict from preference**: preference is not time-to-module or accuracy evidence.
