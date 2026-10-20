/**
 * The instruction budget: how much agent context is worth paying for.
 *
 * An agent loads its instructions on every request, so their size is paid for on every
 * request. Two published findings shape the numbers here:
 *
 *  - A study of AGENTS.md files in real repositories (arXiv:2602.11988, 2026) found that
 *    adding an AGENTS.md did not generally raise an agent's task success and raised
 *    inference cost by more than 20%. The guidance that paid for itself was the part a
 *    model could not infer from the repository: the project's own commands and its
 *    non-standard tooling.
 *  - "Agent instruction bloat" (Thoughtworks, April 2026) describes the same failure from
 *    the other side: instruction files accumulate, hand-written sections survive, and
 *    generated ones pile up until nobody reads them.
 *
 * So the budget is not a style rule. It is the point past which the file stops paying for
 * itself, and the rule that enforces it is deliberately blunt about the fix: cut the
 * file, or move the detail somewhere it is only read when it is needed.
 *
 * The thresholds are in bytes rather than tokens, because bytes are what can be measured
 * the same way on every machine. A tokenizer would make the verdict depend on which
 * tokenizer was used, and a rule that reports a different answer on two machines is a
 * rule nobody trusts. The token count in the message is an estimate for the reader's
 * benefit; it never decides the verdict.
 *
 * The numbers were calibrated against the twenty-seven-repository corpus: twenty-two real
 * repositories, nine of them with instruction files (the five synthetic shapes ship none).
 * The largest is zod's AGENTS.md at 21.5 KB; 16 KB is around where a file stops being read
 * carefully, and 40 KB is 1.9x the largest real file. The budget is measured per
 * instruction source (a rules directory is one source), not summed across sources, because
 * axios ships two files for two tools and no agent loads both.
 */

/** Instructions above this size are worth reporting: past here, detail stops landing. */
export const WARN_INSTRUCTION_BYTES = 16_384

/** Instructions above this size are a finding that costs score. */
export const FAIL_INSTRUCTION_BYTES = 40_960

/**
 * Characters per token.
 *
 * The usual English approximation, and only ever used to turn a byte count into a number
 * a reader recognises. It is deliberately not used to decide a status.
 */
const CHARS_PER_TOKEN = 4

/** An estimate of the tokens a body of text costs, for the message only. */
export function estimateTokens(bytes: number): number {
  return Math.round(bytes / CHARS_PER_TOKEN)
}

/** A byte count as a human-readable size, e.g. `41 KB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  return kb >= 100 ? `${Math.round(kb)} KB` : `${kb.toFixed(1)} KB`
}
