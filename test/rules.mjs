import assert from 'node:assert/strict';
import { parseBlueMachinesExport, mergeConversations } from '../js/data.js';
import { runAudit } from '../js/audit.js';
import { ANSWER_NO, TEST_USER_IDS } from '../js/config.js';
import { agentSummary, csatCounts, csatDaily } from '../js/agents.js';

const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
let sequence = 0;

function toolBlock(output, latencyMs = 100000) {
  const details = { 'Tool name': 'agent_handoff', 'Tool input': '{}' };
  if (output !== undefined) details.Output = output;
  return `[Tool: agent_handoff]\n${JSON.stringify({ details, metrics: [`Latency: ${latencyMs}ms`] })}`;
}

function queryBlock(intent, text, output = '{}') {
  const details = { 'Tool name': 'apna_chat_query', 'Tool input': JSON.stringify([{ body: { intent, message: { text } } }]), Output: output };
  return `[Tool: apna_chat_query]\n${JSON.stringify({ details, metrics: ['Latency: 300ms'] })}`;
}

function transcript(parts, variables = {}) {
  const inputVariables = JSON.stringify(variables);
  return [
    '=== TRANSCRIPT ===',
    '[Variables]',
    JSON.stringify({ details: { 'Input Variables': inputVariables } }),
    ...parts,
  ].join('\n');
}

function exportRecords({
  parts, humanTranscript = '', variables = {}, externalUserId = '9000000000',
  agentName = 'Apna Expert', interactionEnvironment = 'LIVE', evaluationTurns = null,
  interactionDate = '2026-10-15T06:00:00.000Z', handoffAgentName = '', id = null,
}) {
  sequence++;
  const headers = [
    'conversationId', 'interactionDate', 'userDisplayName', 'externalUserId',
    'agentName', 'interactionEnvironment', 'callAnalysisStatus', 'humanTranscript', 'transcript',
    'evaluation.eval_version', 'evaluation.turn_by_turn', 'handoffAgentName',
  ];
  const row = [
    id || `synthetic-${sequence}`, interactionDate, 'Synthetic employer', externalUserId,
    agentName, interactionEnvironment, evaluationTurns ? 'OK' : 'PENDING', humanTranscript, transcript(parts, variables),
    evaluationTurns ? 'synthetic-v1' : '', evaluationTurns ? JSON.stringify(evaluationTurns) : '', handoffAgentName,
  ];
  const csv = `${headers.map(csvCell).join(',')}\n${row.map(csvCell).join(',')}\n`;
  return parseBlueMachinesExport(csv);
}

function makeChat(options) {
  const { conversations } = mergeConversations([], exportRecords(options));
  runAudit(conversations);
  return conversations[0];
}

const noOutput = makeChat({
  parts: ['User: I need a human agent', toolBlock(undefined, 100000)],
});
assert.equal(noOutput.handoffStatus, 'requested');
assert.match(noOutput.handoffDetail, /No result/i);
assert.equal(noOutput.handoffWaitSeconds, 100);
assert.equal(noOutput.audit.flow_checks.alert, 'No reply after the handoff call');

const supportOffer = makeChat({
  parts: [
    'User: I need help with my account',
    'AI agent: If you prefer, I can connect you with our support team instead. Would you like that?',
  ],
});
assert.equal(supportOffer.handoffStatus, 'none');
assert.doesNotMatch(supportOffer.audit.flow_checks?.reasons.join(' ') || '', /Connect line without a real handoff/);

const unreachable = makeChat({
  parts: ['User: connect me to support', toolBlock('Human support could not be reached.')],
});
assert.equal(unreachable.handoffStatus, 'requested');
assert.equal(unreachable.handoffDetail, 'Support could not be reached');

const closed = makeChat({
  parts: ['User: connect me to support', toolBlock('Human support is closed right now and reopens at 9:00 AM')],
});
assert.equal(closed.handoffStatus, 'support_closed');

const joined = makeChat({
  parts: ['User: connect me to support', toolBlock('Request sent')],
  humanTranscript: [
    '[2026-10-15T06:01:00.000Z] agent_handoff.requested',
    '[2026-10-15T06:01:02.000Z] agent_handoff.human_active',
    '[2026-10-15T06:01:03.000Z] Priya (Agent): Hello, how can I help?',
  ].join('\n'),
});
assert.equal(joined.handoffStatus, 'agent_joined');

const testId = [...TEST_USER_IDS][0];
const internal = makeChat({
  parts: ['User: hello', 'AI agent: Hello!'],
  variables: { apnaEmployerId: testId, employerId: 'employer-synthetic', apnaSupportPage: 'help' },
  externalUserId: '9111111111',
});
assert.equal(internal.apnaEmployerId, testId);
assert.equal(internal.phoneNumber, '9111111111');
assert.equal(internal.isTest, true);

const testAgent = makeChat({
  parts: ['User: hello', 'AI agent: Hello!'],
  agentName: '[TEST ]Apna Expert Copy',
});
assert.equal(testAgent.isTest, true);

const nonLive = makeChat({
  parts: ['User: hello', 'AI agent: Hello!'],
  interactionEnvironment: 'STAGING',
});
assert.equal(nonLive.isTest, true);

