begin;
do $$ begin
 if current_setting('bkt.staging',true) is distinct from 'on' then
   raise exception 'Staging session required';
 end if;
end $$;

/*
  Site administration is an account-level capability, not an organiser role.
  The account UUID is kept private so a public player row can never be used as
  proof that somebody may moderate the whole site.  Membership is deliberately
  mutable by a trusted migration/operator (or a future super-admin command),
  while every read and write command below checks the current row again.
*/
create table bkt_private.admin_members (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('moderator','analyst','super_admin')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

/* Reports are private user input.  The reporter identity is retained only for
   deduplication and rate limiting; report RPCs never return it. */
create table bkt_private.user_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_auth_user_id uuid references auth.users(id) on delete set null,
  target_kind text not null check (target_kind in ('player','org','event','entry','station','bracket','result')),
  target_id uuid not null,
  target_field text not null check (length(trim(target_field)) between 1 and 64),
  reason text not null check (length(trim(reason)) between 10 and 1200),
  submitted_at timestamptz not null default now(),
  status text not null default 'open' check (status in ('open','reviewing','resolved','dismissed')),
  triage_note text check (triage_note is null or length(triage_note)<=1000),
  reviewed_by uuid,
  reviewed_at timestamptz
);

/* One current moderation state per target field.  The first value is retained
   here so restore never depends on a client resubmitting the original content.
   There is intentionally no contact target: bkt_private.contacts never enters
   the queue, content feed, metrics, or audit payloads. */
create table bkt_private.moderation_queue (
  id uuid primary key default gen_random_uuid(),
  target_kind text not null check (target_kind in ('player','org','event','entry','station','bracket','result')),
  target_id uuid not null,
  target_field text not null check (length(trim(target_field)) between 1 and 64),
  state text not null default 'open'
    check (state in ('open','quarantined','hidden','replaced','restored')),
  original_value jsonb not null,
  replacement_value jsonb,
  replacement_result_id uuid references public.bkt_results(id),
  reason text not null check (length(trim(reason)) between 1 and 2000),
  source text not null default 'moderation' check (source in ('moderation','user_report')),
  locked boolean not null default false,
  /* Actor UUIDs intentionally outlive Auth accounts so the moderation record
     remains attributable after an administrator is deprovisioned. */
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  unique (target_kind,target_id,target_field)
);

/* Append-only by contract.  Client roles have no schema/table privileges and
   the trigger also catches an accidental UPDATE/DELETE from a future definer
   command.  Audits contain only whitelisted public content targets. */
create table bkt_private.admin_audit (
  id uuid primary key default gen_random_uuid(),
  admin_auth_user_id uuid not null,
  admin_role text not null check (admin_role in ('moderator','analyst','super_admin')),
  action text not null check (action in ('hide','quarantine','restore','replace','lock','review_report')),
  target_kind text not null check (target_kind in ('player','org','event','entry','station','bracket','result','report')),
  target_id uuid not null,
  target_field text not null,
  before_value jsonb,
  after_value jsonb,
  reason text not null check (length(trim(reason)) between 1 and 2000),
  report_id uuid references bkt_private.user_reports(id),
  created_at timestamptz not null default now()
);

alter table public.bkt_results
  add column moderation_state text not null default 'visible'
    check (moderation_state in ('visible','quarantined','hidden','replaced')),
  add column moderation_locked boolean not null default false;

create function bkt_private.admin_field_allowed(p_kind text,p_field text) returns boolean
language sql immutable set search_path=pg_catalog as $$
 select case p_kind
   when 'player' then p_field='tag'
   when 'org' then p_field='name'
   when 'event' then p_field=any(array[
     'name','game_id','format','venue_type','venue','platforms','starts_at','preset_id','overrides','documents','seeding_report'])
   when 'entry' then p_field='crew'
   when 'station' then p_field=any(array['label','platform','match_id'])
   when 'bracket' then p_field='record'
   when 'result' then p_field='record'
   else false
 end
$$;

/* A closed field map supplies both the public-content feed and the report and
   moderation RPCs.  Values are never selected from contacts or arbitrary
   caller-named relations. */
