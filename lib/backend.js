/* Connected-mode boundary, deliberately independent of the auth SDK.
   No generic table upserts: local demo IDs and queued browser patches must
   never become server commands. Only explicit, acknowledged RPCs cross here.
   This adapter is staging infrastructure, not wired into the production store.
   The transport supplies rpc(name, args); auth and HTTP errors fail closed. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fields = {
  orgName: 'org_name', name: 'name', gameId: 'game_id', capacity: 'capacity',
  format: 'format', venueType: 'venue_type', venue: 'venue', platforms: 'platforms',
  startsAt: 'starts_at', entryFee: 'entry_fee', currency: 'currency',
  presetId: 'preset_id', overrides: 'overrides', documents: 'documents',
  visibility: 'visibility',
};

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
      return { event: decodeRow(data.event), org: decodeRow(data.org),
        stations: data.stations.map(decodeRow), inviteCode: data.invite_code };
    },
    async joinEvent(eventId, { contact = null, shareContact = false } = {}) {
      return decodeRow(await call('bkt_join_event', {
        p_event_id: uuid(eventId), p_contact: shareContact ? contact : null,
        p_share_contact: shareContact === true,
      }));
    },
    async listEvents() {
      const data = await call('bkt_list_events');
      return Object.fromEntries(['events', 'orgs', 'players'].map(key => [key, data[key].map(decodeRow)]));
    },
    async redeemCode(code) {
      const data = await call('bkt_event_by_code', { p_code: String(code || '').trim().toUpperCase() });
      return { event: decodeRow(data.event), access: data.access };
    },
    async readEvent(eventId) {
      const data = await call('bkt_read_event', { p_event_id: uuid(eventId) });
      return { event: decodeRow(data.event), revision: data.revision,
        ...Object.fromEntries(['entries', 'players', 'stations', 'orgs', 'brackets', 'results']
          .map(key => [key, data[key].map(decodeRow)])) };
    },
  };
}
