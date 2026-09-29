\set ON_ERROR_STOP on
begin;
create function pg_temp.admin_assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'ASSERT: %',p_message; end if; end $$;
create function pg_temp.admin_denied(p_sql text) returns void language plpgsql as $$
begin
 begin execute p_sql; exception when insufficient_privilege then return; end;
 raise exception 'ASSERT: unexpectedly authorized: %',p_sql;
end $$;
create function pg_temp.admin_fails(p_sql text) returns void language plpgsql as $$
begin
 begin execute p_sql; exception when others then return; end;
 raise exception 'ASSERT: unexpectedly accepted: %',p_sql;
end $$;

insert into auth.users(id) values
 ('00000000-0000-0000-0000-000000000001'),
 ('00000000-0000-0000-0000-000000000002'),
 ('00000000-0000-0000-0000-000000000003'),
 ('00000000-0000-0000-0000-000000000004')
on conflict (id) do nothing;
insert into bkt_private.admin_members(auth_user_id,role,active) values
 ('00000000-0000-0000-0000-000000000001','moderator',true),
 ('00000000-0000-0000-0000-000000000002','analyst',true),
 ('00000000-0000-0000-0000-000000000003','super_admin',true),
 ('00000000-0000-0000-0000-000000000004','moderator',false);

insert into public.bkt_players(id,tag) values
 ('20000000-0000-4000-8000-000000000001','Rae'),
 ('20000000-0000-4000-8000-000000000002','Kira');
insert into public.bkt_orgs(id,name,owner_id)
 values('30000000-0000-4000-8000-000000000001','Batty Arcade','20000000-0000-4000-8000-000000000001');
insert into public.bkt_events(id,org_id,name,game_id,capacity,visibility,venue)
 values('40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',
   'Weekly Bracket','tokon',8,'public','Main Hall');
insert into public.bkt_entries(id,event_id,player_id,waitlisted,crew)
 values
 ('50000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',false,'Blue Crew'),
 ('50000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',false,'Red Crew');
insert into public.bkt_stations(id,event_id,number,label)
 values('60000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',1,'Stream');
insert into public.bkt_results(id,event_id,match_id,game_id,winner_player_id,loser_player_id,score_winner,score_loser,reported_by)
 values('70000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','grand-final','tokon',
   '20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',2,1,
   '20000000-0000-4000-8000-000000000001');
insert into bkt_private.contacts(event_id,player_id,contact)
 values('40000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','private@example.invalid');

/* Effective grants: no admin function is callable by anon, while every
   authenticated RPC is still denied by its in-body membership/AAL checks. */
do $$ declare v text; begin
 foreach v in array array[
   'public.bkt_admin_access()',
   'public.bkt_admin_queue(text,integer)',
   'public.bkt_admin_content(text,integer)',
   'public.bkt_admin_moderate(text,text,uuid,text,jsonb,text)',
   'public.bkt_admin_audit(integer,timestamptz)',
   'public.bkt_admin_metrics(timestamptz,timestamptz)'
 ] loop
   perform pg_temp.admin_assert(not has_function_privilege('anon',v,'EXECUTE'),'anon denied '||v);
   perform pg_temp.admin_assert(has_function_privilege('authenticated',v,'EXECUTE'),'authenticated grant '||v);
 end loop;
 perform pg_temp.admin_assert(not has_table_privilege('authenticated','bkt_private.admin_members','SELECT'),'membership private');
 perform pg_temp.admin_assert(not has_table_privilege('authenticated','bkt_private.moderation_queue','SELECT'),'queue private');
 perform pg_temp.admin_assert(not has_table_privilege('authenticated','bkt_private.admin_audit','SELECT'),'audit private');
end $$;

set local request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
set local request.jwt.claim.aal='aal1';
set local role authenticated;
select pg_temp.admin_fails($q$select public.bkt_admin_access()$q$);
/* A user-editable metadata value never upgrades an AAL1 session. */
set local request.jwt.claim.user_metadata='{"aal":"aal2"}';
select pg_temp.admin_fails($q$select public.bkt_admin_metrics()$q$);
reset role;

