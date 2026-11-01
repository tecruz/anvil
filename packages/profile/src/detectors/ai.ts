/**
 * AI / machine learning: notebooks, and the framework a Python project declares.
 *
 * Python dominates AI repositories on GitHub, and the two things an agent needs that the generic
 * Python playbook cannot give are the notebook environment (a `.ipynb` is not a `.py`) and the
 * framework (PyTorch, TensorFlow, Transformers), whose API changes on its own schedule.
 *
 * The framework is read from the declared dependency, never from an `import`: a repository is a
 * PyTorch project when it depends on `torch`, which is what `pip install` acts on.
 */

import { join } from 'node:path'
import { addStack, type Detector, type DetectorContext, filesUnder, hasFile } from '../detector.ts'
import { evidence, findLine } from '../manifest.ts'
import { readText } from '../walk.ts'

function read(ctx: DetectorContext, rel: string): string | null {
  return readText(join(ctx.root, ctx.resolve(rel))).text
}

const ML_PACKAGES: ReadonlyArray<{ stack: string; packages: readonly string[] }> = [
  { stack: 'pytorch', packages: ['torch'] },
  { stack: 'tensorflow', packages: ['tensorflow'] },
  { stack: 'huggingface', packages: ['transformers'] },
]

/** Manifests a Python project states its dependencies in. */
const PYTHON_MANIFESTS = ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile'] as const

/**
 * The line that declares a package, or null.
 *
 * Bounded on both sides so `torch` does not match `pytorch` (a different distribution that also
 * ships torch) and `transformers` does not match `sentence-transformers`.
 */
function declaredLine(text: string, name: string): number | null {
  return findLine(text, new RegExp(`(^|[^a-z0-9_-])${name}([^a-z0-9_-]|$)`, 'i'))
}

export const aiDetector: Detector = {
  id: 'ai',
  title: 'AI / machine learning',
  priority: 44,
  matches: (ctx) =>
    filesUnder(ctx, '').some((f) => f.endsWith('.ipynb')) || PYTHON_MANIFESTS.some((f) => hasFile(ctx, f)),
  detect(ctx, draft) {
    const notebooks = filesUnder(ctx, '').filter((f) => f.endsWith('.ipynb'))
    if (notebooks.length > 0) {
      addStack(draft, { id: 'jupyter', version: null, evidence: [notebooks[0] as string] })
    }

    for (const rel of PYTHON_MANIFESTS) {
      if (!hasFile(ctx, rel)) continue
      const text = read(ctx, rel)
      if (text === null) continue
      for (const { stack, packages } of ML_PACKAGES) {
        const pkg = packages.find((p) => declaredLine(text, p) !== null)
        if (pkg === undefined) continue
        addStack(draft, { id: stack, version: null, evidence: [evidence(rel, declaredLine(text, pkg))] })
      }
    }
  },
}
