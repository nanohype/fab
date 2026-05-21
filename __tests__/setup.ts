import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point fab's state file at a throwaway temp path so the test suite never
// reads or writes the real ~/.fab/state.json.
process.env.FAB_STATE_FILE = join(tmpdir(), `fab-test-state-${process.pid}.json`);
