begin;
-- Map moderation commands to their stored states without changing access or audit rules.
create or replace function public.bkt_admin_moderate(
  p_action text,
  p_target_kind text,
  p_target_id uuid,
  p_target_field text default null,
  p_replacement jsonb default null,
  p_reason text default null
) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare
 v_role text;
  v_field text;
  v_queue bkt_private.moderation_queue%rowtype;
  v_have_queue boolean:=false;
  v_player public.bkt_players%rowtype;
  v_org public.bkt_orgs%rowtype;
  v_event public.bkt_events%rowtype;
  v_entry public.bkt_entries%rowtype;
  v_station public.bkt_stations%rowtype;
  v_result public.bkt_results%rowtype;
  v_current_result public.bkt_results%rowtype;
  v_original jsonb;
 v_before jsonb;
 v_after jsonb;
 v_value text;
 v_state text;
  v_locked boolean:=false;
 v_replacement_result_id uuid;
 v_event_id uuid;
 v_key text;
 v_audit uuid;
begin
 v_role:=bkt_private.require_admin(array['moderator','super_admin']);
 if p_action is null or not (p_action=any(array['hide','quarantine','restore','replace','lock'])) then
   raise exception 'invalid_moderation_action' using errcode='22023';
 end if;
 if p_target_kind is null or not (p_target_kind=any(array['player','org','event','entry','station','bracket','result']))
    or p_target_id is null then
   raise exception 'invalid_moderation_target' using errcode='22023';
 end if;
 v_field:=nullif(trim(coalesce(p_target_field,'')),'');
 if p_target_kind='result' then
   v_field:=coalesce(v_field,'record');
 end if;
 if v_field is null or not bkt_private.admin_field_allowed(p_target_kind,v_field) then
   raise exception 'invalid_moderation_field' using errcode='22023';
 end if;
 if p_action='replace' and p_target_kind='station' and v_field='match_id' then
   raise exception 'linked_match_id_replace_not_allowed' using errcode='22023';
 end if;
 if p_reason is null or length(trim(p_reason)) not between 1 and 2000 then
   raise exception 'invalid_moderation_reason' using errcode='22023';
 end if;
 /* This flag exists only inside the reviewed moderation RPC transaction. It
    lets an authorized moderator change a held target while organizer RPCs
    remain unable to write through the trigger. */
 perform set_config('bkt.admin_override','on',true);

 perform pg_advisory_xact_lock(hashtextextended(p_target_kind||':'||p_target_id::text||':'||v_field,12));
 select * into v_queue from bkt_private.moderation_queue
  where target_kind=p_target_kind and target_id=p_target_id and target_field=v_field for update;
 v_have_queue:=found;
 if v_have_queue then
   v_original:=v_queue.original_value;
   v_locked:=v_queue.locked;
   v_replacement_result_id:=v_queue.replacement_result_id;
 end if;

 if p_target_kind='result' then
   select * into v_result from public.bkt_results where id=p_target_id for update;
   if not found then raise exception 'moderation_target_not_found' using errcode='22023'; end if;
   v_current_result:=v_result;
   if v_have_queue and v_replacement_result_id is not null then
     select * into v_current_result from public.bkt_results where id=v_replacement_result_id for update;
     if not found then raise exception 'replacement_result_not_found' using errcode='22023'; end if;
     v_before:=to_jsonb(v_current_result);
   else
     v_before:=to_jsonb(v_result);
   end if;
   v_event_id:=v_current_result.event_id;
   if not v_have_queue then v_original:=v_before; end if;
 else
   v_before:=bkt_private.admin_snapshot(p_target_kind,p_target_id,v_field);
   if v_before is null then raise exception 'moderation_target_not_found' using errcode='22023'; end if;
   if p_target_kind in ('event','bracket') then v_event_id:=p_target_id;
   elsif p_target_kind='entry' then select en.event_id into v_event_id from public.bkt_entries en where en.id=p_target_id;
   elsif p_target_kind='station' then select s.event_id into v_event_id from public.bkt_stations s where s.id=p_target_id;
   end if;
   if not v_have_queue then v_original:=v_before; end if;
 end if;

 /* Restoring must never erase a newer organizer edit. Once a prior decision
    has been restored, a later moderation cycle snapshots the then-current
    value as its new restore point. */
 if p_target_kind<>'result' and v_have_queue then
   if v_queue.state in ('hidden','quarantined') and v_before is distinct from coalesce(v_queue.replacement_value,v_queue.original_value) then
     raise exception 'moderation_target_changed' using errcode='40001';
   elsif v_queue.state='replaced' and v_before is distinct from v_queue.replacement_value then
     raise exception 'moderation_target_changed' using errcode='40001';
   elsif v_queue.state='open' and v_queue.locked and v_before is distinct from v_queue.original_value then
     raise exception 'moderation_target_changed' using errcode='40001';
   elsif (v_queue.state='restored' or (v_queue.state='open' and not v_queue.locked)) and p_action<>'restore' then
     v_original:=v_before;
   end if;
 end if;

 /* Every active decision is a durable moderation hold. Organizer state replay
    cannot overwrite it; a moderator must use this audited RPC to restore or
    issue a further correction. */
 if p_action in ('lock','hide','quarantine','replace') then v_locked:=true;
 elsif p_action='restore' then v_locked:=false;
 end if;

 if p_action='restore' and (not v_have_queue or (v_queue.state='open' and not v_queue.locked)) then
   raise exception 'nothing_to_restore' using errcode='22023';
 end if;

 if p_target_kind<>'result' then
   if p_action='replace' then
     if not bkt_private.admin_value_valid(p_target_kind,p_target_id,v_field,p_replacement) then
       raise exception 'invalid_moderation_replacement' using errcode='22023';
     end if;
     perform bkt_private.admin_write_value(p_target_kind,p_target_id,v_field,p_replacement);
     v_after:=bkt_private.admin_snapshot(p_target_kind,p_target_id,v_field);
     v_state:='replaced';
   elsif p_action='restore' then
     if v_queue.state='replaced' or v_queue.replacement_value is not null then
       perform bkt_private.admin_write_value(p_target_kind,p_target_id,v_field,v_original);
       v_after:=v_original;
     else
       v_after:=v_before;
     end if;
     v_state:='restored';
   elsif p_action='lock' then
     v_after:=v_before;
     v_state:=coalesce(v_queue.state,'open');
   else
     v_state:=case p_action when 'hide' then 'hidden' when 'quarantine' then 'quarantined' end;
     v_after:=v_before;
   end if;
 else
   if p_action='replace' then
     if p_replacement is null or jsonb_typeof(p_replacement) is distinct from 'object' then
       raise exception 'result_replacement_required' using errcode='22023';
     end if;
     for v_key in select jsonb_object_keys(p_replacement) loop
       if not (v_key=any(array['game_id','round_name','score_winner','score_loser','by_dq','winner_player_id','loser_player_id'])) then
         raise exception 'invalid_result_replacement_field' using errcode='22023';
       end if;
     end loop;
     if p_replacement ? 'game_id' and (jsonb_typeof(p_replacement->'game_id') is distinct from 'string'
         or length(trim(p_replacement->>'game_id')) not between 1 and 64) then
       raise exception 'invalid_result_game' using errcode='22023';
     end if;
     if p_replacement ? 'round_name' and jsonb_typeof(p_replacement->'round_name') not in ('string','null') then
       raise exception 'invalid_result_round' using errcode='22023';
     end if;
     if p_replacement ? 'round_name' and p_replacement->>'round_name' is not null
        and length(p_replacement->>'round_name')>120 then
       raise exception 'invalid_result_round' using errcode='22023';
     end if;
     if p_replacement ? 'score_winner' and (jsonb_typeof(p_replacement->'score_winner') is distinct from 'number'
         or (p_replacement->>'score_winner') !~ '^[0-9]+$'
         or (p_replacement->>'score_winner')::integer not between 0 and 99) then
       raise exception 'invalid_result_score' using errcode='22023';
     end if;
     if p_replacement ? 'score_loser' and (jsonb_typeof(p_replacement->'score_loser') is distinct from 'number'
         or (p_replacement->>'score_loser') !~ '^[0-9]+$'
         or (p_replacement->>'score_loser')::integer not between 0 and 99) then
       raise exception 'invalid_result_score' using errcode='22023';
     end if;
     if p_replacement ? 'by_dq' and jsonb_typeof(p_replacement->'by_dq') is distinct from 'boolean' then
       raise exception 'invalid_result_dq' using errcode='22023';
     end if;
     if p_replacement ? 'winner_player_id' and (jsonb_typeof(p_replacement->'winner_player_id') is distinct from 'string'
         or (p_replacement->>'winner_player_id')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') then
       raise exception 'invalid_result_player' using errcode='22023';
     end if;
     if p_replacement ? 'loser_player_id' and (jsonb_typeof(p_replacement->'loser_player_id') is distinct from 'string'
         or (p_replacement->>'loser_player_id')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') then
       raise exception 'invalid_result_player' using errcode='22023';
     end if;
     if p_replacement ? 'winner_player_id' and not exists(select 1 from public.bkt_entries en
        where en.event_id=v_result.event_id and en.player_id=(p_replacement->>'winner_player_id')::uuid) then
       raise exception 'invalid_result_player' using errcode='22023';
     end if;
     if p_replacement ? 'loser_player_id' and not exists(select 1 from public.bkt_entries en
        where en.event_id=v_result.event_id and en.player_id=(p_replacement->>'loser_player_id')::uuid) then
       raise exception 'invalid_result_player' using errcode='22023';
     end if;
     if coalesce((p_replacement->>'winner_player_id')::uuid,v_current_result.winner_player_id)
        =coalesce((p_replacement->>'loser_player_id')::uuid,v_current_result.loser_player_id) then
       raise exception 'invalid_result_players' using errcode='22023';
     end if;
     /* Corrections are append-only: close the prior active row and create a
        new result record.  The old row and all prior corrections remain
        queryable to the trusted audit path. */
     if v_replacement_result_id is not null then
       update public.bkt_results set superseded=true,superseded_at=coalesce(superseded_at,now())
        where id=v_replacement_result_id;
     else
       update public.bkt_results set superseded=true,superseded_at=coalesce(superseded_at,now()),
         moderation_state='replaced',moderation_locked=v_locked
        where id=v_result.id;
     end if;
     v_replacement_result_id:=gen_random_uuid();
     insert into public.bkt_results(
       id,event_id,match_id,game_id,round_name,winner_player_id,loser_player_id,
       score_winner,score_loser,by_dq,reported_at,reported_by,superseded,superseded_at,
       moderation_state,moderation_locked
     ) values(
       v_replacement_result_id,v_current_result.event_id,v_current_result.match_id,
       case when p_replacement ? 'game_id' then trim(p_replacement->>'game_id') else v_current_result.game_id end,
       case when p_replacement ? 'round_name' then p_replacement->>'round_name' else v_current_result.round_name end,
       case when p_replacement ? 'winner_player_id' then (p_replacement->>'winner_player_id')::uuid else v_current_result.winner_player_id end,
       case when p_replacement ? 'loser_player_id' then (p_replacement->>'loser_player_id')::uuid else v_current_result.loser_player_id end,
       case when p_replacement ? 'score_winner' then (p_replacement->>'score_winner')::integer else v_current_result.score_winner end,
       case when p_replacement ? 'score_loser' then (p_replacement->>'score_loser')::integer else v_current_result.score_loser end,
       case when p_replacement ? 'by_dq' then (p_replacement->>'by_dq')::boolean else v_current_result.by_dq end,
       now(),v_current_result.reported_by,false,null,'visible',v_locked
     );
     v_state:='replaced';
   elsif p_action='hide' or p_action='quarantine' then
     update public.bkt_results set moderation_state=case p_action when 'hide' then 'hidden' when 'quarantine' then 'quarantined' end,moderation_locked=v_locked
       where id=coalesce(v_replacement_result_id,p_target_id);
     v_state:=case p_action when 'hide' then 'hidden' when 'quarantine' then 'quarantined' end;
   elsif p_action='restore' then
     if jsonb_typeof(v_original) is distinct from 'object' then raise exception 'invalid_result_snapshot' using errcode='22023'; end if;
     if v_replacement_result_id is not null then
       update public.bkt_results set superseded=true,superseded_at=coalesce(superseded_at,now())
        where id=v_replacement_result_id;
     end if;
     update public.bkt_results set moderation_state='visible',moderation_locked=false,
       superseded=false,superseded_at=null where id=p_target_id;
     v_replacement_result_id:=null;
     v_state:='restored';
   else
     update public.bkt_results set moderation_locked=true
       where id=coalesce(v_replacement_result_id,p_target_id);
     v_state:=coalesce(v_queue.state,'open');
   end if;
   if p_action='replace' then
     select to_jsonb(r) into v_after from public.bkt_results r where r.id=v_replacement_result_id;
   elsif p_action='restore' then
     select to_jsonb(r) into v_after from public.bkt_results r where r.id=p_target_id;
   else
     select to_jsonb(r) into v_after from public.bkt_results r where r.id=coalesce(v_replacement_result_id,p_target_id);
   end if;
 end if;

 if v_event_id is not null then
   update public.bkt_events set revision=revision+1 where id=v_event_id;
 end if;

 if v_have_queue then
   update bkt_private.moderation_queue set
     state=v_state,
     replacement_value=case when p_action='replace' then p_replacement
       when p_action='restore' then null else replacement_value end,
     replacement_result_id=v_replacement_result_id,
     reason=coalesce(nullif(trim(p_reason),''),reason),
     source='moderation',
     locked=v_locked,
     created_by=coalesce(created_by,auth.uid()),updated_by=auth.uid(),updated_at=now()
   where id=v_queue.id returning * into v_queue;
 else
   insert into bkt_private.moderation_queue(
     target_kind,target_id,target_field,state,original_value,replacement_value,replacement_result_id,reason,source,locked,created_by,updated_by
   ) values(
     p_target_kind,p_target_id,v_field,v_state,v_original,
     case when p_action='replace' then p_replacement else null end,
     v_replacement_result_id,
     nullif(trim(p_reason),''),'moderation',v_locked,auth.uid(),auth.uid()
   ) returning * into v_queue;
 end if;
 if p_target_kind<>'result' and p_action in ('hide','quarantine') then
   v_after:=bkt_private.admin_scrub_value(p_target_kind,p_target_id,v_field,v_before);
 end if;
 insert into bkt_private.admin_audit(
   admin_auth_user_id,admin_role,action,target_kind,target_id,target_field,before_value,after_value,reason
 ) values(auth.uid(),v_role,p_action,p_target_kind,p_target_id,v_field,v_before,v_after,nullif(trim(p_reason),''))
 returning id into v_audit;
 perform set_config('bkt.admin_override','off',true);
 return jsonb_build_object(
   'action_id',v_audit,
   'action',p_action,
   'target_kind',p_target_kind,
   'target_id',p_target_id,
   'target_field',v_field,
   'content',v_after,
   'queue',to_jsonb(v_queue)
 );
end $$;
commit;
