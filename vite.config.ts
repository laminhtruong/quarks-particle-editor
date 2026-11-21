import { defineConfig } from 'vitest/config'

export default defineConfig({
  build: {
    lib: {
      entry: {
        'quarks-particle-editor': 'src/index.ts',
        document: 'src/document.ts',
        'project-loader': 'src/project-loader.ts',
        'unity-package': 'src/unity-package.ts',
        'unity-behaviors': 'src/unity-behaviors.ts',
      },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },
    rolldownOptions: {
      external: [/^three(?:\/|$)/, /^three\.quarks$/, /^zod(?:\/|$)/],
    },
  },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
})
