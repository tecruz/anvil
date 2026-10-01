/**
 * Python detector.
 *
 * Python's verification story is the messiest of the six: the test runner, the linter and
 * the type checker are all optional and all differently named, and the dominant failure
 * mode is a project with a `tests/` directory and no way to run it. So this detector
 * stays conservative -- it reports a command only when it can point at the definition.
 */

import { join } from 'node:path'
import {
  addCommand,
  addStack,
  addTool,
  type Detector,
  type DetectorContext,
  hasFile,
  hasFileUnder,
  hookFramework,
  type ProfileDraft,
  setMonorepo,
} from '../detector.ts'
import { evidence, findLine, looseVersion } from '../manifest.ts'
import { readText } from '../walk.ts'

/** Line-based readers for the flat formats Python uses. */
function readTomlish(ctx: DetectorContext, relPath: string): string | null {
  const { text } = readText(join(ctx.root, ctx.resolve(relPath)))
  return text
}

function depVersion(text: string, dep: string): string | null {
  // Match both PEP 621 `[project] dependencies = ["fastapi>=0.1"]` and requirement lines.
  //
  // The character class is written with **doubled** backslashes, and that is load-bearing.
  // In a template literal `\s` cooks to the letter `s` and `\]` cooks to `]`, so the
  // single-backslash spelling produced the regex `[^"'s,]]` -- which excludes the letter `s`
  // from the version and then requires a literal `]` after it. Every real version therefore
  // failed to capture (`4.2` gave `4.`, which `looseVersion` then rejected), so Python stack
  // versions were silently always null. The doubled spelling is what the regex engine needs.
  const escaped = dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`["'\\[]?${escaped}\\s*(?:[<>=!~]=?\\s*([0-9][^"'\\s,\\]]*))?`)
  const m = re.exec(text)
  return looseVersion(m?.[1] ?? null)
}

