import { DEFAULT_CSV } from "./data.js";
import { parseScheduleCsv, activityStatus, REQUIRED_COLUMNS } from "./parse.js";
import {
  computeSummary,
  computeContractRollups,
  computeWeeklyLoad,
} from "./metrics.js";
import { downloadCsv } from "./export.js";
import {
  classifyInput,
  parseSupply,
  parseActivities,
  parseProjects,
  computeDemandVsCapacity,
  checkPrecedence,
} from "./inputs.js";
import {
  parseScheduleAccess,
  evaluateScenario,
  evaluateAllScenarios,
  buildMeta,
  inferLine,
  validateInputs,
  buildOccupancyGrid,
  reportToObject,
  reportToCsv,
  SCENARIOS,
  SCENARIO_LABEL,
  EXCESS_NIGHT_COST,
  ECLO_NIGHT_COST,
} from "./scenario.js";

// ---- App state ----
const state = {
  rows: [],
  datasetName: "Sample dataset (embedded)",
  sortKey: "activity_id",
  sortDir: 1, // 1 asc, -1 desc
  filterText: "",
  filterContract: "__all__",
  filterStatus: "__all__",
  // Pre-solve input analysis state
  supplyRows: null, // [{location, capacity}]
  activityInputRows: null, // [{activity, contract, location, accesses, priority}]
  horizonWeeks: 30,
  // Scenario state
  scenario: "A",
  accessRows: null, // parsed SCHEDULE_ACCESS.csv (the loaded submission)
  projectRows: null, // parsed 07_PROJECT_DETAILS.csv
  lineMap: {}, // location -> "Alpha" | "Beta"
  subview: "single", // single | compare | charts | whatif
  whatifRows: null, // working copy of accessRows for what-if edits
  batch: [], // [{name, accessRows}]
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function")
      node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
};

const STATUS_LABEL = {
  ok: "On track",
  shortfall: "Shortfall",
  breach: "Deadline breach",
  slip: "Plan slip",
};

// ---- Loading ----
function loadCsvText(text, name) {
  const { rows, errors } = parseScheduleCsv(text);
  if (rows.length === 0) {
    showImportMessage(
      "error",
      "Could not load data. " + (errors.join(" ") || "No rows parsed."),
    );
    return false;
  }
  state.rows = rows;
  state.datasetName = name;
  state.filterContract = "__all__";
  state.filterStatus = "__all__";
  state.filterText = "";
  if (errors.length > 0) {
    showImportMessage(
      "warn",
      `Loaded ${rows.length} rows with ${errors.length} warning(s): ${errors.slice(0, 3).join(" ")}`,
    );
  } else {
    showImportMessage("ok", `Loaded ${rows.length} activities from ${name}.`);
  }
  renderAll();
  return true;
}

function showImportMessage(kind, msg) {
  const box = $("#import-msg");
  box.className = "import-msg " + kind;
  box.textContent = msg;
}

// ---- Filtering & sorting ----
function visibleRows() {
  let rows = state.rows.slice();
  const t = state.filterText.trim().toLowerCase();
  if (t) {
    rows = rows.filter(
      (r) =>
        r.activity_id.toLowerCase().includes(t) ||
        r.contract.toLowerCase().includes(t),
    );
  }
  if (state.filterContract !== "__all__") {
    rows = rows.filter((r) => r.contract === state.filterContract);
  }
  if (state.filterStatus !== "__all__") {
    rows = rows.filter((r) => activityStatus(r) === state.filterStatus);
  }
  const k = state.sortKey;
  rows.sort((a, b) => {
    let av = a[k];
    let bv = b[k];
    if (k === "weeks") {
      av = a.weeks.length;
      bv = b.weeks.length;
    }
    if (av == null) av = -Infinity;
    if (bv == null) bv = -Infinity;
    if (typeof av === "string") return av.localeCompare(bv) * state.sortDir;
    return (av - bv) * state.sortDir;
  });
  return rows;
}

// ---- Renderers ----
function renderSummary() {
  const s = computeSummary(state.rows);
  const host = $("#summary");
  host.innerHTML = "";
  const pct = (s.deliveryRate * 100).toFixed(1);
  const cards = [
    { label: "Activities", value: s.activities, sub: `${s.contracts} contracts` },
    {
      label: "Delivery rate",
      value: pct + "%",
      sub: `${s.totalDelivered}/${s.totalRequested} accesses`,
      tone: s.deliveryRate >= 0.999 ? "ok" : s.deliveryRate >= 0.9 ? "slip" : "shortfall",
    },
    {
      label: "Total shortfall",
      value: s.totalShortfall,
      sub: `${s.activitiesWithShortfall} activities · wtd ${s.weightedShortfall}`,
      tone: s.totalShortfall === 0 ? "ok" : "shortfall",
    },
    {
      label: "Unserved activities",
      value: s.activitiesUnserved,
      sub: "0 accesses delivered",
      tone: s.activitiesUnserved === 0 ? "ok" : "shortfall",
    },
    {
      label: "Deadline breaches",
      value: s.activitiesBreaching,
      sub: `${s.deadlineBreachWeeks} wk · wtd ${s.weightedDeadlineBreach}`,
      tone: s.activitiesBreaching === 0 ? "ok" : "breach",
    },
    {
      label: "Plan slippage",
      value: s.activitiesSlipping,
      sub: `${s.planSlipWeeks} wk · wtd ${s.weightedPlanSlip}`,
      tone: s.activitiesSlipping === 0 ? "ok" : "slip",
    },
  ];
  for (const c of cards) {
    host.appendChild(
      el("div", { class: "card " + (c.tone || "") }, [
        el("div", { class: "card-label" }, c.label),
        el("div", { class: "card-value" }, String(c.value)),
        el("div", { class: "card-sub" }, c.sub),
      ]),
    );
  }
}

function sortHeader(label, key, numeric) {
  const active = state.sortKey === key;
  const arrow = active ? (state.sortDir === 1 ? " ▲" : " ▼") : "";
  return el(
    "th",
    {
      class: (numeric ? "num " : "") + (active ? "sorted" : "") + " sortable",
      onclick: () => {
        if (state.sortKey === key) state.sortDir *= -1;
        else {
          state.sortKey = key;
          state.sortDir = 1;
        }
        renderTable();
      },
    },
    label + arrow,
  );
}

function miniBar(delivered, requested) {
  const wrap = el("div", { class: "bar-wrap", title: `${delivered}/${requested}` });
  const pct = requested > 0 ? (delivered / requested) * 100 : 100;
  const full = requested > 0 && delivered >= requested;
  wrap.appendChild(
    el("div", {
      class: "bar-fill " + (full ? "full" : "partial"),
      style: `width:${pct}%`,
    }),
  );
  return wrap;
}

