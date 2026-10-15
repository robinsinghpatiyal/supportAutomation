// Run: node test/check.mjs path/to/export.json
// Prints how the app reads the export and how many chats land in each audit queue.
import { readFileSync } from 'node:fs';
import { parseExport, mergeConversations } from '../js/data.js';
import { runAudit } from '../js/audit.js';
import { summarize, daily, topIntents, topTags } from '../js/metrics.js';
import { CATEGORIES } from '../js/config.js';

const file = process.argv[2];
const docs = parseExport(readFileSync(file, 'utf8'));
const { conversations, skipped } = mergeConversations([], docs);
runAudit(conversations, {});
const live = conversations.filter((c) => !c.isTest);
console.log(`records ${docs.length}, conversations ${conversations.length} (tests ${conversations.length - live.length}), skipped ${skipped}`);
console.log('shapes', conversations.reduce((m, c) => ({ ...m, [c.shape]: (m[c.shape] || 0) + 1 }), {}));
const s = summarize(live);
console.log(JSON.stringify({ ...s, categoryCounts: undefined, categoryAlerts: undefined }, (k, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v)));
for (const cat of CATEGORIES) console.log(`${cat.name.padEnd(36)} ${String(s.categoryCounts[cat.key]).padStart(4)}  alerts ${s.categoryAlerts[cat.key]}`);
console.log('daily', daily(live));
console.log('intents', topIntents(live).map((r) => `${r.name}:${r.count}`).join(' | '));
console.log('tags', topTags(live).map((r) => `${r.name}:${r.count}`).join(' | '));
const show = (key, n = 3) => {
  console.log(`\n--- ${key}`);
  live.filter((c) => c.audit[key]).slice(0, n).forEach((c) => console.log(c.id, c.dateIST, c.timeIST, '|', c.audit[key].reasons.join(' / '), c.audit[key].alert ? `[ALERT ${c.audit[key].alert}]` : ''));
};
for (const cat of CATEGORIES) show(cat.key);
