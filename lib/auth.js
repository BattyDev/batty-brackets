/* Brackets · identity
   ===========================================================================
   Discord first, email and password as a real fallback, and one person is one
   PLAYER regardless of how many ways they can sign in.

   ## The three problems this file exists to solve

   ### 1. "That email is already registered"

   Someone signs in with Discord in March. In August they come back, do not
   remember using Discord, and type their email and a new password. Every
   OAuth-first site in the world shows them "an account with this email already
   exists", which is true, useless, and reads like an accusation.

   What this does instead: before asking for a password, ask the SERVER which
   methods that email already has, and then say the specific thing --
   "codyadcock10@gmail.com signs in with Discord. Continue with Discord, or set
   a password to add email sign-in to the same account." Same account either
   way. The user never has to understand the word "identity".

   ### 2. Discord being unavailable is a venue emergency

   This is the part most sites get wrong by treating email fallback as a
   nice-to-have. If Discord's OAuth is down -- or the venue wifi captive portal
   is mangling the redirect, which is more common -- then a Discord-only TO
   cannot get into their own bracket while forty people stand around. So:

     * every account is PROMPTED to set a password once it has run an event
     * the prompt says why, in those words
     * a password is added to the SAME account, never a second one

   Email/password is not a lesser tier here. It is the redundancy that keeps an
   event running.

   ### 3. Most entrants at a local have no account at all

   Roughly a third of a local's entrants register at the door, and the TO types
   their tag into a phone. If identity requires a login, those people are
   ghosts: they have no history, and the "players exist outside events" promise
   quietly excludes exactly the people a local is made of.

   So a TO can create a CLAIMABLE player -- a real row, with real match
   history, that nobody has signed into yet. It carries a claim code. When that
   person eventually makes an account, they claim the row and inherit
   everything: every set, every placement, every head-to-head. See `claim()`.

   This is the difference between a bracket site and a scene's record.

   ---------------------------------------------------------------------------
   ## On running without a backend

   With no Supabase configured, everything here runs against local state. That
   is not a mock for the demo's sake -- it is how a TO with one phone and no
   account runs a 16-person weekly. The session is local, the players are
   local, and nothing is lost because nothing was ever meant to leave the
   device. `LOCAL_ONLY` is the flag; the UI says so plainly rather than
   pretending to be signed in to something.
   =========================================================================== */

'use strict';

import {
  apply, get, uid, getPlayer, getSession, setSession,
  cacheRemote, useConnectedScope, clearConnectedSession, storageScope,
} from './store.js';

let client = null;
let backend = null;
let session = null;
const listeners = new Set();

export const LOCAL_ONLY = Symbol('local-only');

export function onAuth(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) {
    try { fn(session); } catch (err) { console.error('[auth] listener threw', err); }
  }
}

export const currentSession = () => session;
export const currentPlayer = () => (session ? getPlayer(session.playerId) : null);
export const isSignedIn = () => Boolean(session);
/* Is there a server behind this at all? The UI has to know, because several
   things it offers are honest only when there is one -- Discord sign-in most
   of all, which cannot work without an OAuth redirect target. */
export const isRemote = () => Boolean(client);

/* --------------------------------------------------------------------------
   Boot
   -------------------------------------------------------------------------- */

export async function initAuth(supabaseClient, { connectedBackend = null } = {}) {
  client = supabaseClient;
  backend = connectedBackend;

  if (!client) {
    /* Local-only. Restore whoever was signed in on this device. */
    session = getSession();
    emit();
    return session;
  }

  const { data, error } = await client.auth.getSession();
  if (error) throw friendlyAuthError(error);
  if (data?.session) await adoptSupabaseSession(data.session);
  else {
    session = null;
    setSession(null);
  }

  client.auth.onAuthStateChange((event, next) => {
    /* Supabase invokes this callback while holding its auth lock. Defer the
       identity RPC so a slow server cannot deadlock token refresh. */
    setTimeout(async () => {
      try {
        if (event === 'SIGNED_OUT' || !next) {
          session = null;
          if (backend) clearConnectedSession();
          setSession(null);
          emit();
          return;
        }
        await adoptSupabaseSession(next);
      } catch (err) {
        console.error('[auth] could not resolve the connected identity', err);
        session = null;
        if (backend) clearConnectedSession();
        setSession(null);
        emit();
      }
    }, 0);
  });

  return session;
}

