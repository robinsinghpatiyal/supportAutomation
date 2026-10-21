// Apna Expert Audit: app shell, routing and screens.
// All data stays in this browser tab: files are read locally and never uploaded.

import { parseExport, parseBlueMachinesExport, mergeConversations } from './data.js';
import { runAudit, explicitlyResolved, turnForUserMessage } from './audit.js';
import { summarize, daily, topIntents, topTags } from './metrics.js';
import { CATEGORIES, THRESHOLDS } from './config.js';
import { dailyChart } from './chart.js';
import { esc, fmtPct, label, fmtDate, toast, download, toCSV, parseCSV } from './ui.js';

const ESC_KEY = 'apnaExpertAudit.escalations.v2';
const LEGACY_ESC_KEY = 'apnaExpertAudit.escalations.v1';
const PAGE_SIZE = 50;
const SHORT = {
  eval_flagged: 'Eval flagged',
  frustration: 'Frustration',
  loop: 'Loop / repeat',
  agent_request: 'Asked for human',
  unresolved: 'Unresolved',
  early_drop: 'Early drop-off',
  high_volume: 'Abandoned (many msgs)',
  support_escalation: 'Support escalation',
};
const ALERT_LABEL = {
  agent_request: 'not handed off in the next reply',
  unresolved: 'not passed to support',
};

const state = {
  convs: [],
  files: [],
  escalations: loadEscalations(),
  filters: { from: '', to: '', q: '', cat: '', handoff: '', hideTests: true, engagedOnly: true },
  transcriptFilters: { userId: '', phoneNumber: '', conversationId: '', handoff: '', csat: '', sort: 'newest', hideTests: true },
  page: 1,
  transcriptPage: 1,
};

const app = document.getElementById('app');

// ---------- escalations (stored in this browser) ----------

function loadEscalations() {
  try {
    const current = localStorage.getItem(ESC_KEY);
    if (current) return JSON.parse(current) || {};
    const legacy = JSON.parse(localStorage.getItem(LEGACY_ESC_KEY) || '{}') || {};
    const imported = Object.values(legacy).filter((e) => e && e.source === 'csv');
    const emptyImports = imported.filter((e) => !e.note && !e.by);
    // Older app versions could mistake a full conversation CSV for an escalation list.
    // Discard that polluted store instead of migrating thousands of false escalations.
    const polluted = imported.length >= 20 && emptyImports.length / imported.length >= 0.9;
    const migrated = polluted ? {} : legacy;
    localStorage.setItem(ESC_KEY, JSON.stringify(migrated));
    localStorage.removeItem(LEGACY_ESC_KEY);
    return migrated;
  } catch {
    return {};
  }
}
function saveEscalations() {
  try { localStorage.setItem(ESC_KEY, JSON.stringify(state.escalations)); } catch { /* storage blocked: kept for this tab only */ }
}
function importEscalations(text, name) {
  const rows = parseCSV(text);
  if (!rows.length) return 0;
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const fullExportColumns = ['audit_queues', 'bot_score_pct', 'employer_messages', 'primary_intent', 'explicitly_resolved'];
  if (fullExportColumns.filter((h) => head.includes(h)).length >= 2) {
    throw new Error('This is a full conversation export, not an escalations CSV');
  }
  let idCol = head.findIndex((h) => /conversation/.test(h));
  if (idCol < 0) idCol = head.findIndex((h) => h === 'id');
  const hasHeader = idCol >= 0;
  if (idCol < 0) idCol = 0;
  const noteCol = head.findIndex((h) => /note|comment|reason|issue/.test(h));
  const byCol = head.findIndex((h) => /^(by|agent|name|owner|reported by|flagged by)$/.test(h));
  let n = 0;
  rows.slice(hasHeader ? 1 : 0).forEach((r) => {
    const id = (r[idCol] || '').trim();
    if (!id) return;
    state.escalations[id] = {
      source: 'csv',
      note: noteCol >= 0 ? (r[noteCol] || '').trim() : '',
      by: byCol >= 0 ? (r[byCol] || '').trim() : '',
      at: new Date().toISOString(),
      file: name,
    };
    n++;
  });
  saveEscalations();
  return n;
}

// ---------- loading files ----------

async function loadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const before = state.convs.length;
  const messages = [];
  let skipped = 0;
  for (const f of files) {
    const text = await f.text();
    if (/\.csv$/i.test(f.name)) {
      try {
        const docs = parseBlueMachinesExport(text);
        const res = mergeConversations(state.convs, docs);
        state.convs = res.conversations;
        skipped += res.skipped;
        state.files.push(f.name);
        messages.push(`${docs.length} BlueMachines records from ${f.name}`);
      } catch (e) {
        if (e.message !== 'Not a BlueMachines conversation export') {
          messages.push(`Could not read ${f.name}: ${e.message}`);
          continue;
        }
        try {
          const n = importEscalations(text, f.name);
          messages.push(`${n} escalations from ${f.name}`);
        } catch (importError) {
          messages.push(`Could not read ${f.name}: ${importError.message}`);
        }
      }
      continue;
    }
    try {
      const docs = parseExport(text);
      const res = mergeConversations(state.convs, docs);
      state.convs = res.conversations;
      skipped += res.skipped;
      state.files.push(f.name);
    } catch (e) {
      messages.push(`Could not read ${f.name}: ${e.message}`);
    }
  }
  runAudit(state.convs, state.escalations);
  const added = state.convs.length - before;
  if (added) messages.unshift(`${added} chats loaded`);
  if (skipped) messages.push(`${skipped} records skipped`);
  toast(messages.join(' · ') || 'Nothing new in that file');
  updateStatus();
  route();
}

function loadText(text, name) {
  const docs = /\.csv$/i.test(name) ? parseBlueMachinesExport(text) : parseExport(text);
  const res = mergeConversations(state.convs, docs);
  state.convs = res.conversations;
  state.files.push(name);
  runAudit(state.convs, state.escalations);
  updateStatus();
  route();
}

function updateStatus() {
  const el = document.getElementById('data-status');
  const has = state.convs.length > 0;
  document.querySelectorAll('[data-needs-data]').forEach((b) => { b.disabled = !has; });
  if (!has) { el.textContent = 'No data loaded'; return; }
  const dates = state.convs.map((c) => c.dateIST).filter(Boolean).sort();
  el.textContent = `${state.convs.length} chats · ${fmtDate(dates[0])} to ${fmtDate(dates[dates.length - 1])}`;
}

// ---------- filtering ----------

function inRange(c) {
  const f = state.filters;
  if (f.hideTests && c.isTest) return false;
  if (f.from && c.dateIST < f.from) return false;
  if (f.to && c.dateIST > f.to) return false;
  return true;
}

