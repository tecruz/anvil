/**
 * Artifact validation.
 *
 * This is the product feature, not busywork. opencode silently ignores a `SKILL.md` with
 * a bad name or a missing `description` -- the skill simply never appears in the tool
 * description, with no error anywhere. So an agent can "create" a skill, believe it
 * exists, and never use it.
 *
 * The validator is therefore a gate between the LLM's output and the repository. It
 * checks the *real* schemas, quoted below from the opencode documentation, and reports
 * every problem rather than the first.
 *
 *   Agents   .opencode/agents/<name>.md   frontmatter: description (required), mode,
 *            model, temperature, steps, hidden, permission (supports glob maps)
 *   Commands .opencode/commands/<name>.md frontmatter: description, agent, model, subtask.
 *            Body supports $ARGUMENTS, positional $1..$9, !`cmd`, @file.
 *   Skills   .agents/skills/<name>/SKILL.md  frontmatter: name (required, must equal the
 *            directory name and match ^[a-z0-9]+(-[a-z0-9]+)*$), description (required,
 *            1-1024 chars), license, compatibility, metadata (string->string only).
 *            Unknown fields are ignored.
 *   Rules    AGENTS.md                    plain markdown; no frontmatter required.
 */

import { estimateTokens, FAIL_INSTRUCTION_BYTES, formatBytes } from '@anvil/audit'

export type ArtifactKind = 'agent' | 'command' | 'skill' | 'agents-file'

export const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const SKILL_DESCRIPTION_MAX = 1024
const MAX_DESCRIPTION_CHARS = 1024

export interface ArtifactValidation {
  path: string
  kind: ArtifactKind
  ok: boolean
  errors: string[]
  warnings: string[]
}

export interface ParsedFrontmatter {
  data: Record<string, string>
  body: string
  /** Line number of the first body line, 1-based, for evidence. */
  bodyStart: number
  /** True when the file had no closing `---`. */
  unterminated: boolean
}

/**
 * Parse a leading `---` YAML-ish frontmatter block.
 *
 * Deliberately not a YAML parser: the fields these files use are scalars, and a real
 * YAML parser would accept structures opencode's frontmatter does not support (nested
 * maps) and silently accept invalid ones. A strict, flat reader that *reports* what it
 * cannot represent is the honest choice here.
 */
export function parseFrontmatter(text: string): ParsedFrontmatter {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')

  if (lines[0]?.trim() !== '---') {
    return { data: {}, body: normalized, bodyStart: 1, unterminated: false }
  }

  const data: Record<string, string> = {}
  let i = 1
  let closed = false

  for (; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trim() === '---') {
      closed = true
      i++
      break
    }
    if (line.trim() === '') continue

    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (match === null) continue

    const key = match[1] as string
    let value = (match[2] ?? '').trim()

    // Strip a trailing comment from a plain scalar, respecting quotes.
    if (!value.startsWith("'") && !value.startsWith('"') && !value.startsWith('[')) {
      const hash = value.indexOf(' #')
      if (hash !== -1) value = value.slice(0, hash).trim()
    }

    if (
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2) ||
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }

    // Multi-line block scalar: `key: |` followed by indented lines.
    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      const collected: string[] = []
      let j = i + 1
      while (j < lines.length && (lines[j] ?? '').trim() !== '---') {
        collected.push((lines[j] ?? '').replace(/^\s{2,}/, ''))
        j++
      }
      data[key] = value.startsWith('>') ? collected.join(' ') : collected.join('\n')
      i = j - 1
      continue
    }

    data[key] = value
  }

  return {
    data,
    body: lines.slice(i).join('\n'),
    bodyStart: i + 1,
    unterminated: !closed,
  }
}

function result(path: string, kind: ArtifactKind, errors: string[], warnings: string[]): ArtifactValidation {
  return { path, kind, ok: errors.length === 0, errors, warnings }
}