const noThenQuestion = makeChat({
  parts: [
    'AI agent: Did this resolve your query?',
    'User: no',
    'User: I still need help with my job post',
  ],
});
assert.equal(noThenQuestion.audit.unresolved.alert, 'No reply to the no');
assert.match(noThenQuestion.audit.flow_checks.reasons.join(' '), /No reply/);

const laterRefundHandoff = makeChat({
  parts: [
    'AI agent: Did this resolve your query?',
    'User: no',
    'User: What are database credits?',
    'AI agent: Database credits let you unlock candidate profiles.',
    'User: I want a refund of my credits',
    toolBlock(undefined, 100000),
  ],
});
assert.equal(laterRefundHandoff.audit.unresolved.alert, 'No reply to the no');
assert.match(laterRefundHandoff.audit.unresolved.reasons.join(' '), /No reply to the no/);
assert.doesNotMatch(laterRefundHandoff.audit.unresolved.reasons.join(' '), /Passed to support/);

const rawCallOverridesEvaluator = makeChat({
  parts: [
    'AI agent: Did this resolve your query?',
    'User: no',
    'User: What are database credits?',
    'AI agent: Database credits let you unlock candidate profiles.',
    'User: I want a refund of my credits',
    toolBlock(undefined, 100000),
  ],
  evaluationTurns: [
    { turn: 1, user_input: 'no', bot_output: null, tool_calls: [{ tool: 'agent_handoff' }] },
    { turn: 2, user_input: 'What are database credits?', bot_output: 'Database credits let you unlock candidate profiles.', tool_calls: [] },
    { turn: 3, user_input: 'I want a refund of my credits', bot_output: null, tool_calls: [{ tool: 'agent_handoff' }] },
  ],
});
assert.equal(rawCallOverridesEvaluator.audit.unresolved.alert, 'No reply to the no');
assert.doesNotMatch(rawCallOverridesEvaluator.audit.unresolved.reasons.join(' '), /Passed to support/);
assert.equal(rawCallOverridesEvaluator.audit.flow_checks.reasons
  .filter((reason) => reason.startsWith('No reply after the handoff call')).length, 1);

const acceptedAfterClosing = makeChat({
  parts: [
    'AI agent: Thank you for choosing Apna! Have a great day.',
    'User: no help required',
  ],
});
assert.equal(ANSWER_NO.test('no help required'), false);
assert.equal(acceptedAfterClosing.audit.frustration, undefined);
assert.equal(acceptedAfterClosing.audit.flow_checks, undefined);
assert.equal(acceptedAfterClosing.resolveAnswers.some((answer) => answer.answer === 'no'), false);

const acknowledgementsAfterClosing = makeChat({
  parts: [
    'AI agent: Thank you for choosing Apna! Have a great day.',
    'User: ok',
    'User: thanks',
  ],
});
assert.doesNotMatch(acknowledgementsAfterClosing.audit.flow_checks?.reasons.join(' ') || '', /No reply/);

const duplicateClosing = makeChat({
  parts: [
    'AI agent: Thank you for choosing Apna! Have a great day.',
    'User: nothing else',
    'AI agent: Thank you for choosing Apna! Have a great day.',
    'User: nothing else',
    'AI agent: Thank you for choosing Apna! Have a great day.',
  ],
});
assert.match(duplicateClosing.audit.loop.reasons.join(' '), /Closing line sent again/);
assert.match(duplicateClosing.audit.loop.reasons.join(' '), /\(x2\)/);
assert.doesNotMatch(duplicateClosing.audit.flow_checks?.reasons.join(' ') || '', /Closed without asking/);

const closedWithoutAsking = makeChat({
  parts: [
    'User: How do I post a job?',
    'AI agent: Open the Jobs tab and select Post a Job.',
    'User: ok',
    'AI agent: Thank you for choosing Apna! Have a great day.',
  ],
});
assert.match(closedWithoutAsking.audit.flow_checks.reasons.join(' '), /Closed without asking/);

const languageMismatch = makeChat({
  parts: [
    'User: Cen you active me job post',
    'AI agent: Aap kis job ke baare mein jaanna chahte hain? Please job ka title batayein.',
  ],
});
assert.match(languageMismatch.audit.flow_checks.reasons.join(' '), /English message answered in Hinglish/);

// Short words such as "ji" or "h" do not make a message Hinglish
const tinyHindiWord = makeChat({
  parts: [
    'User: ok ji please check my job',
    'AI agent: Which job would you like me to check? Please share the job title.',
  ],
});
assert.doesNotMatch(tinyHindiWord.audit.flow_checks?.reasons.join(' ') || '', /answered in/);

// Devanagari makes a message Hinglish
const devanagari = makeChat({
  parts: [
    'User: Apna app खोला उसके bad kya karna hai',
    'AI agent: Open your profile and click View Profile.',
  ],
});
assert.match(devanagari.audit.flow_checks.reasons.join(' '), /Hinglish message answered in English/);

// A short reply keeps the language of the previous bot reply
const shortSwitch = makeChat({
  parts: [
    'User: why is my job not live',
    'AI agent: Your job is not live yet because a plan has not been selected for it.\n\nDid this resolve your query?',
    'User: ye',
    'AI agent: Apna chunne ke liye dhanyavaad! Aapka din shubh ho. Aur kisi madad ki zarurat ho to batayein.',
  ],
});
assert.match(shortSwitch.audit.flow_checks.reasons.join(' '), /Short reply switched the language to Hinglish/);

