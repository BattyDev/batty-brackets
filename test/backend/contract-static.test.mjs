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
const operations = read('sql/staging/103_operations.sql');
const hardening = read('sql/staging/104_hardening.sql');
const guest = read('sql/staging/105_guest_join.sql');
const admin = read('sql/staging/106_admin.sql');
const submissions = read('sql/staging/107_match_submissions.sql');
const withdrawals = read('sql/staging/108_withdrawals.sql');
const run = read('test/backend/run.sql');
const adapter = read('lib/backend.js');

assert.match(run, /100_foundation\.sql[\s\S]*101_commands\.sql[\s\S]*102_claims\.sql[\s\S]*103_operations\.sql[\s\S]*104_hardening\.sql[\s\S]*105_guest_join\.sql[\s\S]*106_admin\.sql[\s\S]*107_match_submissions\.sql[\s\S]*108_withdrawals\.sql[\s\S]*security\.sql[\s\S]*admin-security\.sql/,
  'the disposable harness must apply staging migrations in order before assertions');
assert.doesNotMatch(run, /001_schema\.sql/, 'the unsafe historical schema must never enter the staging harness');

const rpc = ['bkt_identity', 'bkt_create_event', 'bkt_join_event', 'bkt_list_events',
  'bkt_event_by_code', 'bkt_read_event'];
for (const name of rpc) {
  assert.match(commands, new RegExp(`create function public\\.${name}\\b`), `${name} SQL function missing`);
  assert.match(adapter, new RegExp(`call\\('${name}'`), `${name} client call missing`);
}

