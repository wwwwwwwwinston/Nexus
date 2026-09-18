// Zero-dependency test suite for the scenario engine.
// Run with:  node tests/scenario.test.mjs
// Exits non-zero if any assertion fails.

import {
  parseScheduleAccess,
  evaluateScenario,
  evaluateAllScenarios,
  buildMeta,
  overrunDayWeight,
  validateInputs,
  buildOccupancyGrid,
  reportToObject,
  reportToCsv,
  inferLine,
  SCENARIOS,
  EXCESS_NIGHT_COST,
  ECLO_NIGHT_COST,
} from "../js/scenario.js";

let pass = 0, fail = 0;
const failures = [];
function check(name, cond) {
  if (cond) { pass++; }
  else { fail++; failures.push(name); console.log("FAIL: " + name); }
}
function eq(name, got, want) {
  check(name + `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want));
}

// ---------- weight ladder ----------
eq("P1+actP1 weight = 130", overrunDayWeight(1, 1), 130);
eq("P1+actP3 weight = 100", overrunDayWeight(1, 3), 100);
eq("P2+actP2 weight = 12", overrunDayWeight(2, 2), 12);
eq("P3+actP3 weight = 1", overrunDayWeight(3, 3), 1);
check("P2 ceiling (13) < P1 floor (100)", overrunDayWeight(2, 1) < overrunDayWeight(1, 3));
check("cost ladder P3<excess<ECLO<P2<P1",
  overrunDayWeight(3, 3) < EXCESS_NIGHT_COST &&
  EXCESS_NIGHT_COST < ECLO_NIGHT_COST &&
  ECLO_NIGHT_COST < overrunDayWeight(2, 3) &&
  overrunDayWeight(2, 3) < overrunDayWeight(1, 3));

// ---------- parsing ----------
const accessCsv = `activity_id,access_seq,week,eclo,access_night
A1,1,5,0,1
A1,2,6,1,1
A2,1,5,0,1
A2,2,5,0,1
A2,3,5,0,1`;
const { rows: acc, errors: accErr } = parseScheduleAccess(accessCsv);
eq("parse row count", acc.length, 5);
eq("parse eclo flag on row 2", acc[1].eclo, 1);
eq("parse no errors", accErr.length, 0);

const supply = [{ location: "L1", capacity: 2 }];
const meta = buildMeta({
  activityRows: [
    { activity: "A1", contract: "C1", location: "L1", priority: 3 },
    { activity: "A2", contract: "C1", location: "L1", priority: 3 },
  ],
});
meta.get("A1").plannedWeek = 4; meta.get("A1").contractPriority = 1; meta.get("A1").activityPriority = 3;
meta.get("A2").plannedWeek = 10; meta.get("A2").contractPriority = 3; meta.get("A2").activityPriority = 3;

// ---------- Scenario A ----------
const A = evaluateScenario(acc, supply, meta, { scenario: "A" });
check("A tags capacity", A.tags.has("capacity"));
check("A tags eclo", A.tags.has("eclo"));
check("A hardFail", A.hardFail);
eq("A overrun score 1400", A.score, 1400);

// ---------- Scenario B ----------
const B = evaluateScenario(acc, supply, meta, { scenario: "B" });
check("B tags planned_date", B.tags.has("planned_date"));
eq("B excess nights 2", B.breakdown.excessNights, 2);
eq("B eclo nights 1", B.breakdown.ecloNights, 1);
eq("B score = 2*3 + 1*5", B.score, 2 * EXCESS_NIGHT_COST + 1 * ECLO_NIGHT_COST);

// ---------- Scenario C ----------
const C = evaluateScenario(acc, supply, meta, { scenario: "C", lineOf: () => "Alpha" });
check("C tags capacity (>=2 excess)", C.tags.has("capacity"));
eq("C excessNightsScored beyond allowance = 1", C.breakdown.excessNightsScored, 1);

// C continuity: span > 2 weeks -> eclo fail
const { rows: accSpan } = parseScheduleAccess(`activity_id,access_seq,week,eclo,access_night
X1,1,1,1,1
X1,2,4,1,1`);
const metaSpan = buildMeta({ activityRows: [{ activity: "X1", contract: "C1", location: "AlphaLoc", priority: 3 }] });
const Cspan = evaluateScenario(accSpan, [], metaSpan, { scenario: "C", lineOf: () => "Alpha" });
check("C continuity span>2 -> eclo tag", Cspan.tags.has("eclo"));
eq("C continuity span recorded 4", Cspan.continuityViolations[0].span, 4);

// C 2-night cap
const { rows: acc3 } = parseScheduleAccess(`activity_id,access_seq,week,eclo,access_night
Y1,1,1,1,1
Y1,2,2,1,1
Y1,3,1,1,2`);
const meta3 = buildMeta({ activityRows: [{ activity: "Y1", contract: "C1", location: "AlphaLoc", priority: 3 }] });
const C3 = evaluateScenario(acc3, [], meta3, { scenario: "C", lineOf: () => "Alpha" });
check("C 3 eclo nights -> eclo tag", C3.tags.has("eclo"));

// worked example: 6 ECLO nights -> B eclo score 30
const acc6body = Array.from({ length: 6 }, (_, i) => `Z${i},1,${i + 1},1,1`).join("\n");
const { rows: acc6 } = parseScheduleAccess("activity_id,access_seq,week,eclo,access_night\n" + acc6body);
const meta6 = buildMeta({ activityRows: acc6.map((r) => ({ activity: r.activity, contract: "C1", location: "L9", priority: 3 })) });
const B6 = evaluateScenario(acc6, [], meta6, { scenario: "B" });
eq("worked: 6 ECLO -> B eclo score 30", B6.breakdown.ecloScore, 30);

// clean feasible A
const { rows: accClean } = parseScheduleAccess(`activity_id,access_seq,week,eclo,access_night
G1,1,3,0,1
G1,2,4,0,1`);
const metaClean = buildMeta({ activityRows: [{ activity: "G1", contract: "C1", location: "L1", priority: 3 }] });
metaClean.get("G1").plannedWeek = 5; metaClean.get("G1").contractPriority = 1;
const Aclean = evaluateScenario(accClean, [{ location: "L1", capacity: 2 }], metaClean, { scenario: "A" });
check("clean A no hardFail", !Aclean.hardFail);
eq("clean A score 0", Aclean.score, 0);

// ---------- evaluateAllScenarios ----------
const all = evaluateAllScenarios(acc, supply, meta, { lineOf: () => "Alpha" });
eq("evaluateAll returns 3 keys", Object.keys(all).sort(), ["A", "B", "C"]);
check("evaluateAll A matches single", all.A.score === A.score);

// ---------- inferLine ----------
eq("inferLine H01 -> Alpha", inferLine("H01-H02-S1"), "Alpha");
check("inferLine unknown -> ?", inferLine("ZZZ") === "?");

// ---------- validateInputs ----------
const v = validateInputs({
  accessRows: [{ activity: "A1", week: 5 }, { activity: "A1", week: 5 }, { activity: "UNKNOWN", week: 2 }],
  activityRows: [{ activity: "A1", contract: "C1", location: "L1" }],
  supplyRows: [{ location: "L1", capacity: 2 }],
  projectRows: [],
  scheduleRows: [],
});
check("validate flags duplicate access", v.warnings.some((w) => /duplicate/i.test(w)));
check("validate flags unknown activity", v.warnings.some((w) => /not found/i.test(w)));
const vEmpty = validateInputs({ accessRows: [] });
check("validate errors on no access rows", vEmpty.errors.length > 0);

// ---------- buildOccupancyGrid ----------
const grid = buildOccupancyGrid(acc, supply, meta);
check("occupancy has L1", grid.locations.includes("L1"));
// A1 wk5 (1) + A2 wk5 (3) = 4 accesses at L1 week 5
eq("occupancy L1 wk5 count = 4", grid.grid.get("L1").get(5), 4);
eq("occupancy maxCount = 4", grid.maxCount, 4);

// ---------- report serializers ----------
const obj = reportToObject(A);
check("reportToObject has tags array", Array.isArray(obj.tags));
eq("reportToObject scenario A", obj.scenario, "A");
const csv = reportToCsv(all, "sub1");
check("reportToCsv has 3 data rows", csv.trim().split("\n").length === 4); // header + 3
check("reportToCsv contains PASS/FAIL", /FAIL|PASS/.test(csv));

// ---------- CLI-style: access-only (no supply/activities/projects) ----------
// Mirrors `node score.mjs --access ... --scenario all` with nothing else:
// engine must not crash and must degrade gracefully.
const { rows: accessOnly } = parseScheduleAccess(`activity_id,access_seq,week,eclo,access_night
P1,1,3,0,1
P1,2,4,1,1`);
const emptyMeta = buildMeta({ activityRows: [], projectRows: [], scheduleRows: [] });
for (const scn of SCENARIOS) {
  const r = evaluateScenario(accessOnly, [], emptyMeta, { scenario: scn, lineOf: inferLine });
  check(`access-only ${scn} does not throw & returns score`, typeof r.score === "number");
}
// With no supply, there can be no capacity excess.
const rAonly = evaluateScenario(accessOnly, [], emptyMeta, { scenario: "A", lineOf: inferLine });
check("access-only A: no capacity tag (no supply data)", !rAonly.tags.has("capacity"));
check("access-only A: eclo tag present (1 ECLO night)", rAonly.tags.has("eclo"));

// evaluateAllScenarios shape via CLI-style call
const allCli = evaluateAllScenarios(accessOnly, [], emptyMeta, { lineOf: inferLine });
check("CLI all: A/B/C all present", SCENARIOS.every((s) => allCli[s] && typeof allCli[s].score === "number"));

// ---------- summary ----------
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("Failed: " + failures.join("; ")); process.exit(1); }
process.exit(0);
