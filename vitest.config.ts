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
      // Floors rather than targets: each sits below what the suite measures, so
      // the gate catches a regression — a new untested module dragging the
      // denominator down — without failing on minor fluctuation. What the suite
      // measures is what `npm run test:coverage` prints; the org floor these
      // are held against is branches 60 / functions 75 / lines 75 /
      // statements 75 in nanohype/standards/testing-rubric.json.
      //
      // The widest gap is `runtimes/sdk-k8s.ts` and `runtimes/claude-cli.ts`,
      // and what is uncovered in them is the stream side: a pod log tailed from
      // an apiserver, a subprocess's stdout translated as it arrives. Dispatch
      // and spawn are driven. Neither file is excluded, so both count against
      // these numbers rather than being hidden by them.
      //
      // `runtimes/sdk.ts` and `k8s.ts` sit outside that gap. The sdk runtime's
      // query-options builder is a pure function and its session takes the SDK
      // module as a constructor argument; the k8s client's log follow is
      // exercised against a stubbed `fetch`. What a fixture stands in for is
      // the substrate a transport talks to — an apiserver, a subprocess, an
      // agent loop — and never fab's own code.
      thresholds: {
        lines: 75,
        functions: 70,
        branches: 72,
        statements: 75,

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
