// Scenario-aware validator + scorer for trackopt submissions (Scenarios A/B/C).
//
// Consumes SCHEDULE_ACCESS.csv (the per-access placement result) plus the input
// files (activity details + location supply) and produces, for a chosen
// scenario: a list of hard-fail tags (capacity / eclo / planned_date) and a
// soft-score breakdown.
//
// Cost model (confirmed):
//   overrun-day cost = tierBase * (1 + activityNudge) * overrunDays
//     tierBase  : {1:100, 2:10, 3:1}   (contract_priority)
//     nudge     : {1:+0.3, 2:+0.2, 3:+0.0} (activity_priority) - never crosses band
//   excess access-night = 3x each (loc-week accesses above supply_capacity)
//   ECLO-night          = 5x each (flat)
//   overrunDays = overrunWeeks * 7
//
// Per scenario:
//   A: hard-fail on ANY capacity excess (tag capacity) and ANY eclo (tag eclo).
//      Soft score = priority-weighted overrun only.
//   B: hard-fail on ANY overrun past planned date (tag planned_date).
//      Soft score = excess-nights(3x) + eclo(5x). No overrun term.
//   C: hard-fail on capacity excess > 1 per loc-week (tag capacity when >=2 excess),
//      and ECLO continuity-window violation per line (tag eclo).
//      Soft score = overrun + excess-nights(3x, beyond the 1/loc-week allowance) + eclo(5x).

// ---------- CSV parsing (quote-aware, shared shape with the other modules) ----------
function splitCsvLine(line) {
  const fields = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { fields.push(cur); cur = ""; }
    else cur += ch;
  }
  fields.push(cur);
  return fields;
}

const norm = (s) => String(s || "").toLowerCase().replace(/[\s_-]+/g, "");

function pick(header, candidates) {
  const wanted = candidates.map(norm);
  for (const h of header) if (wanted.includes(norm(h))) return h;
  return null;
}

function toNum(v) {
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

// Parse SCHEDULE_ACCESS.csv -> { rows: [{activity, seq, week, eclo, night}], errors }
export function parseScheduleAccess(text) {
  const errors = [];
  const clean = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = clean.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return { rows: [], errors: ["File is empty."] };

  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const idCol = pick(header, ["activity_id", "activity", "id"]);
  const seqCol = pick(header, ["access_seq", "seq", "sequence"]);
  const weekCol = pick(header, ["week", "wk"]);
  const ecloCol = pick(header, ["eclo"]);
  const nightCol = pick(header, ["access_night", "night"]);

  if (!idCol || !weekCol) {
    errors.push("SCHEDULE_ACCESS.csv needs at least activity_id and week columns.");
    return { rows: [], errors };
  }
  if (!ecloCol) errors.push("No 'eclo' column found — treating all accesses as non-ECLO (eclo=0).");

  const idx = {};
  header.forEach((h, i) => (idx[h] = i));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const f = splitCsvLine(lines[i]);
    const activity = (f[idx[idCol]] ?? "").trim();
    const week = toNum(f[idx[weekCol]]);
    if (!activity || week == null) continue;
    rows.push({
      activity,
      seq: seqCol ? toNum(f[idx[seqCol]]) : null,
      week,
      eclo: ecloCol ? (toNum(f[idx[ecloCol]]) === 1 ? 1 : 0) : 0,
      night: nightCol ? toNum(f[idx[nightCol]]) : null,
    });
  }
  if (rows.length === 0) errors.push("No valid access rows parsed.");
  return { rows, errors };
}

// ---------- Cost weights ----------
const TIER_BASE = { 1: 100, 2: 10, 3: 1 };
const TIER_NUDGE = { 1: 0.3, 2: 0.2, 3: 0.0 };
export const EXCESS_NIGHT_COST = 3;
export const ECLO_NIGHT_COST = 5;

// Overrun-day weight for one activity given its contract & activity priority.
// Falls back to tier 3 (weight 1) if a priority is missing/out of range.
export function overrunDayWeight(contractPriority, activityPriority) {
  const base = TIER_BASE[contractPriority] ?? TIER_BASE[3];
  const nudge = TIER_NUDGE[activityPriority] ?? 0;
  return base * (1 + nudge);
}