create function bkt_private.admin_snapshot(p_kind text,p_id uuid,p_field text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_table text; v_pk text; v_value jsonb; v_id uuid;
begin
 if p_id is null or not bkt_private.admin_field_allowed(p_kind,p_field) then
   raise exception 'invalid_moderation_field' using errcode='22023';
 end if;
 if p_kind='bracket' then
   select jsonb_build_object('matches',b.matches,'type',b.type,'size',b.size,'rounds',b.rounds,
     'losers_rounds',b.losers_rounds) into v_value
     from public.bkt_brackets b where b.event_id=p_id;
 elsif p_kind='result' then
   select coalesce(q.replacement_result_id,p_id) into v_id
     from (select 1) seed
     left join bkt_private.moderation_queue q on q.target_kind='result'
       and q.target_id=p_id and q.target_field='record';
   select to_jsonb(r) into v_value from public.bkt_results r where r.id=v_id;
 else
   v_table:=case p_kind when 'player' then 'bkt_players' when 'org' then 'bkt_orgs'
     when 'event' then 'bkt_events' when 'entry' then 'bkt_entries' when 'station' then 'bkt_stations' end;
   v_pk:=case p_kind when 'player' then 'id' when 'org' then 'id' when 'event' then 'id'
     when 'entry' then 'id' when 'station' then 'id' end;
   execute format('select coalesce(to_jsonb(t.%1$I),''null''::jsonb) from public.%2$I t where t.%3$I=$1',
     p_field,v_table,v_pk) into v_value using p_id;
 end if;
 return v_value;
end $$;

create function bkt_private.admin_scrub_value(p_kind text,p_id uuid,p_field text,p_value jsonb) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_state text; v_type text;
begin
 select q.state into v_state from bkt_private.moderation_queue q
  where q.target_kind=p_kind and q.target_id=p_id and q.target_field=p_field;
 if v_state is null or v_state not in ('hidden','quarantined') then return p_value; end if;
 if p_kind='event' and p_field='starts_at' then return 'null'::jsonb; end if;
 v_type:=jsonb_typeof(p_value);
 return case v_type
   when 'string' then to_jsonb(case v_state when 'hidden' then '[hidden]' else '[quarantined]' end)
   when 'array' then '[]'::jsonb
   when 'object' then '{}'::jsonb
   else 'null'::jsonb
 end;
end $$;

create function bkt_private.admin_scrub_row(p_kind text,p_id uuid,p_row jsonb) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_q record; v_value jsonb;
begin
 for v_q in select q.target_field,q.state from bkt_private.moderation_queue q
   where q.target_kind=p_kind and q.target_id=p_id and q.state in ('hidden','quarantined') loop
   v_value:=bkt_private.admin_scrub_value(p_kind,p_id,v_q.target_field,p_row->v_q.target_field);
   p_row:=jsonb_set(p_row,array[v_q.target_field],v_value,true);
 end loop;
 return p_row;
end $$;

/* A held row is omitted from direct table reads.  The reviewed read RPCs below
   can then return a field-level scrubbed bundle without exposing raw values. */
create function bkt_private.content_is_held(p_kind text,p_id uuid) returns boolean
language sql stable security definer set search_path=pg_catalog as $$
 select exists(select 1 from bkt_private.moderation_queue q where q.target_kind=p_kind
   and q.target_id=p_id and q.state in ('hidden','quarantined'))
$$;

revoke all on function bkt_private.content_is_held(text,uuid) from public,anon,authenticated;
grant execute on function bkt_private.content_is_held(text,uuid) to anon,authenticated;

drop policy read_event on public.bkt_events;
create policy read_event on public.bkt_events for select using (
  bkt_private.can_read(id) and not bkt_private.content_is_held('event',id)
);
drop policy read_entry on public.bkt_entries;
create policy read_entry on public.bkt_entries for select using (
  bkt_private.can_read(event_id) and not bkt_private.content_is_held('entry',id)
);
drop policy read_station on public.bkt_stations;
create policy read_station on public.bkt_stations for select using (
  bkt_private.can_read(event_id) and not bkt_private.content_is_held('station',id)
);
drop policy read_bracket on public.bkt_brackets;
create policy read_bracket on public.bkt_brackets for select using (
  bkt_private.can_read(event_id) and not bkt_private.content_is_held('bracket',event_id)
);
drop policy read_player on public.bkt_players;
create policy read_player on public.bkt_players for select using (
  not bkt_private.content_is_held('player',id) and
  (id=bkt_private.me() or exists(select 1 from public.bkt_entries e
    where e.player_id=bkt_players.id and bkt_private.can_read(e.event_id)))
);
drop policy read_org on public.bkt_orgs;
create policy read_org on public.bkt_orgs for select using (
  not bkt_private.content_is_held('org',id) and
  (bkt_private.is_staff(id) or exists(select 1 from public.bkt_events e
    where e.org_id=bkt_orgs.id and bkt_private.can_read(e.id)))
);

create function bkt_private.admin_write_value(p_kind text,p_id uuid,p_field text,p_value jsonb) returns void
language plpgsql security definer set search_path=pg_catalog as $$
declare v_table text; v_pk text; v_count integer;
begin
 if p_id is null or not bkt_private.admin_field_allowed(p_kind,p_field) or p_kind in ('result') then
   raise exception 'invalid_moderation_field' using errcode='22023';
 end if;
 if p_kind='bracket' then
   if jsonb_typeof(p_value) is distinct from 'object' then
     raise exception 'invalid_bracket_replacement' using errcode='22023';
   end if;
   update public.bkt_brackets b set
     matches=(p_value->'matches'),
     type=p_value->>'type',
     size=(p_value->>'size')::integer,
     rounds=(p_value->>'rounds')::integer,
     losers_rounds=case when p_value->'losers_rounds'='null'::jsonb then null else (p_value->>'losers_rounds')::integer end,
     revision=b.revision+1
    where b.event_id=p_id;
   get diagnostics v_count=row_count;
   if v_count=0 then raise exception 'moderation_target_not_found' using errcode='22023'; end if;
   return;
 end if;
 v_table:=case p_kind when 'player' then 'bkt_players' when 'org' then 'bkt_orgs'
   when 'event' then 'bkt_events' when 'entry' then 'bkt_entries' when 'station' then 'bkt_stations' end;
 v_pk:=case p_kind when 'player' then 'id' when 'org' then 'id' when 'event' then 'id'
   when 'entry' then 'id' when 'station' then 'id' end;
 execute format('update public.%1$I t set %2$I=r.%2$I from jsonb_populate_record(null::public.%1$I,$1) r where t.%3$I=$2',
   v_table,p_field,v_pk) using jsonb_build_object(p_field,p_value),p_id;
 get diagnostics v_count=row_count;
 if v_count=0 then raise exception 'moderation_target_not_found' using errcode='22023'; end if;
end $$;

create function bkt_private.admin_value_valid(p_kind text,p_id uuid,p_field text,p_value jsonb) returns boolean
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_item jsonb; v_slot jsonb; v_key text; v_ids text[]:=array[]::text[]; v_id text; v_count integer;
begin
 if not bkt_private.admin_field_allowed(p_kind,p_field) or p_value is null then return false; end if;
 if p_kind='player' then
   return jsonb_typeof(p_value)='string' and length(trim(p_value#>>'{}')) between 1 and 64;
 elsif p_kind='org' then
   return jsonb_typeof(p_value)='string' and length(trim(p_value#>>'{}')) between 1 and 120;
 elsif p_kind='entry' then
   return jsonb_typeof(p_value) in ('string','null') and (p_value='null'::jsonb or length(p_value#>>'{}')<=120);
 elsif p_kind='station' then
   if p_field='label' then return jsonb_typeof(p_value)='string' and length(trim(p_value#>>'{}')) between 1 and 120; end if;
   if p_field='platform' then return jsonb_typeof(p_value) in ('string','null')
       and (p_value='null'::jsonb or length(p_value#>>'{}')<=64); end if;
   /* A station match id is a foreign reference into bracket JSON.  Its
      replacement is deliberately disallowed; moderators can quarantine it. */
   return false;
 elsif p_kind='event' then
   if p_field='name' then return jsonb_typeof(p_value)='string' and length(trim(p_value#>>'{}')) between 1 and 160; end if;
   if p_field='game_id' then return jsonb_typeof(p_value)='string' and length(trim(p_value#>>'{}')) between 1 and 64; end if;
   if p_field='format' then return p_value in ('"single"'::jsonb,'"double"'::jsonb); end if;
   if p_field='venue_type' then return p_value in ('"offline"'::jsonb,'"online"'::jsonb); end if;
   if p_field='venue' then return jsonb_typeof(p_value) in ('string','null')
       and (p_value='null'::jsonb or length(p_value#>>'{}')<=320); end if;
   if p_field='starts_at' then
     if p_value='null'::jsonb then return true; end if;
     if jsonb_typeof(p_value)<>'string' or length(p_value#>>'{}')>40 then return false; end if;
     begin perform (p_value#>>'{}')::timestamptz; return true; exception when others then return false; end;
   end if;
   if p_field='platforms' then
     if jsonb_typeof(p_value)<>'array' or jsonb_array_length(p_value)>64 then return false; end if;
     return not exists(select 1 from jsonb_array_elements(p_value) x
       where jsonb_typeof(x)<>'string' or length(x#>>'{}')>64);
   end if;
   if p_field='preset_id' then return jsonb_typeof(p_value) in ('string','null')
       and (p_value='null'::jsonb or length(p_value#>>'{}')<=120); end if;
   if p_field='overrides' then return jsonb_typeof(p_value)='object' and octet_length(p_value::text)<=65536; end if;
   if p_field='seeding_report' then return jsonb_typeof(p_value) in ('object','null') and octet_length(p_value::text)<=65536; end if;
   if p_field='documents' then
     if jsonb_typeof(p_value)<>'array' or jsonb_array_length(p_value)>64 or octet_length(p_value::text)>65536 then return false; end if;
     for v_item in select value from jsonb_array_elements(p_value) loop
       if jsonb_typeof(v_item)<>'object' or jsonb_typeof(v_item->'id') is distinct from 'string'
          or length(trim(v_item->>'id')) not between 1 and 120
          or jsonb_typeof(v_item->'version') is distinct from 'number'
          or (v_item->>'version') !~ '^[1-9][0-9]{0,5}$' then return false; end if;
       for v_key in select jsonb_object_keys(v_item) loop
         if v_key<>all(array['id','title','body','text','type','version','required']) then return false; end if;
         if v_key in ('id','title','body','text','type') and jsonb_typeof(v_item->v_key)<>'string'
            or v_key='required' and jsonb_typeof(v_item->v_key)<>'boolean' then return false; end if;
         if v_key in ('title','body','text','type') and length(v_item->>v_key)>12000 then return false; end if;
       end loop;
     end loop;
     if exists(select 1 from jsonb_array_elements(p_value) d group by d->>'id',d->>'version' having count(*)>1) then return false; end if;
     return true;
   end if;
 elsif p_kind='bracket' then
   if jsonb_typeof(p_value)<>'object' or octet_length(p_value::text)>1048576
      or exists(select 1 from jsonb_object_keys(p_value) k where k<>all(array['matches','type','size','rounds','losers_rounds']))
      or not (p_value ?& array['matches','type','size','rounds','losers_rounds'])
      or jsonb_typeof(p_value->'matches')<>'array' or jsonb_array_length(p_value->'matches')>2048
      or jsonb_typeof(p_value->'type')<>'string' or p_value->>'type' not in ('single','double')
      or jsonb_typeof(p_value->'size')<>'number' or (p_value->>'size') !~ '^[0-9]{1,3}$'
      or (p_value->>'size')::integer not between 2 and 512
      or ((p_value->>'size')::integer & ((p_value->>'size')::integer-1))<>0
      or jsonb_typeof(p_value->'rounds')<>'number' or (p_value->>'rounds') !~ '^[0-9]{1,2}$'
      or (p_value->>'rounds')::integer not between 1 and 32
      or (p_value->'losers_rounds'<>'null'::jsonb and (jsonb_typeof(p_value->'losers_rounds')<>'number'
          or (p_value->>'losers_rounds') !~ '^[0-9]{1,2}$' or (p_value->>'losers_rounds')::integer not between 1 and 64)) then
     return false;
   end if;
   for v_item in select value from jsonb_array_elements(p_value->'matches') loop
     if jsonb_typeof(v_item)<>'object' or jsonb_typeof(v_item->'id') is distinct from 'string'
        or length(v_item->>'id') not between 1 and 120 or jsonb_typeof(v_item->'slots') is distinct from 'array'
        or jsonb_array_length(v_item->'slots')>2 then return false; end if;
     v_id:=v_item->>'id';
     if v_id=any(v_ids) then return false; end if;
     v_ids:=array_append(v_ids,v_id);
     for v_slot in select value from jsonb_array_elements(v_item->'slots') loop
       if jsonb_typeof(v_slot)<>'object' then return false; end if;
       if v_slot ? 'entrantId' and jsonb_typeof(v_slot->'entrantId')<>'null' then
         if jsonb_typeof(v_slot->'entrantId')<>'string' or (v_slot->>'entrantId')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            or not exists(select 1 from public.bkt_entries en where en.event_id=p_id and en.id=(v_slot->>'entrantId')::uuid) then
           return false;
         end if;
       end if;
     end loop;
   end loop;
   if exists(select 1 from public.bkt_stations s where s.event_id=p_id and s.match_id is not null and not(s.match_id=any(v_ids))) then
     return false;
   end if;
   return true;
 end if;
 return false;
end $$;

/* Result rows remain durable records.  Quarantine/hide changes visibility via
   this state and RLS, never by deleting the result. */
drop policy read_result on public.bkt_results;
create policy read_result on public.bkt_results for select using (
  bkt_private.can_read(event_id)
  and not superseded
  and moderation_state not in ('hidden','quarantined')
);

/* The event bundle is a SECURITY DEFINER read path, so it must carry the same
   visibility rule as the table policy instead of accidentally returning
   superseded or quarantined result history. */
create or replace function public.bkt_read_event(p_event_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 if not bkt_private.can_read(p_event_id) then raise exception 'event_unavailable' using errcode='42501'; end if;
 return jsonb_build_object(
 'event',(select bkt_private.admin_scrub_row('event',e.id,to_jsonb(e)) from public.bkt_events e where e.id=p_event_id),
 'entries',(select coalesce(jsonb_agg(bkt_private.admin_scrub_row('entry',en.id,to_jsonb(en)) order by en.registered_at,en.id),'[]') from public.bkt_entries en where en.event_id=p_event_id),
 'players',(select coalesce(jsonb_agg(bkt_private.admin_scrub_row('player',p.id,to_jsonb(p)) order by p.id),'[]') from public.bkt_players p where
   exists(select 1 from public.bkt_entries en where en.event_id=p_event_id and en.player_id=p.id)
   or exists(select 1 from public.bkt_orgs o join public.bkt_events e on e.org_id=o.id where e.id=p_event_id and o.owner_id=p.id)),
 'stations',(select coalesce(jsonb_agg(bkt_private.admin_scrub_row('station',s.id,to_jsonb(s)) order by s.number),'[]') from public.bkt_stations s where s.event_id=p_event_id),
 'orgs',(select coalesce(jsonb_agg(bkt_private.admin_scrub_row('org',o.id,to_jsonb(o))),'[]') from public.bkt_orgs o join public.bkt_events e on e.org_id=o.id where e.id=p_event_id),
 'brackets',(select coalesce(jsonb_agg(to_jsonb(b)),'[]') from public.bkt_brackets b where b.event_id=p_event_id
   and not bkt_private.content_is_held('bracket',b.event_id)),
 'results',(select coalesce(jsonb_agg(to_jsonb(r) order by r.reported_at,r.id),'[]') from public.bkt_results r
   where r.event_id=p_event_id and not r.superseded and r.moderation_state not in ('hidden','quarantined')),
 'revision',(select revision from public.bkt_events where id=p_event_id));
end $$;

create or replace function public.bkt_event_by_code(p_code text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_me uuid:=bkt_private.require_me(); v_event uuid; v_exp timestamptz; v_row public.bkt_events%rowtype;
begin
 if not bkt_private.attempt('invite') then return jsonb_build_object('error','rate_limited'); end if;
 if p_code is null or upper(p_code) !~ '^[A-HJ-NP-Z2-9]{12}$' then return jsonb_build_object('error','invalid_code'); end if;
 select i.event_id,least(i.expires_at,now()+interval '24 hours') into v_event,v_exp
 from bkt_private.invites i join public.bkt_events e on e.id=i.event_id
 where i.token_hash=sha256(convert_to(upper(p_code),'UTF8')) and i.expires_at>now() and e.status<>'draft';
 if not found then return jsonb_build_object('error','invalid_code'); end if;
 insert into bkt_private.readers values(v_event,v_me,v_exp)
 on conflict(event_id,player_id) do update set expires_at=excluded.expires_at;
 select * into v_row from public.bkt_events where id=v_event;
 return jsonb_build_object('event',bkt_private.admin_scrub_row('event',v_row.id,to_jsonb(v_row)),
   'access',jsonb_build_object('event_id',v_event,'expires_at',v_exp));
end $$;

create or replace function public.bkt_list_events() returns jsonb
language sql stable security definer set search_path=pg_catalog as $$
 with visible as (select e.* from public.bkt_events e where bkt_private.can_read(e.id)
   order by e.created_at desc,e.id limit 100),
 orgs as (select distinct o.* from public.bkt_orgs o join visible e on e.org_id=o.id)
 select jsonb_build_object(
  'events',(select coalesce(jsonb_agg(bkt_private.admin_scrub_row('event',e.id,to_jsonb(e)) order by e.created_at desc,e.id),'[]') from visible e),
  'orgs',(select coalesce(jsonb_agg(bkt_private.admin_scrub_row('org',o.id,to_jsonb(o))),'[]') from orgs o),
  'players',(select coalesce(jsonb_agg(bkt_private.admin_scrub_row('player',p.id,to_jsonb(p))),'[]') from public.bkt_players p where
    p.id=bkt_private.me() or exists(select 1 from orgs o where o.owner_id=p.id)))
$$;

alter table bkt_private.admin_members enable row level security;
alter table bkt_private.moderation_queue enable row level security;
alter table bkt_private.admin_audit enable row level security;
alter table bkt_private.user_reports enable row level security;

create index bkt_admin_members_active_role
  on bkt_private.admin_members(active,role);
create index bkt_moderation_queue_state_updated
  on bkt_private.moderation_queue(state,updated_at desc);
create index bkt_moderation_queue_replacement_result
  on bkt_private.moderation_queue(replacement_result_id)
  where replacement_result_id is not null;
create index bkt_admin_audit_created
  on bkt_private.admin_audit(created_at desc,id);
create index bkt_admin_audit_actor
  on bkt_private.admin_audit(admin_auth_user_id);
create index bkt_user_reports_dedupe
  on bkt_private.user_reports(reporter_auth_user_id,target_kind,target_id,target_field,submitted_at desc);
create index bkt_user_reports_status_submitted
  on bkt_private.user_reports(status,submitted_at desc,id);
create index bkt_user_reports_target
  on bkt_private.user_reports(target_kind,target_id,target_field,submitted_at desc);
create index bkt_events_created_at
  on public.bkt_events(created_at);
create index bkt_entries_registered_at
  on public.bkt_entries(registered_at);
create index bkt_results_reported_at
  on public.bkt_results(reported_at);
create index bkt_results_event_visible
  on public.bkt_results(event_id,reported_at,id)
  where not superseded and moderation_state not in ('hidden','quarantined');

create function bkt_private.require_admin(p_roles text[] default null) returns text
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;
begin
 if auth.uid() is null then
   raise exception 'authentication_required' using errcode='42501';
 end if;
 if coalesce((select (auth.jwt()->>'is_anonymous')::boolean),false) then
   raise exception 'durable_admin_account_required' using errcode='42501';
 end if;
 /* AAL is a top-level, Auth-issued claim.  Never read end-user-editable
    metadata for this decision. */
 if coalesce((select auth.jwt()->>'aal'),'aal1') <> 'aal2' then
   raise exception 'aal2_required' using errcode='42501';
 end if;
 select m.role into v_role
 from bkt_private.admin_members m
 where m.auth_user_id=auth.uid() and m.active is true;
 if v_role is null then
   raise exception 'admin_required' using errcode='42501';
 end if;
 if p_roles is not null and not (v_role=any(p_roles)) then
   raise exception 'admin_role_required' using errcode='42501';
 end if;
 return v_role;
end $$;

create function bkt_private.reject_locked_content() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare v_id uuid; v_kind text; v_old jsonb; v_new jsonb;
begin
 /* Only bkt_admin_moderate sets this transaction-local flag after checking a
    current admin role. A super-admin using an ordinary organizer RPC does not
    bypass the preservation rules. */
 if current_setting('bkt.admin_override',true)='on' then
   if tg_op='DELETE' then return old; end if;
   return new;
 end if;
 v_kind:=case tg_table_name
   when 'bkt_players' then 'player'
   when 'bkt_orgs' then 'org'
   when 'bkt_events' then 'event'
   when 'bkt_entries' then 'entry'
   when 'bkt_stations' then 'station'
   when 'bkt_brackets' then 'bracket'
   when 'bkt_results' then 'result'
 end;
 if tg_op='DELETE' then v_old:=to_jsonb(old);
 else v_old:=to_jsonb(old); v_new:=to_jsonb(new); end if;
 if v_kind='bracket' then
   v_id:=case when tg_op='DELETE' then old.event_id else new.event_id end;
   if exists(select 1 from bkt_private.moderation_queue q where q.locked
       and q.target_kind='bracket' and q.target_id=v_id and q.target_field='record') then
     /* A bracket is one structured document; preserve the whole document
        while allowing unrelated event-state rows to replay. */
     return null;
   end if;
 else
   v_id:=(case when tg_op='DELETE' then v_old->>'id' else v_new->>'id' end)::uuid;
 end if;
 if v_kind='bracket' then
   null;
 elsif v_kind='result' and exists(select 1 from bkt_private.moderation_queue q
      where q.locked and q.target_kind=v_kind and q.target_field='record'
        and (q.target_id=v_id or q.replacement_result_id=v_id)) then
   /* Organizer state replay updates and deletes the entire result collection.
      Preserve an admin correction row-for-row while allowing unrelated event
      changes in that same transaction to succeed. */
   return null;
 elsif exists(select 1 from bkt_private.moderation_queue q
      where q.locked and q.target_kind=v_kind and q.target_id=v_id
        and (tg_op='DELETE' or v_old->q.target_field is distinct from v_new->q.target_field)) then
   raise exception 'content_locked' using errcode='42501';
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;

create trigger bkt_players_locked_content before update or delete on public.bkt_players
for each row execute function bkt_private.reject_locked_content();
create trigger bkt_orgs_locked_content before update or delete on public.bkt_orgs
for each row execute function bkt_private.reject_locked_content();
create trigger bkt_events_locked_content before update or delete on public.bkt_events
for each row execute function bkt_private.reject_locked_content();
create trigger bkt_entries_locked_content before update or delete on public.bkt_entries
for each row execute function bkt_private.reject_locked_content();
create trigger bkt_stations_locked_content before update or delete on public.bkt_stations
for each row execute function bkt_private.reject_locked_content();
create trigger bkt_brackets_locked_content before update or delete on public.bkt_brackets
for each row execute function bkt_private.reject_locked_content();
create trigger bkt_results_locked_content before update or delete on public.bkt_results
for each row execute function bkt_private.reject_locked_content();

create function bkt_private.reject_admin_audit_mutation() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
 raise exception 'admin_audit_append_only' using errcode='42501';
end $$;

create trigger bkt_admin_audit_append_only
before update or delete on bkt_private.admin_audit
for each row execute function bkt_private.reject_admin_audit_mutation();

/* The UI calls this before rendering the site console.  It is intentionally
   still a privileged RPC: an AAL1 session cannot use it as an admin oracle. */
create function public.bkt_admin_access() returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_role text;
begin
 v_role:=bkt_private.require_admin(array['moderator','analyst','super_admin']);
 return jsonb_build_object(
   'active',true,
   'role',v_role,
   'aal','aal2',
   'can_moderate',v_role=any(array['moderator','super_admin']),
   'can_analyze',true,
     'can_queue',v_role=any(array['moderator','super_admin']),
     'can_content',v_role=any(array['moderator','super_admin']),
     'can_audit',v_role=any(array['moderator','super_admin']),
     'can_reports',v_role=any(array['moderator','super_admin'])
 );
end $$;

create function public.bkt_admin_queue(
  p_state text default null,
  p_search text default null,
  p_limit integer default 100,
  p_cursor jsonb default null
) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare
 v_role text; v_limit integer; v_search text;
 v_cursor_at timestamptz; v_cursor_id uuid;
 v_items jsonb; v_next jsonb;
begin
 v_role:=bkt_private.require_admin(array['moderator','super_admin']);
 if p_state is not null and not (p_state=any(array['open','quarantined','hidden','replaced','restored'])) then
   raise exception 'invalid_queue_state' using errcode='22023';
 end if;
 if p_limit is null or p_limit<1 or p_limit>500 then
   raise exception 'invalid_queue_limit' using errcode='22023';
 end if;
 v_search:=nullif(trim(p_search),'');
 if v_search is not null and length(v_search)>200 then raise exception 'invalid_queue_search' using errcode='22023'; end if;
 if p_cursor is not null then
   if jsonb_typeof(p_cursor)<>'object' or not (p_cursor ?& array['updated_at','id'])
      or (p_cursor-'updated_at'-'id')<>'{}'::jsonb then
     raise exception 'invalid_queue_cursor' using errcode='22023';
   end if;
   v_cursor_at:=(p_cursor->>'updated_at')::timestamptz;
   v_cursor_id:=(p_cursor->>'id')::uuid;
 end if;
 with base as (
   select m.*,
     (select count(*)::integer from bkt_private.user_reports r
       where r.target_kind=m.target_kind and r.target_id=m.target_id and r.target_field=m.target_field) as report_count,
     coalesce((select jsonb_agg(jsonb_build_object('id',latest.id,'reason',latest.reason,
       'submitted_at',latest.submitted_at,'status',latest.status,'triage_note',latest.triage_note)
       order by latest.submitted_at desc,latest.id desc)
       from (select r.id,r.reason,r.submitted_at,r.status,r.triage_note
         from bkt_private.user_reports r where r.target_kind=m.target_kind
          and r.target_id=m.target_id and r.target_field=m.target_field
         order by r.submitted_at desc,r.id desc limit 3) latest),'[]'::jsonb) as recent_reports
   from bkt_private.moderation_queue m
   where (p_state is null or m.state=p_state)
     and (m.source<>'user_report' or exists(select 1 from bkt_private.user_reports r
       where r.target_kind=m.target_kind and r.target_id=m.target_id and r.target_field=m.target_field
         and r.status in ('open','reviewing')))
     and (v_cursor_at is null or m.updated_at<v_cursor_at or (m.updated_at=v_cursor_at and m.id>v_cursor_id))
     and (v_search is null or position(lower(v_search) in lower(concat_ws(' ',m.target_kind,m.target_field,
       m.state,m.reason,m.original_value::text,m.replacement_value::text,
       (select string_agg(r.reason,' ') from bkt_private.user_reports r where r.target_kind=m.target_kind
          and r.target_id=m.target_id and r.target_field=m.target_field))))>0)
 ), page as (
   select b.*,row_number() over(order by b.updated_at desc,b.id) as rn
   from base b order by b.updated_at desc,b.id limit p_limit+1
 )
 select coalesce(jsonb_agg((to_jsonb(p)-'rn') || jsonb_build_object('recent_reports',p.recent_reports)
           order by p.updated_at desc,p.id) filter(where p.rn<=p_limit),'[]'::jsonb),
   case when count(*)>p_limit then (select jsonb_build_object('updated_at',p2.updated_at,'id',p2.id)
     from page p2 where p2.rn=p_limit) else null end
 into v_items,v_next from page p;
 return jsonb_build_object('role',v_role,'items',v_items,'next_cursor',v_next);
end $$;

/* Site-wide public content feed for the moderation console.  This is a fixed
   UNION of whitelisted fields, not a table/column name supplied by a caller.
   In particular, private contacts are not selected or joined. */
create function public.bkt_admin_content(
  p_target_kind text default null,
  p_search text default null,
  p_limit integer default 200,
  p_cursor jsonb default null
) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare
 v_role text; v_search text; v_cursor_kind text; v_cursor_id uuid; v_cursor_field text;
 v_items jsonb; v_next jsonb;
begin
 v_role:=bkt_private.require_admin(array['moderator','super_admin']);
 if p_target_kind is not null and not (p_target_kind=any(array['player','org','event','entry','station','bracket','result'])) then
   raise exception 'invalid_content_kind' using errcode='22023';
 end if;
 if p_limit is null or p_limit<1 or p_limit>500 then
   raise exception 'invalid_content_limit' using errcode='22023';
 end if;
 v_search:=nullif(trim(p_search),'');
 if v_search is not null and length(v_search)>200 then raise exception 'invalid_content_search' using errcode='22023'; end if;
 if p_cursor is not null then
   if jsonb_typeof(p_cursor)<>'object' or not (p_cursor ?& array['target_kind','target_id','target_field'])
      or (p_cursor-'target_kind'-'target_id'-'target_field')<>'{}'::jsonb then
     raise exception 'invalid_content_cursor' using errcode='22023';
   end if;
   v_cursor_kind:=p_cursor->>'target_kind';
   v_cursor_id:=(p_cursor->>'target_id')::uuid;
   v_cursor_field:=p_cursor->>'target_field';
   if not (v_cursor_kind=any(array['player','org','event','entry','station','bracket','result']))
      or length(v_cursor_field) not between 1 and 64 then
     raise exception 'invalid_content_cursor' using errcode='22023';
   end if;
 end if;
 with content(target_kind,target_id,target_field,value) as (
     select 'player',p.id,'tag',to_jsonb(p.tag)
       from public.bkt_players p
     union all
     select 'org',o.id,'name',to_jsonb(o.name)
       from public.bkt_orgs o
     union all
     select 'event',e.id,'name',to_jsonb(e.name)
       from public.bkt_events e
     union all
     select 'event',e.id,'game_id',to_jsonb(e.game_id)
       from public.bkt_events e
     union all
     select 'event',e.id,'format',to_jsonb(e.format)
       from public.bkt_events e
     union all
     select 'event',e.id,'venue_type',to_jsonb(e.venue_type)
       from public.bkt_events e
     union all
     select 'event',e.id,'venue',to_jsonb(e.venue)
       from public.bkt_events e where e.venue is not null
     union all
     select 'event',e.id,'platforms',to_jsonb(e.platforms)
       from public.bkt_events e
     union all
     select 'event',e.id,'starts_at',to_jsonb(e.starts_at)
       from public.bkt_events e where e.starts_at is not null
     union all
     select 'event',e.id,'preset_id',to_jsonb(e.preset_id)
       from public.bkt_events e where e.preset_id is not null
     union all
     select 'event',e.id,'overrides',e.overrides
       from public.bkt_events e
     union all
     select 'event',e.id,'documents',e.documents
       from public.bkt_events e
     union all
     select 'event',e.id,'seeding_report',e.seeding_report
       from public.bkt_events e where e.seeding_report is not null
     union all
     select 'entry',en.id,'crew',to_jsonb(en.crew)
       from public.bkt_entries en where en.crew is not null
     union all
     select 'station',s.id,'platform',to_jsonb(s.platform)
       from public.bkt_stations s where s.platform is not null
     union all
     select 'station',s.id,'match_id',to_jsonb(s.match_id)
       from public.bkt_stations s where s.match_id is not null
     union all
     select 'station',s.id,'label',to_jsonb(s.label)
       from public.bkt_stations s
     union all
     select 'bracket',b.event_id,'record',jsonb_build_object('matches',b.matches,'type',b.type,
       'size',b.size,'rounds',b.rounds,'losers_rounds',b.losers_rounds)
       from public.bkt_brackets b
     union all
     select 'result',coalesce(q.target_id,r.id),'record',to_jsonb(r)
       from public.bkt_results r
       left join bkt_private.moderation_queue q
         on q.target_kind='result' and q.target_field='record'
        and q.replacement_result_id=r.id
      where not r.superseded
   ), filtered as (
     select c.* from content c
     where (p_target_kind is null or c.target_kind=p_target_kind)
       and (v_cursor_kind is null or (c.target_kind,c.target_id,c.target_field)>(v_cursor_kind,v_cursor_id,v_cursor_field))
       and (v_search is null or position(lower(v_search) in lower(concat_ws(' ',c.target_kind,c.target_id::text,c.target_field,c.value::text)))>0)
   ), page as (
     select f.*,row_number() over(order by f.target_kind,f.target_id,f.target_field) as rn
     from filtered f order by f.target_kind,f.target_id,f.target_field limit p_limit+1
   )
   select coalesce(jsonb_agg(jsonb_build_object(
       'target_kind',p.target_kind,'target_id',p.target_id,'target_field',p.target_field,
       'value',bkt_private.admin_scrub_value(p.target_kind,p.target_id,p.target_field,p.value),
       'moderation',(select to_jsonb(q) from bkt_private.moderation_queue q
         where q.target_kind=p.target_kind and q.target_id=p.target_id and q.target_field=p.target_field),
       'report_count',(select count(*)::integer from bkt_private.user_reports r
         where r.target_kind=p.target_kind and r.target_id=p.target_id and r.target_field=p.target_field)
     ) order by p.target_kind,p.target_id,p.target_field) filter(where p.rn<=p_limit),'[]'::jsonb),
     case when count(*)>p_limit then (select jsonb_build_object('target_kind',p2.target_kind,
       'target_id',p2.target_id,'target_field',p2.target_field) from page p2 where p2.rn=p_limit) else null end
   into v_items,v_next from page p;
 return jsonb_build_object('role',v_role,'items',v_items,'next_cursor',v_next);
end $$;

create function public.bkt_admin_audit(
  p_search text default null,
  p_limit integer default 100,
  p_cursor jsonb default null
) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare
 v_role text; v_search text; v_cursor_at timestamptz; v_cursor_id uuid;
 v_items jsonb; v_next jsonb;
begin
 v_role:=bkt_private.require_admin(array['moderator','super_admin']);
 if p_limit is null or p_limit<1 or p_limit>500 then
   raise exception 'invalid_audit_limit' using errcode='22023';
 end if;
 v_search:=nullif(trim(p_search),'');
 if v_search is not null and length(v_search)>200 then raise exception 'invalid_audit_search' using errcode='22023'; end if;
 if p_cursor is not null then
   if jsonb_typeof(p_cursor)<>'object' or not (p_cursor ?& array['created_at','id'])
      or (p_cursor-'created_at'-'id')<>'{}'::jsonb then
     raise exception 'invalid_audit_cursor' using errcode='22023';
   end if;
   v_cursor_at:=(p_cursor->>'created_at')::timestamptz;
   v_cursor_id:=(p_cursor->>'id')::uuid;
 end if;
 with filtered as (
   select a.* from bkt_private.admin_audit a
   where (v_cursor_at is null or a.created_at<v_cursor_at or (a.created_at=v_cursor_at and a.id>v_cursor_id))
     and (v_search is null or position(lower(v_search) in lower(concat_ws(' ',a.admin_role,a.action,
       a.target_kind,a.target_id::text,a.target_field,a.reason,a.before_value::text,a.after_value::text)))>0)
 ), page as (
   select f.*,row_number() over(order by f.created_at desc,f.id) as rn
   from filtered f order by f.created_at desc,f.id limit p_limit+1
 )
 select coalesce(jsonb_agg((to_jsonb(p)-'rn') order by p.created_at desc,p.id) filter(where p.rn<=p_limit),'[]'::jsonb),
   case when count(*)>p_limit then (select jsonb_build_object('created_at',p2.created_at,'id',p2.id)
     from page p2 where p2.rn=p_limit) else null end
 into v_items,v_next from page p;
 return jsonb_build_object('role',v_role,'items',v_items,'next_cursor',v_next);
end $$;

create function bkt_private.report_target_readable(p_kind text,p_id uuid) returns boolean
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_me uuid:=bkt_private.me();
begin
 if p_id is null then return false; end if;
 case p_kind
   when 'player' then return exists(select 1 from public.bkt_players p where p.id=p_id and (
     p.id=v_me or exists(select 1 from public.bkt_entries en where en.player_id=p.id
       and bkt_private.can_read(en.event_id)) or exists(select 1 from public.bkt_orgs o
       join public.bkt_events e on e.org_id=o.id where o.owner_id=p.id and bkt_private.can_read(e.id))));
   when 'org' then return exists(select 1 from public.bkt_orgs o join public.bkt_events e on e.org_id=o.id
     where o.id=p_id and bkt_private.can_read(e.id));
   when 'event' then return bkt_private.can_read(p_id);
   when 'entry' then return exists(select 1 from public.bkt_entries en where en.id=p_id
     and bkt_private.can_read(en.event_id) and not bkt_private.content_is_held('entry',en.id));
   when 'station' then return exists(select 1 from public.bkt_stations s where s.id=p_id
     and bkt_private.can_read(s.event_id) and not bkt_private.content_is_held('station',s.id));
   when 'bracket' then return exists(select 1 from public.bkt_brackets b where b.event_id=p_id
     and bkt_private.can_read(b.event_id) and not bkt_private.content_is_held('bracket',b.event_id));
   when 'result' then return exists(select 1 from public.bkt_results r where r.id=p_id
       and not r.superseded and r.moderation_state not in ('hidden','quarantined')
       and bkt_private.can_read(r.event_id)
     union all
     select 1 from bkt_private.moderation_queue q join public.bkt_results r on r.id=q.replacement_result_id
       where q.target_kind='result' and q.target_id=p_id and q.target_field='record'
         and not r.superseded and r.moderation_state not in ('hidden','quarantined')
         and bkt_private.can_read(r.event_id));
   else return false;
 end case;
end $$;

create function public.bkt_submit_report(
  p_target_kind text,
  p_target_id uuid,
  p_target_field text,
  p_reason text
) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare
 v_player uuid; v_report_id uuid; v_snapshot jsonb; v_reason text;
begin
 if auth.uid() is null then raise exception 'authentication_required' using errcode='42501'; end if;
 if coalesce((select (auth.jwt()->>'is_anonymous')::boolean),false) then
   raise exception 'durable_account_required' using errcode='42501';
 end if;
 v_player:=bkt_private.require_me();
 if p_target_kind is null or p_target_id is null or p_target_field is null
    or not bkt_private.admin_field_allowed(p_target_kind,p_target_field) then
   raise exception 'invalid_report_target' using errcode='22023';
 end if;
 v_reason:=trim(coalesce(p_reason,''));
 if length(v_reason) not between 10 and 1200 or octet_length(v_reason)>4800 then
   raise exception 'invalid_report_reason' using errcode='22023';
 end if;
 if not bkt_private.report_target_readable(p_target_kind,p_target_id) then
   raise exception 'content_unavailable' using errcode='42501';
 end if;
 v_snapshot:=bkt_private.admin_snapshot(p_target_kind,p_target_id,p_target_field);
 if v_snapshot is null then raise exception 'content_unavailable' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,31));
 if exists(select 1 from bkt_private.user_reports r where r.reporter_auth_user_id=auth.uid()
   and r.target_kind=p_target_kind and r.target_id=p_target_id and r.target_field=p_target_field
   and r.submitted_at>=now()-interval '24 hours') then
   return jsonb_build_object('accepted',true,'duplicate',true);
 end if;
 if (select count(*) from bkt_private.user_reports r where r.reporter_auth_user_id=auth.uid()
   and r.submitted_at>=now()-interval '1 hour')>=5 then
   raise exception 'report_rate_limited' using errcode='P0001';
 end if;
 insert into bkt_private.user_reports(reporter_auth_user_id,target_kind,target_id,target_field,reason)
 values(auth.uid(),p_target_kind,p_target_id,p_target_field,v_reason)
 returning id into v_report_id;
 insert into bkt_private.moderation_queue(
   target_kind,target_id,target_field,state,original_value,reason,source,created_by,updated_by
 ) values(p_target_kind,p_target_id,p_target_field,'open',v_snapshot,'User report received.','user_report',null,null)
 on conflict(target_kind,target_id,target_field) do nothing;
 return jsonb_build_object('accepted',true,'duplicate',false);
end $$;

create function public.bkt_admin_reports(
  p_status text default null,
  p_search text default null,
  p_limit integer default 100,
  p_cursor jsonb default null
) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare
 v_role text; v_search text; v_cursor_at timestamptz; v_cursor_id uuid;
 v_items jsonb; v_next jsonb;
begin
 v_role:=bkt_private.require_admin(array['moderator','super_admin']);
 if p_status is not null and p_status not in ('open','reviewing','resolved','dismissed') then
   raise exception 'invalid_report_status' using errcode='22023';
 end if;
 if p_limit is null or p_limit<1 or p_limit>500 then raise exception 'invalid_report_limit' using errcode='22023'; end if;
 v_search:=nullif(trim(p_search),'');
 if v_search is not null and length(v_search)>200 then raise exception 'invalid_report_search' using errcode='22023'; end if;
 if p_cursor is not null then
   if jsonb_typeof(p_cursor)<>'object' or not (p_cursor ?& array['submitted_at','id'])
      or (p_cursor-'submitted_at'-'id')<>'{}'::jsonb then
     raise exception 'invalid_report_cursor' using errcode='22023';
   end if;
   v_cursor_at:=(p_cursor->>'submitted_at')::timestamptz;
   v_cursor_id:=(p_cursor->>'id')::uuid;
 end if;
 with filtered as (
   select r.* from bkt_private.user_reports r
   where (p_status is null or r.status=p_status)
     and (v_cursor_at is null or r.submitted_at<v_cursor_at or (r.submitted_at=v_cursor_at and r.id>v_cursor_id))
     and (v_search is null or position(lower(v_search) in lower(concat_ws(' ',r.target_kind,r.target_id::text,
       r.target_field,r.reason,r.status,r.triage_note,bkt_private.admin_snapshot(r.target_kind,r.target_id,r.target_field)::text)))>0)
 ), page as (
   select f.*,row_number() over(order by f.submitted_at desc,f.id) as rn
   from filtered f order by f.submitted_at desc,f.id limit p_limit+1
 )
 select coalesce(jsonb_agg(jsonb_build_object(
     'id',p.id,'target_kind',p.target_kind,'target_id',p.target_id,'target_field',p.target_field,
     'target_value',bkt_private.admin_scrub_value(p.target_kind,p.target_id,p.target_field,
       bkt_private.admin_snapshot(p.target_kind,p.target_id,p.target_field)),
     'reason',p.reason,'submitted_at',p.submitted_at,'status',p.status,'triage_note',p.triage_note,
     'reviewed_at',p.reviewed_at)
     order by p.submitted_at desc,p.id) filter(where p.rn<=p_limit),'[]'::jsonb),
   case when count(*)>p_limit then (select jsonb_build_object('submitted_at',p2.submitted_at,'id',p2.id)
     from page p2 where p2.rn=p_limit) else null end
 into v_items,v_next from page p;
 return jsonb_build_object('role',v_role,'items',v_items,'next_cursor',v_next);
end $$;

create function public.bkt_admin_review_report(p_report_id uuid,p_status text,p_note text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare
 v_role text; v_report bkt_private.user_reports%rowtype; v_note text; v_audit uuid;
 v_old_status text; v_old_note text;
begin
 v_role:=bkt_private.require_admin(array['moderator','super_admin']);
 if p_report_id is null or p_status is null or p_status not in ('open','reviewing','resolved','dismissed') then
   raise exception 'invalid_report_review' using errcode='22023';
 end if;
 if p_note is not null and length(trim(p_note))>1000 then raise exception 'invalid_report_note' using errcode='22023'; end if;
 select * into v_report from bkt_private.user_reports where id=p_report_id for update;
 if not found then raise exception 'report_not_found' using errcode='22023'; end if;
 v_old_status:=v_report.status;
 v_old_note:=v_report.triage_note;
 v_note:=case when p_note is null then v_report.triage_note else nullif(trim(p_note),'') end;
 update bkt_private.user_reports set status=p_status,triage_note=v_note,reviewed_by=auth.uid(),reviewed_at=now()
  where id=p_report_id returning * into v_report;
 insert into bkt_private.admin_audit(
   admin_auth_user_id,admin_role,action,target_kind,target_id,target_field,before_value,after_value,reason,report_id
 ) values(auth.uid(),v_role,'review_report','report',p_report_id,'status',jsonb_build_object('status',v_old_status,'triage_note',v_old_note),
   jsonb_build_object('status',p_status,'triage_note',v_note),coalesce(v_note,'Report reviewed.'),p_report_id)
 returning id into v_audit;
 return jsonb_build_object('action_id',v_audit,'id',v_report.id,'target_kind',v_report.target_kind,
   'target_id',v_report.target_id,'target_field',v_report.target_field,'reason',v_report.reason,
   'submitted_at',v_report.submitted_at,'status',v_report.status,'triage_note',v_report.triage_note,
   'reviewed_at',v_report.reviewed_at);
end $$;

create function public.bkt_admin_metrics(
  p_from timestamptz default null,
  p_to timestamptz default null
) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare
 v_role text;
 v_from timestamptz:=coalesce(p_from,now()-interval '30 days');
 v_to timestamptz:=coalesce(p_to,now());
begin
 v_role:=bkt_private.require_admin(array['moderator','analyst','super_admin']);
 if v_from>=v_to or v_to-v_from>interval '366 days' then
   raise exception 'invalid_metrics_window' using errcode='22023';
 end if;
 return (
   with status_counts as (
     select e.status,count(*)::bigint as n
       from public.bkt_events e
      group by e.status
   ), daily_rows as (
     select date_trunc('day',e.created_at) as day,'events'::text as kind,count(*)::bigint as n
       from public.bkt_events e where e.created_at between v_from and v_to group by 1
     union all
     select date_trunc('day',en.registered_at),'entries',count(*)::bigint
       from public.bkt_entries en where en.registered_at between v_from and v_to group by 1
     union all
     select date_trunc('day',r.reported_at),'results',count(*)::bigint
       from public.bkt_results r where r.reported_at between v_from and v_to group by 1
   ), daily as (
     select d.day,
       coalesce(sum(d.n) filter (where d.kind='events'),0)::bigint as events,
       coalesce(sum(d.n) filter (where d.kind='entries'),0)::bigint as entries,
       coalesce(sum(d.n) filter (where d.kind='results'),0)::bigint as results
       from daily_rows d group by d.day
   )
   select jsonb_build_object(
     'role',v_role,
     'from',v_from,
     'to',v_to,
     'generated_at',now(),
     'totals',jsonb_build_object(
       'events',(select count(*) from public.bkt_events where created_at between v_from and v_to),
       'organizations',(select count(*) from public.bkt_orgs),
       'players',(select count(*) from public.bkt_players),
       'entries',(select count(*) from public.bkt_entries where registered_at between v_from and v_to),
       'results',(select count(*) from public.bkt_results where reported_at between v_from and v_to),
       'active_events',(select count(*) from public.bkt_events where status in ('registration','checkin','seeding','running'))
     ),
     'statuses',coalesce((select jsonb_agg(jsonb_build_object('status',s.status,'count',s.n) order by s.status) from status_counts s),'[]'::jsonb),
     'moderation',jsonb_build_object(
       'open',(select count(*) from bkt_private.moderation_queue where state='open'),
       'quarantined',(select count(*) from bkt_private.moderation_queue where state='quarantined'),
       'hidden',(select count(*) from bkt_private.moderation_queue where state='hidden'),
       'replaced',(select count(*) from bkt_private.moderation_queue where state='replaced'),
       'restored',(select count(*) from bkt_private.moderation_queue where state='restored'),
       'locked',(select count(*) from bkt_private.moderation_queue where locked)
     ),
     'daily',coalesce((select jsonb_agg(jsonb_build_object('day',d.day,'events',d.events,'entries',d.entries,'results',d.results) order by d.day) from daily d),'[]'::jsonb)
   )
 );
end $$;

/*
  Apply one moderation decision.  Public text is replaced with a short
  placeholder, while result rows are retained and filtered by moderation_state
  for ordinary readers.  A full original snapshot lives only in the private
  queue.  The function never accepts a table or column identifier from a
  caller, and has no delete action.
*/
create function public.bkt_admin_moderate(
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
     v_state:=p_action;
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
     update public.bkt_results set moderation_state=p_action,moderation_locked=v_locked
       where id=coalesce(v_replacement_result_id,p_target_id);
     v_state:=p_action;
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

/* Explicit RPC boundary.  No PUBLIC or anonymous execution, and no table
   grants are added for the client roles. */
revoke all on all tables in schema bkt_private from public,anon,authenticated;
revoke all on function bkt_private.require_admin(text[]),
 bkt_private.reject_locked_content(),bkt_private.reject_admin_audit_mutation(),
 bkt_private.admin_field_allowed(text,text),bkt_private.admin_snapshot(text,uuid,text),
 bkt_private.admin_scrub_value(text,uuid,text,jsonb),bkt_private.admin_scrub_row(text,uuid,jsonb),
 bkt_private.admin_write_value(text,uuid,text,jsonb),bkt_private.admin_value_valid(text,uuid,text,jsonb),
 bkt_private.report_target_readable(text,uuid)
 from public,anon,authenticated;
revoke all on function public.bkt_admin_access(),
 public.bkt_admin_queue(text,text,integer,jsonb),public.bkt_admin_content(text,text,integer,jsonb),
 public.bkt_admin_moderate(text,text,uuid,text,jsonb,text),public.bkt_admin_audit(text,integer,jsonb),
 public.bkt_admin_metrics(timestamptz,timestamptz),public.bkt_submit_report(text,uuid,text,text),
 public.bkt_admin_reports(text,text,integer,jsonb),public.bkt_admin_review_report(uuid,text,text)
 from public,anon,authenticated;
grant execute on function public.bkt_admin_access(),
 public.bkt_admin_queue(text,text,integer,jsonb),public.bkt_admin_content(text,text,integer,jsonb),
 public.bkt_admin_moderate(text,text,uuid,text,jsonb,text),public.bkt_admin_audit(text,integer,jsonb),
 public.bkt_admin_metrics(timestamptz,timestamptz),public.bkt_submit_report(text,uuid,text,text),
 public.bkt_admin_reports(text,text,integer,jsonb),public.bkt_admin_review_report(uuid,text,text)
 to authenticated;
commit;
