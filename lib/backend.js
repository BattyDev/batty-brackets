/* Connected-mode boundary, deliberately independent of the auth SDK.
   No generic table upserts: local demo IDs and queued browser patches must
   never become server commands. Only explicit, acknowledged RPCs cross here.
   The transport supplies rpc(name, args); auth and HTTP errors fail closed. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVITE_CODE = /^[A-HJ-NP-Z2-9]{12}$/;
const ADMIN_ROLES = new Set(['moderator', 'analyst', 'super_admin']);
const ADMIN_ACTIONS = new Set(['hide', 'quarantine', 'restore', 'replace', 'lock']);
const ADMIN_TARGET_FIELDS = {
  player: new Set(['tag']),
  org: new Set(['name']),
  event: new Set(['name', 'game_id', 'format', 'venue_type', 'venue', 'platforms', 'starts_at', 'preset_id', 'documents', 'overrides', 'seeding_report']),
  entry: new Set(['crew']),
  station: new Set(['label', 'platform', 'match_id']),
  bracket: new Set(['record']),
  result: new Set(['record']),
};
const ADMIN_TARGETS = new Set(Object.keys(ADMIN_TARGET_FIELDS));
const fields = {
  orgName: 'org_name', name: 'name', gameId: 'game_id', capacity: 'capacity',
  format: 'format', venueType: 'venue_type', venue: 'venue', platforms: 'platforms',
  startsAt: 'starts_at', entryFee: 'entry_fee', currency: 'currency',
  presetId: 'preset_id', overrides: 'overrides', documents: 'documents',
  visibility: 'visibility',
};

export function isUuid(value) {
  return typeof value === 'string' && UUID.test(value);
}

function uuid(value) {
  if (!UUID.test(value)) throw new Error('Connected events require a server-compatible UUID; local events must be migrated explicitly.');
  return value;
}

export function serializeEvent(input) {
  if (!input || input.demo || input.local) throw new Error('Demo and device-only events cannot be published automatically.');
  const event = {};
  for (const [local, wire] of Object.entries(fields)) {
    if (input[local] !== undefined) event[wire] = structuredClone(input[local]);
  }
  if (!Number.isFinite(Number(event.entry_fee ?? 0)) || Number(event.entry_fee ?? 0) < 0) throw new Error('Entry fee must be a non-negative amount.');
  event.stations = (input.stations || [{ label: 'Station 1', platform: null }])
    .map(({ label, platform }) => ({ label, platform: platform ?? null }));
  return event;
}

/* Decode top-level database columns only. Rules, documents and bracket JSON
   already use the application's own keys and must not be recursively renamed. */
export function decodeRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid backend row.');
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), structuredClone(value),
  ]));
}

