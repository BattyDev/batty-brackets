import assert from 'node:assert/strict';
import { createBackend, serializeEvent, decodeRow } from '../lib/backend.js';

const id = 'fa64db1f-9631-4a42-9168-5d1a28f96f1f';
const calls = [];
let reply = { id, tag: 'Batty' };
const api = createBackend({ async rpc(name, args) { calls.push({ name, args }); return { data: reply }; } });
const rules = { matchFormat: { firstTo: 2 } };
const event = serializeEvent({ name: 'Weekly', ownerId: 'attacker', inviteCode: 'secret',
  orgName: 'Batty', overrides: rules, stations: [{ label: 'One', platform: 'ps5', id: 'unsafe' }] });
assert.deepEqual(event, { name: 'Weekly', org_name: 'Batty', overrides: rules, stations: [{ label: 'One', platform: 'ps5' }] });
event.overrides.matchFormat.firstTo = 3;
assert.equal(rules.matchFormat.firstTo, 2);
assert.throws(() => serializeEvent({ demo: true }), /cannot be published/);
assert.throws(() => serializeEvent({ local: true }), /cannot be published/);
assert.equal(serializeEvent({ entryFee: 10.50 }).entry_fee, 10.50);
assert.throws(() => serializeEvent({ entryFee: -1 }), /non-negative/);
assert.deepEqual(decodeRow({ player_id: id, overrides: rules }), { playerId: id, overrides: rules });
assert.equal((await api.identity()).id, id);
assert.deepEqual(calls.pop(), { name: 'bkt_identity', args: { p_tag: null } });
await assert.rejects(api.readEvent('evt_local'), /UUID/);
await api.joinEvent(id, { contact: 'private@example.com', shareContact: false, seed: 1, paid: true });
assert.deepEqual(calls.pop(), { name: 'bkt_join_event', args: { p_event_id: id, p_contact: null, p_share_contact: false } });
await api.joinEvent(id, { contact: 'ok@example.com', shareContact: true });
assert.equal(calls.pop().args.p_contact, 'ok@example.com');
reply = { entry: { id, event_id: id, player_id: id, checked_in_at: '2026-09-17T01:00:00Z' }, changed: true };
const checked = await api.selfCheckIn(id);
assert.equal(checked.entry.checkedInAt, '2026-09-17T01:00:00Z');
assert.equal(checked.changed, true);
assert.deepEqual(calls.pop(), { name: 'bkt_self_check_in', args: { p_event_id: id } });
reply = { entry: { id, event_id: id, player_id: id, signed_documents: ['conduct'] }, changed: true };
const signed = await api.signDocument(id, 'conduct', 1, '  Batty  ');
assert.deepEqual(signed.entry.signedDocuments, ['conduct']);
assert.deepEqual(calls.pop(), { name: 'bkt_sign_document', args: {
  p_event_id: id, p_document_id: 'conduct', p_document_version: 1, p_typed_name: 'Batty',
} });
reply = { event: { id, org_id: id }, org: { id }, stations: [], invite_code: 'ABCDEFGH2345' };
assert.equal((await api.createEvent(id, { name: 'Weekly' })).inviteCode, 'ABCDEFGH2345');
assert.equal(calls.pop().args.p_event_id, id);
reply = { event: { id }, access: { event_id: id } };
await api.redeemCode('abcdefgh2345');
assert.deepEqual(calls.pop(), { name: 'bkt_event_by_code', args: { p_code: 'ABCDEFGH2345' } });
await assert.rejects(api.redeemCode('foo'), /not valid/);
reply = { error: 'rate_limited' };
await assert.rejects(api.redeemCode('ABCDEFGH2345'), /Too many/);
await assert.rejects(api.claimPlayer('LOCAL123'), /complete claim link/);
reply = { event: { id, revision: 3 }, revision: 3, entries: [], players: [], stations: [], orgs: [], brackets: [], results: [] };
await api.saveEventState(id, 2, { event: { id }, entries: [], players: [], stations: [], bracket: null, results: [] });
assert.deepEqual(calls.pop(), { name: 'bkt_save_event_state', args: {
  p_event_id: id, p_expected_revision: 2,
  p_state: { event: { id }, entries: [], players: [], stations: [], bracket: null, results: [] },
} });
await assert.rejects(api.saveEventState(id, 0, {}), /Refresh/);
reply = { id, event_id: id, match_id: 'W-1-0', player_id: id,
  winner_entry_id: id, score_a: 2, score_b: 1, status: 'pending' };
