import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Lambda logic, and the synth-level checks on things no unit test
    // reaches — a response header can break the whole product silently.
    include: ['lambda/__tests__/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 30_000,
    environment: 'node',
  },
});
