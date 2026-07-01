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
      // on minor fluctuation. Raise these as the runtime + workflow tests
      // grow. Run via `npm run test:coverage`.
      thresholds: {
        lines: 45, // measured 47.45
        functions: 36, // measured 38.10
        branches: 47, // measured 49.64
        statements: 45, // measured 47.64
      },
    },
  },
});
