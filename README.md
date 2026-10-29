# Apna Expert Audit

A small web app for the support team to audit Apna Expert (support bot) chats from a MongoDB export of the `supportPostChat` collection, until the analytics tables are ready.

- Drop a MongoDB export (JSON/NDJSON) or a transcripts CSV downloaded from BlueMachines and it shows 9 audit queues, headline numbers, and every chat with its transcript and the evaluator's turn-by-turn notes.
- The **Transcript generator** tab lists every loaded chat with user/conversation filters, handoff and CSAT filters, sorting, a formatted transcript view, and individual or bulk plain-text downloads.
- **Data never leaves the browser.** Files are read locally. Nothing is uploaded or stored on a server, so the Vercel deployment holds no chat data. Refreshing the tab clears the loaded chats.
- No build step, no dependencies: plain HTML, CSS and JavaScript modules.

## Deploy to Vercel

**Option A: from GitHub (recommended)**
1. Create a GitHub repo and push this folder (from Cursor: *Source Control → Publish to GitHub*).
2. In Vercel: *Add New → Project → Import* the repo.
3. Framework preset: **Other**. Leave Build Command and Install Command empty. Output Directory: `.` (the root).
4. Deploy. Every push to `main` redeploys.

**Option B: from your machine**
```bash
npm i -g vercel
cd apna-expert-audit
vercel          # first time: link or create the project (preview URL)
vercel --prod   # production URL to share
```

`vercel.json` sets security headers: no outside scripts or connections, no indexing by search engines, and the page cannot be framed.

**Who can open it:** the app holds no data, so a public link exposes no chats. If you still want only your team to open it, turn on *Deployment Protection* in the Vercel project settings (what is available depends on your Vercel plan).

## Run it locally

Any static server works; ES modules do not load from `file://`.
```bash
cd apna-expert-audit
python3 -m http.server 8000      # or: npx serve .
```
Open http://localhost:8000. For quick testing, `http://localhost:8000/?file=my-export.json` loads a file placed in this folder on start (this only works on localhost). Do not commit export files: `.gitignore` excludes `*.json` exports and CSVs.

Check the rules against an export from the command line (Node 18+):
```bash
node test/check.mjs path/to/supportPostChat.json
```

## Getting the data out of MongoDB

- **Compass:** open `supportPostChat`, filter if needed (for example `{ createdAt: { $gte: ISODate("2026-10-14") } }`), then *Export Data → Export the full collection* (or the query results) *→ JSON*.
- **Command line:**
  ```bash
  mongoexport --uri "<connection string>" --collection supportPostChat --jsonArray --out chats.json
  ```

The app reads a JSON array, one document per line, or a single document, with Mongo extended JSON (`$oid`, `$date`). It also reads the transcripts CSV downloaded directly from BlueMachines, including its embedded evaluation JSON, bot transcript, human-support transcript and handoff status. Several files can be added; chats are merged by conversation id (the evaluated record wins, then the newest). Other CSV files are treated as support-escalation lists.

It understands both record shapes in the collection:
1. **Raw post-chat records** (`payload.agentInteractionData.transcript`, `eval` / `payload.eval` with `turn_by_turn`), including older ones with no evaluation.
2. **Flattened rows** written from 14 Oct 2026 (`conversation_id`, `chat_date_ist`, `turns`, `transcript_json`, `metadata`, …).

## The audit queues

