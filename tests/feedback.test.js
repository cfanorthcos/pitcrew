// Tests for the feedback webhook. The request shape is the thing worth pinning:
// a JSON content type triggers a CORS preflight that Zapier's Catch Hook never
// answers, so the bug would be "works in curl, silently fails in the browser".

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFeedbackPayload, sendFeedback } from '../js/feedback.js';

function fakeFetch(response = { ok: true }) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    if (response instanceof Error) throw response;
    return response;
  };
  return { impl, calls };
}

test('buildFeedbackPayload trims and fills defaults', () => {
  const now = new Date('2026-10-07T15:00:00Z');
  assert.deepEqual(
    buildFeedbackPayload({ type: 'Bug', message: '  tile is stuck  ', name: '   ', source: 'kiosk', now }),
    {
      type: 'Bug',
      message: 'tile is stuck',
      name: 'Anonymous',
      source: 'kiosk',
      submitted_at: '2026-10-07T15:00:00.000Z',
    },
  );
});

test('buildFeedbackPayload keeps every field a flat string', () => {
  const payload = buildFeedbackPayload({ message: 'x', source: 'admin' });
  for (const value of Object.values(payload)) assert.equal(typeof value, 'string');
});

test('sendFeedback posts form-encoded, so the browser skips the CORS preflight', async () => {
  const { impl, calls } = fakeFetch();
  await sendFeedback('https://hooks.zapier.com/x', { message: 'hi & bye', source: 'kiosk' }, impl);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://hooks.zapier.com/x');
  assert.equal(calls[0].options.method, 'POST');
  assert.ok(calls[0].options.body instanceof URLSearchParams);
  assert.equal(calls[0].options.headers, undefined);
  assert.equal(calls[0].options.body.get('message'), 'hi & bye');
});

test('sendFeedback throws on a non-OK response', async () => {
  const { impl } = fakeFetch({ ok: false });
  await assert.rejects(sendFeedback('https://hooks.zapier.com/x', { message: 'x' }, impl), /Could not send/);
});

test('sendFeedback refuses to send without a URL', async () => {
  const { impl, calls } = fakeFetch();
  await assert.rejects(sendFeedback('', { message: 'x' }, impl), /not set up/);
  assert.equal(calls.length, 0);
});
