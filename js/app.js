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
  buildMeta,
  inferLine,
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
  accessRows: null, // parsed SCHEDULE_ACCESS.csv
  projectRows: null, // parsed 07_PROJECT_DETAILS.csv
  lineMap: {}, // location -> "Alpha" | "Beta"
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

function renderScenario() {
  const verdict = $("#scenario-verdict");
  const scoreHost = $("#scenario-score");
  const findHost = $("#scenario-findings");
  if (!verdict) return;
  verdict.className = "scenario-verdict";
  verdict.innerHTML = "";
  scoreHost.innerHTML = "";
  findHost.innerHTML = "";

  if (!state.accessRows) {
    verdict.classList.add("na");
    verdict.textContent = "Load SCHEDULE_ACCESS.csv (and the input files) to validate a submission.";
    return;
  }

  ensureLineMap();
  const meta = buildMeta({
    activityRows: state.activityInputRows || [],
    projectRows: state.projectRows || [],
    scheduleRows: state.rows || [],
  });
  const supply = state.supplyRows || [];
  const result = evaluateScenario(state.accessRows, supply, meta, {
    scenario: state.scenario,
    lineOf: (loc) => state.lineMap[loc] || inferLine(loc),
  });

  // Verdict banner
  if (result.hardFail) {
    verdict.classList.add("bad");
    verdict.appendChild(el("div", { class: "verdict-head" },
      `✗ Scenario ${state.scenario}: HARD FAIL`));
    verdict.appendChild(el("div", { class: "verdict-tags" },
      [...result.tags].map((t) => el("span", { class: "pill shortfall tag" }, t))));
  } else {
    verdict.classList.add("good");
    verdict.appendChild(el("div", { class: "verdict-head" },
      `✓ Scenario ${state.scenario}: FEASIBLE`));
    verdict.appendChild(el("div", { class: "verdict-sub" },
      `Soft score: ${result.score.toLocaleString()} (lower is better)`));
  }

  // Score breakdown cards
  const cards = [];
  cards.push({ label: "Soft score", value: result.score.toLocaleString(), sub: "lower is better", tone: result.hardFail ? "shortfall" : "ok" });
  const b = result.breakdown;
  if (b.overrunScore != null)
    cards.push({ label: "Priority-weighted overrun", value: b.overrunScore.toLocaleString(), sub: `${result.overrunDetails.length} late activity(ies)` });
  if (b.excessScore != null)
    cards.push({ label: "Excess access-nights", value: b.excessScore.toLocaleString(), sub: `${(b.excessNightsScored ?? b.excessNights ?? 0)} night(s) × 3` });
  if (b.ecloScore != null)
    cards.push({ label: "ECLO penalty", value: b.ecloScore.toLocaleString(), sub: `${b.ecloNights} night(s) × 5` });
  cards.push({ label: "ECLO nights total", value: result.ecloNightsTotal, sub: state.scenario === "A" ? "must be 0" : "used", tone: state.scenario === "A" && result.ecloNightsTotal > 0 ? "shortfall" : "" });

  for (const c of cards) {
    scoreHost.appendChild(el("div", { class: "card " + (c.tone || "") }, [
      el("div", { class: "card-label" }, c.label),
      el("div", { class: "card-value" }, String(c.value)),
      el("div", { class: "card-sub" }, c.sub),
    ]));
  }

  // Findings + detail tables
  if (result.findings.length === 0) {
    findHost.appendChild(el("div", { class: "empty" }, "No hard-fail findings for this scenario."));
  } else {
    const ul = el("ul", { class: "findings-list" });
    for (const f of result.findings) ul.appendChild(el("li", {}, f));
    findHost.appendChild(ul);
  }

  // Capacity detail
  if (result.capacityDetails.length) {
    findHost.appendChild(el("h4", { class: "detail-h" }, "Capacity — location-weeks over supply"));
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

  // Overrun detail (scenarios A/C)
  if (result.overrunDetails.length && (state.scenario === "A" || state.scenario === "C")) {
    findHost.appendChild(el("h4", { class: "detail-h" }, "Overrun — priority-weighted delay cost"));
    const t = el("table", { class: "grid" });
    t.appendChild(el("thead", {}, el("tr", {}, [
      el("th", {}, "Activity"), el("th", { class: "num" }, "Contract P"),
      el("th", { class: "num" }, "Activity P"), el("th", { class: "num" }, "Overrun days"),
      el("th", { class: "num" }, "Weight"), el("th", { class: "num" }, "Cost"),
    ])));
    const tb = el("tbody");
    for (const d of result.overrunDetails.slice(0, 50)) {
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

function setupScenarios() {
  document.querySelectorAll('input[name="scenario"]').forEach((r) => {
    r.addEventListener("change", (e) => {
      if (e.target.checked) {
        state.scenario = e.target.value;
        renderScenario();
      }
    });
  });

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
        renderScenario();
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

  // Load full sample submission (access + projects + inputs + result).
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
      renderScenario();
    } catch (err) {
      const v = $("#scenario-verdict");
      v.className = "scenario-verdict bad";
      v.textContent = "Could not load sample files (are you serving over HTTP?).";
    }
  });

  renderScenario();
}

// ---- Boot ----
window.addEventListener("DOMContentLoaded", () => {
  setupTabs();
  setupImport();
  setupControls();
  setupPresolve();
  setupScenarios();
  loadCsvText(DEFAULT_CSV, "Sample dataset (embedded)");
});
