// The 8 audit categories. Each rule returns null (not in the queue) or
// { reasons: [text], alert?: text } where alert marks the part an auditor must check first.

import { THRESHOLDS, FRUSTRATION_TERMS, AGENT_REQUEST_TERMS, BOT_LINES, LOOP_TAGS, CATEGORIES } from './config.js';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function termRegex(terms) {
  const parts = terms.map((t) => {
    if (t instanceof RegExp) return t.source;
    const e = escapeRe(t.toLowerCase()).replace(/\s+/g, '\\s+');
    return /^[\w]+$/.test(t) ? `\\b${e}\\b` : `(?:^|\\W)${e}(?:$|\\W)`;
  });
  return new RegExp(parts.join('|'), 'gi');
}
const FRUSTRATION_RE = termRegex(FRUSTRATION_TERMS);
const AGENT_RE = termRegex(AGENT_REQUEST_TERMS);

function matches(re, text) {
  re.lastIndex = 0;
  const found = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    found.add(m[0].replace(/^\W+|\W+$/g, '').toLowerCase());
    if (m[0] === '') re.lastIndex++;
  }
  return [...found];
}

const snip = (t, n = 110) => {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

// Character-trigram similarity (Dice), 0 to 1
function normalizeText(t) {
  return String(t || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}
function trigrams(t) {
  const s = `  ${t} `;
  const out = new Map();
  for (let i = 0; i < s.length - 2; i++) {
    const g = s.slice(i, i + 3);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}
export function similarity(a, b) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = trigrams(na);
  const tb = trigrams(nb);
  let inter = 0;
  let total = 0;
  ta.forEach((n, g) => { inter += Math.min(n, tb.get(g) || 0); total += n; });
  tb.forEach((n) => { total += n; });
  return (2 * inter) / total;
}

// index of the bot reply (or agent message) that follows message i, before the employer writes again
function repliesAfter(msgs, i) {
  const out = [];
  for (let j = i + 1; j < msgs.length && msgs[j].speaker !== 'User'; j++) out.push({ ...msgs[j], index: j });
  return out;
}
const isHandoffMsg = (m) => m.speaker === 'Agent' || (m.speaker === 'Bot' && BOT_LINES.handoff.test(m.text));

// the evaluator's turn that answers the employer's message at transcript index i
export function turnForUserMessage(c, i) {
  const userIdx = c.messages.slice(0, i + 1).filter((m) => m.speaker === 'User').length; // 1-based
  const text = normalizeText(c.messages[i].text);
  return c.turns.find((t) => normalizeText(t.userInput) === text) || c.turns.find((t) => t.no === userIdx) || null;
}

// Was the chat really handed off after the employer's message at index i?
// With evaluator data, only an agent_handoff call (or an agent's message) counts: a connect line alone is "saidOnly".
// Without it, a connect or support-hours line in the transcript counts.
// nextOnly: only the bot's reply to that message; otherwise anything after it. i = -1 means the whole chat.
function handoffIn(c, i, nextOnly) {
  const msgs = c.messages;
  let end = msgs.length;
  if (nextOnly) { end = i + 1; while (end < msgs.length && msgs[end].speaker !== 'User') end++; }
  const window = msgs.slice(i + 1, end);
  const agentMsg = window.some((m) => m.speaker === 'Agent');
  const line = window.some((m) => m.speaker === 'Bot' && BOT_LINES.handoff.test(m.text));
  if (!c.turns.length) return { real: agentMsg || line, saidOnly: false };
  let tool = false;
  msgs.forEach((m, k) => {
    if (m.speaker !== 'User' || k < Math.max(i, 0) || (nextOnly && k !== i)) return;
    const t = turnForUserMessage(c, k);
    if (t && t.tools.some((x) => x.tool === 'agent_handoff')) tool = true;
  });
  const real = agentMsg || tool || (!nextOnly && i < 0 && c.agentJoined === true);
  return { real, saidOnly: !real && line };
}

const RULES = {
  eval_flagged(c) {
    if (!c.hasEval) return null;
    const low = c.turns.filter((t) => t.score !== null && t.score <= THRESHOLDS.lowScore);
    const lowChat = c.score5 !== null && c.score5 <= THRESHOLDS.lowScore;
    if (!c.flagForReview && !low.length && !lowChat) return null;
    const reasons = [];
    if (c.flagForReview) reasons.push('Evaluator set flag_for_review.');
    if (lowChat) reasons.push(`Chat score ${c.score5}/5.`);
    low.forEach((t) => reasons.push(`Turn ${t.no} scored ${t.score}/5${t.whatWentWrong ? `: ${snip(t.whatWentWrong, 140)}` : ''}`));
    if (c.failureTags.length) reasons.push(`Tags: ${c.failureTags.join(', ')}`);
    return { reasons };
  },

  frustration(c) {
    const reasons = [];
    c.messages.forEach((m) => {
      if (m.speaker !== 'User') return;
      const words = matches(FRUSTRATION_RE, m.text);
      const bangs = /!{2,}|\?{3,}/.test(m.text);
      const letters = m.text.replace(/[^A-Za-z]/g, '');
      const shouting = letters.length >= 10 && m.text.trim().split(/\s+/).length >= 2 && letters === letters.toUpperCase();
      const why = [];
      if (words.length) why.push(`"${words.join('", "')}"`);
      if (bangs) why.push('repeated !! or ???');
      if (shouting) why.push('all caps');
      if (why.length) reasons.push(`${why.join(', ')} in: "${snip(m.text)}"`);
    });
    if (c.sentimentEnd === 'negative') reasons.push('Evaluator rated sentiment at the end as negative.');
    return reasons.length ? { reasons } : null;
  },

  loop(c) {
    const reasons = [];
    const bot = c.messages
      .map((m, index) => ({ ...m, index }))
      .filter((m) => m.speaker === 'Bot' && !BOT_LINES.welcome.test(m.text) && !BOT_LINES.hold.test(m.text) && m.text);
    for (let k = 1; k < bot.length; k++) {
      const s = similarity(bot[k - 1].text, bot[k].text);
      if (s >= THRESHOLDS.loopSimilarity) {
        reasons.push(`Bot replied ${s === 1 ? 'the same' : `${Math.round(s * 100)}% the same`} twice in a row: "${snip(bot[k].text)}"`);
      }
    }
    const tags = c.failureTags.filter((t) => LOOP_TAGS.includes(t));
    if (tags.length) reasons.push(`Evaluator tagged ${tags.join(', ')}.`);
    const chk = c.checks && c.checks.no_loop_or_repeat;
    if (chk && chk.result === 'fail') reasons.push(`Loop check failed${chk.evidence ? `: ${snip(chk.evidence, 140)}` : '.'}`);
    return reasons.length ? { reasons } : null;
  },

  agent_request(c) {
    const reasons = [];
    let alert = null;
    c.messages.forEach((m, i) => {
      if (m.speaker !== 'User') return;
      const words = matches(AGENT_RE, m.text);
      if (!words.length) return;
      const next = handoffIn(c, i, true);
      const later = next.real ? null : handoffIn(c, i, false);
      let status;
      if (next.real) status = 'Handed off in the next reply';
      else if (next.saidOnly) { status = 'The next reply said it would connect, but no handoff was made'; alert = alert || 'Connect line without a real handoff'; }
      else if (later.real) { status = 'Handed off, but not in the next reply'; alert = alert || 'Handoff was delayed'; }
      else { status = 'Never handed off'; alert = alert || 'Request for a human was not handed off'; }
      reasons.push(`Asked: "${snip(m.text)}" (${words.join(', ')}). ${status}.`);
    });
    return reasons.length ? { reasons, alert } : null;
  },

  unresolved(c) {
    const reasons = [];
    const noAnswers = c.resolveAnswers.filter((a) => a.answer === 'no');
    noAnswers.forEach((a) => reasons.push(`Employer answered "${snip(a.text, 60)}" to "Did this resolve your query?".`));
    if (!noAnswers.length && c.resolvedByEmployer === 'no') reasons.push('Evaluator recorded the employer\'s answer to the resolve question as no.');
    if (c.csat === 'no') reasons.push('CSAT answer was no.');
    if (c.outcome === 'unresolved') reasons.push('Evaluator marked the outcome unresolved.');
    if (!reasons.length) return null;
    // handoff integrity: from the first "no" onwards (or the whole chat, when the signal is the outcome or CSAT)
    const from = noAnswers.length ? noAnswers[0].index : -1;
    const h = handoffIn(c, from, false);
    let alert = null;
    if (h.real) {
      reasons.push(c.handoffStatus === 'support_closed' ? 'Passed to support, but support was closed.' : 'Passed to support.');
    } else if (h.saidOnly) {
      alert = 'Not passed to support';
      reasons.push('The bot said it would connect, but no handoff was made.');
    } else {
      alert = 'Not passed to support';
      reasons.push('Not passed to support after it was unresolved.');
    }
    return { reasons, alert };
  },

  early_drop(c) {
    if (!c.engaged || c.botReplies < THRESHOLDS.earlyDropMinBotReplies) return null;
    if (c.userMessages > THRESHOLDS.highVolumeUserMessages) return null;
    if (c.handoff || explicitlyResolved(c) || c.lastSpeaker !== 'Bot') return null;
    const last = [...c.messages].reverse().find((m) => m.speaker === 'Bot');
    return { reasons: [`Employer left after ${c.botReplies} bot replies and ${c.userMessages} message(s) of their own, with no resolution or handoff. Last bot reply: "${snip(last && last.text)}"`] };
  },

  high_volume(c) {
    if (c.userMessages <= THRESHOLDS.highVolumeUserMessages) return null;
    if (c.handoff || explicitlyResolved(c)) return null;
    return { reasons: [`Employer sent ${c.userMessages} messages and the chat ended with no resolution and no handoff.`] };
  },

  support_escalation(c, escalations) {
    const e = escalations[c.id];
    if (!e) return null;
    return { reasons: [`${e.source === 'csv' ? 'Listed in the escalations file' : 'Marked by support'}${e.by ? ` (${e.by})` : ''}${e.note ? `: ${e.note}` : '.'}`] };
  },
};

export function explicitlyResolved(c) {
  return c.resolveAnswers.some((a) => a.answer === 'yes') || c.closingSent || c.csat === 'yes' || c.resolvedByEmployer === 'yes';
}

// Adds c.audit = { [categoryKey]: { reasons, alert } } to every conversation
export function runAudit(conversations, escalations = {}) {
  for (const c of conversations) {
    c.audit = {};
    for (const cat of CATEGORIES) {
      const r = RULES[cat.key](c, escalations);
      if (r) c.audit[cat.key] = r;
    }
    c.categories = Object.keys(c.audit);
    c.alerts = Object.values(c.audit).map((r) => r.alert).filter(Boolean);
  }
  return conversations;
}
