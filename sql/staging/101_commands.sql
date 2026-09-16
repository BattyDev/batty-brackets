begin;
do $$ begin
 if current_setting('bkt.staging',true) is distinct from 'on' then
   raise exception 'Staging session required';
 end if;
end $$;

create function public.bkt_identity(p_tag text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_player uuid; v_tag text;
begin
 if auth.uid() is null then raise exception 'authentication_required' using errcode='42501'; end if;
 -- Serialize first-use identity resolution without touching auth metadata or
 -- constructing a public tag from an email address/legal name.
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,10));
 v_player := bkt_private.me();
 if v_player is null then
   v_tag := case when p_tag is null then 'Player' else trim(p_tag) end;
   if length(v_tag) not between 1 and 64 or octet_length(v_tag)>256 then
     raise exception 'invalid_tag' using errcode='22023';
   end if;
   insert into public.bkt_players(tag) values(v_tag) returning id into v_player;
   insert into bkt_private.identities values(auth.uid(),v_player);
 end if;
 return (select to_jsonb(p) from public.bkt_players p where p.id=v_player);
end $$;

create function bkt_private.require_me() returns uuid
language plpgsql security definer set search_path=pg_catalog as $$
declare v_id uuid;
begin
 v_id := bkt_private.me();
 if v_id is null then raise exception 'resolve_identity_first' using errcode='42501'; end if;
 return v_id;
end $$;

create function bkt_private.new_token() returns text
language sql volatile set search_path=pg_catalog as $$
 select replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','')
$$;