/** Infer the artifact kind from a repo-relative path. */
export function classifyArtifact(path: string): ArtifactKind | null {
  const p = path.replace(/\\/g, '/')
  if (/^\.opencode\/agents\/[^/]+\.md$/.test(p)) return 'agent'
  if (/^\.opencode\/commands\/[^/]+\.md$/.test(p)) return 'command'
  if (/(^|\/)\.agents\/skills\/[^/]+\/SKILL\.md$/.test(p)) return 'skill'
  if (/(^|\/)\.claude\/skills\/[^/]+\/SKILL\.md$/.test(p)) return 'skill'
  if (/^\.opencode\/skills\/[^/]+\/SKILL\.md$/.test(p)) return 'skill'
  if (/(^|\/)AGENTS\.md$/.test(p)) return 'agents-file'
  return null
}

/** Validate a generated artifact against the schema for its kind. */
export function validateArtifact(path: string, content: string): ArtifactValidation {
  const kind = classifyArtifact(path)
  if (kind === null) {
    return {
      path,
      kind: 'agents-file',
      ok: false,
      errors: [`Unrecognized artifact path: ${path}`],
      warnings: [],
    }
  }

  if (kind === 'agents-file') return validateAgentsFile(path, content)
  if (kind === 'agent') return validateAgent(path, content)
  if (kind === 'command') return validateCommand(path, content)
  return validateSkill(path, content)
}

function validateAgentsFile(path: string, content: string): ArtifactValidation {
  const errors: string[] = []
  const warnings: string[] = []

  if (content.trim() === '') errors.push('AGENTS.md is empty; an empty instructions file is worse than none')
  // Bytes, not UTF-16 code units: the audit measures the file on disk, and a repo whose
  // guidance is not ASCII must get the same verdict from both halves of the tool.
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > FAIL_INSTRUCTION_BYTES) {
    // The same threshold the audit rule fails on, so a file that would fail `anvil doctor`
    // cannot be written by `anvil init --apply` without the writer seeing why. The token
    // count is an estimate for the reader; the bytes are the verdict.
    const lines = content.split('\n').length
    warnings.push(
      `AGENTS.md is ${formatBytes(bytes)} (~${estimateTokens(bytes)} tokens, ${lines} lines). ` +
        'Guidance beyond a few KB stops being read carefully: move the long-form detail into a skill.',
    )
  }
  // opencode does not parse @file references itself, so an AGENTS.md leaning on them has
  // to say so explicitly or the agent never loads them.
  //
  // The reference has to look like a *file*: a path with an extension. Without that
  // requirement the check fires on every scoped npm package name in the document
  // (`@anvil/core`), which is a warning about the tool's own generated layout section --
  // and a false warning here blocks `init --apply`, which refuses to apply while any
  // warning stands.
  if (AT_FILE_REFERENCE.test(content) && !/use your (read|Read) tool|read the file|load the file/i.test(content)) {
    warnings.push('Contains @file references but does not instruct the agent to read them, so they will not be loaded.')
  }
  return result(path, 'agents-file', errors, warnings)
}

/**
 * An `@file` reference: an `@`, a path, and a file extension.
 *
 * The extension is what separates `@src/config.ts` from `@scope/package`.
 */
const AT_FILE_REFERENCE = /@[\w./-]*[\w-]+\.[A-Za-z0-9]{1,8}\b/

function validateAgent(path: string, content: string): ArtifactValidation {
  const errors: string[] = []
  const warnings: string[] = []
  const { data, body, unterminated } = parseFrontmatter(content)

  if (unterminated) errors.push('Frontmatter block is not closed with a second ---')

  const description = data.description ?? ''
  if (description.trim() === '') {
    errors.push('`description` is required and is what decides when this agent is used')
  } else if (description.length > MAX_DESCRIPTION_CHARS) {
    errors.push(`\`description\` is ${description.length} chars; keep it under ${MAX_DESCRIPTION_CHARS}`)
  }

  if (data.mode !== undefined && !['primary', 'subagent', 'all'].includes(data.mode)) {
    errors.push(`\`mode\` must be primary, subagent or all (got "${data.mode}")`)
  }
  if (data.steps !== undefined && !/^\d+$/.test(data.steps)) {
    errors.push('`steps` must be a positive integer')
  }
  if (data.temperature !== undefined && Number.isNaN(Number(data.temperature))) {
    errors.push('`temperature` must be a number')
  }

  if (body.trim() === '') errors.push('Agent has no system prompt body')
  if (!/permission\s*:/.test(content) && /\b(bash|edit|write)\b/.test(body)) {
    warnings.push(
      'Body suggests running commands or editing files but no `permission` block is declared, so the agent inherits every tool.',
    )
  }
  return result(path, 'agent', errors, warnings)
}

