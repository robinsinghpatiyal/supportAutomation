// Agent CSAT: splits the human-support part of a BlueMachines chat into agent sessions and
// works out, for each one, who handled it, how long things took, whether the CSAT question
// was sent and what the employer answered. Also builds the per-agent and per-day summaries.
//
// One session starts at every agent_handoff.requested event. Inside it:
//   waiting / assigned / human_active / reassigned  -> queue and agent changes
//   resolved / closed / timed_out / failed            -> how the session ended
//   feedback_prompt                                   -> the CSAT question was sent
//   ai_resumed                                        -> the chat went back to the bot
// The CSAT answer is the employer's first message after feedback_prompt, before the next request.

import { SUPPORT_HOURS_IST, CSAT_YES, CSAT_NO, AGENT_YES_REQUEST, BOT_LINES } from './config.js';
import { frustrationWords } from './audit.js';

export const NO_AGENT = 'No agent joined';

export const OUTCOME_LABEL = {
  resolved: 'Resolved by agent',
  closed: 'Closed by employer',
  timed_out: 'Timed out',
  failed: 'Handoff failed',
  open: 'Still open in the export',
  no_reply: 'Assigned, no agent reply',
  no_agent: 'No agent assigned',
};

export const ANSWER_LABEL = {
  yes: 'Yes',
  no: 'No',
  other: 'Other reply',
  no_answer: 'Asked, no answer',
  not_asked: 'Not asked',
};

const EVENT_TEXT = {
  requested: 'Handoff requested',
  waiting: 'Waiting for an agent',
  assigned: 'Assigned to an agent',
  human_active: 'Agent joined',
  reassigned: 'Reassigned',
  resolved: 'Resolved by agent',
  closed: 'Closed by employer',
  timed_out: 'Timed out',
  failed: 'Handoff failed',
  feedback_prompt: 'CSAT question sent',
  ai_resumed: 'Back to the bot',
};

// Agent messages can carry HTML (<b>, <br>): keep the words only
const plain = (t) => String(t || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/?[a-z][^>]*>/gi, '').trim();

const seconds = (from, to) => {
  const a = Date.parse(from || '');
  const b = Date.parse(to || '');
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? Math.round((b - a) / 1000) : null;
};

function istParts(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return { date: '', time: '' };
  const d = new Date(t + 5.5 * 3600 * 1000).toISOString();
  return { date: d.slice(0, 10), time: d.slice(11, 16) };
}

export function csatAnswer(text) {
  if (text === null || text === undefined) return null;
  if (CSAT_YES.test(text)) return 'yes';
  if (CSAT_NO.test(text)) return 'no';
  return 'other';
}

function newSession(no, at) {
  return {
    no,
    requestedAt: at,
    waitingAt: null,
    assignedAt: null,
    humanActiveAt: null,
    reassignedAt: [],
    endEvent: null,
    endAt: null,
    feedbackAt: [],
    resumedAt: null,
    agents: [],
    agentMessageCounts: {},
    agentMessages: 0,
    customerMessages: 0,
    firstAgentReplyAt: null,
    lastAgentReplyAt: null,
    lastAgent: null,
    longestWaitSeconds: null,
    waitingSince: null,
    yesRequests: [],
    frustration: [],
    answerText: null,
    answerAt: null,
    afterEndMessages: 0,
    log: [],
  };
}

