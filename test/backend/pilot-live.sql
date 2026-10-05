-- Focused hosted-database check after migrations 106-108.
-- Run as the trusted SQL operator. Uses temporary fixture identities and
-- simulated JWT claims, not browser Auth sessions. Every write is rolled back.
-- Do not remove the BEGIN/ROLLBACK or append COMMIT.
begin;
set local statement_timeout='20s';
do $pilot$
declare
 owner_auth uuid:=gen_random_uuid(); player_auth uuid:=gen_random_uuid();
 opponent_auth uuid:=gen_random_uuid(); outsider_auth uuid:=gen_random_uuid();
 eid uuid:=gen_random_uuid(); proposal uuid:=gen_random_uuid(); withdrawal uuid:=gen_random_uuid();
 owner_player uuid; player_id uuid; opponent_id uuid; entry_a uuid; entry_b uuid;
 result_id uuid:=gen_random_uuid(); rev bigint; bundle jsonb; state jsonb; match jsonb; response jsonb;
begin
 insert into auth.users(id) values(owner_auth),(player_auth),(opponent_auth),(outsider_auth);
 perform set_config('request.jwt.claim.sub',owner_auth::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',owner_auth,'role','authenticated','is_anonymous',false)::text,true);
 set local role authenticated;
 owner_player:=(public.bkt_identity('Pilot check host')->>'id')::uuid;
 response:=public.bkt_create_event(eid,'{"org_name":"Pilot rollback check","name":"Pilot rollback check","game_id":"tokon","capacity":4,"format":"single","visibility":"public"}');
 assert response->'event'->>'status'='registration','create event';
 perform set_config('request.jwt.claim.sub',player_auth::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',player_auth,'role','authenticated','is_anonymous',true)::text,true);
 player_id:=(public.bkt_identity('Pilot check player')->>'id')::uuid;
 entry_a:=(public.bkt_join_event(eid)->>'id')::uuid;
 assert (public.bkt_join_event(eid)->>'id')::uuid=entry_a,'join idempotency';
 response:=public.bkt_withdraw_entry(withdrawal,eid);
 assert response->>'status'='withdrawn','pre-bracket withdrawal';
 assert public.bkt_withdraw_entry(withdrawal,eid)=response,'withdrawal idempotency';
 assert jsonb_array_length(public.bkt_read_event(eid)->'entries')=0,'entry removed';
 entry_a:=(public.bkt_join_event(eid)->>'id')::uuid;
 perform set_config('request.jwt.claim.sub',opponent_auth::text,true);
 opponent_id:=(public.bkt_identity('Pilot check opponent')->>'id')::uuid;
 entry_b:=(public.bkt_join_event(eid)->>'id')::uuid;
 perform set_config('request.jwt.claim.sub',owner_auth::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',owner_auth,'role','authenticated','is_anonymous',false)::text,true);
 bundle:=public.bkt_read_event(eid); rev:=(bundle->>'revision')::bigint;
 match:=jsonb_build_object('id','W1-1','calledAt',now(),'slots',jsonb_build_array(
   jsonb_build_object('entrantId',entry_a),jsonb_build_object('entrantId',entry_b)));
 state:=jsonb_build_object(
 'event',jsonb_build_object('id',eid,'status','running'),
 'players',jsonb_build_array(jsonb_build_object('id',player_id,'tag','Pilot check player'),jsonb_build_object('id',opponent_id,'tag','Pilot check opponent')),
 'entries',jsonb_build_array(jsonb_build_object('id',entry_a,'eventId',eid,'playerId',player_id),jsonb_build_object('id',entry_b,'eventId',eid,'playerId',opponent_id)),
 'stations','[]'::jsonb,'results','[]'::jsonb,
 'bracket',jsonb_build_object('eventId',eid,'type','single','size',2,'rounds',1,'matches',jsonb_build_array(match)));
 bundle:=public.bkt_save_event_state(eid,rev,state);
 assert (bundle->>'revision')::bigint=rev+1,'host save acknowledgement';
 begin
   perform public.bkt_save_event_state(eid,rev,state);
   raise exception 'stale save unexpectedly accepted';
 exception when serialization_failure then null; end;
 rev:=(bundle->>'revision')::bigint;
 perform set_config('request.jwt.claim.sub',outsider_auth::text,true);
 perform public.bkt_identity('Pilot check outsider');
 begin
   perform public.bkt_submit_match_result(gen_random_uuid(),eid,'W1-1',rev,entry_a,2,1);
   raise exception 'outsider submitted result';
 exception when insufficient_privilege then null; end;
 begin
   perform public.bkt_withdraw_entry(gen_random_uuid(),eid);
   raise exception 'outsider withdrew entry';
 exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claim.sub',player_auth::text,true);
 response:=public.bkt_submit_match_result(proposal,eid,'W1-1',rev,entry_a,2,1);
 assert response->>'status'='pending','player result pending';
 assert public.bkt_submit_match_result(proposal,eid,'W1-1',rev,entry_a,2,1)=response,'proposal retry';
 begin
   perform public.bkt_review_match_result(proposal,rev,state,'accepted');
   raise exception 'player reviewed result';
 exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claim.sub',opponent_auth::text,true);
 assert jsonb_array_length(public.bkt_read_event(eid)->'match_submissions')=0,'other player proposal hidden';
 response:=public.bkt_withdraw_entry(gen_random_uuid(),eid);
 assert response->>'status'='pending','active withdrawal pending';
 perform set_config('request.jwt.claim.sub',owner_auth::text,true);
 bundle:=public.bkt_read_event(eid);
 assert (bundle->>'revision')::bigint=rev,'requests preserve event revision';
 assert jsonb_array_length(bundle->'match_submissions')=1,'host sees proposal';
 assert jsonb_array_length(bundle->'withdrawals')=2,'host sees withdrawals';
 match:=match||jsonb_build_object('state','complete','winnerId',entry_a,'score',jsonb_build_object('a',2,'b',1));
 state:=jsonb_set(state,'{bracket,matches}',jsonb_build_array(match));
 state:=jsonb_set(state,'{results}',jsonb_build_array(jsonb_build_object(
   'id',result_id,'eventId',eid,'matchId','W1-1','winnerPlayerId',player_id,'loserPlayerId',opponent_id,'scoreWinner',2,'scoreLoser',1)));
 bundle:=public.bkt_review_match_result(proposal,rev,state,'accepted');
 assert bundle->'match_submissions'->0->>'status'='accepted','host approval';
 assert jsonb_array_length(bundle->'results')=1,'accepted result persisted';
 rev:=(bundle->>'revision')::bigint;
 state:=jsonb_set(state,'{results,0,byDq}','true'::jsonb);
 bundle:=public.bkt_save_event_state(eid,rev,state);
 assert exists(select 1 from jsonb_array_elements(bundle->'withdrawals') w where w->>'status'='resolved'),'DQ resolves withdrawal';
 set local role anon;
 perform set_config('request.jwt.claim.sub','',true);
 perform set_config('request.jwt.claims','{}',true);
 bundle:=public.bkt_read_event(eid);
 assert jsonb_array_length(bundle->'results')=1,'public TV read';
 assert jsonb_array_length(bundle->'match_submissions')=0,'public proposal privacy';
 assert jsonb_array_length(bundle->'withdrawals')=0,'public withdrawal privacy';
 begin
   perform public.bkt_withdraw_entry(gen_random_uuid(),eid);
   raise exception 'anonymous write accepted';
 exception when insufficient_privilege then null; end;
 reset role;
end $pilot$;
rollback;
select 'PASS: hosted RPC pilot check; all fixture writes rolled back' as result;
