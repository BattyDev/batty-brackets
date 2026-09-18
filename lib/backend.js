/* Connected-mode boundary, deliberately independent of the auth SDK.
   No generic table upserts: local demo IDs and queued browser patches must
   never become server commands. Only explicit, acknowledged RPCs cross here.
   The transport supplies rpc(name, args); auth and HTTP errors fail closed. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVITE_CODE = /^[A-HJ-NP-Z2-9]{12}$/;
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
  if ((event.entry_fee ?? 0) !== 0) throw new Error('Connected pilot events must be free; payments are not enabled.');
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
      ? 'Too many code attempts. Wait before trying again.' : 'That invitation is unavailable. Check the code with the organiser.');
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
          .map(key => [key, (data[key] || []).map(decodeRow)])) };
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
      return { entry: decodeRow(data.entry), player: decodeRow(data.player), claimCode: data.claim_code };
    },

    /* Claiming is intentionally exposed only with the reviewed server shape.
       The current UI keeps this action disabled in connected mode because
       the excluded organiser view still creates local eight-character claim
       codes. Keeping the adapter strict prevents that local code from ever
       being sent as a different, guessed RPC signature. */
    async claimPlayer(code) {
      const normalized = String(code || '').trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(normalized)) {
        throw new Error('Connected claim codes are not available until walk-up entries use the server claim flow.');
      }
      return call('bkt_claim_player', { p_code: normalized });
    },
  };
}