/* Turn a Supabase session into our session + player row. The auth UUID is an
   account identifier only. Tournament records use the durable player UUID
   returned by the reviewed bkt_identity RPC, so linking providers in Auth
   cannot accidentally create a second player or make auth.uid() a public row
   identifier. */
async function adoptSupabaseSession(sb) {
  const user = sb.user;
  const discord = user.identities?.find((i) => i.provider === 'discord');
  const meta = user.user_metadata || {};
  if (!backend) throw new Error('Connected authentication has no identity backend.');

  const changedAccount = session?.accountId && session.accountId !== user.id;
  session = null;
  setSession(null);
  const projectUrl = storageScope().projectUrl;
  if (!projectUrl) throw new Error('Connected authentication has no project scope.');
  useConnectedScope(projectUrl, user.id, { clearPrevious: Boolean(changedAccount) });
  const identity = await backend.identity(meta.custom_claims?.global_name || meta.full_name || meta.name || null);
  const existing = getPlayer(identity.id);
  const methods = [...new Set((user.identities || []).map((i) => i.provider))];
  /* Setting a password on an OAuth account does not create a second identity,
     so user.identities can remain Discord-only after a successful update.
     This metadata flag is only a UX memory (never authorization): it keeps us
     from asking for the same fallback again after a reload. */
  const remembersPassword = meta.brackets_password_fallback === true
    || user.app_metadata?.providers?.includes('email');
  if (user.email && remembersPassword && !methods.includes('email')) methods.push('email');
  const player = {
    id: identity.id,
    tag: identity.tag || existing?.tag || meta.custom_claims?.global_name || meta.full_name || meta.name
      || (user.email || '').split('@')[0] || 'Player',
    avatarUrl: existing?.avatarUrl || meta.avatar_url || null,
    discordId: discord?.id || existing?.discordId || null,
    discordName: meta.custom_claims?.global_name || meta.name || existing?.discordName || null,
    email: user.email || existing?.email || null,
    /* Which ways this person can get in. Drives the "you have no password
       set" prompt, which is the redundancy story above. */
    methods,
    createdAt: existing?.createdAt || user.created_at,
    claimable: false,
    claimCode: null,
  };
  cacheRemote({ players: [player] }, { silent: true });

  session = {
    playerId: player.id,
    accountId: user.id,
    email: user.email || null,
    methods: player.methods,
    /* A Discord-only account with no password is one Discord outage away from
       being locked out of its own event. */
    needsPasswordFallback: Boolean(user.email)
      && player.methods.includes('discord') && !player.methods.includes('email'),
    local: false,
  };
  setSession(session);
  emit();
  return session;
}

/* --------------------------------------------------------------------------
   Discord
   -------------------------------------------------------------------------- */

export async function signInWithDiscord() {
  /* This used to quietly call signInLocal and hand back a profile named
     "Local TO" as though OAuth had succeeded. It was reported as "Discord
     sign in doesn't work", and the report was right even though nothing
     errored: the button claimed to do one thing and did another. The UI now
     offers a device account explicitly when there is no server, so reaching
     here without a client means something is wrong rather than merely
     unconfigured. */
  if (!client) throw new Error('Discord sign-in needs a server, and none is connected yet. Use an email address or continue on this device.');

  const { error } = await client.auth.signInWithOAuth({
    provider: 'discord',
    options: {
      redirectTo: `${window.location.origin}${window.location.pathname}`,
      /* `identify` gives us the snowflake and display name; `email` is what
         makes the fallback below possible at all. We ask for nothing else --
         notably not `guilds`, which every second bracket site asks for and
         does not need. */
      scopes: 'identify email',
    },
  });
  if (error) throw error;
}

