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

/* One current moderation state per target field.  The first value is retained
   here so restore never depends on a client resubmitting the original content.
   There is intentionally no contact target: bkt_private.contacts never enters
   the queue, content feed, metrics, or audit payloads. */
create table bkt_private.moderation_queue (
  id uuid primary key default gen_random_uuid(),
  target_kind text not null check (target_kind in ('player','org','event','entry','station','result')),
  target_id uuid not null,
  target_field text not null check (length(trim(target_field)) between 1 and 64),
  state text not null default 'open'
    check (state in ('open','quarantined','hidden','replaced','restored')),
  original_value jsonb not null,
  replacement_value jsonb,
  replacement_result_id uuid references public.bkt_results(id),
  reason text not null check (length(trim(reason)) between 1 and 2000),
  locked boolean not null default false,
  /* Actor UUIDs intentionally outlive Auth accounts so the moderation record
     remains attributable after an administrator is deprovisioned. */
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_by uuid not null,
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
  action text not null check (action in ('hide','quarantine','restore','replace','lock')),
  target_kind text not null check (target_kind in ('player','org','event','entry','station','result')),
  target_id uuid not null,
  target_field text not null,
  before_value jsonb,
  after_value jsonb,
  reason text not null check (length(trim(reason)) between 1 and 2000),
  created_at timestamptz not null default now()
);

alter table public.bkt_results
  add column moderation_state text not null default 'visible'
    check (moderation_state in ('visible','quarantined','hidden','replaced')),
  add column moderation_locked boolean not null default false;

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
 'event',(select to_jsonb(e) from public.bkt_events e where e.id=p_event_id),
 'entries',(select coalesce(jsonb_agg(to_jsonb(en) order by en.registered_at,en.id),'[]') from public.bkt_entries en where en.event_id=p_event_id),
 'players',(select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]') from public.bkt_players p where
   exists(select 1 from public.bkt_entries en where en.event_id=p_event_id and en.player_id=p.id)
   or exists(select 1 from public.bkt_orgs o join public.bkt_events e on e.org_id=o.id where e.id=p_event_id and o.owner_id=p.id)),
 'stations',(select coalesce(jsonb_agg(to_jsonb(s) order by s.number),'[]') from public.bkt_stations s where s.event_id=p_event_id),
 'orgs',(select coalesce(jsonb_agg(to_jsonb(o)),'[]') from public.bkt_orgs o join public.bkt_events e on e.org_id=o.id where e.id=p_event_id),
 'brackets',(select coalesce(jsonb_agg(to_jsonb(b)),'[]') from public.bkt_brackets b where b.event_id=p_event_id),
 'results',(select coalesce(jsonb_agg(to_jsonb(r) order by r.reported_at,r.id),'[]') from public.bkt_results r
   where r.event_id=p_event_id and not r.superseded and r.moderation_state not in ('hidden','quarantined')),
 'revision',(select revision from public.bkt_events where id=p_event_id));
end $$;