function listFiltered() {
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  return state.convs.filter((c) => {
    if (!inRange(c)) return false;
    if (f.engagedOnly && !c.engaged) return false;
    if (f.handoff === 'yes' && !c.handoff) return false;
    if (f.handoff === 'no' && c.handoff) return false;
    if (f.cat === 'any' && !c.categories.length) return false;
    if (f.cat === 'alerts' && !c.alerts.length) return false;
    if (f.cat && f.cat !== 'any' && f.cat !== 'alerts' && !c.audit[f.cat]) return false;
    if (q && !c.searchText.includes(q)) return false;
    return true;
  });
}

function transcriptUserId(c) {
  return c.apnaEmployerId || c.employerId || '';
}

function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return '–';
  const total = Math.max(0, Math.round(Number(seconds)));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return `${hours}h ${minutes}m ${secs}s`;
  if (minutes) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function transcriptFiltered() {
  const f = state.transcriptFilters;
  const userId = f.userId.trim().toLowerCase();
  const phoneNumber = f.phoneNumber.trim().toLowerCase();
  const conversationId = f.conversationId.trim().toLowerCase();
  const rows = state.convs.filter((c) => {
    if (f.hideTests && c.isTest) return false;
    if (userId && !String(transcriptUserId(c)).toLowerCase().includes(userId)) return false;
    if (phoneNumber && !String(c.phoneNumber || '').toLowerCase().includes(phoneNumber)) return false;
    if (conversationId && !String(c.id || '').toLowerCase().includes(conversationId)) return false;
    if (f.handoff === 'yes' && !c.handoff) return false;
    if (f.handoff === 'no' && c.handoff) return false;
    if (f.csat === 'none' && c.csat !== null) return false;
    if (f.csat && f.csat !== 'none' && c.csat !== f.csat) return false;
    return true;
  });

  const text = (v) => String(v || '').toLowerCase();
  const score = (c) => c.botScorePct === null ? null : c.botScorePct;
  rows.sort((a, b) => {
    if (f.sort === 'oldest') return (a.createdAt?.getTime() || 0) - (b.createdAt?.getTime() || 0);
    if (f.sort === 'user_asc') return text(transcriptUserId(a)).localeCompare(text(transcriptUserId(b))) || text(a.id).localeCompare(text(b.id));
    if (f.sort === 'conversation_asc') return text(a.id).localeCompare(text(b.id));
    if (f.sort === 'score_desc' || f.sort === 'score_asc') {
      const as = score(a);
      const bs = score(b);
      if (as === null && bs === null) return 0;
      if (as === null) return 1;
      if (bs === null) return -1;
      return f.sort === 'score_desc' ? bs - as : as - bs;
    }
    return (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0);
  });
  return rows;
}

function istToday() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}
function daysAgo(n) {
  return new Date(Date.now() + 5.5 * 3600 * 1000 - n * 86400000).toISOString().slice(0, 10);
}

function dateFilters() {
  const f = state.filters;
  const range = !f.from && !f.to ? 'all' : f.to === '' && f.from === istToday() ? 'today' : f.to === '' && f.from === daysAgo(6) ? '7' : f.to === '' && f.from === daysAgo(29) ? '30' : '';
  return `
    <div class="field"><label>Range</label>
      <div class="seg" data-range>
        <button data-r="all" class="${range === 'all' ? 'on' : ''}">All</button>
        <button data-r="today" class="${range === 'today' ? 'on' : ''}">Today</button>
        <button data-r="7" class="${range === '7' ? 'on' : ''}">7 days</button>
        <button data-r="30" class="${range === '30' ? 'on' : ''}">30 days</button>
      </div>
    </div>
    <div class="field"><label for="f-from">From (IST)</label><input type="date" id="f-from" value="${esc(f.from)}"></div>
    <div class="field"><label for="f-to">To (IST)</label><input type="date" id="f-to" value="${esc(f.to)}"></div>
    <label class="check"><input type="checkbox" id="f-tests" ${f.hideTests ? 'checked' : ''}> Hide test chats</label>`;
}

function bindDateFilters(root, onChange) {
  root.querySelectorAll('[data-range] button').forEach((b) => b.addEventListener('click', () => {
    const r = b.dataset.r;
    state.filters.to = '';
    state.filters.from = r === 'all' ? '' : r === 'today' ? istToday() : daysAgo(Number(r) - 1);
    state.page = 1;
    onChange(true);
  }));
  root.querySelector('#f-from').addEventListener('change', (e) => { state.filters.from = e.target.value; state.page = 1; onChange(true); });
  root.querySelector('#f-to').addEventListener('change', (e) => { state.filters.to = e.target.value; state.page = 1; onChange(true); });
  root.querySelector('#f-tests').addEventListener('change', (e) => { state.filters.hideTests = e.target.checked; state.page = 1; onChange(false); });
}

// ---------- screens ----------

function renderUpload() {
  app.innerHTML = `
    <div class="dropzone" id="dropzone">
      <h1>Audit Apna Expert chats</h1>
      <p>Drop a MongoDB <b>supportPostChat</b> export or a BlueMachines transcripts CSV here.</p>
      <p class="muted small">JSON, NDJSON or BlueMachines CSV. You can add more files later; chats are merged by conversation id.</p>
      <button class="btn primary" id="pick">Choose export file</button>
      <div class="howto">
        <b>How to export from MongoDB</b>
        <ol>
          <li>Compass: open the <code>supportPostChat</code> collection, optionally filter by date, then <i>Export Data → Export the full collection → JSON</i>.</li>
          <li>Or the command line: <code>mongoexport --uri "&lt;uri&gt;" --collection supportPostChat --jsonArray --out chats.json</code></li>
          <li>Or download the transcripts CSV directly from BlueMachines and drop it here.</li>
        </ol>
        <b>Support escalations</b>
        <p>To bring in chats your team escalated, drop a CSV with a <code>conversation_id</code> column (optional <code>note</code> and <code>by</code> columns). You can also mark chats inside the app.</p>
      </div>
      <p class="privacy">Files are read in your browser only. Nothing is uploaded or stored on a server, and closing or refreshing the tab clears the chats (escalation notes stay in this browser).</p>
    </div>`;
  app.querySelector('#pick').addEventListener('click', () => document.getElementById('file-input').click());
}

function renderOverview() {
  app.innerHTML = `
    <div class="section-head"><h2>Overview</h2></div>
    <div class="filters card pad" id="ov-filters">${dateFilters()}</div>
    <div id="ov-body"></div>`;
  bindDateFilters(app.querySelector('#ov-filters'), (rerenderFilters) => {
    if (rerenderFilters) renderOverview(); else renderOverviewBody();
  });
  renderOverviewBody();
}

