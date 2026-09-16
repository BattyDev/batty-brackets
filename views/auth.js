/* Brackets · sign-in
   ===========================================================================
   One dialog, three states: choose, email, and the branch where the email is
   already spoken for by a Discord login.

   The whole design goal is that nobody is ever told "that email is taken".
   They are told what their account already is and offered the way in that
   works. See lib/auth.js for the reasoning; this is the surface of it.
   =========================================================================== */

'use strict';

import * as auth from '../lib/auth.js';
import { dialog, html, raw, esc, icon, snack } from '../lib/ui.js';

let redraw = () => {};
/* Set when sign-in was demanded by something rather than chosen: the wizard's
   publish gate passes its own heading and reason so the dialog explains why
   it appeared, instead of showing the same generic "Sign in" that a user who
   clicked "Sign in" would get. Being interrupted by a modal that does not say
   why is the thing that makes people close the tab. */
let context = null;
const RETURN_AFTER_AUTH = 'brackets.returnAfterAuth';

/* An invitation is an intent, not permission to create an entry. Preserve the
   exact join route across OAuth's full-page redirect, then put the player back
   in front of the event so they can make the final decision themselves. The
   stored value is deliberately restricted to the one route this view owns;
   sessionStorage must never become an open redirect assembled from arbitrary
   input. */
function joinIntent() {
  const match = window.location.hash.match(/^#\/join\/([A-Z0-9]+)$/i);
  if (!match) return null;
  const code = match[1].toUpperCase();
  return {
    path: `#/join/${code}`,
    title: 'Sign in to join this event',
    why: 'Your invite stays open while you sign in. Afterwards you will review the event and confirm your entry — signing in never enters you automatically.',
  };
}

function rememberJoinIntent() {
  const intent = joinIntent();
  if (!intent) return;
  try { sessionStorage.setItem(RETURN_AFTER_AUTH, intent.path); } catch { /* private mode */ }
}

function validReturnPath(value) {
  return /^#\/join\/[A-Z0-9]+$/i.test(value || '') ? value : null;
}

export function openSignIn(onDone, why = null) {
  redraw = onDone || (() => {});
  context = why || joinIntent();
  chooseStep();
}

/* --------------------------------------------------------------------------
   Step 1 — how do you want to get in
   -------------------------------------------------------------------------- */

function chooseStep() {
  const local = !auth.isRemote();
  const el = dialog({
    title: context?.title || 'Sign in',
    body: html`
      <p class="body-medium dim">${context?.why
        || 'Your profile, your match history and every event you have ever entered live on one account — whichever way you sign in to it.'}</p>
      ${local ? html`
        <div class="banner banner-info" style="margin-top:16px">
          ${raw(icon('station'))}
          <div>
            <b>No server is connected yet</b>
            <p class="body-small" style="margin:4px 0 0">Discord sign-in needs one. For now an account is created on this device — it works completely, it just does not sync anywhere or reach another phone.</p>
          </div>
        </div>` : ''}
      <div class="stack" style="margin:20px 0 8px">
        ${local ? html`
          <button class="btn btn-filled btn-lg btn-block" id="sign-local">
            ${raw(icon('person'))} Continue on this device
          </button>
          <button class="btn btn-outlined btn-block" id="sign-discord" disabled
                  title="Discord sign-in needs a server, which is not connected yet.">
            ${raw(icon('discord'))} Continue with Discord — not available yet
          </button>
          <button class="btn btn-outlined btn-block" id="sign-email" disabled
                  title="Email sign-in needs a server, which is not connected yet.">
            ${raw(icon('mail'))} Continue with email — not available yet
          </button>`
        : html`
          <button class="btn btn-filled btn-lg btn-block" id="sign-discord">
            ${raw(icon('discord'))} Continue with Discord
          </button>
          <button class="btn btn-outlined btn-block" id="sign-email">
            ${raw(icon('mail'))} Use an email address
          </button>`}
      </div>
      <hr class="divider">
      <button class="btn btn-text btn-block" id="sign-claim">
        ${raw(icon('key'))} I have a claim code from an organiser
      </button>
      <p class="body-small dim" style="margin-top:12px">
        A claim code turns the entry an organiser typed in for you at the door into your own account — with the sets you have already played attached to it.
      </p>`,
    actions: [{ label: 'Cancel', kind: 'text' }],
  });

  el.querySelector('#sign-discord')?.addEventListener('click', async () => {
    try {
      rememberJoinIntent();
      await auth.signInWithDiscord();
      el.close();
      redraw();
    } catch (err) {
      snack(err.message || 'Discord sign-in failed. Try email instead.');
    }
  });
  el.querySelector('#sign-local')?.addEventListener('click', () => { el.close(); localStep(); });
  el.querySelector('#sign-email:not([disabled])')?.addEventListener('click', () => { el.close(); emailStep(); });
  el.querySelector('#sign-claim').addEventListener('click', () => { el.close(); claimStep(); });
}

/* --------------------------------------------------------------------------
   Step 2 — the email, and what it already is
   --------------------------------------------------------------------------
   Ask for the address FIRST, on its own, and look up what it already has
   before asking for a password. That extra step is the entire fix: it turns a
   post-hoc error into a pre-emptive explanation.
   -------------------------------------------------------------------------- */

function emailStep(prefill = '') {
  const el = dialog({
    title: 'Sign in with email',
    body: html`
      <label class="field">
        <span class="field-label">Email address</span>
        <input type="email" id="email" autocomplete="email" inputmode="email"
               value="${prefill}" placeholder="you@example.com">
      </label>
      <p class="field-help" id="email-note">We check what this address is already set up with before asking for a password.</p>`,
    actions: [
      { label: 'Cancel', kind: 'text' },
      {
        label: 'Continue',
        kind: 'filled',
        onClick: (dlg) => {
          const email = dlg.querySelector('#email').value.trim();
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
            dlg.querySelector('#email-note').textContent = 'That does not look like an email address.';
            return false;
          }
          dlg.close();
          resolveEmail(email);
          return true;
        },
      },
    ],
  });
  el.querySelector('#email').focus();
}

