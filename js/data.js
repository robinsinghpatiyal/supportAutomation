// Reads MongoDB exports of the supportPostChat collection and turns every record,
// whatever its shape, into one Conversation object the rest of the app uses.
//
// Two record shapes exist in the collection:
//  1. Raw post-chat records: { conversationId, createdAt, transcript, payload: { user_id, session_id,
//     agentInteractionData: { transcript }, eval }, eval }  ("assistant: ..." / "user: ..." lines)
//  2. Flattened rows (from 14 Oct 2026): { conversation_id, chat_date_ist, agent_handoff, turns: [...],
//     transcript_json: [...], metadata: {...}, ... }

import { BOT_LINES, TEST_CONVERSATION_PATTERNS, ANSWER_NO, ANSWER_YES } from './config.js';
import { parseCSV } from './csv.js';

const ANSWER = { yes: ANSWER_YES, no: ANSWER_NO };

// ---------- file parsing ----------

// Mongo extended JSON -> plain values ({"$date": ...} -> Date, {"$oid": ...} -> string, numbers)
function revive(_key, value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1) {
      const k = keys[0];
      if (k === '$oid') return value.$oid;
      if (k === '$date') {
        const d = value.$date;
        if (d && typeof d === 'object' && d.$numberLong) return new Date(Number(d.$numberLong));
        return new Date(d);
      }
      if (k === '$numberLong' || k === '$numberInt' || k === '$numberDouble' || k === '$numberDecimal') {
        return Number(value[k]);
      }
    }
  }
  return value;
}

// Accepts a JSON array (Compass export or mongoexport --jsonArray), one document per line
// (mongoexport default), or a single document.
export function parseExport(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) return JSON.parse(trimmed, revive);
  try {
    const one = JSON.parse(trimmed, revive);
    return Array.isArray(one) ? one : [one];
  } catch {
    const docs = [];
    trimmed.split(/\r?\n/).forEach((line, i) => {
      const l = line.trim();
      if (!l) return;
      try { docs.push(JSON.parse(l, revive)); }
      catch { throw new Error(`Line ${i + 1} is not valid JSON`); }
    });
    return docs;
  }
}

// ---------- BlueMachines CSV parsing ----------

