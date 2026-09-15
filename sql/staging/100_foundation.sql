-- Fresh, isolated staging ONLY. 001_schema.sql is an unsafe historical design,
-- not a prerequisite. Refuse coexistence rather than silently keeping its grants.
begin;
do $$
begin
  if current_setting('bkt.staging', true) is distinct from 'on' then
    raise exception 'Set bkt.staging=on in an explicitly selected staging session';
  end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
             where n.nspname='public' and c.relname like 'bkt\_%' escape '\')
     or exists (select 1 from pg_namespace where nspname='bkt_private')
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='public' and p.proname like 'bkt\_%' escape '\') then
    raise exception 'Existing bkt objects: use an empty staging database; no automatic legacy conversion';
  end if;
end $$;

create schema bkt_private;
revoke all on schema bkt_private from public, anon, authenticated;

create table public.bkt_players (
  id uuid primary key default gen_random_uuid(),
  tag text not null check (length(trim(tag)) between 1 and 64)
);
-- Auth identifiers and all credentials are outside the exposed schema. Identity
-- is resolved explicitly; there is no trigger on the site's shared auth.users.
create table bkt_private.identities (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  player_id uuid not null unique references public.bkt_players(id)
);
create table public.bkt_orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  owner_id uuid not null references public.bkt_players(id)
);
create table bkt_private.staff (
  org_id uuid references public.bkt_orgs(id),
  player_id uuid references public.bkt_players(id),
  role text not null check (role in ('owner','staff')),
  primary key (org_id,player_id)
);
create table public.bkt_events (
  id uuid primary key,
  org_id uuid not null references public.bkt_orgs(id),
  name text not null check (length(trim(name)) between 1 and 160),
  game_id text not null check (length(trim(game_id)) between 1 and 64),
  format text not null default 'double' check (format in ('single','double')),
  venue_type text not null default 'offline' check (venue_type in ('offline','online')),
  venue text check (length(venue)<=320),
  platforms text[] not null default '{}',
  starts_at timestamptz,
  entry_fee numeric(10,2) not null default 0 check (entry_fee=0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  preset_id text,
  overrides jsonb not null default '{}' check (jsonb_typeof(overrides)='object'),
  documents jsonb not null default '[]' check (jsonb_typeof(documents)='array'),
  capacity integer not null check (capacity between 2 and 256),
  status text not null default 'registration'
    check (status in ('draft','registration','checkin','running','complete')),
  visibility text not null check (visibility in ('public','unlisted')),
  revision bigint not null default 1,
  created_at timestamptz not null default now()
);
create table public.bkt_entries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.bkt_events(id),
  player_id uuid not null references public.bkt_players(id),
  seed integer,
  waitlisted boolean not null,
  checked_in_at timestamptz,
  registered_at timestamptz not null default now(),
  unique(event_id,player_id), unique(id,event_id,player_id)
);
create table public.bkt_stations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.bkt_events(id),
  number integer not null check (number between 1 and 64),
  label text not null,
  platform text,
  match_id text,
  unique(event_id,number)
);
-- Future tournament commands must validate the engine state transactionally.
-- There is deliberately NO write RPC for these documents/results in this slice.
create table public.bkt_brackets (
  event_id uuid primary key references public.bkt_events(id),
  revision bigint not null default 1,
  matches jsonb not null default '[]' check (jsonb_typeof(matches)='array')
);
create table public.bkt_results (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.bkt_events(id),
  match_id text not null,
  winner_player_id uuid not null references public.bkt_players(id),
  loser_player_id uuid not null references public.bkt_players(id),
  check (winner_player_id<>loser_player_id)
);
create table bkt_private.contacts (
  event_id uuid not null,
  player_id uuid not null,
  contact text not null check (length(trim(contact)) between 1 and 320),
  consent_at timestamptz not null default now(),
  primary key(event_id,player_id),
  foreign key(event_id,player_id) references public.bkt_entries(event_id,player_id)
);
create table bkt_private.create_requests (
  event_id uuid primary key references public.bkt_events(id),
  actor uuid not null references public.bkt_players(id),
  payload jsonb not null,
  invite_code text not null
);
create table bkt_private.invites (
  token_hash bytea primary key,
  event_id uuid not null references public.bkt_events(id),
  expires_at timestamptz not null
);
create table bkt_private.readers (
  event_id uuid references public.bkt_events(id),
  player_id uuid references public.bkt_players(id),
  expires_at timestamptz not null,
  primary key(event_id,player_id)
);
create table bkt_private.claims (
  token_hash bytea primary key,
  event_id uuid not null references public.bkt_events(id),
  player_id uuid not null unique references public.bkt_players(id),
  expires_at timestamptz not null,
  consumed_by uuid references public.bkt_players(id),
  consumed_at timestamptz
);
create table bkt_private.attempts (
  player_id uuid references public.bkt_players(id),
  kind text not null,
  window_start timestamptz not null,
  attempts integer not null,
  primary key(player_id,kind)
);
-- Signatures are reserved for a later reviewed document workflow. Composite FK
-- binds the signer to the entry/event; clients have neither read nor write grants.
create table bkt_private.signatures (
  entry_id uuid not null, event_id uuid not null, player_id uuid not null,
  document_id text not null, document_version integer not null,
  typed_name text not null, signed_at timestamptz not null default now(),
  foreign key(entry_id,event_id,player_id) references public.bkt_entries(id,event_id,player_id),
  primary key(entry_id,document_id,document_version)
);