async function resolveEmail(email) {
  const methods = await auth.methodsFor(email);

  /* null means the lookup itself failed -- offline, or the RPC is not
     deployed. Guessing "new account" here would produce exactly the duplicate
     error this flow exists to avoid, so offer both doors instead. */
  if (methods === null) {
    passwordStep(email, { mode: 'unknown' });
    return;
  }

  const hasDiscord = methods.includes('discord');
  const hasPassword = methods.includes('email');

  if (hasDiscord && !hasPassword) { discordCollisionStep(email); return; }
  if (hasPassword) { passwordStep(email, { mode: 'signin', alsoDiscord: hasDiscord }); return; }
  passwordStep(email, { mode: 'signup' });
}

/* The case the brief specifically asked about: the address is already used by
   a Discord login. Not an error. Two doors, both leading to the same account,
   with the consequence of each spelled out. */
function discordCollisionStep(email) {
  const el = dialog({
    title: 'You already have an account',
    body: html`
      <div class="banner banner-info" style="margin-bottom:16px">
        ${raw(icon('info'))}
        <div><b>${email}</b> signs in with Discord.<br>
        <span class="body-small">Both options below get you into that same account — your history is not split.</span></div>
      </div>
      <div class="stack">
        <button class="btn btn-filled btn-block" id="use-discord">
          ${raw(icon('discord'))} Continue with Discord
        </button>
        <button class="btn btn-outlined btn-block" id="add-password">
          ${raw(icon('key'))} Set a password for this account
        </button>
      </div>
      <p class="body-small dim" style="margin-top:16px">
        Setting a password is worth doing either way. If Discord is down — or the
        venue wifi breaks its login redirect, which happens more often — a password
        is how you still get into your own bracket.
      </p>`,
    actions: [{ label: 'Cancel', kind: 'text' }],
  });

  el.querySelector('#use-discord').addEventListener('click', async () => {
    try { rememberJoinIntent(); await auth.signInWithDiscord(); el.close(); redraw(); }
    catch (err) { snack(err.message); }
  });
  el.querySelector('#add-password').addEventListener('click', () => {
    el.close();
    dialog({
      title: 'Set a password',
      body: html`
        <p class="body-medium">Sign in with Discord once to prove the account is yours, and we will take you straight to setting a password.</p>`,
      actions: [
        { label: 'Cancel', kind: 'text' },
        {
          label: 'Continue with Discord',
          kind: 'filled',
          onClick: async () => {
            try {
              sessionStorage.setItem('brackets.afterAuth', 'set-password');
            } catch { /* private mode */ }
            rememberJoinIntent();
            await auth.signInWithDiscord();
          },
        },
      ],
    });
  });
}