export const pythonDetector: Detector = {
  id: 'python',
  title: 'Python',
  priority: 50,

  matches(ctx) {
    return (
      hasFile(ctx, 'pyproject.toml') ||
      hasFile(ctx, 'requirements.txt') ||
      hasFile(ctx, 'setup.py') ||
      hasFile(ctx, 'setup.cfg') ||
      hasFile(ctx, 'Pipfile')
    )
  },

  detect(ctx, draft) {
    const pyproject = hasFile(ctx, 'pyproject.toml') ? readTomlish(ctx, 'pyproject.toml') : null

    if (pyproject !== null) {
      addStack(draft, {
        id: 'python',
        version: null,
        evidence: [evidence('pyproject.toml', findLine(pyproject, /^\s*requires-python/))],
      })

      // PEP 621 build backend is a strong project-shape signal.
      if (/\[\s*project\s*\]/.test(pyproject) || /\[project\]/.test(pyproject)) {
        addStack(draft, {
          id: 'pep621',
          version: null,
          evidence: [evidence('pyproject.toml', findLine(pyproject, /\[project\]/))],
        })
      }
      if (/\[tool\.(uv|poetry|hatch|flit|setuptools)\]/.test(pyproject)) {
        const line = findLine(pyproject, /\[tool\.(uv|poetry|hatch|flit|setuptools)\]/)
        addStack(draft, {
          id: 'uv-or-poetry',
          version: null,
          evidence: [evidence('pyproject.toml', line)],
        })
      }
      if (/\[tool\.pytest/.test(pyproject)) {
        addTool(draft, 'test', 'pytest')
        addCommand(draft, 'test', {
          cmd: 'pytest',
          source: 'detected',
          evidence: evidence('pyproject.toml', findLine(pyproject, /\[tool\.pytest/)),
        })
      }
      if (/\[tool\.ruff/.test(pyproject)) {
        addTool(draft, 'lint', 'ruff')
        addCommand(draft, 'lint', {
          cmd: 'ruff check .',
          source: 'detected',
          evidence: evidence('pyproject.toml', findLine(pyproject, /\[tool\.ruff/)),
        })
        addCommand(draft, 'format', {
          cmd: 'ruff format .',
          source: 'detected',
          evidence: evidence('pyproject.toml', findLine(pyproject, /\[tool\.ruff/)),
        })
      }
      if (/\[tool\.mypy/.test(pyproject)) {
        addTool(draft, 'typecheck', 'mypy')
        addCommand(draft, 'typecheck', {
          cmd: 'mypy .',
          source: 'detected',
          evidence: evidence('pyproject.toml', findLine(pyproject, /\[tool\.mypy/)),
        })
      }
      if (/\[tool\.black/.test(pyproject)) {
        addTool(draft, 'formatter', 'black')
        addCommand(draft, 'format', {
          cmd: 'black .',
          source: 'detected',
          evidence: evidence('pyproject.toml', findLine(pyproject, /\[tool\.black/)),
        })
      }
      // Build backends imply a build step.
      if (/\[build-system\]/.test(pyproject) && /requires\s*=/.test(pyproject)) {
        addCommand(draft, 'build', {
          cmd: 'python -m build',
          source: 'inferred',
        })
      }
    }

    if (hasFile(ctx, 'uv.lock')) {
      addStack(draft, { id: 'uv', version: null, evidence: ['uv.lock'] })
      setMonorepo(draft, { tool: 'uv', evidence: 'uv.lock', members: [] })
    }

    // Dependencies from the flat formats, so the stack list is comparable across ecosystems.
    const sources: Array<{ text: string; file: string }> = []
    for (const f of ['requirements.txt', 'requirements-dev.txt', 'setup.py', 'Pipfile', 'pyproject.toml']) {
      if (!hasFile(ctx, f)) continue
      const t = readTomlish(ctx, f)
      if (t !== null) sources.push({ text: t, file: f })
    }
    // Match the dependency wherever it is *declared*, which is mid-line in a PEP 621
    // `dependencies = ["django>=4.2"]` array and at the line start in a `requirements.txt`.
    // The old `^django` with no `m` flag meant "the file begins with django", so a framework
    // declared anywhere but the first line was never detected at all.
    //
    // Each pattern is the same shape `depVersion` parses, so the detection and the version
    // cannot disagree about whether the dependency is there.
    const KNOWN: Array<[string, RegExp]> = [
      ['django', /["']?django\b/i],
      ['flask', /["']?flask\b/i],
      ['fastapi', /["']?fastapi\b/i],
      ['pytest', /["']?pytest\b/i],
      ['ruff', /["']?ruff\b/i],
      ['mypy', /["']?mypy\b/i],
      ['black', /["']?black\b/i],
      ['poetry', /["']?poetry\b/i],
    ]
    for (const [id, re] of KNOWN) {
      for (const { text, file } of sources) {
        if (!re.test(text)) continue
        addStack(draft, {
          id,
          version: depVersion(text, id),
          evidence: [evidence(file, findLine(text, re))],
        })
        break
      }
    }

    // A test layout with no runnable command is the dominant Python readiness gap, so
    // only offer a command when something in the repo actually implies one. Marked
    // `inferred` -- nothing defines it -- so `ship` will not execute it unprobed.
    const hasTestLayout = hasFileUnder(ctx, 'tests') || hasFile(ctx, 'test') || hasFile(ctx, 'tests.py')
    if (hasTestLayout && draft.commands.test === undefined) {
      addCommand(draft, 'test', { cmd: 'pytest', source: 'inferred' })
    }

    if (hasFile(ctx, 'Dockerfile')) addTool(draft, 'container', 'docker')
    const hook = hookFramework(ctx)
    if (hook !== null) addTool(draft, 'hooks', hook)
    for (const f of ctx.files) {
      if (f.startsWith('.github/workflows/') && f.endsWith('.yml')) addTool(draft, 'ci', f)
    }

    // uv workspaces: members are sibling directories with their own pyproject.toml.
    if (pyproject !== null && findLine(pyproject, /\[tool\.uv\.workspace\]/) !== null) {
      setMonorepo(draft, {
        tool: 'uv',
        evidence: evidence('pyproject.toml', findLine(pyproject, /\[tool\.uv\.workspace\]/)),
        members: [],
      })
      for (const f of ctx.files) {
        if (!f.endsWith('/pyproject.toml')) continue
        const path = f.slice(0, -'/pyproject.toml'.length)
        const inner = readTomlish(ctx, f)
        const name = inner === null ? null : (/^\s*name\s*=\s*["']([^"']+)["']/m.exec(inner)?.[1] ?? null)
        addModulePy(draft, name ?? path, path)
      }
    }
  },
}

function addModulePy(draft: ProfileDraft, id: string, path: string): void {
  if (!draft.modules.some((m) => m.id === id)) {
    draft.modules.push({ id, path, kind: 'package', deps: [] })
  }
}