alter table bkt_private.admin_members enable row level security;
alter table bkt_private.moderation_queue enable row level security;
alter table bkt_private.admin_audit enable row level security;

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
declare v_id uuid; v_kind text; v_field text;
begin
 /* Only bkt_admin_moderate sets this transaction-local flag after checking a
    current admin role. A super-admin using an ordinary organizer RPC does not
    bypass the preservation rules. */
 if current_setting('bkt.admin_override',true)='on' then
   if tg_op='DELETE' then return old; end if;
   return new;
 end if;
 if tg_op='DELETE' then
   v_id:=old.id;
 else
   v_id:=new.id;
 end if;
 v_kind:=case tg_table_name
   when 'bkt_players' then 'player'
   when 'bkt_orgs' then 'org'
   when 'bkt_events' then 'event'
   when 'bkt_entries' then 'entry'
   when 'bkt_stations' then 'station'
   when 'bkt_results' then 'result'
 end;
 if v_kind='player' and exists(select 1 from bkt_private.moderation_queue q
      where q.locked and q.target_kind=v_kind and q.target_id=v_id and q.target_field='tag'
        and (tg_op='DELETE' or (to_jsonb(old)->>'tag') is distinct from (to_jsonb(new)->>'tag'))) then
   raise exception 'content_locked' using errcode='42501';
 elsif v_kind='org' and exists(select 1 from bkt_private.moderation_queue q
      where q.locked and q.target_kind=v_kind and q.target_id=v_id and q.target_field='name'
        and (tg_op='DELETE' or (to_jsonb(old)->>'name') is distinct from (to_jsonb(new)->>'name'))) then
   raise exception 'content_locked' using errcode='42501';
 elsif v_kind='event' and exists(select 1 from bkt_private.moderation_queue q
      where q.locked and q.target_kind=v_kind and q.target_id=v_id and
        ((q.target_field='name' and (tg_op='DELETE' or (to_jsonb(old)->>'name') is distinct from (to_jsonb(new)->>'name'))) or
         (q.target_field='venue' and (tg_op='DELETE' or (to_jsonb(old)->>'venue') is distinct from (to_jsonb(new)->>'venue'))))) then
   raise exception 'content_locked' using errcode='42501';
 elsif v_kind='entry' and exists(select 1 from bkt_private.moderation_queue q
      where q.locked and q.target_kind=v_kind and q.target_id=v_id and q.target_field='crew'
        and (tg_op='DELETE' or (to_jsonb(old)->>'crew') is distinct from (to_jsonb(new)->>'crew'))) then
   raise exception 'content_locked' using errcode='42501';
 elsif v_kind='station' and exists(select 1 from bkt_private.moderation_queue q
      where q.locked and q.target_kind=v_kind and q.target_id=v_id and q.target_field='label'
        and (tg_op='DELETE' or (to_jsonb(old)->>'label') is distinct from (to_jsonb(new)->>'label'))) then
   raise exception 'content_locked' using errcode='42501';
 elsif v_kind='result' and exists(select 1 from bkt_private.moderation_queue q
      where q.locked and q.target_kind=v_kind and q.target_field='record'
        and (q.target_id=v_id or q.replacement_result_id=v_id)) then
   /* Organizer state replay updates and deletes the entire result collection.
      Preserve an admin correction row-for-row while allowing unrelated event
      changes in that same transaction to succeed. */
   return null;
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
   'can_audit',v_role=any(array['moderator','super_admin'])
 );
end $$;

create function public.bkt_admin_queue(
  p_state text default null,
  p_limit integer default 100
) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_role text; v_limit integer;
begin
 v_role:=bkt_private.require_admin(array['moderator','super_admin']);
 if p_state is not null and not (p_state=any(array['open','quarantined','hidden','replaced','restored'])) then
   raise exception 'invalid_queue_state' using errcode='22023';
 end if;
 if p_limit is null or p_limit<1 or p_limit>500 then
   raise exception 'invalid_queue_limit' using errcode='22023';
 end if;
 v_limit:=p_limit;
 return jsonb_build_object(
   'role',v_role,
   'items',coalesce((
     select jsonb_agg(to_jsonb(q) order by q.updated_at desc,q.id)
     from (
       select m.* from bkt_private.moderation_queue m
       where p_state is null or m.state=p_state
       order by m.updated_at desc,m.id
       limit v_limit
     ) q
   ),'[]'::jsonb),
   'next_cursor',null
 );
end $$;

/* Site-wide public content feed for the moderation console.  This is a fixed
   UNION of whitelisted fields, not a table/column name supplied by a caller.
   In particular, private contacts are not selected or joined. */
