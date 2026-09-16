# Staging backend verification

This procedure is for a disposable, empty database. It does not provision a
project, edit `config.js`, connect the browser client, migrate local events or
deploy anything. `sql/001_schema.sql` is historical and must not be applied.

## Local PostgreSQL gate

First run the dependency-free drift check from the repository root:

```sh
node brackets/test/backend/contract-static.test.mjs
node brackets/test/backend-client.test.mjs
```

These checks validate migration ordering and client/RPC naming only. They do
not execute SQL and cannot establish authorization correctness.

Requirements: PostgreSQL with `psql`, `gen_random_uuid()` and `sha256(bytea)`.
Use a database that can be discarded. The harness creates Supabase-shaped
`anon`, `authenticated` and `auth` fixtures, so never run it against Supabase or
any database that already has those objects.

From `brackets/test/backend/`:

```sh
createdb batty_brackets_test
psql --set=ON_ERROR_STOP=1 --dbname=batty_brackets_test --file=run.sql
dropdb batty_brackets_test
```

`run.sql` commits the three staging migrations and runs adversarial assertions
inside a rollback-only transaction. A pass ends with:

```text
Backend security regression assertions passed (transaction rolled back).
```

The database itself is disposable because the migrations remain committed.
Do not infer a pass from `psql` reaching the end when `ON_ERROR_STOP` was not
enabled.

## Empty Supabase staging gate

1. Confirm the selected project is dedicated staging and has no `bkt_` objects.
2. In one explicitly selected SQL session, set `bkt.staging = 'on'`.
3. Apply `100_foundation.sql`, `101_commands.sql`, then `102_claims.sql`.
   The first migration refuses legacy or partially installed Batty objects.
4. Adapt the assertions in `test/backend/security.sql` to real test users and
   JWT-backed API requests. Do not run `bootstrap.sql`; Supabase already owns
   its roles, `auth` schema and `auth.uid()` implementation.
5. Inspect effective table, schema and function grants. Test as anonymous,
   unrelated authenticated player, entrant, owner and unrelated organizer.
6. Race the last available place from two authenticated sessions. Exactly one
   entry must be admitted and the other waitlisted. Retry both commands and
   confirm no duplicate entry or revision change.
7. Delete the staging test data or discard the project. Never use real
   participant contact information.

## Still required after SQL passes

- Integrate `lib/backend.js` only after authenticated cache/account isolation is
  implemented; never attach the legacy generic outbox.
- Exercise create/list/redeem/join/read from independent laptop, phone and TV
  contexts, including expiration, sign-out, reconnect and access revocation.
- Add transactional report/correct/station-release commands with operation IDs
  and expected revisions before calling connected tournament operation ready.
- Review a separate production migration and rollback plan. Production config
  stays blank until those gates pass.
