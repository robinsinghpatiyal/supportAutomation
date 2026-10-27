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

console.log('All synthetic handoff and flow-rule tests passed.');
