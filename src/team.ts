import type { TeamMember } from './types.js';

import { DISCOVERY } from './team/discovery.js';
import { DESIGN } from './team/design.js';
import { BUILD_FRONTEND } from './team/build/frontend.js';
import { BUILD_BACKEND } from './team/build/backend.js';
import { BUILD_AI } from './team/build/ai.js';
import { BUILD_DATA } from './team/build/data.js';
import { BUILD_SUBSTRATE } from './team/build/substrate.js';
import { BUILD_CLUSTER_PLATFORM } from './team/build/cluster-platform.js';
import { BUILD_CLUSTER_ADDONS } from './team/build/cluster-addons.js';
import { BUILD_AGENT_PLATFORM } from './team/build/agent-platform.js';
import { VERIFY } from './team/verify.js';
import { SHIP } from './team/ship.js';
import { OPERATE } from './team/operate.js';
import { CUSTOMER } from './team/customer.js';
import { SALES } from './team/business/sales.js';
import { MARKETING } from './team/business/marketing.js';
import { LEAD_GEN } from './team/business/lead-gen.js';
import { SYSTEM_CURATORS } from './team/system-curators.js';
import { STAFF } from './team/staff.js';
import { LAB } from './team/lab.js';

/**
 * Team roster organized around factory phases (no top-level coordinator —
 * workflow code in `src/workflows.ts` fans out across phase-scoped multiagent
 * sessions). Roles follow the curator/engineer naming convention documented in
 * `docs/roster.md`.
 */
export const TEAM: TeamMember[] = [
  ...DISCOVERY,
  ...DESIGN,
  ...BUILD_FRONTEND,
  ...BUILD_BACKEND,
  ...BUILD_AI,
  ...BUILD_DATA,
  ...BUILD_SUBSTRATE,
  ...BUILD_CLUSTER_PLATFORM,
  ...BUILD_CLUSTER_ADDONS,
  ...BUILD_AGENT_PLATFORM,
  ...VERIFY,
  ...SHIP,
  ...OPERATE,
  ...CUSTOMER,
  ...SALES,
  ...MARKETING,
  ...LEAD_GEN,
  ...SYSTEM_CURATORS,
  ...STAFF,
  ...LAB,
];
