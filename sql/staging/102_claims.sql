begin;
do $$ begin
 if current_setting('bkt.staging',true) is distinct from 'on' then raise exception 'Staging session required'; end if;
end $$;

-- Deliberately narrow: no automatic history merge. A claim transfers just one
-- unused, free-event entry. Once play/check-in/signing begins the claim closes.
create function public.bkt_create_walkup(p_event_id uuid,p_tag text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_me uuid:=bkt_private.require_me(); v_event public.bkt_events%rowtype;
 v_player uuid; v_entry public.bkt_entries%rowtype; v_code text;
begin
 select * into v_event from public.bkt_events where id=p_event_id for update;
 if not found or not bkt_private.is_staff(v_event.org_id) then
   raise exception 'staff_required' using errcode='42501';
 end if;
 if v_event.status<>'registration' then raise exception 'registration_closed' using errcode='55000'; end if;
 if (select count(*) from public.bkt_entries where event_id=p_event_id)>=512 then
   raise exception 'roster_limit' using errcode='54000';
 end if;
 insert into public.bkt_players(tag) values(p_tag) returning id into v_player;
 insert into public.bkt_entries(event_id,player_id,waitlisted)
 values(p_event_id,v_player,(select count(*)>=v_event.capacity from public.bkt_entries where event_id=p_event_id and not waitlisted))
 returning * into v_entry;
 v_code:=bkt_private.new_token();
 insert into bkt_private.claims(token_hash,event_id,player_id,expires_at)
 values(sha256(convert_to(v_code,'UTF8')),p_event_id,v_player,now()+interval '24 hours');
 update public.bkt_events set revision=revision+1 where id=p_event_id;
 return jsonb_build_object('entry',to_jsonb(v_entry),'player',jsonb_build_object('id',v_player,'tag',p_tag),'claim_code',v_code);
end $$;

create function public.bkt_claim_player(p_code text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_me uuid:=bkt_private.require_me(); v_claim bkt_private.claims%rowtype;
 v_event public.bkt_events%rowtype; v_entry public.bkt_entries%rowtype;
begin
 if not bkt_private.attempt('claim') then return jsonb_build_object('error','rate_limited'); end if;
 if p_code is null or p_code !~ '^[0-9a-fA-F]{64}$' then return jsonb_build_object('error','invalid_code'); end if;
 select * into v_claim from bkt_private.claims where token_hash=sha256(convert_to(lower(p_code),'UTF8'));
 if not found then return jsonb_build_object('error','invalid_code'); end if;
 -- Event before token: same lock order as admission. Re-read token after waiting.
 select * into v_event from public.bkt_events where id=v_claim.event_id for update;
 select * into v_claim from bkt_private.claims where token_hash=v_claim.token_hash for update;
 if v_claim.consumed_at is not null then
   if v_claim.consumed_by=v_me then
     return jsonb_build_object('claimed_player_id',v_claim.player_id,'player_id',v_me,'event_id',v_claim.event_id);
   end if;
   return jsonb_build_object('error','invalid_code');
 end if;
 if v_claim.expires_at<=now() then return jsonb_build_object('error','invalid_code'); end if;
 select * into v_entry from public.bkt_entries where event_id=v_claim.event_id and player_id=v_claim.player_id for update;
 if not found or v_event.status<>'registration' or v_entry.seed is not null or v_entry.checked_in_at is not null
    or exists(select 1 from bkt_private.identities where player_id=v_claim.player_id)
    or exists(select 1 from public.bkt_entries where player_id=v_claim.player_id and event_id<>v_claim.event_id)
    or exists(select 1 from public.bkt_entries where player_id=v_me and event_id=v_claim.event_id)
    or exists(select 1 from public.bkt_brackets where event_id=v_claim.event_id)
    or exists(select 1 from public.bkt_results where winner_player_id=v_claim.player_id or loser_player_id=v_claim.player_id)
    or exists(select 1 from bkt_private.signatures where player_id=v_claim.player_id)
    or exists(select 1 from bkt_private.contacts where player_id=v_claim.player_id) then
   return jsonb_build_object('error','claim_requires_review');
 end if;
 update public.bkt_entries set player_id=v_me where id=v_entry.id;
 update bkt_private.claims set consumed_by=v_me,consumed_at=now() where token_hash=v_claim.token_hash;
 update public.bkt_events set revision=revision+1 where id=v_claim.event_id;
 return jsonb_build_object('claimed_player_id',v_claim.player_id,'player_id',v_me,'event_id',v_claim.event_id);
end $$;
revoke all on function public.bkt_create_walkup(uuid,text),public.bkt_claim_player(text) from public,anon,authenticated;
grant execute on function public.bkt_create_walkup(uuid,text),public.bkt_claim_player(text) to authenticated;
commit;
