/**
 * List helpers.
 */

/**
 * The unique values of a list, in the order they first appeared.
 */
export function unique(values) {
  return [...new Set(values)]
}
