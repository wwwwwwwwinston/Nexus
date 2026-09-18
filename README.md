# trackopt — schedule viewer (web UI)

A zero-dependency, offline web UI for viewing and testing
`trackopt` nightly track-possession schedule results.

It loads a `schedule_result.csv` (the output of `python3 -m trackopt.cli`)
and shows:

- **Overview** — headline KPIs (delivery rate, total/weighted shortfall,
  unserved activities, deadline breaches, plan slippage) plus a sortable,
  filterable per-activity table with status pills and delivery bars.
- **Timeline** — a week-by-week grid: one row per activity showing which
  weeks it was granted track access, coloured by status, with markers for
  each activity's planned-completion and contract-deadline weeks, over a
  network-load histogram.
- **Contracts** — per-contract rollup of requested vs delivered accesses
  and total breach / slippage.
- **Pre-solve** — load the solver's *input* CSVs (`08_ACTIVITY_DETAILS.csv`
  for demand and `04_LOCATION_SUPPLY.csv` for capacity) to see, before running
  a solve, which locations are chokepoints — where total contracted demand
  exceeds what weekly capacity can deliver over the horizon. Overloaded
  locations (e.g. the H01↔H02 single-track sectors) are flagged, showing
  exactly how many accesses structurally cannot fit. This tab **also verifies
  predecessor ordering** (Problem Statement §2.4 rule 3): it reads the
  `predecessor_activity_id` column and checks the loaded schedule result so
  that each predecessor's *last* granted week comes before its successor's
  *first* granted week, flagging any violation.
- **Scenarios A/B/C** — validate and score a submission under any of the three
  scoring regimes (see below). Load `SCHEDULE_ACCESS.csv` (per-access placement
  with the `eclo` flag) plus the input files; the engine reports hard-fail tags
  (`capacity` / `eclo` / `planned_date`) and the soft-score breakdown. Four
  sub-views:
  - **Single** — one scenario in depth: verdict, score cards, findings, and
    clickable hard-fail tags that jump to the offending detail. Export the full
    A/B/C report as **JSON or CSV**.
  - **Compare A/B/C** — all three verdicts + scores side by side for the same
    submission.
  - **Charts** — a capacity heatmap (accesses per location-week, over-capacity
    cells flagged), ECLO nights per line, and a score-contribution bar.
  - **What-if** — move an access to a different week and watch the score /
    hard-fails update live against the baseline.
- **Batch** — drop several `SCHEDULE_ACCESS.csv` submissions and get a ranked
  leaderboard (pass/fail + score per scenario); export it as CSV.
- **Import data** — drop a CSV, pick a file, or paste CSV text to load a
  different solve result. Everything runs locally in the browser; nothing
  is uploaded.

The Overview toolbar also has an **Export CSV** button that downloads the
currently filtered/sorted rows back to the schedule-result CSV format (it
round-trips cleanly through the importer).

## Scenarios A / B / C

The **Scenarios** tab consumes `SCHEDULE_ACCESS.csv`
(`activity_id, access_seq, week, eclo, access_night`) as the source of truth for
placement and ECLO usage, plus `08_ACTIVITY_DETAILS.csv` (location + activity
priority), `04_LOCATION_SUPPLY.csv` (per-location weekly capacity), and
`07_PROJECT_DETAILS.csv` (contract priority + planned completion week).

**Cost model** (per unit, cheapest → costliest):
`P3 overrun-day (1–1.3×) < excess access-night (3×) < ECLO-night (5×) <
P2 overrun-day (10–13×) < P1 overrun-day (100–130×)`.
Overrun-day weight = `tierBase × (1 + activityNudge)` with
base `{P1:100, P2:10, P3:1}` and nudge `{P1:+0.3, P2:+0.2, P3:0}` (the nudge
never crosses a band). Overrun-days = overrun-weeks × 7. Capacity is checked
**per location-week** (one access = one location-week).