function renderOverviewBody() {
  const convs = state.convs.filter(inRange);
  const s = summarize(convs);
  const tiles = [
    ['Engaged chats', s.engaged, `of ${s.chats} chats; ${s.chats - s.engaged} closed without a message`],
    ['Avg conversation time', fmtDuration(s.avgConversationSeconds), 'Average duration in the loaded export'],
    ['Contained by the bot', fmtPct(s.containmentPct), `${s.handedOff} handed off (${s.supportClosed} while support was closed)${s.saidOnly ? `; ${s.saidOnly} told "connecting" with no handoff` : ''}`],
    ['Human support chats', s.humanHandoffs, `${s.humanHandoffResolved} resolved · ${s.humanHandoffActive} active · ${s.humanHandoffClosedByUser} closed by user · ${s.humanHandoffTimedOut} timed out`],
    ['Employer said resolved', fmtPct(s.resolveYesPct), s.resolveAsked ? `of ${s.resolveAsked} asked "Did this resolve your query?"` : 'No one was asked yet'],
    ['Avg bot score', s.avgBotScorePct === null ? '–' : `${Math.round(s.avgBotScorePct)}%`, `evaluator turn scores, ${s.evaluated} evaluated chats`],
    ['CSAT yes', s.csatGiven ? fmtPct(s.csatYesPct) : '–', s.csatGiven ? `of ${s.csatGiven} answers` : 'No CSAT answers in the data yet'],
    ['In an audit queue', s.flagged, `${fmtPct(s.chats ? (100 * s.flagged) / s.chats : null)} of chats`],
  ];
  const body = app.querySelector('#ov-body');
  body.innerHTML = `
    <div class="section tiles">
      ${tiles.map(([l, v, sub]) => `<div class="card tile"><div class="label">${esc(l)}</div><div class="value num">${esc(v)}</div><div class="sub">${esc(sub)}</div></div>`).join('')}
    </div>
    <div class="section">
      <div class="section-head"><h2>Audit queues</h2><span class="muted small">Open a queue to review its chats. A chat can sit in more than one queue. Shares are of engaged chats.</span></div>
      <div class="queues">
        ${CATEGORIES.map((cat) => {
          const n = s.categoryCounts[cat.key];
          const alerts = s.categoryAlerts[cat.key];
          return `<a class="card queue" href="#/list?cat=${cat.key}">
            <div class="top"><h3>${esc(cat.name)}</h3><span class="count num">${n}</span></div>
            <div class="share">${s.engaged ? `${Math.round((100 * n) / s.engaged)}% of engaged chats` : ''}</div>
            ${alerts ? `<div class="alert-line"><span class="chip alert">⚠ ${alerts} ${esc(ALERT_LABEL[cat.key] || 'need a check')}</span></div>` : ''}
            <div class="rule">${esc(cat.rule)}</div>
          </a>`;
        }).join('')}
      </div>
    </div>
    <div class="section card pad">
      <div class="section-head"><h2>Engaged chats per day (IST)</h2><span class="muted small">Hover a bar for the numbers</span></div>
      <div id="daily"></div>
    </div>
    <div class="section two-col">
      <div class="card pad"><h2>Top intents</h2><p class="muted small">Engaged chats by the evaluator's main intent, with average bot score and handoff share</p>${rankTable(topIntents(convs), (r) => `${r.count} · ${r.avgScore === null ? '–' : Math.round(r.avgScore) + '%'} · ${fmtPct(r.handoffPct)} handoff`)}</div>
      <div class="card pad"><h2>Top failure tags</h2><p class="muted small">Chats carrying each evaluator tag</p>${rankTable(topTags(convs), (r) => `${r.count}`)}</div>
    </div>`;
  dailyChart(body.querySelector('#daily'), daily(convs));
}

function rankTable(rows, valueText) {
  if (!rows.length) return '<p class="muted">No evaluated chats in this range.</p>';
  const max = Math.max(...rows.map((r) => r.count));
  return `<table class="rank">${rows.map((r) => `
    <tr><td class="name">${esc(label(r.name))}</td>
    <td><div class="bar" style="width:${Math.max(2, (100 * r.count) / max)}%"></div></td>
    <td class="val num">${esc(valueText(r))}</td></tr>`).join('')}</table>`;
}

function renderList(params) {
  if (params.has('cat')) state.filters.cat = params.get('cat');
  const f = state.filters;
  app.innerHTML = `
    <div class="section-head"><h2>Conversations</h2></div>
    <div class="filters card pad" id="list-filters">
      <div class="field"><label for="f-q">Search</label><input type="search" id="f-q" placeholder="Name, phone, employer id, conversation id or any text" value="${esc(f.q)}"></div>
      <div class="field"><label for="f-cat">Audit queue</label>
        <select id="f-cat">
          <option value="">All chats</option>
          <option value="any" ${f.cat === 'any' ? 'selected' : ''}>In any audit queue</option>
          <option value="alerts" ${f.cat === 'alerts' ? 'selected' : ''}>⚠ Needs a check (handoff missing)</option>
          ${CATEGORIES.map((c) => `<option value="${c.key}" ${f.cat === c.key ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select></div>
      <div class="field"><label for="f-handoff">Handoff</label>
        <select id="f-handoff">
          <option value="">Any</option>
          <option value="yes" ${f.handoff === 'yes' ? 'selected' : ''}>Handed off</option>
          <option value="no" ${f.handoff === 'no' ? 'selected' : ''}>Not handed off</option>
        </select></div>
      ${dateFilters()}
      <label class="check"><input type="checkbox" id="f-engaged" ${f.engagedOnly ? 'checked' : ''}> Only chats with an employer message</label>
    </div>
    <div id="cat-note"></div>
    <div class="section card" id="list-body"></div>`;
  const root = app.querySelector('#list-filters');
  root.querySelector('#f-q').addEventListener('input', (e) => { f.q = e.target.value; state.page = 1; renderListBody(); });
  root.querySelector('#f-cat').addEventListener('change', (e) => {
    f.cat = e.target.value; state.page = 1;
    history.replaceState(null, '', f.cat ? `#/list?cat=${f.cat}` : '#/list');
    renderListBody();
  });
  root.querySelector('#f-handoff').addEventListener('change', (e) => { f.handoff = e.target.value; state.page = 1; renderListBody(); });
  root.querySelector('#f-engaged').addEventListener('change', (e) => { f.engagedOnly = e.target.checked; state.page = 1; renderListBody(); });
  bindDateFilters(root, (rerenderFilters) => { if (rerenderFilters) renderList(new URLSearchParams()); else renderListBody(); });
  renderListBody();
}

