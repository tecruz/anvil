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

Report: correctness problems, missing edge cases, and anything that would be
hard to review. If the diff touches a high-risk path, say so explicitly.