function renderTable() {
  const rows = visibleRows();
  const host = $("#table-host");
  host.innerHTML = "";
  $("#table-count").textContent = `${rows.length} shown / ${state.rows.length} total`;

  const table = el("table", { class: "grid" });
  const thead = el("thead", {}, [
    el("tr", {}, [
      sortHeader("Activity", "activity_id"),
      sortHeader("Contract", "contract"),
      sortHeader("Wt", "weight", true),
      sortHeader("Req", "total_accesses", true),
      sortHeader("Del", "delivered", true),
      el("th", {}, "Delivery"),
      sortHeader("Short", "shortfall", true),
      sortHeader("Weeks", "weeks", true),
      sortHeader("Finish", "finish_week", true),
      sortHeader("Plan", "planned_completion_week", true),
      sortHeader("Deadline", "contract_deadline_week", true),
      sortHeader("Breach", "deadline_breach_weeks", true),
      sortHeader("Slip", "plan_slip_weeks", true),
      el("th", {}, "Status"),
    ]),
  ]);
  table.appendChild(thead);

  const tbody = el("tbody");
  for (const r of rows) {
    const st = activityStatus(r);
    const tr = el("tr", { class: "row-" + st });
    tr.appendChild(el("td", { class: "mono" }, r.activity_id));
    tr.appendChild(el("td", { class: "mono" }, r.contract));
    tr.appendChild(el("td", { class: "num" }, String(r.weight)));
    tr.appendChild(el("td", { class: "num" }, String(r.total_accesses)));
    tr.appendChild(el("td", { class: "num" }, String(r.delivered)));
    tr.appendChild(el("td", {}, miniBar(r.delivered, r.total_accesses)));
    tr.appendChild(
      el("td", { class: "num" + (r.shortfall > 0 ? " bad" : "") }, String(r.shortfall)),
    );
    tr.appendChild(
      el("td", { class: "mono weeks", title: `[${r.weeks.join(", ")}]` },
        r.weeks.length ? `[${r.weeks.join(", ")}]` : "—"),
    );
    tr.appendChild(el("td", { class: "num" }, r.finish_week == null ? "—" : String(r.finish_week)));
    tr.appendChild(el("td", { class: "num" }, r.planned_completion_week == null ? "—" : String(r.planned_completion_week)));
    tr.appendChild(el("td", { class: "num" }, r.contract_deadline_week == null ? "—" : String(r.contract_deadline_week)));
    tr.appendChild(
      el("td", { class: "num" + (r.deadline_breach_weeks > 0 ? " bad" : "") }, String(r.deadline_breach_weeks)),
    );
    tr.appendChild(
      el("td", { class: "num" + (r.plan_slip_weeks > 0 ? " warn" : "") }, String(r.plan_slip_weeks)),
    );
    tr.appendChild(el("td", {}, el("span", { class: "pill " + st }, STATUS_LABEL[st])));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  if (rows.length === 0) {
    host.appendChild(el("div", { class: "empty" }, "No activities match the current filters."));
  } else {
    host.appendChild(table);
  }
}

function renderFilters() {
  const contractSel = $("#filter-contract");
  const contracts = [...new Set(state.rows.map((r) => r.contract))].sort();
  contractSel.innerHTML = "";
  contractSel.appendChild(el("option", { value: "__all__" }, "All contracts"));
  for (const c of contracts) contractSel.appendChild(el("option", { value: c }, c));
  contractSel.value = state.filterContract;
}

function renderTimeline() {
  const s = computeSummary(state.rows);
  const maxWeek = Math.max(s.maxWeek, 1);
  const load = computeWeeklyLoad(state.rows, maxWeek);
  const peak = Math.max(1, ...load);
  const host = $("#timeline-host");
  host.innerHTML = "";

  // Week-load histogram header
  const legend = el("div", { class: "tl-legend" }, [
    el("span", { class: "swatch full" }),
    "granted access week   ",
    el("span", { class: "swatch deadline-mark" }),
    "contract deadline   ",
    el("span", { class: "swatch plan-mark" }),
    "planned completion",
  ]);
  host.appendChild(legend);

  const loadRow = el("div", { class: "tl-load-row" });
  loadRow.appendChild(el("div", { class: "tl-rowhead" }, "Network load"));
  const loadTrack = el("div", { class: "tl-track load" });
  for (let w = 0; w <= maxWeek; w++) {
    const h = Math.round((load[w] / peak) * 100);
    loadTrack.appendChild(
      el("div", {
        class: "tl-load-cell",
        title: `Week ${w}: ${load[w]} activities`,
        style: `--h:${h}%`,
      }, el("span", { class: "tl-load-fill", style: `height:${h}%` })),
    );
  }
  loadRow.appendChild(loadTrack);
  host.appendChild(loadRow);

  // One row per activity, respecting current filters/sort
  const rows = visibleRows();
  const chart = el("div", { class: "tl-chart" });
  for (const r of rows) {
    const st = activityStatus(r);
    const line = el("div", { class: "tl-row" });
    line.appendChild(
      el("div", { class: "tl-rowhead" }, [
        el("span", { class: "mono" }, r.activity_id),
        el("span", { class: "tl-sub" }, r.contract),
      ]),
    );
    const track = el("div", { class: "tl-track" });
    const set = new Set(r.weeks);
    for (let w = 0; w <= maxWeek; w++) {
      const classes = ["tl-cell"];
      if (set.has(w)) classes.push("granted", st);
      if (w === r.contract_deadline_week) classes.push("deadline-mark");
      if (w === r.planned_completion_week) classes.push("plan-mark");
      const title =
        `Week ${w}` +
        (set.has(w) ? " · access granted" : "") +
        (w === r.contract_deadline_week ? " · contract deadline" : "") +
        (w === r.planned_completion_week ? " · planned completion" : "");
      track.appendChild(el("div", { class: classes.join(" "), title }));
    }
    line.appendChild(track);
    chart.appendChild(line);
  }
  host.appendChild(chart);

  // Axis
  const axis = el("div", { class: "tl-row axis" });
  axis.appendChild(el("div", { class: "tl-rowhead" }, "Week"));
  const axisTrack = el("div", { class: "tl-track" });
  for (let w = 0; w <= maxWeek; w++) {
    axisTrack.appendChild(el("div", { class: "tl-cell axis-cell" }, w % 5 === 0 ? String(w) : ""));
  }
  axis.appendChild(axisTrack);
  host.appendChild(axis);
}

function renderContracts() {
  const host = $("#contracts-host");
  host.innerHTML = "";
  const rollups = computeContractRollups(state.rows);
  const table = el("table", { class: "grid" });
  table.appendChild(
    el("thead", {}, el("tr", {}, [
      el("th", {}, "Contract"),
      el("th", { class: "num" }, "Activities"),
      el("th", { class: "num" }, "Requested"),
      el("th", { class: "num" }, "Delivered"),
      el("th", { class: "num" }, "Shortfall"),
      el("th", { class: "num" }, "Breach wk"),
      el("th", { class: "num" }, "Slip wk"),
      el("th", { class: "num" }, "Deadline wk"),
    ])),
  );
  const tbody = el("tbody");
  for (const c of rollups) {
    const bad = c.shortfall > 0 || c.breachWeeks > 0;
    tbody.appendChild(
      el("tr", { class: bad ? "row-shortfall" : "" }, [
        el("td", { class: "mono" }, c.contract),
        el("td", { class: "num" }, String(c.activities)),
        el("td", { class: "num" }, String(c.requested)),
        el("td", { class: "num" }, String(c.delivered)),
        el("td", { class: "num" + (c.shortfall > 0 ? " bad" : "") }, String(c.shortfall)),
        el("td", { class: "num" + (c.breachWeeks > 0 ? " bad" : "") }, String(c.breachWeeks)),
        el("td", { class: "num" + (c.slipWeeks > 0 ? " warn" : "") }, String(c.slipWeeks)),
        el("td", { class: "num" }, c.deadline == null ? "—" : String(c.deadline)),
      ]),
    );
  }
  table.appendChild(tbody);
  host.appendChild(table);
}

function renderAll() {
  $("#dataset-name").textContent = state.datasetName;
  renderSummary();
  renderFilters();
  renderTable();
  renderTimeline();
  renderContracts();
}

// ---- Tabs ----
function setupTabs() {
  const tabs = document.querySelectorAll(".tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const target = tab.dataset.target;
      document.querySelectorAll(".panel").forEach((p) => {
        p.classList.toggle("hidden", p.id !== target);
      });
    });
  });
}

