begin;
do $$ begin
 if current_setting('bkt.staging',true) is distinct from 'on' then raise exception 'Staging session required'; end if;
end $$;

-- Manual accounting stays private. A player can read their own record; only
-- current event staff can change it. No card processing or public ledger.
alter table public.bkt_events drop constraint bkt_events_entry_fee_check;
alter table public.bkt_events add constraint bkt_events_entry_fee_check check (entry_fee between 0 and 99999999.99);
create table bkt_private.entry_payments (
 entry_id uuid primary key references public.bkt_entries(id) on delete cascade,
 amount_due numeric(10,2) check (amount_due between 0 and 99999999.99),
 amount_paid numeric(10,2) not null default 0 check (amount_paid between 0 and 99999999.99),
 note text not null default '' check (length(note)<=500),
 recorded_by uuid not null,
 recorded_at timestamptz not null default now()
);
alter table bkt_private.entry_payments enable row level security;
revoke all on bkt_private.entry_payments from public,anon,authenticated;
alter table bkt_private.signatures add column document_title text, add column document_body text;

-- Normalize public text and advance versions on any change to signed content.
-- Existing empty legacy documents may remain untouched, but cannot be signed.
create function bkt_private.registration_documents() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare d jsonb; previous jsonb; old_body text; body text; docs jsonb:='[]'; ids text[]:='{}'; v integer;
begin
 if jsonb_typeof(new.documents) is distinct from 'array' or jsonb_array_length(new.documents)>20 then raise exception 'invalid_documents' using errcode='22023'; end if;
 for d in select value from jsonb_array_elements(new.documents) loop
   if jsonb_typeof(d) is distinct from 'object' or jsonb_typeof(d->'id') is distinct from 'string'
      or length(trim(d->>'id')) not between 1 and 120 or d->>'id'=any(ids)
      or jsonb_typeof(d->'version') is distinct from 'number' or (d->>'version') !~ '^[1-9][0-9]*$'
      or d ? 'required' and jsonb_typeof(d->'required') is distinct from 'boolean'
      or exists(select 1 from jsonb_object_keys(d) k where k not in ('id','title','body','text','type','version','required')) then
     raise exception 'invalid_document' using errcode='22023';
   end if;
   ids:=array_append(ids,d->>'id'); previous:=null; old_body:='';
   if tg_op='UPDATE' then
     select value into previous from jsonb_array_elements(old.documents) where value->>'id'=d->>'id';
     old_body:=trim(coalesce(previous->>'body',previous->>'text',case when d->>'id'='doc_coc' then old.overrides->>'codeOfConduct' end,''));
   end if;
   body:=trim(coalesce(d->>'body',d->>'text',case when d->>'id'='doc_coc' then new.overrides->>'codeOfConduct' end,''));
   if (previous is null or d is distinct from previous or body is distinct from old_body)
      and not (previous is not null and body='' and old_body='' and d->>'title' is not distinct from previous->>'title' and d->>'required'='false') then
     if jsonb_typeof(d->'title') is distinct from 'string' or length(trim(d->>'title')) not between 1 and 160
        or length(body) not between 1 and 30000
        or d ? 'body' and jsonb_typeof(d->'body') is distinct from 'string'
        or d ? 'text' and jsonb_typeof(d->'text') is distinct from 'string' then
       raise exception 'document_text_required' using errcode='22023';
     end if;
   end if;
   v:=(d->>'version')::integer;
   if previous is null then
     v:=greatest(v,coalesce((select max(document_version)+1 from bkt_private.signatures where event_id=new.id and document_id=d->>'id'),v));
   end if;
   if previous is not null then
     if body is distinct from old_body or d->>'title' is distinct from previous->>'title' then
       v:=greatest(v,(previous->>'version')::integer+1);
     elsif v<>(previous->>'version')::integer then raise exception 'document_version_requires_content_change' using errcode='22023';
     end if;
   end if;
   -- Leave an unchanged legacy row as-is until a host supplies real text.
   if body<>'' then d:=(d-'text')||jsonb_build_object('body',body,'version',v); end if;
   docs:=docs||jsonb_build_array(d);
 end loop;
 new.documents:=docs;
 return new;
end $$;
create trigger bkt_events_00_registration_documents before insert or update of documents,overrides on public.bkt_events
 for each row execute function bkt_private.registration_documents();

create function bkt_private.entry_registration(p_entry public.bkt_entries) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_event public.bkt_events%rowtype; v_payment bkt_private.entry_payments%rowtype; result jsonb; due numeric;
begin
 select * into v_event from public.bkt_events where id=p_entry.event_id;
 result:=bkt_private.admin_scrub_row('entry',p_entry.id,to_jsonb(p_entry));
 result:=result||jsonb_build_object('signed_documents',coalesce((select jsonb_agg(d->>'id') from jsonb_array_elements(v_event.documents) d
   where exists(select 1 from bkt_private.signatures s where s.entry_id=p_entry.id and s.document_id=d->>'id'
     and s.document_version=(d->>'version')::integer)),'[]'::jsonb));
 if p_entry.player_id=bkt_private.me() or bkt_private.is_staff(v_event.org_id) then
   select * into v_payment from bkt_private.entry_payments where entry_id=p_entry.id;
   due:=coalesce(v_payment.amount_due,v_event.entry_fee);
   result:=result||jsonb_build_object('amount_due',v_payment.amount_due,'amount_paid',coalesce(v_payment.amount_paid,0),
     'payment_note',coalesce(v_payment.note,''),'paid_at',case when coalesce(v_payment.amount_paid,0)>=due then v_payment.recorded_at end);
 end if;
 return result;