| Queue | Rule in this app | What the auditor checks |
|---|---|---|
| Eval Bot Flagged | Evaluator set `flag_for_review`, or the chat or any turn scored 2/5 or lower | System anomalies, factual errors, low-confidence answers |
| Frustration & Negative Sentiment | Employer used a frustration, abuse, legal or social-media word (English or Hinglish), typed `!!`/`???` or all caps, or the evaluator rated end sentiment negative | Pain points, tone, broken experience |
| Repetitive Answers & Loops | Two consecutive bot replies ≥ 85% similar, the closing line is sent twice in succession, or the evaluator reports a loop. Lines the bot may repeat on purpose (waiting for an agent, support closed, handoff failed, the platform's handback message) are not counted | Dead ends where the bot does not progress |
| Human Agent Requests | Employer asked for a human, agent, call or support team. **⚠** when the next reply did not hand off, or only *said* it would connect with no handoff call. A call about plans answered with the Sales lead line is correct (it goes to Sales, not support) | Escalation recognised immediately |
| Unresolved Queries (Resolve = No) | Employer said no to "Did this resolve your query?", CSAT no, or evaluator outcome `unresolved`. A no must hand off in the very next reply | Handoff integrity |
| Early Drop-off | Employer left after ≥ 3 bot replies (welcome not counted) and ≤ 5 messages of their own, last message from the bot, no resolution, no handoff | Answers too long, irrelevant or unhelpful |
| High-Volume Abandonment | Employer sent > 5 messages, no resolution, no handoff | Complex queries the bot could not solve |
| Support Team Escalations | Marked in the app (detail page) or imported from a CSV with a `conversation_id` column (optional `note`, `by`) | Issues reported by the support team |
| Chat Flow & Handoff Checks | Missing replies, handoff calls with no reply, requested handoffs with no agent during support hours, fake connect lines, premature closing, and language: a message with Devanagari or a clear Hindi word should get Hinglish and any other full message English (short words such as "ji" or "h" do not count), a short reply ("ok", "ye", "?", an attachment) keeps the chat's language, "speak in Hindi" or "English please" holds for the rest of the chat, and one reply never mixes both; Sales leads: "which plan should I take" makes the lead in the same turn, and a yes to the Sales Team question makes one unless it was made earlier | Broken flow and operational handoff failures |

"Resolution" means the employer answered the resolve question with yes or an accepted equivalent (including "nothing", "nothing else", "no help required" or "no more help"), the closing line was sent, or CSAT was yes. A no must be followed by a handoff in the next reply.

Handoff status is **Agent joined** when a support agent wrote or the lifecycle reached `human_active`; **Support closed** for support-hours/offline replies or a closed-hours tool result; **Requested** when `agent_handoff` ran but no agent joined; **Said only** when the bot promised a connection without a real call; otherwise it is **None**. Requested handoffs show the tool result and wait time when available.

All thresholds, keyword lists and fixed bot lines are in **`js/config.js`**.

## Headline numbers

| Number | Definition |
|---|---|
| Engaged chats | Chats where the employer sent at least one message |
| Avg conversation time | Average BlueMachines interaction duration where `durationSeconds` is available |
| Contained by the bot | Engaged chats with no handoff (no `agent_handoff`, connect line, support-hours line or agent message) |
| Human support chats | Chats with a populated human handoff or support-agent message, split into resolved, active, closed-by-user and timed-out |
| Employer said resolved | Of chats where the employer answered the resolve question yes or no, the share whose last answer was yes |
| Avg bot score | 100 × sum of turn scores ÷ (5 × turns), averaged over evaluated chats |
| Avg helpfulness | Evaluator's 0–10 rating, averaged |
| CSAT yes | Share of yes answers to the post-chat feedback question |

## Where things are (for editing in Cursor)

| File | What it does |
|---|---|
| `index.html` | Page shell and top bar |
| `styles.css` | All styling; light and dark mode follow the system setting |
| `js/config.js` | Thresholds, keyword lists, bot line patterns, queue names and rule text |
| `js/data.js` | Reads exports and turns both record shapes into one conversation object |
| `js/audit.js` | The 9 queue rules and the reasons shown for each chat |
| `js/metrics.js` | Headline numbers, daily volume, top intents and failure tags |
| `js/main.js` | Screens (upload, overview, conversations, transcript generator, chat detail, how it works), routing, exports, escalations |
| `js/chart.js` | Daily stacked bar chart (SVG) |
| `js/ui.js` | HTML escaping, CSV helpers, download, toast |
| `test/check.mjs` | Command-line check of the rules against an export |
| `test/rules.mjs` | Synthetic BlueMachines regression tests for handoff and flow rules |

## Known limits

- **Escalations are saved per browser** (localStorage). To share them, use *How it works → Download escalations CSV*, and import that CSV on another machine.
- **Test chats** are hidden when their conversation id matches `TEST_CONVERSATION_PATTERNS`, their Apna employer id is in `TEST_USER_IDS`, or their phone number matches one associated with those test users in the loaded data.
- **When the analytics tables are ready**, replace the file upload with a fetch from the analytics API: `loadText()` in `js/main.js` already takes the raw text of an export, so an API that returns the same documents plugs in there.
