begin;
do $$ begin
 if current_setting('bkt.staging',true) is distinct from 'on' then raise exception 'Staging session required'; end if;
end $$;

alter table public.bkt_events
  add column check_in_opens_at timestamptz,
  add column check_in_closes_at timestamptz,
  add column completed_at timestamptz,
  add column seeding_report jsonb;
alter table public.bkt_events drop constraint bkt_events_status_check;
alter table public.bkt_events add constraint bkt_events_status_check
  check (status in ('draft','registration','checkin','seeding','running','complete'));
alter table public.bkt_entries
  add column crew text check (crew is null or length(crew)<=120),
  add column source text check (source is null or length(source)<=32),
  add column signed_documents text[] not null default '{}';
alter table public.bkt_stations add column closed boolean not null default false;
alter table public.bkt_brackets
  add column type text not null default 'double' check (type in ('single','double')),
  add column size integer not null default 2 check (size between 2 and 512 and (size & (size-1))=0),
  add column rounds integer not null default 1 check (rounds between 1 and 32),
  add column losers_rounds integer check (losers_rounds between 1 and 64);
alter table public.bkt_results
  add column game_id text not null default 'unknown',
  add column round_name text,
  add column score_winner integer not null default 0 check (score_winner between 0 and 99),
  add column score_loser integer not null default 0 check (score_loser between 0 and 99),
  add column by_dq boolean not null default false,
  add column reported_at timestamptz not null default now(),
  add column reported_by uuid references public.bkt_players(id),
  add column superseded boolean not null default false,
  add column superseded_at timestamptz;
create unique index bkt_station_live_match on public.bkt_stations(event_id,match_id) where match_id is not null;
create unique index bkt_result_active_match on public.bkt_results(event_id,match_id) where not superseded;
create index bkt_entries_player on public.bkt_entries(player_id);
create index bkt_results_winner on public.bkt_results(winner_player_id);
create index bkt_results_loser on public.bkt_results(loser_player_id);

create or replace function public.bkt_read_event(p_event_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 if not bkt_private.can_read(p_event_id) then raise exception 'event_unavailable' using errcode='42501'; end if;
 return jsonb_build_object(
 'event',(select to_jsonb(e) from public.bkt_events e where e.id=p_event_id),
 'entries',(select coalesce(jsonb_agg(to_jsonb(en) order by en.registered_at,en.id),'[]') from public.bkt_entries en where en.event_id=p_event_id),
 'players',(select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]') from public.bkt_players p where
   exists(select 1 from public.bkt_entries en where en.event_id=p_event_id and en.player_id=p.id)
   or exists(select 1 from public.bkt_orgs o join public.bkt_events e on e.org_id=o.id where e.id=p_event_id and o.owner_id=p.id)),
 'stations',(select coalesce(jsonb_agg(to_jsonb(s) order by s.number),'[]') from public.bkt_stations s where s.event_id=p_event_id),
 'orgs',(select coalesce(jsonb_agg(to_jsonb(o)),'[]') from public.bkt_orgs o join public.bkt_events e on e.org_id=o.id where e.id=p_event_id),
 'brackets',(select coalesce(jsonb_agg(to_jsonb(b)),'[]') from public.bkt_brackets b where b.event_id=p_event_id),
 'results',(select coalesce(jsonb_agg(to_jsonb(r) order by r.reported_at,r.id),'[]') from public.bkt_results r where r.event_id=p_event_id),
 'revision',(select revision from public.bkt_events where id=p_event_id));
end $$;