// ---- Import wiring ----
function setupImport() {
  const fileInput = $("#file-input");
  const drop = $("#dropzone");

  const readFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => loadCsvText(String(reader.result), file.name);
    reader.onerror = () => showImportMessage("error", "Failed to read file.");
    reader.readAsText(file);
  };

  fileInput.addEventListener("change", (e) => readFile(e.target.files[0]));
  drop.addEventListener("click", () => fileInput.click());
  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add("hover");
    }),
  );
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove("hover");
    }),
  );
  drop.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files[0];
    readFile(file);
  });

  $("#load-sample").addEventListener("click", () => {
    loadCsvText(DEFAULT_CSV, "Sample dataset (embedded)");
  });

  $("#load-paste").addEventListener("click", () => {
    const text = $("#paste-area").value;
    if (!text.trim()) {
      showImportMessage("error", "Paste some CSV text first.");
      return;
    }
    loadCsvText(text, "Pasted CSV");
  });

  $("#expected-cols").textContent = REQUIRED_COLUMNS.join(", ");
}

// ---- Search/filter wiring ----
function setupControls() {
  $("#search").addEventListener("input", (e) => {
    state.filterText = e.target.value;
    renderTable();
    renderTimeline();
  });
  $("#filter-contract").addEventListener("change", (e) => {
    state.filterContract = e.target.value;
    renderTable();
    renderTimeline();
  });
  $("#filter-status").addEventListener("change", (e) => {
    state.filterStatus = e.target.value;
    renderTable();
    renderTimeline();
  });
  $("#export-btn").addEventListener("click", () => {
    const rows = visibleRows();
    if (rows.length === 0) return;
    const base = state.datasetName.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
    downloadCsv(rows, `${base || "schedule"}_export.csv`);
  });
}

// ---- Pre-solve (input analysis) ----
function renderPresolve() {
  const sumHost = $("#presolve-summary");
  const host = $("#presolve-host");
  sumHost.innerHTML = "";
  host.innerHTML = "";

  if (!state.activityInputRows && !state.supplyRows) {
    host.appendChild(
      el("div", { class: "empty" },
        "Load 08_ACTIVITY_DETAILS.csv and 04_LOCATION_SUPPLY.csv above to see the demand-vs-capacity picture."),
    );
    renderPrecedence(state.activityInputRows || []);
    return;
  }

  const supply = state.supplyRows || [];
  const acts = state.activityInputRows || [];
  const analysis = computeDemandVsCapacity(supply, acts, state.horizonWeeks);

  const chokepoints = analysis.filter((a) => a.overloaded);
  const totalDemand = analysis.reduce((s, a) => s + a.demandAccesses, 0);
  const totalStructuralShortfall = analysis.reduce((s, a) => s + a.shortfallCapacity, 0);

  const cards = [
    { label: "Locations", value: analysis.length, sub: `${supply.length} with capacity data` },
    { label: "Activities (demand)", value: acts.length, sub: `${totalDemand} accesses requested` },
    {
      label: "Chokepoints",
      value: chokepoints.length,
      sub: "capacity < demand over horizon",
      tone: chokepoints.length === 0 ? "ok" : "shortfall",
    },
    {
      label: "Structural shortfall",
      value: totalStructuralShortfall,
      sub: "accesses that cannot fit",
      tone: totalStructuralShortfall === 0 ? "ok" : "shortfall",
    },
  ];
  for (const c of cards) {
    sumHost.appendChild(
      el("div", { class: "card " + (c.tone || "") }, [
        el("div", { class: "card-label" }, c.label),
        el("div", { class: "card-value" }, String(c.value)),
        el("div", { class: "card-sub" }, c.sub),
      ]),
    );
  }

  const table = el("table", { class: "grid" });
  table.appendChild(
    el("thead", {}, el("tr", {}, [
      el("th", {}, "Location"),
      el("th", { class: "num" }, "Capacity/wk"),
      el("th", { class: "num" }, "Horizon"),
      el("th", { class: "num" }, "Max deliverable"),
      el("th", { class: "num" }, "Demand"),
      el("th", { class: "num" }, "Activities"),
      el("th", {}, "Utilisation"),
      el("th", { class: "num" }, "Cannot fit"),
      el("th", {}, "Status"),
    ])),
  );
  const tbody = el("tbody");
  for (const a of analysis) {
    const util = a.utilization == null ? null : a.utilization;
    const utilPct = util == null ? "—" : (util * 100).toFixed(0) + "%";
    tbody.appendChild(
      el("tr", { class: a.overloaded ? "row-shortfall" : "" }, [
        el("td", { class: "mono" }, a.location),
        el("td", { class: "num" }, a.capacity == null ? "—" : String(a.capacity)),
        el("td", { class: "num" }, String(a.horizonWeeks)),
        el("td", { class: "num" }, a.maxDeliverable == null ? "—" : String(a.maxDeliverable)),
        el("td", { class: "num" }, String(a.demandAccesses)),
        el("td", { class: "num" }, String(a.demandActivities)),
        el("td", {}, utilBar(util)),
        el("td", { class: "num" + (a.shortfallCapacity > 0 ? " bad" : "") }, String(a.shortfallCapacity)),
        el("td", {}, el("span", { class: "pill " + (a.overloaded ? "shortfall" : "ok") },
          a.overloaded ? "Chokepoint" : (a.capacity == null ? "No capacity data" : "OK"))),
      ]),
    );
  }
  table.appendChild(tbody);
  host.appendChild(table);

  renderPrecedence(acts);
}