// c.humanTimeline: [{ type: 'event', at, event } | { type: 'message', at, speaker: 'Agent'|'User', name, text }]
export function agentSessions(c) {
  const timeline = Array.isArray(c.humanTimeline) ? c.humanTimeline : [];
  if (!timeline.length) return [];
  const sessions = [];
  let s = null;
  const current = (at) => {
    if (!s) { s = newSession(1, at); sessions.push(s); }
    return s;
  };

  for (const item of timeline) {
    if (item.type === 'event') {
      if (item.event === 'requested') {
        s = newSession(sessions.length + 1, item.at);
        sessions.push(s);
        s.log.push({ at: item.at, kind: 'event', who: null, text: EVENT_TEXT.requested });
        continue;
      }
      const x = current(item.at);
      x.log.push({ at: item.at, kind: 'event', who: null, text: EVENT_TEXT[item.event] || item.event.replace(/_/g, ' ') });
      if (item.event === 'waiting') x.waitingAt = x.waitingAt || item.at;
      else if (item.event === 'assigned') x.assignedAt = x.assignedAt || item.at;
      else if (item.event === 'human_active') x.humanActiveAt = x.humanActiveAt || item.at;
      else if (item.event === 'reassigned') x.reassignedAt.push(item.at);
      else if (['resolved', 'closed', 'timed_out', 'failed'].includes(item.event) && !x.endEvent) {
        x.endEvent = item.event;
        x.endAt = item.at;
      } else if (item.event === 'feedback_prompt') x.feedbackAt.push(item.at);
      else if (item.event === 'ai_resumed') x.resumedAt = x.resumedAt || item.at;
      continue;
    }

    const x = current(item.at);
    if (item.speaker === 'Agent') {
      const name = item.name || 'Agent';
      if (!x.agents.includes(name)) x.agents.push(name);
      x.agentMessageCounts[name] = (x.agentMessageCounts[name] || 0) + 1;
      x.agentMessages++;
      x.firstAgentReplyAt = x.firstAgentReplyAt || item.at;
      x.lastAgentReplyAt = item.at;
      x.lastAgent = name;
      if (x.waitingSince) {
        const waited = seconds(x.waitingSince, item.at);
        if (waited !== null && (x.longestWaitSeconds === null || waited > x.longestWaitSeconds)) x.longestWaitSeconds = waited;
        x.waitingSince = null;
      }
      if (AGENT_YES_REQUEST.test(item.text)) x.yesRequests.push({ name, at: item.at, text: item.text });
      x.log.push({ at: item.at, kind: 'agent', who: name, text: plain(item.text) });
      continue;
    }

    // Employer message
    if (x.feedbackAt.length && x.answerText === null) {
      x.answerText = item.text;
      x.answerAt = item.at;
      x.log.push({ at: item.at, kind: 'answer', who: 'Employer (CSAT answer)', text: item.text });
      continue;
    }
    if (x.endEvent) {
      x.afterEndMessages++;
      x.log.push({ at: item.at, kind: 'employer', who: 'Employer', text: item.text });
      continue;
    }
    x.customerMessages++;
    if (!x.waitingSince) x.waitingSince = item.at;
    for (const w of frustrationWords(item.text)) if (!x.frustration.includes(w)) x.frustration.push(w);
    x.log.push({ at: item.at, kind: 'employer', who: 'Employer', text: item.text });
  }

  // Employer messages to the bot after each hand back (BlueMachines' "Hope the support team has resolved your queries")
  const msgs = Array.isArray(c.messages) ? c.messages : [];
  const handbacks = msgs.map((m, i) => (m.speaker === 'Bot' && BOT_LINES.handback.test(m.text) ? i : -1)).filter((i) => i >= 0);
  let handbackNo = 0;

  return sessions.map((x, i) => {
    const isLast = i === sessions.length - 1;
    // An employer still waiting for an agent reply when the session ended: that wait counts too
    if (x.waitingSince && x.endAt && x.agents.length) {
      const waited = seconds(x.waitingSince, x.endAt);
      if (waited !== null && (x.longestWaitSeconds === null || waited > x.longestWaitSeconds)) x.longestWaitSeconds = waited;
    }
    const credited = (isLast && c.handoffAgentName) || x.lastAgent || null;
    let outcome = x.endEvent;
    if (!outcome) outcome = x.agents.length || x.humanActiveAt ? 'open' : x.assignedAt ? 'no_reply' : 'no_agent';
    const startAt = x.requestedAt || x.assignedAt || x.humanActiveAt || x.firstAgentReplyAt;
    const { date, time } = istParts(startAt || (c.createdAt instanceof Date ? c.createdAt.toISOString() : ''));
    const asked = x.feedbackAt.length;
    const answer = x.answerText !== null ? csatAnswer(x.answerText) : asked ? 'no_answer' : 'not_asked';

    let wroteToBotAfter = null;
    if (x.resumedAt && handbackNo < handbacks.length) {
      const from = handbacks[handbackNo++];
      const next = msgs.slice(from + 1).find((m) => m.speaker === 'User' || (m.speaker === 'Bot' && BOT_LINES.handback.test(m.text)));
      if (next && next.speaker === 'User') wroteToBotAfter = next.text;
    }
    const unansweredAtEnd = x.waitingSince && x.endEvent ? 1 : 0;

    return {
      conversationId: c.id,
      no: x.no,
      sessionsInChat: sessions.length,
      dateIST: date,
      timeIST: time,
      inSupportHours: !!time && time >= SUPPORT_HOURS_IST.start && time < SUPPORT_HOURS_IST.end,
      employerName: c.userName || null,
      employerId: c.apnaEmployerId || null,
      phoneNumber: c.phoneNumber || null,
      creditedAgent: credited || NO_AGENT,
      lastAgent: x.lastAgent,
      ownerAtExport: isLast ? c.handoffAgentName || null : null,
      agents: x.agents,
      agentMessageCounts: x.agentMessageCounts,
      reassignments: x.reassignedAt.length,
      outcome,
      requestedAt: x.requestedAt,
      assignedAt: x.assignedAt,
      humanActiveAt: x.humanActiveAt,
      firstAgentReplyAt: x.firstAgentReplyAt,
      lastAgentReplyAt: x.lastAgentReplyAt,
      endAt: x.endAt,
      feedbackAt: x.feedbackAt,
      resumedAt: x.resumedAt,
      assignSeconds: seconds(x.requestedAt, x.assignedAt),
      firstReplySeconds: seconds(x.requestedAt, x.firstAgentReplyAt),
      handleSeconds: seconds(x.humanActiveAt || x.firstAgentReplyAt, x.endAt),
      activeSeconds: seconds(x.firstAgentReplyAt, x.lastAgentReplyAt),
      totalSeconds: seconds(x.requestedAt, x.endAt),
      longestWaitSeconds: x.longestWaitSeconds,
      agentMessages: x.agentMessages,
      customerMessages: x.customerMessages,
      lastEmployerMessageUnanswered: unansweredAtEnd === 1,
      csatAsked: asked,
      csatAnswer: answer,
      csatAnswerText: x.answerText,
      csatAnswerAt: x.answerAt,
      csatAnswerSeconds: x.answerAt && asked ? seconds(x.feedbackAt[0], x.answerAt) : null,
      yesRequests: x.yesRequests.length,
      yesRequestText: x.yesRequests.length ? x.yesRequests[x.yesRequests.length - 1].text : null,
      frustration: x.frustration,
      askedForSupportAgain: !isLast,
      wroteToBotAfter,
      // The employer's reply to the bot's hand-back line: a plain no or "Not resolved" is a second CSAT signal
      handbackReply: wroteToBotAfter === null ? null : csatAnswer(wroteToBotAfter),
      log: x.log,
      transcript: x.log.map((e) => `[${istParts(e.at).time}] ${e.kind === 'event' ? `-- ${e.text} --` : `${e.who}: ${e.text}`}`).join('\n'),
    };
  });
}

