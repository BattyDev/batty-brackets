\set ON_ERROR_STOP on
begin;
create function pg_temp.assert_true(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'ASSERT: %',p_message; end if; end $$;
create function pg_temp.denied(p_sql text) returns void language plpgsql as $$
begin
 begin execute p_sql; exception when insufficient_privilege then return; end;
 raise exception 'ASSERT: unexpectedly authorized: %',p_sql;
end $$;
create function pg_temp.fails(p_sql text) returns void language plpgsql as $$
begin
 begin execute p_sql; exception when others then return; end;
 raise exception 'ASSERT: unexpectedly accepted: %',p_sql;
end $$;
insert into auth.users values
 ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002'),
 ('00000000-0000-0000-0000-000000000003'),('00000000-0000-0000-0000-000000000004');

-- Check effective grants, not merely whether policy text looks restrictive.
do $$ declare t record; r text; v text; begin
 foreach r in array array['anon','authenticated'] loop
  for t in select c.oid,n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where c.relkind='r' and (n.nspname='bkt_private' or n.nspname='public' and c.relname like 'bkt_%') loop
   foreach v in array array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
    perform pg_temp.assert_true(not has_table_privilege(r,t.oid,v),r||' '||v||' '||t.relname);
   end loop;
   if t.nspname='bkt_private' then perform pg_temp.assert_true(not has_table_privilege(r,t.oid,'SELECT'),'private table SELECT'); end if;
  end loop;
 end loop;
 perform pg_temp.assert_true(not has_schema_privilege('authenticated','bkt_private','USAGE'),'private schema hidden');
end $$;
set local role anon;
select pg_temp.denied($q$select public.bkt_identity('intruder')$q$);
select pg_temp.denied($q$select public.bkt_event_by_code('anything')$q$);
select pg_temp.denied($q$insert into public.bkt_players(tag) values('intruder')$q$);
reset role;
set local request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
set local role authenticated;
select public.bkt_identity('Owner')->>'id' as owner_id \gset
select pg_temp.assert_true(public.bkt_identity()->>'id'= :'owner_id','identity idempotent');
select pg_temp.assert_true(:'owner_id'<>'00000000-0000-0000-0000-000000000001','player separate from auth');
select public.bkt_create_event('10000000-0000-0000-0000-000000000001',
 '{"org_name":"One","name":"Public","game_id":"tokon","capacity":2,"format":"single","venue_type":"offline","venue":"Hall","platforms":["ps5"],"starts_at":"2026-10-01T18:00:00Z","entry_fee":0,"currency":"USD","preset_id":"local","overrides":{"dq":300},"documents":[{"id":"conduct","version":1,"required":true}],"stations":[{"label":"Stream","platform":"ps5"}]}') as created \gset
select pg_temp.assert_true((:'created'::jsonb->'event'->>'status')='registration','server status');
select pg_temp.assert_true((:'created'::jsonb->'stations'->0->>'label')='Stream','station labels roundtrip');
select public.bkt_create_event('10000000-0000-0000-0000-000000000002',
 '{"org_name":"One","name":"Hidden","game_id":"tokon","capacity":2,"visibility":"unlisted"}') as hidden \gset
select pg_temp.assert_true(public.bkt_create_event('10000000-0000-0000-0000-000000000002',
 '{"org_name":"One","name":"Hidden","game_id":"tokon","capacity":2,"visibility":"unlisted"}')= :'hidden'::jsonb,'create retry');
select pg_temp.fails($q$select public.bkt_create_event('10000000-0000-0000-0000-000000000002','{"name":"changed"}')$q$);
select pg_temp.fails($q$select public.bkt_create_event('10000000-0000-0000-0000-000000000003',
 '{"org_name":"One","name":"Bad","game_id":"tokon","capacity":2,"owner_id":"spoof"}')$q$);
select pg_temp.fails($q$select public.bkt_create_event('10000000-0000-0000-0000-000000000003',
 '{"org_name":"One","name":"Bad","game_id":"tokon","capacity":2,"entry_fee":10}')$q$);
select pg_temp.assert_true(jsonb_array_length(public.bkt_list_events()->'events')=2,'owner sees hidden');
select public.bkt_create_walkup('10000000-0000-0000-0000-000000000002','Walkup') as walkup \gset
select public.bkt_join_event('10000000-0000-0000-0000-000000000001') as owner_entry \gset
select pg_temp.denied($q$update public.bkt_entries set seed=1$q$);
select pg_temp.denied($q$delete from public.bkt_events$q$);
select pg_temp.denied($q$select * from bkt_private.claims$q$);
reset role;

-- Seed hidden child data as trusted fixture owner, then test real SELECT RLS.
insert into public.bkt_brackets(event_id) values('10000000-0000-0000-0000-000000000002');
set local request.jwt.claim.sub='';
set local role anon;
select pg_temp.assert_true((select count(*) from public.bkt_events)=1,'anon hidden event denied');
select pg_temp.assert_true((select count(*) from public.bkt_entries where event_id='10000000-0000-0000-0000-000000000002')=0,'anon hidden entry denied');
select pg_temp.assert_true((select count(*) from public.bkt_brackets)=0,'anon hidden bracket denied');
select pg_temp.assert_true((select count(*) from public.bkt_stations where event_id='10000000-0000-0000-0000-000000000002')=0,'anon hidden stations denied');
select pg_temp.denied($q$select public.bkt_read_event('10000000-0000-0000-0000-000000000002')$q$);
select pg_temp.assert_true(public.bkt_read_event('10000000-0000-0000-0000-000000000001') ?& array['orgs','brackets','results','revision'],'bundle arrays');
reset role;
delete from public.bkt_brackets where event_id='10000000-0000-0000-0000-000000000002';

set local request.jwt.claim.sub='00000000-0000-0000-0000-000000000002';
set local role authenticated;
select public.bkt_identity('Entrant')->>'id' as entrant_id \gset
select pg_temp.assert_true(jsonb_array_length(public.bkt_list_events()->'events')=1,'other account hidden denied');
select pg_temp.denied($q$select public.bkt_join_event('10000000-0000-0000-0000-000000000002')$q$);
select pg_temp.fails($q$select public.bkt_join_event(p_event_id=>'10000000-0000-0000-0000-000000000001',p_seed=>1)$q$);
select pg_temp.fails($q$select public.bkt_join_event('10000000-0000-0000-0000-000000000001','private',false)$q$);
select public.bkt_join_event('10000000-0000-0000-0000-000000000001','entrant@example.invalid',true) as joined \gset
select pg_temp.assert_true((:'joined'::jsonb->>'waitlisted')='false','second admitted');
select pg_temp.assert_true((:'joined'::jsonb->'seed')='null'::jsonb,'no self seed');
select pg_temp.assert_true(public.bkt_join_event('10000000-0000-0000-0000-000000000001')= :'joined'::jsonb,'join retry stable');
select pg_temp.assert_true(public.bkt_event_by_code('bad')->>'error'='invalid_code','bad token generic');
select pg_temp.assert_true(public.bkt_event_by_code(:'hidden'::jsonb->>'invite_code') ? 'access','code grants membership');
select pg_temp.assert_true(public.bkt_read_event('10000000-0000-0000-0000-000000000002')->'event'->>'name'='Hidden','redemption enables bundle');
select pg_temp.assert_true(public.bkt_claim_player(:'walkup'::jsonb->>'claim_code')->>'player_id'= :'entrant_id','unused walkup claimed');
select pg_temp.assert_true(public.bkt_claim_player(:'walkup'::jsonb->>'claim_code')->>'player_id'= :'entrant_id','claim retry');
reset role;

set local request.jwt.claim.sub='00000000-0000-0000-0000-000000000003';
set local role authenticated;
select public.bkt_identity('Other organizer');
select public.bkt_create_event('10000000-0000-0000-0000-000000000003',
 '{"org_name":"Other","name":"Other event","game_id":"tokon","capacity":2}');
select pg_temp.assert_true(public.bkt_join_event('10000000-0000-0000-0000-000000000001')->>'waitlisted'='true','overflow waitlisted');
select pg_temp.assert_true(public.bkt_read_contacts('10000000-0000-0000-0000-000000000001')='[]'::jsonb,'other organizer no contact');
select pg_temp.denied($q$insert into public.bkt_entries(event_id,player_id,waitlisted,seed)
 values('10000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001',false,1)$q$);
select pg_temp.assert_true(public.bkt_claim_player(:'walkup'::jsonb->>'claim_code')->>'error'='invalid_code','consumed token not transferable');
do $$ begin for i in 1..10 loop perform public.bkt_event_by_code('bad'); end loop; end $$;
select pg_temp.assert_true(public.bkt_event_by_code('bad')->>'error'='rate_limited','failed attempts persist');
reset role;
set local request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
set local role authenticated;
select pg_temp.assert_true(jsonb_array_length(public.bkt_read_contacts('10000000-0000-0000-0000-000000000001'))=1,'owner sees opted contact only');
reset role;
set local request.jwt.claim.sub='00000000-0000-0000-0000-000000000002';
set local role authenticated;
select public.bkt_set_contact('10000000-0000-0000-0000-000000000001');
reset role;
set local request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
set local role authenticated;
select pg_temp.assert_true(public.bkt_read_contacts('10000000-0000-0000-0000-000000000001')='[]'::jsonb,'revocation removes contact');
reset role;
select pg_temp.assert_true((select count(*) from public.bkt_entries where event_id='10000000-0000-0000-0000-000000000001' and not waitlisted)=2,'capacity invariant');
select pg_temp.assert_true(not exists(select 1 from information_schema.columns where table_schema='public' and table_name like 'bkt_%'
 and column_name in ('auth_user_id','contact','email','claim_code','invite_code','paid_at','typed_name')),'secrets never public columns');
rollback;
\echo 'Backend security regression assertions passed (transaction rolled back).'