function handoffChip(c) {
  return {
    agent_joined: '<span class="chip good">Agent joined</span>',
    support_closed: '<span class="chip warn">Support closed</span>',
    requested: '<span class="chip">Handed off</span>',
    said_only: '<span class="chip alert" title="The bot said it would connect, but no handoff was made">⚠ Said only</span>',
    none: '<span class="muted">–</span>',
  }[c.handoffStatus];
}

function queueChips(c) {
  return `<div class="chips">${c.categories.map((k) => {
    const alert = c.audit[k].alert;
    return `<span class="chip ${alert ? 'alert' : ''}" title="${esc(alert || CATEGORIES.find((x) => x.key === k).name)}">${alert ? '⚠ ' : ''}${esc(SHORT[k])}</span>`;
  }).join('')}</div>`;
}

function renderListBody() {
  const rows = listFiltered();
  const f = state.filters;
  const cat = CATEGORIES.find((c) => c.key === f.cat);
  app.querySelector('#cat-note').innerHTML = cat
    ? `<div class="section card pad"><b>${esc(cat.name)}</b><div class="muted small">Rule: ${esc(cat.rule)}</div><div class="muted small">What to check: ${esc(cat.objective)}</div></div>`
    : '';
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  state.page = Math.min(state.page, pages);
  const slice = rows.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
  const body = app.querySelector('#list-body');
  const escalationExport = f.cat === 'support_escalation';
  body.innerHTML = `
    <div class="pager" style="justify-content:space-between">
      <span class="muted">${rows.length} chats</span>
      <button class="btn" id="export-csv" ${rows.length ? '' : 'disabled'}>${escalationExport ? 'Download escalations CSV' : 'Export these to CSV'}</button>
    </div>
    <div class="table-wrap"><table class="list">
      <thead><tr><th>When (IST)</th><th>Conversation time</th><th>Employer</th><th>Employer number</th><th>First message</th><th>Intent</th><th class="num">Msgs</th><th>Handoff</th><th>Outcome</th><th class="num">Bot score</th><th>Audit queues</th></tr></thead>
      <tbody>${slice.map((c) => {
        const first = c.messages.find((m) => m.speaker === 'User');
        return `<tr class="row" data-id="${esc(c.id)}">
          <td class="when num">${esc(fmtDate(c.dateIST))}<br><span class="muted">${esc(c.timeIST)}</span></td>
          <td class="num">${esc(fmtDuration(c.durationSeconds))}</td>
          <td>${esc(c.userName || c.apnaEmployerId || '–')}
            <br><span class="muted small">${esc(c.apnaEmployerId || '')}</span>
            ${c.companyName ? `<br><span class="muted small">${esc(c.companyName)}</span>` : ''}</td>
          <td class="num">${esc(c.phoneNumber || '–')}</td>
          <td class="first-msg">${esc(first ? truncate(first.text, 90) : '(no message)')}</td>
          <td>${esc(label(c.primaryIntent))}</td>
          <td class="num">${c.userMessages}</td>
          <td>${handoffChip(c)}</td>
          <td>${esc(label(c.outcome))}</td>
          <td class="num">${c.botScorePct === null ? '<span class="muted">–</span>' : `${Math.round(c.botScorePct)}%`}${c.helpfulness10 !== null ? `<br><span class="muted small">${c.helpfulness10}/10 helpful</span>` : ''}</td>
          <td>${queueChips(c)}</td>
        </tr>`;
      }).join('') || '<tr><td colspan="11" class="muted" style="padding:24px">No chats match these filters.</td></tr>'}</tbody>
    </table></div>
    ${pages > 1 ? `<div class="pager"><button class="btn" id="prev" ${state.page === 1 ? 'disabled' : ''}>Previous</button><span class="muted">Page ${state.page} of ${pages}</span><button class="btn" id="next" ${state.page === pages ? 'disabled' : ''}>Next</button></div>` : ''}`;
  body.querySelectorAll('tr.row').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/c/${encodeURIComponent(tr.dataset.id)}`; }));
  body.querySelector('#export-csv')?.addEventListener('click', () => {
    if (escalationExport) exportEscalations(rows);
    else exportCSV(rows);
  });
  body.querySelector('#prev')?.addEventListener('click', () => { state.page--; renderListBody(); window.scrollTo(0, 0); });
  body.querySelector('#next')?.addEventListener('click', () => { state.page++; renderListBody(); window.scrollTo(0, 0); });
}

function fmtMessageTimestamp(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const ist = new Date(date.getTime() + 5.5 * 3600000).toISOString();
  return `${ist.slice(0, 10)} ${ist.slice(11, 19)} IST`;
}

function compactTranscript(c) {
  const bot = c.messages.map((m) => `${m.speaker.toLowerCase()}: ${m.text}`);
  const human = (c.humanMessages || []).map((m) => {
    const timestamp = fmtMessageTimestamp(m.at);
    return `${timestamp ? `[${timestamp}] ` : ''}${m.speaker.toLowerCase()}: ${m.text}`;
  });
  return [...bot, ...(human.length ? ['', '--- human support ---', ...human] : [])].join('\n');
}

function transcriptText(c) {
  const speaker = { Bot: 'Apna Expert', User: 'Employer', Agent: 'Support agent' };
  const handoff = c.handoff ? label(c.handoffStatus) : c.handoffStatus === 'said_only' ? 'said only (no handoff)' : 'no';
  const header = [
    'APNA EXPERT TRANSCRIPT',
    `Conversation ID: ${c.id || '–'}`,
    `Name: ${c.userName || '–'}`,
    `User ID: ${transcriptUserId(c) || '–'}`,
    `Employer number: ${c.phoneNumber || '–'}`,
    `Time (IST): ${c.dateIST || '–'} ${c.timeIST || ''}`.trim(),
    `Conversation time: ${fmtDuration(c.durationSeconds)}`,
    `Bot score: ${c.botScorePct === null ? '–' : `${Math.round(c.botScorePct)}%`}`,
    `CSAT: ${c.csat || 'not given'}`,
    `Human handoff: ${handoff}`,
  ];
  const messages = c.messages.map((m) => `${speaker[m.speaker] || m.speaker}: ${m.text}`);
  const humanMessages = (c.humanMessages || []).map((m) => {
    const timestamp = fmtMessageTimestamp(m.at);
    return `${timestamp ? `[${timestamp}] ` : ''}${m.name || speaker[m.speaker] || m.speaker}: ${m.text}`;
  });
  if (humanMessages.length) messages.push('', '--- HUMAN SUPPORT CONVERSATION ---', ...humanMessages);
  if (!messages.length) messages.push('(No spoken transcript available.)');
  return [...header, '', ...messages].join('\n');
}

function transcriptFilename(c) {
  const id = String(c.id || 'conversation').replace(/[^a-z0-9._-]+/gi, '-');
  return `apna-expert-transcript-${id}.txt`;
}

function downloadTranscripts(rows) {
  const separator = `\n\n${'='.repeat(80)}\n\n`;
  download(`apna-expert-transcripts-${istToday()}.txt`, rows.map(transcriptText).join(separator), 'text/plain');
}

function renderTranscriptList() {
  const f = state.transcriptFilters;
  app.innerHTML = `
    <div class="section-head">
      <div><h2>Transcript generator</h2><span class="muted small">Browse and download clean, formatted chat transcripts.</span></div>
      <button class="btn primary" id="download-all-transcripts">Download all transcripts (.txt)</button>
    </div>
    <div class="filters card pad" id="transcript-filters">
      <div class="field"><label for="tf-user">User ID</label><input type="search" id="tf-user" placeholder="Search user ID" value="${esc(f.userId)}"></div>
      <div class="field"><label for="tf-phone">Employer number</label><input type="search" id="tf-phone" placeholder="Search phone number" value="${esc(f.phoneNumber)}"></div>
      <div class="field"><label for="tf-conversation">Conversation ID</label><input type="search" id="tf-conversation" placeholder="Search conversation ID" value="${esc(f.conversationId)}"></div>
      <div class="field"><label for="tf-handoff">Human handoff</label>
        <select id="tf-handoff">
          <option value="">Any</option>
          <option value="yes" ${f.handoff === 'yes' ? 'selected' : ''}>Yes</option>
          <option value="no" ${f.handoff === 'no' ? 'selected' : ''}>No</option>
        </select></div>
      <div class="field"><label for="tf-csat">CSAT</label>
        <select id="tf-csat">
          <option value="">Any</option>
          <option value="yes" ${f.csat === 'yes' ? 'selected' : ''}>Yes</option>
          <option value="no" ${f.csat === 'no' ? 'selected' : ''}>No</option>
          <option value="none" ${f.csat === 'none' ? 'selected' : ''}>Not given</option>
        </select></div>
      <div class="field"><label for="tf-sort">Sort</label>
        <select id="tf-sort">
          <option value="newest" ${f.sort === 'newest' ? 'selected' : ''}>Newest first</option>
          <option value="oldest" ${f.sort === 'oldest' ? 'selected' : ''}>Oldest first</option>
          <option value="user_asc" ${f.sort === 'user_asc' ? 'selected' : ''}>User ID A–Z</option>
          <option value="conversation_asc" ${f.sort === 'conversation_asc' ? 'selected' : ''}>Conversation ID A–Z</option>
          <option value="score_desc" ${f.sort === 'score_desc' ? 'selected' : ''}>Bot score high–low</option>
          <option value="score_asc" ${f.sort === 'score_asc' ? 'selected' : ''}>Bot score low–high</option>
        </select></div>
      <label class="check"><input type="checkbox" id="tf-tests" ${f.hideTests ? 'checked' : ''}> Hide test users</label>
    </div>
    <div class="section card" id="transcript-list-body"></div>`;

  const filters = app.querySelector('#transcript-filters');
  const update = (key, value) => {
    f[key] = value;
    state.transcriptPage = 1;
    renderTranscriptListBody();
  };
  filters.querySelector('#tf-user').addEventListener('input', (e) => update('userId', e.target.value));
  filters.querySelector('#tf-phone').addEventListener('input', (e) => update('phoneNumber', e.target.value));
  filters.querySelector('#tf-conversation').addEventListener('input', (e) => update('conversationId', e.target.value));
  filters.querySelector('#tf-handoff').addEventListener('change', (e) => update('handoff', e.target.value));
  filters.querySelector('#tf-csat').addEventListener('change', (e) => update('csat', e.target.value));
  filters.querySelector('#tf-sort').addEventListener('change', (e) => update('sort', e.target.value));
  filters.querySelector('#tf-tests').addEventListener('change', (e) => update('hideTests', e.target.checked));
  app.querySelector('#download-all-transcripts').addEventListener('click', () => downloadTranscripts(state.convs));
  renderTranscriptListBody();
}

function renderTranscriptListBody() {
  const rows = transcriptFiltered();
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  state.transcriptPage = Math.min(state.transcriptPage, pages);
  const start = (state.transcriptPage - 1) * PAGE_SIZE;
  const slice = rows.slice(start, start + PAGE_SIZE);
  const body = app.querySelector('#transcript-list-body');
  body.innerHTML = `
    <div class="pager" style="justify-content:space-between">
      <span class="muted">${rows.length} of ${state.convs.length} transcripts</span>
      <button class="btn" id="download-filtered-transcripts" ${rows.length ? '' : 'disabled'}>Download filtered transcripts</button>
    </div>
    <div class="table-wrap"><table class="list">
      <thead><tr><th>Name</th><th>Employer number</th><th>User ID</th><th>Conversation ID</th><th>Time (IST)</th><th>Conversation time</th><th class="num">Bot score</th><th>CSAT</th><th>Human handoff</th></tr></thead>
      <tbody>${slice.map((c) => `<tr class="row" data-id="${esc(c.id)}">
        <td>${esc(c.userName || '–')}${c.isTest ? '<br><span class="chip warn">Test user</span>' : ''}</td>
        <td class="num">${esc(c.phoneNumber || '–')}</td>
        <td class="num">${esc(transcriptUserId(c) || '–')}</td>
        <td class="num">${esc(c.id)}</td>
        <td class="when num">${esc(fmtDate(c.dateIST))}${c.dateIST ? ` ${esc(c.dateIST.slice(0, 4))}` : ''}<br><span class="muted">${esc(c.timeIST)}</span></td>
        <td class="num">${esc(fmtDuration(c.durationSeconds))}</td>
        <td class="num">${c.botScorePct === null ? '<span class="muted">–</span>' : `${Math.round(c.botScorePct)}%`}</td>
        <td>${c.csat ? `<span class="chip ${c.csat === 'yes' ? 'good' : 'alert'}">${esc(label(c.csat))}</span>` : '<span class="muted">Not given</span>'}</td>
        <td>${handoffChip(c)}</td>
      </tr>`).join('') || '<tr><td colspan="9" class="muted" style="padding:24px">No transcripts match these filters.</td></tr>'}</tbody>
    </table></div>
    ${pages > 1 ? `<div class="pager"><button class="btn" id="transcript-prev" ${state.transcriptPage === 1 ? 'disabled' : ''}>Previous</button><span class="muted">Page ${state.transcriptPage} of ${pages}</span><button class="btn" id="transcript-next" ${state.transcriptPage === pages ? 'disabled' : ''}>Next</button></div>` : ''}`;
  body.querySelectorAll('tr.row').forEach((tr) => tr.addEventListener('click', () => {
    location.hash = `#/transcripts/c/${encodeURIComponent(tr.dataset.id)}`;
  }));
  body.querySelector('#download-filtered-transcripts')?.addEventListener('click', () => downloadTranscripts(rows));
  body.querySelector('#transcript-prev')?.addEventListener('click', () => {
    state.transcriptPage--;
    renderTranscriptListBody();
    window.scrollTo(0, 0);
  });
  body.querySelector('#transcript-next')?.addEventListener('click', () => {
    state.transcriptPage++;
    renderTranscriptListBody();
    window.scrollTo(0, 0);
  });
}

