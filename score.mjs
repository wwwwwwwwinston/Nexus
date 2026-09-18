#!/usr/bin/env node
// Standalone A/B/C scenario scorer — no browser, no tab.
//
// Runs a submission through the scenario engine and prints the verdict
// (hard-fail tags) and soft score for Scenario A, B, and C (or one you pick).
//
// Usage:
//   node score.mjs --access SCHEDULE_ACCESS.csv [options]
//
// Options:
//   --access   <file>   SCHEDULE_ACCESS.csv (per-access placement; required)
//   --activities <file> 08_ACTIVITY_DETAILS.csv (location + activity priority)
//   --supply   <file>   04_LOCATION_SUPPLY.csv (per-location weekly capacity)
//   --projects <file>   07_PROJECT_DETAILS.csv (contract priority + planned week)
//   --result   <file>   schedule_result.csv (fallback planned/finish weeks)
//   --scenario <A|B|C|all>   which scenario(s) to score (default: all)
//   --lines    <file>   optional CSV "location,line" mapping (line = Alpha|Beta)
//   --json              emit machine-readable JSON instead of a text report
//   --quiet             suppress the human report (use with --json)
//   -h, --help          show this help
//
// Exit code: 0 if no scored scenario hard-fails; 1 if any scored scenario
// hard-fails (handy for CI / scripting). --scenario all fails if ANY of A/B/C
// hard-fails.

import { readFileSync, existsSync } from "node:fs";
import {
  parseScheduleAccess,
  evaluateScenario,
  evaluateAllScenarios,
  buildMeta,
  inferLine,
  validateInputs,
  reportToObject,
  SCENARIOS,
  SCENARIO_LABEL,
  EXCESS_NIGHT_COST,
  ECLO_NIGHT_COST,
} from "./js/scenario.js";
import { parseActivities, parseSupply, parseProjects } from "./js/inputs.js";
import { parseScheduleCsv } from "./js/parse.js";

// ---------- tiny arg parser ----------
function parseArgs(argv) {
  const opts = { scenario: "all" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "-h": case "--help": opts.help = true; break;
      case "--json": opts.json = true; break;
      case "--quiet": opts.quiet = true; break;
      case "--access": opts.access = next(); break;
      case "--activities": opts.activities = next(); break;
      case "--supply": opts.supply = next(); break;
      case "--projects": opts.projects = next(); break;
      case "--result": opts.result = next(); break;
      case "--lines": opts.lines = next(); break;
      case "--scenario": opts.scenario = String(next() || "all").toUpperCase(); break;
      default:
        if (a.startsWith("--")) { console.error(`Unknown option: ${a}`); process.exit(2); }
    }
  }
  return opts;
}

const HELP = readFileSync(new URL(import.meta.url)).toString()
  .split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n");

function readIf(file, label) {
  if (!file) return null;
  if (!existsSync(file)) { console.error(`✗ ${label} file not found: ${file}`); process.exit(2); }
  return readFileSync(file, "utf8");
}

// Parse an optional location->line mapping CSV ("location,line").
function parseLineMap(text) {
  const map = {};
  if (!text) return map;
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim());
  // skip a header row if present
  const start = /line/i.test(lines[0] || "") ? 1 : 0;
  for (let i = start; i < lines.length; i++) {
    const [loc, line] = lines[i].split(",").map((s) => (s || "").trim());
    if (loc && line) map[loc] = /beta/i.test(line) ? "Beta" : "Alpha";
  }
  return map;
}

function fmt(n) { return Number(n).toLocaleString(); }