create function public.bkt_create_event(p_event_id uuid,p_event jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare
 v_me uuid := bkt_private.require_me(); v_org uuid; v_code text;
 v_stations jsonb; v_item jsonb; v_key text; v_n integer := 0;
 v_existing bkt_private.create_requests%rowtype;
begin
 if p_event_id is null or jsonb_typeof(p_event) is distinct from 'object'
    or octet_length(p_event::text)>65536 then
   raise exception 'invalid_event' using errcode='22023';
 end if;
 for v_key in select jsonb_object_keys(p_event) loop
   if not (v_key=any(array['org_name','name','game_id','capacity','format','venue_type',
    'venue','platforms','starts_at','entry_fee','currency','preset_id','overrides',
    'documents','visibility','stations'])) then
     raise exception 'unknown_event_field: %',v_key using errcode='22023';
   end if;
 end loop;
 -- This key also handles response loss. A conflicting payload is not a retry.
 perform pg_advisory_xact_lock(hashtextextended(p_event_id::text,11));
 select * into v_existing from bkt_private.create_requests where event_id=p_event_id;
 if found then
   if v_existing.actor<>v_me or v_existing.payload<>p_event then
     raise exception 'idempotency_conflict' using errcode='40001';
   end if;
   v_org := (select org_id from public.bkt_events where id=p_event_id);
   v_code := v_existing.invite_code;
 else
   foreach v_key in array array['org_name','name','game_id'] loop
     if jsonb_typeof(p_event->v_key) is distinct from 'string' then
       raise exception 'required_text: %',v_key using errcode='22023';
     end if;
   end loop;
   foreach v_key in array array['format','venue_type','currency','visibility'] loop
     if p_event ? v_key and jsonb_typeof(p_event->v_key)<>'string' then
       raise exception 'invalid_text: %',v_key using errcode='22023';
     end if;
   end loop;
   foreach v_key in array array['venue','starts_at','preset_id'] loop
     if p_event ? v_key and jsonb_typeof(p_event->v_key) not in ('string','null') then
       raise exception 'invalid_optional_text: %',v_key using errcode='22023';
     end if;
   end loop;
   if jsonb_typeof(p_event->'capacity') is distinct from 'number'
      or (p_event->>'capacity') !~ '^[0-9]+$'
      or (p_event ? 'entry_fee' and (jsonb_typeof(p_event->'entry_fee')<>'number'
                                  or (p_event->>'entry_fee')::numeric<>0)) then
     raise exception 'invalid_capacity_or_fee' using errcode='22023';
   end if;
   if jsonb_typeof(coalesce(p_event->'platforms','[]'))<>'array'
      or jsonb_typeof(coalesce(p_event->'overrides','{}'))<>'object'
      or jsonb_typeof(coalesce(p_event->'documents','[]'))<>'array' then
     raise exception 'invalid_collections' using errcode='22023';
   end if;
   for v_item in select value from jsonb_array_elements(coalesce(p_event->'platforms','[]')) loop
     if jsonb_typeof(v_item)<>'string' or length(v_item#>>'{}') not between 1 and 64 then
       raise exception 'invalid_platform' using errcode='22023';
     end if;
   end loop;
   -- Document bodies are public rules, never signed names. Collection/signature
   -- APIs remain disabled until document-version validation has its own tests.
   for v_item in select value from jsonb_array_elements(coalesce(p_event->'documents','[]')) loop
     if jsonb_typeof(v_item)<>'object'
        or jsonb_typeof(v_item->'id') is distinct from 'string'
        or length(trim(v_item->>'id')) not between 1 and 120
        or (v_item->>'id')<>trim(v_item->>'id')
        or jsonb_typeof(v_item->'version') is distinct from 'number'
        or (v_item->>'version') !~ '^[1-9][0-9]*$' then
       raise exception 'invalid_document' using errcode='22023';
     end if;
     for v_key in select jsonb_object_keys(v_item) loop
       if not(v_key=any(array['id','title','body','text','type','version','required'])) then
         raise exception 'unknown_document_field' using errcode='22023';
       end if;
       if v_key in ('id','title','body','text','type') and jsonb_typeof(v_item->v_key)<>'string'
          or v_key='required' and jsonb_typeof(v_item->v_key)<>'boolean'
          or v_key='version' and (jsonb_typeof(v_item->v_key)<>'number' or (v_item->>v_key)!~'^[1-9][0-9]*$') then
         raise exception 'invalid_document_field' using errcode='22023';
       end if;
     end loop;
   end loop;
   if exists(select 1 from jsonb_array_elements(coalesce(p_event->'documents','[]')) d
             group by d->>'id',d->>'version' having count(*)>1) then
     raise exception 'duplicate_document_version' using errcode='22023';
   end if;
   v_stations := coalesce(p_event->'stations','[{"label":"Station 1","platform":null}]');
   if jsonb_typeof(v_stations)<>'array' then raise exception 'invalid_stations' using errcode='22023'; end if;
   if jsonb_array_length(v_stations) not between 1 and 64 then
     raise exception 'invalid_station_count' using errcode='22023';
   end if;
   insert into public.bkt_orgs(name,owner_id) values(trim(p_event->>'org_name'),v_me) returning id into v_org;
   insert into bkt_private.staff values(v_org,v_me,'owner');
   insert into public.bkt_events(id,org_id,name,game_id,capacity,format,venue_type,venue,
      platforms,starts_at,entry_fee,currency,preset_id,overrides,documents,visibility)
   values(p_event_id,v_org,trim(p_event->>'name'),trim(p_event->>'game_id'),(p_event->>'capacity')::integer,
      coalesce(p_event->>'format','double'),coalesce(p_event->>'venue_type','offline'),p_event->>'venue',
      array(select jsonb_array_elements_text(coalesce(p_event->'platforms','[]'))),
      (p_event->>'starts_at')::timestamptz,0,coalesce(p_event->>'currency','USD'),p_event->>'preset_id',
      coalesce(p_event->'overrides','{}'),coalesce(p_event->'documents','[]'),coalesce(p_event->>'visibility','public'));
   for v_item in select value from jsonb_array_elements(v_stations) loop
     if jsonb_typeof(v_item)<>'object' or jsonb_typeof(v_item->'label') is distinct from 'string'
        or length(trim(v_item->>'label')) not between 1 and 120
        or (v_item ? 'platform' and jsonb_typeof(v_item->'platform') not in ('string','null'))
        or length(v_item->>'platform')>64 then
       raise exception 'invalid_station' using errcode='22023';
     end if;
     if exists(select 1 from jsonb_object_keys(v_item) k where k not in ('label','platform')) then
       raise exception 'unknown_station_field' using errcode='22023';
     end if;
     v_n:=v_n+1;
     insert into public.bkt_stations(event_id,number,label,platform)
       values(p_event_id,v_n,trim(v_item->>'label'),v_item->>'platform');
   end loop;
   v_code:=bkt_private.new_token();
   insert into bkt_private.invites values(sha256(convert_to(v_code,'UTF8')),p_event_id,now()+interval '30 days');
   insert into bkt_private.create_requests values(p_event_id,v_me,p_event,v_code);
 end if;
 return jsonb_build_object('event',(select to_jsonb(e) from public.bkt_events e where e.id=p_event_id),
   'org',(select to_jsonb(o) from public.bkt_orgs o where o.id=v_org),
   'stations',(select coalesce(jsonb_agg(to_jsonb(s) order by s.number),'[]') from public.bkt_stations s where s.event_id=p_event_id),
   'invite_code',v_code);
end $$;

create function public.bkt_join_event(p_event_id uuid,p_contact text default null,p_share_contact boolean default false)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_me uuid:=bkt_private.require_me(); v_event public.bkt_events%rowtype;
 v_entry public.bkt_entries%rowtype; v_count integer;
begin
 if not bkt_private.can_read(p_event_id) then raise exception 'event_unavailable' using errcode='42501'; end if;
 select * into v_event from public.bkt_events where id=p_event_id for update;
 select * into v_entry from public.bkt_entries where event_id=p_event_id and player_id=v_me;
 if found then return to_jsonb(v_entry); end if;
 if v_event.status not in ('registration','checkin') then raise exception 'registration_closed' using errcode='55000'; end if;
 if (select count(*) from public.bkt_entries where event_id=p_event_id)>=512 then
   raise exception 'roster_limit' using errcode='54000';
 end if;
 select count(*) into v_count from public.bkt_entries where event_id=p_event_id and not waitlisted;
 insert into public.bkt_entries(event_id,player_id,waitlisted)
   values(p_event_id,v_me,v_count>=v_event.capacity) returning * into v_entry;
 if p_share_contact is true then
   if p_contact is null or length(trim(p_contact)) not between 1 and 320
      or octet_length(trim(p_contact))>1280 then
     raise exception 'invalid_contact' using errcode='22023';
   end if;
   insert into bkt_private.contacts(event_id,player_id,contact) values(p_event_id,v_me,trim(p_contact));
 elsif p_contact is not null then
   raise exception 'contact_requires_consent' using errcode='22023';
 end if;
 update public.bkt_events set revision=revision+1 where id=p_event_id;
 return to_jsonb(v_entry);
end $$;

create function public.bkt_set_contact(p_event_id uuid,p_contact text default null,p_share_contact boolean default false)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_me uuid:=bkt_private.require_me();
begin
 if not exists(select 1 from public.bkt_entries where event_id=p_event_id and player_id=v_me) then
   raise exception 'entry_required' using errcode='42501';
 end if;
 if p_share_contact is true then
   if p_contact is null or length(trim(p_contact)) not between 1 and 320
      or octet_length(trim(p_contact))>1280 then
     raise exception 'invalid_contact' using errcode='22023';
   end if;
   insert into bkt_private.contacts(event_id,player_id,contact) values(p_event_id,v_me,trim(p_contact))
   on conflict(event_id,player_id) do update set contact=excluded.contact,consent_at=now();
 else
   if p_contact is not null then raise exception 'contact_requires_consent' using errcode='22023'; end if;
   delete from bkt_private.contacts where event_id=p_event_id and player_id=v_me;
 end if;
 return jsonb_build_object('shared',p_share_contact is true);
end $$;

create function public.bkt_read_contacts(p_event_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_me uuid:=bkt_private.require_me();
begin
 if not bkt_private.can_read(p_event_id) then raise exception 'event_unavailable' using errcode='42501'; end if;
 return (select coalesce(jsonb_agg(to_jsonb(c)),'[]') from bkt_private.contacts c
   where c.event_id=p_event_id and (c.player_id=v_me or
     bkt_private.is_staff((select org_id from public.bkt_events where id=p_event_id))));
end $$;

-- Attempts return structured failures, not exceptions: throwing would roll back
-- the throttle increment. This is a per-account limit, not an edge/IP defense.
create function bkt_private.attempt(p_kind text) returns boolean
language plpgsql security definer set search_path=pg_catalog as $$
declare v_n integer; v_me uuid:=bkt_private.require_me();
begin
 insert into bkt_private.attempts values(v_me,p_kind,now(),1)
 on conflict(player_id,kind) do update set
   attempts=case when bkt_private.attempts.window_start<now()-interval '1 minute' then 1 else bkt_private.attempts.attempts+1 end,
   window_start=case when bkt_private.attempts.window_start<now()-interval '1 minute' then now() else bkt_private.attempts.window_start end
 returning attempts into v_n;
 return v_n<=10;
end $$;

create function public.bkt_event_by_code(p_code text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_me uuid:=bkt_private.require_me(); v_event uuid; v_exp timestamptz;
begin
 if not bkt_private.attempt('invite') then return jsonb_build_object('error','rate_limited'); end if;
 if p_code is null or p_code !~ '^[0-9a-fA-F]{64}$' then return jsonb_build_object('error','invalid_code'); end if;
 select i.event_id,least(i.expires_at,now()+interval '24 hours') into v_event,v_exp
 from bkt_private.invites i join public.bkt_events e on e.id=i.event_id
 where i.token_hash=sha256(convert_to(lower(p_code),'UTF8')) and i.expires_at>now() and e.status<>'draft';
 if not found then return jsonb_build_object('error','invalid_code'); end if;
 insert into bkt_private.readers values(v_event,v_me,v_exp)
 on conflict(event_id,player_id) do update set expires_at=excluded.expires_at;
 return jsonb_build_object('event',(select to_jsonb(e) from public.bkt_events e where e.id=v_event),
   'access',jsonb_build_object('event_id',v_event,'expires_at',v_exp));
end $$;

create function public.bkt_read_event(p_event_id uuid) returns jsonb
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
 'results',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]') from public.bkt_results r where r.event_id=p_event_id),
 'revision',(select revision from public.bkt_events where id=p_event_id));
end $$;

create function public.bkt_list_events() returns jsonb
language sql stable security definer set search_path=pg_catalog as $$
 with visible as (select e.* from public.bkt_events e where bkt_private.can_read(e.id)
   order by e.created_at desc,e.id limit 100),
 orgs as (select distinct o.* from public.bkt_orgs o join visible e on e.org_id=o.id)
 select jsonb_build_object(
  'events',(select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at desc,e.id),'[]') from visible e),
  'orgs',(select coalesce(jsonb_agg(to_jsonb(o)),'[]') from orgs o),
  'players',(select coalesce(jsonb_agg(to_jsonb(p)),'[]') from public.bkt_players p where
    p.id=bkt_private.me() or exists(select 1 from orgs o where o.owner_id=p.id)))
$$;

-- RPC allowlist, rather than relying on a project's possibly broad defaults.
revoke all on function public.bkt_identity(text), public.bkt_create_event(uuid,jsonb),
 public.bkt_join_event(uuid,text,boolean),public.bkt_set_contact(uuid,text,boolean),
 public.bkt_read_contacts(uuid),public.bkt_event_by_code(text),public.bkt_read_event(uuid),
 public.bkt_list_events() from public,anon,authenticated;
grant execute on function public.bkt_identity(text),public.bkt_create_event(uuid,jsonb),
 public.bkt_join_event(uuid,text,boolean),public.bkt_set_contact(uuid,text,boolean),
 public.bkt_read_contacts(uuid),public.bkt_event_by_code(text) to authenticated;
grant execute on function public.bkt_read_event(uuid),public.bkt_list_events() to anon,authenticated;
revoke all on function bkt_private.require_me(),bkt_private.new_token(),bkt_private.attempt(text)
 from public,anon,authenticated;
commit;