assert.equal((await api.submitMatchResult({ id, eventId: id, matchId: 'W-1-0',
  expectedRevision: 3, winnerEntryId: id, scoreA: 2, scoreB: 1 })).winnerEntryId, id);
assert.deepEqual(calls.pop(), { name: 'bkt_submit_match_result', args: {
  p_id: id, p_event_id: id, p_match_id: 'W-1-0', p_expected_revision: 3,
  p_winner_entry_id: id, p_score_a: 2, p_score_b: 1,
} });
await assert.rejects(api.submitMatchResult({ id, eventId: id, matchId: 'W-1-0',
  expectedRevision: 3, winnerEntryId: id, scoreA: 2, scoreB: 2 }), /valid winner/);
reply = { event: { id, revision: 4 }, revision: 4, entries: [], players: [],
  stations: [], orgs: [], brackets: [], results: [], match_submissions: [{ id, status: 'accepted' }] };
assert.equal((await api.reviewMatchResult(id, 3, { event: { id } }, 'accepted')).matchSubmissions[0].status, 'accepted');
assert.deepEqual(calls.pop(), { name: 'bkt_review_match_result', args: {
  p_id: id, p_expected_revision: 3, p_state: { event: { id } }, p_decision: 'accepted',
} });
reply = { id, event_id: id, entry_id: id, player_id: id, status: 'pending' };
assert.equal((await api.withdrawEntry(id, id)).status, 'pending');
assert.deepEqual(calls.pop(), { name: 'bkt_withdraw_entry', args: { p_id: id, p_event_id: id } });
await assert.rejects(api.withdrawEntry('local-id', id), /UUID/);
reply = { event: { id, revision: 4 }, revision: 4, entries: [], players: [],
  stations: [], orgs: [], brackets: [], results: [], withdrawals: [{ id, event_id: id, entry_id: id, player_id: id, status: 'resolved' }] };