function validateCommand(path: string, content: string): ArtifactValidation {
  const errors: string[] = []
  const warnings: string[] = []
  const { data, body, unterminated } = parseFrontmatter(content)

  if (unterminated) errors.push('Frontmatter block is not closed with a second ---')

  const description = data.description ?? ''
  if (description.trim() === '') {
    errors.push('`description` is required; it is what the user sees in the command menu')
  } else if (description.length > MAX_DESCRIPTION_CHARS) {
    errors.push(`\`description\` is ${description.length} chars; keep it under ${MAX_DESCRIPTION_CHARS}`)
  }

  if (body.trim() === '') errors.push('Command has no template body, so invoking it does nothing')
  if (data.subtask !== undefined && !['true', 'false'].includes(data.subtask)) {
    errors.push('`subtask` must be true or false')
  }

  // A command whose description promises a parameter but whose body never interpolates
  // one is a latent bug: the user types `/add-component Button` and it is ignored.
  if (/\$\{?\w/.test(content) && !/\$ARGUMENTS|\$\d/.test(body)) {
    warnings.push(
      'Frontmatter references a variable but the body never interpolates it, so it will not reach the prompt',
    )
  }
  return result(path, 'command', errors, warnings)
}

function validateSkill(path: string, content: string): ArtifactValidation {
  const errors: string[] = []
  const warnings: string[] = []
  const { data, body, unterminated } = parseFrontmatter(content)

  if (unterminated) errors.push('Frontmatter block is not closed with a second ---')

  // The directory name is the skill's identity, and a mismatch makes opencode ignore it.
  const dirName = skillDirName(path)
  const name = data.name ?? ''

  if (name.trim() === '') {
    errors.push('`name` is required')
  } else {
    if (!SKILL_NAME_PATTERN.test(name)) {
      errors.push(`\`name\` must match ${SKILL_NAME_PATTERN.source} (got "${name}")`)
    }
    if (dirName !== null && name !== dirName) {
      errors.push(`\`name\` ("${name}") must equal the containing directory name ("${dirName}")`)
    }
  }

  const description = data.description ?? ''
  if (description.trim() === '') {
    errors.push('`description` is required; it is how the agent decides when to load this skill')
  } else if (description.length > SKILL_DESCRIPTION_MAX) {
    errors.push(`\`description\` is ${description.length} chars; the maximum is ${SKILL_DESCRIPTION_MAX}`)
  }

  if (data.metadata !== undefined) {
    warnings.push('`metadata` must be a string-to-string map; a flat scalar will not be read')
  }
  if (body.trim() === '') errors.push('Skill has no instructions body')

  return result(path, 'skill', errors, warnings)
}

/** The skill's directory name, which must equal its `name`. Null for a non-skill path. */
export function skillDirName(path: string): string | null {
  const p = path.replace(/\\/g, '/')
  const m = /skills\/([^/]+)\/SKILL\.md$/.exec(p)
  return m === null ? null : (m[1] as string)
}

export interface ValidateSummary {
  ok: boolean
  results: ArtifactValidation[]
  errors: Array<{ path: string; message: string }>
  warnings: Array<{ path: string; message: string }>
}

export function validateAll(artifacts: ReadonlyArray<{ path: string; content: string }>): ValidateSummary {
  const results = artifacts.map((a) => validateArtifact(a.path, a.content))
  return {
    ok: results.every((r) => r.ok),
    results,
    errors: results.flatMap((r) => r.errors.map((message) => ({ path: r.path, message }))),
    warnings: results.flatMap((r) => r.warnings.map((message) => ({ path: r.path, message }))),
  }
}
