// Apna Expert Audit: every threshold, keyword list and fixed bot line the rules use.
// Edit here to tune the audit queues; nothing else needs to change.

export const THRESHOLDS = {
  // Repetitive Answers & Loops: two consecutive bot replies at least this similar (0 to 1)
  loopSimilarity: 0.85,
  // Early Drop-off: employer left after at least this many bot replies (welcome message not counted)
  earlyDropMinBotReplies: 3,
  // High-Volume Abandonment: employer sent MORE than this many messages
  highVolumeUserMessages: 5,
  // Eval Bot Flagged: any turn scored at or below this (1 to 5), or the chat score at or below it
  lowScore: 2,
  // Language check: long enough employer messages and distinct Hindi words in a bot reply
  languageMinEmployerWords: 3,
  languageMinBotHindiWords: 2,
};

export const SUPPORT_HOURS_IST = { start: '09:00', end: '19:00' };

// Conversations whose id matches one of these are internal tests (hidden by default)
export const TEST_CONVERSATION_PATTERNS = [/^bm_dummy/i, /^test/i];

// Apna employer IDs used by internal team members. During import, phone numbers
// belonging to these IDs are also treated as tests without storing those numbers here.
export const TEST_USER_IDS = new Set([
  '58278958', '55831297', '65906147', '18131429', '57999454', '33840438',
  '65951096', '62964442', '39317100', '11532763', '47951860', '10407313',
  '22717143', '64661331', '53980663', '62203798', '66296336', '58106048', '66202126',
]);

// Frustration & Negative Sentiment: words or phrases in the EMPLOYER's messages.
// Single words match whole words only; phrases match anywhere. Case does not matter.
export const FRUSTRATION_TERMS = [
  // English
  'useless', 'frustrating', 'frustrated', 'terrible', 'stupid', 'bad bot', 'worst', 'pathetic',
  'rubbish', 'nonsense', 'ridiculous', 'horrible', 'disgusting', 'waste of time', 'wasting my time',
  'not helpful', /\bno help\b(?!\s+(?:required|needed))/i, 'idiot', 'dumb', 'fed up', 'irritating', 'annoying', 'hate', 'wtf',
  'third class', 'harassment', 'harassing', 'mental torture', 'mental agony', 'blackmail',
  'fraud', 'fraudulent', 'scam', 'scammer', 'cheat', 'cheating', 'fake company', 'stole my money',
  'consumer court', 'legal notice', 'legal action', 'lawyer', 'police complaint', 'cyber cell',
  'bad review', '1 star', 'playstore review', 'on twitter', 'tweet', 'linkedin post', 'on linkedin',
  'social media pe', 'social media par', 'social media complaint', 'going public', 'viral',
  // Hinglish
  'bakwas', 'bekar', 'bekaar', 'faltu', 'ghatiya', 'chutiya', 'pagal', 'bewakoof', 'dhokha',
  'dhokebaaz', 'chor', 'loot', 'loot liya', 'gandha', 'fraudiye', 'samajh nahi aa raha',
  'kuch nahi ho raha', 'time waste', 'paisa waste', 'case karunga', 'police mein complaint',
];

// Human Agent Requests: words or phrases in the EMPLOYER's messages asking for a person.
export const AGENT_REQUEST_TERMS = [
  'human', 'real person', 'live person', 'speak to someone', 'talk to someone', 'speak with someone',
  'talk to a person', 'customer care', 'customer support', 'support team', 'call me', 'callback',
  'call back', 'connect me', 'insaan', 'kisi se baat', 'baat karni hai', 'baat karao', 'baat karwao',
  'call karo', 'call kijiye', 'call karna',
  // "agent", but not a job title such as "delivery agent" or "sales agent"
  /(?<!\b(?:delivery|sales|field|insurance|travel|collection|recovery|booking|leasing|placement|estate|service|centre|center|marketing|ticketing|courier|loan|bank)\s)\bagents?\b/i,
];