// Render the predecessor-ordering verification against the loaded schedule result.
function renderPrecedence(activityRows) {
  const host = $("#precedence-host");
  const banner = $("#precedence-banner");
  if (!host) return;
  host.innerHTML = "";
  banner.className = "precedence-banner";
  banner.textContent = "";

  const hasPredCol = activityRows.some((a) => a.predecessor);
  if (!activityRows.length) {
    host.appendChild(el("div", { class: "empty" },
      "Load 08_ACTIVITY_DETAILS.csv above to check predecessor ordering."));
    return;
  }
  if (!hasPredCol) {
    banner.classList.add("na");
    banner.textContent =
      "No predecessor_activity_id values found in the loaded activity file — nothing to check.";
    return;
  }

  const { pairs, violations, satisfied, missing } = checkPrecedence(
    state.rows,
    activityRows,
  );

  if (violations > 0) {
    banner.classList.add("bad");
    banner.textContent =
      `✗ ${violations} predecessor ordering violation(s) in the loaded schedule — ` +
      `a successor starts before its predecessor finishes.`;
  } else {
    banner.classList.add("good");
    banner.textContent =
      `✓ All ${pairs.length} predecessor dependency(ies) satisfied` +
      (missing ? ` (${missing} could not be checked — activity absent from result).` : ".");
  }

  const table = el("table", { class: "grid" });
  table.appendChild(
    el("thead", {}, el("tr", {}, [
      el("th", {}, "Successor"),
      el("th", {}, "Predecessor"),
      el("th", { class: "num" }, "Pred. last wk"),
      el("th", { class: "num" }, "Succ. first wk"),
      el("th", {}, "Status"),
    ])),
  );
  const tbody = el("tbody");
  const LABEL = {
    violation: "Violation",
    ok: "OK",
    na: "No access (n/a)",
    unknown: "Not in result",
  };
  const PILL = { violation: "shortfall", ok: "ok", na: "slip", unknown: "breach" };
  for (const p of pairs) {
    tbody.appendChild(
      el("tr", { class: p.status === "violation" ? "row-shortfall" : "" }, [
        el("td", { class: "mono" }, p.successor),
        el("td", { class: "mono" }, p.predecessor),
        el("td", { class: "num" }, p.predLast == null ? "—" : String(p.predLast)),
        el("td", { class: "num" }, p.succFirst == null ? "—" : String(p.succFirst)),
        el("td", {}, el("span", { class: "pill " + PILL[p.status] }, LABEL[p.status])),
      ]),
    );
  }
  table.appendChild(tbody);
  host.appendChild(table);
}

function utilBar(util) {
  const wrap = el("div", { class: "bar-wrap wide", title: util == null ? "n/a" : (util * 100).toFixed(0) + "%" });
  if (util == null) return wrap;
  const pct = Math.min(util * 100, 100);
  wrap.appendChild(
    el("div", {
      class: "bar-fill " + (util > 1 ? "partial" : "full"),
      style: `width:${pct}%`,
    }),
  );
  return wrap;
}

function setupPresolve() {
  const wireDrop = (labelId, inputId, stateId, kind) => {
    const label = $("#" + labelId);
    const input = $("#" + inputId);
    const stateSpan = $("#" + stateId);

    const handle = (file) => {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result);
        if (kind === "supply") {
          const { rows } = parseSupply(text);
          state.supplyRows = rows;
          stateSpan.textContent = `${rows.length} locations · ${file.name}`;
        } else {
          const { rows } = parseActivities(text);
          state.activityInputRows = rows;
          stateSpan.textContent = `${rows.length} activities · ${file.name}`;
        }
        stateSpan.classList.add("loaded");
        renderPresolve();
      };
      reader.readAsText(file);
    };

    input.addEventListener("change", (e) => handle(e.target.files[0]));
    ["dragenter", "dragover"].forEach((ev) =>
      label.addEventListener(ev, (e) => { e.preventDefault(); label.classList.add("hover"); }));
    ["dragleave", "drop"].forEach((ev) =>
      label.addEventListener(ev, (e) => { e.preventDefault(); label.classList.remove("hover"); }));
    label.addEventListener("drop", (e) => handle(e.dataTransfer.files[0]));
  };

  wireDrop("drop-activities", "input-activities", "state-activities", "activity");
  wireDrop("drop-supply", "input-supply", "state-supply", "supply");

  $("#horizon-weeks").addEventListener("input", (e) => {
    const v = Number(e.target.value);
    state.horizonWeeks = Number.isFinite(v) && v > 0 ? v : 1;
    renderPresolve();
  });

  renderPresolve();
}

// ---- Scenarios (A/B/C validator + scorer) ----

// Build/refresh the location -> line map, keeping any user overrides.
function ensureLineMap() {
  const locs = new Set();
  for (const a of state.activityInputRows || []) if (a.location) locs.add(a.location);
  for (const s of state.supplyRows || []) if (s.location) locs.add(s.location);
  for (const loc of locs) {
    if (!state.lineMap[loc]) {
      const inf = inferLine(loc);
      state.lineMap[loc] = inf === "?" ? "Alpha" : inf;
    }
  }
}

function renderLineMapping() {
  const host = $("#line-mapping");
  if (!host) return;
  host.innerHTML = "";
  const locs = Object.keys(state.lineMap).sort();
  if (locs.length === 0) {
    host.appendChild(el("div", { class: "empty" }, "Load the activity/supply files to populate locations."));
    return;
  }
  for (const loc of locs) {
    const row = el("label", { class: "lm-row" }, [
      el("span", { class: "mono lm-loc" }, loc),
      (() => {
        const sel = el("select", {
          onchange: (e) => {
            state.lineMap[loc] = e.target.value;
            renderScenario();
          },
        }, [
          el("option", { value: "Alpha" }, "Alpha"),
          el("option", { value: "Beta" }, "Beta"),
        ]);
        sel.value = state.lineMap[loc];
        return sel;
      })(),
    ]);
    host.appendChild(row);
  }
}

// Shared meta + supply builders used across scenario sub-views.
function scenarioMeta() {
  return buildMeta({
    activityRows: state.activityInputRows || [],
    projectRows: state.projectRows || [],
    scheduleRows: state.rows || [],
  });
}
function lineOf(loc) {
  return state.lineMap[loc] || inferLine(loc);
}
function evalOne(scenario, accessRows) {
  return evaluateScenario(accessRows || state.accessRows, state.supplyRows || [], scenarioMeta(), {
    scenario,
    lineOf,
  });
}

// Build the verdict banner into a host element; tags are clickable to scroll to detail.
function renderVerdict(host, result, scenario) {
  host.className = "scenario-verdict";
  host.innerHTML = "";
  if (result.hardFail) {
    host.classList.add("bad");
    host.appendChild(el("div", { class: "verdict-head" }, `✗ Scenario ${scenario}: HARD FAIL`));
    host.appendChild(el("div", { class: "verdict-tags" },
      [...result.tags].map((t) =>
        el("span", {
          class: "pill shortfall tag clickable",
          title: "Jump to detail",
          onclick: () => {
            const anchor = document.getElementById("detail-" + t);
            if (anchor) anchor.scrollIntoView({ behavior: "smooth", block: "center" });
          },
        }, t))));
  } else {
    host.classList.add("good");
    host.appendChild(el("div", { class: "verdict-head" }, `✓ Scenario ${scenario}: FEASIBLE`));
    host.appendChild(el("div", { class: "verdict-sub" },
      `Soft score: ${result.score.toLocaleString()} (lower is better)`));
  }
}

