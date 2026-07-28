import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    setupFiles: ['./__tests__/setup.ts'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      // Explicit include so modules with zero tests still count against the
      // floor — the gate measures the whole src/ surface, not just what the
      // suite happened to load.
      include: ['src/**/*.ts'],
      exclude: [
        // CLI entry point — raw-arg dispatch + process.exit wiring, exercised
        // end-to-end by running the binary, not unit-testable in isolation.
        'src/bin/fab.ts',
        // Interactive readline REPL — needs a TTY + a live session to drive;
        // out of unit scope by design.
        'src/repl.ts',
      ],
      // Honest floors set just below the measured actuals (see the numbers in
      // the comment on each threshold) so the gate catches a regression — a
      // new untested module dragging the denominator down — without flaking
      // on minor fluctuation. Run via `npm run test:coverage`.
      //
      // The gap to the org floor (branches 60 / functions 75 / lines 75 /
      // statements 75 in nanohype/standards/testing-rubric.json) is the three
      // alternate transports — `runtimes/sdk.ts`, `runtimes/sdk-k8s.ts`,
      // `runtimes/claude-cli.ts` — plus the in-cluster `k8s.ts` client they
      // depend on. Each needs either the optional Agent SDK, a subprocess, or
      // a live apiserver to exercise honestly; they are not excluded, so they
      // count against these numbers rather than being hidden by them.
      thresholds: {
        lines: 70, // measured 71.09
        functions: 61, // measured 61.95
        branches: 66, // measured 67.07
        statements: 70, // measured 70.73
      },
    },
  },
});
