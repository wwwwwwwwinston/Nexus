// RFC-4180-ish CSV parser + trackopt schedule-result row typing.
// Handles quoted fields containing commas (the `weeks` column) and quoted
// double-quote escaping ("").

// Split a single CSV line into fields, honoring double-quoted sections.
function splitCsvLine(line) {
  const fields = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

// Parse the array-like weeks cell: "[20, 21]" -> [20, 21]; "[]" -> [].
function parseWeeks(raw) {
  if (raw == null) return [];
  const s = String(raw).trim();
  if (s === "" || s === "[]") return [];
  const inner = s.replace(/^\[/, "").replace(/\]$/, "").trim();
  if (inner === "") return [];
  return inner
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "")
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n));
}

function numOrNull(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// The columns we expect in a schedule-result CSV.
export const REQUIRED_COLUMNS = [
  "activity_id",
  "contract",
  "weight",
  "total_accesses",
  "delivered",
  "shortfall",
  "weeks",
  "finish_week",
  "planned_completion_week",
  "contract_deadline_week",
  "deadline_breach_weeks",
  "plan_slip_weeks",
];

// Parse a full CSV string into { rows, header, errors }.
export function parseScheduleCsv(text) {
  const errors = [];
  const clean = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = clean.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) {
    return { rows: [], header: [], errors: ["File is empty."] };
  }

  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    errors.push(`Missing required column(s): ${missing.join(", ")}`);
    return { rows: [], header, errors };
  }

  const idx = {};
  header.forEach((h, i) => (idx[h] = i));

  const rows = [];
  for (let li = 1; li < lines.length; li++) {
    const f = splitCsvLine(lines[li]);
    const get = (name) => f[idx[name]];

    const row = {
      activity_id: (get("activity_id") || "").trim(),
      contract: (get("contract") || "").trim(),
      weight: numOrNull(get("weight")) ?? 0,
      total_accesses: numOrNull(get("total_accesses")) ?? 0,
      delivered: numOrNull(get("delivered")) ?? 0,
      shortfall: numOrNull(get("shortfall")) ?? 0,
      weeks: parseWeeks(get("weeks")),
      finish_week: numOrNull(get("finish_week")),
      planned_completion_week: numOrNull(get("planned_completion_week")),
      contract_deadline_week: numOrNull(get("contract_deadline_week")),
      deadline_breach_weeks: numOrNull(get("deadline_breach_weeks")) ?? 0,
      plan_slip_weeks: numOrNull(get("plan_slip_weeks")) ?? 0,
    };

    if (!row.activity_id) {
      errors.push(`Row ${li + 1}: missing activity_id — skipped.`);
      continue;
    }
    rows.push(row);
  }

  if (rows.length === 0) {
    errors.push("No valid data rows found.");
  }
  return { rows, header, errors };
}

// Derive a per-activity status classification for coloring.
export function activityStatus(row) {
  if (row.shortfall > 0) return "shortfall";
  if (row.deadline_breach_weeks > 0) return "breach";
  if (row.plan_slip_weeks > 0) return "slip";
  return "ok";
}