end $$;

create function public.bkt_record_payment(p_entry_id uuid,p_amount_due numeric,p_amount_paid numeric,p_note text,p_expected_revision bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_me uuid:=bkt_private.require_me(); v_entry public.bkt_entries%rowtype; v_event public.bkt_events%rowtype;
begin
 select ev.* into v_event from public.bkt_events ev join public.bkt_entries en on en.event_id=ev.id where en.id=p_entry_id for update of ev;
 if not found or not bkt_private.is_staff(v_event.org_id) then raise exception 'organizer_required' using errcode='42501'; end if;
 if p_expected_revision is null or p_expected_revision<>v_event.revision then raise exception 'stale_revision: refresh the event' using errcode='40001'; end if;
 if p_amount_paid is null or p_amount_paid not between 0 and 99999999.99 or p_amount_paid<>round(p_amount_paid,2)
    or p_amount_due is not null and (p_amount_due not between 0 and 99999999.99 or p_amount_due<>round(p_amount_due,2))
    or length(coalesce(p_note,''))>500 then raise exception 'invalid_payment_amount' using errcode='22023'; end if;
 select * into v_entry from public.bkt_entries where id=p_entry_id for update;
 insert into bkt_private.entry_payments(entry_id,amount_due,amount_paid,note,recorded_by)
 values(p_entry_id,p_amount_due,p_amount_paid,trim(coalesce(p_note,'')),v_me)
 on conflict(entry_id) do update set amount_due=excluded.amount_due,amount_paid=excluded.amount_paid,
   note=excluded.note,recorded_by=excluded.recorded_by,recorded_at=now();
 update public.bkt_events set revision=revision+1 where id=v_event.id returning * into v_event;
 return jsonb_build_object('entry',bkt_private.entry_registration(v_entry),'revision',v_event.revision);
end $$;
revoke all on function bkt_private.registration_documents(),bkt_private.entry_registration(public.bkt_entries),public.bkt_record_payment(uuid,numeric,numeric,text,bigint) from public,anon,authenticated;
grant execute on function public.bkt_record_payment(uuid,numeric,numeric,text,bigint) to authenticated;

-- Updated definitions below preserve the existing moderation and revision gates.

create or replace function public.bkt_create_event(p_event_id uuid,p_event jsonb) returns jsonb
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
                                  or (p_event->>'entry_fee')::numeric not between 0 and 99999999.99
                                  or (p_event->>'entry_fee')::numeric<>round((p_event->>'entry_fee')::numeric,2))) then
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
      (p_event->>'starts_at')::timestamptz,coalesce((p_event->>'entry_fee')::numeric,0),coalesce(p_event->>'currency','USD'),p_event->>'preset_id',
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
   v_code:=bkt_private.new_invite_code();
   insert into bkt_private.invites values(sha256(convert_to(v_code,'UTF8')),p_event_id,now()+interval '30 days');
   insert into bkt_private.create_requests values(p_event_id,v_me,p_event,v_code);
 end if;
 return jsonb_build_object('event',(select to_jsonb(e) from public.bkt_events e where e.id=p_event_id),
   'org',(select to_jsonb(o) from public.bkt_orgs o where o.id=v_org),
   'stations',(select coalesce(jsonb_agg(to_jsonb(s) order by s.number),'[]') from public.bkt_stations s where s.event_id=p_event_id),
   'invite_code',v_code);
end $$;

create or replace function public.bkt_save_event_state(p_event_id uuid,p_expected_revision bigint,p_state jsonb) returns jsonb
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
   entry_fee=coalesce((p_state->'event'->>'entryFee')::numeric,entry_fee),
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

 if p_state->'event' ? 'entryFee' and ((p_state->'event'->>'entryFee')::numeric<>round((p_state->'event'->>'entryFee')::numeric,2)) then raise exception 'invalid_payment_amount' using errcode='22023'; end if;

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
   if exists(select 1 from public.bkt_entries where id=v_id and waitlisted) and not coalesce((v_item->>'waitlisted')::boolean,false)
      and (v_event.status not in ('registration','checkin','seeding') or exists(select 1 from public.bkt_brackets where event_id=p_event_id)) then raise exception 'waitlist_admission_closed' using errcode='55000'; end if;
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

 if (select count(*) from public.bkt_entries where event_id=p_event_id and not waitlisted)>(select capacity from public.bkt_events where id=p_event_id) then raise exception 'event_capacity_reached' using errcode='55000'; end if;

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

