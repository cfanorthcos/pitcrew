// "Send feedback" — posts to a Zapier Catch Hook, which a Zap turns into an
// item on the Monday feedback board. PitCrew never talks to Monday directly:
// that would need a Monday API token, and anything in this repo ships to every
// browser that loads the kiosk. A Catch Hook URL can only ever *add* a feedback
// item, which is the most a public kiosk should be able to do.
//
// The URL lives in js/config.js. Leave it empty and the button never appears.

import { FEEDBACK_WEBHOOK_URL } from './config.js';
import { openModal, closeModal, showError, showSuccess } from './ui.js';
import { field, textArea, textInput, select, modalActions } from './render.js';

export const FEEDBACK_TYPES = ['Idea', 'Bug', 'Something else'];

// Flat string fields only. Zapier shows each key as its own field when the
// Zap's Monday step is mapped, so a nested object here would arrive as one
// unreadable blob in a single column.
export function buildFeedbackPayload({ type, message, name, source, now = new Date() }) {
  return {
    type: type || 'Something else',
    message: String(message ?? '').trim(),
    name: String(name ?? '').trim() || 'Anonymous',
    source,
    submitted_at: now.toISOString(),
  };
}

// Sent form-encoded on purpose. A JSON body makes the browser send a CORS
// preflight first, and a Catch Hook doesn't answer preflights — the request
// would fail before Zapier ever saw it. Form-encoded is a "simple" request with
// no preflight, and Zapier splits it into the same named fields JSON would.
export async function sendFeedback(url, payload, fetchImpl = globalThis.fetch) {
  if (!url) throw new Error('Feedback is not set up yet.');
  const response = await fetchImpl(url, {
    method: 'POST',
    body: new URLSearchParams(payload),
  });
  if (!response.ok) throw new Error('Could not send feedback. Try again.');
}

export function isFeedbackEnabled() {
  return Boolean(FEEDBACK_WEBHOOK_URL);
}

// `source` says which screen it came from ("kiosk" or "admin"), so the board
// can tell a driver's note from a manager's.
export function openFeedbackModal({ source }) {
  const sheet = openModal('Send feedback', `
    <h2>Send Feedback</h2>
    <p class="meta">Something broken, confusing, or missing? It goes straight to the team that builds PitCrew.</p>
    ${field(
      'What kind?',
      'feedback-type',
      select({
        id: 'feedback-type',
        options: FEEDBACK_TYPES.map((t, i) => ({ value: t, label: t, selected: i === 0 })),
      }),
    )}
    ${field(
      'What should we know?',
      'feedback-message',
      textArea({ id: 'feedback-message', placeholder: 'What happened, or what would make this better.' }),
    )}
    ${field(
      'Your name',
      'feedback-name',
      textInput({ id: 'feedback-name', placeholder: 'Optional', autocomplete: 'off' }),
    )}
    ${modalActions('Send', 'feedback-submit-btn', { disabled: true })}
  `);

  const message = sheet.querySelector('#feedback-message');
  const submit = sheet.querySelector('#feedback-submit-btn');
  message.focus();
  message.addEventListener('input', () => {
    submit.disabled = !message.value.trim();
  });

  submit.addEventListener('click', async () => {
    submit.disabled = true;
    submit.textContent = 'Sending…';
    try {
      await sendFeedback(
        FEEDBACK_WEBHOOK_URL,
        buildFeedbackPayload({
          type: sheet.querySelector('#feedback-type').value,
          message: message.value,
          name: sheet.querySelector('#feedback-name').value,
          source,
        }),
      );
      closeModal();
      showSuccess('Feedback sent. Thank you!');
    } catch (err) {
      // fetch rejects with a bare TypeError when offline or blocked; that
      // message ("Failed to fetch") means nothing to a driver.
      showError(
        err instanceof TypeError ? 'Could not send feedback. Check the connection and try again.' : err.message,
      );
      submit.disabled = false;
      submit.textContent = 'Send';
    }
  });
}
