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
| `bkt_sign_document` | authenticated identity with an entry | `p_event_id uuid, p_document_id text, p_document_version integer, p_typed_name text` | `{entry, changed}` |
| `bkt_self_check_in` | authenticated identity with an entry | `p_event_id uuid` | `{entry, changed}` |
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

## Guest player contract

A “guest” is a Supabase anonymous Auth user. Supabase gives that session the
`authenticated` database role; it is not the unauthenticated `anon` role shown
in the matrix below. The app immediately resolves the Auth UUID through
`bkt_identity`, so entries point at the same durable player UUID before and
after account upgrade.

Guests may redeem a code, join, read their event, and check in their own entry.
They may not own an organization or create an event. That distinction uses the
trusted JWT `is_anonymous` claim, never editable user metadata. Self check-in
locks the caller's entry, rejects waitlisted players, requires the event to be
in check-in, and verifies every required document signature server-side. A
retry is idempotent and returns `changed: false`.

Upgrade must link credentials to the active anonymous Auth user. Discord uses
identity linking; email uses a verification-first user update. Ordinary sign-up
and sign-in are blocked while a guest record is active because switching Auth
UUIDs would split tournament history.

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
| Self check in | no | own admitted entry only | own admitted entry only |
| Create event | no | durable account only | yes |
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

Before guest access is enabled in production, enable anonymous sign-ins and
manual identity linking in Supabase, configure CAPTCHA/edge abuse protection,
and rehearse email verification and OAuth linking on the production callback
domain. The per-account invitation throttle cannot stop one device from making
many anonymous accounts.

## Site administration contract (staging migration 106)

The site-wide console is a separate capability from event staff. The private
`bkt_private.admin_members` table maps an Auth account UUID to exactly one
active role: `moderator`, `analyst`, or `super_admin`. A client cannot read or
write that table. The first production super-admin membership must be seeded by
the reviewed deployment operator; the browser never receives a service-role
credential.

Every admin RPC checks all three conditions at call time: `auth.uid()` is
present, the matching membership is active and has an allowed role, and the
issuer-controlled top-level JWT `aal` claim is `aal2`. No `user_metadata` value
is used for authorization. A stale or AAL1 session receives a denial and must
complete MFA before retrying.

### RPC boundary

All six functions are `SECURITY DEFINER` with `search_path = pg_catalog`, have
PUBLIC/anon execution revoked, and grant execution only to `authenticated`.
They return JSON objects and never expose a private table directly.

| RPC | Roles | Arguments | Response |
|---|---|---|---|
| `bkt_admin_access` | all active admin roles | none | `{active, role, aal, can_moderate, can_analyze, can_queue, can_content, can_audit}` |
| `bkt_admin_queue` | moderator, super_admin | `p_state text = null, p_limit integer = 100` | `{role, items, next_cursor}` |
| `bkt_admin_content` | moderator, super_admin | `p_target_kind text = null, p_limit integer = 200` | `{role, items, next_cursor}` |
| `bkt_admin_moderate` | moderator, super_admin | `p_action, p_target_kind, p_target_id, p_target_field = null, p_replacement = null, p_reason` (required, 1–2000 characters) | `{action_id, action, target_kind, target_id, target_field, content, queue}` |
| `bkt_admin_audit` | moderator, super_admin | `p_limit integer = 100, p_before timestamptz = null` | `{role, items, next_cursor}` |
| `bkt_admin_metrics` | all active admin roles | `p_from timestamptz = null, p_to timestamptz = null` | `{role, from, to, generated_at, totals, statuses, moderation, daily}` |

Analysts are deliberately metrics-only. Moderators can review and change
content but cannot manage membership; `super_admin` is the escalation role.

### Moderation and privacy

The private `moderation_queue` stores one original snapshot per whitelisted
target field and the current decision. Targets are player `tag`, organisation
`name`, event `name`/`venue`, entry `crew`, station `label`, and a result
`record`. `hide` and `quarantine` replace public text with a short
placeholder; result rows are hidden by RLS and the event bundle while remaining
durable. `restore` reads the private snapshot. `replace` on text stores the
replacement; `replace` on a result marks the prior row `superseded` and inserts
a corrective result row, so history is never overwritten. Every active
moderation decision holds its target against organiser UPDATE/DELETE attempts
through target-table triggers; a moderator or super admin can restore or issue
a further correction only through the audited AAL2 moderation RPC.

`bkt_private.admin_audit` is append-only (client roles have zero schema/table
grants and an UPDATE/DELETE trigger rejects even accidental definer mutation).
It records the actor role, action, target, before/after values, required reason, and
timestamp. Private contacts are not a moderation target and are excluded from
the content feed, audit payloads, and metrics.
