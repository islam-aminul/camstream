import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['lambda/__tests__/**/*.test.ts'],
    environment: 'node',
  },
});
