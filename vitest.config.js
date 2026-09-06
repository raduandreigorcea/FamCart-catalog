import { defineConfig } from 'vitest/config'

// Node environment: nothing here touches a DOM. No setup file and no globals —
// every test imports what it needs, which keeps a fixture-driven suite honest
// about what it is exercising.
//
// There is no network in this suite BY CONSTRUCTION, not by convention: the
// transport takes an injected `fetchImpl` and the retailer tests pass one that
// reads test/fixtures/. A test that reached the real Auchan would be a test that
// fails when Auchan is slow, and CI would learn to ignore it.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.{test,spec}.{js,ts}'],
  },
})
