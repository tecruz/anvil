# Security policy

> **This file is a template. Replace the contact address before publishing.**
>
> A security contact that is not monitored is worse than none: a researcher who mails a
> real vulnerability and gets nothing back concludes the project is not worth reporting to.
> Fill in the address below, and prefer a dedicated inbox over a personal one.

## Reporting a vulnerability

Report it privately to **TODO: security contact address** (a dedicated inbox such as
`security@TODO-DOMAIN`). Please do not open a public issue for a vulnerability.

Include, as far as you can:

- what anvil does, and the version or commit you tested
- the repository and command that triggered it
- the actual impact: what is read or written, and where
- a reproduction, ideally the smallest one

## What to expect

- an acknowledgement within a few working days
- an assessment once the report has been reproduced, with an estimate if a fix is needed
- credit in the fix's commit message unless you would rather not be named

## Threat model

Worth knowing before reporting, because it is where judgement is needed:

**In scope.** anvil runs commands, reads ticket text and repository content, and writes
files. The interesting cases are the ones where untrusted input crosses a boundary:

- a malicious repository, playbook or ticket body influencing what anvil executes or writes
- path traversal from ticket ids, playbook paths or staging manifests
- the `gh` transport building a command line from ticket-controlled text
- the Windows `.cmd` shim path, which refuses rather than escapes unsafe arguments

**Out of scope.** Running anvil in a repository you do not trust *as yourself* -- anvil
executes that repository's own verify commands, which is inherent to what it does, and is
why the plan treats "you do not own these repos" as the design constraint rather than an
edge case. Also out of scope: vulnerabilities in `gh`, `git`, or a package manager anvil
invokes.