// The Hinglish resolve question on its own is Hinglish; an English answer ending with it is mixed
const resolveOnly = makeChat({
  parts: [
    'User: free job post krni h',
    'AI agent: Free job post ki suvidha nahi hai, aap View Plans se plan kharid sakte hain.',
    'User: ok tnkuu',
    'AI agent: Kya isse aapki query solve hui?',
  ],
});
assert.doesNotMatch(resolveOnly.audit.flow_checks?.reasons.join(' ') || '', /Short reply|answered in/);
const mixed = makeChat({
  parts: [
    'User: can we post work from home jobs on the monthly plan',
    'AI agent: Work From Home jobs are not supported on apna Unlimited.\n\nKya isse aapki query solve hui?',
  ],
});
assert.match(mixed.audit.flow_checks.reasons.join(' '), /mixed in one reply/);

// After "please speak in hindi", replies stay in Hinglish
const hindiRequested = makeChat({
  parts: [
    'User: please speak in hindi',
    'AI agent: Zaroor! Bataiye, aaj main aapki kya madad karun?',
    'User: why is my job not live',
    'AI agent: Aapki job abhi live nahi hai kyunki plan select nahi hua hai.',
  ],
});
assert.doesNotMatch(hindiRequested.audit.flow_checks?.reasons.join(' ') || '', /answered in/);

// BlueMachines' handback message is not graded as a bot reply
const handback = makeChat({
  parts: [
    'User: Sir ji mere se buy mistek premium job post ho gai hai',
    'AI agent: Hope the support team has resolved your queries. I can continue to help you from here',
  ],
});
assert.doesNotMatch(handback.audit.flow_checks?.reasons.join(' ') || '', /answered in/);

// A call about plans that gets a Sales lead is not a missed handoff
const salesCall = makeChat({
  parts: [
    'User: please call me about the plans',
    'AI agent: Thank you! Our sales team will reach out to you within 24 hours.',
  ],
});
assert.match(salesCall.audit.agent_request.reasons.join(' '), /Sent to the Sales team/);
assert.equal(salesCall.audit.agent_request.alert, null);

// The failed-handoff line may repeat without counting as a loop
const failedTwice = makeChat({
  parts: [
    'User: connect me to an agent',
    toolBlock('Human support could not be reached', 1000),
    "AI agent: Sorry, I couldn't connect you to our support team right now. Please email us at employersupport@apna.co and the team will get back to you.",
    'User: connect me to an agent please',
    toolBlock('Human support could not be reached', 1000),
    "AI agent: Sorry, I couldn't connect you to our support team right now. Please email us at employersupport@apna.co and the team will get back to you.",
  ],
});
assert.equal(failedTwice.audit.loop, undefined);

// "Which plan should I take" must make the Sales lead in the same turn
const PLAN_ANSWER = 'AI agent: The right plan depends on your hiring needs.\n\nIf you hire regularly, our apna Unlimited subscription is a good fit.\n\nWould you like me to connect you with our Sales Team to find the best plan for your requirement?';
const whichPlanNoLead = makeChat({
  parts: ['User: which plan should I take', queryBlock('GET_CREDITS', 'which plan should I take'), PLAN_ANSWER],
});
assert.match(whichPlanNoLead.audit.flow_checks.reasons.join(' '), /Which-plan answer with no Sales lead/);
assert.equal(whichPlanNoLead.audit.flow_checks.alert, 'Sales lead missing');
const whichPlanLead = makeChat({
  parts: ['User: which plan should I take', queryBlock('CREATE_LEAD', 'which plan should I take'), PLAN_ANSWER],
});
assert.doesNotMatch(whichPlanLead.audit.flow_checks?.reasons.join(' ') || '', /Sales lead/);

// A yes to the Sales Team question needs a lead, unless one was made earlier in the chat
const yesNoLead = makeChat({
  parts: [
    'User: how many credits do I have',
    queryBlock('GET_CREDITS', 'how many credits do I have'),
    'AI agent: You have 0 job posting credits and 0 database credits.\n\nYou can buy plans under View Plans on your dashboard. Would you like me to connect you with our Sales Team for custom packages or current discounts?',
    'User: yes',
    'AI agent: Thank you! Our sales team will reach out to you within 24 hours.',
  ],
});
assert.match(yesNoLead.audit.flow_checks.reasons.join(' '), /Yes to the Sales offer, but no lead was created/);
const yesAfterLead = makeChat({
  parts: ['User: which plan should I take', queryBlock('CREATE_LEAD', 'which plan should I take'), PLAN_ANSWER,
    'User: yes', 'AI agent: Thank you! Our sales team will reach out to you within 24 hours.'],
});
assert.doesNotMatch(yesAfterLead.audit.flow_checks?.reasons.join(' ') || '', /Sales lead|no lead/);