function scoreCards(result, scenario) {
  const cards = [];
  cards.push({ label: "Soft score", value: result.score.toLocaleString(), sub: "lower is better", tone: result.hardFail ? "shortfall" : "ok" });
  const b = result.breakdown;
  if (b.overrunScore != null)
    cards.push({ label: "Priority-weighted overrun", value: b.overrunScore.toLocaleString(), sub: `${result.overrunDetails.length} late activity(ies)` });
  if (b.excessScore != null)
    cards.push({ label: "Excess access-nights", value: b.excessScore.toLocaleString(), sub: `${(b.excessNightsScored ?? b.excessNights ?? 0)} night(s) × ${EXCESS_NIGHT_COST}` });
  if (b.ecloScore != null)
    cards.push({ label: "ECLO penalty", value: b.ecloScore.toLocaleString(), sub: `${b.ecloNights} night(s) × ${ECLO_NIGHT_COST}` });
  cards.push({ label: "ECLO nights total", value: result.ecloNightsTotal, sub: scenario === "A" ? "must be 0" : "used", tone: scenario === "A" && result.ecloNightsTotal > 0 ? "shortfall" : "" });
  return cards;
}

function renderScenario() {
  renderValidation();
  renderColumnMapping();
  const verdict = $("#scenario-verdict");
  const scoreHost = $("#scenario-score");
  const findHost = $("#scenario-findings");
  if (!verdict) return;
  scoreHost.innerHTML = "";
  findHost.innerHTML = "";

  if (!state.accessRows) {
    verdict.className = "scenario-verdict na";
    verdict.textContent = "Load SCHEDULE_ACCESS.csv (and the input files) to validate a submission.";
    renderLineMapping();
    return;
  }

  ensureLineMap();
  const result = evalOne(state.scenario);
  renderVerdict(verdict, result, state.scenario);

  for (const c of scoreCards(result, state.scenario)) {
    scoreHost.appendChild(el("div", { class: "card " + (c.tone || "") }, [
      el("div", { class: "card-label" }, c.label),
      el("div", { class: "card-value" }, String(c.value)),
      el("div", { class: "card-sub" }, c.sub),
    ]));
  }

  // Findings
  if (result.findings.length === 0) {
    findHost.appendChild(el("div", { class: "empty" }, "No hard-fail findings for this scenario."));
  } else {
    const ul = el("ul", { class: "findings-list" });
    for (const f of result.findings) ul.appendChild(el("li", {}, f));
    findHost.appendChild(ul);
  }

  // Capacity detail (anchored for tag drill-down)
  if (result.capacityDetails.length) {
    const h = el("h4", { class: "detail-h", id: "detail-capacity" }, "Capacity — location-weeks over supply");
    findHost.appendChild(h);
    const t = el("table", { class: "grid" });
    t.appendChild(el("thead", {}, el("tr", {}, [
      el("th", {}, "Location"), el("th", { class: "num" }, "Week"),
      el("th", { class: "num" }, "Accesses"), el("th", { class: "num" }, "Capacity"),
      el("th", { class: "num" }, "Excess"),
    ])));
    const tb = el("tbody");
    for (const d of result.capacityDetails) {
      tb.appendChild(el("tr", { class: "row-shortfall" }, [
        el("td", { class: "mono" }, d.location),
        el("td", { class: "num" }, String(d.week)),
        el("td", { class: "num" }, String(d.count)),
        el("td", { class: "num" }, String(d.capacity)),
        el("td", { class: "num bad" }, String(d.excess)),
      ]));
    }
    t.appendChild(tb);
    findHost.appendChild(t);
  }

  // ECLO detail (anchored)
  if (result.tags.has("eclo") || result.ecloNightsTotal > 0) {
    findHost.appendChild(el("h4", { class: "detail-h", id: "detail-eclo" }, "ECLO — nights used"));
    const lines = [];
    for (const v of result.continuityViolations)
      lines.push(`Line ${v.line}: ECLO weeks ${v.weeks.join(", ")} span ${v.span} > 2 (C window).`);
    for (const v of result.activityEcloCapViolations)
      lines.push(`Activity ${v.activity}: ${v.ecloNights} ECLO nights > 2-night cap (C).`);
    if (lines.length) {
      const ul = el("ul", { class: "findings-list" });
      for (const l of lines) ul.appendChild(el("li", {}, l));
      findHost.appendChild(ul);
    }
    const counts = { Alpha: result.ecloByLine.Alpha.length, Beta: result.ecloByLine.Beta.length, "?": result.ecloByLine["?"].length };
    findHost.appendChild(el("p", { class: "hint small" },
      `Total ECLO nights: ${result.ecloNightsTotal} (Alpha ${counts.Alpha}, Beta ${counts.Beta}${counts["?"] ? ", unmapped " + counts["?"] : ""}).`));
  }

  // Overrun detail (anchored under planned_date for B, always shown for A/C)
  if (result.overrunDetails.length) {
    const anchorId = state.scenario === "B" ? "detail-planned_date" : "detail-overrun";
    findHost.appendChild(el("h4", { class: "detail-h", id: anchorId }, "Overrun — priority-weighted delay cost"));
    const t = el("table", { class: "grid" });
    t.appendChild(el("thead", {}, el("tr", {}, [
      el("th", {}, "Activity"), el("th", { class: "num" }, "Contract P"),
      el("th", { class: "num" }, "Activity P"), el("th", { class: "num" }, "Overrun days"),
      el("th", { class: "num" }, "Weight"), el("th", { class: "num" }, "Cost"),
    ])));
    const tb = el("tbody");
    for (const d of result.overrunDetails.slice(0, 80)) {
      tb.appendChild(el("tr", {}, [
        el("td", { class: "mono" }, d.activity),
        el("td", { class: "num" }, d.contractPriority == null ? "—" : String(d.contractPriority)),
        el("td", { class: "num" }, d.activityPriority == null ? "—" : String(d.activityPriority)),
        el("td", { class: "num" }, String(d.overrunDays)),
        el("td", { class: "num" }, String(d.weight)),
        el("td", { class: "num bad" }, d.cost.toLocaleString()),
      ]));
    }
    t.appendChild(tb);
    findHost.appendChild(t);
  }

  renderLineMapping();
}

// ---- Input validation (#6) ----
function renderValidation() {
  const host = $("#scenario-validation");
  if (!host) return;
  host.innerHTML = "";
  if (!state.accessRows) return;
  const { errors, warnings } = validateInputs({
    accessRows: state.accessRows,
    activityRows: state.activityInputRows || [],
    supplyRows: state.supplyRows || [],
    projectRows: state.projectRows || [],
    scheduleRows: state.rows || [],
  });
  if (errors.length === 0 && warnings.length === 0) {
    host.appendChild(el("div", { class: "validation-msg ok" }, "✓ Inputs look structurally consistent."));
    return;
  }
  for (const e of errors) host.appendChild(el("div", { class: "validation-msg error" }, "⚠ " + e));
  for (const w of warnings) host.appendChild(el("div", { class: "validation-msg warn" }, "• " + w));
}

// ---- Column mapping (#10) ----
// If the activity/supply files have headers we couldn't auto-map, let the user
// pick which column maps to the required field.
function renderColumnMapping() {
  const host = $("#column-mapping");
  if (!host) return;
  host.innerHTML = "";
  const issues = [];
  if (state.supplyRows && state.supplyRows.length && state.supplyRows.every((s) => s.capacity === 0))
    issues.push("Every supply capacity parsed as 0 — the capacity column may not have been recognised.");
  if (state.activityInputRows && state.activityInputRows.length &&
      state.activityInputRows.every((a) => !a.location))
    issues.push("No activity locations parsed — the location column may not have been recognised.");
  if (issues.length === 0) return;
  host.appendChild(el("div", { class: "colmap-head" }, "Column mapping may be needed"));
  for (const i of issues) host.appendChild(el("div", { class: "validation-msg warn" }, "• " + i));
  host.appendChild(el("div", { class: "hint small" },
    "The parser matches columns by common names (case/spacing-insensitive). If your headers differ, rename them to a recognised alias (e.g. location_id, supply_capacity, total_accesses, activity_priority, contract) and reload."));
}