function passwordStep(email, { mode, alsoDiscord = false }) {
  const signup = mode === 'signup';
  const el = dialog({
    title: signup ? 'Create your account' : 'Enter your password',
    body: html`
      ${mode === 'unknown' ? html`
        <div class="banner banner-warn" style="margin-bottom:16px">${raw(icon('alert'))}
          <div class="body-small">We could not check this address — you may be offline. If it turns out you already have an account, use “Sign in” rather than “Create”.</div>
        </div>` : ''}
      ${alsoDiscord ? html`
        <p class="body-small dim">This account can also sign in with Discord.</p>` : ''}
      <p class="body-medium"><b>${email}</b></p>
      ${signup ? html`
        <label class="field" style="margin-bottom:20px">
          <span class="field-label">Tag</span>
          <input type="text" id="tag" autocomplete="nickname" placeholder="What people call you at events">
        </label>` : ''}
      <label class="field">
        <span class="field-label">Password</span>
        <input type="password" id="password" autocomplete="${raw(signup ? 'new-password' : 'current-password')}">
      </label>
      <p class="field-help" id="pw-note">${signup ? 'At least 8 characters.' : ''}</p>
      ${signup ? '' : html`<button class="btn btn-text" id="forgot" style="margin-top:8px">Forgot it?</button>`}`,
    actions: [
      { label: 'Back', kind: 'text', onClick: () => { setTimeout(() => emailStep(email), 0); } },
      {
        label: signup ? 'Create account' : 'Sign in',
        kind: 'filled',
        onClick: async (dlg) => {
          const password = dlg.querySelector('#password').value;
          const note = dlg.querySelector('#pw-note');
          if (password.length < 8) { note.textContent = 'At least 8 characters.'; return false; }
          try {
            rememberJoinIntent();
            if (signup) await auth.signUpWithEmail(email, password, dlg.querySelector('#tag')?.value);
            else await auth.signInWithEmail(email, password);
            dlg.close();
            redraw();
            snack(signup ? 'Account created' : 'Signed in');
          } catch (err) {
            note.textContent = err.message;
            return false;
          }
          return true;
        },
      },
    ],
  });

  el.querySelector('#forgot')?.addEventListener('click', async () => {
    try {
      await auth.sendPasswordReset(email);
      snack('Reset link sent, if that address has an account.');
    } catch (err) { snack(err.message); }
  });
  el.querySelector(signup ? '#tag' : '#password')?.focus();
}

/* --------------------------------------------------------------------------
   Claim
   -------------------------------------------------------------------------- */

/* --------------------------------------------------------------------------
   Local mode — an account on this device
   --------------------------------------------------------------------------
   With no backend configured there is no Discord to redirect to and no server
   to hold an account, so this is what "sign in" honestly means: pick a tag,
   get a profile, keep it on this device.

   It used to be hidden behind the Discord button, which silently created a
   local profile called "Local TO" and returned as though OAuth had worked.
   That is why Discord sign-in was reported as broken -- it was not broken, it
   was pretending. A button that does something other than what it says is
   worse than a button that says it cannot help yet.
   -------------------------------------------------------------------------- */

function localStep() {
  const el = dialog({
    title: 'What should we call you?',
    body: html`
      <p class="body-medium dim">Your tag is what other people see on a bracket. You can change it later.</p>
      <label class="field" style="margin-top:16px">
        <span class="field-label">Tag</span>
        <input type="text" id="tag" autocomplete="nickname" spellcheck="false" maxlength="24" placeholder="Kira">
      </label>
      <p class="field-help" id="tag-note">Saved on this device. Nothing is sent anywhere — there is no server connected.</p>`,
    actions: [
      { label: 'Cancel', kind: 'text' },
      {
        label: 'Continue',
        kind: 'filled',
        onClick: (dlg) => {
          const tag = dlg.querySelector('#tag').value.trim();
          if (!tag) {
            dlg.querySelector('#tag-note').textContent = 'Pick something — even one letter.';
            return false;
          }
          rememberJoinIntent();
          auth.signInLocal({ tag });
          dlg.close();
          snack(`Signed in as ${tag} — on this device`);
          redraw();
          return true;
        },
      },
    ],
  });
  el.querySelector('#tag').focus();
}

