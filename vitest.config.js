import { defineConfig } from 'vitest/config'

// The framework-free core under supabase/functions/_shared is imported by three
// runtimes -- Node (the seed script), Deno (the edge function) and this. Nothing
// here needs a DOM, so the default node environment is the right one and there
// is no setup file.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.{test,spec}.{js,ts}'],
  },
})
