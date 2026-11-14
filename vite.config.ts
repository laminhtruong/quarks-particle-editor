import { defineConfig } from 'vitest/config'

export default defineConfig({
  build: {
    lib: {
      entry: { 'quarks-particle-editor': 'src/index.ts', document: 'src/document.ts' },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },
    rolldownOptions: {
      external: [/^three(?:\/|$)/, /^three\.quarks$/, /^zod(?:\/|$)/],
    },
  },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
})