// The CSAT answer for the whole chat: the last yes or no given in any session
export function chatCsat(sessions) {
  const given = sessions.filter((s) => s.csatAnswer === 'yes' || s.csatAnswer === 'no');
  return given.length ? given[given.length - 1].csatAnswer : null;
}

const pct = (n, d) => (d ? (100 * n) / d : null);
const median = (xs) => {
  const v = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
};
const avg = (xs) => {
  const v = xs.filter((x) => x !== null && x !== undefined);
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
};

// Counts shared by the headline tiles, each agent row and each day row
export function csatCounts(sessions) {
  const n = (fn) => sessions.filter(fn).length;
  const asked = sessions.filter((s) => s.csatAsked > 0);
  const answered = asked.filter((s) => ['yes', 'no', 'other'].includes(s.csatAnswer));
  const yes = n((s) => s.csatAnswer === 'yes');
  const no = n((s) => s.csatAnswer === 'no');
  return {
    sessions: sessions.length,
    chats: new Set(sessions.map((s) => s.conversationId)).size,
    resolved: n((s) => s.outcome === 'resolved'),
    closedByEmployer: n((s) => s.outcome === 'closed'),
    timedOut: n((s) => s.outcome === 'timed_out'),
    failed: n((s) => s.outcome === 'failed'),
    open: n((s) => s.outcome === 'open'),
    noAgent: n((s) => s.outcome === 'no_agent' || s.outcome === 'no_reply'),
    csatAskedSessions: asked.length,
    csatAskedTimes: sessions.reduce((t, s) => t + s.csatAsked, 0),
    answered: answered.length,
    yes,
    no,
    other: n((s) => s.csatAnswer === 'other'),
    noAnswer: n((s) => s.csatAnswer === 'no_answer'),
    notAsked: n((s) => s.csatAnswer === 'not_asked'),
    resolvedNotAsked: n((s) => s.outcome === 'resolved' && !s.csatAsked),
    responseRatePct: pct(answered.length, asked.length),
    yesPctOfAnswers: pct(yes, yes + no),
    noPctOfAnswers: pct(no, yes + no),
    yesPctOfAsked: pct(yes, asked.length),
    yesRequestSessions: n((s) => s.yesRequests > 0),
    frustratedSessions: n((s) => s.frustration.length > 0),
    cameBack: n((s) => s.askedForSupportAgain || !!s.wroteToBotAfter),
    notResolvedAfterHandback: n((s) => s.handbackReply === 'no'),
    reassigned: n((s) => s.reassignments > 0),
    unansweredAtEnd: n((s) => s.lastEmployerMessageUnanswered),
    medianFirstReplySeconds: median(sessions.map((s) => s.firstReplySeconds)),
    avgFirstReplySeconds: avg(sessions.map((s) => s.firstReplySeconds)),
    medianHandleSeconds: median(sessions.filter((s) => s.outcome === 'resolved').map((s) => s.handleSeconds)),
    avgHandleSeconds: avg(sessions.filter((s) => s.outcome === 'resolved').map((s) => s.handleSeconds)),
    medianActiveSeconds: median(sessions.filter((s) => s.outcome === 'resolved').map((s) => s.activeSeconds)),
    medianLongestWaitSeconds: median(sessions.map((s) => s.longestWaitSeconds)),
    maxLongestWaitSeconds: sessions.reduce((m, s) => (s.longestWaitSeconds !== null && s.longestWaitSeconds > (m ?? -1) ? s.longestWaitSeconds : m), null),
  };
}

