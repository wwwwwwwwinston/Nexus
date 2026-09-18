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
  exactly how many accesses structurally cannot fit.
- **Import data** — drop a CSV, pick a file, or paste CSV text to load a
  different solve result. Everything runs locally in the browser; nothing
  is uploaded.

The Overview toolbar also has an **Export CSV** button that downloads the
currently filtered/sorted rows back to the schedule-result CSV format (it
round-trips cleanly through the importer).

## Run it

The app uses ES modules, so it needs to be served over HTTP (opening
`index.html` directly via `file://` will not work in most browsers).

```bash
# from this directory
python3 -m http.server 8000
# then open http://localhost:8000/
```

Any static file server works (`npx serve`, nginx, etc.).

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
  app.js        # rendering, filtering, sorting, import wiring
data/
  schedule_result.csv        # the sample schedule-result data
  sample_inputs/
    04_LOCATION_SUPPLY.csv   # sample capacity data (has a chokepoint)
    08_ACTIVITY_DETAILS.csv  # sample demand data
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