// Fixed bot lines (English and the approved Hinglish versions), used to read the transcript.
export const BOT_LINES = {
  welcome: /welcome to apna support/i,
  resolveQuestion: /did this resolve your query|kya (isse|is se) aapki query (solve|resolve)/i,
  closing: /thank you for choosing apna|apna chunne ke liye dhanyavaad/i,
  salesAnswer: /thank you! our sales team will reach out to you within 24 hours|your request is already with our sales team/i,
  supportEmail: /employersupport@apna\.co/i,
  hold: /support team will join this chat shortly|support team jald hi is chat/i,
  // A connection is happening now. Offers ("I can connect", "Would you like") are not connect lines.
  handoff: new RegExp(`^(?![\\s\\S]*\\?\\s*$)[\\s\\S]*(?:${[
    'let me connect you (with|to) our (human agent|support team|support agent)',
    "i(?:'ll| will) connect you (with|to) our (human agent|support team|support agent)",
    'connecting you to our support team',
    'while i connect you',
    'support team will join this chat',
    'support team jald hi',
    'support agent se connect kiya ja raha hai',
    'support team se connect kiya ja raha hai',
  ].join('|')})`, 'i'),
  supportClosed: /chat support team is available from|currently offline|abhi offline hai|subah 9:00 am se shaam 7:00 pm/i,
  // BlueMachines' automatic message after a human agent hands the chat back (not written by the bot)
  handback: /hope the support team has resolved your queries/i,
  // Lines the bot is allowed to repeat (never a loop)
  holdLong: /taking longer than usual to join|judne mein usual se zyada samay/i,
  handoffFailed: /couldn't connect you to our support team right now|connect nahi kiya ja saka/i,
  // The Sales Team question ends a reply that offers Sales help; a yes to it must create a lead
  salesOffer: /connect you with our sales team|sales team se (connect|baat)/i,
  // "Which plan should I take" answer: the lead is created in the same turn
  whichPlan: /the right plan depends on your hiring needs/i,
};

// An employer's agreement to the Sales Team question
export const SALES_YES = /^\s*(yes|yeah|yep|yup|haan|han|ha|haa|ji|ji haan|ok|okay|okk|sure|please|go ahead|theek hai|thik hai|call me)\b/i;

// An employer message that is only an attachment marker
export const ATTACHMENT_ONLY = /^\s*(?:\[attached (?:image|file)[^\]]*\]\s*)+$/i;

// Employer replies to "Did this resolve your query?"
export const ANSWER_YES = /^\s*(yes|yeah|yep|haan|han|ha|haa|ji|ji haan|ok|okay|okk|k|sure|got it|thanks|thank you|thankyou|thx|resolved|done|solved|nothing|nothing else|no help required|no help needed|no more help|no need|ho gaya|hogaya|theek hai|thik hai|sahi hai)\b/i;
export const ANSWER_NO = /^\s*(?!(?:no help required|no help needed|no more help|no need)\b)(no|nope|nahi|nahin|nhi|nai|ni|na|not really|not resolved|still not|abhi bhi nahi|nahi hua|nhi hua)\b/i;

export const ACKNOWLEDGEMENT = /^\s*(ok|okay|okk|k|sure|thanks|thank you|thankyou|thx|got it|nothing|nothing else)\b/i;
export const NO_REPLY_AFTER_CLOSING = /^\s*(ok|okay|okk|k|ko|thanks|thank you|thankyou|thx|bye|bye bye|yes|no|no thanks|done|nothing|nothing else|no help required|no more help|can you close|theek hai|thik hai|shukriya|dhanyavaad|ji)[.!]*\s*$/i;
export const EMOJI_ONLY = /^\s*(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\uFE0F|\u200D)+\s*$/u;
export const GREETING_ONLY = /^\s*(hi|hai|hii)\s*[!.]*\s*$/i;

// Words that make an EMPLOYER message Hinglish (same list as the bot prompt's LANGUAGE rule).
// Short words that also appear in English typos and names (h, ho, se, ka, ke, ki, ko, ji, bhi,
// ye, to, na, bhai, acha, thik) never decide it on their own, so they are not here.
export const EMPLOYER_HINDI_WORDS = [
  'nhi', 'nahi', 'nai', 'hai', 'kya', 'kyu', 'kaise', 'kab', 'kitna', 'kitne', 'mera', 'meri',
  'mujhe', 'aap', 'karo', 'kro', 'kar', 'karna', 'btao', 'batao', 'hua', 'hoga', 'rha', 'rahe',
  'abhi', 'jaldi', 'kuch', 'koi', 'chahiye',
  // common spellings of the same words
  'nahin', 'hain', 'kyun', 'kyon', 'kese', 'kaisa', 'kaha', 'kahan', 'kitni', 'mere', 'mujko', 'humko',
  'kare', 'karu', 'karun', 'krna', 'krni', 'karni', 'karke', 'gaya', 'gayi', 'hogi', 'raha', 'rahi',
  'tha', 'thi', 'wala', 'wali', 'wale', 'bhejo', 'dikhao', 'dikh', 'chahte', 'sakta', 'sakte', 'paisa', 'paise',
];