// "Dear Apna Support Team," at the start of an email is a greeting, not a request for a person
const emailGreeting = makeChat({
  parts: [
    'User: Dear Apna Support Team,\n\nCould you please confirm whether we can use the remaining Database Credits after the subscription expires?\n\nThank you.',
    'AI agent: Here is when your credits expire:\n- 112 Database Credits on 11 Jan 2027',
  ],
});
assert.equal(emailGreeting.audit.agent_request ?? null, null);
const greetingThenAsk = makeChat({
  parts: [
    'User: Hi support team, please connect me to an agent',
    'AI agent: Here is when your credits expire:\n- 112 Database Credits on 11 Jan 2027',
  ],
});
assert.match(greetingThenAsk.audit.agent_request.reasons.join(' '), /connect me|agent/);

// A review under way for more than 30 minutes must not get the 30-minute answer (chat starts 11:30 AM IST)
const reviewOutput = (since) => JSON.stringify({ intent: 'GET_JOB_STATUS', context: { job: { status: 'under_review', under_review_since: since, verification: { verification_status: 'COMPLETED', pending_steps: [] } } } });
const THIRTY = 'AI agent: Your documents are uploaded and our team is reviewing them. This usually takes around 30 minutes, and your job will go live once verified. No action is needed from you.';
const delayedReview = makeChat({
  parts: ['User: why is my job not live', queryBlock('GET_JOB_STATUS', 'why is my job not live', reviewOutput('15 Oct 2026, 09:00 AM IST')), THIRTY],
});
assert.match(delayedReview.audit.flow_checks.reasons.join(' '), /30-minute answer for a review under way for 2 hours/);
assert.equal(delayedReview.audit.flow_checks.alert, 'Delayed review not handed off');
const freshReview = makeChat({
  parts: ['User: why is my job not live', queryBlock('GET_JOB_STATUS', 'why is my job not live', reviewOutput('15 Oct 2026, 11:10 AM IST')), THIRTY],
});
assert.doesNotMatch(freshReview.audit.flow_checks?.reasons.join(' ') || '', /30-minute answer/);

// Outside support hours (7:50 PM IST) a support offer is flagged; "Did this resolve your query?" and Sales offers are not
const S88 = 'AI agent: The username and password login option is currently available only for Enterprise accounts and is not supported for regular accounts.\n\nTo access this feature, you can upgrade to an Enterprise account with a minimum purchase of ₹10,000.';
const EVENING = '2026-10-15T14:20:00.000Z';
const offerAfterHours = makeChat({
  interactionDate: EVENING,
  parts: ['User: can i login using my mail id', `${S88} Would you like to connect with our support team?`],
});
assert.equal(offerAfterHours.inSupportHours, false);
assert.match(offerAfterHours.audit.flow_checks.reasons.join(' '), /Support offer outside support hours \(chat started 19:50 IST\)/);
assert.equal(offerAfterHours.audit.flow_checks.alert, 'Support offer outside support hours');
const offerInHours = makeChat({
  parts: ['User: can i login using my mail id', `${S88} Would you like to connect with our support team?`],
});
assert.doesNotMatch(offerInHours.audit.flow_checks?.reasons.join(' ') || '', /Support offer outside support hours/);
const resolveAfterHours = makeChat({
  interactionDate: EVENING,
  parts: ['User: can i login using my mail id', `${S88}\n\nDid this resolve your query?`],
});
assert.doesNotMatch(resolveAfterHours.audit.flow_checks?.reasons.join(' ') || '', /Support offer outside support hours/);
const salesAfterHours = makeChat({
  interactionDate: EVENING,
  parts: ['User: which plan is best', 'AI agent: You can see our plans under View Plans on your dashboard.\n\nWould you like me to connect you with our Sales Team to find the best plan for your requirement?'],
});
assert.doesNotMatch(salesAfterHours.audit.flow_checks?.reasons.join(' ') || '', /Support offer outside support hours/);
const linkAfterHours = makeChat({
  interactionDate: EVENING,
  parts: ['User: my accountant job is not live', "AI agent: I couldn't find your Accountant job. Could you please share its link?\n\nOpen the job on your dashboard and copy the link from your browser's address bar.\n\nIf you prefer, I can connect you with our support team instead. Would you like that?"],
});
assert.match(linkAfterHours.audit.flow_checks.reasons.join(' '), /Support offer outside support hours/);

// "please call me" right after the Sales line gets the Sales call answer: a lead, not a missed handoff
const salesCallQuestion = makeChat({
  parts: [
    'User: I want help choosing a plan',
    'AI agent: Your request is already with our Sales team. They will reach out to you within 24 hours.',
    'User: please call me today',
    'AI agent: Yes, our Sales team will call you within 24 hours.',
  ],
});
assert.match(salesCallQuestion.audit.agent_request.reasons.join(' '), /Sent to the Sales team as a lead/);
assert.equal(salesCallQuestion.audit.agent_request.alert, null);

// Freshchat fails a handoff at once (failed, ai_resumed): the bot got no result and said nothing
const failedHandoff = makeChat({
  parts: ['User: connect me to a human', toolBlock(undefined, 2000), 'User: hello?', 'AI agent: Hello! How can I help you today?'],
  humanTranscript: [
    '[2026-10-15T06:01:00.000Z] ── agent_handoff.requested ──',
    '[2026-10-15T06:01:02.000Z] ── agent_handoff.failed ──',
    '[2026-10-15T06:01:02.000Z] ── agent_handoff.ai_resumed ──',
  ].join('\n'),
});
assert.equal(failedHandoff.handoffDetail, 'Freshchat failed the request and the bot resumed, with no result sent to the bot');
assert.match(failedHandoff.audit.flow_checks.reasons.join(' '), /No reply after a failed handoff: .*connect me to a human/);
assert.equal(failedHandoff.audit.flow_checks.alert, 'No reply after a failed handoff');

