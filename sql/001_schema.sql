-- Brackets -- tournament brackets for fighting games.
-- Target: the `battydevsite` Supabase project, the shared backend for the whole
-- site. Everything this feature owns is prefixed `bkt_`, for the same reason
-- /fcevents prefixes everything `raid_`: `players`, `events`, `matches` and
-- `results` are exactly the names the next sub-site would want, and squatting
-- them in `public` would make that collision somebody's problem later.
--
-- ============================================================================
-- THE SECURITY MODEL LIVES IN THIS FILE
-- ============================================================================
--
-- The page in ../index.html is a rendering layer over this schema and is
-- assumed hostile. The publishable key is in the page source; anyone can read
-- it out, open a REPL and issue their own queries. So every rule the UI appears
-- to enforce is a restatement of something enforced here, never the thing doing
-- the enforcing. If a change to the app appears to expose more than it should,
-- the bug is in THIS FILE.
--
-- The shape of the problem is different from /fcevents, and worth stating
-- plainly, because it drives every policy below:
--
--   A BRACKET IS PUBLIC. That is the point of a bracket. Who entered, who
--   played whom, and what the score was are meant to be readable by anyone
--   with the link -- including people with no account, standing in the venue.
--
-- So the interesting question here is not "who can read" (mostly: everyone)
-- but "who can WRITE", and "which of a person's details are not part of the
-- public record".
--
-- The three things that are NOT public:
--
--   1. Contact details -- email, legal name, phone. Held in bkt_player_private,
--      a separate table, readable only by the person and by staff of an org
--      they have actually entered an event for. Splitting the table rather
--      than filtering columns is deliberate: Postgres RLS is row-level, so a
--      policy cannot hide a column, and "we only select the safe columns in
--      the client" is not a security boundary when the client is hostile.
--
--   2. Signatures -- who agreed to what, when. This is a record with legal
--      weight and a typed human name in it; it is readable by the signer and
--      by staff of the org whose document it is, and by nobody else.
--
--   3. Payment state -- whether someone has paid the door fee. Visible to the
--      entrant and to staff. Not part of the public entrant list, because
--      "who has not paid yet" is nobody else's business.
--
-- And the writes:
--
--   * a player may write their OWN profile row and their own private row
--   * a player may create their own entry, and may update ONLY the fields
--     that are theirs to change on it -- check-in and signed documents.
--     Notably NOT their seed. A client that could set its own seed would make
--     the entire seeding feature decorative.
--   * an org's staff may write anything belonging to that org's events
--   * results and brackets are staff-only writes
--
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- bkt_players -- one row per person, forever
-- ---------------------------------------------------------------------------
-- The durable identity, deliberately NOT scoped to an event. See the note at
-- the top of ../views/player.js for why this inversion is the whole product.
--
-- `id` is NOT a foreign key to auth.users, and that is the important decision
-- in this schema. Most rows here DO correspond to an auth user, but a walk-up
-- entrant typed in at the door by a TO has no account and must still be a real
-- player with real match history. So `auth_user_id` is a nullable link, and a
-- row with it null is a claimable placeholder.
--
-- The alternative -- requiring an account to exist in the record -- excludes
-- roughly a third of a local's entrants, which are exactly the people a local
-- is made of.
create table if not exists public.bkt_players (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid unique references auth.users (id) on delete set null,

  tag           text not null check (length(trim(tag)) between 1 and 64),
  pronouns      text,
  region        text,
  home_venue    text,
  avatar_url    text,

  -- Public handles: psn, steam, nintendo, twitch, bluesky, x, discord.
  -- Public on purpose -- a PSN ID is how an opponent starts an online set, and
  -- hiding it would break the thing it exists for. Contact details that are
  -- NOT for that purpose live in bkt_player_private.
  connections   jsonb not null default '{}'::jsonb,
  mains         jsonb not null default '{}'::jsonb,

  -- Claimable placeholder state.
  claimable     boolean not null default false,
  claim_code    text unique,
  claim_org_id  uuid,
  created_by    uuid references public.bkt_players (id) on delete set null,

  -- Tombstone. A claimed placeholder is not deleted, because a bracket link
  -- shared in a Discord in March still points at it; it keeps a pointer so
  -- those links redirect rather than 404.
  merged_into   uuid references public.bkt_players (id) on delete set null,
  merged_at     timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- A placeholder has a code and no account; a real account has neither.
  constraint bkt_players_claim_shape check (
    (claimable and auth_user_id is null and claim_code is not null)
    or (not claimable and claim_code is null)
  )
);

