# Staging backend contract v1

Status: proposed to parent before implementation. Connected create/join/read is
the first slice; reporting, generic record replay and offline publication are
not supported by this foundation.

All wire fields are snake_case. Entity IDs are full UUIDs. `auth.uid()` identifies
an auth user; `bkt_identity` resolves a separate durable player UUID. Never send a
device profile ID as proof of identity. RPCs execute using the authenticated
JWT, never a service key. No client role has direct table write permission.

Proposed RPCs (JSON objects unless otherwise noted):

| RPC | Arguments | Response |
|---|---|---|
| `bkt_identity` | `p_tag text = null` | `{id, tag}` |
| `bkt_create_event` | `p_event_id uuid, p_org_name text, p_name text, p_game_id text, p_capacity integer, p_station_count integer, p_visibility text = 'public'` | `{event, org, stations}` |
| `bkt_join_event` | `p_event_id uuid, p_contact text = null, p_share_contact boolean = false` | entry |
| `bkt_read_event` | `p_event_id uuid` | `{event, entries, players, stations, revision}` |

Create retries use the same event UUID and identical arguments. Join is unique
by event and authenticated player. Capacity overflow becomes waitlisted; retry
does not upgrade or alter the entry. Clients cannot supply seed, paid state,
player identity, timestamps, admission or ownership.

Contact is event-scoped and absent by default. Only explicit player opt-in
creates a contact grant. Adding a person to a roster cannot expose global
contact information. Revocation must remove the server copy; client adapter
must also invalidate protected cached data at logout/account switching.

Public reads include published public events. Draft/unlisted child records
follow the same event authorization. Unlisted readers require authenticated
token redemption; anonymous TVs support public events only in this slice.
No global directory of auth IDs, contacts or claim tokens is exposed.

The parent owns adapter serialization, identity lifecycle, cache isolation,
client contract tests and UI. This workstream owns database enforcement and
its isolated database tests. Never send the existing generic store outbox to
these tables; existing local events require a separate explicit migration flow.