// ---- Compare A/B/C (#1) ----
function renderCompare() {
  const host = $("#compare-host");
  if (!host) return;
  host.innerHTML = "";
  if (!state.accessRows) {
    host.appendChild(el("div", { class: "empty" }, "Load a submission to compare across scenarios."));
    return;
  }
  ensureLineMap();
  const all = evaluateAllScenarios(state.accessRows, state.supplyRows || [], scenarioMeta(), { lineOf });
  for (const sc of SCENARIOS) {
    const r = all[sc];
    const col = el("div", { class: "compare-col " + (r.hardFail ? "fail" : "pass") });
    col.appendChild(el("div", { class: "compare-head" }, [
      el("span", { class: "compare-sc" }, "Scenario " + sc),
      el("span", { class: "compare-sub" }, SCENARIO_LABEL[sc]),
    ]));
    col.appendChild(el("div", { class: "compare-verdict " + (r.hardFail ? "bad" : "good") },
      r.hardFail ? "✗ HARD FAIL" : "✓ FEASIBLE"));
    if (r.hardFail)
      col.appendChild(el("div", { class: "verdict-tags" },
        [...r.tags].map((t) => el("span", { class: "pill shortfall tag" }, t))));
    col.appendChild(el("div", { class: "compare-score" }, r.score.toLocaleString()));
    col.appendChild(el("div", { class: "compare-scorelabel" }, "soft score"));
    const b = r.breakdown;
    const rows = [];
    if (b.overrunScore != null) rows.push(["Overrun", b.overrunScore]);
    if (b.excessScore != null) rows.push(["Excess ×" + EXCESS_NIGHT_COST, b.excessScore]);
    if (b.ecloScore != null) rows.push(["ECLO ×" + ECLO_NIGHT_COST, b.ecloScore]);
    const bd = el("div", { class: "compare-breakdown" });
    for (const [k, v] of rows)
      bd.appendChild(el("div", { class: "cb-row" }, [el("span", {}, k), el("span", { class: "mono" }, v.toLocaleString())]));
    col.appendChild(bd);
    host.appendChild(col);
  }
}

// ---- Charts (#7) ----
function renderCharts() {
  if (!state.accessRows) {
    $("#chart-heatmap").innerHTML = '<div class="empty">Load a submission to see charts.</div>';
    $("#chart-eclo").innerHTML = "";
    $("#chart-score").innerHTML = "";
    return;
  }
  ensureLineMap();
  const meta = scenarioMeta();
  const grid = buildOccupancyGrid(state.accessRows, state.supplyRows || [], meta);

  // Heatmap
  const hm = $("#chart-heatmap");
  hm.innerHTML = "";
  if (grid.locations.length === 0) {
    hm.appendChild(el("div", { class: "empty" }, "No occupancy data."));
  } else {
    const table = el("div", { class: "heatmap" });
    // header row
    const head = el("div", { class: "hm-row hm-head" });
    head.appendChild(el("div", { class: "hm-loc" }, "Location"));
    for (const w of grid.weeks) head.appendChild(el("div", { class: "hm-cell hm-wk" }, w % 5 === 0 ? String(w) : ""));
    table.appendChild(head);
    for (const loc of grid.locations) {
      const row = el("div", { class: "hm-row" });
      const cap = grid.capacityByLoc.has(loc) ? grid.capacityByLoc.get(loc) : null;
      row.appendChild(el("div", { class: "hm-loc mono", title: cap == null ? loc : `${loc} (cap ${cap})` }, loc));
      for (const w of grid.weeks) {
        const c = grid.grid.get(loc).get(w) || 0;
        const over = cap != null && c > cap;
        const intensity = grid.maxCount ? c / grid.maxCount : 0;
        const cell = el("div", {
          class: "hm-cell" + (over ? " over" : c > 0 ? " on" : ""),
          title: `${loc} · week ${w}: ${c} access${c === 1 ? "" : "es"}${cap != null ? ` / cap ${cap}` : ""}`,
          style: c > 0 && !over ? `--i:${intensity.toFixed(2)}` : "",
        }, c > 0 ? String(c) : "");
        row.appendChild(cell);
      }
      table.appendChild(row);
    }
    hm.appendChild(table);
  }

  // ECLO per line (grouped bar over weeks)
  const ec = $("#chart-eclo");
  ec.innerHTML = "";
  const ecloRows = state.accessRows.filter((a) => a.eclo === 1);
  if (ecloRows.length === 0) {
    ec.appendChild(el("div", { class: "empty" }, "No ECLO nights in this submission."));
  } else {
    const byLineWeek = {}; // line -> Map(week->count)
    let maxWk = 0, minWk = Infinity, maxC = 1;
    for (const a of ecloRows) {
      const line = lineOf(meta.get(a.activity)?.location || "");
      byLineWeek[line] = byLineWeek[line] || new Map();
      const c = (byLineWeek[line].get(a.week) || 0) + 1;
      byLineWeek[line].set(a.week, c);
      maxC = Math.max(maxC, c);
      maxWk = Math.max(maxWk, a.week); minWk = Math.min(minWk, a.week);
    }
    for (const line of Object.keys(byLineWeek)) {
      const track = el("div", { class: "eclo-track" });
      track.appendChild(el("div", { class: "eclo-linelabel" }, "Line " + line));
      const bars = el("div", { class: "eclo-bars" });
      for (let w = minWk; w <= maxWk; w++) {
        const c = byLineWeek[line].get(w) || 0;
        bars.appendChild(el("div", {
          class: "eclo-bar" + (c ? " on" : ""),
          title: `Line ${line} · week ${w}: ${c} ECLO night(s)`,
          style: `--h:${Math.round((c / maxC) * 100)}%`,
        }, el("span", { class: "eclo-fill", style: `height:${Math.round((c / maxC) * 100)}%` })));
      }
      track.appendChild(bars);
      ec.appendChild(track);
    }
  }

  // Score contribution bar (current scenario)
  const sc = $("#chart-score");
  sc.innerHTML = "";
  const r = evalOne(state.scenario);
  const b = r.breakdown;
  const parts = [];
  if (b.overrunScore) parts.push(["Overrun", b.overrunScore, "var(--shortfall)"]);
  if (b.excessScore) parts.push(["Excess nights", b.excessScore, "var(--slip)"]);
  if (b.ecloScore) parts.push(["ECLO", b.ecloScore, "var(--breach)"]);
  const total = parts.reduce((s, p) => s + p[1], 0);
  if (total === 0) {
    sc.appendChild(el("div", { class: "empty" }, `Scenario ${state.scenario}: soft score is 0.`));
  } else {
    const bar = el("div", { class: "stackbar" });
    for (const [label, val, color] of parts) {
      bar.appendChild(el("div", {
        class: "stackseg",
        title: `${label}: ${val.toLocaleString()} (${((val / total) * 100).toFixed(0)}%)`,
        style: `width:${(val / total) * 100}%;background:${color}`,
      }, (val / total) > 0.08 ? label : ""));
    }
    sc.appendChild(bar);
    const legend = el("div", { class: "stack-legend" });
    for (const [label, val, color] of parts)
      legend.appendChild(el("span", { class: "sl-item" }, [
        el("span", { class: "sl-sw", style: `background:${color}` }), `${label}: ${val.toLocaleString()}`,
      ]));
    sc.appendChild(legend);
  }
}