// One row per agent. CSAT, outcome and timings use the sessions credited to the agent (the agent who
// held the chat at the end); "involved" counts every session in which the agent wrote at least once.
export function agentSummary(sessions) {
  const names = new Set(sessions.map((s) => s.creditedAgent));
  sessions.forEach((s) => s.agents.forEach((a) => names.add(a)));
  return [...names].map((name) => {
    const credited = sessions.filter((s) => s.creditedAgent === name);
    const involved = sessions.filter((s) => s.agents.includes(name));
    const passedOn = involved.filter((s) => s.creditedAgent !== name).length;
    const dates = credited.map((s) => s.dateIST).filter(Boolean).sort();
    return {
      agent: name,
      involved: involved.length,
      passedOn,
      messages: involved.reduce((t, s) => t + (s.agentMessageCounts[name] || 0), 0),
      firstDate: dates[0] || '',
      lastDate: dates[dates.length - 1] || '',
      ...csatCounts(credited),
    };
  }).sort((a, b) => (a.agent === NO_AGENT) - (b.agent === NO_AGENT) || b.sessions - a.sessions || a.agent.localeCompare(b.agent));
}

// One row per IST day of the handoff request (oldest first)
export function csatDaily(sessions) {
  const days = new Map();
  for (const s of sessions) {
    if (!s.dateIST) continue;
    if (!days.has(s.dateIST)) days.set(s.dateIST, []);
    days.get(s.dateIST).push(s);
  }
  return [...days.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, list]) => ({ date, ...csatCounts(list) }));
}
