// Pre-solve input analysis.
//
// The trackopt solver consumes 8 input CSVs (see README / trackopt/io.py).
// The two that drive the "is this even feasible?" question are:
//   - 08_ACTIVITY_DETAILS.csv  -> demand: how many accesses each activity wants,
//                                 on which location, from when, at what priority
//   - 04_LOCATION_SUPPLY.csv    -> capacity: accesses/week each location can host
//
// Exact column names live in trackopt/io.py and can vary, so this module is
// tolerant: it matches columns by a set of candidate names (case-insensitive,
// ignoring spaces/underscores) rather than hard-coding one spelling.

const norm = (s) => String(s || "").toLowerCase().replace(/[\s_-]+/g, "");

// Reuse the same quote-aware line splitter shape as parse.js.
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

function parseGenericCsv(text) {
  const clean = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = clean.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return { header: [], rows: [] };
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const f = splitCsvLine(lines[i]);
    const obj = {};
    header.forEach((h, j) => (obj[h] = (f[j] ?? "").trim()));
    rows.push(obj);
  }
  return { header, rows };
}

// Find the first header whose normalized name matches any candidate.
function pick(header, candidates) {
  const wanted = candidates.map(norm);
  for (const h of header) {
    if (wanted.includes(norm(h))) return h;
  }
  return null;
}