set local request.jwt.claim.aal='aal2';
set local role authenticated;
select pg_temp.admin_assert(public.bkt_admin_access()->>'role'='moderator','moderator access');
select pg_temp.admin_assert((public.bkt_admin_queue()->'items')='[]'::jsonb,'empty queue');
select pg_temp.admin_fails($q$select public.bkt_admin_moderate('delete','player','20000000-0000-4000-8000-000000000001','tag',null,null)$q$);
select public.bkt_admin_moderate('quarantine','player','20000000-0000-4000-8000-000000000001','tag',null,'slur review');
select pg_temp.admin_assert((public.bkt_admin_content('player')->'items'->0->>'value')='[quarantined]','player quarantine redacts');
select pg_temp.admin_assert((public.bkt_admin_queue('quarantined')->'items'->0->>'target_kind')='player','queue target kind');
select public.bkt_admin_moderate('replace','player','20000000-0000-4000-8000-000000000001','tag','"Rae"'::jsonb,'reviewed tag');
select pg_temp.admin_assert((public.bkt_admin_content('player')->'items'->0->>'value')='Rae','replacement applies');
select public.bkt_admin_moderate('restore','player','20000000-0000-4000-8000-000000000001','tag',null,'restore source');
select pg_temp.admin_assert((public.bkt_admin_content('player')->'items'->0->>'value')='Rae','restore uses private snapshot');
select public.bkt_admin_moderate('quarantine','org','30000000-0000-4000-8000-000000000001','name',null,'org review');
select pg_temp.admin_assert((public.bkt_admin_content('org')->'items'->0->>'value')='[quarantined]','org text quarantine');
select public.bkt_admin_moderate('replace','event','40000000-0000-4000-8000-000000000001','venue','"Side Hall"'::jsonb,'venue correction');
select pg_temp.admin_assert((public.bkt_admin_content('event')->'items'->1->>'value')='Side Hall','event text replacement');
select public.bkt_admin_moderate('hide','entry','50000000-0000-4000-8000-000000000001','crew',null,'roster review');
select pg_temp.admin_assert((public.bkt_admin_content('entry')->'items'->0->>'value')='[hidden]','roster text hide');
select public.bkt_admin_moderate('lock','station','60000000-0000-4000-8000-000000000001','label',null,'final station label');
select public.bkt_admin_moderate('replace','station','60000000-0000-4000-8000-000000000001','label','"Desk"'::jsonb,'reviewed label correction');
select pg_temp.admin_assert((select label from public.bkt_stations where id='60000000-0000-4000-8000-000000000001')='Desk','moderator RPC changes held content');
reset role;
select pg_temp.admin_fails($q$update public.bkt_stations set label='Organizer overwrite' where id='60000000-0000-4000-8000-000000000001'$q$);
set local request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
set role authenticated;
select public.bkt_admin_moderate('hide','result','70000000-0000-4000-8000-000000000001',null,null,'result dispute');
reset role;
set local request.jwt.claim.sub='';
set local role anon;
select pg_temp.admin_assert((select count(*) from public.bkt_results where id='70000000-0000-4000-8000-000000000001')=0,'hidden result RLS');
reset role;
set local request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
set local role authenticated;
select pg_temp.admin_assert(public.bkt_admin_metrics()->'totals' ? 'results','metrics totals');
select pg_temp.admin_assert(position('private@example.invalid' in public.bkt_admin_content()::text)=0,'contacts excluded from content');
reset role;

/* Analysts receive aggregate metrics only; queue/content/audit are limited to
   moderators and super admins, and analysts cannot mutate moderation state. */