/* --------------------------------------------------------------------------
   Email
   --------------------------------------------------------------------------
   `methodsFor` is the function that makes the confusing case non-confusing.
   It answers "how does this email already get in?" BEFORE we ask for a
   password, so the UI can say the specific true thing rather than a generic
   error after the fact.

   It is served by an RPC (`bkt_auth_methods`) rather than a table read for a
   reason worth stating: the obvious implementation -- select from a users
   table where email = $1 -- is an account enumeration oracle, and a public
   one, since the key is in the page source. The RPC is rate-limited and
   returns only the method list for an exact match, never a "no such user"
   distinguishable from an empty list by timing. That is a deliberately modest
   protection: an attacker who really wants to know whether an email is
   registered will find out. The point is not to make it impossible, it is to
   avoid handing over a bulk-checkable endpoint.
   -------------------------------------------------------------------------- */

export async function methodsFor(email) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean) return [];

  if (!client) {
    const hit = Object.values(get().players).find((p) => (p.email || '').toLowerCase() === clean);
    return hit?.methods || [];
  }

  /* bkt_auth_methods is not part of the reviewed connected slice. Do not
     probe a missing RPC (or fall back to a table read); the UI treats null as
     unknown and offers the normal sign-in/create choices. */
  return null;
}

export async function signUpWithEmail(email, password, tag) {
  if (!client) return signInLocal({ tag: tag || email.split('@')[0], email, via: 'email' });

  const { data, error } = await client.auth.signUp({
    email, password,
    options: { data: { full_name: tag || '' } },
  });
  if (error) throw friendlyAuthError(error);
  return data;
}

export async function signInWithEmail(email, password) {
  if (!client) return signInLocal({ tag: email.split('@')[0], email, via: 'email' });

  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw friendlyAuthError(error);
  return data;
}

/* Add a password to an account that currently only has Discord. This is the
   same auth user -- `updateUser` on an active session -- so it adds a way in
   rather than making a second account. */
export async function addPasswordFallback(password) {
  if (!client) return { local: true };
  if (!session?.email) throw new Error('This Discord account has no verified email address to use for password sign-in.');

  const { error } = await client.auth.updateUser({
    password,
    /* Supabase keeps OAuth as the identity provider after a password is set.
       Remember the fallback explicitly so a reload does not prompt again.
       This is display state only; authentication remains entirely server-side. */
    data: { brackets_password_fallback: true },
  });
  if (error) throw friendlyAuthError(error);
  if (session) {
    session.methods = [...new Set([...session.methods, 'email'])];
    session.needsPasswordFallback = false;
    emit();
  }
  return { ok: true };
}