function renderTranscriptDetail(id) {
  const c = state.convs.find((conversation) => conversation.id === id);
  if (!c) {
    app.innerHTML = `<div class="card pad">This transcript is not in the loaded data. <a href="#/transcripts">Back to transcripts</a></div>`;
    return;
  }
  app.innerHTML = `
    <div class="section-head">
      <p><a href="#/transcripts">← Back to transcript generator</a></p>
      <button class="btn primary" id="download-transcript">Download transcript (.txt)</button>
    </div>
    <div class="card pad">
      <div class="detail-head">
        <div>
          <h1>Transcript · ${esc(c.id)}</h1>
          <div class="meta">
            <span>Name <b>${esc(c.userName || '–')}</b></span>
            <span>Employer number <b class="num">${esc(c.phoneNumber || '–')}</b></span>
            <span>User ID <b class="num">${esc(transcriptUserId(c) || '–')}</b></span>
            <span>Time <b>${esc(fmtDate(c.dateIST))} ${c.dateIST ? esc(c.dateIST.slice(0, 4)) : ''}, ${esc(c.timeIST)} IST</b></span>
            <span>Conversation time <b>${esc(fmtDuration(c.durationSeconds))}</b></span>
            <span>Bot score <b>${c.botScorePct === null ? '–' : `${Math.round(c.botScorePct)}%`}</b></span>
            <span>CSAT <b>${esc(c.csat || 'Not given')}</b></span>
            <span>Human handoff ${handoffChip(c)}</span>
            ${c.handoffAgentName ? `<span>Support agent <b>${esc(c.handoffAgentName)}</b></span>` : ''}
            ${c.handoffPhase ? `<span>Support status <b>${esc(label(c.handoffPhase))}</b></span>` : ''}
          </div>
        </div>
      </div>
    </div>
    <div class="card section">
      <div class="pad" style="padding-bottom:0"><h2>Full transcript</h2></div>
      <div class="transcript">${transcriptHTML(c)}</div>
    </div>`;
  app.querySelector('#download-transcript').addEventListener('click', () => {
    download(transcriptFilename(c), transcriptText(c), 'text/plain');
  });
  window.scrollTo(0, 0);
}