create function bkt_private.me() returns uuid language sql stable security definer
set search_path = pg_catalog as $$
 select player_id from bkt_private.identities where auth_user_id=auth.uid()
$$;
create function bkt_private.is_staff(p_org uuid) returns boolean language sql stable security definer
set search_path = pg_catalog as $$
 select exists(select 1 from bkt_private.staff where org_id=p_org and player_id=bkt_private.me())
$$;
create function bkt_private.can_read(p_event uuid) returns boolean language sql stable security definer
set search_path = pg_catalog as $$
 select exists(select 1 from public.bkt_events e where e.id=p_event and (
   (e.visibility='public' and e.status<>'draft') or bkt_private.is_staff(e.org_id)
   or (e.status<>'draft' and (
     exists(select 1 from public.bkt_entries en where en.event_id=e.id and en.player_id=bkt_private.me())
     or exists(select 1 from bkt_private.readers r where r.event_id=e.id
               and r.player_id=bkt_private.me() and r.expires_at>now())
   ))))
$$;
-- RLS applies even to direct REST SELECTs. Definer helpers avoid recursive
-- policies; the function owner must be the trusted migration role, never a user.
alter table public.bkt_players enable row level security;
alter table public.bkt_orgs enable row level security;
alter table public.bkt_events enable row level security;
alter table public.bkt_entries enable row level security;
alter table public.bkt_stations enable row level security;
alter table public.bkt_brackets enable row level security;
alter table public.bkt_results enable row level security;
create policy read_event on public.bkt_events for select using(bkt_private.can_read(id));
create policy read_entry on public.bkt_entries for select using(bkt_private.can_read(event_id));
create policy read_station on public.bkt_stations for select using(bkt_private.can_read(event_id));
create policy read_bracket on public.bkt_brackets for select using(bkt_private.can_read(event_id));
create policy read_result on public.bkt_results for select using(bkt_private.can_read(event_id));
create policy read_player on public.bkt_players for select using (
  id=bkt_private.me() or exists(select 1 from public.bkt_entries e
    where e.player_id=bkt_players.id and bkt_private.can_read(e.event_id))
);
create policy read_org on public.bkt_orgs for select using (
  bkt_private.is_staff(id) or exists(select 1 from public.bkt_events e
    where e.org_id=bkt_orgs.id and bkt_private.can_read(e.id))
);
-- Explicitly reset table grants: column REVOKEs cannot override table grants.
revoke all on public.bkt_players, public.bkt_orgs, public.bkt_events,
 public.bkt_entries, public.bkt_stations, public.bkt_brackets, public.bkt_results
 from public, anon, authenticated;
grant select on public.bkt_players, public.bkt_orgs, public.bkt_events,
 public.bkt_entries, public.bkt_stations, public.bkt_brackets, public.bkt_results
 to anon, authenticated;
revoke all on all tables in schema bkt_private from public, anon, authenticated;
revoke all on all functions in schema bkt_private from public, anon, authenticated;
-- Helpers are executable solely to evaluate stored RLS expressions. The private
-- schema has no USAGE grant, and must never be added to PostgREST exposed schemas.
grant execute on function bkt_private.me(), bkt_private.is_staff(uuid),
 bkt_private.can_read(uuid) to anon, authenticated;
commit;
