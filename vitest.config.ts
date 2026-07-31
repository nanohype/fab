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

        // Per-file 100%, above the global floor, on the two files where an
        // uncovered branch is an unproven control rather than a coverage
        // number. The floor above is deliberately low because of the alternate
        // transports, which makes an average an especially bad guardian for
        // these two — the package could sit comfortably above 70 with the gap
        // sitting in the approval gate.
        //
        // gate.ts decides whether a factory PR ships: it parses each role's
        // verdict, enforces the evidence contract by verifying that every
        // cited fragment appears verbatim at the cited location, and blocks
        // release on calibration drift.
        //
        // attribution.ts binds a session's cloud actions to a named human via
        // STS SourceIdentity. A gap here is an action nobody is accountable
        // for.
        'src/gate.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'src/attribution.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
      },
    },
  },
});
