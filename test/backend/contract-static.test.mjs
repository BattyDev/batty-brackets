/* This test catches contract drift without pretending to execute PostgreSQL.
   Authorization behavior remains the job of security.sql on a real database. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const brackets = path.resolve(here, '../..');
const read = (relative) => fs.readFileSync(path.join(brackets, relative), 'utf8');
const foundation = read('sql/staging/100_foundation.sql');
const commands = read('sql/staging/101_commands.sql');
const claims = read('sql/staging/102_claims.sql');
const run = read('test/backend/run.sql');
const adapter = read('lib/backend.js');

assert.match(run, /100_foundation\.sql[\s\S]*101_commands\.sql[\s\S]*102_claims\.sql[\s\S]*security\.sql/,
  'the disposable harness must apply staging migrations in order before assertions');
assert.doesNotMatch(run, /001_schema\.sql/, 'the unsafe historical schema must never enter the staging harness');

const rpc = ['bkt_identity', 'bkt_create_event', 'bkt_join_event', 'bkt_list_events',
  'bkt_event_by_code', 'bkt_read_event'];
for (const name of rpc) {
  assert.match(commands, new RegExp(`create function public\\.${name}\\b`), `${name} SQL function missing`);
  assert.match(adapter, new RegExp(`call\\('${name}'`), `${name} client call missing`);
}

for (const sql of [foundation, commands, claims]) {
  const declarations = [...sql.matchAll(/create function\s+([\w.]+)([\s\S]*?)\bas\s+\$\$/gi)];
  const definers = declarations.filter(([, , declaration]) => /security definer/i.test(declaration));
  assert.ok(definers.length, 'each migration that defines commands must expose definer functions to inspect');
  for (const [, name, declaration] of definers) {
    assert.match(declaration, /set search_path\s*=\s*pg_catalog/i,
      `${name} must pin its search path`);
  }
}

assert.match(foundation, /revoke all on public\.bkt_players[\s\S]*from public, anon, authenticated;/,
  'public table grants must be reset explicitly');
assert.match(foundation, /revoke all on all tables in schema bkt_private from public, anon, authenticated;/,
  'private tables must not inherit client grants');
assert.match(commands, /grant execute on function public\.bkt_read_event\(uuid\),public\.bkt_list_events\(\) to anon,authenticated;/,
  'anonymous access must be limited to event reads and listings');
assert.doesNotMatch(commands, /grant\s+(insert|update|delete|all)\s+on/gi,
  'connected clients must mutate state only through reviewed commands');

console.log('PASS backend static contract: migration order, RPC parity, fixed search paths, and grant boundary');
