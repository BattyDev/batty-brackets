/* Batty Brackets · platform administration
   ===========================================================================
   This page is deliberately independent from the event organiser console.
   It has its own Supabase storage namespace, its own authentication gate, and
   its own RPC adapter. A signed-in browser is not an admin browser: the page
   does not ask for a single admin RPC until the session has an AAL2 claim and
   bkt_admin_access has acknowledged the active server-side membership.
   =========================================================================== */

'use strict';

import * as captcha from './lib/captcha.js';

const STORAGE_KEY = 'batty-brackets-platform-admin';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const ADMIN_ROLES = new Set(['analyst', 'moderator', 'super_admin']);
const MODERATOR_ROLES = new Set(['moderator', 'super_admin']);
const TARGET_KINDS = ['player', 'org', 'event', 'entry', 'station', 'bracket', 'result'];
const QUEUE_STATES = ['open', 'quarantined', 'hidden', 'replaced', 'restored'];
const REPORT_STATES = ['open', 'reviewing', 'resolved', 'dismissed'];
const MODERATION_ACTIONS = ['hide', 'quarantine', 'restore', 'replace', 'lock'];

const VIEW_META = {
  overview: {
    label: 'Overview',
    description: 'A quick read on the platform, moderation health, and recent activity.',
  },
  queue: {
    label: 'Moderation queue',
    description: 'Review reported public fields and record a durable decision.',
    capability: 'can_queue',
  },
  content: {
    label: 'Content search',
    description: 'Search the whitelisted public content feed without exposing private contacts.',
    capability: 'can_content',
  },
  audit: {
    label: 'Audit log',
    description: 'Read the append-only record of platform moderation decisions.',
    capability: 'can_audit',
  },
  reports: {
    label: 'User reports',
    description: 'Review player-submitted reports and record a triage outcome.',
    capability: 'can_queue',
  },
  metrics: {
    label: 'Metrics',
    description: 'Measure platform activity over a bounded reporting window.',
    capability: 'can_analyze',
  },
};

const state = {
  client: null,
  session: null,
  access: null,
  view: 'overview',
  metrics: null,
  queue: null,
  content: null,
  audit: null,
  reports: null,
  filters: {
    queueState: '',
    queueSearch: '',
    contentKind: '',
    contentSearch: '',
    auditSearch: '',
    reportStatus: '',
    reportSearch: '',
    metricsFrom: '',
    metricsTo: '',
  },
  authFlow: null,
  authFlowKey: null,
  securityGeneration: 0,
  viewGeneration: 0,
  mfaPending: null,
  authNotice: null,
  testMode: false,
};

const appRoot = document.getElementById('platform-admin-app');
const statusRegion = document.getElementById('admin-status');
const alertRegion = document.getElementById('admin-alert');

/* --------------------------------------------------------------------------
   Small output helpers
   -------------------------------------------------------------------------- */

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttribute(value) { return escapeHtml(value); }

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString() : '0';
}

function shortRole(role) {
  return role === 'super_admin' ? 'Super admin' : role === 'moderator' ? 'Moderator' : role === 'analyst' ? 'Analyst' : 'Unknown actor';
}

function prettyToken(value) {
  return String(value ?? '')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function dateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function dateOnly(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

function displayValue(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return '[unavailable]'; }
  }
  return String(value);
}

function dataObject(result) {
  if (!result) return null;
  if (Object.prototype.hasOwnProperty.call(result, 'data')) return result.data;
  return result;
}

function resultError(result) {
  if (result?.error) return result.error;
  return null;
}

function errorMessage(error, fallback = 'Something went wrong. Try again.') {
  const message = String(error?.message || error || '').trim();
  return message || fallback;
}

function announce(message, { error = false } = {}) {
  const node = error ? alertRegion : statusRegion;
  if (!node) return;
  /* Clearing first makes repeated messages announce reliably in VoiceOver and
     NVDA, including two consecutive refresh errors with the same wording. */
  node.textContent = '';
  requestAnimationFrame(() => { node.textContent = String(message || ''); });
}

function focusSelector(selector) {
  requestAnimationFrame(() => {
    const element = document.querySelector(selector);
    if (!element) return;
    element.focus({ preventScroll: true });
  });
}