function printReport(scenario, r) {
  const status = r.hardFail ? "HARD FAIL" : "FEASIBLE";
  const mark = r.hardFail ? "✗" : "✓";
  console.log(`\n${mark} Scenario ${scenario} (${SCENARIO_LABEL[scenario]}): ${status}`);
  if (r.hardFail) console.log(`  hard-fail tags: ${[...r.tags].join(", ")}`);
  console.log(`  soft score: ${fmt(r.score)}  (lower is better)`);
  const b = r.breakdown;
  if (b.overrunScore != null) console.log(`    · priority-weighted overrun: ${fmt(b.overrunScore)}`);
  if (b.excessScore != null) console.log(`    · excess access-nights: ${fmt(b.excessScore)} (${b.excessNightsScored ?? b.excessNights ?? 0} × ${EXCESS_NIGHT_COST})`);
  if (b.ecloScore != null) console.log(`    · ECLO penalty: ${fmt(b.ecloScore)} (${b.ecloNights} × ${ECLO_NIGHT_COST})`);
  if (r.findings.length) {
    console.log("  findings:");
    for (const f of r.findings) console.log(`    - ${f}`);
  }
}

// ---------- main ----------
function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || process.argv.length <= 2) { console.log(HELP); process.exit(0); }
  if (!opts.access) { console.error("✗ --access SCHEDULE_ACCESS.csv is required. See --help."); process.exit(2); }

  const { rows: accessRows, errors: accessErrors } =
    parseScheduleAccess(readIf(opts.access, "access"));
  const activityRows = opts.activities ? parseActivities(readIf(opts.activities, "activities")).rows : [];
  const supplyRows = opts.supply ? parseSupply(readIf(opts.supply, "supply")).rows : [];
  const projectRows = opts.projects ? parseProjects(readIf(opts.projects, "projects")).rows : [];
  const scheduleRows = opts.result ? parseScheduleCsv(readIf(opts.result, "result")).rows : [];
  const userLineMap = parseLineMap(readIf(opts.lines, "lines"));

  const meta = buildMeta({ activityRows, projectRows, scheduleRows });
  const lineOf = (loc) => userLineMap[loc] || inferLine(loc);

  const validation = validateInputs({ accessRows, activityRows, supplyRows, projectRows, scheduleRows });

  const scenariosToRun =
    opts.scenario === "ALL" ? SCENARIOS
    : SCENARIOS.includes(opts.scenario) ? [opts.scenario]
    : null;
  if (!scenariosToRun) { console.error(`✗ --scenario must be A, B, C, or all (got '${opts.scenario}').`); process.exit(2); }

  const results = {};
  for (const sc of scenariosToRun)
    results[sc] = evaluateScenario(accessRows, supplyRows, meta, { scenario: sc, lineOf });

  const anyHardFail = Object.values(results).some((r) => r.hardFail);
  // A structural error (e.g. no access rows at all) is a failure too — scoring
  // an empty/broken submission as "feasible" would be misleading.
  const failExit = anyHardFail || validation.errors.length > 0;

  if (opts.json) {
    const out = {
      access: opts.access,
      accessRows: accessRows.length,
      validation,
      scenarios: {},
    };
    for (const sc of scenariosToRun) out.scenarios[sc] = reportToObject(results[sc]);
    out.anyHardFail = anyHardFail;
    out.hasErrors = validation.errors.length > 0;
    console.log(JSON.stringify(out, null, 2));
  }

  if (!opts.quiet && !opts.json) {
    console.log(`trackopt scenario scorer`);
    console.log(`  submission: ${opts.access}  (${accessRows.length} access-nights)`);
    if (accessErrors.length) for (const e of accessErrors) console.log(`  ⚠ ${e}`);
    if (!opts.supply) console.log("  ⚠ no --supply: capacity checks skipped.");
    if (!opts.activities) console.log("  ⚠ no --activities: locations/priorities unknown (overrun & capacity limited).");
    if (validation.warnings.length) {
      console.log("  input warnings:");
      for (const w of validation.warnings) console.log(`    • ${w}`);
    }
    if (validation.errors.length) for (const e of validation.errors) console.log(`  ✗ ${e}`);
    for (const sc of scenariosToRun) printReport(sc, results[sc]);
    const verdict = validation.errors.length
      ? "✗ Input error — submission could not be scored properly."
      : anyHardFail
        ? "✗ At least one scored scenario HARD FAILED."
        : "✓ All scored scenarios are feasible.";
    console.log(`\n${verdict}`);
  }

  process.exit(failExit ? 1 : 0);
}

main();
