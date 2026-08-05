// The skills must not teach a resource the platform does not ship.
//
// fab injects its skills into the preamble of every agent session it runs, so a
// kind named there is a kind agents will confidently author. When the batch tier
// was deleted from eks-agent-platform, `BatchJob` survived in
// eks-agent-platform-curation.md — and every session kept being told the
// platform had a batch API. Nothing could catch it: fab does not vendor the
// CRDs, so there was no local list to compare against.
//
// This compares the kinds the skills name against the CRDs the operator chart
// actually ships, in both directions:
//
//   * A kind the skills name that no CRD defines — the batch case. Agents are
//     taught an API that does not exist, and find out at admission.
//   * A kind the operator ships that no skill mentions — quieter, and it is the
//     reason this checks both ways. SLOPolicy shipped a controller, a CRD, a
//     kube-state-metrics projection and three alerts while the skills barely
//     named it, so agents never authored one and the loop never ran.
//
// CI sparse-checks-out the chart's crds/ directory and runs this against it, so
// a kind added or deleted upstream is caught here rather than in a session
// transcript.
//
// Usage: node scripts/check-skill-resources.mjs <operator-chart-crds-dir>

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const crdDir = process.argv[2];
if (!crdDir) {
  console.error('usage: check-skill-resources.mjs <operator-chart-crds-dir>');
  process.exit(2);
}

// spec.names.kind, at the indentation controller-gen emits — NOT the document's
// own `kind: CustomResourceDefinition`.
const CRD_KIND = /^ {4}kind:\s*([A-Za-z][A-Za-z0-9]*)\s*$/m;

const shipped = new Set();
for (const f of readdirSync(crdDir)
  .filter((n) => n.endsWith('.yaml'))
  .sort()) {
  const m = CRD_KIND.exec(readFileSync(join(crdDir, f), 'utf-8'));
  if (m) shipped.add(m[1]);
}

if (shipped.size === 0) {
  console.error(
    `parsed no kinds out of ${crdDir} — the CRD shape changed or the checkout path is wrong,`,
  );
  console.error('so this check is comparing against an empty set and asserting nothing.');
  process.exit(2);
}

// Only the API-group lines and definition bullets are read, not free prose. A
// skill may legitimately say "platform" or "tenant" as English; what must be
// accurate is where it enumerates the API.
const SKILL_DIR = 'skills';
const named = new Map(); // kind -> [where]
let scanned = 0;

for (const f of readdirSync(SKILL_DIR)
  .filter((n) => n.endsWith('.md'))
  .sort()) {
  const text = readFileSync(join(SKILL_DIR, f), 'utf-8');
  text.split('\n').forEach((line, i) => {
    // An API-group enumeration: `agents.nanohype.dev` (AgentFleet, ModelGateway)
    // or a definition bullet: | `SLOPolicy` | ... or - `SLOPolicy` — ...
    const enumeration = /nanohype\.dev`?\s*\(([^)]+)\)/g;
    const bullet = /^\s*(?:[-*|]\s*)`([A-Z][A-Za-z0-9]*)`/;

    for (const m of line.matchAll(enumeration)) {
      scanned++;
      for (const raw of m[1].split(',')) {
        const kind = raw.trim().replace(/`/g, '');
        if (/^[A-Z][A-Za-z0-9]*$/.test(kind)) {
          if (!named.has(kind)) named.set(kind, []);
          named.get(kind).push(`${f}:${i + 1}`);
        }
      }
    }
    const b = bullet.exec(line);
    if (b && shipped.has(b[1])) {
      scanned++;
      if (!named.has(b[1])) named.set(b[1], []);
      named.get(b[1]).push(`${f}:${i + 1}`);
    }
  });
}

if (scanned === 0) {
  console.error(
    `no API enumeration or definition bullet matched in ${SKILL_DIR}/ — the skills' shape`,
  );
  console.error('changed, so this check found nothing to compare and is asserting nothing.');
  process.exit(2);
}

const errors = [];

for (const [kind, where] of [...named].sort()) {
  if (!shipped.has(kind)) {
    errors.push(
      `${kind} is named in the skills but no CRD in the operator chart defines it.\n` +
        `    at ${where.join(', ')}\n` +
        '    Every session fab runs is told this API exists; an agent that authors one\n' +
        '    finds out at admission.',
    );
  }
}

for (const kind of [...shipped].sort()) {
  if (!named.has(kind)) {
    errors.push(
      `${kind} is a kind the operator ships and no skill names it.\n` +
        '    Agents are never told the API exists, so nothing authors one and the tier\n' +
        '    stays unexercised — the quieter half of the same drift.',
    );
  }
}

if (errors.length > 0) {
  for (const e of errors) console.error(`FAIL  ${e}`);
  process.exit(1);
}

console.log(
  `skills name exactly the ${shipped.size} kinds the operator ships: ${[...shipped].sort().join(', ')}`,
);