function viewFromHash() {
  const raw = String(location.hash || '').replace(/^#/, '').toLowerCase();
  const aliases = {
    moderation: 'queue',
    'moderation-queue': 'queue',
    'content-search': 'content',
    'audit-log': 'audit',
  };
  const view = aliases[raw] || raw;
  return VIEW_META[view] ? view : 'overview';
}

function normalizeAal(result) {
  const data = dataObject(result) || {};
  return {
    currentLevel: data.currentLevel || data.current_level || null,
    nextLevel: data.nextLevel || data.next_level || null,
  };
}

function normalizeFactors(result) {
  const data = dataObject(result) || {};
  const all = Array.isArray(data.all) ? data.all : [];
  const totp = Array.isArray(data.totp) ? data.totp : all.filter((factor) => factor?.factor_type === 'totp' || factor?.factorType === 'totp');
  return { all, totp };
}

function factorStatus(factor) {
  return String(factor?.status || '').toLowerCase();
}

function factorId(factor) { return factor?.id || factor?.factor_id || null; }

function normalizeChallenge(result) {
  const data = dataObject(result) || {};
  return data.id || data.challengeId || data.challenge_id || null;
}

function validAccess(access) {
  return Boolean(access)
    && access.active === true
    && ADMIN_ROLES.has(access.role)
    && access.aal === 'aal2';
}

function canView(view) {
  if (!state.access || !VIEW_META[view]) return false;
  const meta = VIEW_META[view];
  if (!meta.capability) return true;
  /* The role is an additional client-side guard. The RPC remains the
     authority, but an analyst should never even be offered moderator UI. */
  if (state.access.role === 'analyst' && view !== 'metrics') return false;
  if (MODERATOR_ROLES.has(state.access.role) && meta.capability === 'can_analyze') return true;
  return state.access[meta.capability] === true;
}

function allowedViews() {
  return Object.keys(VIEW_META).filter((view) => canView(view));
}

function adminShellMarkup() {
  const role = shortRole(state.access.role);
  const email = state.session?.user?.email || state.session?.email || 'Authenticated account';
  const nav = (mobile = false) => allowedViews().map((view) => {
    const current = state.view === view;
    return `<button class="nav-button" type="button" data-view="${view}"
      aria-current="${current ? 'page' : 'false'}">
      <span>${escapeHtml(VIEW_META[view].label)}</span>
      ${current ? '<span class="nav-button__meta" aria-hidden="true">●</span>' : ''}
    </button>`;
  }).join('');

  return `<main class="admin-app" aria-labelledby="page-title">
    <aside class="admin-sidebar" aria-label="Platform administration">
      <div class="brand-block">
        <p class="eyebrow">BattyDev</p>
        <h1 id="page-title">Platform Admin</h1>
        <p class="subtle">Site-wide controls for trusted staff.</p>
        <span class="role-pill">${escapeHtml(role)}</span>
      </div>
      <div>
        <p class="nav-label">Console</p>
        <nav class="admin-nav" aria-label="Admin views">${nav()}</nav>
      </div>
      <div class="sidebar-footer">
        <p class="subtle" title="${escapeAttribute(email)}">${escapeHtml(email)}</p>
        <button class="button button--secondary button--small" type="button" data-act="logout">Log out</button>
      </div>
    </aside>
    <section class="admin-main" aria-labelledby="view-title">
      <div class="view-tabs" aria-label="Admin views">${nav(true)}</div>
      <header class="admin-main-header">
        <div>
          <p class="section-kicker">${escapeHtml(role)} access</p>
          <h2 id="view-title">${escapeHtml(VIEW_META[state.view].label)}</h2>
          <p>${escapeHtml(VIEW_META[state.view].description)}</p>
        </div>
        <span class="status-pill">AAL2 verified</span>
      </header>
      <div id="admin-view-content" tabindex="-1"></div>
    </section>
  </main>`;
}

function renderAdminShell({ focus = true } = {}) {
  appRoot.innerHTML = adminShellMarkup();
  if (focus) focusSelector('#admin-view-content');
}

function renderCard({ title, body, wide = false, notice = '' } = {}) {
  return `<main class="admin-shell admin-shell--center" aria-labelledby="page-title">
    <section class="admin-card${wide ? ' admin-card--wide' : ''}">
      <p class="eyebrow">BattyDev</p>
      <h1 id="page-title">${escapeHtml(title || 'Platform Admin')}</h1>
      ${notice ? `<div class="notice notice--${notice.kind || 'info'}" role="${notice.kind === 'error' ? 'alert' : 'status'}">
        <div class="notice__content">${notice.icon ? `<span aria-hidden="true">${notice.icon}</span>` : ''}${notice.text || ''}</div>
      </div>` : ''}
      ${body || ''}
    </section>
  </main>`;
}

function renderLogin(message = null) {
  state.mfaPending = null;
  const notice = message ? { kind: 'error', text: escapeHtml(message) } : null;
  appRoot.innerHTML = renderCard({
    title: 'Platform Admin',
    notice,
    body: `<p class="lead">A restricted console for moderation, audit, and platform metrics.</p>
      <form class="form-stack" data-form="login" novalidate>
        <div class="field">
          <label for="admin-email">Email address</label>
          <input id="admin-email" name="email" type="email" autocomplete="username" inputmode="email" required autofocus>
        </div>
        <div class="field">
          <label for="admin-password">Password</label>
          <input id="admin-password" name="password" type="password" autocomplete="current-password" required>
        </div>
        ${captcha.enabled() ? '<div class="captcha-slot" data-hcaptcha-widget><span class="field-help">Loading anti-bot check…</span></div><p class="field-help">Complete this check to continue.</p>' : ''}
        <div class="button-row">
          <button class="button button--primary" type="submit" data-submit>Sign in</button>
        </div>
      </form>
      <p class="auth-footnote">Admin access requires a time-based one-time password. Your account must also have an active platform role; signing in alone never grants access.</p>`,
  });
  void captcha.mount(appRoot);
  focusSelector('#admin-email');
}

function renderSecurityLoading(message = 'Verifying your secure admin session…') {
  appRoot.innerHTML = renderCard({
    title: 'Verifying access',
    body: `<div class="loading-block" aria-live="polite"><span class="spinner" aria-hidden="true"></span><p>${escapeHtml(message)}</p></div>`,
  });
}

function renderMfa({ enrollment = false, qrCode = null, secret = null, error = null } = {}) {
  const heading = enrollment ? 'Set up admin verification' : 'Verify your admin session';
  const intro = enrollment
    ? 'Add a time-based one-time password before the platform console can open.'
    : 'Enter the six-digit code from your authenticator app to continue.';
  const qr = qrCode && /^(data:image\/(?:png|gif|jpe?g|webp|svg\+xml)|https:\/\/)/i.test(String(qrCode))
    ? `<div class="qr-wrap"><img src="${escapeAttribute(qrCode)}" alt="QR code for the Batty Brackets admin authenticator">
      <p class="subtle">Scan this code with your authenticator app.</p></div>`
    : '';
  const secretMarkup = secret
    ? `<p class="field-help">Can’t scan? Enter this setup key manually:<br><span class="secret-code">${escapeHtml(secret)}</span></p>`
    : '';
  const notice = error ? `<div class="notice notice--error" role="alert"><div class="notice__content">${escapeHtml(error)}</div></div>` : '';
  appRoot.innerHTML = renderCard({
    title: heading,
    body: `<p class="lead">${intro}</p>${qr}${secretMarkup}${notice}
      <form class="form-stack" data-form="mfa" novalidate>
        <div class="field">
          <label for="mfa-code">Authenticator code</label>
          <input id="mfa-code" class="mfa-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required autofocus aria-describedby="mfa-code-help">
          <p class="field-help" id="mfa-code-help">Use the current six-digit code. Codes change every few seconds.</p>
        </div>
        <div class="button-row">
          <button class="button button--primary" type="submit" data-submit>Verify and continue</button>
          <button class="button button--quiet" type="button" data-act="logout">Cancel</button>
        </div>
      </form>`,
  });
  focusSelector('#mfa-code');
}

function loadingBlock(label = 'Loading…') {
  return `<div class="loading-block" aria-live="polite"><span class="spinner" aria-hidden="true"></span><p>${escapeHtml(label)}</p></div>`;
}

function errorBlock(message, retryView = state.view) {
  return `<div class="notice notice--error" role="alert"><div class="notice__content"><strong>Couldn’t load this view.</strong><br>${escapeHtml(message)}</div>
    <button class="button button--secondary button--small" type="button" data-act="retry" data-view="${escapeAttribute(retryView)}">Try again</button></div>`;
}

function emptyState(title, message) {
  return `<div class="empty-state"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(message)}</p></div>`;
}

function metricCards(totals = {}, { includeModeration = false } = {}) {
  const entries = [
    ['events', 'Events'],
    ['organizations', 'Organizations'],
    ['players', 'Players'],
    ['entries', 'Entries'],
    ['results', 'Results'],
    ['active_events', 'Active events'],
  ];
  if (includeModeration) entries.push(['moderation', 'Moderation actions']);
  return `<div class="metric-grid">${entries.map(([key, label]) => {
    const value = key === 'moderation' ? '—' : number(totals[key]);
    return `<div class="metric-card"><span class="metric-card__label">${escapeHtml(label)}</span><strong class="metric-card__value">${escapeHtml(value)}</strong></div>`;
  }).join('')}</div>`;
}

function inlineStats(object = {}, labels = {}) {
  const entries = Object.entries(object);
  if (!entries.length) return emptyState('Nothing to show', 'The server returned no summary rows for this window.');
  return `<dl class="inline-stat-list">${entries.map(([key, value]) => `<div class="inline-stat"><dt>${escapeHtml(labels[key] || prettyToken(key))}</dt><dd>${escapeHtml(number(value))}</dd></div>`).join('')}</dl>`;
}

function statusesMarkup(statuses = []) {
  if (!Array.isArray(statuses) || !statuses.length) return emptyState('No event statuses yet', 'Status counts will appear as events are created.');
  const max = Math.max(1, ...statuses.map((row) => Number(row.count) || 0));
  return `<div class="bar-list">${statuses.map((row) => {
    const count = Number(row.count) || 0;
    return `<div class="bar-row"><span class="bar-row__label">${escapeHtml(prettyToken(row.status))}</span><span class="bar-track" aria-hidden="true"><span style="width:${Math.max(2, Math.round((count / max) * 100))}%"></span></span><span class="bar-row__value">${escapeHtml(number(count))}</span></div>`;
  }).join('')}</div>`;
}

function moderationSummaryMarkup(moderation = {}) {
  const labels = {
    open: 'Open', quarantined: 'Quarantined', hidden: 'Hidden', replaced: 'Replaced', restored: 'Restored', locked: 'Locked',
  };
  return inlineStats(moderation, labels);
}

/* --------------------------------------------------------------------------
   Admin views
   -------------------------------------------------------------------------- */

function renderOverview(data) {
  const totals = data?.totals || {};
  const moderation = data?.moderation || {};
  const roleNote = state.access.role === 'analyst'
    ? '<div class="notice notice--info" role="status"><div class="notice__content"><strong>Metrics-only role.</strong><br>Your role can inspect platform metrics. Moderation, content, and audit records are intentionally unavailable.</div></div>'
    : '';
  const shortcuts = MODERATOR_ROLES.has(state.access.role)
    ? `<div class="button-row"><button class="button button--secondary" type="button" data-view="queue">Open moderation queue</button><button class="button button--secondary" type="button" data-view="content">Search content</button></div>`
    : '';
  const generated = data?.generated_at ? `<p class="subtle">Generated ${escapeHtml(dateTime(data.generated_at))}</p>` : '';
  return `${roleNote}<div class="panel-grid">
    <section class="panel panel--span-12" aria-labelledby="overview-totals-title">
      <div class="panel-header"><div><h3 id="overview-totals-title">Platform snapshot</h3><p>Counts returned by the secure metrics RPC.</p></div>${generated}</div>
      ${metricCards(totals)}
    </section>
    <section class="panel panel--span-6" aria-labelledby="overview-status-title">
      <div class="panel-header"><div><h3 id="overview-status-title">Event statuses</h3><p>All current event records.</p></div></div>
      ${statusesMarkup(data?.statuses)}
    </section>
    <section class="panel panel--span-6" aria-labelledby="overview-moderation-title">
      <div class="panel-header"><div><h3 id="overview-moderation-title">Moderation health</h3><p>Queue state counts, including locked targets.</p></div></div>
      ${moderationSummaryMarkup(moderation)}
    </section>
    ${shortcuts ? `<section class="panel panel--span-12" aria-labelledby="overview-actions-title"><div class="panel-header"><div><h3 id="overview-actions-title">Staff actions</h3><p>Jump into the tools available to your role.</p></div></div>${shortcuts}</section>` : ''}
  </div>`;
}

function queueItemId(item) { return item?.id || item?.queue_id || ''; }

function moderationButtons(item) {
  const kind = item?.target_kind || item?.targetKind || '';
  const targetId = item?.target_id || item?.targetId || '';
  const field = item?.target_field || item?.targetField || '';
  if (!kind || !targetId) return '<span class="subtle">No action target</span>';
  const actions = kind === 'station' && field === 'match_id'
    ? MODERATION_ACTIONS.filter((action) => action !== 'replace')
    : MODERATION_ACTIONS;
  return `<div class="action-list" aria-label="Moderation actions for ${escapeAttribute(kind)}">
    ${actions.map((action) => `<button class="button button--secondary button--small" type="button" data-act="moderate" data-action="${action}" data-target-kind="${escapeAttribute(kind)}" data-target-id="${escapeAttribute(targetId)}" data-target-field="${escapeAttribute(field)}">${escapeHtml(prettyToken(action))}</button>`).join('')}
  </div>`;
}

function queueTable(items = []) {
  if (!items.length) return emptyState('Queue is clear', 'No moderation items match this state.');
  return `<div class="table-wrap"><table class="data-table"><caption>Moderation queue</caption><thead><tr><th scope="col">Target</th><th scope="col">State</th><th scope="col">Current value</th><th scope="col">Updated</th><th scope="col">Actions</th></tr></thead><tbody>${items.map((item) => {
    const kind = item.target_kind || item.targetKind || 'target';
    const targetId = item.target_id || item.targetId || '';
    const field = item.target_field || item.targetField || '';
    const queueState = item.state || 'open';
    return `<tr><td><strong>${escapeHtml(prettyToken(kind))}</strong><span class="subline mono">${escapeHtml(targetId)}</span><span class="subline">${escapeHtml(field || 'record')}</span></td>
      <td><span class="status-pill state-pill--${escapeAttribute(queueState)}">${escapeHtml(prettyToken(queueState))}</span></td>
      <td><div class="value-preview">${escapeHtml(displayValue(item.current_value ?? item.value ?? item.after_value ?? item.replacement_value ?? item.original_value))}</div>${item.reason ? `<span class="subline">Reason: ${escapeHtml(item.reason)}</span>` : ''}</td>
      <td>${escapeHtml(dateTime(item.updated_at || item.created_at))}</td><td>${moderationButtons({ target_kind: kind, target_id: targetId, target_field: field })}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function renderQueue(data) {
  const stateValue = state.filters.queueState;
  const options = [['', 'All states'], ...QUEUE_STATES.map((value) => [value, prettyToken(value)])];
  const next = data?.nextCursor ? `<button class="button button--secondary button--small" type="button" data-act="queue-more">Load more</button>` : '';
  return `<section class="panel-grid"><div class="panel panel--span-12">
    <form class="toolbar" data-form="queue-search"><div class="toolbar__filters"><div class="field"><label for="queue-state">Queue state</label><select id="queue-state" name="state" data-filter="queue-state">${options.map(([value, label]) => `<option value="${escapeAttribute(value)}" ${stateValue === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></div><div class="field"><label for="queue-search">Search queue</label><input id="queue-search" name="search" type="search" maxlength="200" autocomplete="off" placeholder="Search reason, target, or value" value="${escapeAttribute(state.filters.queueSearch)}"></div></div><div class="toolbar__actions"><button class="button button--primary" type="submit" data-submit>Search</button><button class="button button--secondary" type="button" data-act="refresh-view">Refresh</button>${next}</div></form>
    ${queueTable(data?.items || [])}
  </div></section>`;
}

function contentItemId(item) { return item?.target_id || item?.targetId || ''; }

function contentTable(items = []) {
  if (!items.length) return emptyState('No matching content', 'Try a different search phrase or content kind.');
  return `<div class="table-wrap"><table class="data-table"><caption>Searchable public content</caption><thead><tr><th scope="col">Kind</th><th scope="col">Field</th><th scope="col">Target ID</th><th scope="col">Value</th><th scope="col">Moderation</th><th scope="col">Actions</th></tr></thead><tbody>${items.map((item) => {
    const kind = item.target_kind || item.targetKind || 'target';
    const field = item.target_field || item.targetField || '';
    const id = contentItemId(item);
    const moderation = item.moderation || {};
    const moderationState = moderation.state || 'none';
    const structured = ['documents', 'overrides', 'record', 'seeding_report', 'signed_documents'].includes(field);
    const context = item.context || item.event_name || item.eventName || '';
    return `<tr><td>${escapeHtml(prettyToken(kind))}</td><td>${escapeHtml(field || 'record')}</td><td class="mono">${escapeHtml(id)}${context ? `<span class="subline">${escapeHtml(context)}</span>` : ''}</td><td><div class="value-preview${structured ? ' value-preview--structured' : ''}">${escapeHtml(displayValue(item.value))}</div></td><td>${moderationState === 'none' ? '<span class="subtle">No decision</span>' : `<span class="status-pill state-pill--${escapeAttribute(moderationState)}">${escapeHtml(prettyToken(moderationState))}</span>`}</td><td>${moderationButtons({ target_kind: kind, target_id: id, target_field: field })}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function renderContent(data) {
  const kindValue = state.filters.contentKind;
  const options = [['', 'All content'], ...TARGET_KINDS.map((value) => [value, prettyToken(value)])];
  const next = data?.nextCursor ? `<button class="button button--secondary button--small" type="button" data-act="content-more">Load more</button>` : '';
  return `<section class="panel-grid"><div class="panel panel--span-12">
    <form class="toolbar" data-form="content-search"><div class="toolbar__filters"><div class="field"><label for="content-search">Search content</label><input id="content-search" name="search" type="search" maxlength="200" autocomplete="off" placeholder="Search public value, kind, field, or ID" value="${escapeAttribute(state.filters.contentSearch)}"></div><div class="field"><label for="content-kind">Content kind</label><select id="content-kind" name="kind" data-filter="content-kind">${options.map(([value, label]) => `<option value="${escapeAttribute(value)}" ${kindValue === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></div></div><div class="toolbar__actions"><button class="button button--primary" type="submit" data-submit>Search</button><button class="button button--secondary" type="button" data-act="refresh-view">Refresh</button>${next}</div></form>
    ${contentTable(data?.items || [])}
  </div></section>`;
}

function auditTable(items = []) {
  if (!items.length) return emptyState('No audit entries', 'Moderation actions will appear here after a decision is recorded.');
  return `<div class="table-wrap"><table class="data-table"><caption>Platform moderation audit log</caption><thead><tr><th scope="col">When</th><th scope="col">Actor</th><th scope="col">Action</th><th scope="col">Target</th><th scope="col">Reason</th></tr></thead><tbody>${items.map((item) => {
    const kind = item.target_kind || item.targetKind || 'target';
    const targetId = item.target_id || item.targetId || '';
    const actor = item.actor_role || item.actorRole || 'admin';
    return `<tr><td>${escapeHtml(dateTime(item.created_at || item.createdAt))}</td><td>${escapeHtml(shortRole(item.admin_role || actor))}<span class="subline mono">${escapeHtml(item.admin_auth_user_id || item.actor_id || item.actorId || '')}</span></td><td><strong>${escapeHtml(prettyToken(item.action || 'decision'))}</strong><span class="subline">${escapeHtml(item.target_field || item.targetField || 'record')}</span></td><td>${escapeHtml(prettyToken(kind))}<span class="subline mono">${escapeHtml(targetId)}</span></td><td><div class="value-preview">${escapeHtml(item.reason || '—')}</div></td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function renderAudit(data) {
  const next = data?.nextCursor ? `<button class="button button--secondary button--small" type="button" data-act="audit-more">Load older</button>` : '';
  return `<section class="panel-grid"><div class="panel panel--span-12">
    <form class="toolbar" data-form="audit-search"><div class="toolbar__filters"><div class="field"><label for="audit-search">Search audit log</label><input id="audit-search" name="search" type="search" maxlength="200" autocomplete="off" placeholder="Search actor, action, target, or reason" value="${escapeAttribute(state.filters.auditSearch)}"><p class="field-help">Audit entries stay append-only; search runs on the server.</p></div></div><div class="toolbar__actions"><button class="button button--primary" type="submit" data-submit>Search</button><button class="button button--secondary" type="button" data-act="refresh-view">Refresh</button>${next}</div></form>
    ${auditTable(data?.items || [])}
  </div></section>`;
}

function reportTable(items = []) {
  if (!items.length) return emptyState('No reports match', 'Submitted reports will appear here as players flag public content.');
  return `<div class="table-wrap"><table class="data-table"><caption>Player-submitted content reports</caption><thead><tr><th scope="col">Submitted</th><th scope="col">Target</th><th scope="col">Report</th><th scope="col">Status</th><th scope="col">Review</th></tr></thead><tbody>${items.map((item) => {
    const id = item.id || item.report_id || '';
    const kind = item.target_kind || item.targetKind || 'target';
    const targetId = item.target_id || item.targetId || '';
    const field = item.target_field || item.targetField || 'record';
    const status = item.status || 'open';
    const targetValue = item.target_value ?? item.targetValue ?? item.current_value ?? item.value;
    const reviewNote = item.triage_note || item.triageNote || '';
    return `<tr><td>${escapeHtml(dateTime(item.submitted_at || item.created_at || item.createdAt))}<span class="subline mono">${escapeHtml(id)}</span></td><td><strong>${escapeHtml(prettyToken(kind))}</strong><span class="subline">${escapeHtml(field)}</span><span class="subline mono">${escapeHtml(targetId)}</span>${targetValue !== undefined ? `<div class="value-preview report-target-preview">${escapeHtml(displayValue(targetValue))}</div>` : ''}</td><td><div class="value-preview">${escapeHtml(item.reason || '—')}</div></td><td><span class="status-pill state-pill--${escapeAttribute(status)}">${escapeHtml(prettyToken(status))}</span>${reviewNote ? `<span class="subline">${escapeHtml(reviewNote)}</span>` : ''}</td><td><button class="button button--secondary button--small" type="button" data-act="review-report" data-report-id="${escapeAttribute(id)}" data-report-status="${escapeAttribute(status)}" data-report-note="${escapeAttribute(reviewNote)}">Update review</button></td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function renderReports(data) {
  const options = [['', 'All statuses'], ...REPORT_STATES.map((value) => [value, prettyToken(value)])];
  const next = data?.nextCursor ? `<button class="button button--secondary button--small" type="button" data-act="reports-more">Load more</button>` : '';
  return `<section class="panel-grid"><div class="panel panel--span-12">
    <form class="toolbar" data-form="reports-search"><div class="toolbar__filters"><div class="field"><label for="report-status">Report status</label><select id="report-status" name="status" data-filter="report-status">${options.map(([value, label]) => `<option value="${escapeAttribute(value)}" ${state.filters.reportStatus === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></div><div class="field"><label for="report-search">Search reports</label><input id="report-search" name="search" type="search" maxlength="200" autocomplete="off" placeholder="Search report reason, target, or field" value="${escapeAttribute(state.filters.reportSearch)}"></div></div><div class="toolbar__actions"><button class="button button--primary" type="submit" data-submit>Search</button><button class="button button--secondary" type="button" data-act="refresh-view">Refresh</button>${next}</div></form>
    ${reportTable(data?.items || [])}
  </div></section>`;
}

function dailyTable(daily = []) {
  if (!Array.isArray(daily) || !daily.length) return emptyState('No activity in this window', 'Try a wider date range to see daily event, entry, and result activity.');
  return `<div class="table-wrap"><table class="data-table daily-table"><caption>Daily platform activity</caption><thead><tr><th scope="col">Day</th><th scope="col">Events</th><th scope="col">Entries</th><th scope="col">Results</th></tr></thead><tbody>${daily.map((row) => `<tr><td>${escapeHtml(dateOnly(row.day))}</td><td>${escapeHtml(number(row.events))}</td><td>${escapeHtml(number(row.entries))}</td><td>${escapeHtml(number(row.results))}</td></tr>`).join('')}</tbody></table></div>`;
}

function metricsControls() {
  return `<form class="toolbar" data-form="metrics"><div class="toolbar__filters"><div class="date-range"><div class="field"><label for="metrics-from">From</label><input id="metrics-from" name="from" type="date" value="${escapeAttribute(state.filters.metricsFrom)}"></div><div class="field"><label for="metrics-to">To</label><input id="metrics-to" name="to" type="date" value="${escapeAttribute(state.filters.metricsTo)}"></div></div></div><div class="toolbar__actions"><button class="button button--primary" type="submit" data-submit>Update metrics</button></div></form>`;
}

function renderMetrics(data) {
  const totals = data?.totals || {};
  const moderation = data?.moderation || {};
  const windowText = data?.from || data?.to ? `Window: ${dateOnly(data.from)} – ${dateOnly(data.to)}` : 'Default window: the last 30 days';
  return `<section class="panel-grid"><div class="panel panel--span-12">${metricsControls()}<p class="subtle">${escapeHtml(windowText)}${data?.generated_at ? ` · Generated ${escapeHtml(dateTime(data.generated_at))}` : ''}</p></div>
    <section class="panel panel--span-12" aria-labelledby="metrics-totals-title"><div class="panel-header"><div><h3 id="metrics-totals-title">Totals</h3><p>Counts within the selected reporting window, where applicable.</p></div></div>${metricCards(totals)}</section>
    <section class="panel panel--span-6" aria-labelledby="metrics-status-title"><div class="panel-header"><div><h3 id="metrics-status-title">Event statuses</h3><p>Current status distribution.</p></div></div>${statusesMarkup(data?.statuses)}</section>
    <section class="panel panel--span-6" aria-labelledby="metrics-moderation-title"><div class="panel-header"><div><h3 id="metrics-moderation-title">Moderation queue</h3><p>Current state distribution.</p></div></div>${moderationSummaryMarkup(moderation)}</section>
    <section class="panel panel--span-12" aria-labelledby="metrics-daily-title"><div class="panel-header"><div><h3 id="metrics-daily-title">Daily activity</h3><p>Events created, entries registered, and results reported.</p></div></div>${dailyTable(data?.daily)}</section>
  </section>`;
}

function renderViewContent(markup) {
  const target = document.getElementById('admin-view-content');
  if (target) target.innerHTML = markup;
}

function renderViewLoading(label) { renderViewContent(loadingBlock(label)); }

function renderViewError(message) { renderViewContent(errorBlock(message)); }

/* --------------------------------------------------------------------------
   Supabase and test-only client selection
   -------------------------------------------------------------------------- */

function isLocalHost() { return LOCAL_HOSTS.has(String(location.hostname || '').toLowerCase()); }

function localTestFlag() {
  if (!isLocalHost()) return false;
  const params = new URLSearchParams(location.search);
  return params.has('platform-admin-test')
    || params.get('test') === '1'
    || params.get('test') === 'platform-admin'
    || window.__BATTY_PLATFORM_ADMIN_TEST__ === true;
}

function injectedTestClient() {
  if (!isLocalHost()) return null;
  const candidates = [
    window.__BATTY_PLATFORM_ADMIN_CLIENT__,
    window.__PLATFORM_ADMIN_CLIENT__,
    window.__SUPABASE_ADMIN_CLIENT__,
    window.__SUPABASE_MOCK__,
  ];
  return candidates.find((candidate) => candidate && typeof candidate === 'object' && candidate.auth && typeof candidate.rpc === 'function') || null;
}

function testRole() {
  const params = new URLSearchParams(location.search);
  const role = params.get('role') || params.get('platform-admin-role');
  return ADMIN_ROLES.has(role) ? role : 'moderator';
}

/* A tiny deterministic fixture is available only behind a localhost query
   flag. It makes the browser regression suite independent of a real project;
   it cannot be selected on a production hostname and is never used when the
   configured project has real credentials. */
function createLocalTestClient() {
  let session = null;
  let aal = 'aal1';
  let factors = [];
  let factorCounter = 0;
  const listeners = new Set();
  const role = testRole();
  const calls = [];
  const emit = (event, next) => listeners.forEach((listener) => listener(event, next));
  const adminSession = () => ({
    access_token: 'local-platform-admin-token',
    user: { id: '00000000-0000-4000-8000-000000000001', email: 'admin@example.test' },
  });
  const metrics = {
    role,
    from: new Date(Date.now() - 30 * 86400000).toISOString(),
    to: new Date().toISOString(),
    generated_at: new Date().toISOString(),
    totals: { events: 12, organizations: 5, players: 87, entries: 138, results: 94, active_events: 3 },
    statuses: [{ status: 'running', count: 3 }, { status: 'complete', count: 9 }],
    moderation: { open: 2, quarantined: 1, hidden: 0, replaced: 2, restored: 1, locked: 1 },
    daily: [{ day: new Date().toISOString(), events: 2, entries: 17, results: 12 }],
  };
  const queue = [
    { id: '00000000-0000-4000-8000-000000000101', target_kind: 'player', target_id: '00000000-0000-4000-8000-000000000201', target_field: 'tag', state: 'open', current_value: 'Example', updated_at: '2026-09-20T12:00:00Z', reason: null },
    { id: '00000000-0000-4000-8000-000000000102', target_kind: 'event', target_id: '00000000-0000-4000-8000-000000000202', target_field: 'documents', state: 'open', current_value: [{ id: 'conduct', version: 1 }], updated_at: '2026-09-19T12:00:00Z', reason: 'Report received' },
    { id: '00000000-0000-4000-8000-000000000103', target_kind: 'bracket', target_id: '00000000-0000-4000-8000-000000000202', target_field: 'record', state: 'quarantined', current_value: { matches: [] }, updated_at: '2026-09-18T12:00:00Z', reason: 'Malformed progression' },
  ];
  const content = [
    { target_kind: 'player', target_id: '00000000-0000-4000-8000-000000000201', target_field: 'tag', value: 'Example', moderation: null },
    { target_kind: 'event', target_id: '00000000-0000-4000-8000-000000000202', target_field: 'documents', value: [{ id: 'conduct', version: 1 }], moderation: null },
    { target_kind: 'event', target_id: '00000000-0000-4000-8000-000000000202', target_field: 'overrides', value: { matchFormat: { firstTo: 2 } }, moderation: null },
    { target_kind: 'bracket', target_id: '00000000-0000-4000-8000-000000000202', target_field: 'record', value: { matches: [{ id: 'final', winner: 'Example' }] }, moderation: null },
    { target_kind: 'bracket', target_id: '00000000-0000-4000-8000-000000000203', target_field: 'record', value: { matches: [{ id: 'semifinal', winner: 'Challenger' }] }, moderation: null },
    { target_kind: 'bracket', target_id: '00000000-0000-4000-8000-000000000204', target_field: 'record', value: { matches: [{ id: 'losers' }] }, moderation: null },
  ];
  const audit = [];
  const reports = [{
    id: '00000000-0000-4000-8000-000000000301', target_kind: 'event', target_id: '00000000-0000-4000-8000-000000000202', target_field: 'documents',
    reason: 'The conduct document contains an outdated policy.', status: 'open', submitted_at: '2026-09-18T10:00:00Z', target_value: [{ id: 'conduct' }], triage_note: null,
  }];
  const pageRows = (items, args = {}, searchFields = []) => {
    const term = String(args.p_search || '').trim().toLowerCase();
    const filtered = items.filter((item) => !term || searchFields.map((field) => item[field]).some((value) => JSON.stringify(value ?? '').toLowerCase().includes(term)));
    const offset = Math.max(0, Number(args.p_cursor?.offset) || 0);
    const page = filtered.slice(offset, offset + 2);
    return { items: page, next_cursor: offset + page.length < filtered.length ? { offset: offset + page.length } : null };
  };
  const auth = {
    async getSession() { return { data: { session }, error: null }; },
    onAuthStateChange(listener) { listeners.add(listener); return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } }; },
    async signInWithPassword() { session = adminSession(); aal = 'aal1'; factors = []; emit('SIGNED_IN', session); return { data: { session, user: session.user }, error: null }; },
    async signOut() { session = null; aal = 'aal1'; factors = []; emit('SIGNED_OUT', null); return { error: null }; },
    mfa: {
      async getAuthenticatorAssuranceLevel() { return { data: { currentLevel: aal, nextLevel: factors.length ? 'aal2' : 'aal1' }, error: null }; },
      async listFactors() { return { data: { all: factors, totp: factors }, error: null }; },
      async enroll() {
        const factor = { id: `local-factor-${++factorCounter}`, factor_type: 'totp', status: 'unverified', friendly_name: 'Batty Brackets Admin' };
        factors = [factor];
        return { data: { id: factor.id, type: 'totp', totp: { id: factor.id, secret: 'LOCAL-TEST-SECRET', qr_code: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="white"/><path d="M10 10h30v30H10zM80 10h30v30H80zM10 80h30v30H10zM55 55h12v12H55zM80 80h12v12H80z" fill="black"/></svg>' } }, error: null };
      },
      async challenge({ factorId }) { return { data: { id: `local-challenge-${factorId}` }, error: null }; },
      async verify() { aal = 'aal2'; factors = factors.map((factor) => ({ ...factor, status: 'verified' })); return { data: { verified: true }, error: null }; },
    },
  };
  return {
    auth,
    async rpc(name, args = {}) {
      calls.push({ name, args });
      if (name === 'bkt_admin_access') return { data: { active: true, role, aal: 'aal2', can_moderate: MODERATOR_ROLES.has(role), can_analyze: true, can_queue: MODERATOR_ROLES.has(role), can_content: MODERATOR_ROLES.has(role), can_audit: MODERATOR_ROLES.has(role) }, error: null };
      if (name === 'bkt_admin_metrics') return { data: { ...metrics, from: args.p_from || metrics.from, to: args.p_to || metrics.to }, error: null };
      if (name === 'bkt_admin_queue') {
        const filtered = args.p_state ? queue.filter((item) => item.state === args.p_state) : queue;
        return { data: { role, ...pageRows(filtered, args, ['target_kind', 'target_id', 'target_field', 'state', 'reason', 'current_value']) }, error: null };
      }
      if (name === 'bkt_admin_content') {
        const filtered = args.p_target_kind ? content.filter((item) => item.target_kind === args.p_target_kind) : content;
        return { data: { role, ...pageRows(filtered, args, ['target_kind', 'target_id', 'target_field', 'value']) }, error: null };
      }
      if (name === 'bkt_admin_audit') return { data: { role, ...pageRows(audit, args, ['action', 'target_kind', 'target_id', 'target_field', 'reason', 'admin_auth_user_id']) }, error: null };
      if (name === 'bkt_admin_reports') {
        const filtered = args.p_status ? reports.filter((item) => item.status === args.p_status) : reports;
        return { data: { role, ...pageRows(filtered, args, ['target_kind', 'target_id', 'target_field', 'reason', 'status']) }, error: null };
      }
      if (name === 'bkt_admin_review_report') {
        const report = reports.find((item) => item.id === args.p_report_id);
        if (report) { report.status = args.p_status; report.triage_note = args.p_note; }
        return { data: report || {}, error: null };
      }
      if (name === 'bkt_admin_moderate') {
        audit.unshift({ id: `local-audit-${Date.now()}`, actor_role: role, action: args.p_action, target_kind: args.p_target_kind, target_id: args.p_target_id, target_field: args.p_target_field, reason: args.p_reason, created_at: new Date().toISOString() });
        return { data: { action_id: `local-action-${Date.now()}`, ...args, content: null, queue: null }, error: null };
      }
      return { data: {}, error: null };
    },
    __calls: calls,
  };
}

async function selectClient() {
  const injected = injectedTestClient();
  if (injected) {
    state.testMode = true;
    return injected;
  }
  if (localTestFlag()) {
    state.testMode = true;
    const client = createLocalTestClient();
    window.__PLATFORM_ADMIN_TEST_CLIENT__ = client;
    window.__PLATFORM_ADMIN_TEST_CALLS__ = client.__calls;
    return client;
  }
  const config = window.BRACKETS_CONFIG;
  if (!config || typeof config !== 'object' || !String(config.url || '').trim() || !String(config.key || '').trim()) return null;
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/+esm');
  if (typeof createClient !== 'function') throw new Error('The secure authentication library did not load.');
  /* The literal storageKey is intentional: this namespace must never collide
     with the player/organiser session stored by the public app. */
  return createClient(config.url, config.key, {
    auth: {
      storageKey: 'batty-brackets-platform-admin',
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
    },
  });
}

/* --------------------------------------------------------------------------
   Security gate
   -------------------------------------------------------------------------- */

async function signOutClient() {
  try { if (state.client?.auth?.signOut) await state.client.auth.signOut(); } catch { /* still clear the page */ }
  clearAuthenticatedState();
}

function clearAuthenticatedState() {
  state.session = null;
  state.access = null;
  state.metrics = null;
  state.queue = null;
  state.content = null;
  state.audit = null;
  state.reports = null;
  state.authFlow = null;
  state.authFlowKey = null;
  state.mfaPending = null;
  state.securityGeneration += 1;
}

async function authorizeAdmin(session, generation) {
  if (generation !== state.securityGeneration) throw new Error('The session changed while access was being checked.');
  const response = await state.client.rpc('bkt_admin_access');
  const rpcError = resultError(response);
  if (rpcError) throw rpcError;
  const access = dataObject(response);
  /* No view is rendered with server data until this exact acknowledgement is
     valid. A malformed response is a denial, not a partial-access mode. */
  if (!validAccess(access)) throw new Error('This account does not have an active AAL2 platform admin role.');
  state.access = access;
  state.session = session;
  state.view = canView(viewFromHash()) ? viewFromHash() : 'overview';
  renderAdminShell();
  announce(`Admin access granted for ${shortRole(access.role)}. Showing ${VIEW_META[state.view].label}.`);
  await loadView(state.view);
}

async function beginSecurityFlow(session) {
  if (!session) { renderLogin(); return; }
  const generation = ++state.securityGeneration;
  state.session = session;
  state.access = null;
  renderSecurityLoading();
  const auth = state.client?.auth;
  if (!auth?.mfa?.getAuthenticatorAssuranceLevel || !auth.mfa.listFactors) {
    throw new Error('Multi-factor verification is unavailable for this session.');
  }
  const aalResult = await auth.mfa.getAuthenticatorAssuranceLevel();
  const aalError = resultError(aalResult);
  if (aalError) throw aalError;
  const aal = normalizeAal(aalResult);
  if (aal.currentLevel === 'aal2' && aal.nextLevel === 'aal2') {
    await authorizeAdmin(session, generation);
    return;
  }
  /* AAL1 is the only state from which enrollment/challenge is allowed. Do not
     use a metadata flag or a user role claim as a substitute. */
  const factorResult = await auth.mfa.listFactors();
  const factorError = resultError(factorResult);
  if (factorError) throw factorError;
  const factors = normalizeFactors(factorResult).totp;
  const verified = factors.find((factor) => factorStatus(factor) === 'verified');
  const pending = factors.find((factor) => factorId(factor));
  if (verified) {
    await waitForMfa({ factor: verified, enrollment: false, generation });
    await authorizeAdmin(session, generation);
    return;
  }
  if (pending) {
    await waitForMfa({ factor: pending, enrollment: true, generation, unverified: true });
    await authorizeAdmin(session, generation);
    return;
  }
  if (!auth.mfa.enroll) throw new Error('No authenticator is enrolled and enrollment is unavailable.');
  const enrollmentResult = await auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: 'Batty Brackets Platform Admin',
  });
  const enrollmentError = resultError(enrollmentResult);
  if (enrollmentError) throw enrollmentError;
  const enrollment = dataObject(enrollmentResult) || {};
  const totp = enrollment.totp || enrollment;
  const enrolledId = factorId(totp) || enrollment.id;
  if (!enrolledId) throw new Error('The authenticator enrollment did not return a factor ID.');
  await waitForMfa({
    factor: { id: enrolledId },
    enrollment: true,
    generation,
    qrCode: totp.qr_code || totp.qrCode || null,
    secret: totp.secret || null,
  });
  await authorizeAdmin(session, generation);
}

async function waitForMfa({ factor, enrollment, generation, qrCode = null, secret = null, unverified = false }) {
  const id = factorId(factor);
  if (!id) throw new Error('The authenticator factor is missing its ID.');
  return new Promise((resolve, reject) => {
    state.mfaPending = {
      factorId: id,
      enrollment,
      generation,
      qrCode,
      secret,
      unverified,
      resolve,
      reject,
    };
    renderMfa({ enrollment, qrCode, secret });
    announce(enrollment ? 'Authenticator enrollment is ready. Enter a code to verify it.' : 'Enter your authenticator code to finish signing in.');
  });
}

async function verifyMfaCode(form) {
  const pending = state.mfaPending;
  if (!pending || pending.generation !== state.securityGeneration) throw new Error('This verification step expired. Sign in again.');
  const input = form.elements.code;
  const code = String(input?.value || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) {
    input?.setAttribute('aria-invalid', 'true');
    throw new Error('Enter the six-digit code from your authenticator app.');
  }
  const mfa = state.client?.auth?.mfa;
  if (!mfa?.challenge || !mfa?.verify) throw new Error('Multi-factor verification is unavailable for this session.');
  const challengeResult = await mfa.challenge({ factorId: pending.factorId });
  const challengeError = resultError(challengeResult);
  if (challengeError) throw challengeError;
  const challengeId = normalizeChallenge(challengeResult);
  if (!challengeId) throw new Error('The authenticator challenge did not return an ID.');
  const verifyResult = await mfa.verify({ factorId: pending.factorId, challengeId, code });
  const verifyError = resultError(verifyResult);
  if (verifyError) throw verifyError;
  const aalResult = await mfa.getAuthenticatorAssuranceLevel();
  const aalError = resultError(aalResult);
  if (aalError) throw aalError;
  const aal = normalizeAal(aalResult);
  if (aal.currentLevel !== 'aal2' || aal.nextLevel !== 'aal2') throw new Error('The authenticator code was accepted, but the session is not a current AAL2 session.');
  const done = state.mfaPending;
  state.mfaPending = null;
  done.resolve(aal);
}

async function handleSecurityFailure(error) {
  const message = errorMessage(error, 'We could not verify this admin session.');
  state.mfaPending = null;
  state.access = null;
  state.session = null;
  announce(message, { error: true });
  /* Signing out on any failed gate prevents a stale AAL1 session from
     accidentally being reused after a reload. No admin data was requested. */
  try { if (state.client?.auth?.signOut) await state.client.auth.signOut(); } catch { /* fail closed locally */ }
  clearAuthenticatedState();
  renderLogin(message);
}

function startSecurityFlow(session) {
  const key = session?.access_token || session?.user?.id || session?.user?.email || 'session';
  if (state.authFlow && state.authFlowKey === key) return state.authFlow;
  state.authFlowKey = key;
  state.authFlow = beginSecurityFlow(session)
    .catch((error) => handleSecurityFailure(error))
    .finally(() => {
      if (state.authFlowKey === key) state.authFlow = null;
    });
  return state.authFlow;
}

/* --------------------------------------------------------------------------
   RPC-backed view loading
   -------------------------------------------------------------------------- */

async function adminRpc(name, args = {}) {
  if (!state.access || !validAccess(state.access)) throw new Error('Admin access has expired. Sign in again.');
  const response = await state.client.rpc(name, args);
  const error = resultError(response);
  if (error) throw error;
  const data = dataObject(response);
  if (data === null || data === undefined) throw new Error('The server returned no data.');
  return data;
}

function pageResult(data, existing = null, append = false) {
  const items = Array.isArray(data?.items) ? data.items : [];
  return {
    ...data,
    items: append && Array.isArray(existing?.items) ? [...existing.items, ...items] : items,
    nextCursor: data?.next_cursor ?? data?.nextCursor ?? null,
  };
}

async function loadView(view, { cursor = null, append = false } = {}) {
  if (!state.access || !canView(view)) return;
  const generation = ++state.viewGeneration;
  const target = document.getElementById('admin-view-content');
  if (target) target.innerHTML = loadingBlock(`Loading ${VIEW_META[view].label.toLowerCase()}…`);
  try {
    if (view === 'overview') {
      state.metrics = await adminRpc('bkt_admin_metrics', { p_from: null, p_to: null });
      if (generation !== state.viewGeneration || state.view !== view) return;
      renderViewContent(renderOverview(state.metrics));
    } else if (view === 'metrics') {
      const from = state.filters.metricsFrom ? dateStartIso(state.filters.metricsFrom) : null;
      const to = state.filters.metricsTo ? dateEndIso(state.filters.metricsTo) : null;
      state.metrics = await adminRpc('bkt_admin_metrics', { p_from: from, p_to: to });
      if (generation !== state.viewGeneration || state.view !== view) return;
      renderViewContent(renderMetrics(state.metrics));
    } else if (view === 'queue') {
      const data = await adminRpc('bkt_admin_queue', {
        p_state: state.filters.queueState || null,
        p_search: state.filters.queueSearch.trim() || null,
        p_limit: 100, p_cursor: cursor,
      });
      if (generation !== state.viewGeneration || state.view !== view) return;
      state.queue = pageResult(data, state.queue, append);
      renderViewContent(renderQueue(state.queue));
    } else if (view === 'content') {
      const data = await adminRpc('bkt_admin_content', {
        p_target_kind: state.filters.contentKind || null,
        p_search: state.filters.contentSearch.trim() || null,
        p_limit: 100, p_cursor: cursor,
      });
      if (generation !== state.viewGeneration || state.view !== view) return;
      state.content = pageResult(data, state.content, append);
      renderViewContent(renderContent(state.content));
    } else if (view === 'audit') {
      const data = await adminRpc('bkt_admin_audit', {
        p_search: state.filters.auditSearch.trim() || null,
        p_limit: 100, p_cursor: cursor,
      });
      if (generation !== state.viewGeneration || state.view !== view) return;
      state.audit = pageResult(data, state.audit, append);
      renderViewContent(renderAudit(state.audit));
    } else if (view === 'reports') {
      const data = await adminRpc('bkt_admin_reports', {
        p_status: state.filters.reportStatus || null,
        p_search: state.filters.reportSearch.trim() || null,
        p_limit: 100, p_cursor: cursor,
      });
      if (generation !== state.viewGeneration || state.view !== view) return;
      state.reports = pageResult(data, state.reports, append);
      renderViewContent(renderReports(state.reports));
    }
    announce(`${VIEW_META[view].label} loaded.`);
  } catch (error) {
    if (generation !== state.viewGeneration || state.view !== view) return;
    renderViewError(errorMessage(error, `The ${VIEW_META[view].label.toLowerCase()} could not be loaded.`));
    announce(errorMessage(error), { error: true });
  }
}

function dateStartIso(value) { return new Date(`${value}T00:00:00.000Z`).toISOString(); }
function dateEndIso(value) { return new Date(`${value}T23:59:59.999Z`).toISOString(); }

function navigate(view) {
  if (!VIEW_META[view] || !canView(view)) return;
  if (location.hash.replace(/^#/, '') !== view) {
    location.hash = view;
    return;
  }
  state.view = view;
  renderAdminShell();
  loadView(view);
}

/* --------------------------------------------------------------------------
   Moderation dialog
   -------------------------------------------------------------------------- */

function closeDialog(dialog) {
  if (!dialog) return;
  try { dialog.close(); } catch { /* already closed */ }
  dialog.remove();
}

function openModerationDialog({ action, targetKind, targetId, targetField }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'admin-dialog';
  dialog.setAttribute('aria-labelledby', 'moderation-dialog-title');
  const jsonField = ['documents', 'overrides', 'platforms', 'signed_documents', 'seeding_report', 'record'].includes(targetField);
  const replaceHelp = jsonField
    ? 'Enter valid JSON matching this structured field. This change is audited.'
    : 'Enter a replacement value for this public field.';
  const replacement = action === 'replace'
    ? `<div class="field"><label for="moderation-replacement">Replacement ${jsonField ? 'JSON' : 'value'}</label>${jsonField ? '<textarea id="moderation-replacement" name="replacement" spellcheck="false" required></textarea>' : '<input id="moderation-replacement" name="replacement" type="text" required>'}<p class="field-help">${replaceHelp}</p></div>`
    : '';
  dialog.innerHTML = `<form method="dialog" class="admin-card" data-form="moderation"><p class="eyebrow">Moderation decision</p><h2 id="moderation-dialog-title">${escapeHtml(prettyToken(action))} ${escapeHtml(prettyToken(targetKind))}</h2><p class="muted">This decision is recorded in the append-only audit log and applied through the secure moderation RPC.</p><div class="notice notice--info" role="status"><div class="notice__content"><strong>Target</strong><br><span class="mono">${escapeHtml(targetId)}</span> · ${escapeHtml(targetField || 'record')}</div></div>${replacement}<div class="field"><label for="moderation-reason">Reason</label><textarea id="moderation-reason" name="reason" maxlength="2000" placeholder="Why is this decision being made?" required></textarea></div><div class="button-row"><button class="button button--quiet" type="button" data-act="close-dialog">Cancel</button><button class="button button--primary" type="submit" data-submit>Apply ${escapeHtml(prettyToken(action))}</button></div><p class="sr-only" data-dialog-status role="alert" aria-live="assertive"></p></form>`;
  document.body.append(dialog);
  dialog.addEventListener('cancel', () => closeDialog(dialog));
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeDialog(dialog);
  });
  dialog.querySelector('[data-act="close-dialog"]')?.addEventListener('click', () => closeDialog(dialog));
  dialog.querySelector('form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('[data-submit]');
    const note = form.querySelector('[data-dialog-status]');
    let replacementValue = null;
    try {
      if (action === 'replace') {
        const raw = String(form.elements.replacement?.value || '').trim();
        if (!raw) throw new Error('Enter a replacement value.');
        if (jsonField) {
          try { replacementValue = JSON.parse(raw); } catch { throw new Error('Replacement JSON is not valid.'); }
        } else replacementValue = raw;
      }
      const reason = String(form.elements.reason?.value || '').trim();
      if (!reason) {
        form.elements.reason?.setAttribute('aria-invalid', 'true');
        throw new Error('Enter a reason for this moderation decision.');
      }
      submit.disabled = true;
      submit.setAttribute('aria-busy', 'true');
      const data = await adminRpc('bkt_admin_moderate', {
        p_action: action,
        p_target_kind: targetKind,
        p_target_id: targetId,
        p_target_field: targetField || null,
        p_replacement: replacementValue,
        p_reason: reason,
      });
      closeDialog(dialog);
      announce(`${prettyToken(action)} decision recorded for ${prettyToken(targetKind)}.`);
      if (state.view === 'queue') await loadView('queue');
      if (state.view === 'content') await loadView('content');
      if (state.view === 'overview' || state.view === 'metrics') await loadView(state.view);
      void data;
    } catch (error) {
      submit.disabled = false;
      submit.removeAttribute('aria-busy');
      note.textContent = errorMessage(error, 'The moderation decision could not be recorded.');
      inputInvalidIfNeeded(form, action, error);
    }
  });
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  focusSelector('#moderation-replacement, #moderation-reason');
}

function inputInvalidIfNeeded(form, action, error) {
  if (action === 'replace' && /replacement/i.test(errorMessage(error))) {
    form.elements.replacement?.setAttribute('aria-invalid', 'true');
  }
}

/* --------------------------------------------------------------------------
   Event handling
   -------------------------------------------------------------------------- */

async function submitLogin(form) {
  const email = String(form.elements.email?.value || '').trim();
  const password = String(form.elements.password?.value || '');
  const submit = form.querySelector('[data-submit]');
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    form.elements.email?.setAttribute('aria-invalid', 'true');
    throw new Error('Enter a valid email address.');
  }
  if (!password) {
    form.elements.password?.setAttribute('aria-invalid', 'true');
    throw new Error('Enter your password.');
  }
  const captchaToken = captcha.token(form);
  if (captcha.enabled() && !captchaToken) throw new Error('Complete the anti-bot checkbox first.');
  submit.disabled = true;
  submit.setAttribute('aria-busy', 'true');
  renderSecurityLoading('Signing in and preparing secure verification…');
  const response = await state.client.auth.signInWithPassword({ email, password, options: { captchaToken } });
  const error = resultError(response);
  if (error) throw error;
  const data = dataObject(response) || {};
  const session = data.session || (data.user ? data : null);
  if (!session) throw new Error('Sign-in did not return a session.');
  await startSecurityFlow(session);
}

async function submitMetrics(form) {
  const from = String(form.elements.from?.value || '');
  const to = String(form.elements.to?.value || '');
  if ((from && !to) || (!from && to)) throw new Error('Choose both dates, or leave both dates blank.');
  if (from && to && new Date(`${from}T00:00:00Z`) >= new Date(`${to}T23:59:59Z`)) throw new Error('The end date must be after the start date.');
  if (from && to) {
    const days = (new Date(`${to}T23:59:59Z`) - new Date(`${from}T00:00:00Z`)) / 86400000;
    if (days > 366) throw new Error('Choose a reporting window of 366 days or less.');
  }
  state.filters.metricsFrom = from;
  state.filters.metricsTo = to;
  await loadView('metrics');
}

async function handleRootSubmit(event) {
  const form = event.target.closest('form');
  if (!form) return;
  event.preventDefault();
  try {
    if (form.dataset.form === 'login') await submitLogin(form);
    else if (form.dataset.form === 'mfa') await verifyMfaCode(form);
    else if (form.dataset.form === 'metrics') await submitMetrics(form);
    else if (form.dataset.form === 'queue-search') {
      state.filters.queueSearch = String(form.elements.search?.value || '').trim();
      await loadView('queue');
    } else if (form.dataset.form === 'content-search') {
      state.filters.contentSearch = String(form.elements.search?.value || '').trim();
      await loadView('content');
    } else if (form.dataset.form === 'audit-search') {
      state.filters.auditSearch = String(form.elements.search?.value || '').trim();
      await loadView('audit');
    } else if (form.dataset.form === 'reports-search') {
      state.filters.reportSearch = String(form.elements.search?.value || '').trim();
      await loadView('reports');
    }
  } catch (error) {
    const message = errorMessage(error);
    const note = form.closest('.admin-card')?.querySelector('.notice--error') || form.querySelector('[data-dialog-status]');
    if (note) {
      note.textContent = message;
      note.classList.remove('sr-only');
      note.setAttribute('role', 'alert');
    } else if (form.dataset.form === 'mfa') {
      renderMfa({ enrollment: Boolean(state.mfaPending?.enrollment), qrCode: state.mfaPending?.qrCode, secret: state.mfaPending?.secret, error: message });
    } else {
      renderLogin(message);
    }
    announce(message, { error: true });
  }
}

async function handleRootClick(event) {
  const viewButton = event.target.closest('[data-view]');
  if (viewButton && appRoot.contains(viewButton)) {
    event.preventDefault();
    navigate(viewButton.dataset.view);
    return;
  }
  const logout = event.target.closest('[data-act="logout"]');
  if (logout) {
    event.preventDefault();
    await signOutClient();
    renderLogin('You have been signed out.');
    announce('Signed out.');
    return;
  }
  const retry = event.target.closest('[data-act="retry"]');
  if (retry) { await loadView(retry.dataset.view || state.view); return; }
  const refresh = event.target.closest('[data-act="refresh-view"]');
  if (refresh) { await loadView(state.view); return; }
  const moreQueue = event.target.closest('[data-act="queue-more"]');
  if (moreQueue) { await loadView('queue', { cursor: state.queue?.nextCursor || null, append: true }); return; }
  const moreContent = event.target.closest('[data-act="content-more"]');
  if (moreContent) { await loadView('content', { cursor: state.content?.nextCursor || null, append: true }); return; }
  const moreAudit = event.target.closest('[data-act="audit-more"]');
  if (moreAudit) { await loadView('audit', { cursor: state.audit?.nextCursor || null, append: true }); return; }
  const moreReports = event.target.closest('[data-act="reports-more"]');
  if (moreReports) { await loadView('reports', { cursor: state.reports?.nextCursor || null, append: true }); return; }
  const reviewReport = event.target.closest('[data-act="review-report"]');
  if (reviewReport) {
    openReportReviewDialog({ reportId: reviewReport.dataset.reportId, status: reviewReport.dataset.reportStatus, note: reviewReport.dataset.reportNote || '' });
    return;
  }
  const moderate = event.target.closest('[data-act="moderate"]');
  if (moderate) {
    event.preventDefault();
    openModerationDialog({ action: moderate.dataset.action, targetKind: moderate.dataset.targetKind, targetId: moderate.dataset.targetId, targetField: moderate.dataset.targetField || null });
  }
}

function handleRootChange(event) {
  const filter = event.target.closest('[data-filter]');
  if (!filter) return;
  if (filter.dataset.filter === 'queue-state') {
    state.filters.queueState = filter.value;
    state.filters.queueSearch = String(filter.form?.elements.search?.value || '').trim();
    loadView('queue');
  } else if (filter.dataset.filter === 'content-kind') {
    state.filters.contentKind = filter.value;
    state.filters.contentSearch = String(filter.form?.elements.search?.value || '').trim();
    loadView('content');
  } else if (filter.dataset.filter === 'report-status') {
    state.filters.reportStatus = filter.value;
    state.filters.reportSearch = String(filter.form?.elements.search?.value || '').trim();
    loadView('reports');
  }
}

function openReportReviewDialog({ reportId, status = 'open', note = '' }) {
  if (!reportId) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'admin-dialog';
  dialog.setAttribute('aria-labelledby', 'report-review-title');
  dialog.innerHTML = `<form method="dialog" class="admin-card" data-form="report-review"><p class="eyebrow">User report</p><h2 id="report-review-title">Update report review</h2><p class="muted">This triage update is recorded in the append-only admin audit log.</p><div class="notice notice--info" role="status"><div class="notice__content"><strong>Report</strong><br><span class="mono">${escapeHtml(reportId)}</span></div></div><div class="field"><label for="report-review-status">Review status</label><select id="report-review-status" name="status">${REPORT_STATES.map((value) => `<option value="${value}" ${status === value ? 'selected' : ''}>${escapeHtml(prettyToken(value))}</option>`).join('')}</select></div><div class="field"><label for="report-review-note">Staff note <span class="subtle">(optional)</span></label><textarea id="report-review-note" name="note" maxlength="1200" placeholder="Record the triage outcome or context">${escapeHtml(note)}</textarea></div><div class="button-row"><button class="button button--quiet" type="button" data-act="close-dialog">Cancel</button><button class="button button--primary" type="submit" data-submit>Save review</button></div><p class="sr-only" data-dialog-status role="alert" aria-live="assertive"></p></form>`;
  document.body.append(dialog);
  dialog.addEventListener('cancel', () => closeDialog(dialog));
  dialog.addEventListener('click', (event) => { if (event.target === dialog) closeDialog(dialog); });
  dialog.querySelector('[data-act="close-dialog"]')?.addEventListener('click', () => closeDialog(dialog));
  dialog.querySelector('form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('[data-submit]');
    const noteNode = form.querySelector('[data-dialog-status]');
    submit.disabled = true;
    submit.setAttribute('aria-busy', 'true');
    try {
      await adminRpc('bkt_admin_review_report', {
        p_report_id: reportId,
        p_status: String(form.elements.status?.value || 'open'),
        p_note: String(form.elements.note?.value || '').trim() || null,
      });
      closeDialog(dialog);
      announce('Report review updated.');
      if (state.view === 'reports') await loadView('reports');
    } catch (error) {
      submit.disabled = false;
      submit.removeAttribute('aria-busy');
      noteNode.textContent = errorMessage(error, 'The report review could not be saved.');
    }
  });
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  focusSelector('#report-review-status');
}

function handleRootInput(event) {
  /* Search is submitted explicitly so each query runs against the full
     server-side feed, not only the current page held in the browser. */
  void event;
}

function handleAuthStateChange(event, session) {
  setTimeout(() => {
    if (event === 'SIGNED_OUT' || !session) {
      clearAuthenticatedState();
      renderLogin();
    } else if (session && !state.access) {
      void startSecurityFlow(session);
    }
  }, 0);
}

async function bootstrap() {
  appRoot.addEventListener('submit', handleRootSubmit);
  appRoot.addEventListener('click', handleRootClick);
  appRoot.addEventListener('change', handleRootChange);
  appRoot.addEventListener('input', handleRootInput);
  window.addEventListener('hashchange', () => {
    if (!state.access) return;
    const next = viewFromHash();
    navigate(next);
  });

  let client;
  try { client = await selectClient(); } catch (error) {
    appRoot.innerHTML = renderCard({ title: 'Platform Admin unavailable', notice: { kind: 'error', text: escapeHtml(errorMessage(error, 'The secure authentication library could not load.')) }, body: '<p class="lead">Try again when the platform connection is available.</p>' });
    announce(errorMessage(error), { error: true });
    return;
  }
  if (!client) {
    /* Production fail-closed state. There is no local admin session, no
       fallback credential, and no RPC transport when config.js is blank. */
    appRoot.innerHTML = renderCard({ title: 'Platform Admin unavailable', notice: { kind: 'warning', text: '<strong>Secure admin access is not configured.</strong><br>This console is disabled until the production Supabase project is configured.' }, body: '<p class="lead">No admin data has been loaded.</p>' });
    announce('Platform admin is unavailable because the secure connection is not configured.', { error: true });
    return;
  }
  state.client = client;
  if (!client.auth || typeof client.auth.getSession !== 'function' || typeof client.auth.signInWithPassword !== 'function') {
    appRoot.innerHTML = renderCard({ title: 'Platform Admin unavailable', notice: { kind: 'error', text: 'The secure authentication client is incomplete.' }, body: '<p class="lead">No admin data has been loaded.</p>' });
    announce('The secure authentication client is incomplete.', { error: true });
    return;
  }
  if (typeof client.auth.onAuthStateChange === 'function') client.auth.onAuthStateChange(handleAuthStateChange);
  try {
    const response = await client.auth.getSession();
    const error = resultError(response);
    if (error) throw error;
    const session = dataObject(response)?.session || null;
    if (session) await startSecurityFlow(session);
    else renderLogin();
  } catch (error) {
    await handleSecurityFailure(error);
  }
}

void bootstrap();
