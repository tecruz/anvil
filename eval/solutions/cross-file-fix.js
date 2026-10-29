/**
 * Solution for cross-file scenario.
 *
 * Replaces the shared helper so it preserves whitespace instead of trimming it.
 * The consumer delegates to the helper unchanged.
 */
export function format(val) {
  return val
}