create or replace function public.bkt_sign_document(
 p_event_id uuid,p_document_id text,p_document_version integer,p_typed_name text
) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare
 v_me uuid:=bkt_private.require_me();
 v_event public.bkt_events%rowtype;
 v_entry public.bkt_entries%rowtype;
 v_changed boolean:=false; v_document jsonb; v_body text;
begin
 select * into v_event from public.bkt_events where id=p_event_id for update;
 if not found or not bkt_private.can_read(p_event_id) then
   raise exception 'event_unavailable' using errcode='42501';
 end if;
 if v_event.status not in ('registration','checkin') then raise exception 'signing_closed' using errcode='55000'; end if;
 if p_typed_name is null or length(trim(p_typed_name)) not between 1 and 160 or octet_length(trim(p_typed_name))>640 then
   raise exception 'invalid_signature_name' using errcode='22023';
 end if;
 if not exists(select 1 from jsonb_array_elements(v_event.documents) d
   where d->>'id'=p_document_id and (d->>'version')::integer=p_document_version) then
   raise exception 'document_unavailable' using errcode='22023';
 end if;
 select value into v_document from jsonb_array_elements(v_event.documents) where value->>'id'=p_document_id;
 v_body:=trim(coalesce(v_document->>'body',v_document->>'text',case when p_document_id='doc_coc' then v_event.overrides->>'codeOfConduct' end,''));
 if v_body='' then raise exception 'document_text_required' using errcode='22023'; end if;
 select * into v_entry from public.bkt_entries
 where event_id=p_event_id and player_id=v_me for update;
 if not found then raise exception 'entry_required' using errcode='42501'; end if;

 insert into bkt_private.signatures(entry_id,event_id,player_id,document_id,document_version,typed_name,document_title,document_body)
 values(v_entry.id,p_event_id,v_me,p_document_id,p_document_version,trim(p_typed_name),v_document->>'title',v_body)
 on conflict(entry_id,document_id,document_version) do nothing;
 if found then
   update public.bkt_entries set signed_documents=case when p_document_id=any(signed_documents)
     then signed_documents else array_append(signed_documents,p_document_id) end
   where id=v_entry.id returning * into v_entry;
   update public.bkt_events set revision=revision+1 where id=p_event_id;
   v_changed:=true;
 else
   select * into v_entry from public.bkt_entries where id=v_entry.id;
 end if;
 return jsonb_build_object('entry',bkt_private.entry_registration(v_entry),'changed',v_changed);
end $$;

create or replace function public.bkt_read_event(p_event_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 if not bkt_private.can_read(p_event_id) then raise exception 'event_unavailable' using errcode='42501'; end if;
 return jsonb_build_object(
 'event',(select bkt_private.admin_scrub_row('event',e.id,to_jsonb(e)) from public.bkt_events e where e.id=p_event_id),
 'entries',(select coalesce(jsonb_agg(bkt_private.entry_registration(en) order by en.registered_at,en.id),'[]') from public.bkt_entries en where en.event_id=p_event_id),
 'players',(select coalesce(jsonb_agg(bkt_private.admin_scrub_row('player',p.id,to_jsonb(p)) order by p.id),'[]') from public.bkt_players p where exists(select 1 from public.bkt_entries en where en.event_id=p_event_id and en.player_id=p.id) or exists(select 1 from public.bkt_orgs o join public.bkt_events e on e.org_id=o.id where e.id=p_event_id and o.owner_id=p.id)),
 'stations',(select coalesce(jsonb_agg(bkt_private.admin_scrub_row('station',s.id,to_jsonb(s)) order by s.number),'[]') from public.bkt_stations s where s.event_id=p_event_id),
 'orgs',(select coalesce(jsonb_agg(bkt_private.admin_scrub_row('org',o.id,to_jsonb(o))),'[]') from public.bkt_orgs o join public.bkt_events e on e.org_id=o.id where e.id=p_event_id),
 'brackets',(select coalesce(jsonb_agg(to_jsonb(b)),'[]') from public.bkt_brackets b where b.event_id=p_event_id and not bkt_private.content_is_held('bracket',b.event_id)),
 'results',(select coalesce(jsonb_agg(to_jsonb(r) order by r.reported_at,r.id),'[]') from public.bkt_results r where r.event_id=p_event_id and not r.superseded and r.moderation_state not in ('hidden','quarantined')),
 'match_submissions',(select coalesce(jsonb_agg(to_jsonb(s) order by s.submitted_at,s.id),'[]') from bkt_private.match_submissions s where s.event_id=p_event_id and (s.player_id=bkt_private.me() or bkt_private.is_staff((select org_id from public.bkt_events where id=p_event_id)))),
 'withdrawals',(select coalesce(jsonb_agg(to_jsonb(w) order by w.requested_at,w.id),'[]') from bkt_private.withdrawals w where w.event_id=p_event_id and (w.player_id=bkt_private.me() or bkt_private.is_staff((select org_id from public.bkt_events where id=p_event_id)))),
 'revision',(select revision from public.bkt_events where id=p_event_id));
end $$;

commit;
