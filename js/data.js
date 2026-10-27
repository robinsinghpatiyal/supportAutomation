// Reads MongoDB exports of the supportPostChat collection and turns every record,
// whatever its shape, into one Conversation object the rest of the app uses.
//
// Two record shapes exist in the collection:
//  1. Raw post-chat records: { conversationId, createdAt, transcript, payload: { user_id, session_id,
//     agentInteractionData: { transcript }, eval }, eval }  ("assistant: ..." / "user: ..." lines)
//  2. Flattened rows (from 14 Oct 2026): { conversation_id, chat_date_ist, agent_handoff, turns: [...],
//     transcript_json: [...], metadata: {...}, ... }

import { BOT_LINES, TEST_CONVERSATION_PATTERNS, TEST_USER_IDS, ANSWER_NO, ANSWER_YES, SUPPORT_HOURS_IST } from './config.js';
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

function blueMachinesBody(raw) {
  const text = String(raw || '');
  const marker = text.match(/===\s*TRANSCRIPT\s*===/i);
  return marker ? text.slice(marker.index + marker[0].length) : text;
}

// Returns a complete JSON object beginning at or after start, respecting braces in strings.
function jsonObjectAfter(text, start) {
  const begin = text.indexOf('{', start);
  if (begin < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = begin; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return { text: text.slice(begin, i + 1), end: i + 1 };
  }
  return null;
}

function blueMachinesVariables(raw) {
  const body = blueMachinesBody(raw);
  const marker = body.search(/^\[Variables\]\s*$/m);
  if (marker < 0) return {};
  const object = jsonObjectAfter(body, marker);
  if (object) {
    try {
      const wrapper = JSON.parse(object.text);
      const input = wrapper?.details?.['Input Variables'];
      if (typeof input === 'string') return JSON.parse(input);
      if (input && typeof input === 'object') return input;
    } catch { /* fall through to field regexes */ }
  }
  const field = (name) => {
    const match = body.slice(marker, object?.end || marker + 5000)
      .match(new RegExp(`\\\\?"${name}\\\\?"\\s*:\\s*\\\\?"([^"\\\\}]*)`, 'i'));
    return match ? match[1].replace(/\\"/g, '"') : null;
  };
  return {
    apnaEmployerId: field('apnaEmployerId'),
    userId: field('userId'),
    employerId: field('employerId'),
    companyName: field('companyName'),
    apnaSupportPage: field('apnaSupportPage'),
  };
}

function blueMachinesToolCalls(raw) {
  const body = blueMachinesBody(raw);
  const userPositions = [...body.matchAll(/^User:\s/gmi)].map((m) => m.index);
  const calls = [];
  for (const marker of body.matchAll(/^\[Tool:\s*([^\]]+)\]\s*$/gmi)) {
    const fallbackName = marker[1].trim();
    const object = jsonObjectAfter(body, marker.index + marker[0].length);
    const segmentEnd = object?.end || body.slice(marker.index + marker[0].length).search(/\n(?:AI agent|User|\[Tool:|\[External Data\])/i);
    const segment = object?.text || body.slice(marker.index, segmentEnd > 0 ? marker.index + segmentEnd : undefined);
    let parsed = null;
    try { parsed = object ? JSON.parse(object.text) : null; } catch { /* regex fallback below */ }
    const details = parsed?.details || {};
    const metricText = Array.isArray(parsed?.metrics) ? parsed.metrics.join(' ') : segment;
    const latency = metricText.match(/Latency:\s*([\d.]+)\s*ms/i);
    const fallback = (label) => {
      const match = segment.match(new RegExp(`"${label}"\\s*:\\s*"((?:\\\\.|[^"])*)"`, 'i'));
      return match ? match[1].replace(/\\"/g, '"').replace(/\\\\n/g, '\n') : null;
    };
    calls.push({
      tool: details['Tool name'] || fallback('Tool name') || fallbackName,
      input: details['Tool input'] ?? fallback('Tool input'),
      output: details.Output ?? fallback('Output'),
      latencyMs: latency ? Number(latency[1]) : null,
      userMessageNo: userPositions.filter((position) => position < marker.index).length,
    });
  }
  return calls;
}

// The BlueMachines transcript also contains variables, tool payloads and debugger output.
// Keep only the lines visibly spoken by the AI, employer or human support agent.
function blueMachinesTranscript(raw) {
  const body = blueMachinesBody(raw);
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

// "[time] Name (Agent): text {delivery=...}" / "[time] Customer: text {delivery=...}"
// -> spoken support messages. Handoff lifecycle event lines are intentionally omitted.
function blueMachinesHumanTranscript(raw) {
  const messages = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const text = current.lines.join('\n')
      .replace(/\s+\{delivery=[^}]*\}\s*$/i, '')
      .trim();
    if (text) messages.push({ speaker: current.speaker, name: current.name, text, at: current.at });
    current = null;
  };

  for (const line of String(raw || '').split(/\r?\n/)) {
    const match = line.match(/^\[([^\]]+)\]\s+(.+?):\s*(.*)$/);
    if (match) {
      flush();
      const [, at, actor, rawText] = match;
      const isAgent = /\(agent\)\s*$/i.test(actor);
      const isUser = /^(customer|user|employer)$/i.test(actor.trim());
      if (!isAgent && !isUser) continue;
      current = {
        speaker: isAgent ? 'Agent' : 'User',
        name: isAgent ? actor.replace(/\s*\(agent\)\s*$/i, '').trim() : 'Customer',
        lines: [rawText],
        at,
      };
    } else if (current) {
      current.lines.push(line.trim());
    }
  }
  flush();
  return messages;
}

