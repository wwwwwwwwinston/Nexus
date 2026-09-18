// Serialize schedule rows back to the trackopt schedule-result CSV format
// and trigger a browser download. Round-trips cleanly through parse.js.
import { REQUIRED_COLUMNS } from "./parse.js";

function csvCell(value) {
  const s = value == null ? "" : String(value);
  // Quote if the cell contains a comma, quote, or newline.
  if (/[",\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Render one row object to a CSV line matching REQUIRED_COLUMNS order.
function rowToCsvFields(r) {
  return [
    r.activity_id,
    r.contract,
    r.weight,
    r.total_accesses,
    r.delivered,
    r.shortfall,
    // weeks serialized as "[a, b, c]" to match the source format
    "[" + r.weeks.join(", ") + "]",
    r.finish_week == null ? "" : r.finish_week,
    r.planned_completion_week == null ? "" : r.planned_completion_week,
    r.contract_deadline_week == null ? "" : r.contract_deadline_week,
    r.deadline_breach_weeks,
    r.plan_slip_weeks,
  ];
}

export function rowsToCsv(rows) {
  const lines = [REQUIRED_COLUMNS.join(",")];
  for (const r of rows) {
    lines.push(rowToCsvFields(r).map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}

export function downloadCsv(rows, filename = "schedule_export.csv") {
  const csv = rowsToCsv(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
