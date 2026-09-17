# Supabase cutover runbook

Target project: `battydevsite` (`bbqauqqymjxqcyurxmna`, AWS `us-east-1`).

Batty Brackets starts from scratch in this project. Legacy `battydevsite` data
is intentionally out of scope. Do not run `sql/001_schema.sql`; it is retained
as design history and has known authorization defects.

## Stop gates

Do not configure the public site until every item is true:

- The ordered replacement migrations pass the local PostgreSQL adversarial
  suite and a clean Supabase staging run with real JWT-backed roles.
- Connected mode uses only the explicit RPC adapter. The generic table
  `upsert`/`delete` outbox is not attached.
- Organizer, player-phone, and TV clients pass the Tōkon rehearsal, including
  account switching, reconnects, stale revisions, duplicate submissions,
  capacity races, result correction, and rollback.

## Inventory

Record counts and object names only. Do not copy API keys, database passwords,
OAuth client secrets, participant contact information, or service-role keys
into this repository.

1. Database schemas, tables, views, functions, triggers, policies, extensions,
   publications, and webhooks.
2. Auth user count, enabled providers, site URL, redirect URLs, email templates,
   and rate-limit settings.
3. Storage bucket names, privacy, object counts, and aggregate sizes.
4. Edge Function names and versions; secret names separately.
5. Project integrations and custom domains.

## Replacement sequence

1. Inspect the target for existing `bkt_` objects. If conflicting objects must
   be removed, stop for explicit destructive-action approval.
2. Apply the reviewed replacement migrations in one selected SQL session with
   `ON_ERROR_STOP` semantics; stop on the first error.
3. Inspect effective grants and RLS as anonymous, unrelated authenticated,
   entrant, staff, and owner users.
4. Run idempotency, stale-revision, station-occupancy, capacity-race, and
   correction tests from independent sessions.
5. Configure Auth providers and exact production redirect URLs.
6. Put only the public project URL and publishable key in `config.js`.
7. Deploy to a branch, run the remote browser rehearsal, then merge after the
   site assembly workflow is green.
8. Keep rollback instructions until at least one real event has passed.

## Rollback

If schema application, permission checks, or the cross-device rehearsal fails,
leave `config.js` blank so the public site remains local-only. Do not try to
repair production in place under event pressure. Remove the failed scratch
schema only after explicit approval, then re-run the reviewed migrations.
