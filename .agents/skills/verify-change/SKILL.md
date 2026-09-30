---
name: verify-change
description: Run this repository's own verification commands before claiming a change is done. Use it after any code edit, before reporting completion.
---

# Verifying a change

1. Run the changed-files subset first:
```bash
npm run test:changed
```

2. Run the full suite before you claim the work is done:
```bash
npm run test
```

3. Lint:
```bash
npm run lint
```

If a command fails, fix the cause rather than the assertion. If a command is wrong,
say so explicitly instead of reporting a green run you did not observe.
