// The audit categories. Each rule returns null (not in the queue) or
// { reasons: [text], alert?: text } where alert marks the part an auditor must check first.

import {
  THRESHOLDS, FRUSTRATION_TERMS, AGENT_REQUEST_TERMS, BOT_LINES, LOOP_TAGS, CATEGORIES,
  ACKNOWLEDGEMENT, NO_REPLY_AFTER_CLOSING, EMOJI_ONLY, GREETING_ONLY, HINDI_WORDS,
} from './config.js';

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
  const numbered = c.turns.find((t) => t.no === userIdx);
  if (numbered && normalizeText(numbered.userInput) === text) return numbered;
  const matching = c.turns.filter((t) => normalizeText(t.userInput) === text);
  return matching.length === 1 ? matching[0] : numbered || matching[0] || null;
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
  const rawHandoffCalls = (c.toolCalls || []).filter((call) => call.tool === 'agent_handoff');
  const useRawCalls = rawHandoffCalls.length > 0;
  let tool = false;
  if (useRawCalls) {
    tool = rawHandoffCalls.some((call) =>
      i < 0 || (nextOnly ? call.messageIndex === i : call.messageIndex >= i));
  } else {
    msgs.forEach((m, k) => {
      if (m.speaker !== 'User' || k < Math.max(i, 0) || (nextOnly && k !== i)) return;
      const t = turnForUserMessage(c, k);
      if (t && t.tools.some((x) => x.tool === 'agent_handoff')) tool = true;
    });
  }
  const hasToolData = c.turns.length > 0 || (c.toolCalls || []).length > 0;
  const real = agentMsg || tool || (!nextOnly && i < 0 && (c.agentJoined === true || c.agentMessages > 0))
    || (!hasToolData && line);
  return {
    real,
    saidOnly: !real && line,
    tool,
    agent: agentMsg,
    replied: window.some((m) => m.speaker === 'Bot' || m.speaker === 'Agent'),
  };
}

function handoffTriggers(c) {
  const rawCalls = (c.toolCalls || []).filter((call) => call.tool === 'agent_handoff');
  if (rawCalls.length) {
    return [...new Set(rawCalls.filter((call) => call.messageIndex >= 0).map((call) => call.messageIndex))];
  }
  const indices = new Set();
  c.messages.forEach((m, i) => {
    if (m.speaker !== 'User') return;
    const turn = turnForUserMessage(c, i);
    if (turn?.tools.some((tool) => tool.tool === 'agent_handoff')) indices.add(i);
  });
  return [...indices];
}

function unresolvedReplyWindow(c, messageIndex) {
  const messages = repliesAfter(c.messages, messageIndex);
  const rawCalls = (c.toolCalls || []).filter((call) =>
    call.tool === 'agent_handoff' && call.messageIndex === messageIndex);
  // BlueMachines raw calls are authoritative when present. Evaluator turns can
  // occasionally attach a later call to an earlier employer message.
  const hasRawHandoffCalls = (c.toolCalls || []).some((call) => call.tool === 'agent_handoff');
  const evaluatorTurn = hasRawHandoffCalls ? null : turnForUserMessage(c, messageIndex);
  const evaluatorCalls = (evaluatorTurn?.tools || []).filter((tool) => tool.tool === 'agent_handoff');
  const calls = rawCalls.length ? rawCalls : evaluatorCalls;
  const agent = messages.some((message) => message.speaker === 'Agent');
  const bot = messages.some((message) => message.speaker === 'Bot');
  const supportClosed = messages.some((message) => message.speaker === 'Bot' && BOT_LINES.supportClosed.test(message.text))
    || calls.some((call) => /closed right now|reopens at|closed hours/i.test(String(call.output || call.result || '')));
  return { calls, agent, bot, supportClosed };
}

function lastBotBefore(messages, index) {
  for (let i = index - 1; i >= 0; i--) {
    if (messages[i].speaker === 'Bot') return messages[i];
  }
  return null;
}

function deduplicateReasons(reasons) {
  const counts = new Map();
  const order = [];
  reasons.forEach((reason) => {
    if (!counts.has(reason)) order.push(reason);
    counts.set(reason, (counts.get(reason) || 0) + 1);
  });
  return order.map((reason) => counts.get(reason) > 1 ? `${reason} (x${counts.get(reason)})` : reason);
}

