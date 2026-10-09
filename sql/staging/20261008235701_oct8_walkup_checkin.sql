-- Host walk-ups during check-in; admission/document and claim limits remain unchanged.
create or replace function public.bkt_create_walkup(p_event_id uuid,p_tag text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_me uuid:=bkt_private.require_me(); v_event public.bkt_events%rowtype;
 v_player uuid; v_entry public.bkt_entries%rowtype; v_code text;
begin
 if p_tag is null or length(trim(p_tag)) not between 1 and 64
    or octet_length(trim(p_tag))>256 then
   raise exception 'invalid_tag' using errcode='22023';
 end if;
 select * into v_event from public.bkt_events where id=p_event_id for update;
 if not found or not bkt_private.is_staff(v_event.org_id) then
   raise exception 'staff_required' using errcode='42501';
 end if;
 if v_event.status not in ('registration','checkin') then raise exception 'registration_closed' using errcode='55000'; end if;
 if (select count(*) from public.bkt_entries where event_id=p_event_id)>=512 then
   raise exception 'roster_limit' using errcode='54000';
 end if;
 insert into public.bkt_players(tag) values(trim(p_tag)) returning id into v_player;
 insert into public.bkt_entries(event_id,player_id,waitlisted,source)
 values(p_event_id,v_player,(select count(*)>=v_event.capacity from public.bkt_entries where event_id=p_event_id and not waitlisted),'door')
 returning * into v_entry;
 v_code:=bkt_private.new_token();
 insert into bkt_private.claims(token_hash,event_id,player_id,expires_at)
 values(sha256(convert_to(v_code,'UTF8')),p_event_id,v_player,now()+interval '24 hours');
 update public.bkt_events set revision=revision+1 where id=p_event_id;
 return jsonb_build_object('entry',to_jsonb(v_entry),'player',jsonb_build_object('id',v_player,'tag',trim(p_tag)),'claim_code',v_code,'claim_expires_at',now()+interval '24 hours');
end $$;
revoke all on function public.bkt_create_walkup(uuid,text) from public,anon;
grant execute on function public.bkt_create_walkup(uuid,text) to authenticated;