// A review under 30 minutes old gets the 30-minute answer; a handoff for it is flagged (lookup at 11:30 AM IST)
const freshOutput = (since) => JSON.stringify({ intent: 'GET_JOB_STATUS', context: { job: { status: 'under_review', under_review_since: since, verification: { verification_status: 'APPROVED', pending_steps: [] } } }, timestamp: '2026-10-15T06:00:00.000Z' });
const joinedAgent = ['[2026-10-15T06:01:00.000Z] agent_handoff.requested', '[2026-10-15T06:01:02.000Z] agent_handoff.human_active', '[2026-10-15T06:01:03.000Z] Priya (Agent): Hello'].join('\n');
const freshHandoff = makeChat({
  parts: ['User: why is my job not live', queryBlock('GET_JOB_STATUS', 'why is my job not live', freshOutput('15 Oct 2026, 11:25 AM IST')), toolBlock(undefined, 2000)],
  humanTranscript: joinedAgent,
});
assert.match(freshHandoff.audit.flow_checks.reasons.join(' '), /Handoff for a review only 5 minutes old/);
assert.equal(freshHandoff.audit.flow_checks.alert, 'Fresh review handed off');
const freshButLong = makeChat({
  parts: ['User: my job is under review since 2 hours', queryBlock('GET_JOB_STATUS', 'my job is under review since 2 hours', freshOutput('15 Oct 2026, 11:25 AM IST')), toolBlock(undefined, 2000)],
  humanTranscript: joinedAgent,
});
assert.doesNotMatch(freshButLong.audit.flow_checks?.reasons.join(' ') || '', /Handoff for a review only/);

// An account whose documents are submitted never gets upload steps
const verificationOutput = (state) => JSON.stringify({ intent: 'GET_VERIFICATION', context: { account_verification: { pending_steps: [], reason: null, state } } });
const S82 = 'AI agent: Your verification is not complete yet.\n\nTo complete it, upload a company document and finish your personal KYC (Aadhaar or PAN with a selfie) on your dashboard.';
const submittedUpload = makeChat({
  parts: ['User: is my verification done', queryBlock('GET_VERIFICATION', 'is my verification done', verificationOutput('submitted')), S82],
});
assert.match(submittedUpload.audit.flow_checks.reasons.join(' '), /Upload steps for documents already submitted/);
const unverifiedUpload = makeChat({
  parts: ['User: is my verification done', queryBlock('GET_VERIFICATION', 'is my verification done', verificationOutput('unverified')), S82],
});
assert.doesNotMatch(unverifiedUpload.audit.flow_checks?.reasons.join(' ') || '', /Upload steps for documents already submitted/);

// A file shared while a preloaded job is under review goes to a human, never the file line
const FILE_LINE = 'AI agent: I am unable to read files shared in this chat. Could you please tell me how I can help you?';
const fileUnderReview = makeChat({
  parts: ['User: [Attached image: image.png (85 KB)]', FILE_LINE],
  variables: { jobs: JSON.stringify([{ id: 932750684, title: 'Accountant', status: 'under_review' }]) },
});
assert.equal(fileUnderReview.preloadJobs[0].status, 'under_review');
assert.equal(fileUnderReview.audit.flow_checks.alert, 'File with a job under review not handed off');
const fileLiveJob = makeChat({
  parts: ['User: [Attached image: image.png (85 KB)]', FILE_LINE],
  variables: { jobs: JSON.stringify([{ id: 932750684, title: 'Accountant', status: 'active' }]) },
});
assert.doesNotMatch(fileLiveJob.audit.flow_checks?.reasons.join(' ') || '', /File shared while a job is under review/);

// The support-hours message goes out once a chat
const GATE = 'AI agent: Our chat support team is available from 9:00 AM to 7:00 PM IST.\n\nI can help you with any issues right now, or you can email us at employersupport@apna.co and the team will get back to you.\n\nWhat would you like to do?';
const CLOSED_RESULT = 'Human support is closed right now and reopens at 9:00 AM';
const gateTwice = makeChat({
  interactionDate: EVENING,
  parts: ['User: connect to human agent', toolBlock(CLOSED_RESULT), GATE, 'User: why is it taking so long', toolBlock(CLOSED_RESULT), GATE],
});
assert.match(gateTwice.audit.flow_checks.reasons.join(' '), /Support-hours message sent 2 times/);