// ---- What-if (#5) ----
function renderWhatif() {
  const sel = $("#whatif-activity");
  const verdictHost = $("#whatif-verdict");
  const deltaHost = $("#whatif-delta");
  if (!sel) return;
  if (!state.accessRows) {
    verdictHost.className = "scenario-verdict na";
    verdictHost.textContent = "Load a submission first.";
    deltaHost.innerHTML = "";
    sel.innerHTML = "";
    return;
  }
  if (!state.whatifRows) state.whatifRows = state.accessRows.map((a) => ({ ...a }));

  // populate activity dropdown (once / on change of loaded data)
  const acts = [...new Set(state.whatifRows.map((a) => a.activity))].sort();
  if (sel.options.length !== acts.length) {
    sel.innerHTML = "";
    for (const a of acts) sel.appendChild(el("option", { value: a }, a));
  }
  const chosen = sel.value || acts[0];
  const weeks = state.whatifRows.filter((a) => a.activity === chosen).map((a) => a.week).sort((x, y) => x - y);
  $("#whatif-current").textContent = `current weeks: [${weeks.join(", ")}]`;

  // Evaluate baseline vs current what-if for the active scenario
  const base = evalOne(state.scenario, state.accessRows);
  const now = evalOne(state.scenario, state.whatifRows);
  renderVerdict(verdictHost, now, state.scenario);

  deltaHost.innerHTML = "";
  const dScore = now.score - base.score;
  const arrow = dScore === 0 ? "→" : dScore < 0 ? "▼" : "▲";
  const tone = dScore < 0 ? "good" : dScore > 0 ? "bad" : "";
  deltaHost.appendChild(el("div", { class: "delta-line " + tone },
    `Score ${base.score.toLocaleString()} ${arrow} ${now.score.toLocaleString()} (${dScore >= 0 ? "+" : ""}${dScore.toLocaleString()})`));
  const baseTags = [...base.tags].join(",") || "none";
  const nowTags = [...now.tags].join(",") || "none";
  if (baseTags !== nowTags)
    deltaHost.appendChild(el("div", { class: "delta-line" }, `Hard-fail tags: [${baseTags}] → [${nowTags}]`));
}

// ---- Sub-view switching ----
function showSubview(name) {
  state.subview = name;
  document.querySelectorAll("#scenario-subnav .subtab").forEach((t) =>
    t.classList.toggle("active", t.dataset.sub === name));
  document.querySelectorAll("#panel-scenarios .subview").forEach((v) =>
    v.classList.toggle("hidden", v.id !== "sub-" + name));
  if (name === "single") renderScenario();
  else if (name === "compare") renderCompare();
  else if (name === "charts") renderCharts();
  else if (name === "whatif") renderWhatif();
}

// Re-render whichever sub-view is active (after data changes).
function refreshScenarioViews() {
  showSubview(state.subview);
}

// ---- Export (#4) ----
function downloadText(text, filename, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function setupScenarios() {
  // scenario radios
  document.querySelectorAll('input[name="scenario"]').forEach((r) => {
    r.addEventListener("change", (e) => {
      if (e.target.checked) {
        state.scenario = e.target.value;
        refreshScenarioViews();
      }
    });
  });

  // sub-nav
  document.querySelectorAll("#scenario-subnav .subtab").forEach((t) =>
    t.addEventListener("click", () => showSubview(t.dataset.sub)));

  const onLoaded = () => { state.whatifRows = null; refreshScenarioViews(); };

  const wireDrop = (labelId, inputId, stateId, kind) => {
    const label = $("#" + labelId);
    const input = $("#" + inputId);
    const stateSpan = $("#" + stateId);
    const handle = (file) => {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result);
        if (kind === "access") {
          const { rows, errors } = parseScheduleAccess(text);
          state.accessRows = rows;
          stateSpan.textContent = `${rows.length} accesses · ${file.name}`;
          if (errors.length) stateSpan.textContent += ` (${errors.length} warning)`;
        } else {
          const { rows } = parseProjects(text);
          state.projectRows = rows;
          stateSpan.textContent = `${rows.length} contracts · ${file.name}`;
        }
        stateSpan.classList.add("loaded");
        onLoaded();
      };
      reader.readAsText(file);
    };
    input.addEventListener("change", (e) => handle(e.target.files[0]));
    ["dragenter", "dragover"].forEach((ev) =>
      label.addEventListener(ev, (e) => { e.preventDefault(); label.classList.add("hover"); }));
    ["dragleave", "drop"].forEach((ev) =>
      label.addEventListener(ev, (e) => { e.preventDefault(); label.classList.remove("hover"); }));
    label.addEventListener("drop", (e) => handle(e.dataTransfer.files[0]));
  };
  wireDrop("drop-access", "input-access", "state-access", "access");
  wireDrop("drop-projects", "input-projects", "state-projects", "projects");

  // sample loader
  $("#load-scenario-sample").addEventListener("click", async () => {
    try {
      const base = "data/sample_inputs/";
      const [accessTxt, projTxt, actTxt, supTxt] = await Promise.all([
        fetch(base + "SCHEDULE_ACCESS.csv").then((r) => r.text()),
        fetch(base + "07_PROJECT_DETAILS.csv").then((r) => r.text()),
        fetch(base + "08_ACTIVITY_DETAILS.csv").then((r) => r.text()),
        fetch(base + "04_LOCATION_SUPPLY.csv").then((r) => r.text()),
      ]);
      state.accessRows = parseScheduleAccess(accessTxt).rows;
      state.projectRows = parseProjects(projTxt).rows;
      state.activityInputRows = parseActivities(actTxt).rows;
      state.supplyRows = parseSupply(supTxt).rows;
      $("#state-access").textContent = `${state.accessRows.length} accesses · SCHEDULE_ACCESS.csv`;
      $("#state-access").classList.add("loaded");
      $("#state-projects").textContent = `${state.projectRows.length} contracts · 07_PROJECT_DETAILS.csv`;
      $("#state-projects").classList.add("loaded");
      state.lineMap = {};
      onLoaded();
    } catch (err) {
      const v = $("#scenario-verdict");
      v.className = "scenario-verdict bad";
      v.textContent = "Could not load sample files (are you serving over HTTP?).";
    }
  });

  // export buttons
  $("#export-report-json").addEventListener("click", () => {
    if (!state.accessRows) return;
    ensureLineMap();
    const all = evaluateAllScenarios(state.accessRows, state.supplyRows || [], scenarioMeta(), { lineOf });
    const obj = { generatedAt: new Date().toISOString(), scenarios: {} };
    for (const sc of SCENARIOS) obj.scenarios[sc] = reportToObject(all[sc]);
    downloadText(JSON.stringify(obj, null, 2), "scenario_report.json", "application/json");
  });
  $("#export-report-csv").addEventListener("click", () => {
    if (!state.accessRows) return;
    ensureLineMap();
    const all = evaluateAllScenarios(state.accessRows, state.supplyRows || [], scenarioMeta(), { lineOf });
    downloadText(reportToCsv(all, "submission"), "scenario_report.csv", "text/csv");
  });

  // what-if controls
  $("#whatif-activity").addEventListener("change", renderWhatif);
  $("#whatif-apply").addEventListener("click", () => {
    const act = $("#whatif-activity").value;
    const wk = Number($("#whatif-week").value);
    if (!act || !Number.isFinite(wk)) return;
    if (!state.whatifRows) state.whatifRows = state.accessRows.map((a) => ({ ...a }));
    const which = $("#whatif-which").value; // "last" | "first"
    // Move the activity's last (default) or first access to the chosen week.
    // The last access drives finish-week / overrun, so it's the impactful lever.
    const rows = state.whatifRows
      .filter((a) => a.activity === act)
      .sort((a, b) => a.week - b.week);
    if (rows.length) {
      const target = which === "first" ? rows[0] : rows[rows.length - 1];
      target.week = wk;
    }
    renderWhatif();
  });
  $("#whatif-reset").addEventListener("click", () => {
    state.whatifRows = state.accessRows ? state.accessRows.map((a) => ({ ...a })) : null;
    renderWhatif();
  });

  renderScenario();
}