// Default Alpha/Beta line inference from a location string. Heuristic only —
// the UI lets the user override the mapping. Returns "Alpha" | "Beta" | "?".
export function inferLine(location) {
  const s = String(location || "").toUpperCase();
  // Common conventions: an "A"/"ALPHA"/"L1" prefix -> Alpha; "B"/"BETA"/"L2" -> Beta.
  if (/(^|[^A-Z])(ALPHA|LINE ?A|^A|L1|H01)/.test(s)) return "Alpha";
  if (/(^|[^A-Z])(BETA|LINE ?B|^B|L2|H02)/.test(s)) return "Beta";
  return "?";
}

// ---------- Core engine ----------
//
// Inputs:
//   accessRows   : parsed SCHEDULE_ACCESS rows
//   activityRows : parsed 08_ACTIVITY_DETAILS rows (activity, contract, location,
//                  accesses, priority[activity], and optionally contractPriority,
//                  planned/deadline weeks). We accept an enrichment map for the
//                  bits that live in other files.
//   supplyRows   : parsed 04_LOCATION_SUPPLY rows [{location, capacity}]
//   opts:
//     scenario       : "A" | "B" | "C"
//     meta           : Map activity_id -> {
//                        location, contractPriority, activityPriority,
//                        plannedWeek, finishWeek  }   (finishWeek optional;
//                        if absent we derive it from the last scheduled week)
//     lineOf         : function(location) -> "Alpha"|"Beta"|"?" (override of inferLine)
//
// Returns { scenario, tags:Set, hardFail:bool, findings:[], score, breakdown }.
export function evaluateScenario(accessRows, supplyRows, meta, opts) {
  const scenario = opts.scenario;
  const lineOf = opts.lineOf || ((loc) => inferLine(loc));

  const supplyCap = new Map();
  for (const s of supplyRows) supplyCap.set(s.location, s.capacity);

  const metaOf = (id) => meta.get(id) || {};
  const locOf = (id) => metaOf(id).location || "(unknown)";

  // ----- Per-location-week occupancy (capacity) -----
  // key: `${location}@@${week}` -> count of accesses
  const locWeek = new Map();
  for (const a of accessRows) {
    const loc = locOf(a.activity);
    const key = loc + "@@" + a.week;
    locWeek.set(key, (locWeek.get(key) || 0) + 1);
  }

  const capacityDetails = []; // { location, week, count, capacity, excess }
  let totalExcessNights = 0; // sum of all excess (accesses above cap)
  let excessNightsBeyondAllowance = 0; // for C: excess above the 1/loc-week allowance
  let locWeeksOverAllowance = 0; // for C hard-fail: loc-weeks with >=2 excess
  let anyCapacityExcess = false;

  for (const [key, count] of locWeek) {
    const [loc, wk] = key.split("@@");
    const cap = supplyCap.has(loc) ? supplyCap.get(loc) : null;
    if (cap == null) continue; // no capacity data for this location -> skip capacity check
    const excess = Math.max(0, count - cap);
    if (excess > 0) {
      anyCapacityExcess = true;
      totalExcessNights += excess;
      excessNightsBeyondAllowance += Math.max(0, excess - 1); // C allows 1 free/loc-week
      if (excess >= 2) locWeeksOverAllowance++;
      capacityDetails.push({ location: loc, week: Number(wk), count, capacity: cap, excess });
    }
  }
  capacityDetails.sort((a, b) => b.excess - a.excess || a.location.localeCompare(b.location));

  // ----- ECLO -----
  const ecloRows = accessRows.filter((a) => a.eclo === 1);
  const ecloNightsTotal = ecloRows.length;
  // ECLO per line, per activity (for C continuity window)
  const ecloByLine = { Alpha: [], Beta: [], "?": [] };
  for (const a of ecloRows) {
    const line = lineOf(locOf(a.activity));
    (ecloByLine[line] || ecloByLine["?"]).push(a);
  }

  // C continuity window: per line, all eclo weeks must fit a single span <= 2 weeks.
  // (span = maxWeek - minWeek + 1 <= 2). Cross-line activities are naturally
  // covered because their eclo rows appear under whichever line the location maps to;
  // we additionally cap any single activity to 2 eclo nights.
  const continuityViolations = [];
  for (const line of ["Alpha", "Beta"]) {
    const rows = ecloByLine[line];
    if (rows.length === 0) continue;
    const weeks = rows.map((r) => r.week);
    const span = Math.max(...weeks) - Math.min(...weeks) + 1;
    if (span > 2) {
      continuityViolations.push({
        line,
        span,
        weeks: [...new Set(weeks)].sort((a, b) => a - b),
      });
    }
  }
  // Cap: any activity with >2 eclo nights violates the window in C.
  const ecloPerActivity = new Map();
  for (const a of ecloRows) ecloPerActivity.set(a.activity, (ecloPerActivity.get(a.activity) || 0) + 1);
  const activityEcloCapViolations = [];
  for (const [act, n] of ecloPerActivity) {
    if (n > 2) activityEcloCapViolations.push({ activity: act, ecloNights: n });
  }

  // ----- Overrun (priority-weighted) -----
  // finish week per activity = last scheduled week (or meta.finishWeek if provided).
  const lastWeekByActivity = new Map();
  for (const a of accessRows) {
    const prev = lastWeekByActivity.get(a.activity);
    if (prev == null || a.week > prev) lastWeekByActivity.set(a.activity, a.week);
  }

  const overrunDetails = []; // { activity, contractPriority, activityPriority, overrunWeeks, overrunDays, weight, cost }
  let overrunScore = 0;
  let anyPlannedBreach = false;

  for (const [id, m] of meta) {
    const planned = m.plannedWeek;
    if (planned == null) continue;
    const finish = m.finishWeek != null ? m.finishWeek : lastWeekByActivity.get(id);
    if (finish == null) continue; // activity got no access -> no overrun measured here
    const overrunWeeks = Math.max(0, finish - planned);
    if (overrunWeeks <= 0) continue;
    anyPlannedBreach = true;
    const overrunDays = overrunWeeks * 7;
    const weight = overrunDayWeight(m.contractPriority, m.activityPriority);
    const cost = weight * overrunDays;
    overrunScore += cost;
    overrunDetails.push({
      activity: id,
      contractPriority: m.contractPriority ?? null,
      activityPriority: m.activityPriority ?? null,
      overrunWeeks,
      overrunDays,
      weight,
      cost,
    });
  }
  overrunDetails.sort((a, b) => b.cost - a.cost);

  // ----- Assemble per scenario -----
  const tags = new Set();
  const findings = [];
  let score = 0;
  const breakdown = {};

  if (scenario === "A") {
    // Hard-fails
    if (anyCapacityExcess) {
      tags.add("capacity");
      findings.push(`capacity: ${capacityDetails.length} location-week(s) exceed supply (total ${totalExcessNights} excess access-night(s)) — hard fail in A.`);
    }
    if (ecloNightsTotal > 0) {
      tags.add("eclo");
      findings.push(`eclo: ${ecloNightsTotal} ECLO night(s) used — ECLO is hard-forbidden in A.`);
    }
    // Soft: priority-weighted overrun only
    score = overrunScore;
    breakdown.overrunScore = overrunScore;
  } else if (scenario === "B") {
    // Hard-fail: any overrun past planned date
    if (anyPlannedBreach) {
      tags.add("planned_date");
      findings.push(`planned_date: ${overrunDetails.length} activity(ies) overrun their planned_completion_date — hard fail in B.`);
    }
    // Soft: excess-nights(3x) + eclo(5x)
    const excessScore = totalExcessNights * EXCESS_NIGHT_COST;
    const ecloScore = ecloNightsTotal * ECLO_NIGHT_COST;
    score = excessScore + ecloScore;
    breakdown.excessNights = totalExcessNights;
    breakdown.excessScore = excessScore;
    breakdown.ecloNights = ecloNightsTotal;
    breakdown.ecloScore = ecloScore;
  } else if (scenario === "C") {
    // Hard-fail: capacity excess > 1 per loc-week
    if (locWeeksOverAllowance > 0) {
      tags.add("capacity");
      findings.push(`capacity: ${locWeeksOverAllowance} location-week(s) exceed supply by 2+ (C allows only 1 excess/loc-week) — hard fail.`);
    }
    // Hard-fail: ECLO continuity window per line + per-activity 2-night cap
    if (continuityViolations.length > 0 || activityEcloCapViolations.length > 0) {
      tags.add("eclo");
      for (const v of continuityViolations)
        findings.push(`eclo: line ${v.line} ECLO nights span ${v.span} weeks (weeks ${v.weeks.join(", ")}) — exceeds the 2-week continuity window.`);
      for (const v of activityEcloCapViolations)
        findings.push(`eclo: activity ${v.activity} uses ${v.ecloNights} ECLO nights — exceeds the 2-night cap in C.`);
    }
    // Soft: overrun + excess-nights beyond allowance(3x) + eclo(5x)
    const excessScore = excessNightsBeyondAllowance * EXCESS_NIGHT_COST;
    const ecloScore = ecloNightsTotal * ECLO_NIGHT_COST;
    score = overrunScore + excessScore + ecloScore;
    breakdown.overrunScore = overrunScore;
    breakdown.excessNightsScored = excessNightsBeyondAllowance;
    breakdown.excessNightsTotal = totalExcessNights;
    breakdown.excessScore = excessScore;
    breakdown.ecloNights = ecloNightsTotal;
    breakdown.ecloScore = ecloScore;
  } else {
    findings.push(`Unknown scenario '${scenario}'.`);
  }

  return {
    scenario,
    tags,
    hardFail: tags.size > 0,
    findings,
    score,
    breakdown,
    // raw detail for the UI tables
    capacityDetails,
    overrunDetails,
    ecloNightsTotal,
    ecloByLine,
    continuityViolations,
    activityEcloCapViolations,
    totalExcessNights,
  };
}