// One lead per chat, and never "already with our Sales team" in the lead turn
const leadOutput = JSON.stringify({ intent: 'CREATE_LEAD', context: { lead_already_exists: true, lead_created: false } });
const LEAD_DONE = 'AI agent: Your request is already with our Sales team. They will reach out to you within 24 hours.';
const leadTwice = makeChat({
  parts: ['User: yearly offer plan', queryBlock('CREATE_LEAD', 'yearly offer plan', leadOutput), LEAD_DONE,
    'User: kindly payment details', queryBlock('CREATE_LEAD', 'kindly payment details', leadOutput), LEAD_DONE],
});
assert.match(leadTwice.audit.flow_checks.reasons.join(' '), /2 lead calls in one chat/);
assert.match(leadTwice.audit.flow_checks.reasons.join(' '), /"Your request is already with our Sales team" in the turn the lead was made, after "yearly offer plan"/);
assert.equal(leadTwice.audit.flow_checks.alert, 'Second lead call');
const leadRight = makeChat({
  parts: ['User: yearly offer plan', queryBlock('CREATE_LEAD', 'yearly offer plan', leadOutput),
    'AI agent: Our current offers are shown under View Plans on your dashboard.\n\nWould you like me to connect you with our Sales Team for custom packages or current discounts?'],
});
assert.doesNotMatch(leadRight.audit.flow_checks?.reasons.join(' ') || '', /lead calls in one chat|in the turn the lead was made/);

// "ok" and then only "Did this resolve your query?" is the end of a chat, not an early drop
const doneAfterOk = makeChat({
  parts: [
    'User: hi', 'AI agent: Hello! I am Apna Expert. How can I help you today?',
    'User: why is my secretary job under review', 'AI agent: Your job has been successfully posted, but our team is currently reviewing your documents before it goes active.\n\nThis process typically takes around 30 minutes.',
    'User: ok', 'AI agent: Did this resolve your query?',
  ],
});
assert.equal(doneAfterOk.audit.early_drop, undefined);
const droppedAfterQuestion = makeChat({
  parts: [
    'User: hi', 'AI agent: Hello! I am Apna Expert. How can I help you today?',
    'User: why is my secretary job under review', 'AI agent: Your job has been successfully posted, but our team is currently reviewing your documents before it goes active.\n\nThis process typically takes around 30 minutes.',
    'User: how do I repost it', 'AI agent: To renew an expired job: open Expired Jobs, click Repost Now, choose a plan and publish.\n\nDid this resolve your query?',
  ],
});
assert.ok(droppedAfterQuestion.audit.early_drop);

// ---------- Agent CSAT ----------
const human = (lines) => lines.map(([t, text]) => `[2026-10-15T${t}.000Z] ${text}`).join('\n');
const HANDBACK = 'AI agent: Hope the support team has resolved your queries. I can continue to help you from here';

// Resolved after a reassignment, CSAT asked and answered Yes; the agent asked for a Yes
const csatYes = makeChat({
  parts: ['User: connect me to support', toolBlock('Request sent'), HANDBACK],
  handoffAgentName: 'Falguni Bera',
  humanTranscript: human([
    ['06:00:00', '── agent_handoff.requested ──'],
    ['06:00:05', '── agent_handoff.waiting ──'],
    ['06:00:10', '── agent_handoff.assigned ──'],
    ['06:00:20', '── agent_handoff.human_active ──'],
    ['06:00:30', 'Rahul Kumar Sinha (Agent): Hi, welcome to APNA chat support.  {delivery=PROVIDER_CONFIRMED, policy=ALLOW, source=RELAY}'],
    ['06:01:00', 'Customer: my job is not live  {delivery=ACCEPTED, policy=ALLOW, source=RELAY}'],
    ['06:01:30', '── agent_handoff.reassigned ──'],
    ['06:03:00', 'Falguni Bera (Agent): Your job is live now.'],
    ['06:04:00', 'Falguni Bera (Agent): It was a pleasure assisting you today. Kindly consider clicking on "Yes" if I was able to solve your query in the feedback question you will receive shortly.'],
    ['06:10:00', '── agent_handoff.resolved ──'],
    ['06:10:00', '── agent_handoff.feedback_prompt ──'],
    ['06:10:00', '── agent_handoff.ai_resumed ──'],
    ['06:10:05', 'Customer: Yes  {delivery=ACCEPTED, policy=ALLOW, source=RELAY}'],
  ]),
});
assert.equal(csatYes.agentSessions.length, 1);
const sYes = csatYes.agentSessions[0];
assert.equal(sYes.creditedAgent, 'Falguni Bera');
assert.deepEqual(sYes.agents, ['Rahul Kumar Sinha', 'Falguni Bera']);
assert.equal(sYes.reassignments, 1);
assert.equal(sYes.outcome, 'resolved');
assert.equal(sYes.csatAsked, 1);
assert.equal(sYes.csatAnswer, 'yes');
assert.equal(sYes.csatAnswerSeconds, 5);
assert.equal(sYes.yesRequests, 1);
assert.equal(sYes.firstReplySeconds, 30);
assert.equal(sYes.handleSeconds, 580);
assert.equal(sYes.longestWaitSeconds, 120);
assert.equal(sYes.customerMessages, 1);
assert.equal(sYes.timeIST, '11:30');
assert.equal(sYes.inSupportHours, true);
assert.equal(csatYes.csat, 'yes');
assert.deepEqual(csatYes.supportAgents, ['Rahul Kumar Sinha', 'Falguni Bera']);
// The agent chat log keeps events and messages in order, with HTML removed
assert.deepEqual(sYes.log.slice(0, 2).map((e) => [e.kind, e.text]), [['event', 'Handoff requested'], ['event', 'Waiting for an agent']]);
assert.deepEqual(sYes.log.filter((e) => e.kind !== 'event').map((e) => e.who), ['Rahul Kumar Sinha', 'Employer', 'Falguni Bera', 'Falguni Bera', 'Employer (CSAT answer)']);
assert.match(sYes.transcript, /\[11:40\] -- CSAT question sent --/);