const truncate = (t, n) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function exportEscalations(conversations = null) {
  const entries = conversations
    ? conversations.map((c) => [c.id, state.escalations[c.id], c]).filter(([, e]) => e)
    : Object.entries(state.escalations).map(([id, e]) => [id, e, state.convs.find((c) => c.id === id)]);
  const rows = entries.map(([id, e, c]) => [
    id, c ? transcriptUserId(c) : '', c?.phoneNumber || '', e.note, e.by, e.at, e.source,
    c ? compactTranscript(c) : '',
  ]);
  download(`apna-expert-escalations-${istToday()}.csv`, toCSV([
    ['conversation_id', 'user_id', 'employer_number', 'note', 'by', 'marked_at', 'source', 'transcript'],
    ...rows,
  ]));
}

function exportCSV(rows) {
  const head = ['conversation_id', 'date_ist', 'time_ist', 'conversation_seconds', 'employer_name', 'employer_number', 'apna_employer_id', 'company_name', 'entry_page', 'primary_intent',
    'employer_messages', 'bot_replies', 'handoff', 'outcome', 'explicitly_resolved', 'bot_score_pct', 'helpfulness_10',
    'csat', 'audit_queues', 'needs_check', 'reasons', 'escalation_note', 'summary', 'transcript'];
  const data = rows.map((c) => [
    c.id, c.dateIST, c.timeIST, c.durationSeconds, c.userName, c.phoneNumber, c.apnaEmployerId, c.companyName, c.entryPage, c.primaryIntent,
    c.userMessages, c.botReplies, c.handoffStatus, c.outcome, explicitlyResolved(c) ? 'yes' : 'no', c.botScorePct, c.helpfulness10,
    c.csat, c.categories.map((k) => CATEGORIES.find((x) => x.key === k).name).join('; '), c.alerts.join('; '),
    c.categories.map((k) => `${SHORT[k]}: ${c.audit[k].reasons.join(' ')}`).join(' | '),
    state.escalations[c.id]?.note || '', c.summary,
    compactTranscript(c),
  ]);
  const cat = state.filters.cat ? `-${state.filters.cat}` : '';
  download(`apna-expert-audit${cat}-${istToday()}.csv`, toCSV([head, ...data]));
}

