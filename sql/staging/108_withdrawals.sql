-- A pre-bracket withdrawal removes only the entry. Once seeded, staff must
-- record a DQ in an open match; the bracket and completed results stay intact.
begin;

create table bkt_private.withdrawals (
 id uuid primary key,
 event_id uuid not null references public.bkt_events(id),
 entry_id uuid not null,
 player_id uuid not null references public.bkt_players(id),
 status text not null check (status in ('withdrawn','pending','resolved')),
 requested_at timestamptz not null default now(),
 resolved_at timestamptz,
 resolved_match_id text
);
create unique index bkt_one_pending_withdrawal on bkt_private.withdrawals(event_id,player_id)
 where status='pending';
create index bkt_withdrawals_event on bkt_private.withdrawals(event_id,requested_at);
alter table bkt_private.withdrawals enable row level security;
revoke all on bkt_private.withdrawals from public,anon,authenticated;
-- Signed document records are historical and must survive entry removal.
-- The signing RPC verifies the live entry before inserting a signature.
alter table bkt_private.signatures drop constraint signatures_entry_id_event_id_player_id_fkey;

-- Keep an unlisted event readable to a player who just left its roster.
create or replace function bkt_private.can_read(p_event uuid) returns boolean
language sql stable security definer set search_path=pg_catalog as $$
 select exists(select 1 from public.bkt_events e where e.id=p_event and (
   (e.visibility='public' and e.status<>'draft') or bkt_private.is_staff(e.org_id)
   or (e.status<>'draft' and (
     exists(select 1 from public.bkt_entries en where en.event_id=e.id and en.player_id=bkt_private.me())
     or exists(select 1 from bkt_private.readers r where r.event_id=e.id
               and r.player_id=bkt_private.me() and r.expires_at>now())
     or exists(select 1 from bkt_private.withdrawals w where w.event_id=e.id
               and w.player_id=bkt_private.me())
   ))))
$$;

