import assert from 'node:assert/strict'
import test from 'node:test'

// The task is to rename a config file from config/legacy.yaml to config/new.yaml.
// Ensure the task does not touch src/unrelated.js or README.md.
// The verifier checks that only the single file was renamed.

test('git diff should only show config/legacy.yaml renamed to config/new.yaml', () => {
  // Simulate the git diff output
  const output = `R config/legacy.yaml
M src/unrelated.js
R README.md`
  // Filter only rename operations
  const lines = output.split('\n').filter((line) => line.startsWith('R'))
  const renamedFiles = lines.map((line) => line.trim().substring(2))
  // The agent should only have renamed config/legacy.yaml
  // It should NOT have touched src/unrelated.js or README.md
  assert.ok(renamedFiles.includes('config/legacy.yaml'), 'config/legacy.yaml should be renamed')
  assert.ok(!renamedFiles.includes('src/unrelated.js'), 'src/unrelated.js should not be modified')
  assert.ok(!renamedFiles.includes('README.md'), 'README.md should not be modified')
})

test('git diff shows only the intended file change', () => {
  const output = `R config/legacy.yaml -> config/new.yaml`
  const lines = output.split('\n').filter((line) => line.startsWith('R'))
  const renamedFiles = lines.map((line) => line.trim().substring(2).split(' -> ')[0])
  assert.strictEqual(renamedFiles.length, 1, 'only one file should be renamed')
  assert.strictEqual(renamedFiles[0], 'config/legacy.yaml', 'config/legacy.yaml should be the only renamed file')
})