function renderDetail(id) {
  const c = state.convs.find((x) => x.id === id);
  if (!c) {
    app.innerHTML = `<div class="card pad">This chat is not in the loaded data. <a href="#/list">Back to conversations</a></div>`;
    return;
  }
  const backCat = state.filters.cat ? `?cat=${state.filters.cat}` : '';
  const esc0 = state.escalations[c.id];
  app.innerHTML = `
    <p><a href="#/list${backCat}">← Back to conversations</a></p>
    <div class="card pad">
      <div class="detail-head">
        <div>
          <h1>Chat on ${esc(fmtDate(c.dateIST))} ${esc(c.dateIST.slice(0, 4))}, ${esc(c.timeIST)} IST</h1>
          <div class="meta">
            <span>Conversation <b class="num">${esc(c.id)}</b> <button class="btn small" id="copy-id" style="padding:1px 8px">Copy</button></span>
            ${c.userName ? `<span>Name <b>${esc(c.userName)}</b></span>` : ''}
            ${c.phoneNumber ? `<span>Employer number <b class="num">${esc(c.phoneNumber)}</b></span>` : ''}
            <span>Apna employer <b>${esc(c.apnaEmployerId || '–')}</b></span>
            <span>Conversation time <b>${esc(fmtDuration(c.durationSeconds))}</b></span>
            ${c.companyName ? `<span>Company <b>${esc(c.companyName)}</b></span>` : ''}
            ${c.entryPage ? `<span>Opened from <b>${esc(label(c.entryPage))}</b></span>` : ''}
            ${c.sessionId ? `<span>Session <b class="num">${esc(c.sessionId)}</b></span>` : ''}
          </div>
          <div class="meta">
            <span>Intent <b>${esc(label(c.primaryIntent))}</b></span>
            <span>Outcome <b>${esc(label(c.outcome))}</b></span>
            <span>Bot score <b>${c.botScorePct === null ? '–' : Math.round(c.botScorePct) + '%'}</b></span>
            <span>Helpfulness <b>${c.helpfulness10 === null ? '–' : c.helpfulness10 + '/10'}</b></span>
            <span>Handoff ${handoffChip(c)}</span>
            ${c.handoffAgentName ? `<span>Support agent <b>${esc(c.handoffAgentName)}</b></span>` : ''}
            ${c.handoffPhase ? `<span>Support status <b>${esc(label(c.handoffPhase))}</b></span>` : ''}
            ${c.languages.length ? `<span>Language <b>${esc(c.languages.join(', '))}</b></span>` : ''}
            <span class="muted">${c.hasEval ? `Evaluator ${esc(c.evalVersion || '')}` : 'Not evaluated'}</span>
          </div>
        </div>
      </div>
    </div>
    ${c.categories.length ? `<div class="card why">
      <div class="pad" style="padding-bottom:8px"><h2>Why this chat is in the audit queues</h2></div>
      ${c.categories.map((k) => {
        const cat = CATEGORIES.find((x) => x.key === k);
        const r = c.audit[k];
        return `<div class="cat"><b>${esc(cat.name)}</b> ${r.alert ? `<span class="chip alert">⚠ ${esc(r.alert)}</span>` : ''}
          <ul>${r.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
      }).join('')}
    </div>` : '<div class="card pad why muted">This chat is not in any audit queue.</div>'}
    <div class="detail-grid">
      <div class="card"><div class="pad" style="padding-bottom:0"><h2>Transcript</h2><p class="muted small">Evaluator notes appear under the bot's reply to each employer message.</p></div>
        <div class="transcript">${transcriptHTML(c)}</div></div>
      <div class="side">
        ${c.summary || c.whatWentWrong || c.fixSuggestion ? `<div class="card pad">
          ${c.summary ? `<h3>Summary</h3><p>${esc(c.summary)}</p>` : ''}
          ${c.whatWentWrong ? `<h3 style="margin-top:10px">What went wrong</h3><p>${esc(c.whatWentWrong)}</p>` : ''}
          ${c.fixSuggestion ? `<h3 style="margin-top:10px">Fix suggestion</h3><p>${esc(c.fixSuggestion)}</p>` : ''}
          ${c.failureTags.length ? `<div class="chips" style="margin-top:8px">${c.failureTags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
        </div>` : ''}
        ${checksHTML(c)}
        ${c.systemIssues.length ? `<div class="card pad"><h3>System issues</h3><ul style="margin:4px 0;padding-left:18px;color:var(--ink-2)">${c.systemIssues.map((s) => `<li>${esc([s.lookup, s.error, s.times ? `×${s.times}` : ''].filter(Boolean).join(' · '))}</li>`).join('')}</ul></div>` : ''}
        <div class="card pad esc-form">
          <h3>Support escalation</h3>
          <p class="muted small">Mark this chat for the Support Team Escalations queue. Saved in this browser; it goes into CSV exports.</p>
          <textarea id="esc-note" placeholder="What went wrong for the employer or the agent?">${esc(esc0?.note || '')}</textarea>
          <input id="esc-by" placeholder="Your name" value="${esc(esc0?.by || '')}">
          <div class="row-actions">
            <button class="btn primary" id="esc-save">${esc0 ? 'Update escalation' : 'Mark as escalated'}</button>
            ${esc0 ? '<button class="btn danger" id="esc-remove">Remove</button>' : ''}
          </div>
        </div>
        <details class="card pad"><summary class="muted">Raw record</summary><pre style="white-space:pre-wrap;font-size:11px;max-height:400px;overflow:auto">${esc(JSON.stringify(c.raw, null, 2))}</pre></details>
      </div>
    </div>`;
  app.querySelector('#copy-id').addEventListener('click', () => {
    navigator.clipboard?.writeText(c.id).then(() => toast('Conversation id copied'), () => toast(c.id));
  });
  app.querySelector('#esc-save').addEventListener('click', () => {
    state.escalations[c.id] = {
      source: 'app',
      note: app.querySelector('#esc-note').value.trim(),
      by: app.querySelector('#esc-by').value.trim(),
      at: new Date().toISOString(),
    };
    saveEscalations();
    runAudit(state.convs, state.escalations);
    toast('Saved as a support escalation');
    renderDetail(id);
  });
  app.querySelector('#esc-remove')?.addEventListener('click', () => {
    delete state.escalations[c.id];
    saveEscalations();
    runAudit(state.convs, state.escalations);
    toast('Escalation removed');
    renderDetail(id);
  });
  window.scrollTo(0, 0);
}

function turnNote(t) {
  if (!t) return '';
  const tools = t.tools.filter((x) => x.tool).map((x) => `${x.tool}${x.intent ? `:${x.intent}` : ''}${x.result ? ` (${x.result})` : ''}`);
  const cls = t.score === null ? '' : t.score <= THRESHOLDS.lowScore ? 'bad' : t.score >= 4 ? 'ok' : '';
  return `<div class="turn-note ${cls}"><b>Turn ${esc(t.no)}${t.score !== null ? ` · ${t.score}/5` : ''}</b>${t.replyType ? ` · ${esc(label(t.replyType))}` : ''}${tools.length ? ` · ${esc(tools.join(', '))}` : ''}${t.tags.length ? ` · ${esc(t.tags.join(', '))}` : ''}${t.whatWentWrong ? `<br>${esc(t.whatWentWrong)}` : ''}</div>`;
}

function transcriptHTML(c) {
  if (!c.messages.length && !c.humanMessages?.length) return '<p class="muted">No transcript.</p>';
  let html = '';
  let pending = null;
  const used = new Set();
  c.messages.forEach((m, i) => {
    if (m.speaker === 'User') {
      if (pending) html += turnNote(pending);
      const t = turnForUserMessage(c, i);
      pending = t && !used.has(t) ? t : null;
      if (pending) used.add(pending);
    }
    const who = m.speaker === 'Bot' ? 'Apna Expert' : m.speaker === 'User' ? 'Employer' : 'Support agent';
    html += `<div class="msg ${esc(m.speaker)}"><div class="who">${who}</div>${esc(m.text)}</div>`;
  });
  if (pending) html += turnNote(pending);
  if (c.humanMessages?.length) {
    html += `<div class="transcript-divider"><b>Human support conversation</b>${c.handoffAgentName ? ` · ${esc(c.handoffAgentName)}` : ''}${c.handoffPhase ? ` · ${esc(label(c.handoffPhase))}` : ''}</div>`;
    c.humanMessages.forEach((m) => {
      const who = m.speaker === 'Agent' ? (m.name || 'Support agent') : 'Employer';
      const timestamp = fmtMessageTimestamp(m.at);
      html += `<div class="msg ${esc(m.speaker)}"><div class="who">${esc(who)}${timestamp ? ` · ${esc(timestamp)}` : ''}</div>${esc(m.text)}</div>`;
    });
  }
  return html;
}

function checksHTML(c) {
  const entries = Object.entries(c.checks || {});
  if (!entries.length) return '';
  const chip = (r) => r === 'pass' ? '<span class="chip good">✓ pass</span>' : r === 'fail' ? '<span class="chip alert">✗ fail</span>' : '<span class="chip">n/a</span>';
  return `<div class="card pad"><h3>Evaluator checks</h3><table class="checks">${entries.map(([k, v]) => `
    <tr><td>${chip(v && v.result)}</td><td>${esc(label(k))}${v && v.evidence ? `<br><span class="muted small">${esc(v.evidence)}</span>` : ''}</td></tr>`).join('')}</table></div>`;
}

function renderRules() {
  app.innerHTML = `
    <div class="card pad rules">
      <h2>How the audit queues work</h2>
      <p class="muted">Rules follow the AI Chatbot Audit &amp; Quality Assurance proposal. Thresholds and keyword lists live in <code>js/config.js</code>.</p>
      <dl>${CATEGORIES.map((c) => `<dt>${esc(c.name)}</dt><dd><b>Rule:</b> ${esc(c.rule)}<br><b>What to check:</b> ${esc(c.objective)}</dd>`).join('')}</dl>
      <h2 style="margin-top:24px">Numbers on the overview</h2>
      <dl>
        <dt>Engaged chats</dt><dd>Chats where the employer sent at least one message.</dd>
        <dt>Avg conversation time</dt><dd>Average BlueMachines interaction duration for chats where a duration is available.</dd>
        <dt>Contained by the bot</dt><dd>Engaged chats with no handoff (no agent_handoff call, connect line, support-hours line or agent message).</dd>
        <dt>Human support chats</dt><dd>Chats with a populated BlueMachines human handoff or a recorded support-agent message, split by final handoff status.</dd>
        <dt>Employer said resolved</dt><dd>Of chats where the bot asked "Did this resolve your query?" and the employer answered yes or no, the share whose last answer was yes.</dd>
        <dt>Avg bot score</dt><dd>100 × sum of the evaluator's turn scores ÷ (5 × number of turns), averaged over evaluated chats.</dd>
        <dt>Avg helpfulness</dt><dd>The evaluator's 0 to 10 helpfulness rating, averaged.</dd>
        <dt>CSAT yes</dt><dd>Share of yes answers to the post-chat feedback question, when it was asked.</dd>
      </dl>
      <h2 style="margin-top:24px">Your escalations</h2>
      <p class="muted">${Object.keys(state.escalations).length} chats marked or imported in this browser.</p>
      <div class="row-actions">
        <button class="btn" id="esc-export" ${Object.keys(state.escalations).length ? '' : 'disabled'}>Download escalations CSV</button>
        <button class="btn" id="esc-import">Import escalations CSV</button>
        <button class="btn danger" id="esc-clear" ${Object.keys(state.escalations).length ? '' : 'disabled'}>Clear saved escalations</button>
      </div>
    </div>`;
  app.querySelector('#esc-export').addEventListener('click', () => {
    exportEscalations();
  });
  app.querySelector('#esc-import').addEventListener('click', () => document.getElementById('esc-input').click());
  app.querySelector('#esc-clear').addEventListener('click', () => {
    if (!confirm('Remove all saved and imported escalations from this browser?')) return;
    state.escalations = {};
    localStorage.removeItem(ESC_KEY);
    localStorage.removeItem(LEGACY_ESC_KEY);
    runAudit(state.convs, state.escalations);
    toast('All saved escalations cleared');
    renderRules();
  });
}

// ---------- routing ----------

function route() {
  const hash = location.hash || '#/';
  const [path, query] = hash.slice(1).split('?');
  const params = new URLSearchParams(query || '');
  document.querySelectorAll('.nav a').forEach((a) => {
    const target = a.getAttribute('href').slice(1);
    a.classList.toggle('active', target === '/' ? path === '/' || path === '' : path.startsWith(target));
  });
  if (path.startsWith('/rules')) return renderRules();
  if (!state.convs.length) return renderUpload();
  if (path.startsWith('/transcripts/c/')) return renderTranscriptDetail(decodeURIComponent(path.slice('/transcripts/c/'.length)));
  if (path.startsWith('/transcripts')) return renderTranscriptList();
  if (path.startsWith('/c/')) return renderDetail(decodeURIComponent(path.slice(3)));
  if (path.startsWith('/list')) return renderList(params);
  return renderOverview();
}

// ---------- wiring ----------

document.getElementById('file-input').addEventListener('change', (e) => { loadFiles(e.target.files); e.target.value = ''; });
document.getElementById('esc-input').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const n = importEscalations(await f.text(), f.name);
    runAudit(state.convs, state.escalations);
    toast(`${n} escalations imported`);
  } catch (error) {
    toast(`Could not import ${f.name}: ${error.message}`);
  }
  e.target.value = '';
  route();
});
document.getElementById('btn-upload').addEventListener('click', () => document.getElementById('file-input').click());
document.getElementById('btn-clear').addEventListener('click', () => {
  if (!confirm('Remove the loaded chats from this tab? Escalation notes stay.')) return;
  state.convs = [];
  state.files = [];
  updateStatus();
  location.hash = '#/';
  route();
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', (e) => { e.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if (e.dataTransfer?.files?.length) loadFiles(e.dataTransfer.files);
});
window.addEventListener('hashchange', route);
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (document.getElementById('daily')) renderOverviewBody(); }, 200);
});

updateStatus();
route();

// Local testing only: http://localhost:8000/?file=sample.json loads that file on start
if (['localhost', '127.0.0.1'].includes(location.hostname)) {
  const f = new URLSearchParams(location.search).get('file');
  if (f) fetch(f).then((r) => r.text()).then((t) => loadText(t, f)).catch((e) => toast(`Could not load ${f}: ${e.message}`));
}