// ---------- Meta assembly ----------
// Build the per-activity meta map the engine needs, from whatever the user loaded:
//   - activityRows  : from parseActivities (activity, contract, location, priority[=activity_priority])
//   - projectRows   : optional [{contract, contractPriority, plannedWeek, deadlineWeek}]
//   - scheduleRows  : optional parsed schedule_result rows (have planned_completion_week,
//                     finish_week, contract) — a convenient source for planned/finish weeks.
// Any field that can't be found is left null; the engine degrades gracefully.
export function buildMeta({ activityRows = [], projectRows = [], scheduleRows = [] }) {
  const meta = new Map();

  // contract -> contractPriority / plannedWeek (from project details if given)
  const projByContract = new Map();
  for (const p of projectRows) {
    if (p.contract) projByContract.set(p.contract, p);
  }

  // activity -> schedule-result row (planned_completion_week, finish_week)
  const schedByActivity = new Map();
  for (const r of scheduleRows) schedByActivity.set(r.activity_id, r);

  for (const a of activityRows) {
    const sched = schedByActivity.get(a.activity) || {};
    const proj = projByContract.get(a.contract) || {};
    meta.set(a.activity, {
      location: a.location || null,
      contract: a.contract || null,
      activityPriority: a.priority ?? null,
      contractPriority:
        proj.contractPriority ??
        (sched.contract_priority ?? null),
      plannedWeek:
        sched.planned_completion_week ??
        proj.plannedWeek ??
        null,
      finishWeek: sched.finish_week ?? null,
    });
  }

  // Also include any schedule-result activities not present in activityRows,
  // so overrun can still be measured for them.
  for (const r of scheduleRows) {
    if (meta.has(r.activity_id)) continue;
    const proj = projByContract.get(r.contract) || {};
    meta.set(r.activity_id, {
      location: null,
      contract: r.contract || null,
      activityPriority: r.weight != null ? null : null, // weight isn't a priority; leave null
      contractPriority: proj.contractPriority ?? null,
      plannedWeek: r.planned_completion_week ?? proj.plannedWeek ?? null,
      finishWeek: r.finish_week ?? null,
    });
  }

  return meta;
}