create function public.bkt_admin_content(
  p_target_kind text default null,
  p_limit integer default 200
) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_role text;
begin
 v_role:=bkt_private.require_admin(array['moderator','super_admin']);
 if p_target_kind is not null and not (p_target_kind=any(array['player','org','event','entry','station','result'])) then
   raise exception 'invalid_content_kind' using errcode='22023';
 end if;
 if p_limit is null or p_limit<1 or p_limit>500 then
   raise exception 'invalid_content_limit' using errcode='22023';
 end if;
 return (
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
     select 'event',e.id,'venue',to_jsonb(e.venue)
       from public.bkt_events e where e.venue is not null
     union all
     select 'entry',en.id,'crew',to_jsonb(en.crew)
       from public.bkt_entries en where en.crew is not null
     union all
     select 'station',s.id,'label',to_jsonb(s.label)
       from public.bkt_stations s
     union all
     select 'result',coalesce(q.target_id,r.id),'record',to_jsonb(r)
       from public.bkt_results r
       left join bkt_private.moderation_queue q
         on q.target_kind='result' and q.target_field='record'
        and q.replacement_result_id=r.id
      where not r.superseded
   ), limited as (
     select c.* from content c
     where p_target_kind is null or c.target_kind=p_target_kind
     order by c.target_kind,c.target_id,c.target_field
     limit p_limit
   )
   select jsonb_build_object(
     'role',v_role,
     'items',coalesce(jsonb_agg(jsonb_build_object(
       'target_kind',l.target_kind,
       'target_id',l.target_id,
       'target_field',l.target_field,
       'value',l.value,
       'moderation',(select to_jsonb(q) from bkt_private.moderation_queue q
         where q.target_kind=l.target_kind and q.target_id=l.target_id and q.target_field=l.target_field)
     ) order by l.target_kind,l.target_id,l.target_field),'[]'::jsonb),
     'next_cursor',null
   ) from limited l
 );
end $$;

create function public.bkt_admin_audit(
  p_limit integer default 100,
  p_before timestamptz default null
) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_role text;
begin
 v_role:=bkt_private.require_admin(array['moderator','super_admin']);
 if p_limit is null or p_limit<1 or p_limit>500 then
   raise exception 'invalid_audit_limit' using errcode='22023';
 end if;
 return jsonb_build_object(
   'role',v_role,
   'items',coalesce((
     select jsonb_agg(to_jsonb(a) order by a.created_at desc,a.id)
     from (
       select x.* from bkt_private.admin_audit x
       where p_before is null or x.created_at<p_before
       order by x.created_at desc,x.id
       limit p_limit
     ) a
   ),'[]'::jsonb),
   'next_cursor',null
 );
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
 v_key text;
 v_audit uuid;
