/**
 * Unified diff rendering.
 *
 * The user-facing promise of `anvil init` is that nothing enters a repository they do not
 * own without a reviewable diff. That makes this module load-bearing rather than a
 * convenience: if the diff misrepresents what will be written, the review step is theatre.
 *
 * Written from scratch to keep the runtime dependency count at zero. The algorithm is a
 * standard LCS over lines, which is the same shape `git diff` uses; the output is
 * `git apply`-compatible, so a reviewer can even check it with `git apply --check`.
 */

export type DiffOp = 'add' | 'remove' | 'context'

export interface DiffLine {
  op: DiffOp
  text: string
  /** 1-based line number in the old file, or null for additions. */
  oldLine: number | null
  /** 1-based line number in the new file, or null for removals. */
  newLine: number | null
}

export interface FileDiff {
  path: string
  kind: 'add' | 'modify' | 'delete'
  hunks: DiffHunk[]
  added: number
  removed: number
}

export interface DiffHunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: DiffLine[]
}

/** Split into lines without inventing a trailing empty line. */
export function splitLines(text: string): string[] {
  if (text === '') return []
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  // A trailing newline yields a final empty element that is not a real line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Longest common subsequence as an index-pair list.
 *
 * O(n*m) is fine here: the files anvil generates are documentation and small config
 * files, and the pathological input (a generated file with 100k lines) is refused by
 * callers that care. Kept simple deliberately -- a smarter algorithm here would be
 * optimizing the wrong thing.
 */
function lcsPairs(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const n = a.length
  const m = b.length
  if (n === 0 || m === 0) return []

  // Guard: beyond this the table is large enough that we degrade to a whole-file
  // replace rather than allocating hundreds of MB.
  if (n * m > 4_000_000) return []

  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    const row = table[i] as number[]
    const next = table[i + 1] as number[]
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number)
    }
  }

  const out: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([i, j])
      i++
      j++
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      i++
    } else {
      j++
    }
  }
  return out
}

/** Build the full op list for a file pair. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  const out: DiffLine[] = []
  const pairs = lcsPairs(a, b)

  let ai = 0
  let bi = 0
  for (const [pa, pb] of [...pairs, [a.length, b.length] as [number, number]]) {
    while (ai < pa) {
      out.push({
        op: 'remove',
        text: a[ai] as string,
        oldLine: ai + 1,
        newLine: null,
      })
      ai++
    }
    while (bi < pb) {
      out.push({
        op: 'add',
        text: b[bi] as string,
        oldLine: null,
        newLine: bi + 1,
      })
      bi++
    }
    if (pa < a.length && pb < b.length) {
      out.push({
        op: 'context',
        text: a[pa] as string,
        oldLine: pa + 1,
        newLine: pb + 1,
      })
      ai++
      bi++
    }
  }
  return out
}

const CONTEXT_LINES = 3

/** Group op lines into hunks with `context` lines of surrounding context. */
export function buildHunks(lines: readonly DiffLine[]): DiffHunk[] {
  const changedIdx: number[] = []
  lines.forEach((l, i) => {
    if (l.op !== 'context') changedIdx.push(i)
  })
  if (changedIdx.length === 0) return []

  // Merge change indices into ranges, padded by CONTEXT_LINES.
  const ranges: Array<[number, number]> = []
  let start = Math.max(0, (changedIdx[0] as number) - CONTEXT_LINES)
  let end = Math.min(lines.length - 1, (changedIdx[0] as number) + CONTEXT_LINES)
  for (const idx of changedIdx.slice(1)) {
    const s = Math.max(0, idx - CONTEXT_LINES)
    const e = Math.min(lines.length - 1, idx + CONTEXT_LINES)
    if (s <= end + 1) {
      end = Math.max(end, e)
    } else {
      ranges.push([start, end])
      start = s
      end = e
    }
  }
  ranges.push([start, end])

  return ranges.map(([s, e]) => {
    const slice = lines.slice(s, e + 1)
    const olds = slice.map((l) => l.oldLine).filter((n): n is number => n !== null)
    const news = slice.map((l) => l.newLine).filter((n): n is number => n !== null)
    return {
      oldStart: olds[0] ?? 0,
      oldCount: olds.length,
      newStart: news[0] ?? 0,
      newCount: news.length,
      lines: slice,
    }
  })
}

export interface DiffInput {
  path: string
  /** null for a new file. */
  before: string | null
  after: string
}

/** Diff one logical file. Returns null when nothing changed. */
export function diffFile(input: DiffInput): FileDiff | null {
  const before = input.before
  if (before !== null && before === input.after) return null

  if (before === null) {
    const lines = splitLines(input.after).map((text, i) => ({
      op: 'add' as const,
      text,
      oldLine: null,
      newLine: i + 1,
    }))
    return {
      path: input.path,
      kind: 'add',
      hunks:
        lines.length === 0
          ? []
          : [
              {
                oldStart: 0,
                oldCount: 0,
                newStart: 1,
                newCount: lines.length,
                lines,
              },
            ],
      added: lines.length,
      removed: 0,
    }
  }

  if (input.after === '') {
    const lines = splitLines(before).map((text, i) => ({
      op: 'remove' as const,
      text,
      oldLine: i + 1,
      newLine: null,
    }))
    return {
      path: input.path,
      kind: 'delete',
      hunks: [
        {
          oldStart: 1,
          oldCount: lines.length,
          newStart: 0,
          newCount: 0,
          lines,
        },
      ],
      added: 0,
      removed: lines.length,
    }
  }

  const lines = diffLines(before, input.after)
  const added = lines.filter((l) => l.op === 'add').length
  const removed = lines.filter((l) => l.op === 'remove').length
  if (added === 0 && removed === 0) return null

  return {
    path: input.path,
    kind: 'modify',
    hunks: buildHunks(lines),
    added,
    removed,
  }
}

/** Render a `git apply`-compatible unified diff. */
export function renderUnifiedDiff(diffs: readonly FileDiff[]): string {
  const out: string[] = []
  for (const d of diffs) {
    out.push(`diff --git a/${d.path} b/${d.path}`)
    if (d.kind === 'add') out.push('new file mode 100644')
    else if (d.kind === 'delete') out.push('deleted file mode 100644')
    out.push(`--- ${d.kind === 'add' ? '/dev/null' : `a/${d.path}`}`)
    out.push(`+++ ${d.kind === 'delete' ? '/dev/null' : `b/${d.path}`}`)
    for (const hunk of d.hunks) {
      out.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`)
      for (const line of hunk.lines) {
        const prefix = line.op === 'add' ? '+' : line.op === 'remove' ? '-' : ' '
        out.push(prefix + line.text)
      }
    }
  }
  return out.length === 0 ? '' : `${out.join('\n')}\n`
}

export function summarize(diffs: readonly FileDiff[]): {
  files: number
  added: number
  removed: number
} {
  return {
    files: diffs.length,
    added: diffs.reduce((n, d) => n + d.added, 0),
    removed: diffs.reduce((n, d) => n + d.removed, 0),
  }
}