comment on column public.bkt_players.auth_user_id is
  'Null for a walk-up entrant an organiser typed in. Set when they claim it.';
comment on column public.bkt_players.connections is
  'Public platform handles only. Anything that is contact rather than identity belongs in bkt_player_private.';

create index if not exists bkt_players_auth_idx on public.bkt_players (auth_user_id);
create index if not exists bkt_players_claim_idx on public.bkt_players (claim_code) where claim_code is not null;

-- ---------------------------------------------------------------------------
-- bkt_player_private -- the half that is nobody else's business
-- ---------------------------------------------------------------------------
-- Split from bkt_players rather than hidden with a column filter, because a
-- row-level policy cannot hide a column and a client-side select list is not a
-- boundary. If you are tempted to move `email` back up into bkt_players to
-- save a join: don't. The join is cheap and the mistake is not.
create table if not exists public.bkt_player_private (
  player_id   uuid primary key references public.bkt_players (id) on delete cascade,
  email       text,
  real_name   text,
  phone       text,
  -- Set by the entrant, honoured by staff-facing screens. Not a security
  -- control -- staff can see contact details for their own events regardless,
  -- because they need to be able to reach people -- but a stated preference.
  contact_pref text check (contact_pref in ('discord', 'email', 'either', 'none')),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- bkt_orgs and staff
-- ---------------------------------------------------------------------------
-- A venue, a store, a Discord -- whoever puts events on. Exists so that the
-- second event has somewhere to belong and so staff can be added without
-- sharing a login, which is what people otherwise do.
create table if not exists public.bkt_orgs (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  blurb       text,
  region      text,
  owner_id    uuid not null references public.bkt_players (id) on delete restrict,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.bkt_org_staff (
  org_id     uuid not null references public.bkt_orgs (id) on delete cascade,
  player_id  uuid not null references public.bkt_players (id) on delete cascade,
  role       text not null default 'staff' check (role in ('owner', 'staff')),
  added_at   timestamptz not null default now(),
  primary key (org_id, player_id)
);

-- The predicate every staff-write policy below is built on. A function rather
-- than a repeated subquery so there is ONE definition of "is staff here" --
-- eleven copies of a join is eleven chances to get one of them wrong.
--
-- STABLE, not IMMUTABLE: it reads tables. SECURITY DEFINER so it can see
-- bkt_org_staff regardless of the caller's own row access, which is required
-- or the policies would be circular.
create or replace function public.bkt_is_staff(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.bkt_org_staff s
    join public.bkt_players p on p.id = s.player_id
    where s.org_id = p_org
      and p.auth_user_id = auth.uid()
  );
$$;

-- "Is this me?" Same reasoning.
create or replace function public.bkt_is_me(p_player uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.bkt_players
    where id = p_player and auth_user_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------------
-- bkt_events
-- ---------------------------------------------------------------------------
create table if not exists public.bkt_events (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.bkt_orgs (id) on delete cascade,
  owner_id     uuid references public.bkt_players (id) on delete set null,

  name         text not null,
  game_id      text not null,
  format       text not null default 'double' check (format in ('single', 'double')),
  venue_type   text not null default 'offline' check (venue_type in ('offline', 'online')),
  venue        text,
  platforms    text[] not null default '{}',

  starts_at         timestamptz,
  check_in_opens_at timestamptz,
  check_in_closes_at timestamptz,
  completed_at      timestamptz,

  status       text not null default 'registration'
               check (status in ('draft', 'registration', 'checkin', 'seeding', 'running', 'complete')),

  capacity     integer check (capacity is null or capacity >= 2),
  entry_fee    numeric(10, 2) not null default 0,
  currency     text not null default 'USD',

  -- Short, human-sayable, no ambiguous glyphs. Unique so two events cannot
  -- share one -- a TO reading a code out over a PA has to land people in the
  -- right bracket.
  invite_code  text unique not null,

  -- 'public'   listed: turns up for anyone browsing.
  -- 'unlisted' reachable with the code or the link, and nowhere else.
  --
  -- Unlisted is a real read policy below and not merely a client-side filter,
  -- because a filter applied in the browser is not a filter at all against
  -- anyone willing to call PostgREST directly. What it is NOT is secrecy: an
  -- unlisted event is readable by anyone holding the code, and codes get
  -- forwarded. See bkt_event_by_code.
  visibility   text not null default 'public'
               check (visibility in ('public', 'unlisted')),

  -- The ruleset, stored as a COPY rather than a reference. A preset that
  -- changes next month must not silently rewrite the rules of an event that
  -- already ran; see the note in ../data/games.js.
  preset_id    text,
  overrides    jsonb not null default '{}'::jsonb,
  documents    jsonb not null default '[]'::jsonb,
  seeding_report jsonb,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists bkt_events_org_idx on public.bkt_events (org_id);
-- The browsing index carries visibility because the browsing query filters on
-- it, and a partial index on the listed rows is smaller than the whole table.
create index if not exists bkt_events_status_idx on public.bkt_events (status, starts_at desc)
  where visibility = 'public';

-- ---------------------------------------------------------------------------
-- bkt_entries -- a player IN an event
-- ---------------------------------------------------------------------------
-- The join row. Everything true of somebody at THIS event and nowhere else.
create table if not exists public.bkt_entries (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.bkt_events (id) on delete cascade,
  player_id   uuid not null references public.bkt_players (id) on delete cascade,

  seed        integer,
  crew        text,          -- team / venue, used by seeding separation
                             -- (not `group` or `grouping`: both are reserved words,
                             --  and a column you have to quote everywhere is a
                             --  column somebody will eventually forget to quote)
  notes       text,

  checked_in_at timestamptz,
  paid_at       timestamptz,
  waitlisted    boolean not null default false,
  signed_documents text[] not null default '{}',

  source      text default 'self' check (source in ('self', 'door', 'import', 'staff')),
  registered_at timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- One entry per player per event. This is the constraint that makes the
  -- duplicate-detection in the app a nicety rather than the only defence.
  unique (event_id, player_id)
);

create index if not exists bkt_entries_event_idx on public.bkt_entries (event_id, seed);
create index if not exists bkt_entries_player_idx on public.bkt_entries (player_id);

-- ---------------------------------------------------------------------------
-- bkt_brackets -- the generated structure
-- ---------------------------------------------------------------------------
-- The match list is jsonb rather than a bkt_matches table, and that is a real
-- trade worth writing down.
--
-- FOR: a bracket is read and written as a whole. Progression rewrites several
-- matches at once (winner forward, loser into losers, station freed), and as
-- one document that is one atomic write instead of a transaction across five
-- rows -- which matters a great deal when the writer is a phone on bad wifi
-- replaying a queue. It also means the client's in-memory bracket and the
-- stored one are literally the same shape, so there is no mapping layer to
-- disagree with itself.
--
-- AGAINST: you cannot query "every set Kira played" from here. That is exactly
-- why bkt_results below exists as its own table -- the durable, queryable
-- record is separate from the working structure. If a future feature needs to
-- query INSIDE a live bracket, that is the point to reconsider.
create table if not exists public.bkt_brackets (
  id          uuid primary key,         -- same id as the event; one per event
  event_id    uuid not null unique references public.bkt_events (id) on delete cascade,
  type        text not null check (type in ('single', 'double')),
  size        integer not null,
  rounds      integer not null,
  matches     jsonb not null default '[]'::jsonb,
  generated_at timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- bkt_results -- the durable record
-- ---------------------------------------------------------------------------
-- Append-only in spirit: a corrected result marks the old one superseded
-- rather than deleting it.
--
-- That is not bookkeeping fussiness. Two people reporting the same set from
-- two phones is routine, and when they disagree the only way a TO can settle
-- it is to see both, with timestamps and who reported them. Silently keeping
-- the last write and dropping the other destroys the only evidence.
--
-- Note it stores PLAYER ids, not entry ids. A profile query therefore never
-- joins through a tournament -- so it still works if the event is deleted, and
-- it works offline against a partial cache. Denormalised on purpose.
create table if not exists public.bkt_results (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid references public.bkt_events (id) on delete set null,
  game_id     text not null,
  match_id    text,
  round_name  text,

  winner_player_id uuid not null references public.bkt_players (id) on delete cascade,
  loser_player_id  uuid not null references public.bkt_players (id) on delete cascade,
  score_winner integer not null default 0,
  score_loser  integer not null default 0,
  by_dq        boolean not null default false,

  reported_at  timestamptz not null default now(),
  reported_by  uuid references public.bkt_players (id) on delete set null,
  superseded   boolean not null default false,
  superseded_at timestamptz,

  constraint bkt_results_distinct check (winner_player_id <> loser_player_id)
);

create index if not exists bkt_results_winner_idx on public.bkt_results (winner_player_id) where not superseded;
create index if not exists bkt_results_loser_idx on public.bkt_results (loser_player_id) where not superseded;
create index if not exists bkt_results_event_idx on public.bkt_results (event_id);

-- ---------------------------------------------------------------------------
-- bkt_stations
-- ---------------------------------------------------------------------------
create table if not exists public.bkt_stations (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.bkt_events (id) on delete cascade,
  number      integer not null,
  label       text not null,
  platform    text,
  stream      boolean not null default false,
  closed      boolean not null default false,
  match_id    text,
  updated_at  timestamptz not null default now()
);

create index if not exists bkt_stations_event_idx on public.bkt_stations (event_id, number);

-- ---------------------------------------------------------------------------
-- bkt_signatures -- who agreed to what, when
-- ---------------------------------------------------------------------------
-- Versioned against the document, because "they agreed to the code of conduct"
-- is worthless without "which version, and on what date".
--
-- READ THE README before treating this as a waiver system. It records
-- agreement; it does not make that agreement legally valid, and for anyone
-- under 18 it definitely does not.
create table if not exists public.bkt_signatures (
  id          uuid primary key default gen_random_uuid(),
  entry_id    uuid not null references public.bkt_entries (id) on delete cascade,
  event_id    uuid not null references public.bkt_events (id) on delete cascade,
  player_id   uuid not null references public.bkt_players (id) on delete cascade,
  document_id text not null,
  document_version integer not null default 1,
  typed_name  text not null,
  signed_at   timestamptz not null default now()
);

create index if not exists bkt_signatures_entry_idx on public.bkt_signatures (entry_id);

-- ===========================================================================
-- ROW LEVEL SECURITY
-- ===========================================================================

alter table public.bkt_players        enable row level security;
alter table public.bkt_player_private enable row level security;
alter table public.bkt_orgs           enable row level security;
alter table public.bkt_org_staff      enable row level security;
alter table public.bkt_events         enable row level security;
alter table public.bkt_entries        enable row level security;
alter table public.bkt_brackets       enable row level security;
alter table public.bkt_results        enable row level security;
alter table public.bkt_stations       enable row level security;
alter table public.bkt_signatures     enable row level security;

-- ---- players -------------------------------------------------------------
-- Readable by everyone. A tag and a match record are the public part of being
-- in a scene, and a bracket has to render names for people who are not signed
-- in. The claim_code column is the exception and it is handled below.
drop policy if exists bkt_players_read on public.bkt_players;
create policy bkt_players_read on public.bkt_players
  for select using (true);

drop policy if exists bkt_players_update_self on public.bkt_players;
create policy bkt_players_update_self on public.bkt_players
  for update using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid());

-- Staff may create claimable placeholders, and may correct the tag on one that
-- is still unclaimed -- typing someone's tag wrong at the door is the single
-- most common data-entry mistake at a local. They may NOT touch a claimed row:
-- once it belongs to a person, it is that person's.
drop policy if exists bkt_players_insert on public.bkt_players;
create policy bkt_players_insert on public.bkt_players
  for insert with check (
    -- signing up for the first time: the row must be yours
    (auth_user_id = auth.uid() and not claimable)
    -- or an organiser adding a walk-up
    or (claimable and auth_user_id is null and claim_org_id is not null and public.bkt_is_staff(claim_org_id))
  );

drop policy if exists bkt_players_update_placeholder on public.bkt_players;
create policy bkt_players_update_placeholder on public.bkt_players
  for update using (claimable and auth_user_id is null and public.bkt_is_staff(claim_org_id))
  with check (claimable and auth_user_id is null);

-- The claim code is a bearer token for somebody else's record, so it must not
-- be readable from a SELECT * that anyone can run. Revoking the column keeps
-- it out of every client query while leaving the row readable; the code is
-- only ever surfaced to the staff member who created the placeholder, through
-- the RPC below.
revoke select (claim_code) on public.bkt_players from anon, authenticated;

-- ---- player_private ------------------------------------------------------
-- Yours, or visible to staff of an org you have actually entered an event for.
-- Scoped to entry rather than to "any organiser", because otherwise anybody
-- who created a throwaway org could read every email in the database -- the
-- same privilege-escalation shape /fcevents ran into with event creators.
drop policy if exists bkt_private_read on public.bkt_player_private;
create policy bkt_private_read on public.bkt_player_private
  for select using (
    public.bkt_is_me(player_id)
    or exists (
      select 1
      from public.bkt_entries e
      join public.bkt_events ev on ev.id = e.event_id
      where e.player_id = bkt_player_private.player_id
        and public.bkt_is_staff(ev.org_id)
    )
  );

drop policy if exists bkt_private_write on public.bkt_player_private;
create policy bkt_private_write on public.bkt_player_private
  for all using (public.bkt_is_me(player_id))
  with check (public.bkt_is_me(player_id));

-- ---- orgs and staff ------------------------------------------------------
drop policy if exists bkt_orgs_read on public.bkt_orgs;
create policy bkt_orgs_read on public.bkt_orgs for select using (true);

drop policy if exists bkt_orgs_insert on public.bkt_orgs;
create policy bkt_orgs_insert on public.bkt_orgs
  for insert with check (public.bkt_is_me(owner_id));

drop policy if exists bkt_orgs_update on public.bkt_orgs;
create policy bkt_orgs_update on public.bkt_orgs
  for update using (public.bkt_is_staff(id)) with check (public.bkt_is_staff(id));

drop policy if exists bkt_staff_read on public.bkt_org_staff;
create policy bkt_staff_read on public.bkt_org_staff for select using (true);

-- Only an OWNER may change the staff list. A staff member who could add staff
-- could add themselves as owner, and then the roles are decorative.
drop policy if exists bkt_staff_write on public.bkt_org_staff;
create policy bkt_staff_write on public.bkt_org_staff
  for all using (
    exists (
      select 1 from public.bkt_org_staff s
      join public.bkt_players p on p.id = s.player_id
      where s.org_id = bkt_org_staff.org_id and s.role = 'owner' and p.auth_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.bkt_org_staff s
      join public.bkt_players p on p.id = s.player_id
      where s.org_id = bkt_org_staff.org_id and s.role = 'owner' and p.auth_user_id = auth.uid()
    )
  );

-- ---- events --------------------------------------------------------------
-- Listed and not a draft, or it is yours, or you are in it.
--
-- Three clauses, one per reason somebody legitimately sees an event:
--   * it is listed and published -- a draft is a TO thinking out loud
--   * you are staff for the org that owns it
--   * you are entered in it, which is how an unlisted event stays usable for
--     the people it was made for after they have joined by code
--
-- An unlisted event that nobody has joined yet is reachable ONLY through
-- bkt_event_by_code below, which is the point: without the code there is no
-- query that returns it, so the event list cannot be scraped for private
-- sessions. That is a genuinely different guarantee from filtering in the
-- browser, which is what "unlisted" means on most bracket sites.
drop policy if exists bkt_events_read on public.bkt_events;
create policy bkt_events_read on public.bkt_events
  for select using (
    (status <> 'draft' and visibility = 'public')
    or public.bkt_is_staff(org_id)
    or exists (
      select 1 from public.bkt_entries en
      join public.bkt_players p on p.id = en.player_id
      where en.event_id = bkt_events.id and p.auth_user_id = auth.uid()
    )
  );

-- Redeeming a code.
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER so it can see past the read policy above, which is the
-- only way an unlisted event can be opened by somebody who has the link but
-- has not entered yet.
--
-- It returns ONE event and only by exact code. That matters: the obvious
-- alternative -- letting the client select on invite_code -- requires the row
-- to be readable, which would defeat the policy entirely. Here the code is
-- the capability, and holding it grants exactly one row.
--
-- Codes are short enough to guess given enough attempts, and there is NO rate
-- limit here yet -- that is a real gap, recorded in ROADMAP.md, and the honest
-- state of it is: requiring a signed-in caller is the only mitigation in
-- place. It buys something (a guesser needs an account, and accounts can be
-- banned) and it is not sufficient on its own. Public events do not need this
-- function at all -- they are readable directly.
create or replace function public.bkt_event_by_code(p_code text)
returns public.bkt_events
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  ev public.bkt_events;
begin
  if auth.uid() is null then
    raise exception 'sign in to open an event by code'
      using errcode = '42501';
  end if;

  select * into ev
  from public.bkt_events
  where upper(invite_code) = upper(trim(p_code))
    and status <> 'draft';

  return ev;   -- null row when there is no match; the caller cannot tell
                -- "wrong code" from "unlisted and wrong code", which is the
                -- correct amount of information to give a guesser.
end;
$$;

revoke all on function public.bkt_event_by_code(text) from public, anon;
grant execute on function public.bkt_event_by_code(text) to authenticated;

drop policy if exists bkt_events_write on public.bkt_events;
create policy bkt_events_write on public.bkt_events
  for all using (public.bkt_is_staff(org_id)) with check (public.bkt_is_staff(org_id));

-- ---- entries -------------------------------------------------------------
-- The entrant list is public: that is what "who is entered" means. Payment
-- state is not, and is handled by revoking the column, same pattern as
-- claim_code.
drop policy if exists bkt_entries_read on public.bkt_entries;
create policy bkt_entries_read on public.bkt_entries for select using (true);

revoke select (paid_at, notes) on public.bkt_entries from anon;

drop policy if exists bkt_entries_staff on public.bkt_entries;
create policy bkt_entries_staff on public.bkt_entries
  for all using (
    exists (select 1 from public.bkt_events e where e.id = event_id and public.bkt_is_staff(e.org_id))
  )
  with check (
    exists (select 1 from public.bkt_events e where e.id = event_id and public.bkt_is_staff(e.org_id))
  );

-- A player may enter an open event themselves...
drop policy if exists bkt_entries_self_insert on public.bkt_entries;
create policy bkt_entries_self_insert on public.bkt_entries
  for insert with check (
    public.bkt_is_me(player_id)
    and exists (
      select 1 from public.bkt_events e
      where e.id = event_id and e.status in ('registration', 'checkin')
    )
  );

-- ...and may update their own entry. The trigger below is what stops that
-- from meaning "and set their own seed" -- a policy can gate the row but not
-- the columns, and self-seeding would make the whole seeding feature theatre.
drop policy if exists bkt_entries_self_update on public.bkt_entries;
create policy bkt_entries_self_update on public.bkt_entries
  for update using (public.bkt_is_me(player_id))
  with check (public.bkt_is_me(player_id));

create or replace function public.bkt_entries_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_staff boolean;
begin
  select public.bkt_is_staff(e.org_id) into is_staff
  from public.bkt_events e where e.id = new.event_id;

  if coalesce(is_staff, false) then
    return new;
  end if;

  -- Not staff: this is the entrant editing their own row. Only check-in and
  -- signed documents are theirs to change. Everything else is pinned to its
  -- old value rather than rejected, so a client that PATCHes the whole row --
  -- which is what an offline queue replaying an upsert does -- succeeds
  -- without being able to smuggle a seed change through it.
  new.seed          := old.seed;
  new.crew          := old.crew;
  new.paid_at       := old.paid_at;
  new.waitlisted    := old.waitlisted;
  new.notes         := old.notes;
  new.source        := old.source;
  new.player_id     := old.player_id;
  new.event_id      := old.event_id;
  new.registered_at := old.registered_at;
  return new;
end;
$$;

drop trigger if exists bkt_entries_guard_trg on public.bkt_entries;
create trigger bkt_entries_guard_trg
  before update on public.bkt_entries
  for each row execute function public.bkt_entries_guard();

-- ---- brackets, results, stations ----------------------------------------
-- All public to read -- a bracket on a projector has no session -- and
-- staff-only to write.
--
-- Staff-only writes are a deliberate limit on the current design and it is
-- worth naming: it means players cannot self-report their sets, which is a
-- feature every large event wants. Adding it means a bkt_result_claims table
-- where both players submit and agreement promotes it, with disputes going to
-- staff. That is the right shape; it is not built. See the README.
drop policy if exists bkt_brackets_read on public.bkt_brackets;
create policy bkt_brackets_read on public.bkt_brackets for select using (true);

drop policy if exists bkt_brackets_write on public.bkt_brackets;
create policy bkt_brackets_write on public.bkt_brackets
  for all using (exists (select 1 from public.bkt_events e where e.id = event_id and public.bkt_is_staff(e.org_id)))
  with check (exists (select 1 from public.bkt_events e where e.id = event_id and public.bkt_is_staff(e.org_id)));

drop policy if exists bkt_results_read on public.bkt_results;
create policy bkt_results_read on public.bkt_results for select using (true);

drop policy if exists bkt_results_write on public.bkt_results;
create policy bkt_results_write on public.bkt_results
  for all using (exists (select 1 from public.bkt_events e where e.id = event_id and public.bkt_is_staff(e.org_id)))
  with check (exists (select 1 from public.bkt_events e where e.id = event_id and public.bkt_is_staff(e.org_id)));

drop policy if exists bkt_stations_read on public.bkt_stations;
create policy bkt_stations_read on public.bkt_stations for select using (true);

drop policy if exists bkt_stations_write on public.bkt_stations;
create policy bkt_stations_write on public.bkt_stations
  for all using (exists (select 1 from public.bkt_events e where e.id = event_id and public.bkt_is_staff(e.org_id)))
  with check (exists (select 1 from public.bkt_events e where e.id = event_id and public.bkt_is_staff(e.org_id)));

-- ---- signatures ----------------------------------------------------------
-- The one table with no public read at all.
drop policy if exists bkt_signatures_read on public.bkt_signatures;
create policy bkt_signatures_read on public.bkt_signatures
  for select using (
    public.bkt_is_me(player_id)
    or exists (select 1 from public.bkt_events e where e.id = event_id and public.bkt_is_staff(e.org_id))
  );

-- Insert only, by the signer. No update and no delete policy exists, so
-- nobody -- including staff -- can rewrite a signature after the fact. That is
-- the entire point of keeping one.
drop policy if exists bkt_signatures_insert on public.bkt_signatures;
create policy bkt_signatures_insert on public.bkt_signatures
  for insert with check (public.bkt_is_me(player_id));

-- ===========================================================================
-- FUNCTIONS THE CLIENT CALLS
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- bkt_auth_methods -- "how does this email already sign in?"
-- ---------------------------------------------------------------------------
-- Powers the flow that stops anyone being told "that email is already
-- registered". See ../lib/auth.js.
--
-- This is an account-existence oracle and there is no way to write it that is
-- not. The honest position: the alternative -- letting someone submit a
-- password and THEN telling them the address is taken -- is the same oracle
-- with worse ergonomics, so refusing to build this buys nothing.
--
-- What it does do is stay modest. It returns provider names for an exact
-- match and nothing else: no tag, no id, no "close" matches, and the same
-- empty array for "no such user" as for "user with no identities". Bulk
-- checking should be handled by rate limiting at the edge -- Supabase's
-- per-IP limits apply to RPC calls, and an org running this seriously should
-- put a stricter limit in front of it.
create or replace function public.bkt_auth_methods(p_email text)
returns text[]
language sql
stable
security definer
set search_path = public, auth
as $$
  select coalesce(array_agg(distinct i.provider), '{}'::text[])
  from auth.users u
  join auth.identities i on i.user_id = u.id
  where lower(u.email) = lower(trim(p_email));
$$;

revoke all on function public.bkt_auth_methods(text) from public;
grant execute on function public.bkt_auth_methods(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- bkt_claim_player -- take over a walk-up entry
-- ---------------------------------------------------------------------------
-- A claim code is a bearer token for somebody else's tournament record, so the
-- rules that keep it from being a way to steal one are enforced HERE, not in
-- the client:
--
--   * the placeholder must still be unclaimed
--   * the caller must be signed in and claiming into their own player row
--   * a placeholder that has been in a PAID event cannot be self-claimed --
--     that is where the money is, so it needs a staff member to approve
--   * the claim is recorded, and the tombstone keeps a pointer so old links
--     still resolve
create or replace function public.bkt_claim_player(p_code text, p_into uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target public.bkt_players%rowtype;
  v_paid   boolean;
begin
  if auth.uid() is null then
    raise exception 'Sign in before claiming.' using errcode = '42501';
  end if;

  if not public.bkt_is_me(p_into) then
    raise exception 'You can only claim into your own account.' using errcode = '42501';
  end if;

  select * into v_target
  from public.bkt_players
  where claim_code = upper(trim(p_code)) and claimable and auth_user_id is null;

  if not found then
    raise exception 'That claim code did not match anything.' using errcode = 'P0002';
  end if;

  select exists (
    select 1 from public.bkt_entries e
    join public.bkt_events ev on ev.id = e.event_id
    where e.player_id = v_target.id and ev.entry_fee > 0 and e.paid_at is not null
  ) into v_paid;

  if v_paid and not public.bkt_is_staff(v_target.claim_org_id) then
    raise exception 'This entry is in a paid event — the organiser has to approve the claim.'
      using errcode = '42501';
  end if;

  update public.bkt_entries set player_id = p_into where player_id = v_target.id;
  update public.bkt_results set winner_player_id = p_into where winner_player_id = v_target.id;
  update public.bkt_results set loser_player_id  = p_into where loser_player_id  = v_target.id;
  update public.bkt_signatures set player_id = p_into where player_id = v_target.id;

  update public.bkt_players
     set claimable = false, claim_code = null,
         merged_into = p_into, merged_at = now()
   where id = v_target.id;

  return v_target.id;
end;
$$;

revoke all on function public.bkt_claim_player(text, uuid) from public;
grant execute on function public.bkt_claim_player(text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- New auth user -> player row
-- ---------------------------------------------------------------------------
-- Created by a trigger, never by the client. There is deliberately no path for
-- a client to insert a row with an arbitrary auth_user_id.
create or replace function public.bkt_on_auth_user_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player uuid;
  v_tag    text;
begin
  v_tag := coalesce(
    new.raw_user_meta_data -> 'custom_claims' ->> 'global_name',
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'name',
    split_part(coalesce(new.email, 'player'), '@', 1)
  );

  insert into public.bkt_players (auth_user_id, tag, avatar_url)
  values (new.id, left(coalesce(nullif(trim(v_tag), ''), 'Player'), 64),
          new.raw_user_meta_data ->> 'avatar_url')
  returning id into v_player;

  insert into public.bkt_player_private (player_id, email)
  values (v_player, new.email);

  return new;
end;
$$;

drop trigger if exists bkt_on_auth_user_created_trg on auth.users;
create trigger bkt_on_auth_user_created_trg
  after insert on auth.users
  for each row execute function public.bkt_on_auth_user_created();

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------
-- The client sends its own timestamp for last-write-wins, but a row must not
-- be able to claim it was written in the future -- a client with a wrong clock
-- (or a deliberate one) would otherwise win every conflict forever.
create or replace function public.bkt_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := least(coalesce(new.updated_at, now()), now());
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'bkt_players', 'bkt_player_private', 'bkt_orgs', 'bkt_events',
    'bkt_entries', 'bkt_brackets', 'bkt_stations'
  ] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format(
      'create trigger %I_touch before insert or update on public.%I
       for each row execute function public.bkt_touch()', t, t);
  end loop;
end $$;