// Words that show a BOT reply is in Hinglish (two or more distinct ones needed)
export const BOT_HINDI_WORDS = [
  ...EMPLOYER_HINDI_WORDS, 'aapka', 'aapke', 'aapko', 'aapki', 'karein', 'kijiye', 'kholiye', 'mein',
  'liye', 'baare', 'batayein', 'hamari', 'hamare', 'apni', 'apne', 'par', 'jaakar', 'baad', 'yeh', 'woh',
  'aur', 'ya', 'kripya', 'dhanyavaad', 'shukriya', 'sakti', 'ho', 'se', 'ka', 'ke', 'ki', 'ko',
];

// Evaluator tags that mean the bot repeated itself or looped
export const LOOP_TAGS = ['REPEATED_ANSWER', 'WHICH_JOB_LOOP', 'SUPPORT_OFFER_REPEATED'];

// The 9 audit categories (names and objectives from the audit proposal)
export const CATEGORIES = [
  {
    key: 'eval_flagged',
    name: 'Eval Bot Flagged',
    rule: `The evaluation bot set flag_for_review, or scored the chat or any turn ${THRESHOLDS.lowScore} or lower out of 5.`,
    objective: 'Validate system-level anomalies, factual accuracy errors and low-confidence responses.',
  },
  {
    key: 'frustration',
    name: 'Frustration & Negative Sentiment',
    rule: 'The employer used a frustration, abuse, legal or social-media word, typed "!!" or wrote in all caps, or the evaluator rated their sentiment at the end as negative.',
    objective: 'Identify customer pain points, tone issues and breakdowns in user experience.',
  },
  {
    key: 'loop',
    name: 'Repetitive Answers & Loops',
    rule: `Two consecutive bot replies are near-identical (similarity ${Math.round(THRESHOLDS.loopSimilarity * 100)}% or more), or the evaluator tagged a repeat or loop.`,
    objective: 'Catch dead ends where the bot fails to progress or recognise that it is stuck.',
  },
  {
    key: 'agent_request',
    name: 'Human Agent Requests',
    rule: 'The employer asked for a human, agent, call or support team. Checked: did the very next bot reply hand off?',
    objective: 'Ensure the bot recognises escalation requests immediately without forcing more conversation.',
  },
  {
    key: 'unresolved',
    name: 'Unresolved Queries (Resolve = No)',
    rule: 'The employer answered no to "Did this resolve your query?", gave a negative CSAT, or the evaluator marked the chat unresolved. Checked: was it passed to support?',
    objective: 'Check handoff integrity: was the unresolved query passed to a support agent?',
  },
  {
    key: 'early_drop',
    name: 'Early Drop-off',
    rule: `The employer left after ${THRESHOLDS.earlyDropMinBotReplies} or more bot replies (and ${THRESHOLDS.highVolumeUserMessages} or fewer messages of their own), with no resolution and no handoff.`,
    objective: 'Evaluate whether the first answers were too long, irrelevant or unhelpful.',
  },
  {
    key: 'high_volume',
    name: 'High-Volume Abandonment',
    rule: `The employer sent more than ${THRESHOLDS.highVolumeUserMessages} messages and the chat ended with no resolution and no handoff.`,
    objective: 'Find complex, multi-turn queries where the bot failed to give a clear solution.',
  },
  {
    key: 'support_escalation',
    name: 'Support Team Escalations',
    rule: 'Marked in this app by a support agent or lead, or listed in an uploaded escalations CSV (a conversation_id column).',
    objective: 'Capture downstream issues reported by the support team (missing context, misrouted chats).',
  },
  {
    key: 'flow_checks',
    name: 'Chat Flow & Handoff Checks',
    rule: 'Checks missing replies, incomplete or fake handoffs, premature closing, English/Hinglish reply mismatches, short replies ("ok", "ye", "?", an attachment) that switched the chat\'s language, and Sales leads missing after "which plan should I take" or a yes to the Sales Team question.',
    objective: 'Catch broken conversation flow and handoff behaviour that other outcome-based queues miss.',
  },
];
