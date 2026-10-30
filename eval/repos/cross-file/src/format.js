/**
 * A shared helper used by two modules.
 *
 * CURRENT IMPLEMENTATION: trims whitespace (BROKEN - should preserve).
 */
export function format(val) {
  return val.trim()
}
