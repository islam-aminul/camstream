import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Lambda logic, and the synth-level checks on things no unit test
    // reaches — a response header can break the whole product silently.
    include: ['lambda/__tests__/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 30_000,
    environment: 'node',

    // Fixed, fake AWS environment.
    //
    // Some of this code presigns URLs, and a presigner needs a region and a
    // key before it will build one — offline, but not from nothing. Left to
    // the ambient environment that passed on a workstation with a configured
    // profile and failed in CI, which deliberately holds no credentials, with
    // "Region is missing" from a test about whether a PowerShell script is
    // ASCII. The suite now supplies its own, so it neither depends on a real
    // configuration nor is able to reach an account if something in it ever
    // stopped being offline.
    env: {
      AWS_REGION: 'ap-south-1',
      AWS_DEFAULT_REGION: 'ap-south-1',
      AWS_ACCESS_KEY_ID: 'testing',
      AWS_SECRET_ACCESS_KEY: 'testing',
      AWS_SESSION_TOKEN: 'testing',
      AWS_PROFILE: '',
    },
  },
});
