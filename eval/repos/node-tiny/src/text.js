/**
 * String helpers.
 */

/**
 * Cut a string to `max` characters, adding an ellipsis when it was cut.
 */
export function truncate(text, max) {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}