create function public.bkt_save_event_state(p_event_id uuid,p_expected_revision bigint,p_state jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare
 v_event public.bkt_events%rowtype; v_item jsonb; v_match jsonb; v_slot jsonb; v_key text;
 v_ids uuid[]:=array[]::uuid[]; v_player_ids uuid[]:=array[]::uuid[]; v_new_player_ids uuid[]:=array[]::uuid[]; v_station_ids uuid[]:=array[]::uuid[];
 v_result_ids uuid[]:=array[]::uuid[]; v_match_ids text[]:=array[]::text[];
 v_id uuid; v_player uuid; v_number integer; v_match_id text; v_bracket jsonb;
begin
 if auth.uid() is null then raise exception 'authentication_required' using errcode='42501'; end if;
 if p_event_id is null or p_expected_revision is null or jsonb_typeof(p_state) is distinct from 'object'
    or octet_length(p_state::text)>2097152 then raise exception 'invalid_state' using errcode='22023'; end if;
 if exists(select 1 from jsonb_object_keys(p_state) k where k not in ('event','entries','players','stations','bracket','results'))
    or jsonb_typeof(p_state->'event') is distinct from 'object'
    or jsonb_typeof(p_state->'entries') is distinct from 'array'
    or jsonb_typeof(p_state->'players') is distinct from 'array'
    or jsonb_typeof(p_state->'stations') is distinct from 'array'
    or jsonb_typeof(p_state->'results') is distinct from 'array'
    or jsonb_typeof(p_state->'bracket') not in ('object','null') then
   raise exception 'invalid_state_shape' using errcode='22023';
 end if;
 select * into v_event from public.bkt_events where id=p_event_id for update;
 if not found or not bkt_private.is_staff(v_event.org_id) then raise exception 'staff_required' using errcode='42501'; end if;
 if v_event.revision<>p_expected_revision then raise exception 'stale_revision' using errcode='40001'; end if;
 if p_state->'event'->>'id'<>p_event_id::text then raise exception 'event_mismatch' using errcode='22023'; end if;
 if jsonb_array_length(p_state->'entries')>512 or jsonb_array_length(p_state->'players')>512
    or jsonb_array_length(p_state->'stations')>64 or jsonb_array_length(p_state->'results')>4096 then
   raise exception 'state_limit' using errcode='54000';
 end if;

 -- Event values are constrained again by table checks. Identity, org and revision
 -- are never taken from the client document.
 update public.bkt_events set
   name=coalesce(nullif(trim(p_state->'event'->>'name'),''),name),
   format=coalesce(p_state->'event'->>'format',format),
   venue_type=coalesce(p_state->'event'->>'venueType',venue_type),
   venue=case when p_state->'event' ? 'venue' then p_state->'event'->>'venue' else venue end,
   platforms=case when p_state->'event' ? 'platforms' then array(select jsonb_array_elements_text(p_state->'event'->'platforms')) else platforms end,
   starts_at=case when p_state->'event' ? 'startsAt' and jsonb_typeof(p_state->'event'->'startsAt')<>'null' then (p_state->'event'->>'startsAt')::timestamptz else null end,
   capacity=coalesce((p_state->'event'->>'capacity')::integer,capacity),
   preset_id=case when p_state->'event' ? 'presetId' then p_state->'event'->>'presetId' else preset_id end,
   overrides=coalesce(p_state->'event'->'overrides',overrides),
   documents=coalesce(p_state->'event'->'documents',documents),
   visibility=coalesce(p_state->'event'->>'visibility',visibility),
   status=coalesce(p_state->'event'->>'status',status),
   check_in_opens_at=case when p_state->'event' ? 'checkInOpensAt' and jsonb_typeof(p_state->'event'->'checkInOpensAt')<>'null' then (p_state->'event'->>'checkInOpensAt')::timestamptz else null end,
   check_in_closes_at=case when p_state->'event' ? 'checkInClosesAt' and jsonb_typeof(p_state->'event'->'checkInClosesAt')<>'null' then (p_state->'event'->>'checkInClosesAt')::timestamptz else null end,
   completed_at=case when p_state->'event' ? 'completedAt' and jsonb_typeof(p_state->'event'->'completedAt')<>'null' then (p_state->'event'->>'completedAt')::timestamptz else null end,
   seeding_report=case when p_state->'event' ? 'seedingReport' then p_state->'event'->'seedingReport' else seeding_report end
 where id=p_event_id;

 -- Players in the payload must belong to the submitted roster. Existing linked
 -- account tags cannot be rewritten by an organizer; unclaimed walk-ups can.
 for v_item in select value from jsonb_array_elements(p_state->'players') loop
   if jsonb_typeof(v_item)<>'object' or (v_item->>'id')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or jsonb_typeof(v_item->'tag') is distinct from 'string' or length(trim(v_item->>'tag')) not between 1 and 64 then
     raise exception 'invalid_player' using errcode='22023'; end if;
   v_player:=(v_item->>'id')::uuid;
   if v_player=any(v_player_ids) then raise exception 'duplicate_player' using errcode='22023'; end if;
   v_player_ids:=array_append(v_player_ids,v_player);
   if exists(select 1 from public.bkt_players where id=v_player) then
     if exists(select 1 from bkt_private.identities where player_id=v_player)
        and (select tag from public.bkt_players where id=v_player)<>trim(v_item->>'tag') then
       raise exception 'linked_player_tag' using errcode='42501'; end if;
     update public.bkt_players set tag=trim(v_item->>'tag') where id=v_player
       and not exists(select 1 from bkt_private.identities where player_id=v_player);
   else
     insert into public.bkt_players(id,tag) values(v_player,trim(v_item->>'tag'));
     v_new_player_ids:=array_append(v_new_player_ids,v_player);
   end if;
 end loop;

 for v_item in select value from jsonb_array_elements(p_state->'entries') loop
   if jsonb_typeof(v_item)<>'object' or (v_item->>'id')!~*'^[0-9a-f-]{36}$' or (v_item->>'playerId')!~*'^[0-9a-f-]{36}$'
      or v_item->>'eventId'<>p_event_id::text then raise exception 'invalid_entry' using errcode='22023'; end if;
   v_id:=(v_item->>'id')::uuid; v_player:=(v_item->>'playerId')::uuid;
   if v_id=any(v_ids) or not(v_player=any(v_player_ids)) then raise exception 'duplicate_or_unknown_entry' using errcode='22023'; end if;
   if exists(select 1 from public.bkt_players p where p.id=v_player)
      and not exists(select 1 from public.bkt_entries e where e.event_id=p_event_id and e.player_id=v_player)
      and not(v_player=any(v_new_player_ids)) then
     raise exception 'foreign_player' using errcode='42501';
   end if;
   v_ids:=array_append(v_ids,v_id);
   if exists(select 1 from public.bkt_entries e where (e.id=v_id and (e.event_id<>p_event_id or e.player_id<>v_player))
      or (e.event_id=p_event_id and e.player_id=v_player and e.id<>v_id)) then
     raise exception 'entry_identity_conflict' using errcode='42501'; end if;
   insert into public.bkt_entries(id,event_id,player_id,seed,waitlisted,checked_in_at,registered_at,crew,source,signed_documents)
   values(v_id,p_event_id,v_player,(v_item->>'seed')::integer,coalesce((v_item->>'waitlisted')::boolean,false),
     (v_item->>'checkedInAt')::timestamptz,coalesce((v_item->>'registeredAt')::timestamptz,now()),nullif(v_item->>'group',''),
     nullif(v_item->>'source',''),
     coalesce(array(select jsonb_array_elements_text(coalesce(v_item->'signedDocuments','[]'))),'{}'))
   on conflict(id) do update set seed=excluded.seed,waitlisted=excluded.waitlisted,checked_in_at=excluded.checked_in_at,
     crew=excluded.crew,source=excluded.source,signed_documents=excluded.signed_documents
   where bkt_entries.event_id=p_event_id and bkt_entries.player_id=excluded.player_id;
 end loop;
 delete from bkt_private.contacts where event_id=p_event_id and not(player_id=any(v_player_ids));
 delete from public.bkt_entries where event_id=p_event_id and not(id=any(v_ids));

 for v_item in select value from jsonb_array_elements(p_state->'stations') loop
   if jsonb_typeof(v_item)<>'object' or (v_item->>'id')!~*'^[0-9a-f-]{36}$' or v_item->>'eventId'<>p_event_id::text
      or jsonb_typeof(v_item->'label') is distinct from 'string' then raise exception 'invalid_station' using errcode='22023'; end if;
   v_id:=(v_item->>'id')::uuid; v_number:=(v_item->>'number')::integer; v_match_id:=nullif(v_item->>'matchId','');
   if v_id=any(v_station_ids) or v_number not between 1 and 64 then raise exception 'duplicate_or_invalid_station' using errcode='22023'; end if;
   v_station_ids:=array_append(v_station_ids,v_id);
   if exists(select 1 from public.bkt_stations s where s.id=v_id and s.event_id<>p_event_id) then
     raise exception 'station_identity_conflict' using errcode='42501'; end if;
   insert into public.bkt_stations(id,event_id,number,label,platform,match_id,closed)
   values(v_id,p_event_id,v_number,trim(v_item->>'label'),v_item->>'platform',v_match_id,coalesce((v_item->>'closed')::boolean,false))
   on conflict(id) do update set number=excluded.number,label=excluded.label,platform=excluded.platform,match_id=excluded.match_id,closed=excluded.closed
   where bkt_stations.event_id=p_event_id;
 end loop;
 delete from public.bkt_stations where event_id=p_event_id and not(id=any(v_station_ids));

 v_bracket:=p_state->'bracket';
 if jsonb_typeof(v_bracket)='null' then delete from public.bkt_brackets where event_id=p_event_id;
 else
   if v_bracket->>'eventId'<>p_event_id::text or jsonb_typeof(v_bracket->'matches') is distinct from 'array'
      or jsonb_array_length(v_bracket->'matches')>2048 then raise exception 'invalid_bracket' using errcode='22023'; end if;
   for v_match in select value from jsonb_array_elements(v_bracket->'matches') loop
     if jsonb_typeof(v_match)<>'object' or jsonb_typeof(v_match->'id') is distinct from 'string'
        or length(v_match->>'id') not between 1 and 120 or jsonb_typeof(v_match->'slots') is distinct from 'array'
        or jsonb_array_length(v_match->'slots')>2 then raise exception 'invalid_match' using errcode='22023'; end if;
     v_match_id:=v_match->>'id';
     if v_match_id=any(v_match_ids) then raise exception 'duplicate_match' using errcode='22023'; end if;
     v_match_ids:=array_append(v_match_ids,v_match_id);
     for v_slot in select value from jsonb_array_elements(v_match->'slots') loop
       if v_slot ? 'entrantId' and jsonb_typeof(v_slot->'entrantId')<>'null'
          and not((v_slot->>'entrantId')::uuid=any(v_ids)) then raise exception 'unknown_match_entry' using errcode='22023'; end if;
     end loop;
   end loop;
   if exists(select 1 from public.bkt_stations s where s.event_id=p_event_id and s.match_id is not null and not(s.match_id=any(v_match_ids))) then
     raise exception 'unknown_station_match' using errcode='22023'; end if;
   insert into public.bkt_brackets(event_id,revision,matches,type,size,rounds,losers_rounds)
   values(p_event_id,coalesce((v_bracket->>'revision')::bigint,1),v_bracket->'matches',v_bracket->>'type',
     (v_bracket->>'size')::integer,(v_bracket->>'rounds')::integer,(v_bracket->>'losersRounds')::integer)
   on conflict(event_id) do update set revision=bkt_brackets.revision+1,matches=excluded.matches,type=excluded.type,
     size=excluded.size,rounds=excluded.rounds,losers_rounds=excluded.losers_rounds;
 end if;

 update public.bkt_results set superseded=true,superseded_at=coalesce(superseded_at,now()) where event_id=p_event_id;
 for v_item in select value from jsonb_array_elements(p_state->'results') loop
   if jsonb_typeof(v_item)<>'object' or (v_item->>'id')!~*'^[0-9a-f-]{36}$' or v_item->>'eventId'<>p_event_id::text
      or jsonb_typeof(v_item->'matchId') is distinct from 'string' then raise exception 'invalid_result' using errcode='22023'; end if;
   v_id:=(v_item->>'id')::uuid;
   if v_id=any(v_result_ids) or not((v_item->>'winnerPlayerId')::uuid=any(v_player_ids))
      or not((v_item->>'loserPlayerId')::uuid=any(v_player_ids)) or v_item->>'winnerPlayerId'=v_item->>'loserPlayerId'
      or (array_length(v_match_ids,1) is not null and not((v_item->>'matchId')=any(v_match_ids))) then
     raise exception 'invalid_result_reference' using errcode='22023'; end if;
   v_result_ids:=array_append(v_result_ids,v_id);
   if exists(select 1 from public.bkt_results r where r.id=v_id and
      (r.event_id<>p_event_id or r.match_id<>v_item->>'matchId'
       or r.winner_player_id<>(v_item->>'winnerPlayerId')::uuid or r.loser_player_id<>(v_item->>'loserPlayerId')::uuid)) then
     raise exception 'result_identity_conflict' using errcode='42501'; end if;
   insert into public.bkt_results(id,event_id,game_id,match_id,round_name,winner_player_id,loser_player_id,
     score_winner,score_loser,by_dq,reported_at,reported_by,superseded,superseded_at)
   values(v_id,p_event_id,coalesce(v_item->>'gameId',v_event.game_id),v_item->>'matchId',v_item->>'roundName',
     (v_item->>'winnerPlayerId')::uuid,(v_item->>'loserPlayerId')::uuid,(v_item->>'scoreWinner')::integer,
     (v_item->>'scoreLoser')::integer,coalesce((v_item->>'byDq')::boolean,false),
     coalesce((v_item->>'reportedAt')::timestamptz,now()),nullif(v_item->>'reportedBy','')::uuid,
     coalesce((v_item->>'superseded')::boolean,false),(v_item->>'supersededAt')::timestamptz)
   on conflict(id) do update set round_name=excluded.round_name,score_winner=excluded.score_winner,
     score_loser=excluded.score_loser,by_dq=excluded.by_dq,superseded=excluded.superseded,superseded_at=excluded.superseded_at
   where bkt_results.event_id=p_event_id and bkt_results.match_id=excluded.match_id
     and bkt_results.winner_player_id=excluded.winner_player_id and bkt_results.loser_player_id=excluded.loser_player_id;
 end loop;
 delete from public.bkt_results where event_id=p_event_id and not(id=any(v_result_ids));
 update public.bkt_events set revision=revision+1 where id=p_event_id;
 return public.bkt_read_event(p_event_id);
end $$;

revoke all on function public.bkt_save_event_state(uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.bkt_save_event_state(uuid,bigint,jsonb) to authenticated;
commit;
