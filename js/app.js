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
  computeDemandVsCapacity,
} from "./inputs.js";

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
  const wireDrop = (labelId, inputId, kind) => {
    const label = $("#" + labelId);
    const input = $("#" + inputId);
    const stateSpan = $("#state-" + kind);

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

  wireDrop("drop-activities", "input-activities", "activity");
  wireDrop("drop-supply", "input-supply", "supply");

  $("#horizon-weeks").addEventListener("input", (e) => {
    const v = Number(e.target.value);
    state.horizonWeeks = Number.isFinite(v) && v > 0 ? v : 1;
    renderPresolve();
  });

  renderPresolve();
}

// ---- Boot ----
window.addEventListener("DOMContentLoaded", () => {
  setupTabs();
  setupImport();
  setupControls();
  setupPresolve();
  loadCsvText(DEFAULT_CSV, "Sample dataset (embedded)");
});
