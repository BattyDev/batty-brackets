import { html, on, snack } from '../lib/ui.js';
import * as auth from '../lib/auth.js';

export function view(ctx) {
  return { title: 'Claim a desk entry', back: '/', body: html`
    <div class="pane" style="max-width:640px">
      <h2 class="headline-small">Your desk entry</h2>
      <p>Claim the unused entry your host created, then review documents and check in yourself.</p>
      <p class="body-small">The link expires after 24 hours. Registration must be open. An entry with a seed, check-in, signature, or played result cannot be transferred. You must not already be entered in the same event.</p>
      <p><a href="#/about/walkup">Help with a desk entry</a></p>
      ${ctx.me ? html`<p>Claim as <b>${ctx.me.tag}</b>.</p><button class="btn btn-filled" data-act="claim-desk-entry" data-code="${ctx.params.code}">Claim this entry</button>` : html`<p>Sign in to your player record first, then return here to confirm.</p><button class="btn btn-filled" data-act="sign-in">Sign in</button>`}
      <p id="desk-claim-error" class="body-small" role="alert"></p>
    </div>` };
}

on('claim-desk-entry', async ({ code }, button) => {
  button.disabled = true;
  try {
    const player = await auth.claim(code);
    snack('Entry claimed. Review documents and check-in in your event.');
    window.location.hash = player.eventId ? `#/e/${player.eventId}` : '#/me';
  } catch (error) {
    document.getElementById('desk-claim-error').textContent = error.message;
    button.disabled = false;
  }
});
