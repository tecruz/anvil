// Sort function that sorts ascending (README incorrectly says descending)
export function sort(arr) {
  return arr.slice().sort((a, b) => a - b)
}
