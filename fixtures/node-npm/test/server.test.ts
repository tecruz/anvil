import { describe, it, expect } from 'vitest'
import { handler } from '../src/server.js'

describe('handler', () => {
  it('responds', () => {
    expect(handler).toBeTypeOf('function')
  })
})