export async function sendPasswordReset(email) {
  if (!client) return { local: true };
  const { error } = await client.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}${window.location.pathname}`,
  });
  if (error) throw friendlyAuthError(error);
  return { ok: true };
}

export async function signOut() {
  try {
    if (client) await client.auth.signOut();
  } finally {
    session = null;
    if (backend) clearConnectedSession();
    setSession(null);
    emit();
  }
}

/* Supabase's auth errors are accurate and unhelpful. Every one of these
   rewrites tells the user what to DO, because "Invalid login credentials" has
   never once helped anybody. */
function friendlyAuthError(error) {
  const msg = String(error?.message || '');
  if (/already registered|already been registered/i.test(msg)) {
    return new Error('That email already has an account. Try signing in — or if you first signed up with Discord, use the Discord button and add a password afterwards.');
  }
  if (/invalid login credentials/i.test(msg)) {
    return new Error('That email and password did not match. If you originally signed in with Discord, use the Discord button instead — your account has no password yet.');
  }
  if (/password should be at least/i.test(msg)) {
    return new Error('Passwords need to be at least 8 characters.');
  }
  if (/email not confirmed/i.test(msg)) {
    return new Error('Check your email for the confirmation link, then sign in again.');
  }
  return new Error(msg || 'Something went wrong signing in.');
}

/* --------------------------------------------------------------------------
   Local-only session
   -------------------------------------------------------------------------- */

function signInLocal({ tag, email = null, via = 'local' }) {
  const existing = Object.values(get().players)
    .find((p) => (email && p.email === email) || (p.local && p.tag === tag));
  const id = existing?.id || uid('plr');

  apply('players', id, {
    id, tag, email, local: true, methods: [via],
    createdAt: existing?.createdAt || new Date().toISOString(),
    claimable: false,
  });

  session = { playerId: id, email, methods: [via], needsPasswordFallback: false, local: true };
  setSession(session);
  emit();
  return session;
}

export { signInLocal };

/* Adopt a session for an existing local player.
   --------------------------------------------------------------------------
   Used by the guided demo to borrow a demo entrant's identity so the player
   views run their real queries rather than a mocked copy.

   It exists because auth keeps its own module-level `session` alongside the
   stored one, and writing only the stored copy leaves the two disagreeing --
   which is exactly what happened: the tour set the session, the store had it,
   and every view still rendered "sign in" because `currentPlayer()` reads the
   module copy. Anything that changes who is signed in goes through here. */
export function adoptLocalSession(next) {
  session = next || null;
  setSession(session);
  emit();
  return session;
}

/* --------------------------------------------------------------------------
   Claimable players — the walk-up entrant
   --------------------------------------------------------------------------
   A TO types a tag at the door. That creates a real player row with
   `claimable: true` and a short code. It has no auth user behind it, so nobody
   can sign in as it, but it accumulates results exactly like any other player.

   When the person makes their own account, `claim()` merges the placeholder
   into it: results are repointed, the placeholder is tombstoned with a pointer
   to the real row, and their history is simply there.

   ## The obvious abuse, and what stops it

   A claim code is a bearer token for someone else's tournament record. If it
   were guessable or long-lived, claiming a rival's account would be trivial.
   So:

     * the code is only valid while the placeholder has no auth user
     * it is scoped to the ORG that created it -- a code from one venue cannot
       claim a player row at another
     * a claim is recorded (who, when, from what device) and is reversible by
       the org that created the placeholder
     * a placeholder that has been in a PAID event cannot be self-claimed at
       all; it needs the TO to approve, because that is where the money is

   That last rule is the one that matters and it is enforced in the database,
   not here -- see `bkt_claim_player` in sql/001_schema.sql. This function is
   the client half of it.
   -------------------------------------------------------------------------- */

export function createClaimablePlayer({ tag, orgId, createdBy, extra = {} }) {
  const id = uid('plr');
  const code = claimCode();
  apply('players', id, {
    id, tag: String(tag).trim(), claimable: true, claimCode: code,
    claimOrgId: orgId || null, createdBy: createdBy || null,
    createdAt: new Date().toISOString(),
    methods: [], email: null,
    ...extra,
  });
  return { id, code };
}

function claimCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 8 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

/* Merge a claimable placeholder into the signed-in player. Local half; with a
   backend the same call goes through the RPC so the checks above are enforced
   somewhere the client cannot skip. */
export async function claim(code) {
  const me = currentPlayer();
  if (!me) throw new Error('Sign in first, then claim.');

  /* The reviewed connected slice does not yet include the organiser-side
     walk-up command. Its server claim RPC accepts a 64-character token while
     the excluded admin view still creates local eight-character codes. Keep
     this boundary explicit instead of sending the old p_into signature or
     pretending a local placeholder exists on the server. */
  if (client) {
    throw new Error('Claiming walk-up entries is not available in connected mode yet. Ask the organiser to add you after the server roster flow is enabled.');
  }

  const target = Object.values(get().players)
    .find((p) => p.claimable && p.claimCode === String(code || '').toUpperCase().trim());
  if (!target) throw new Error('That claim code did not match anything. Ask the organiser to read it out again.');
  if (target.id === me.id) throw new Error('That is already your account.');

  /* Repoint everything that referenced the placeholder. Done here rather than
     left to a foreign key so the local copy is correct immediately -- the
     player should see their history the moment they claim, not after a sync. */
  const state = get();
  for (const entry of Object.values(state.entries)) {
    if (entry.playerId === target.id) apply('entries', entry.id, { playerId: me.id });
  }
  for (const result of Object.values(state.results)) {
    const patch = {};
    if (result.winnerPlayerId === target.id) patch.winnerPlayerId = me.id;
    if (result.loserPlayerId === target.id) patch.loserPlayerId = me.id;
    if (Object.keys(patch).length) apply('results', result.id, patch);
  }

  /* Tombstone rather than delete. A deleted row breaks any link already shared
     -- a bracket posted in Discord in March still points at the placeholder --
     and the pointer lets those links redirect instead of 404. */
  apply('players', target.id, {
    claimable: false, claimCode: null,
    mergedInto: me.id, mergedAt: new Date().toISOString(),
  });

  /* Keep the better display name. A TO's door-desk spelling of someone's tag
     is often the one the scene actually uses. */
  if (!me.tag || me.tag === 'Player') apply('players', me.id, { tag: target.tag });

  return target;
}

/* --------------------------------------------------------------------------
   Connected platform accounts
   --------------------------------------------------------------------------
   Which of these matter is not a matter of taste -- it is operational:

     * PSN / Steam / Nintendo IDs are how an ONLINE set actually gets started.
       Without them a TO is asking in Discord at the moment the set is called.
       Tokon is crossplay PS5/PC, so a Tokon entrant needs whichever one they
       are on, and the check-in step verifies they have it.
     * Twitch / YouTube are how a set becomes a VOD on a profile.
     * start.gg is the IMPORT path -- the reason someone's history here is not
       empty on day one. See the README.
     * Bluesky and X are how a scene talks. Low value to the software, high
       value to the player deciding whether this profile is worth filling in.

   Stored per player, not per event, which is the entire point: enter the ID
   once, and every event you ever sign up for already has it.
   -------------------------------------------------------------------------- */

export const CONNECTIONS = [
  { id: 'discord', label: 'Discord', kind: 'auth', help: 'How you sign in, and where "you are up next" is sent.' },
  { id: 'psn', label: 'PlayStation Network', kind: 'platform', help: 'Needed to start an online Tokon set on PS5.' },
  { id: 'steam', label: 'Steam', kind: 'platform', help: 'Needed to start an online Tokon set on PC.' },
  { id: 'nintendo', label: 'Nintendo', kind: 'platform', help: 'Friend code, for online Smash.' },
  { id: 'startgg', label: 'start.gg', kind: 'import', help: 'Import your past results so your record here is not empty.' },
  { id: 'twitch', label: 'Twitch', kind: 'media', help: 'Sets you played on stream get linked back to your profile.' },
  { id: 'youtube', label: 'YouTube', kind: 'media', help: 'For VODs of your sets.' },
  { id: 'bluesky', label: 'Bluesky', kind: 'social' },
  { id: 'x', label: 'X', kind: 'social' },
];

export function setConnection(playerId, connectionId, handle) {
  const player = getPlayer(playerId);
  if (!player) return;
  const connections = { ...(player.connections || {}) };
  if (handle) connections[connectionId] = String(handle).trim();
  else delete connections[connectionId];
  apply('players', playerId, { connections });
}

/* Whether a player can actually be put on a station for this event. The run
   view calls this before calling a set, so "we cannot start because nobody
   knows his PSN" is caught at check-in instead of at the station. */
export function readinessFor(player, event) {
  const problems = [];
  if (!player) return [{ level: 'error', text: 'No player record.' }];

  if (event?.venueType === 'online') {
    const needs = event.platforms || [];
    const has = player.connections || {};
    if (needs.includes('ps5') && needs.includes('pc')) {
      if (!has.psn && !has.steam) {
        problems.push({ level: 'error', text: 'No PSN or Steam ID on file — an online set cannot be started.' });
      }
    } else if (needs.includes('ps5') && !has.psn) {
      problems.push({ level: 'error', text: 'No PSN ID on file.' });
    } else if (needs.includes('pc') && !has.steam) {
      problems.push({ level: 'error', text: 'No Steam ID on file.' });
    }
  }

  if (!player.connections?.discord && !player.email) {
    problems.push({ level: 'warn', text: 'No Discord or email — cannot be notified when their set is called.' });
  }
  return problems;
}
