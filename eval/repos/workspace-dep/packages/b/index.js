/**
 * Consumer module that depends on the shared dependency.
 * Uses a relative import so the scenario works without npm install.
 */
import { dep } from '../a/index.js'

export const depExists = dep
