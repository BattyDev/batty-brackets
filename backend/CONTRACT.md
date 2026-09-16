# Staging backend contract v1

Status: implemented for an empty staging database, but not yet executed against
PostgreSQL or a hosted Supabase project. Passing the dependency-free client
adapter test is not evidence that these database permissions work.

This is the first connected slice only: identity, create, list, code redemption,
join and event-scoped reads. Reporting, bracket mutation, generic record replay
and offline publication are deliberately absent. The existing generic browser
outbox must never be pointed at these tables.

## Boundary

All wire fields are `snake_case`; all connected entity IDs are full UUIDs.
`auth.uid()` identifies an authentication account, while `bkt_identity` resolves
the separate durable player UUID used by tournament records. A device profile ID
is never proof of identity. RPCs use the caller's JWT and publishable key; a
browser never receives a service-role key or database password.

No client role has direct table write permission. `SECURITY DEFINER` commands
validate their complete input, derive ownership and privileged entry fields, and
run with a fixed `pg_catalog` search path. Public table reads remain behind RLS;
private identities, contacts, invitation tokens and claim credentials are in a
schema with no client `USAGE` or table grants.

## RPC contract

Responses are JSON objects unless noted otherwise.

| RPC | Who | Arguments | Response |
|---|---|---|---|
| `bkt_identity` | authenticated | `p_tag text = null` | player `{id, tag}` |
| `bkt_create_event` | authenticated identity | `p_event_id uuid, p_event jsonb` | `{event, org, stations, invite_code}` |
| `bkt_list_events` | anonymous or authenticated | none | `{events, orgs, players}` (newest 100 visible events) |
| `bkt_event_by_code` | authenticated identity | `p_code text` | `{event, access}` or `{error}` |
| `bkt_join_event` | authenticated identity | `p_event_id uuid, p_contact text = null, p_share_contact boolean = false` | entry |
| `bkt_read_event` | anonymous or authenticated reader | `p_event_id uuid` | `{event, entries, players, stations, orgs, brackets, results, revision}` |

`p_event` accepts only: `org_name`, `name`, `game_id`, `capacity`, `format`,
`venue_type`, `venue`, `platforms`, `starts_at`, `entry_fee`, `currency`,
`preset_id`, `overrides`, `documents`, `visibility`, and `stations`. Payment is
out of scope, so `entry_fee` must be zero. The server derives the owner, staff
membership, registration status, revision, timestamps, station numbers and
invitation secret. Unknown keys fail rather than being silently discarded.

Create is idempotent only for the same authenticated player, event UUID and
structurally equal JSON value. A retry returns the same private invitation code;
another actor or changed payload receives an idempotency conflict. Join is
unique by event and authenticated player. The event row is locked before
capacity is counted, so admitted places cannot exceed capacity; overflow joins
are waitlisted. Clients cannot supply player identity, seed, paid state,
waitlist state, timestamps or ownership.

## Visibility and private data

Listed public events and all of their public child rows are readable without an
account. Unlisted events are absent from listings and direct reads until an
authenticated player redeems the exact invitation code. Redemption grants a
short reader lease; joining creates durable event-scoped read access through the
entry. “Unlisted” is a discoverability control, not secrecy or DRM. Drafts are
never public. Anonymous venue displays support public events only in this slice.

Contact is event-scoped and absent by default. A contact row is created only by
that player with `p_share_contact = true`; creating a roster entry cannot expose
contact from another event. Revocation deletes the server copy. The client must
also clear protected cached data on sign-out and account switching before this
can be activated.

Invitation and claim attempts have a per-account database throttle. That is not
an IP/edge rate limit and must not be represented as one. Errors intentionally
do not reveal whether an unlisted event or consumed credential exists.

## Permission matrix

| Capability | Anonymous | Authenticated player | Event staff/owner |
|---|---:|---:|---:|
| List/read public event | yes | yes | yes |
| Read unlisted event before redemption/entry | no | no | yes |
| Redeem invitation and join | no | yes | yes |
| Create event | no | yes | yes |
| Set own event contact | no | own entry only | own entry only |
| Read opted-in contacts | no | own contact only | that event only |
| Direct table write/private-schema read | no | no | no |

## Activation gates

Follow [STAGING.md](STAGING.md). Before any client integration or production
configuration, execute the SQL tests on disposable PostgreSQL and then an empty
Supabase staging project. Verify the effective grants there, repeat the
simultaneous-capacity test from two sessions, and rehearse an organizer laptop,
player phone and separate TV. The schema has not passed those gates merely by
existing in this repository.