function blueMachinesHandoffEvents(raw) {
  const events = [];
  for (const match of String(raw || '').matchAll(/agent_handoff\.([a-z_]+)/gi)) {
    const event = match[1].toLowerCase();
    if (!events.includes(event)) events.push(event);
  }
  return events;
}

// Human handoff feedback is recorded after a feedback_prompt event, but older
// evaluator payloads can still say CSAT was not given. Prefer the explicit response.
function blueMachinesHumanCsat(raw) {
  const match = String(raw || '').match(/agent_handoff\.feedback_prompt[\s\S]*?\[[^\]]+\]\s+(?:Customer|User|Employer):\s*([^\n]+)/i);
  if (!match) return null;
  const answer = match[1].replace(/\s+\{delivery=[^}]*\}\s*$/i, '').trim();
  if (ANSWER_YES.test(answer)) return 'yes';
  if (ANSWER_NO.test(answer)) return 'no';
  return null;
}

function booleanCell(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['yes', 'true', '1'].includes(normalized)) return true;
  if (['no', 'false', '0'].includes(normalized)) return false;
  return null;
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
    const humanTranscript = get('humanTranscript');
    const rawTranscript = get('transcript');
    const variables = blueMachinesVariables(rawTranscript);
    const variableEmployerId = variables.apnaEmployerId || variables.userId || null;
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
      transcript: blueMachinesTranscript(rawTranscript),
      humanTranscript: blueMachinesHumanTranscript(humanTranscript),
      handoffEvents: blueMachinesHandoffEvents(humanTranscript),
      toolCalls: blueMachinesToolCalls(rawTranscript),
      variables,
      userId: identity.apna_employer_id || variableEmployerId,
      eval: evaluation,
      payload: {
        user_id: identity.apna_employer_id || variableEmployerId,
        session_id: identity.session_id || null,
      },
      blueMachines: {
        userDisplayName: get('userDisplayName') || null,
        userPhoneNumber: get('userPhoneNumber') || get('externalUserId') || null,
        externalUserId: get('externalUserId') || null,
        agentName: get('agentName') || null,
        durationSeconds: numberCell(get('durationSeconds')),
        statusType: get('statusType') || null,
        medium: get('medium') || null,
        interactionEnvironment: get('interactionEnvironment') || null,
        hasHumanHandoff: booleanCell(get('hasHumanHandoff')),
        handoffAgentName: get('handoffAgentName') || null,
        handoffPhase: get('handoffPhase') || null,
        handoffMessageCount: numberCell(get('handoffMessageCount')),
        handoffRequestedAt: get('handoffRequestedAt') || null,
        handoffHumanActiveAt: get('handoffHumanActiveAt') || null,
        handoffResolvedAt: get('handoffResolvedAt') || null,
        csat: blueMachinesHumanCsat(humanTranscript),
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

export function isSupportHoursIST(time) {
  return typeof time === 'string' && time >= SUPPORT_HOURS_IST.start && time < SUPPORT_HOURS_IST.end;
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
  const bm = rec.blueMachines || {};
  const variables = rec.variables || {};
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
    durationSeconds: num(rec.durationSeconds) ?? num(rec.blueMachines && rec.blueMachines.durationSeconds),
    apnaEmployerId: str(payload.user_id) || str(rec.userId) || str(ident.apna_employer_id)
      || str(variables.apnaEmployerId) || str(variables.userId),
    employerId: str(ident.employer_id) || str(variables.employerId),
    userName: str(rec.userDisplayName) || str(rec.blueMachines && rec.blueMachines.userDisplayName)
      || str(payload.user_name) || str(ident.user_name) || str(ident.employer_name),
    agentName: str(bm.agentName),
    interactionEnvironment: str(bm.interactionEnvironment),
    phoneNumber: str(rec.userPhoneNumber) || str(rec.blueMachines && rec.blueMachines.userPhoneNumber)
      || str(payload.user_phone_number) || str(payload.phone_number) || str(ident.phone_number),
    companyName: str(ident.company_name) || str(variables.companyName),
    sessionId: str(payload.session_id) || str(ident.session_id),
    entryPage: str(ev && ev.entry_page) || str(variables.apnaSupportPage),
    messages: parseTranscript(transcriptText),
    humanMessages: Array.isArray(rec.humanTranscript) ? rec.humanTranscript : [],
    toolCalls: Array.isArray(rec.toolCalls) ? rec.toolCalls : [],
    handoffEvents: Array.isArray(rec.handoffEvents) ? rec.handoffEvents : [],
    humanHandoff: bm.hasHumanHandoff === true,
    handoffAgentName: str(bm.handoffAgentName),
    handoffPhase: str(bm.handoffPhase),
    handoffMessageCount: num(bm.handoffMessageCount),
    handoffRequestedAt: asDate(bm.handoffRequestedAt),
    handoffHumanActiveAt: asDate(bm.handoffHumanActiveAt),
    handoffResolvedAt: asDate(bm.handoffResolvedAt),
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
    csat: csatFrom(ev && ev.csat, bm.csat),
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
  const botSessionSeconds = num(rec.bot_session_seconds);
  const humanSessionSeconds = num(rec.human_session_seconds);
  const durationSeconds = num(rec.duration_seconds)
    ?? (botSessionSeconds !== null || humanSessionSeconds !== null ? (botSessionSeconds || 0) + (humanSessionSeconds || 0) : null);
  return {
    shape: 'flat',
    id: str(rec.conversation_id) || str(rec.conversationId) || str(rec._id),
    mongoId: str(rec._id),
    createdAt: asDate(rec.received_at_utc) || asDate(rec.createdAt) || asDate(rec.started_at_utc),
    durationSeconds,
    apnaEmployerId: str(rec.apna_employer_id) || str(ident.apna_employer_id),
    employerId: str(rec.employer_id) || str(ident.employer_id),
    userName: str(rec.user_display_name) || str(rec.user_name) || str(ident.user_name) || str(ident.employer_name),
    agentName: str(rec.agent_name),
    interactionEnvironment: str(rec.interaction_environment),
    phoneNumber: str(rec.user_phone_number) || str(rec.phone_number) || str(ident.phone_number),
    companyName: str(rec.company_name) || str(ident.company_name),
    sessionId: str(rec.session_id) || str(ident.session_id),
    entryPage: str(rec.entry_page),
    messages,
    humanMessages: [],
    toolCalls: [],
    handoffEvents: [],
    humanHandoff: !!(rec.human_transcript_json && rec.human_transcript_json.length),
    handoffAgentName: str(rec.handoff_agent_name),
    handoffPhase: str(rec.handoff_phase),
    handoffMessageCount: num(rec.handoff_message_count),
    handoffRequestedAt: asDate(rec.handoff_requested_at),
    handoffHumanActiveAt: asDate(rec.handoff_human_active_at),
    handoffResolvedAt: asDate(rec.handoff_resolved_at),
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
    botSessionSeconds,
    humanSessionSeconds,
    raw: rec,
  };
}

// Derived facts used by the audit rules and the screens
function enrich(c) {
  const msgs = c.messages;
  const humanMsgs = Array.isArray(c.humanMessages) ? c.humanMessages : [];
  c.toolCalls = Array.isArray(c.toolCalls) ? c.toolCalls : [];
  c.handoffEvents = Array.isArray(c.handoffEvents) ? c.handoffEvents : [];
  const { date, time } = toIST(c.createdAt);
  c.dateIST = date;
  c.timeIST = time;
  c.inSupportHours = isSupportHoursIST(time);
  c.userMessages = msgs.filter((m) => m.speaker === 'User').length;
  c.botMessages = msgs.filter((m) => m.speaker === 'Bot').length;
  c.agentMessages = msgs.filter((m) => m.speaker === 'Agent').length
    + humanMsgs.filter((m) => m.speaker === 'Agent').length;
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

  // Tie raw BlueMachines calls to the employer message that triggered each one.
  const userIndices = msgs.map((m, i) => m.speaker === 'User' ? i : -1).filter((i) => i >= 0);
  c.toolCalls = c.toolCalls.map((call) => ({
    ...call,
    messageIndex: Number.isInteger(call.messageIndex)
      ? call.messageIndex
      : (userIndices[Math.max(0, Number(call.userMessageNo || 1) - 1)] ?? -1),
  }));

  // Handoff: evaluator evidence, raw tool calls, lifecycle events, timestamps, or an agent message.
  const evaluatorToolHandoff = c.turns.some((t) => t.tools.some((x) => x.tool === 'agent_handoff'));
  const rawHandoffCalls = c.toolCalls.filter((call) => call.tool === 'agent_handoff');
  const lastRawHandoff = rawHandoffCalls[rawHandoffCalls.length - 1] || null;
  const lastOutput = String(lastRawHandoff?.output || '');
  const event = (name) => c.handoffEvents.includes(name);
  const lineHandoff = msgs.some((m) => m.speaker === 'Bot' && BOT_LINES.handoff.test(m.text));
  const closedLine = msgs.some((m) => m.speaker === 'Bot' && BOT_LINES.supportClosed.test(m.text));
  const hasToolData = c.turns.length > 0 || c.toolCalls.length > 0;
  c.handoff = !!(c.evalHandoff || evaluatorToolHandoff || rawHandoffCalls.length
    || c.humanHandoff || c.handoffRequestedAt || event('requested') || c.agentMessages > 0);
  if (!hasToolData && lineHandoff) c.handoff = true; // Raw Mongo transcripts have no tool evidence.

  const agentJoined = c.agentMessages > 0 || c.agentJoined || event('human_active') || c.handoffHumanActiveAt;
  const supportClosedOutput = /closed right now|reopens at/i.test(lastOutput);
  if (agentJoined) c.handoffStatus = 'agent_joined';
  else if (c.handoff && (supportClosedOutput || closedLine || c.outcome === 'handoff_closed_hours')) c.handoffStatus = 'support_closed';
  else if (c.handoff) c.handoffStatus = 'requested';
  else if (lineHandoff) c.handoffStatus = 'said_only';
  else c.handoffStatus = 'none';

  const waits = rawHandoffCalls.map((call) => Number(call.latencyMs)).filter(Number.isFinite);
  c.handoffWaitSeconds = waits.length ? Math.round(Math.max(...waits) / 1000) : null;
  c.handoffDetail = null;
  if (c.handoffStatus === 'requested') {
    if (/human support could not be reached/i.test(lastOutput)) {
      c.handoffDetail = 'Support could not be reached';
    } else if (/support service is temporarily unavailable/i.test(lastOutput)) {
      c.handoffDetail = 'Support service unavailable';
    } else if (lastRawHandoff && !lastOutput.trim() && !event('requested')) {
      const waited = c.handoffWaitSeconds === null ? '' : ` after ${c.handoffWaitSeconds} s`;
      c.handoffDetail = `No result${waited}, no Freshchat request (usually the employer did not accept the handoff prompt)`;
    } else if (event('requested') && !event('assigned') && !event('human_active')) {
      c.handoffDetail = 'Sent to Freshchat, no agent assigned';
    }
  }

  if (c.botScorePct === null) {
    const scores = c.turns.map((t) => t.score).filter((s) => s !== null);
    c.botScorePct = scores.length ? Math.round((1000 * scores.reduce((a, b) => a + b, 0)) / (5 * scores.length)) / 10 : null;
  }
  c.isTest = TEST_CONVERSATION_PATTERNS.some((re) => re.test(c.id || ''))
    || TEST_USER_IDS.has(c.apnaEmployerId || '')
    || /test/i.test(c.agentName || '')
    || !!(c.interactionEnvironment && c.interactionEnvironment.toUpperCase() !== 'LIVE');
  c.searchText = [c.id, c.apnaEmployerId, c.employerId, c.userName, c.phoneNumber, c.companyName, c.sessionId, c.primaryIntent,
    ...msgs.map((m) => m.text), ...humanMsgs.map((m) => m.text)].filter(Boolean).join(' ').toLowerCase();
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
  const testPhoneNumbers = new Set(all
    .filter((c) => TEST_USER_IDS.has(c.apnaEmployerId || '') && c.phoneNumber)
    .map((c) => c.phoneNumber));
  all.forEach((c) => {
    if (c.phoneNumber && testPhoneNumbers.has(c.phoneNumber)) c.isTest = true;
  });
  return { conversations: all, skipped };
}
