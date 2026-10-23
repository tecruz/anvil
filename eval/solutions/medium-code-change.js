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
 * The median of a list of numbers: the middle value of the sorted list, or the mean
 * of the two middle values when the count is even.
 */
export function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle]
  return (sorted[middle - 1] + sorted[middle]) / 2
}
