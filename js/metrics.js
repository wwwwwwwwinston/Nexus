// Aggregations over parsed schedule rows: summary KPIs, per-contract rollups,
// and the week-by-week network load used by the timeline view.

export function computeSummary(rows) {
  const s = {
    activities: rows.length,
    contracts: new Set(rows.map((r) => r.contract)).size,
    totalRequested: 0,
    totalDelivered: 0,
    totalShortfall: 0,
    weightedShortfall: 0,
    activitiesWithShortfall: 0,
    activitiesUnserved: 0, // delivered === 0 but requested > 0
    deadlineBreachWeeks: 0,
    weightedDeadlineBreach: 0,
    activitiesBreaching: 0,
    planSlipWeeks: 0,
    weightedPlanSlip: 0,
    activitiesSlipping: 0,
    maxWeek: 0,
  };
  for (const r of rows) {
    s.totalRequested += r.total_accesses;
    s.totalDelivered += r.delivered;
    s.totalShortfall += r.shortfall;
    s.weightedShortfall += r.shortfall * r.weight;
    if (r.shortfall > 0) s.activitiesWithShortfall++;
    if (r.total_accesses > 0 && r.delivered === 0) s.activitiesUnserved++;
    s.deadlineBreachWeeks += r.deadline_breach_weeks;
    s.weightedDeadlineBreach += r.deadline_breach_weeks * r.weight;
    if (r.deadline_breach_weeks > 0) s.activitiesBreaching++;
    s.planSlipWeeks += r.plan_slip_weeks;
    s.weightedPlanSlip += r.plan_slip_weeks * r.weight;
    if (r.plan_slip_weeks > 0) s.activitiesSlipping++;
    for (const w of r.weeks) if (w > s.maxWeek) s.maxWeek = w;
    if (r.finish_week != null && r.finish_week > s.maxWeek) s.maxWeek = r.finish_week;
    if (r.contract_deadline_week != null && r.contract_deadline_week > s.maxWeek)
      s.maxWeek = r.contract_deadline_week;
  }
  s.deliveryRate = s.totalRequested > 0 ? s.totalDelivered / s.totalRequested : 1;
  return s;
}

export function computeContractRollups(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.contract)) {
      map.set(r.contract, {
        contract: r.contract,
        activities: 0,
        requested: 0,
        delivered: 0,
        shortfall: 0,
        breachWeeks: 0,
        slipWeeks: 0,
        deadline: r.contract_deadline_week,
      });
    }
    const c = map.get(r.contract);
    c.activities++;
    c.requested += r.total_accesses;
    c.delivered += r.delivered;
    c.shortfall += r.shortfall;
    c.breachWeeks += r.deadline_breach_weeks;
    c.slipWeeks += r.plan_slip_weeks;
  }
  return [...map.values()].sort((a, b) => a.contract.localeCompare(b.contract));
}

// Per-week count of how many activities occupy each week (network load).
export function computeWeeklyLoad(rows, maxWeek) {
  const load = new Array(maxWeek + 1).fill(0);
  for (const r of rows) {
    for (const w of r.weeks) {
      if (w >= 0 && w <= maxWeek) load[w]++;
    }
  }
  return load;
}