begin
 v_role:=bkt_private.require_admin(array['moderator','super_admin']);
 if p_action is null or not (p_action=any(array['hide','quarantine','restore','replace','lock'])) then
   raise exception 'invalid_moderation_action' using errcode='22023';
 end if;
 if p_target_kind is null or not (p_target_kind=any(array['player','org','event','entry','station','result']))
    or p_target_id is null then
   raise exception 'invalid_moderation_target' using errcode='22023';
 end if;
 v_field:=nullif(trim(coalesce(p_target_field,'')),'');
 if p_target_kind='result' then
   v_field:=coalesce(v_field,'record');
   if v_field<>'record' then raise exception 'invalid_result_field' using errcode='22023'; end if;
 elsif v_field is null
    or (p_target_kind='player' and v_field<>'tag')
    or (p_target_kind='org' and v_field<>'name')
    or (p_target_kind='event' and v_field not in ('name','venue'))
    or (p_target_kind='entry' and v_field<>'crew')
    or (p_target_kind='station' and v_field<>'label') then
   raise exception 'invalid_moderation_field' using errcode='22023';
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

 if p_target_kind='player' then
   select * into v_player from public.bkt_players where id=p_target_id for update;
   if not found then raise exception 'moderation_target_not_found' using errcode='22023'; end if;
   v_before:=to_jsonb(v_player.tag);
   if not v_have_queue then v_original:=v_before; end if;
 elsif p_target_kind='org' then
   select * into v_org from public.bkt_orgs where id=p_target_id for update;
   if not found then raise exception 'moderation_target_not_found' using errcode='22023'; end if;
   v_before:=to_jsonb(v_org.name);
   if not v_have_queue then v_original:=v_before; end if;
 elsif p_target_kind='event' then
   select * into v_event from public.bkt_events where id=p_target_id for update;
   if not found then raise exception 'moderation_target_not_found' using errcode='22023'; end if;
   if v_field='name' then v_before:=to_jsonb(v_event.name); else v_before:=coalesce(to_jsonb(v_event.venue),'null'::jsonb); end if;
   if not v_have_queue then v_original:=v_before; end if;
 elsif p_target_kind='entry' then
   select * into v_entry from public.bkt_entries where id=p_target_id for update;
   if not found then raise exception 'moderation_target_not_found' using errcode='22023'; end if;
   v_before:=coalesce(to_jsonb(v_entry.crew),'null'::jsonb);
   if not v_have_queue then v_original:=v_before; end if;
 elsif p_target_kind='station' then
   select * into v_station from public.bkt_stations where id=p_target_id for update;
   if not found then raise exception 'moderation_target_not_found' using errcode='22023'; end if;
   v_before:=to_jsonb(v_station.label);
   if not v_have_queue then v_original:=v_before; end if;
 else
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
   if not v_have_queue then v_original:=v_before; end if;
 end if;

 /* Restoring must never erase a newer organizer edit. Once a prior decision
    has been restored, a later moderation cycle snapshots the then-current
    value as its new restore point. */
 if p_target_kind<>'result' and v_have_queue then
   if v_queue.state='hidden' and v_before is distinct from to_jsonb('[hidden]'::text) then
     raise exception 'moderation_target_changed' using errcode='40001';
   elsif v_queue.state='quarantined' and v_before is distinct from to_jsonb('[quarantined]'::text) then
     raise exception 'moderation_target_changed' using errcode='40001';
   elsif v_queue.state='replaced' and v_before is distinct from v_queue.replacement_value then
     raise exception 'moderation_target_changed' using errcode='40001';
   elsif v_queue.state='restored' and p_action<>'restore' then
     v_original:=v_before;
   end if;
 end if;

 /* Every active decision is a durable moderation hold. Organizer state replay
    cannot overwrite it; a moderator must use this audited RPC to restore or
    issue a further correction. */
 if p_action in ('lock','hide','quarantine','replace') then v_locked:=true;
 elsif p_action='restore' then v_locked:=false;
 end if;

 if p_action='restore' and not v_have_queue then
   raise exception 'nothing_to_restore' using errcode='22023';
 end if;

 if p_target_kind<>'result' then
   if p_action='hide' then v_value:='[hidden]';
   elsif p_action='quarantine' then v_value:='[quarantined]';
   elsif p_action='replace' then
     if p_replacement is null or jsonb_typeof(p_replacement) is distinct from 'string' then
       raise exception 'text_replacement_required' using errcode='22023';
     end if;
     v_value:=p_replacement#>>'{}';
   elsif p_action='restore' then
     v_value:=case when jsonb_typeof(v_original)='null' then null else v_original#>>'{}' end;
   end if;
   if p_action<>'lock' then
     if p_target_kind in ('player','org','station')
        and (v_value is null or length(trim(v_value))<1 or
             (p_target_kind='player' and length(trim(v_value))>64) or
             (p_target_kind='org' and length(trim(v_value))>120) or
             (p_target_kind='station' and length(trim(v_value))>120)) then
       raise exception 'invalid_text_replacement' using errcode='22023';
     end if;
     if p_target_kind='event' and v_field='name'
        and (v_value is null or length(trim(v_value)) not between 1 and 160) then
       raise exception 'invalid_text_replacement' using errcode='22023';
     end if;
     if p_target_kind='event' and v_field='venue'
        and v_value is not null and length(v_value)>320 then
       raise exception 'invalid_text_replacement' using errcode='22023';
     end if;
     if p_target_kind='entry' and v_value is not null and length(v_value)>120 then
       raise exception 'invalid_text_replacement' using errcode='22023';
     end if;
     if p_target_kind in ('player','org','event','station') or (p_target_kind='entry' and v_value is not null) then
       v_value:=trim(v_value);
     end if;
     if p_target_kind='player' then
       update public.bkt_players set tag=v_value where id=p_target_id;
     elsif p_target_kind='org' then
       update public.bkt_orgs set name=v_value where id=p_target_id;
     elsif p_target_kind='event' then
       if v_field='name' then update public.bkt_events set name=v_value where id=p_target_id;
       else update public.bkt_events set venue=v_value where id=p_target_id; end if;
     elsif p_target_kind='entry' then
       update public.bkt_entries set crew=v_value where id=p_target_id;
     else
       update public.bkt_stations set label=v_value where id=p_target_id;
     end if;
     v_after:=coalesce(to_jsonb(v_value),'null'::jsonb);
   else
     v_after:=v_before;
   end if;
   v_state:=case when p_action='lock' then coalesce(v_queue.state,'open') else p_action end;
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
     update public.bkt_results set
       game_id=coalesce(v_original->>'game_id',game_id),
       round_name=case when v_original ? 'round_name' then v_original->>'round_name' else round_name end,
       score_winner=coalesce((v_original->>'score_winner')::integer,score_winner),
       score_loser=coalesce((v_original->>'score_loser')::integer,score_loser),
       by_dq=coalesce((v_original->>'by_dq')::boolean,by_dq),
       winner_player_id=coalesce((v_original->>'winner_player_id')::uuid,winner_player_id),
       loser_player_id=coalesce((v_original->>'loser_player_id')::uuid,loser_player_id),
       moderation_state='visible',moderation_locked=false,superseded=false,superseded_at=null
       where id=p_target_id;
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

 if v_have_queue then
   update bkt_private.moderation_queue set
     state=v_state,
     replacement_value=case when p_action='replace' then p_replacement else null end,
     replacement_result_id=v_replacement_result_id,
     reason=coalesce(nullif(trim(p_reason),''),reason),
     locked=v_locked,
     updated_by=auth.uid(),updated_at=now()
   where id=v_queue.id returning * into v_queue;
 else
   insert into bkt_private.moderation_queue(
     target_kind,target_id,target_field,state,original_value,replacement_value,replacement_result_id,reason,locked,created_by,updated_by
   ) values(
     p_target_kind,p_target_id,v_field,v_state,v_original,
     case when p_action='replace' then p_replacement else null end,
     v_replacement_result_id,
     nullif(trim(p_reason),''),v_locked,auth.uid(),auth.uid()
   ) returning * into v_queue;
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
 bkt_private.reject_locked_content(),bkt_private.reject_admin_audit_mutation()
 from public,anon,authenticated;
revoke all on function public.bkt_admin_access(),
 public.bkt_admin_queue(text,integer),public.bkt_admin_content(text,integer),
 public.bkt_admin_moderate(text,text,uuid,text,jsonb,text),public.bkt_admin_audit(integer,timestamptz),
 public.bkt_admin_metrics(timestamptz,timestamptz)
 from public,anon,authenticated;
grant execute on function public.bkt_admin_access(),
 public.bkt_admin_queue(text,integer),public.bkt_admin_content(text,integer),
 public.bkt_admin_moderate(text,text,uuid,text,jsonb,text),public.bkt_admin_audit(integer,timestamptz),
 public.bkt_admin_metrics(timestamptz,timestamptz)
 to authenticated;
commit;