// Asked, never answered; the employer then told the bot "Not resolved" and asked again: two agent chats
const csatTwice = makeChat({
  parts: ['User: connect me to support', toolBlock('Request sent'), HANDBACK, 'User: Not resolved', toolBlock('Request sent')],
  handoffAgentName: 'Umair Mushtaq',
  humanTranscript: human([
    ['06:00:00', 'agent_handoff.requested'],
    ['06:00:10', 'agent_handoff.human_active'],
    ['06:00:40', 'Asif Laskar (Agent): Hello, how can I help?'],
    ['06:05:00', 'agent_handoff.resolved'],
    ['06:05:00', 'agent_handoff.feedback_prompt'],
    ['06:05:00', 'agent_handoff.ai_resumed'],
    ['06:06:00', 'agent_handoff.requested'],
    ['06:06:30', 'Customer: still not live'],
    ['06:07:00', 'agent_handoff.human_active'],
    ['06:07:10', 'Umair Mushtaq (Agent): Checking.'],
  ]),
});
assert.equal(csatTwice.agentSessions.length, 2);
const [first, second] = csatTwice.agentSessions;
assert.equal(first.creditedAgent, 'Asif Laskar');
assert.equal(first.csatAnswer, 'no_answer');
assert.equal(first.csatAnswerText, null);
assert.equal(first.askedForSupportAgain, true);
assert.equal(first.wroteToBotAfter, 'Not resolved');
assert.equal(first.handbackReply, 'no');
assert.equal(second.creditedAgent, 'Umair Mushtaq');
assert.equal(second.outcome, 'open');
assert.equal(second.csatAnswer, 'not_asked');
assert.equal(second.customerMessages, 1);
assert.equal(csatTwice.csat, null);
assert.equal(csatTwice.csatAsked, 1);

// Only a plain yes or no is an answer; "No" and "Not resolved" both count as No
const answerOf = (text) => makeChat({
  parts: ['User: connect me to support', toolBlock('Request sent')],
  humanTranscript: human([
    ['06:00:00', 'agent_handoff.requested'],
    ['06:00:30', 'Gul Khan EXT (Agent): Done from our side.'],
    ['06:01:00', 'agent_handoff.resolved'],
    ['06:01:00', 'agent_handoff.feedback_prompt'],
    ['06:01:10', `Customer: ${text}`],
  ]),
}).agentSessions[0];
assert.equal(answerOf('No').csatAnswer, 'no');
assert.equal(answerOf('Not resolved').csatAnswer, 'no');
assert.equal(answerOf('ok thanks').csatAnswer, 'other');
assert.equal(answerOf('ok thanks').csatAnswerText, 'ok thanks');

// No agent ever joined, and an employer left waiting until the chat timed out
const noAgent = makeChat({
  parts: ['User: connect me to support', toolBlock('Request sent')],
  humanTranscript: human([['06:00:00', 'agent_handoff.requested'], ['06:00:05', 'agent_handoff.waiting'], ['06:20:00', 'agent_handoff.timed_out']]),
}).agentSessions[0];
assert.equal(noAgent.creditedAgent, 'No agent joined');
assert.equal(noAgent.outcome, 'timed_out');
const leftWaiting = makeChat({
  parts: ['User: connect me to support', toolBlock('Request sent')],
  humanTranscript: human([
    ['06:00:00', 'agent_handoff.requested'],
    ['06:00:20', 'Pooja Shivapeti (Agent): Hello'],
    ['06:01:00', 'Customer: are you there?'],
    ['06:11:00', 'agent_handoff.timed_out'],
  ]),
}).agentSessions[0];
assert.equal(leftWaiting.longestWaitSeconds, 600);
assert.equal(leftWaiting.lastEmployerMessageUnanswered, true);

// Per-agent and per-day numbers
const all = [csatYes, csatTwice].flatMap((c) => c.agentSessions);
const totals = csatCounts(all);
assert.equal(totals.sessions, 3);
assert.equal(totals.chats, 2);
assert.equal(totals.csatAskedSessions, 2);
assert.equal(totals.answered, 1);
assert.equal(totals.yes, 1);
assert.equal(totals.responseRatePct, 50);
assert.equal(totals.yesPctOfAnswers, 100);
assert.equal(totals.yesRequestSessions, 1);
assert.equal(totals.notResolvedAfterHandback, 1);
const byAgent = Object.fromEntries(agentSummary(all).map((r) => [r.agent, r]));
assert.equal(byAgent['Falguni Bera'].sessions, 1);
assert.equal(byAgent['Falguni Bera'].yes, 1);
assert.equal(byAgent['Rahul Kumar Sinha'].sessions, 0);
assert.equal(byAgent['Rahul Kumar Sinha'].involved, 1);
assert.equal(byAgent['Rahul Kumar Sinha'].passedOn, 1);
assert.equal(byAgent['Asif Laskar'].noAnswer, 1);
assert.equal(byAgent['Asif Laskar'].cameBack, 1);
assert.deepEqual(csatDaily(all).map((d) => [d.date, d.sessions, d.csatAskedSessions]), [['2026-10-15', 3, 2]]);

