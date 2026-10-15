// Headline numbers, daily volume, intents and failure tags for a set of conversations.

import { CATEGORIES } from './config.js';
import { explicitlyResolved } from './audit.js';

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pct = (n, d) => (d ? (100 * n) / d : null);

export function summarize(convs) {
  const engaged = convs.filter((c) => c.engaged);
  const evaluated = engaged.filter((c) => c.hasEval);
  const handedOff = engaged.filter((c) => c.handoff);
  const asked = engaged.filter((c) => c.resolveAnswers.some((a) => a.answer === 'yes' || a.answer === 'no'));
  const said = (ans) => asked.filter((c) => {
    const answers = c.resolveAnswers.filter((a) => a.answer === 'yes' || a.answer === 'no');
    return answers.length && answers[answers.length - 1].answer === ans;
  }).length;
  const csatGiven = engaged.filter((c) => c.csat === 'yes' || c.csat === 'no');

  const categoryCounts = {};
  const categoryAlerts = {};
  for (const cat of CATEGORIES) {
    const inCat = convs.filter((c) => c.audit[cat.key]);
    categoryCounts[cat.key] = inCat.length;
    categoryAlerts[cat.key] = inCat.filter((c) => c.audit[cat.key].alert).length;
  }

  return {
    chats: convs.length,
    engaged: engaged.length,
    evaluated: evaluated.length,
    containmentPct: pct(engaged.length - handedOff.length, engaged.length),
    handoffPct: pct(handedOff.length, engaged.length),
    handedOff: handedOff.length,
    supportClosed: handedOff.filter((c) => c.handoffStatus === 'support_closed').length,
    saidOnly: engaged.filter((c) => c.handoffStatus === 'said_only').length,
    resolveAsked: asked.length,
    resolveYesPct: pct(said('yes'), asked.length),
    explicitResolvedPct: pct(engaged.filter(explicitlyResolved).length, engaged.length),
    avgBotScorePct: avg(evaluated.map((c) => c.botScorePct).filter((x) => x !== null)),
    avgHelpfulness: avg(evaluated.map((c) => c.helpfulness10).filter((x) => x !== null)),
    csatGiven: csatGiven.length,
    csatYesPct: pct(csatGiven.filter((c) => c.csat === 'yes').length, csatGiven.length),
    flagged: convs.filter((c) => c.categories.length).length,
    categoryCounts,
    categoryAlerts,
  };
}

// Engaged chats per IST day, split into contained and handed off (oldest first)
export function daily(convs) {
  const days = new Map();
  for (const c of convs) {
    if (!c.engaged || !c.dateIST) continue;
    const d = days.get(c.dateIST) || { date: c.dateIST, contained: 0, handedOff: 0, total: 0 };
    if (c.handoff) d.handedOff++; else d.contained++;
    d.total++;
    days.set(c.dateIST, d);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function topIntents(convs, limit = 8) {
  const m = new Map();
  for (const c of convs) {
    if (!c.engaged || !c.primaryIntent) continue;
    const r = m.get(c.primaryIntent) || { name: c.primaryIntent, count: 0, scores: [], handoffs: 0 };
    r.count++;
    if (c.botScorePct !== null) r.scores.push(c.botScorePct);
    if (c.handoff) r.handoffs++;
    m.set(c.primaryIntent, r);
  }
  return [...m.values()]
    .map((r) => ({ name: r.name, count: r.count, avgScore: avg(r.scores), handoffPct: pct(r.handoffs, r.count) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export function topTags(convs, limit = 8) {
  const m = new Map();
  for (const c of convs) for (const t of new Set(c.failureTags)) m.set(t, (m.get(t) || 0) + 1);
  return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, limit);
}
