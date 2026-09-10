/**
 * End-to-end demonstration of the Operational Router resource adapter.
 *
 *   node scripts/operational-router/demo-e2e.mjs
 *
 * Shows:
 *   A. fixture ResourceEvidence x3  -> adapter -> bounded exact BUDGET history
 *      -> shared Skillpack PACE resolver -> resource-aware candidate selection
 *      -> rendered Orca dispatch command
 *   B. a capacity grant  -> continuity invalidated -> PACE UNKNOWN
 *   C. a single BURST snapshot -> burst depletion works immediately, no history
 *
 * Pure: reads fixtures from disk, no provider contact, no dispatch.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

import { OperationalResourceAdapter } from "./resource-adapter.mjs";
import { FixtureResourceEvidenceProvider } from "./evidence-provider.mjs";
import { selectCandidate, resolvePace } from "../validate-policy-pack.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = join(HERE, "..", "..", "tests", "fixtures", "resource-evidence");
const fx = (n) => JSON.parse(readFileSync(join(FX, n), "utf8"));

const registry = parseYaml(readFileSync(join(HERE, "..", "..", "policies", "MODEL_REGISTRY.yaml"), "utf8"));
const TIER_ORDER = registry.capability_tier_order;
const SLOT = registry.capability_slots.DEFAULT_IMPLEMENTER;

const NOW = Date.parse("2026-09-10T09:21:00.000Z");
const line = (s = "") => process.stdout.write(s + "\n");

function renderDispatch(candidate) {
  if (candidate.provider === "codex") {
    return [
      `orca terminal create --worktree active --title "impl ${candidate.model}" \\`,
      `  --command 'codex -m ${candidate.model} -c '"'"'model_reasoning_effort="${candidate.reasoning}"'"'"'' \\`,
      `  --sandbox workspace-write --json`,
    ].join("\n");
  }
  return [
    `orca terminal create --worktree active --title "impl ${candidate.model}" \\`,
    `  --command '${candidate.provider === "antigravity" ? "agy" : candidate.provider} --model ${candidate.model} --effort ${candidate.reasoning}' \\`,
    `  --sandbox workspace-write --json`,
  ].join("\n");
}

async function scenarioA() {
  line("=".repeat(72));
  line("A. three same-generation ResourceEvidence snapshots -> PACE -> selection");
  line("=".repeat(72));
  const adapter = new OperationalResourceAdapter({
    provider: new FixtureResourceEvidenceProvider([fx("rebalance-1.json"), fx("rebalance-2.json"), fx("rebalance-3.json")]),
  });
  for (let i = 1; i <= 3; i += 1) {
    const summary = await adapter.refresh({ now: NOW });
    const s = summary.providers.find((p) => p.resource_state_key === "codex");
    line(`  ingest #${i}: codex BUDGET observations appended=${s.observations_appended} segmented=${s.continuity_segmented}`);
  }

  const obs = adapter.getPaceObservations("codex", { now: NOW });
  line("");
  line(`  bounded exact BUDGET history (codex/weekly), ${obs.length} observations:`);
  for (const o of obs) line(`    checked_at=${o.checked_at}  remaining_ratio=${o.remaining_ratio}  reset_at=${o.reset_at}`);

  const pace = resolvePace({ observations: obs }, { now: NOW });
  line("");
  line(`  shared Skillpack resolvePace(): pace_pressure=${pace.pace_pressure} pace_confidence=${pace.pace_confidence} pace_reason=${pace.pace_reason}`);

  line("");
  line("  explain():");
  for (const key of ["codex", "antigravity.gemini"]) line(`    ${key.padEnd(20)} ${JSON.stringify(adapter.explain(key, { now: NOW }))}`);

  const rs = adapter.getCurrentResourceState({ now: NOW });
  const pick = selectCandidate(SLOT, rs, TIER_ORDER, { now: NOW });
  line("");
  line(`  selectCandidate(DEFAULT_IMPLEMENTER): ${pick.status} -> ${pick.candidate.provider}/${pick.candidate.model}`);
  line(`    resource_pressure_rank=${pick.resource_pressure_rank}  pace_demotion=${JSON.stringify(pick.pace_demotion)}`);
  line("");
  line("  rendered Orca dispatch command:");
  line(renderDispatch(pick.candidate).replace(/^/gm, "    "));
}

async function scenarioB() {
  line("");
  line("=".repeat(72));
  line("B. capacity grant -> continuity invalidated -> PACE UNKNOWN");
  line("=".repeat(72));
  const adapter = new OperationalResourceAdapter({
    provider: new FixtureResourceEvidenceProvider([
      fx("codex-budget-series-1.json"),
      fx("codex-budget-series-2.json"),
      fx("codex-budget-series-3.json"),
      fx("codex-capacity-grant.json"),
    ]),
  });
  const now = Date.parse("2026-09-10T10:01:00.000Z");
  let lastSummary;
  for (let i = 1; i <= 4; i += 1) lastSummary = await adapter.refresh({ now });
  const s = lastSummary.providers[0];
  const obs = adapter.getPaceObservations("codex", { now });
  line(`  after the grant: continuity_segmented=${s.continuity_segmented}  BUDGET history length=${obs.length}`);
  line(`  resolvePace(): pace_pressure=${resolvePace({ observations: obs }, { now }).pace_pressure}  (single post-grant snapshot -> UNKNOWN)`);
}

async function scenarioC() {
  line("");
  line("=".repeat(72));
  line("C. single BURST snapshot -> burst depletion works immediately, zero history");
  line("=".repeat(72));
  const adapter = new OperationalResourceAdapter({
    provider: new FixtureResourceEvidenceProvider([fx("codex-burst-nearly-spent.json")]),
  });
  const now = Date.parse("2026-09-10T09:01:00.000Z");
  await adapter.refresh({ now });
  const ex = adapter.explain("codex", { now });
  line(`  BUDGET observations so far: ${ex.budget_observations}   pace=${ex.pace}`);
  line(`  burst_depletion=${ex.burst_depletion}  resource_pressure_rank=${ex.resource_pressure_rank}   (from one snapshot)`);
}

await scenarioA();
await scenarioB();
await scenarioC();
line("");
line("done.");
