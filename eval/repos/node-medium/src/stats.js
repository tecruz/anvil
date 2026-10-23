/**
 * Numeric summaries.
 */

/**
 * The arithmetic mean of a list of numbers.
 */
export function mean(numbers) {
  if (numbers.length === 0) return NaN
  const total = numbers.reduce((sum, value) => sum + value, 0)
  return total / numbers.length
}

/**
 * The median of a list of numbers.
 *
 * Sort the list, then return the middle value; when the count is even, return the mean
 * of the two middle values.
 */
export function median(numbers) {
  return numbers
}