export function createBackend(transport) {
  if (typeof transport?.rpc !== 'function') throw new Error('An authenticated RPC transport is required.');
  let generation = 0;
  const invalidate = () => { generation += 1; };

  async function call(name, args = {}) {
    const started = generation;
    const response = await transport.rpc(name, args);
    // Signing out or changing accounts invalidates responses already in flight.
    if (started !== generation) throw new Error('Account changed; discard this response and refresh.');
    if (response?.error) throw new Error(response.error.message || 'The server could not complete this action.');
    if (response?.data == null) throw new Error('The server returned no acknowledgement.');
    if (response.data.error) throw new Error(response.data.error === 'rate_limited'
      ? 'Too many code attempts. Wait before trying again.' : response.data.error === 'claim_requires_review'
        ? 'This entry cannot be claimed now. Ask the host: registration must be open and the entry must be unused, without check-in, seed, documents, or results. Do not enter twice.'
        : 'That invitation is unavailable. Check the code with the organiser.');
    return response.data;
  }

  return {
    invalidate,
    async identity(tag = null) {
      const row = decodeRow(await call('bkt_identity', { p_tag: tag }));
      uuid(row.id); // Never infer player ID from the auth provider's user ID.
      return row;
    },
    async createEvent(eventId, input) {
      const data = await call('bkt_create_event', { p_event_id: uuid(eventId), p_event: serializeEvent(input) });
      if (!INVITE_CODE.test(data.invite_code || '')) throw new Error('The server returned an invalid invitation code.');
      return { event: decodeRow(data.event), org: decodeRow(data.org),
        stations: (data.stations || []).map(decodeRow), inviteCode: data.invite_code };
    },
    async joinEvent(eventId, { contact = null, shareContact = false } = {}) {
      return decodeRow(await call('bkt_join_event', {
        p_event_id: uuid(eventId), p_contact: shareContact ? contact : null,
        p_share_contact: shareContact === true,
      }));
    },
    async selfCheckIn(eventId) {
      const data = await call('bkt_self_check_in', { p_event_id: uuid(eventId) });
      return { entry: decodeRow(data.entry), changed: data.changed === true };
    },
    async signDocument(eventId, documentId, documentVersion, typedName) {
      const clean = String(typedName || '').trim();
      if (!clean || clean.length > 160) throw new Error('Type your name, up to 160 characters.');
      const data = await call('bkt_sign_document', {
        p_event_id: uuid(eventId), p_document_id: String(documentId),
        p_document_version: Number(documentVersion), p_typed_name: clean,
      });
      return { entry: decodeRow(data.entry), changed: data.changed === true };
    },
    async recordPayment(entryId, { amountDue = null, amountPaid = 0, note = '' }, expectedRevision) {
      const data = await call('bkt_record_payment', {
        p_entry_id: uuid(entryId), p_amount_due: amountDue, p_amount_paid: amountPaid,
        p_note: String(note).trim(), p_expected_revision: expectedRevision,
      });
      return { entry: decodeRow(data.entry), revision: data.revision };
    },
    async listEvents() {
      const data = await call('bkt_list_events');
      return Object.fromEntries(['events', 'orgs', 'players'].map(key => [key, (data[key] || []).map(decodeRow)]));
    },
    async redeemCode(code) {
      const normalized = String(code || '').trim().toUpperCase();
      if (!INVITE_CODE.test(normalized)) throw new Error('That invitation code is not valid. Check it with the organiser.');
      const data = await call('bkt_event_by_code', { p_code: normalized });
      return { event: decodeRow(data.event), access: data.access };
    },
    async readEvent(eventId) {
      const data = await call('bkt_read_event', { p_event_id: uuid(eventId) });
      return { event: decodeRow(data.event), revision: data.revision,
        ...Object.fromEntries(['entries', 'players', 'stations', 'orgs', 'brackets', 'results']
          .map(key => [key, (data[key] || []).map(decodeRow)])),
        matchSubmissions: (data.match_submissions || []).map(decodeRow),
        withdrawals: (data.withdrawals || []).map(decodeRow) };
    },
    async withdrawEntry(id, eventId) {
      return decodeRow(await call('bkt_withdraw_entry', { p_id: uuid(id), p_event_id: uuid(eventId) }));
    },
    async submitMatchResult({ id, eventId, matchId, expectedRevision, winnerEntryId, scoreA, scoreB }) {
      if (typeof matchId !== 'string' || !matchId || matchId.length > 120
          || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1
          || ![scoreA, scoreB].every(n => Number.isInteger(n) && n >= 0 && n <= 4)
          || scoreA === scoreB) throw new Error('Choose a valid winner and score.');
      return decodeRow(await call('bkt_submit_match_result', {
        p_id: uuid(id), p_event_id: uuid(eventId), p_match_id: matchId,
        p_expected_revision: expectedRevision, p_winner_entry_id: uuid(winnerEntryId),
        p_score_a: scoreA, p_score_b: scoreB,
      }));
    },
    async reviewMatchResult(id, expectedRevision, state, decision) {
      if (!['accepted', 'corrected'].includes(decision) || !Number.isSafeInteger(expectedRevision)
          || expectedRevision < 1) throw new Error('Refresh the submission before reviewing it.');
      const data = await call('bkt_review_match_result', {
        p_id: uuid(id), p_expected_revision: expectedRevision,
        p_state: structuredClone(state), p_decision: decision,
      });
      return { event: decodeRow(data.event), revision: data.revision,
        ...Object.fromEntries(['entries', 'players', 'stations', 'orgs', 'brackets', 'results']
          .map(key => [key, (data[key] || []).map(decodeRow)])),
        matchSubmissions: (data.match_submissions || []).map(decodeRow),
        withdrawals: (data.withdrawals || []).map(decodeRow) };
    },
    async saveEventState(eventId, expectedRevision, state) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
        throw new Error('Refresh this event before saving connected changes.');
      }
      if (!state || typeof state !== 'object' || Array.isArray(state)) {
        throw new Error('The event state is invalid.');
      }
      const data = await call('bkt_save_event_state', {
        p_event_id: uuid(eventId),
        p_expected_revision: expectedRevision,
        p_state: structuredClone(state),
      });
      return { event: decodeRow(data.event), revision: data.revision,
        ...Object.fromEntries(['entries', 'players', 'stations', 'orgs', 'brackets', 'results']
          .map(key => [key, (data[key] || []).map(decodeRow)])) };
    },
    async createWalkup(eventId, tag) {
      const clean = String(tag || '').trim();
      if (!clean || clean.length > 64) throw new Error('Enter a player tag up to 64 characters.');
      const data = await call('bkt_create_walkup', { p_event_id: uuid(eventId), p_tag: clean });
      if (!/^[0-9a-f]{64}$/i.test(data.claim_code || '')) throw new Error('The server returned an invalid claim code.');
      return { entry: decodeRow(data.entry), player: decodeRow(data.player), claimCode: data.claim_code, claimExpiresAt: data.claim_expires_at || null };
    },

    /* Claiming is intentionally exposed only with the reviewed server shape.
       The current UI keeps this action disabled in connected mode because
       the excluded organiser view still creates local eight-character claim
       codes. Keeping the adapter strict prevents that local code from ever
       being sent as a different, guessed RPC signature. */
    async claimPlayer(code) {
      const normalized = String(code || '').trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(normalized)) {
        throw new Error('Use the complete claim link shared by the host.');
      }
      return call('bkt_claim_player', { p_code: normalized });
    },

    async submitReport({ targetKind, targetId, targetField, reason } = {}) {
      if (!ADMIN_TARGET_FIELDS[targetKind]?.has(targetField)) {
        throw new Error('The report target is invalid.');
      }
      const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
      if (normalizedReason.length < 10 || normalizedReason.length > 1200) {
        throw new Error('A report reason between 10 and 1200 characters is required.');
      }
      const data = await call('bkt_submit_report', {
        p_target_kind: targetKind,
        p_target_id: uuid(targetId),
        p_target_field: targetField,
        p_reason: normalizedReason,
      });
      if (data.accepted !== true || typeof data.duplicate !== 'boolean') {
        throw new Error('The server returned an invalid report acknowledgement.');
      }
      return { accepted: true, duplicate: data.duplicate };
    },

    /* Site-wide administration is a separate RPC surface from organiser
       operations.  These methods never read private tables directly; the
       server verifies the current admin membership and AAL2 claim on every
       call. */
    async adminAccess() {
      const data = await call('bkt_admin_access');
      if (!ADMIN_ROLES.has(data.role) || data.aal !== 'aal2' || data.active !== true) {
        throw new Error('The server returned an invalid admin access acknowledgement.');
      }
      return data;
    },
    async adminQueue({ state = null, search = null, limit = 100, cursor = null } = {}) {
      if (state !== null && !['open', 'quarantined', 'hidden', 'replaced', 'restored'].includes(state)) {
        throw new Error('The moderation queue filter is invalid.');
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
        throw new Error('The moderation queue limit is invalid.');
      }
      const data = await call('bkt_admin_queue', {
        p_state: state, p_search: normalizeAdminSearch(search), p_limit: limit,
        p_cursor: normalizeAdminCursor(cursor),
      });
      return {
        role: data.role,
        items: (data.items || []).map(decodeRow),
        nextCursor: data.next_cursor ?? null,
      };
    },
    async adminContent({ targetKind = null, search = null, limit = 100, cursor = null } = {}) {
      if (targetKind !== null && !ADMIN_TARGETS.has(targetKind)) {
        throw new Error('The moderation content kind is invalid.');
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
        throw new Error('The moderation content limit is invalid.');
      }
      const data = await call('bkt_admin_content', { p_target_kind: targetKind, p_search: normalizeAdminSearch(search), p_limit: limit, p_cursor: normalizeAdminCursor(cursor) });
      return {
        role: data.role,
        items: (data.items || []).map(decodeRow),
        nextCursor: data.next_cursor ?? null,
      };
    },
    async adminModerate({ action, targetKind, targetId, targetField = null, replacement = null, reason = null } = {}) {
      if (!ADMIN_ACTIONS.has(action)) throw new Error('The moderation action is invalid.');
      if (!ADMIN_TARGETS.has(targetKind)) throw new Error('The moderation target is invalid.');
      const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
      if (!normalizedReason || normalizedReason.length > 2000) {
        throw new Error('A moderation reason between 1 and 2000 characters is required.');
      }
      if (!ADMIN_TARGET_FIELDS[targetKind]?.has(targetField)) {
        throw new Error('The moderation field is invalid.');
      }
      if (targetKind === 'station' && targetField === 'match_id' && action === 'replace') {
        throw new Error('A station match reference cannot be replaced directly.');
      }
      const data = await call('bkt_admin_moderate', {
        p_action: action,
        p_target_kind: targetKind,
        p_target_id: uuid(targetId),
        p_target_field: targetField,
        p_replacement: replacement == null ? null : structuredClone(replacement),
        p_reason: normalizedReason,
      });
      return {
        ...decodeRow(data),
        queue: data.queue ? decodeRow(data.queue) : null,
      };
    },
    async adminAudit({ search = null, limit = 100, cursor = null } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
        throw new Error('The admin audit limit is invalid.');
      }
      const data = await call('bkt_admin_audit', {
        p_search: normalizeAdminSearch(search), p_limit: limit,
        p_cursor: normalizeAdminCursor(cursor),
      });
      return {
        role: data.role,
        items: (data.items || []).map(decodeRow),
        nextCursor: data.next_cursor ?? null,
      };
    },
    async adminReports({ status = null, search = null, limit = 100, cursor = null } = {}) {
      if (status !== null && !['open', 'reviewing', 'resolved', 'dismissed'].includes(status)) {
        throw new Error('The user report status filter is invalid.');
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
        throw new Error('The user report limit is invalid.');
      }
      const data = await call('bkt_admin_reports', {
        p_status: status, p_search: normalizeAdminSearch(search),
        p_limit: limit, p_cursor: normalizeAdminCursor(cursor),
      });
      return { role: data.role, items: (data.items || []).map(decodeRow), nextCursor: data.next_cursor ?? null };
    },
    async adminReviewReport({ reportId, status, note = null } = {}) {
      if (!isUuid(reportId)) throw new Error('The user report ID is invalid.');
      if (!['open', 'reviewing', 'resolved', 'dismissed'].includes(status)) {
        throw new Error('The user report status is invalid.');
      }
      const normalizedNote = typeof note === 'string' ? note.trim() : '';
      if (normalizedNote.length > 1200) throw new Error('The review note must be 1200 characters or fewer.');
      const data = await call('bkt_admin_review_report', {
        p_report_id: reportId, p_status: status, p_note: normalizedNote || null,
      });
      return decodeRow(data);
    },
    async adminMetrics({ from = null, to = null } = {}) {
      const data = await call('bkt_admin_metrics', { p_from: from, p_to: to });
      return decodeRow(data);
    },
  };
}

function normalizeAdminSearch(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > 200) {
    throw new Error('The admin search must be 200 characters or fewer.');
  }
  return value.trim() || null;
}

function normalizeAdminCursor(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The admin page cursor is invalid.');
  }
  return structuredClone(value);
}