assert.equal((await api.readEvent(id)).withdrawals[0].status, 'resolved');
reply = { entry: { id, event_id: id, player_id: id }, player: { id, tag: 'Door' }, claim_code: 'a'.repeat(64) };
assert.equal((await api.createWalkup(id, ' Door ')).claimCode, 'a'.repeat(64));
assert.deepEqual(calls.pop(), { name: 'bkt_create_walkup', args: { p_event_id: id, p_tag: 'Door' } });
reply = { player_id: id };
await api.claimPlayer('a'.repeat(64));
assert.deepEqual(calls.pop(), { name: 'bkt_claim_player', args: { p_code: 'a'.repeat(64) } });
reply = { active: true, role: 'moderator', aal: 'aal2', can_moderate: true };
assert.equal((await api.adminAccess()).role, 'moderator');
assert.deepEqual(calls.pop(), { name: 'bkt_admin_access', args: {} });
reply = { accepted: true, duplicate: false };
assert.deepEqual(await api.submitReport({ targetKind: 'bracket', targetId: id, targetField: 'record', reason: 'This bracket includes an invalid match.' }), { accepted: true, duplicate: false });
assert.deepEqual(calls.pop(), { name: 'bkt_submit_report', args: {
  p_target_kind: 'bracket', p_target_id: id, p_target_field: 'record', p_reason: 'This bracket includes an invalid match.',
} });
await assert.rejects(api.submitReport({ targetKind: 'event', targetId: id, targetField: 'private_contact', reason: 'Please review this private contact.' }), /target/);
await assert.rejects(api.submitReport({ targetKind: 'event', targetId: id, targetField: 'status', reason: 'This event status should not be reportable.' }), /target/);
await assert.rejects(api.submitReport({ targetKind: 'event', targetId: id, targetField: 'documents', reason: 'short' }), /10 and 1200/);
reply = { role: 'moderator', items: [{ target_kind: 'player', target_id: id, target_field: 'tag' }], next_cursor: { updated_at: '2026-09-18T00:00:00Z', id } };
assert.equal((await api.adminQueue({ state: 'hidden', search: 'example', limit: 20, cursor: { updated_at: '2026-09-17T00:00:00Z', id } })).items[0].targetKind, 'player');
assert.deepEqual(calls.pop(), { name: 'bkt_admin_queue', args: {
  p_state: 'hidden', p_search: 'example', p_limit: 20, p_cursor: { updated_at: '2026-09-17T00:00:00Z', id },
} });
reply = { role: 'moderator', items: [{ target_kind: 'event', target_id: id, target_field: 'documents', value: [{ id: 'conduct' }] }], next_cursor: { target_kind: 'event', target_id: id, target_field: 'documents' } };
await api.adminContent({ targetKind: 'event', search: 'conduct', limit: 10, cursor: { target_kind: 'event', target_id: id, target_field: 'name' } });
assert.deepEqual(calls.pop(), { name: 'bkt_admin_content', args: {
  p_target_kind: 'event', p_search: 'conduct', p_limit: 10,
  p_cursor: { target_kind: 'event', target_id: id, target_field: 'name' },
} });
reply = { action_id: id, action: 'replace', target_kind: 'bracket', target_id: id, target_field: 'record', queue: { target_kind: 'bracket' } };
await api.adminModerate({ action: 'replace', targetKind: 'bracket', targetId: id, targetField: 'record', replacement: { matches: [] }, reason: 'Correct bracket JSON' });
assert.equal(calls.pop().args.p_replacement.matches.length, 0);
reply = { action_id: id, action: 'replace', target_kind: 'player', target_id: id, target_field: 'tag', queue: { target_kind: 'player' } };
await api.adminModerate({ action: 'replace', targetKind: 'player', targetId: id, targetField: 'tag', replacement: 'Batty', reason: 'reviewed' });
assert.deepEqual(calls.pop(), { name: 'bkt_admin_moderate', args: {
  p_action: 'replace', p_target_kind: 'player', p_target_id: id, p_target_field: 'tag',
  p_replacement: 'Batty', p_reason: 'reviewed',
} });
reply = { role: 'moderator', items: [{ target_kind: 'player', target_id: id }], next_cursor: null };
await api.adminAudit({ search: 'moderator', limit: 5, cursor: { created_at: '2026-09-18T00:00:00Z', id } });
assert.deepEqual(calls.pop(), { name: 'bkt_admin_audit', args: {
  p_search: 'moderator', p_limit: 5, p_cursor: { created_at: '2026-09-18T00:00:00Z', id },
} });
reply = { role: 'moderator', items: [{ id, status: 'open', reason: 'Unsafe event name' }], next_cursor: null };
assert.equal((await api.adminReports({ status: 'open', search: 'unsafe' })).items[0].status, 'open');
assert.deepEqual(calls.pop(), { name: 'bkt_admin_reports', args: { p_status: 'open', p_search: 'unsafe', p_limit: 100, p_cursor: null } });
reply = { id, status: 'resolved', review_note: 'Handled' };
assert.equal((await api.adminReviewReport({ reportId: id, status: 'resolved', note: 'Handled' })).status, 'resolved');
assert.deepEqual(calls.pop(), { name: 'bkt_admin_review_report', args: { p_report_id: id, p_status: 'resolved', p_note: 'Handled' } });
reply = { role: 'moderator', totals: { events: 2 }, statuses: [], daily: [] };
assert.equal((await api.adminMetrics()).totals.events, 2);
assert.deepEqual(calls.pop(), { name: 'bkt_admin_metrics', args: { p_from: null, p_to: null } });
await assert.rejects(api.adminQueue({ limit: 0 }), /limit/);
await assert.rejects(api.adminModerate({ action: 'delete', targetKind: 'player', targetId: id, targetField: 'tag' }), /action/);
await assert.rejects(api.adminModerate({ action: 'hide', targetKind: 'event', targetId: id, targetField: 'bad', reason: 'invalid field probe' }), /field/);
await assert.rejects(api.adminModerate({ action: 'hide', targetKind: 'bracket', targetId: id, targetField: 'json', reason: 'invalid structured field probe' }), /field/);
await assert.rejects(api.adminModerate({ action: 'replace', targetKind: 'station', targetId: id, targetField: 'match_id', replacement: 'final', reason: 'direct reference replacement should be rejected' }), /cannot be replaced/);
await assert.rejects(api.adminModerate({ action: 'hide', targetKind: 'player', targetId: id, targetField: 'tag' }), /reason/);
await assert.rejects(api.adminReports({ status: 'pending' }), /status/);
await assert.rejects(api.adminReviewReport({ reportId: 'not-a-uuid', status: 'resolved' }), /ID/);
await assert.rejects(api.adminReviewReport({ reportId: id, status: 'new' }), /status/);
reply = null;
await assert.rejects(api.identity(), /acknowledgement/);
const failing = createBackend({ async rpc() { return { error: { message: 'Permission denied' } }; } });
await assert.rejects(failing.identity(), /Permission denied/);
let resolve;
const pending = createBackend({ rpc() { return new Promise(done => { resolve = done; }); } });
const oldAccount = pending.identity();
pending.invalidate();
resolve({ data: { id, tag: 'Previous account' } });
await assert.rejects(oldAccount, /Account changed/);
console.log('PASS backend client: explicit payloads, identity, consent, errors, account race, and local-data boundary');
