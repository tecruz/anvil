/**
 * String helpers.
 */

/**
 * Capitalise every word in a sentence.
 */
export function titleCase(text) {
  return text
    .split(/\s+/)
    .filter((word) => word !== '')
    .map((word) => `${word[0].toUpperCase()}${word.slice(1)}`)
    .join(' ')
}