const HINDI_SET = new Set(HINDI_WORDS);
const wordsIn = (text) => String(text || '').toLowerCase().match(/[a-z]+/g) || [];
const hindiWordsIn = (text) => new Set(wordsIn(text).filter((word) => HINDI_SET.has(word)));
const onlyNumberLinkOrId = (text) => /^\s*(?:\d+|https?:\/\/\S+|www\.\S+|[a-f\d]{12,}|[a-z]*\d[\w-]*)\s*$/i.test(text);

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
      if (BOT_LINES.closing.test(bot[k - 1].text) && BOT_LINES.closing.test(bot[k].text)) {
        reasons.push('Closing line sent again.');
        continue;
      }
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
    let alert = null;
    if (noAnswers.length) {
      noAnswers.forEach((answer) => {
        const window = unresolvedReplyWindow(c, answer.index);
        const prefix = `Employer answered "${snip(answer.text, 60)}" to "Did this resolve your query?".`;
        if (window.calls.length || window.agent) {
          const passed = window.supportClosed ? 'Passed to support, but support was closed.' : 'Passed to support.';
          const detail = !window.agent && c.handoffDetail ? ` ${c.handoffDetail}.` : '';
          reasons.push(`${prefix} ${passed}${detail}`);
        } else if (!window.bot && !window.agent) {
          alert ||= 'No reply to the no';
          reasons.push(`${prefix} No reply to the no.`);
        } else {
          alert ||= 'Not passed to support';
          reasons.push(`${prefix} Not passed to support.`);
        }
      });
    } else {
      if (c.resolvedByEmployer === 'no') reasons.push('Evaluator recorded the employer\'s answer to the resolve question as no.');
      if (c.csat === 'no') reasons.push('CSAT answer was no.');
      if (c.outcome === 'unresolved') reasons.push('Evaluator marked the outcome unresolved.');
      if (!reasons.length) return null;
      const h = handoffIn(c, -1, false);
      if (h.real) {
        reasons.push(c.handoffStatus === 'support_closed' ? 'Passed to support, but support was closed.' : 'Passed to support.');
      } else if (h.saidOnly) {
        alert = 'Not passed to support';
        reasons.push('The bot said it would connect, but no handoff was made.');
      } else {
        alert = 'Not passed to support';
        reasons.push('Not passed to support after it was unresolved.');
      }
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

  flow_checks(c) {
    const reasons = [];
    let alert = null;

    // Every employer message needs a visible reply, an agent response, or a handoff call.
    c.messages.forEach((m, i) => {
      if (m.speaker !== 'User') return;
      const priorBot = lastBotBefore(c.messages, i);
      const allowedAfterClosing = priorBot && BOT_LINES.closing.test(priorBot.text)
        && (NO_REPLY_AFTER_CLOSING.test(m.text) || EMOJI_ONLY.test(m.text));
      const replies = repliesAfter(c.messages, i);
      const handoff = handoffIn(c, i, true);
      if (!allowedAfterClosing && !replies.some((reply) => reply.speaker === 'Bot' || reply.speaker === 'Agent') && !handoff.tool) {
        reasons.push(`No reply: Employer got no reply after "${snip(m.text)}".`);
        alert ||= 'Employer got no reply';
      }
    });

    // A handoff call that produced no later bot or agent message is a separate operational failure.
    handoffTriggers(c).forEach((i) => {
      const visibleAfter = c.messages.slice(i + 1).some((m) => m.speaker === 'Bot' || m.speaker === 'Agent')
        || (c.humanMessages || []).some((m) => m.speaker === 'Agent');
      if (visibleAfter) return;
      const detail = c.handoffDetail ? ` ${c.handoffDetail}.` : '';
      const waited = c.handoffWaitSeconds === null ? '' : ` Waited ${c.handoffWaitSeconds} s.`;
      reasons.push(`No reply after the handoff call.${detail}${waited}`);
      alert = 'No reply after the handoff call';
    });

    if (c.handoffStatus === 'requested' && !c.agentMessages && c.inSupportHours) {
      reasons.push(`Handoff requested, no agent joined${c.handoffDetail ? `: ${c.handoffDetail}` : ''}.`);
      alert ||= 'Handoff requested, no agent joined';
    }

    const connectWithoutCall = c.messages.some((m, i) => {
      if (m.speaker !== 'Bot' || !BOT_LINES.handoff.test(m.text)) return false;
      let employerIndex = -1;
      for (let k = i - 1; k >= 0; k--) {
        if (c.messages[k].speaker === 'User') { employerIndex = k; break; }
      }
      return employerIndex >= 0 && handoffIn(c, employerIndex, true).saidOnly;
    });
    if (c.handoffStatus === 'said_only' || connectWithoutCall) {
      reasons.push('Connect line without a real handoff.');
      alert ||= 'Connect line without a real handoff';
    }

    c.messages.forEach((m, i) => {
      if (m.speaker !== 'Bot' || !BOT_LINES.closing.test(m.text)) return;
      const employer = c.messages[i - 1];
      if (employer?.speaker !== 'User' || !ACKNOWLEDGEMENT.test(employer.text)) return;
      let previousBot = null;
      for (let k = i - 2; k >= 0; k--) {
        if (c.messages[k].speaker === 'Bot') { previousBot = c.messages[k]; break; }
      }
      if (previousBot && !BOT_LINES.closing.test(previousBot.text)
        && !BOT_LINES.resolveQuestion.test(previousBot.text) && !BOT_LINES.supportEmail.test(previousBot.text)) {
        reasons.push('Closed without asking: the closing line followed an acknowledgement without a resolve question.');
      }
    });

    c.messages.forEach((m, i) => {
      if (m.speaker !== 'User' || wordsIn(m.text).length < 3 || GREETING_ONLY.test(m.text) || onlyNumberLinkOrId(m.text)) return;
      const reply = repliesAfter(c.messages, i).find((next) => next.speaker === 'Bot');
      if (!reply || BOT_LINES.welcome.test(reply.text)) return;
      const employerHinglish = hindiWordsIn(m.text).size >= 1;
      const botHinglish = hindiWordsIn(reply.text).size >= 2;
      if (!employerHinglish && botHinglish) {
        reasons.push(`English message answered in Hinglish: "${snip(m.text)}" → "${snip(reply.text)}"`);
      } else if (employerHinglish && !botHinglish) {
        reasons.push(`Hinglish message answered in English: "${snip(m.text)}" → "${snip(reply.text)}"`);
      }
    });

    return reasons.length ? { reasons, alert } : null;
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
      if (r) {
        r.reasons = deduplicateReasons(r.reasons);
        c.audit[cat.key] = r;
      }
    }
    c.categories = Object.keys(c.audit);
    c.alerts = Object.values(c.audit).map((r) => r.alert).filter(Boolean);
  }
  return conversations;
}