// ---- Batch scoring (#2) ----
function renderBatch() {
  const host = $("#batch-host");
  if (!host) return;
  host.innerHTML = "";
  if (state.batch.length === 0) {
    host.appendChild(el("div", { class: "empty" }, "Drop one or more SCHEDULE_ACCESS.csv files to build a leaderboard."));
    return;
  }
  ensureLineMap();
  const meta = scenarioMeta();
  const supply = state.supplyRows || [];
  const rowsData = state.batch.map((sub) => {
    const all = evaluateAllScenarios(sub.accessRows, supply, meta, { lineOf });
    return { name: sub.name, all };
  });

  const table = el("table", { class: "grid" });
  table.appendChild(el("thead", {}, el("tr", {}, [
    el("th", {}, "Submission"),
    el("th", {}, "A"), el("th", { class: "num" }, "A score"),
    el("th", {}, "B"), el("th", { class: "num" }, "B score"),
    el("th", {}, "C"), el("th", { class: "num" }, "C score"),
  ])));
  const tb = el("tbody");
  // Rank by C score among feasible-C first, then others.
  rowsData.sort((x, y) => {
    const xf = x.all.C.hardFail, yf = y.all.C.hardFail;
    if (xf !== yf) return xf ? 1 : -1;
    return x.all.C.score - y.all.C.score;
  });
  const cell = (r) => {
    const td = el("td", {}, el("span", { class: "pill " + (r.hardFail ? "shortfall" : "ok") }, r.hardFail ? "FAIL" : "PASS"));
    return td;
  };
  for (const rd of rowsData) {
    tb.appendChild(el("tr", {}, [
      el("td", { class: "mono" }, rd.name),
      cell(rd.all.A), el("td", { class: "num" }, rd.all.A.score.toLocaleString()),
      cell(rd.all.B), el("td", { class: "num" }, rd.all.B.score.toLocaleString()),
      cell(rd.all.C), el("td", { class: "num" }, rd.all.C.score.toLocaleString()),
    ]));
  }
  table.appendChild(tb);
  host.appendChild(table);
}

function setupBatch() {
  const label = $("#drop-batch");
  const input = $("#input-batch");
  const stateSpan = $("#state-batch");
  if (!label) return;
  const handleFiles = (fileList) => {
    const files = [...fileList];
    let pending = files.length;
    if (pending === 0) return;
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const { rows } = parseScheduleAccess(String(reader.result));
        state.batch.push({ name: file.name, accessRows: rows });
        if (--pending === 0) {
          stateSpan.textContent = `${state.batch.length} submission(s) loaded`;
          stateSpan.classList.add("loaded");
          renderBatch();
        }
      };
      reader.readAsText(file);
    }
  };
  input.addEventListener("change", (e) => handleFiles(e.target.files));
  label.addEventListener("click", () => input.click());
  ["dragenter", "dragover"].forEach((ev) =>
    label.addEventListener(ev, (e) => { e.preventDefault(); label.classList.add("hover"); }));
  ["dragleave", "drop"].forEach((ev) =>
    label.addEventListener(ev, (e) => { e.preventDefault(); label.classList.remove("hover"); }));
  label.addEventListener("drop", (e) => handleFiles(e.dataTransfer.files));

  $("#batch-clear").addEventListener("click", () => {
    state.batch = [];
    stateSpan.textContent = "none loaded";
    stateSpan.classList.remove("loaded");
    renderBatch();
  });
  $("#batch-export").addEventListener("click", () => {
    if (state.batch.length === 0) return;
    ensureLineMap();
    const meta = scenarioMeta();
    const supply = state.supplyRows || [];
    let csv = "";
    state.batch.forEach((sub, i) => {
      const all = evaluateAllScenarios(sub.accessRows, supply, meta, { lineOf });
      const part = reportToCsv(all, sub.name);
      csv += i === 0 ? part : part.split("\n").slice(1).join("\n");
    });
    downloadText(csv, "batch_leaderboard.csv", "text/csv");
  });

  renderBatch();
}

// ---- Theme (#8) ----
function setupTheme() {
  const btn = $("#theme-toggle");
  const apply = (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    if (btn) btn.textContent = theme === "light" ? "☀️" : "🌙";
  };
  let saved = "dark";
  try { saved = localStorage.getItem("trackopt-theme") || "dark"; } catch (e) {}
  apply(saved);
  if (btn) btn.addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    apply(next);
    try { localStorage.setItem("trackopt-theme", next); } catch (e) {}
  });
}

// ---- Keyboard navigation (#8): Alt+1..7 switch tabs, [ / ] cycle ----
function setupKeyboardNav() {
  window.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    const tabs = [...document.querySelectorAll(".tabs .tab")];
    if (e.altKey && e.key >= "1" && e.key <= "9") {
      const i = Number(e.key) - 1;
      if (tabs[i]) { tabs[i].click(); e.preventDefault(); }
    } else if (e.key === "[" || e.key === "]") {
      const active = tabs.findIndex((t) => t.classList.contains("active"));
      if (active >= 0) {
        const next = e.key === "]" ? (active + 1) % tabs.length : (active - 1 + tabs.length) % tabs.length;
        tabs[next].click();
        e.preventDefault();
      }
    }
  });
}

// ---- Boot ----
window.addEventListener("DOMContentLoaded", () => {
  setupTheme();
  setupTabs();
  setupImport();
  setupControls();
  setupPresolve();
  setupScenarios();
  setupBatch();
  setupKeyboardNav();
  loadCsvText(DEFAULT_CSV, "Sample dataset (embedded)");
});