function jsonCell(value, fallback) {
  if (value === null || value === undefined || String(value).trim() === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function numberCell(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// The BlueMachines transcript also contains variables, tool payloads and debugger output.
// Keep only the lines visibly spoken by the AI, employer or human support agent.
function blueMachinesTranscript(raw) {
  const marker = String(raw || '').match(/===\s*TRANSCRIPT\s*===/i);
  const body = marker ? String(raw).slice(marker.index + marker[0].length) : String(raw || '');
  const messages = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const text = current.lines.join('\n').trim();
    if (text) messages.push(`${current.speaker}: ${text}`);
    current = null;
  };

  for (const line of body.split(/\r?\n/)) {
    const spoken = line.match(/^(AI agent|Assistant|Bot|User|Employer|Human agent|Support agent|Agent):\s*(.*)$/i);
    if (spoken) {
      flush();
      const who = spoken[1].toLowerCase();
      const speaker = /user|employer/.test(who) ? 'user' : /human|support/.test(who) || who === 'agent' ? 'agent' : 'assistant';
      current = { speaker, lines: [spoken[2]] };
      continue;
    }
    if (/^\s*debugger\s*:/.test(line) || /^\s*\[(?:Variables|Tool:)/i.test(line)) {
      flush();
      continue;
    }
    if (current) current.lines.push(line);
  }
  flush();
  return messages.join('\n');
}

// Converts the CSV downloaded directly from BlueMachines into the raw record shape
// already understood by normalize(). Throws when the file is some other kind of CSV.
export function parseBlueMachinesExport(text) {
  const rows = parseCSV(text);
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim().replace(/^\uFEFF/, ''));
  const index = new Map(headers.map((h, i) => [h, i]));
  if (!index.has('conversationId') || !index.has('transcript')) {
    throw new Error('Not a BlueMachines conversation export');
  }

  return rows.slice(1).map((cells) => {
    const get = (name) => cells[index.get(name)] ?? '';
    const evaluated = get('callAnalysisStatus').toLowerCase() === 'ok' || !!get('evaluation.eval_version');
    const identity = jsonCell(get('evaluation.identity'), {});
    const evaluation = evaluated ? {
      checks: jsonCell(get('evaluation.checks'), {}),
      csat: jsonCell(get('evaluation.csat'), null),
      employer_sentiment_end: get('evaluation.employer_sentiment_end') || null,
      entry_page: get('evaluation.entry_page') || null,
      eval_version: get('evaluation.eval_version') || null,
      failure_tags: jsonCell(get('evaluation.failure_tags'), []),
      fix_suggestion: get('evaluation.fix_suggestion') || null,
      flag_for_review: jsonCell(get('evaluation.flag_for_review'), false),
      helpfulness_10: numberCell(get('evaluation.helpfulness_10')),
      human_handoff: jsonCell(get('evaluation.human_handoff'), {}),
      identity,
      languages: jsonCell(get('evaluation.languages'), []),
      outcome: get('evaluation.outcome') || null,
      primary_intent: get('evaluation.primary_intent') || null,
      resolution_feedback: jsonCell(get('evaluation.resolution_feedback'), {}),
      score: numberCell(get('evaluation.score')),
      summary: get('evaluation.summary') || null,
      system_issues: jsonCell(get('evaluation.system_issues'), []),
      tools_visible: jsonCell(get('evaluation.tools_visible'), null),
      turn_by_turn: jsonCell(get('evaluation.turn_by_turn'), []),
      what_went_wrong: get('evaluation.what_went_wrong') || null,
    } : null;

    return {
      _source: 'bluemachines_csv',
      conversationId: get('conversationId'),
      createdAt: get('interactionDate'),
      transcript: blueMachinesTranscript(get('transcript')),
      userId: identity.apna_employer_id || get('externalUserId') || null,
      eval: evaluation,
      payload: {
        user_id: identity.apna_employer_id || get('externalUserId') || null,
        session_id: identity.session_id || null,
      },
      blueMachines: {
        userDisplayName: get('userDisplayName') || null,
        agentName: get('agentName') || null,
        durationSeconds: numberCell(get('durationSeconds')),
        statusType: get('statusType') || null,
        medium: get('medium') || null,
        interactionEnvironment: get('interactionEnvironment') || null,
        workflowId: get('workflowId') || null,
        workflowExecutionId: get('workflowExecutionId') || null,
      },
    };
  }).filter((record) => record.conversationId);
}

// ---------- helpers ----------

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
export function toIST(date) {
  if (!(date instanceof Date) || isNaN(date)) return { date: '', time: '' };
  const d = new Date(date.getTime() + IST_OFFSET_MS).toISOString();
  return { date: d.slice(0, 10), time: d.slice(11, 16) };
}

function asDate(v) {
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    return isNaN(d) ? null : d;
  }
  return null;
}

function yesNo(v) {
  if (v === true || v === 'yes') return true;
  if (v === false || v === 'no') return false;
  return null;
}

function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

function str(v) {
  return v === null || v === undefined || v === '' ? null : String(v);
}

function list(v) {
  if (Array.isArray(v)) return v.filter(Boolean).map(String);
  if (typeof v === 'string' && v.trim()) return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

const SPEAKERS = { assistant: 'Bot', user: 'User', freshchatassistant: 'Agent', agent: 'Agent', bot: 'Bot' };
const LINE_RE = /^(assistant|user|freshchatAssistant|agent|bot)\s*:\s?(.*)$/i;

// "assistant: ...\nuser: ..." -> [{ speaker, text }]; lines without a prefix continue the message above
export function parseTranscript(text) {
  const msgs = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(LINE_RE);
    if (m) msgs.push({ speaker: SPEAKERS[m[1].toLowerCase()], text: m[2] });
    else if (msgs.length) msgs[msgs.length - 1].text += '\n' + line;
  }
  msgs.forEach((m) => { m.text = m.text.trim(); });
  return msgs;
}

function csatFrom(evalCsat, rowCsat) {
  if (rowCsat === 'yes' || rowCsat === 'no') return rowCsat;
  const c = evalCsat;
  if (c && typeof c === 'object') {
    if (!c.given) return null;
    const raw = String(c.rating_raw ?? '').trim().toLowerCase();
    if (['yes', 'y', 'haan', '1'].includes(raw)) return 'yes';
    if (['no', 'n', 'nahi', '0'].includes(raw)) return 'no';
    return { positive: 'yes', negative: 'no' }[c.csat_sentiment] || null;
  }
  if (typeof c === 'string' && ['yes', 'no'].includes(c.toLowerCase())) return c.toLowerCase();
  return null;
}

function toolsFromCalls(calls) {
  return (calls || []).map((c) => ({
    tool: c.tool || null,
    intent: c.intent || null,
    result: c.result || null,
    error: c.error || null,
  }));
}

// "apna_chat_query:GET_JOB_STATUS,agent_handoff:-" -> tool list
function toolsFromString(s) {
  return list(s).map((part) => {
    const [tool, intent] = part.split(':');
    return { tool, intent: intent && intent !== '-' ? intent : null, result: null, error: null };
  });
}

// ---------- normalisation ----------

function fromRaw(rec) {
  const payload = rec.payload || {};
  const ev = (rec.eval && typeof rec.eval === 'object') ? rec.eval : (payload.eval && typeof payload.eval === 'object' ? payload.eval : null);
  const hasEval = !!(ev && Array.isArray(ev.turn_by_turn));
  const ident = (ev && ev.identity) || {};
  const hh = (ev && ev.human_handoff) || {};
  const rf = (ev && ev.resolution_feedback) || {};
  const transcriptText = rec.transcript || (payload.agentInteractionData || {}).transcript || '';
  const turns = hasEval ? ev.turn_by_turn.map((t) => ({
    no: t.turn,
    userInput: t.user_input ?? null,
    botOutput: t.bot_output ?? null,
    replyType: t.reply_type || null,
    score: num(t.turn_score),
    whatWentWrong: str(t.what_went_wrong),
    tags: list(t.tags),
    tools: toolsFromCalls(t.tool_calls),
  })) : [];
  return {
    shape: 'raw',
    id: str(rec.conversationId) || str(payload.conversation_id) || str(rec._id),
    mongoId: str(rec._id),
    createdAt: asDate(rec.createdAt) || asDate(rec.updatedAt),
    apnaEmployerId: str(payload.user_id) || str(rec.userId) || str(ident.apna_employer_id),
    employerId: str(ident.employer_id),
    userName: str(rec.userDisplayName) || str(rec.blueMachines && rec.blueMachines.userDisplayName)
      || str(payload.user_name) || str(ident.user_name) || str(ident.employer_name),
    companyName: str(ident.company_name),
    sessionId: str(payload.session_id) || str(ident.session_id),
    entryPage: str(ev && ev.entry_page),
    messages: parseTranscript(transcriptText),
    hasEval,
    evalVersion: str(ev && ev.eval_version),
    score5: hasEval ? num(ev.score) : null,
    helpfulness10: hasEval ? num(ev.helpfulness_10) : null,
    botScorePct: null, // computed from turns below
    outcome: hasEval ? str(ev.outcome) : null,
    primaryIntent: hasEval ? str(ev.primary_intent) : null,
    sentimentEnd: hasEval ? str(ev.employer_sentiment_end) : null,
    languages: hasEval ? list(ev.languages) : [],
    flagForReview: hasEval ? !!ev.flag_for_review : null,
    failureTags: hasEval ? list(ev.failure_tags) : [],
    evalHandoff: hasEval ? yesNo(hh.happened) : null,
    handoffReason: str(hh.reason),
    agentJoined: yesNo(hh.agent_joined),
    resolvedByEmployer: str(rf.last_response),
    csat: csatFrom(ev && ev.csat, null),
    summary: str(ev && ev.summary),
    whatWentWrong: str(ev && ev.what_went_wrong),
    fixSuggestion: str(ev && ev.fix_suggestion),
    checks: (ev && ev.checks) || {},
    systemIssues: (ev && Array.isArray(ev.system_issues)) ? ev.system_issues : [],
    turns,
    raw: rec,
  };
}

function fromFlat(rec) {
  const meta = rec.metadata || {};
  const ident = meta.identity || {};
  const hh = meta.human_handoff || {};
  const hasEval = rec.has_evaluation === 'yes';
  let messages = Array.isArray(rec.transcript_json) && rec.transcript_json.length
    ? [...rec.transcript_json].sort((a, b) => (a.seq || 0) - (b.seq || 0)).map((m) => ({ speaker: m.speaker, text: String(m.text || '').trim() }))
    : parseTranscript(rec.transcript);
  if (Array.isArray(rec.human_transcript_json) && rec.human_transcript_json.length) {
    const known = new Set(messages.map((m) => m.speaker + '|' + m.text));
    rec.human_transcript_json.forEach((m) => {
      const msg = { speaker: m.speaker || 'Agent', text: String(m.text || '').trim() };
      if (!known.has(msg.speaker + '|' + msg.text)) messages.push(msg);
    });
  }
  const turns = (rec.turns || []).map((t) => ({
    no: t.turn_no ?? t.turn,
    userInput: t.user_input ?? null,
    botOutput: t.bot_output ?? null,
    replyType: t.reply_type || null,
    score: num(t.turn_score),
    whatWentWrong: str(t.what_went_wrong),
    tags: list(t.tags),
    tools: Array.isArray(t.tool_calls_json) && t.tool_calls_json.length ? toolsFromCalls(t.tool_calls_json) : toolsFromString(t.tools_used),
  }));
  return {
    shape: 'flat',
    id: str(rec.conversation_id) || str(rec.conversationId) || str(rec._id),
    mongoId: str(rec._id),
    createdAt: asDate(rec.received_at_utc) || asDate(rec.createdAt) || asDate(rec.started_at_utc),
    apnaEmployerId: str(rec.apna_employer_id) || str(ident.apna_employer_id),
    employerId: str(rec.employer_id) || str(ident.employer_id),
    userName: str(rec.user_display_name) || str(rec.user_name) || str(ident.user_name) || str(ident.employer_name),
    companyName: str(rec.company_name) || str(ident.company_name),
    sessionId: str(rec.session_id) || str(ident.session_id),
    entryPage: str(rec.entry_page),
    messages,
    hasEval,
    evalVersion: str(rec.eval_version),
    score5: num(rec.overall_score_5),
    helpfulness10: num(rec.helpfulness_10),
    botScorePct: num(rec.bot_score_pct),
    outcome: str(rec.outcome),
    primaryIntent: str(rec.primary_intent),
    sentimentEnd: str(rec.sentiment_end),
    languages: list(rec.languages),
    flagForReview: hasEval ? rec.flag_for_review === 'yes' : null,
    failureTags: list(rec.failure_tags),
    evalHandoff: yesNo(rec.agent_handoff),
    handoffReason: str(rec.handoff_reason),
    agentJoined: yesNo(rec.agent_joined),
    resolvedByEmployer: str(rec.resolved_by_employer),
    csat: csatFrom(meta.csat, rec.csat),
    summary: str(rec.summary),
    whatWentWrong: str(rec.what_went_wrong),
    fixSuggestion: str(rec.fix_suggestion),
    checks: meta.checks || {},
    systemIssues: Array.isArray(meta.system_issues) ? meta.system_issues : [],
    turns,
    botSessionSeconds: num(rec.bot_session_seconds),
    humanSessionSeconds: num(rec.human_session_seconds),
    raw: rec,
  };
}

// Derived facts used by the audit rules and the screens
function enrich(c) {
  const msgs = c.messages;
  const { date, time } = toIST(c.createdAt);
  c.dateIST = date;
  c.timeIST = time;
  c.userMessages = msgs.filter((m) => m.speaker === 'User').length;
  c.botMessages = msgs.filter((m) => m.speaker === 'Bot').length;
  c.agentMessages = msgs.filter((m) => m.speaker === 'Agent').length;
  // bot replies after the employer's first message (the welcome line is not a reply)
  const firstUser = msgs.findIndex((m) => m.speaker === 'User');
  c.botReplies = firstUser < 0 ? 0 : msgs.slice(firstUser).filter((m) => m.speaker === 'Bot').length;
  c.engaged = c.userMessages > 0;
  c.lastSpeaker = msgs.length ? msgs[msgs.length - 1].speaker : null;

  // Answers to "Did this resolve your query?"
  c.resolveAnswers = [];
  msgs.forEach((m, i) => {
    if (m.speaker !== 'Bot' || !BOT_LINES.resolveQuestion.test(m.text)) return;
    const reply = msgs.slice(i + 1).find((x) => x.speaker !== 'Bot');
    if (!reply || reply.speaker !== 'User') { c.resolveAnswers.push({ index: i, answer: 'no_reply' }); return; }
    const idx = msgs.indexOf(reply);
    let answer = 'other';
    if (ANSWER.no.test(reply.text)) answer = 'no';
    else if (ANSWER.yes.test(reply.text)) answer = 'yes';
    c.resolveAnswers.push({ index: idx, answer, text: reply.text });
  });
  c.closingSent = msgs.some((m) => m.speaker === 'Bot' && BOT_LINES.closing.test(m.text));

  // Handoff: evaluator's answer, a human agent's message, a handoff tool call, or a connect / support-hours line
  const toolHandoff = c.turns.some((t) => t.tools.some((x) => x.tool === 'agent_handoff'));
  const lineHandoff = msgs.some((m) => m.speaker === 'Bot' && BOT_LINES.handoff.test(m.text));
  const closedLine = msgs.some((m) => m.speaker === 'Bot' && BOT_LINES.supportClosed.test(m.text));
  // With evaluator turn data, only a real handoff (agent_handoff call or an agent's message) counts;
  // a connect line with no call is shown as "said only". Without it, the transcript lines are all we have.
  const hasToolData = c.turns.length > 0;
  c.handoff = hasToolData
    ? !!(c.evalHandoff || toolHandoff || c.agentMessages > 0)
    : !!(c.evalHandoff || c.agentMessages > 0 || lineHandoff);
  if (c.agentMessages > 0 || c.agentJoined) c.handoffStatus = 'agent_joined';
  else if (c.handoff && (c.outcome === 'handoff_closed_hours' || closedLine)) c.handoffStatus = 'support_closed';
  else if (c.handoff) c.handoffStatus = 'requested';
  else if (lineHandoff) c.handoffStatus = 'said_only';
  else c.handoffStatus = 'none';

  if (c.botScorePct === null) {
    const scores = c.turns.map((t) => t.score).filter((s) => s !== null);
    c.botScorePct = scores.length ? Math.round((1000 * scores.reduce((a, b) => a + b, 0)) / (5 * scores.length)) / 10 : null;
  }
  c.isTest = TEST_CONVERSATION_PATTERNS.some((re) => re.test(c.id || ''));
  c.searchText = [c.id, c.apnaEmployerId, c.employerId, c.userName, c.companyName, c.sessionId, c.primaryIntent,
    ...msgs.map((m) => m.text)].filter(Boolean).join(' ').toLowerCase();
  return c;
}

export function normalize(rec) {
  const isFlat = !rec.payload && (Array.isArray(rec.turns) || 'transcript_json' in rec || 'has_evaluation' in rec);
  return enrich(isFlat ? fromFlat(rec) : fromRaw(rec));
}

// Keep one record per conversation: the evaluated one, then the most recent
function better(a, b) {
  if (a.hasEval !== b.hasEval) return a.hasEval ? a : b;
  const ta = a.createdAt ? a.createdAt.getTime() : 0;
  const tb = b.createdAt ? b.createdAt.getTime() : 0;
  return tb > ta ? b : a;
}

export function mergeConversations(existing, records) {
  const byId = new Map(existing.map((c) => [c.id, c]));
  let skipped = 0;
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') { skipped++; continue; }
    let c;
    try { c = normalize(rec); } catch (e) { skipped++; continue; }
    if (!c.id) { skipped++; continue; }
    const prev = byId.get(c.id);
    byId.set(c.id, prev ? better(prev, c) : c);
  }
  const all = [...byId.values()].sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0));
  return { conversations: all, skipped };
}
