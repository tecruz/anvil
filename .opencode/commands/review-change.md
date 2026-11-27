---
description: Review the current diff against the project test and lint results
---

Review the current diff for correctness before it is proposed.

Recent commits:
!`git log --oneline -10`

Test results:
!`npm run test`

Lint results:
!`npm run lint`

Treat what the code does as evidence of the current implementation; it does not by
itself define intended product behavior. If the diff depends on an undocumented
business expectation, name it as an open question instead of inventing an answer.

If the intent is unclear, ask: What intended product behavior and acceptance criteria should guide changes?

Report: correctness problems, missing edge cases, and anything that would be
hard to review. If the diff touches a high-risk path, say so explicitly.