function claimStep() {
  dialog({
    title: 'Claim your entry',
    body: html`
      <p class="body-medium">If an organiser signed you up at the door, they can give you an eight-character code. Claiming it moves every set you have played onto your own account.</p>
      <label class="field" style="margin-top:16px">
        <span class="field-label">Claim code</span>
        <input type="text" id="code" autocapitalize="characters" spellcheck="false"
               style="font-family:var(--font-mono);letter-spacing:.15em" placeholder="XXXXXXXX">
      </label>
      <p class="field-help" id="claim-note">You will need to be signed in first — we will ask if you are not.</p>`,
    actions: [
      { label: 'Cancel', kind: 'text' },
      {
        label: 'Claim',
        kind: 'filled',
        onClick: async (dlg) => {
          const code = dlg.querySelector('#code').value.trim().toUpperCase();
          const note = dlg.querySelector('#claim-note');
          if (!auth.isSignedIn()) {
            try { sessionStorage.setItem('brackets.pendingClaim', code); } catch { /* private mode */ }
            dlg.close();
            chooseStep();
            return true;
          }
          try {
            const claimed = await auth.claim(code);
            dlg.close();
            snack(`Claimed — ${claimed.tag}'s results are now on your profile.`);
            redraw();
          } catch (err) {
            note.textContent = err.message;
            return false;
          }
          return true;
        },
      },
    ],
  });
}

/* Called after a redirect back from Discord. Two things can be waiting: a
   password the user asked to set, and a claim code they entered before they
   had an account to claim it into. Both would otherwise be silently lost
   across the OAuth round trip, which is exactly the kind of small breakage
   that makes an auth flow feel unreliable. */
export async function resumeAfterRedirect(onDone) {
  redraw = onDone || (() => {});
  let pending = null;
  let claimCode = null;
  let returnPath = null;
  try {
    pending = sessionStorage.getItem('brackets.afterAuth');
    claimCode = sessionStorage.getItem('brackets.pendingClaim');
    returnPath = validReturnPath(sessionStorage.getItem(RETURN_AFTER_AUTH));
    sessionStorage.removeItem('brackets.afterAuth');
    sessionStorage.removeItem('brackets.pendingClaim');
    sessionStorage.removeItem(RETURN_AFTER_AUTH);
  } catch { /* private mode */ }

  if (claimCode && auth.isSignedIn()) {
    try {
      const claimed = await auth.claim(claimCode);
      snack(`Claimed — ${claimed.tag}'s results are now on your profile.`);
      redraw();
    } catch (err) { snack(err.message); }
  }

  if (pending === 'set-password' && auth.isSignedIn()) openSetPassword();

  /* Route restoration happens after the account exists and after any claim
     waiting on it. It only redraws the invite; the join action still requires
     its own explicit activation on the event summary. */
  if (returnPath && auth.isSignedIn()) {
    if (window.location.hash !== returnPath) window.location.hash = returnPath;
    else redraw();
  }
}

/* app.js imports this module before auth boot. Listening here lets both a
   local sign-in and a returning OAuth session resume the same stored intent
   without adding a second auth coordinator to the application shell. Defer
   the work: provider callbacks should finish before any follow-up RPC runs. */
let resumeScheduled = false;
auth.onAuth(() => {
  if (!auth.isSignedIn() || resumeScheduled) return;
  let hasWork = false;
  try {
    hasWork = Boolean(sessionStorage.getItem(RETURN_AFTER_AUTH)
      || sessionStorage.getItem('brackets.afterAuth')
      || sessionStorage.getItem('brackets.pendingClaim'));
  } catch { /* private mode */ }
  if (!hasWork) return;
  resumeScheduled = true;
  setTimeout(async () => {
    try { await resumeAfterRedirect(redraw); }
    finally { resumeScheduled = false; }
  }, 0);
});

export function openSetPassword() {
  dialog({
    title: 'Set a password',
    body: html`
      <p class="body-medium">This adds a second way into the same account. Your Discord login keeps working.</p>
      <label class="field" style="margin-top:16px">
        <span class="field-label">New password</span>
        <input type="password" id="password" autocomplete="new-password">
      </label>
      <p class="field-help" id="note">At least 8 characters.</p>`,
    actions: [
      { label: 'Not now', kind: 'text' },
      {
        label: 'Set password',
        kind: 'filled',
        onClick: async (dlg) => {
          const password = dlg.querySelector('#password').value;
          const note = dlg.querySelector('#note');
          if (password.length < 8) { note.textContent = 'At least 8 characters.'; return false; }
          try {
            await auth.addPasswordFallback(password);
            snack('Password set — you can now sign in either way.');
            redraw();
          } catch (err) { note.textContent = err.message; return false; }
          return true;
        },
      },
    ],
  });
}