for (const sql of [foundation, commands, claims, operations, guest, admin, submissions, withdrawals]) {
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
assert.match(operations, /create function public\.bkt_save_event_state\(p_event_id uuid,p_expected_revision bigint,p_state jsonb\)/,
  'organizer operations must cross one explicit, versioned command boundary');
assert.match(operations, /v_event\.revision<>p_expected_revision[\s\S]*stale_revision/,
  'organizer writes must reject stale event revisions');
assert.match(operations, /grant execute on function public\.bkt_save_event_state\(uuid,bigint,jsonb\) to authenticated/,
  'only authenticated clients may invoke organizer writes');
assert.match(hardening, /alter table bkt_private\.identities enable row level security;[\s\S]*alter table bkt_private\.signatures enable row level security;/,
  'private tables require defense-in-depth RLS even though the schema is hidden');
assert.match(guest, /auth\.jwt\(\)->>'is_anonymous'/, 'guest privilege decisions must use the trusted JWT claim');
assert.doesNotMatch(guest, /->>\s*'user_metadata'/i, 'guest privilege decisions must not trust editable user metadata');
assert.match(guest, /create trigger bkt_orgs_durable_owner[\s\S]*reject_anonymous_org_owner/, 'guests cannot become organization owners');
assert.match(guest, /create function public\.bkt_sign_document[\s\S]*player_id=v_me for update/, 'players can sign only their own entry');
assert.match(guest, /where event_id=p_event_id and player_id=v_me for update/, 'self check-in locks only the caller entry');
assert.match(guest, /checked_in_at is null[\s\S]*v_changed:=true/, 'self check-in is idempotent');
assert.match(guest, /grant execute on function[\s\S]*public\.bkt_self_check_in\(uuid\) to authenticated/, 'only authenticated identities can invoke check-in');
assert.match(adapter, /call\('bkt_self_check_in'/, 'the client must use the reviewed self check-in command');
assert.match(adapter, /call\('bkt_sign_document'/, 'the client must use the reviewed signature command');

const adminRpc = ['bkt_admin_access', 'bkt_admin_queue', 'bkt_admin_content',
  'bkt_admin_moderate', 'bkt_admin_audit', 'bkt_admin_metrics'];
for (const name of adminRpc) {
  assert.match(admin, new RegExp(`create function public\\.${name}\\b`), `${name} SQL function missing`);
  assert.match(adapter, new RegExp(`call\\('${name}'`), `${name} client call missing`);
  const declaration = admin.match(new RegExp(`create function public\\.${name}\\b([\\s\\S]*?)\\bas\\s+\\$\\$`, 'i'))?.[1] || '';
  assert.match(declaration, /security definer/i, `${name} must be a reviewed definer boundary`);
  assert.match(declaration, /set search_path\s*=\s*pg_catalog/i, `${name} must pin its search path`);
}
assert.match(admin, /create table bkt_private\.admin_members/, 'private admin membership table missing');
assert.match(admin, /create table bkt_private\.moderation_queue/, 'private moderation queue missing');
assert.match(admin, /create table bkt_private\.admin_audit/, 'private append-only audit missing');
assert.match(admin, /alter table bkt_private\.admin_members enable row level security;[\s\S]*alter table bkt_private\.admin_audit enable row level security;/,
  'admin private tables require RLS');
assert.match(admin, /revoke all on all tables in schema bkt_private from public,anon,authenticated;/,
  'new private tables must reset inherited grants');
assert.match(admin, /revoke all on function public\.bkt_admin_access\(\),[\s\S]*grant execute on function public\.bkt_admin_access\(\),[\s\S]*to authenticated;/,
  'admin RPCs need an authenticated-only grant boundary');
assert.match(admin, /coalesce\(\(select auth\.jwt\(\)->>\'aal\'\),\'aal1\'\)\s*<>\s*\'aal2\'/,
  'every admin path must enforce an AAL2 JWT');
assert.doesNotMatch(admin, /auth\.jwt\(\)[^\n]*user_metadata/i,
  'JWT user metadata must never drive admin authorization');
assert.match(admin, /moderation_state not in \(\'hidden\',\'quarantined\'\)/,
  'quarantine/hide must be absent from ordinary result reads');
assert.match(admin, /create trigger bkt_admin_audit_append_only\s*\nbefore update or delete/i,
  'audit rows must be append-only');
assert.doesNotMatch(admin, /from\s+bkt_private\.contacts/i,
  'private contacts must stay outside admin content queries');
assert.match(admin, /replacement_result_id uuid references public\.bkt_results\(id\)/,
  'result replacement must retain a corrective-row pointer');
assert.match(admin, /select 'result',coalesce\(q\.target_id,r\.id\),'record',to_jsonb\(r\)[\s\S]*where not r\.superseded/,
  'the content feed must expose only active results through their canonical moderation target');
assert.match(admin, /v_kind='result'[\s\S]*replacement_result_id=v_id\)\) then[\s\S]*return null;/,
  'organizer replay must preserve held result corrections without blocking unrelated writes');
const moderateBody = admin.match(/create function public\.bkt_admin_moderate\([\s\S]*?end \$\$;/i)?.[0] || '';
assert.match(moderateBody, /set_config\('bkt\.admin_override','on',true\)[\s\S]*set_config\('bkt\.admin_override','off',true\)/,
  'only the audited moderation transaction may bypass a content hold');
assert.match(admin, /if p_reason is null or length\(trim\(p_reason\)\) not between 1 and 2000/,
  'every moderation decision requires a bounded reason');
assert.match(admin, /auth\.jwt\(\)->>'is_anonymous'/,
  'anonymous Auth accounts must never qualify as platform administrators');
assert.match(submissions, /create table bkt_private\.match_submissions[\s\S]*enable row level security/);
assert.match(submissions, /create trigger bkt_close_stale_match_submissions[\s\S]*after update on public\.bkt_brackets/,
  'manual host reports must close obsolete player proposals');
assert.match(submissions, /bkt_private\.match_submissions[\s\S]*player_id=v_me[\s\S]*return to_jsonb\(v_existing\)/,
  'a retry must return only the same caller and payload');
assert.match(submissions, /en\.id in \(v_a,v_b\) and en\.player_id=v_me/,
  'the server must verify match ownership');
assert.match(submissions, /v_submission\.status<>'pending' then return public\.bkt_read_event/,
  'review retries must not advance the bracket twice');
assert.match(submissions, /bkt_save_event_state\(v_submission\.event_id,p_expected_revision,p_state\)/,
  'host review must use the versioned save boundary');
assert.match(adapter, /call\('bkt_submit_match_result'/);
assert.match(adapter, /call\('bkt_review_match_result'/);
assert.match(withdrawals, /create table bkt_private\.withdrawals[\s\S]*enable row level security/);
assert.match(withdrawals, /v_existing\.player_id<>v_me[\s\S]*return to_jsonb\(v_existing\)/,
  'withdrawal retries must belong to the same player');
assert.match(withdrawals, /v_event\.status in \('draft','complete'\)/,
  'closed events must reject new withdrawals');
assert.match(withdrawals, /delete from public\.bkt_entries where id=v_entry\.id/,
  'pre-bracket withdrawal removes the entry only');
assert.match(withdrawals, /r\.by_dq and not r\.superseded[\s\S]*w\.status='pending'/,
  'a recorded DQ is required to resolve a pending player request');
assert.match(withdrawals, /select count\(\*\) from public\.bkt_results r[\s\S]*b\.type='double' then 2 else 1/,
  'double elimination requests remain pending until the player is out');
assert.match(withdrawals, /old\.by_dq and not old\.superseded and new\.superseded[\s\S]*status='pending'/,
  'correcting a DQ reopens the request');
assert.match(adapter, /call\('bkt_withdraw_entry'/);

console.log('PASS backend static contract: migration order, RPC parity, fixed search paths, admin AAL2 boundary, and private moderation data');

const registration = read('sql/staging/20261005202914_registration_ux.sql');
assert.match(registration, /entry_payments enable row level security/);
assert.match(registration, /revoke all on bkt_private\.entry_payments from public,anon,authenticated/);
assert.match(registration, /public\.bkt_record_payment[\s\S]*security definer set search_path=pg_catalog/);
assert.match(registration, /p_expected_revision<>v_event\.revision/);
assert.match(registration, /p_entry\.player_id=bkt_private\.me\(\) or bkt_private\.is_staff/);
assert.match(registration, /document_title,document_body/);
assert.match(adapter, /call\('bkt_record_payment'/);