set local request.jwt.claim.sub='00000000-0000-0000-0000-000000000002';
set local role authenticated;
select pg_temp.admin_assert(public.bkt_admin_access()->>'role'='analyst','analyst access');
select pg_temp.admin_assert((public.bkt_admin_metrics()->'totals') ? 'events','analyst metrics read');
select pg_temp.admin_fails($q$select public.bkt_admin_queue()$q$);
select pg_temp.admin_fails($q$select public.bkt_admin_content()$q$);
select pg_temp.admin_fails($q$select public.bkt_admin_audit()$q$);
select pg_temp.admin_fails($q$select public.bkt_admin_moderate('restore','result','70000000-0000-4000-8000-000000000001',null,null,null)$q$);
reset role;

/* A super admin can unlock by restoring the private original snapshot. */
set local request.jwt.claim.sub='00000000-0000-0000-0000-000000000003';
set local role authenticated;
select pg_temp.admin_assert(public.bkt_admin_access()->>'role'='super_admin','super admin access');
select public.bkt_admin_moderate('restore','result','70000000-0000-4000-8000-000000000001',null,null,'resolve dispute');
reset role;
set local request.jwt.claim.sub='';
set local role anon;
select pg_temp.admin_assert((select count(*) from public.bkt_results where id='70000000-0000-4000-8000-000000000001')=1,'result restore');
select pg_temp.admin_assert((select moderation_state from public.bkt_results where id='70000000-0000-4000-8000-000000000001')='visible','restored result durable');
reset role;
set local request.jwt.claim.sub='00000000-0000-0000-0000-000000000003';
set local role authenticated;
select public.bkt_admin_moderate('replace','result','70000000-0000-4000-8000-000000000001',null,'{"score_winner":3}'::jsonb,'correct score');
reset role;
select pg_temp.admin_assert((select count(*) from public.bkt_results where event_id='40000000-0000-4000-8000-000000000001' and not superseded)=1,'one active corrected result');
select pg_temp.admin_assert((select score_winner from public.bkt_results where event_id='40000000-0000-4000-8000-000000000001' and not superseded)=3,'corrective result score');
update public.bkt_results set score_winner=9 where event_id='40000000-0000-4000-8000-000000000001';
delete from public.bkt_results where event_id='40000000-0000-4000-8000-000000000001';
select pg_temp.admin_assert((select count(*) from public.bkt_results where event_id='40000000-0000-4000-8000-000000000001' and not superseded)=1,'ordinary replay preserves active correction');
select pg_temp.admin_assert((select score_winner from public.bkt_results where event_id='40000000-0000-4000-8000-000000000001' and not superseded)=3,'ordinary replay cannot rewrite correction');
set local request.jwt.claim.sub='00000000-0000-0000-0000-000000000003';
set role authenticated;
select public.bkt_admin_moderate('restore','result','70000000-0000-4000-8000-000000000001',null,null,'undo correction');
reset role;
select pg_temp.admin_assert((select count(*) from public.bkt_results where event_id='40000000-0000-4000-8000-000000000001' and not superseded)=1,'restore leaves one active result');
select pg_temp.admin_assert((select score_winner from public.bkt_results where id='70000000-0000-4000-8000-000000000001')=2,'restore original result');
set local request.jwt.claim.sub='00000000-0000-0000-0000-000000000003';
set role authenticated;
select pg_temp.admin_fails($q$update bkt_private.admin_audit set reason='tampered' where id=(select id from bkt_private.admin_audit limit 1)$q$);
select pg_temp.admin_fails($q$delete from bkt_private.admin_audit$q$);
reset role;

set local request.jwt.claim.sub='00000000-0000-0000-0000-000000000004';
set local request.jwt.claim.aal='aal2';
set local role authenticated;
select pg_temp.admin_fails($q$select public.bkt_admin_access()$q$);
select pg_temp.admin_denied($q$select * from bkt_private.moderation_queue$q$);
select pg_temp.admin_denied($q$delete from public.bkt_players$q$);
reset role;

select pg_temp.admin_assert((select count(*) from bkt_private.admin_audit)>=11,'audit records append');
select pg_temp.admin_assert(not exists(select 1 from bkt_private.admin_audit where target_kind='contact'),'no contact audit target');
rollback;
\echo 'Admin security regression assertions passed (transaction rolled back).'