function toNum(v) {
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

// Classify which of the 8 input files a CSV is, from its filename + columns.
export function classifyInput(filename, header) {
  const fn = norm(filename);
  const cols = header.map(norm);
  const has = (c) => cols.includes(norm(c));

  if (/locationsupply|04|supply/.test(fn) || (has("location_id") && (has("supply_capacity") || has("capacity"))))
    return "supply";
  if (/activitydetails|08|activity/.test(fn) || has("total_accesses") || has("activity_id"))
    return "activity";
  if (/projectdetails|07|project|contract/.test(fn) || has("contract_completion_date"))
    return "project";
  return "other";
}

// Parse a location-supply CSV -> [{location, capacity}]
export function parseSupply(text) {
  const { header, rows } = parseGenericCsv(text);
  const locCol = pick(header, ["location_id", "location", "sector_id", "sector", "id"]);
  const capCol = pick(header, ["supply_capacity", "capacity", "weekly_capacity", "supply"]);
  const out = [];
  for (const r of rows) {
    const location = locCol ? r[locCol] : "";
    const capacity = capCol ? toNum(r[capCol]) : null;
    if (location) out.push({ location, capacity: capacity ?? 0 });
  }
  return { rows: out, locCol, capCol };
}

// Parse an activity-details CSV
// -> [{activity, contract, location, accesses, priority, predecessor}]
export function parseActivities(text) {
  const { header, rows } = parseGenericCsv(text);
  const idCol = pick(header, ["activity_id", "activity", "id"]);
  const conCol = pick(header, ["contract", "contract_id", "project", "project_id"]);
  const locCol = pick(header, ["location_id", "location", "sector_id", "sector"]);
  const accCol = pick(header, ["total_accesses", "accesses", "requested_accesses", "number_of_accesses"]);
  const priCol = pick(header, ["activity_priority", "priority"]);
  const predCol = pick(header, [
    "predecessor_activity_id",
    "predecessor_activity",
    "predecessor",
    "predecessor_id",
    "depends_on",
  ]);
  const out = [];
  for (const r of rows) {
    const activity = idCol ? r[idCol] : "";
    if (!activity) continue;
    // Predecessor may be blank / "none" / "-" for activities with no dependency.
    let predecessor = predCol ? String(r[predCol] ?? "").trim() : "";
    if (/^(none|null|na|n\/a|-|nan)$/i.test(predecessor)) predecessor = "";
    out.push({
      activity,
      contract: conCol ? r[conCol] : "",
      location: locCol ? r[locCol] : "",
      accesses: accCol ? (toNum(r[accCol]) ?? 0) : 0,
      priority: priCol ? toNum(r[priCol]) : null,
      predecessor,
    });
  }
  return { rows: out, idCol, conCol, locCol, accCol, predCol };
}

// Verify the predecessor ordering constraint (Problem Statement §2.4 rule 3):
// a predecessor activity's LAST granted access must come strictly before its
// successor's FIRST granted access.
//
// scheduleRows: parsed schedule-result rows (have activity_id + weeks[])
// activityRows: parsed activity-details rows (have activity + predecessor)
// Returns { pairs, violations, satisfied, missing } where pairs is a list of
// { successor, predecessor, predFirst, predLast, succFirst, succLast, status }.
export function checkPrecedence(scheduleRows, activityRows) {
  // Map activity_id -> its granted weeks from the schedule result.
  const weeksById = new Map();
  for (const r of scheduleRows) {
    weeksById.set(r.activity_id, Array.isArray(r.weeks) ? r.weeks : []);
  }

  const pairs = [];
  let violations = 0;
  let satisfied = 0;
  let missing = 0;

  for (const a of activityRows) {
    if (!a.predecessor) continue; // no dependency declared
    const succWeeks = weeksById.get(a.activity);
    const predWeeks = weeksById.get(a.predecessor);

    const succHas = Array.isArray(succWeeks) && succWeeks.length > 0;
    const predHas = Array.isArray(predWeeks) && predWeeks.length > 0;

    const predFirst = predHas ? Math.min(...predWeeks) : null;
    const predLast = predHas ? Math.max(...predWeeks) : null;
    const succFirst = succHas ? Math.min(...succWeeks) : null;
    const succLast = succHas ? Math.max(...succWeeks) : null;

    let status;
    if (weeksById.get(a.activity) === undefined || weeksById.get(a.predecessor) === undefined) {
      // One of the activities isn't present in the schedule result at all.
      status = "unknown";
      missing++;
    } else if (!predHas || !succHas) {
      // If either side got no access, the ordering can't be violated on weeks.
      // Flag as "n/a" (nothing to compare) rather than a breach.
      status = "na";
      satisfied++;
    } else if (predLast < succFirst) {
      status = "ok";
      satisfied++;
    } else {
      status = "violation";
      violations++;
    }

    pairs.push({
      successor: a.activity,
      predecessor: a.predecessor,
      predFirst,
      predLast,
      succFirst,
      succLast,
      status,
    });
  }

  pairs.sort((x, y) => {
    const rank = { violation: 0, unknown: 1, na: 2, ok: 3 };
    if (rank[x.status] !== rank[y.status]) return rank[x.status] - rank[y.status];
    return x.successor.localeCompare(y.successor);
  });

  return { pairs, violations, satisfied, missing };
}

// Combine parsed supply + activity demand into a per-location feasibility view.
// horizonWeeks: the scheduling horizon (weeks) to compare demand against.
export function computeDemandVsCapacity(supplyRows, activityRows, horizonWeeks) {
  const supply = new Map();
  for (const s of supplyRows) supply.set(s.location, s.capacity);

  const demand = new Map(); // location -> { accesses, activities }
  for (const a of activityRows) {
    const loc = a.location || "(unspecified)";
    if (!demand.has(loc)) demand.set(loc, { accesses: 0, activities: 0 });
    const d = demand.get(loc);
    d.accesses += a.accesses;
    d.activities += 1;
  }

  const locations = new Set([...supply.keys(), ...demand.keys()]);
  const out = [];
  for (const loc of locations) {
    const cap = supply.has(loc) ? supply.get(loc) : null;
    const d = demand.get(loc) || { accesses: 0, activities: 0 };
    const maxDeliverable = cap == null ? null : cap * horizonWeeks;
    const overloaded = maxDeliverable != null && d.accesses > maxDeliverable;
    out.push({
      location: loc,
      capacity: cap,
      horizonWeeks,
      maxDeliverable,
      demandAccesses: d.accesses,
      demandActivities: d.activities,
      shortfallCapacity: overloaded ? d.accesses - maxDeliverable : 0,
      utilization: maxDeliverable ? d.accesses / maxDeliverable : null,
      overloaded,
    });
  }
  // Chokepoints (overloaded) first, then by utilization desc.
  out.sort((a, b) => {
    if (a.overloaded !== b.overloaded) return a.overloaded ? -1 : 1;
    const au = a.utilization == null ? -1 : a.utilization;
    const bu = b.utilization == null ? -1 : b.utilization;
    return bu - au;
  });
  return out;
}