create function public.bkt_withdraw_entry(p_id uuid,p_event_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_me uuid:=bkt_private.require_me(); v_event public.bkt_events%rowtype;
 v_entry public.bkt_entries%rowtype; v_existing bkt_private.withdrawals%rowtype;
 v_status text; v_bracket_type text; v_losses integer;
begin
 if p_id is null or p_event_id is null then raise exception 'invalid_withdrawal' using errcode='22023'; end if;
 select * into v_event from public.bkt_events where id=p_event_id for update;
 if not found then raise exception 'event_unavailable' using errcode='42501'; end if;
 select * into v_existing from bkt_private.withdrawals where id=p_id;
 if found then
   if v_existing.event_id<>p_event_id or v_existing.player_id<>v_me then
     raise exception 'withdrawal_id_conflict' using errcode='23505'; end if;
   return to_jsonb(v_existing);
 end if;
 select * into v_entry from public.bkt_entries where event_id=p_event_id and player_id=v_me for update;
 if not found then raise exception 'entry_required' using errcode='42501'; end if;
 if v_event.status in ('draft','complete') then raise exception 'event_closed' using errcode='55000'; end if;
 if exists(select 1 from bkt_private.withdrawals where event_id=p_event_id and player_id=v_me and status='pending') then
   select * into v_existing from bkt_private.withdrawals where event_id=p_event_id and player_id=v_me and status='pending';
   return to_jsonb(v_existing);
 end if;
 if exists(select 1 from public.bkt_brackets where event_id=p_event_id) then
   if v_event.status<>'running' then raise exception 'event_closed' using errcode='55000'; end if;
   if v_entry.waitlisted or not exists(
     select 1 from public.bkt_brackets b,
       jsonb_array_elements(b.matches) m(value), jsonb_array_elements(m.value->'slots') s(value)
     where b.event_id=p_event_id and s.value->>'entrantId'=v_entry.id::text
       and not (m.value ? 'state') and not coalesce((m.value->>'cancelled')::boolean,false)
   ) then raise exception 'no_open_bracket_path' using errcode='55000'; end if;
   select type into v_bracket_type from public.bkt_brackets where event_id=p_event_id;
   select count(*) into v_losses from public.bkt_results where event_id=p_event_id
     and loser_player_id=v_me and not superseded;
   if v_losses >= case when v_bracket_type='double' then 2 else 1 end then
     raise exception 'already_eliminated' using errcode='55000'; end if;
   v_status:='pending';
 else
   if v_event.status not in ('registration','checkin') then raise exception 'event_closed' using errcode='55000'; end if;
   v_status:='withdrawn';
 end if;
 insert into bkt_private.withdrawals(id,event_id,entry_id,player_id,status)
 values(p_id,p_event_id,v_entry.id,v_me,v_status) returning * into v_existing;
 if v_status='withdrawn' then
   delete from bkt_private.contacts where event_id=p_event_id and player_id=v_me;
   delete from public.bkt_entries where id=v_entry.id;
   update public.bkt_events set revision=revision+1 where id=p_event_id;
 end if;
 return to_jsonb(v_existing);
end $$;

-- The existing staff DQ save creates the result. Resolve only after that
-- transaction has recorded a DQ against the requesting player.
create function bkt_private.resolve_withdrawal_dq() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
 if tg_op='DELETE' then
   update bkt_private.withdrawals set status='pending',resolved_at=null,resolved_match_id=null
   where event_id=old.event_id and player_id=old.loser_player_id and status='resolved'
     and resolved_match_id=old.match_id and old.by_dq;
   return old;
 end if;
 if tg_op='UPDATE' and old.by_dq and not old.superseded and new.superseded then
   update bkt_private.withdrawals set status='pending',resolved_at=null,resolved_match_id=null
   where event_id=old.event_id and player_id=old.loser_player_id and status='resolved'
     and resolved_match_id=old.match_id;
 end if;
 if not new.superseded and (
   select count(*) from public.bkt_results r where r.event_id=new.event_id
     and r.loser_player_id=new.loser_player_id and not r.superseded
 ) >= (select case when b.type='double' then 2 else 1 end
       from public.bkt_brackets b where b.event_id=new.event_id) then
   update bkt_private.withdrawals w set status='resolved',resolved_at=now(),
     resolved_match_id=(select r.match_id from public.bkt_results r where r.event_id=w.event_id
       and r.loser_player_id=w.player_id and r.by_dq and not r.superseded
       and r.reported_at>=w.requested_at order by r.reported_at desc limit 1)
   where w.event_id=new.event_id and w.player_id=new.loser_player_id and w.status='pending'
     and exists(select 1 from public.bkt_results r where r.event_id=w.event_id
       and r.loser_player_id=w.player_id and r.by_dq and not r.superseded
       and r.reported_at>=w.requested_at);
 end if;
 return new;
end $$;
create trigger bkt_resolve_withdrawal_dq after insert or update or delete on public.bkt_results
 for each row execute function bkt_private.resolve_withdrawal_dq();

create or replace function public.bkt_read_event(p_event_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 if not bkt_private.can_read(p_event_id) then raise exception 'event_unavailable' using errcode='42501'; end if;
 return jsonb_build_object(
 'event',(select bkt_private.admin_scrub_row('event',e.id,to_jsonb(e)) from public.bkt_events e where e.id=p_event_id),
 'entries',(select coalesce(jsonb_agg(bkt_private.admin_scrub_row('entry',en.id,to_jsonb(en)) order by en.registered_at,en.id),'[]') from public.bkt_entries en where en.event_id=p_event_id),
 'players',(select coalesce(jsonb_agg(bkt_private.admin_scrub_row('player',p.id,to_jsonb(p)) order by p.id),'[]') from public.bkt_players p where exists(select 1 from public.bkt_entries en where en.event_id=p_event_id and en.player_id=p.id) or exists(select 1 from public.bkt_orgs o join public.bkt_events e on e.org_id=o.id where e.id=p_event_id and o.owner_id=p.id)),
 'stations',(select coalesce(jsonb_agg(bkt_private.admin_scrub_row('station',s.id,to_jsonb(s)) order by s.number),'[]') from public.bkt_stations s where s.event_id=p_event_id),
 'orgs',(select coalesce(jsonb_agg(bkt_private.admin_scrub_row('org',o.id,to_jsonb(o))),'[]') from public.bkt_orgs o join public.bkt_events e on e.org_id=o.id where e.id=p_event_id),
 'brackets',(select coalesce(jsonb_agg(to_jsonb(b)),'[]') from public.bkt_brackets b where b.event_id=p_event_id and not bkt_private.content_is_held('bracket',b.event_id)),
 'results',(select coalesce(jsonb_agg(to_jsonb(r) order by r.reported_at,r.id),'[]') from public.bkt_results r where r.event_id=p_event_id and not r.superseded and r.moderation_state not in ('hidden','quarantined')),
 'match_submissions',(select coalesce(jsonb_agg(to_jsonb(s) order by s.submitted_at,s.id),'[]') from bkt_private.match_submissions s where s.event_id=p_event_id and (s.player_id=bkt_private.me() or bkt_private.is_staff((select org_id from public.bkt_events where id=p_event_id)))),
 'withdrawals',(select coalesce(jsonb_agg(to_jsonb(w) order by w.requested_at,w.id),'[]') from bkt_private.withdrawals w where w.event_id=p_event_id and (w.player_id=bkt_private.me() or bkt_private.is_staff((select org_id from public.bkt_events where id=p_event_id)))),
 'revision',(select revision from public.bkt_events where id=p_event_id));
end $$;

revoke all on function public.bkt_withdraw_entry(uuid,uuid) from public,anon,authenticated;
grant execute on function public.bkt_withdraw_entry(uuid,uuid) to authenticated;
commit;
