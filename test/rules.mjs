import assert from 'node:assert/strict';
import { parseBlueMachinesExport, mergeConversations } from '../js/data.js';
import { runAudit } from '../js/audit.js';
import { ANSWER_NO, TEST_USER_IDS } from '../js/config.js';

const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
let sequence = 0;

function toolBlock(output, latencyMs = 100000) {
  const details = { 'Tool name': 'agent_handoff', 'Tool input': '{}' };
  if (output !== undefined) details.Output = output;
  return `[Tool: agent_handoff]\n${JSON.stringify({ details, metrics: [`Latency: ${latencyMs}ms`] })}`;
}

function queryBlock(intent, text) {
  const details = { 'Tool name': 'apna_chat_query', 'Tool input': JSON.stringify([{ body: { intent, message: { text } } }]), Output: '{}' };
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

function makeChat({
  parts, humanTranscript = '', variables = {}, externalUserId = '9000000000',
  agentName = 'Apna Expert', interactionEnvironment = 'LIVE', evaluationTurns = null,
}) {
  sequence++;
  const headers = [
    'conversationId', 'interactionDate', 'userDisplayName', 'externalUserId',
    'agentName', 'interactionEnvironment', 'callAnalysisStatus', 'humanTranscript', 'transcript',
    'evaluation.eval_version', 'evaluation.turn_by_turn',
  ];
  const row = [
    `synthetic-${sequence}`, '2026-10-15T06:00:00.000Z', 'Synthetic employer', externalUserId,
    agentName, interactionEnvironment, evaluationTurns ? 'OK' : 'PENDING', humanTranscript, transcript(parts, variables),
    evaluationTurns ? 'synthetic-v1' : '', evaluationTurns ? JSON.stringify(evaluationTurns) : '',
  ];
  const csv = `${headers.map(csvCell).join(',')}\n${row.map(csvCell).join(',')}\n`;
  const records = parseBlueMachinesExport(csv);
  const { conversations } = mergeConversations([], records);
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

console.log('All synthetic handoff and flow-rule tests passed.');