| | Hard-fails | Soft score |
|---|---|---|
| **A** strict supply | any capacity excess (`capacity`); any ECLO (`eclo`) | priority-weighted overrun only |
| **B** strict schedule | any overrun past planned date (`planned_date`) | excess-nights ×3 + ECLO ×5 |
| **C** balanced | capacity excess ≥2 per loc-week (`capacity`); ECLO continuity-window / 2-night-cap breach (`eclo`) | overrun + excess-nights ×3 (beyond the 1/loc-week allowance) + ECLO ×5 |

**Scenario C's ECLO continuity window**: all `eclo=1` nights on a line (Alpha /
Beta) must fit one continuous span of ≤2 calendar weeks, and no activity may use
more than 2 ECLO nights. The Alpha/Beta assignment per location is **editable in
the UI** (defaults are inferred from location names — correct them if wrong).

> Scope note: this tool *validates and scores* a submission — it does not solve.
> The actual scheduling is done by the `trackopt` CP-SAT solver, which is a
> separate project.

## Run it

The app uses ES modules, so it needs to be served over HTTP (opening
`index.html` directly via `file://` will not work in most browsers).

```bash
# from this directory
python3 -m http.server 8000   # or: npm run serve
# then open http://localhost:8000/
```

Any static file server works (`npx serve`, nginx, etc.).

**UI shortcuts:** the ☀️/🌙 button (top-right) toggles light/dark theme
(remembered via `localStorage`); `Alt+1…7` jump to a tab and `[` / `]` cycle
between them.

## Tests

The scenario engine has a zero-dependency test suite (no `npm install` needed):

```bash
npm test          # or: node tests/scenario.test.mjs
```

It covers the cost-weight ladder, all three scenarios' hard-fails and soft
scores, the ECLO continuity window and 2-night cap, input validation, the
occupancy grid, and the report serializers (39 assertions).

## Data format

The importer expects the columns produced by `trackopt`'s report:

```
activity_id, contract, weight, total_accesses, delivered, shortfall,
weeks, finish_week, planned_completion_week, contract_deadline_week,
deadline_breach_weeks, plan_slip_weeks
```

Notes:
- `weeks` is a list like `[20, 21]`, or empty `[]`.
- `finish_week` may be blank for activities that received no access.
- Rows missing `activity_id` are skipped (with a warning).

## Status classification

Each activity is classified (highest severity first):
1. **Shortfall** — `shortfall > 0` (requested accesses not delivered)
2. **Deadline breach** — `deadline_breach_weeks > 0`
3. **Plan slip** — `plan_slip_weeks > 0`
4. **On track** — otherwise

## Files

```
index.html      # markup + tab shell
styles.css      # dark theme styling
js/
  data.js       # embedded sample dataset (the provided schedule result)
  parse.js      # CSV parser + row typing + status classification
  metrics.js    # summary / contract rollup / weekly-load aggregations
  export.js     # serialize rows back to schedule-result CSV + download
  inputs.js     # input-CSV parsing + demand-vs-capacity (pre-solve) analysis
  scenario.js   # SCHEDULE_ACCESS parser + A/B/C validator & scorer
  app.js        # rendering, filtering, sorting, import wiring
data/
  schedule_result.csv        # the sample schedule-result data
  sample_inputs/
    04_LOCATION_SUPPLY.csv   # sample capacity data (has a chokepoint)
    07_PROJECT_DETAILS.csv   # sample contract priorities + planned weeks
    08_ACTIVITY_DETAILS.csv  # sample demand data (with predecessors)
    SCHEDULE_ACCESS.csv      # sample per-access submission (with ECLO nights)
tests/
  scenario.test.mjs         # zero-dependency test suite for the scenario engine
package.json                # npm test / npm run serve scripts (no dependencies)
```

## Pre-solve input format

The Pre-solve tab is tolerant of column-name variations (it matches by
normalized name). It looks for:

- **Supply**: a `location_id` (or `location`/`sector`) column and a
  `supply_capacity` (or `capacity`) column.
- **Activities**: an `activity_id` column, plus `location_id`, `contract`,
  and `total_accesses` where available.

A location is a **chokepoint** when
`total demand accesses > supply_capacity × horizon_weeks`.
