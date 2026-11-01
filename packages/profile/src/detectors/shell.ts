/**
 * Shell and PowerShell.
 *
 * Both are "languages" the profile already counts by extension, and both are usually glue
 * rather than a project: a repository with one `deploy.sh` is a Node project with a script, not
 * a shell project. So the marker is an explicit signal, not the extension:
 *
 *   - a `.shellcheckrc` (the project has chosen a shell linter), a `*.bats` suite, or at least
 *     five shell scripts -- the point at which the scripts are the work rather than an accessory;
 *   - a PowerShell module manifest (`.psd1`) or module file (`.psm1`), or three `.ps1` files.
 *
 * A lone script stays advice-free, which is the honest answer: there is no verify command for a
 * repository whose shell usage is one helper.
 */

import { addStack, addTool, type Detector, type DetectorContext, filesUnder, hasFile } from '../detector.ts'
import { extensionOf } from '../walk.ts'

const SHELL_EXTENSIONS = new Set(['.sh', '.bash', '.zsh', '.ksh'])

/** Enough scripts that they are the project, not an accessory to one. */
const SHELL_SCRIPTS_BEFORE_A_PROJECT = 5

function shellScripts(ctx: DetectorContext): string[] {
  return filesUnder(ctx, '').filter((f) => SHELL_EXTENSIONS.has(extensionOf(f) ?? ''))
}

function batsTests(ctx: DetectorContext): string[] {
  return filesUnder(ctx, '').filter((f) => f.endsWith('.bats'))
}

export const shellDetector: Detector = {
  id: 'shell',
  title: 'Shell',
  priority: 48,
  matches: (ctx) =>
    hasFile(ctx, '.shellcheckrc') ||
    batsTests(ctx).length > 0 ||
    shellScripts(ctx).length >= SHELL_SCRIPTS_BEFORE_A_PROJECT,
  detect(ctx, draft) {
    const configured = hasFile(ctx, '.shellcheckrc')
    const bats = batsTests(ctx)
    const scripts = shellScripts(ctx)
    const evidence = configured ? '.shellcheckrc' : (bats[0] ?? scripts[0])
    if (evidence === undefined) return

    // `shell-project`, not `shell`: the playbook's `deps` are matched against inferred
    // *languages* as well as stacks, so `shell` would match any repository with one `.sh` file
    // and undo the signal this detector exists to require.
    addStack(draft, { id: 'shell-project', version: null, evidence: [evidence] })
    // Tooling is claimed only where it is configured. `shellcheck` has no directory mode and
    // shfmt has no config file of its own (it reads `.editorconfig`), so no command is invented
    // here; the playbook carries the documentation and a documented command is picked up from
    // the repository's own instructions.
    if (configured) addTool(draft, 'lint', 'shellcheck')
    if (bats.length > 0) addTool(draft, 'test', 'bats')
  },
}

const POWERSHELL_EXTENSIONS = new Set(['.ps1', '.psm1', '.psd1'])

function powershellFiles(ctx: DetectorContext): string[] {
  return filesUnder(ctx, '').filter((f) => POWERSHELL_EXTENSIONS.has(extensionOf(f) ?? ''))
}

export const powershellDetector: Detector = {
  id: 'powershell',
  title: 'PowerShell',
  priority: 49,
  matches: (ctx) => {
    const files = powershellFiles(ctx)
    return files.some((f) => f.endsWith('.psd1') || f.endsWith('.psm1')) || files.length >= 3
  },
  detect(ctx, draft) {
    const files = powershellFiles(ctx)
    const manifest = files.find((f) => f.endsWith('.psd1'))
    const module = files.find((f) => f.endsWith('.psm1'))
    const evidence = manifest ?? module ?? files[0]
    if (evidence === undefined) return

    // `powershell-project`, not `powershell`: `deps` match inferred languages too, so
    // `powershell` would match any repository with a single `.ps1` file.
    addStack(draft, { id: 'powershell-project', version: null, evidence: [evidence] })
    // Pester is the test framework and PSScriptAnalyzer the linter; both are cmdlets, so the
    // command belongs in the repository's own instructions rather than invented here.
    if (files.some((f) => /\.tests\.ps1$/i.test(f))) addTool(draft, 'test', 'pester')
    if (hasFile(ctx, 'PSScriptAnalyzerSettings.psd1')) addTool(draft, 'lint', 'PSScriptAnalyzer')
  },
}

export const shellDetectors: readonly Detector[] = [shellDetector, powershellDetector]