// ---------- Several exports and the newer checks ----------
// The same chat in two exports: the more complete copy wins, whichever file comes first, and keeps the evaluation
const early = exportRecords({
  id: 'same-chat', parts: ['User: connect me to support', toolBlock('Request sent')],
  evaluationTurns: [{ turn: 1, user_input: 'connect me to support', bot_output: null, turn_score: 4 }],
  humanTranscript: human([['06:00:00', 'agent_handoff.requested'], ['06:00:20', 'Gul Khan EXT (Agent): Hello']]),
});
const later = exportRecords({
  id: 'same-chat', parts: ['User: connect me to support', toolBlock('Request sent'), HANDBACK],
  humanTranscript: human([
    ['06:00:00', 'agent_handoff.requested'], ['06:00:20', 'Gul Khan EXT (Agent): Hello'],
    ['06:05:00', 'agent_handoff.resolved'], ['06:05:00', 'agent_handoff.feedback_prompt'], ['06:05:00', 'agent_handoff.ai_resumed'],
  ]),
});
const firstLoad = mergeConversations([], early);
const merged = mergeConversations(firstLoad.conversations, later);
assert.equal(firstLoad.added, 1);
assert.equal(merged.added, 0);
assert.equal(merged.updated, 1);
assert.equal(merged.conversations.length, 1);
assert.equal(merged.conversations[0].agentSessions[0].outcome, 'resolved');
assert.equal(merged.conversations[0].hasEval, true);
const reversed = mergeConversations(mergeConversations([], later).conversations, early);
assert.equal(reversed.updated, 1); // the complete copy stays and takes the evaluation from the shorter one
assert.equal(reversed.conversations[0].hasEval, true);
assert.equal(reversed.conversations[0].agentSessions[0].outcome, 'resolved');

const flowReasons = (c) => (c.audit.flow_checks?.reasons || []).join(' | ');
// "Credits & Usage" to an apna Unlimited subscriber
const subscriber = makeChat({
  parts: ['User: cancel my plan', 'AI agent: To turn off auto-renewal:\n- Go to Credits & Usage on your dashboard.\n- Click the 3-dots menu next to your plan.'],
  variables: { accounts: JSON.stringify([{ plans: [{ plan_type: 'apna Unlimited' }] }]) },
});
assert.match(flowReasons(subscriber), /"Credits & Usage" sent to an apna Unlimited subscriber/);
const notSubscriber = makeChat({ parts: ['User: cancel my plan', 'AI agent: To turn off auto-renewal:\n- Go to Credits & Usage on your dashboard.'] });
assert.doesNotMatch(flowReasons(notSubscriber), /Plans & Usage/);

// A suspended account told it is not blocked
const suspended = makeChat({ parts: ['User: Account block', 'AI agent: Your account is not blocked. Your verification is complete.'], variables: { isBanned: true } });
assert.equal(suspended.audit.flow_checks.alert, 'Suspended account told it is not blocked');
const suspendedOk = makeChat({ parts: ['User: Account block', 'AI agent: Your account has been temporarily suspended due to a policy flag.\n\nOur Trust and Safety team will review your profile and get back to you within 24 hours.'], variables: { isBanned: true } });
assert.doesNotMatch(flowReasons(suspendedOk), /Suspended account/);

// "no" to the closing line is not a handoff
const afterClosing = makeChat({
  parts: ['User: thanks', 'AI agent: Thank you for choosing Apna! Have a great day. Let me know if you need anything else.', 'User: no', toolBlock('Request sent', 2000)],
});
assert.match(flowReasons(afterClosing), /Handoff after the closing line for "no"/);

// The hand-back line after a handoff that timed out with no agent (roadmap #43)
const timedOut = makeChat({
  parts: ['User: i am unable to use database', toolBlock(undefined, 478000), HANDBACK],
  humanTranscript: human([['06:00:00', 'agent_handoff.requested'], ['06:00:05', 'agent_handoff.waiting'], ['06:08:00', 'agent_handoff.timed_out'], ['06:08:00', 'agent_handoff.ai_resumed']]),
});
assert.match(flowReasons(timedOut), /hand-back|though no agent joined/);

// Job tips in support hours are followed by a handoff (from 4 Nov 2026)
const tipsPart = 'AI agent: Your Welder job is on the Classic plan and has received 4 leads so far.\n\n- Add perks\n\nYou can make these changes from Edit Job on your dashboard. Editing an active job may send it for a quick review.';
const tipsOnly = makeChat({ parts: ['User: not getting applications', tipsPart], interactionDate: '2026-11-04T06:00:00.000Z' });
assert.match(flowReasons(tipsOnly), /Job tips in support hours with no handoff/);
const tipsThenHandoff = makeChat({ parts: ['User: not getting applications', tipsPart, toolBlock('Request sent', 2000)], interactionDate: '2026-11-04T06:00:00.000Z' });
assert.doesNotMatch(flowReasons(tipsThenHandoff), /Job tips in support hours/);
const tipsBeforeRule = makeChat({ parts: ['User: not getting applications', tipsPart], interactionDate: '2026-11-02T06:00:00.000Z' });
assert.doesNotMatch(flowReasons(tipsBeforeRule), /Job tips in support hours/);

console.log('All synthetic handoff, flow-rule and agent CSAT tests passed.');
