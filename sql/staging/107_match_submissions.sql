-- Player match results are proposals. Only a staff review advances the bracket.
begin;

create table bkt_private.match_submissions (
 id uuid primary key,
 event_id uuid not null references public.bkt_events(id),
 match_id text not null,
 bracket_revision bigint not null,
 player_id uuid not null references public.bkt_players(id),
 entry_a uuid not null,
 entry_b uuid not null,
 winner_entry_id uuid not null,
 score_a integer not null check (score_a between 0 and 4),
 score_b integer not null check (score_b between 0 and 4),
 status text not null default 'pending' check (status in ('pending','accepted','corrected','stale')),
 submitted_at timestamptz not null default now(),
 reviewed_at timestamptz,
 reviewed_by uuid references public.bkt_players(id)
);
create unique index bkt_one_pending_match_submission
 on bkt_private.match_submissions(event_id,match_id) where status='pending';
create index bkt_match_submissions_event on bkt_private.match_submissions(event_id,submitted_at);
alter table bkt_private.match_submissions enable row level security;
revoke all on bkt_private.match_submissions from public,anon,authenticated;

create function bkt_private.close_stale_match_submissions() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
 update bkt_private.match_submissions s set status='stale',reviewed_at=now()
 where s.event_id=new.event_id and s.status='pending' and not exists (
   select 1 from jsonb_array_elements(new.matches) as m(value)
   where m.value->>'id'=s.match_id and not (m.value ? 'state')
     and not coalesce((m.value->>'cancelled')::boolean,false)
     and (m.value->'slots'->0->>'entrantId')::uuid is not distinct from s.entry_a
     and (m.value->'slots'->1->>'entrantId')::uuid is not distinct from s.entry_b
 );
 return new;
end $$;
create trigger bkt_close_stale_match_submissions
after update on public.bkt_brackets for each row
execute function bkt_private.close_stale_match_submissions();

create function public.bkt_submit_match_result(
 p_id uuid,p_event_id uuid,p_match_id text,p_expected_revision bigint,
 p_winner_entry_id uuid,p_score_a integer,p_score_b integer
) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_me uuid:=bkt_private.require_me(); v_event public.bkt_events%rowtype;
 v_bracket public.bkt_brackets%rowtype; v_match jsonb; v_a uuid; v_b uuid;
 v_existing bkt_private.match_submissions%rowtype;
begin
 if p_id is null or p_event_id is null or p_match_id is null or length(p_match_id) not between 1 and 120
   or p_expected_revision is null or p_winner_entry_id is null
   or p_score_a is null or p_score_b is null or p_score_a not between 0 and 4
   or p_score_b not between 0 and 4 or p_score_a=p_score_b then
   raise exception 'invalid_match_submission' using errcode='22023';
 end if;
 select * into v_event from public.bkt_events where id=p_event_id for update;
 if not found then raise exception 'event_unavailable' using errcode='42501'; end if;
 select * into v_existing from bkt_private.match_submissions where id=p_id;
 if found then
   if v_existing.event_id<>p_event_id or v_existing.match_id<>p_match_id
     or v_existing.player_id<>v_me or v_existing.winner_entry_id<>p_winner_entry_id
     or v_existing.score_a<>p_score_a or v_existing.score_b<>p_score_b then
     raise exception 'submission_id_conflict' using errcode='23505';
   end if;
   return to_jsonb(v_existing);
 end if;
 if v_event.status<>'running' or v_event.revision<>p_expected_revision then
   raise exception 'stale_match' using errcode='40001';
 end if;
 select * into v_bracket from public.bkt_brackets where event_id=p_event_id;
 select value into v_match from jsonb_array_elements(coalesce(v_bracket.matches,'[]'::jsonb))
   where value->>'id'=p_match_id;
 if v_match is null or v_match ? 'state' or v_match->>'calledAt' is null
   or coalesce((v_match->>'cancelled')::boolean,false)
   or jsonb_array_length(v_match->'slots')<>2 then
   raise exception 'match_unavailable' using errcode='22023';
 end if;
 v_a:=(v_match->'slots'->0->>'entrantId')::uuid;
 v_b:=(v_match->'slots'->1->>'entrantId')::uuid;
 if v_a is null or v_b is null or v_a=v_b or p_winner_entry_id not in (v_a,v_b)
   or (p_winner_entry_id=v_a and p_score_a<=p_score_b)
   or (p_winner_entry_id=v_b and p_score_b<=p_score_a) then
   raise exception 'invalid_match_score' using errcode='22023';
 end if;
 if not exists(select 1 from public.bkt_entries en where en.event_id=p_event_id
   and en.id in (v_a,v_b) and en.player_id=v_me and not en.waitlisted) then
   raise exception 'match_player_required' using errcode='42501';
 end if;
 insert into bkt_private.match_submissions
   (id,event_id,match_id,bracket_revision,player_id,entry_a,entry_b,winner_entry_id,score_a,score_b)
 values(p_id,p_event_id,p_match_id,v_bracket.revision,v_me,v_a,v_b,p_winner_entry_id,p_score_a,p_score_b)
 returning * into v_existing;
 return to_jsonb(v_existing);
end $$;

create function public.bkt_review_match_result(
 p_id uuid,p_expected_revision bigint,p_state jsonb,p_decision text
) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_submission bkt_private.match_submissions%rowtype;
 v_event public.bkt_events%rowtype; v_match jsonb; v_me uuid:=bkt_private.require_me();
begin
 if p_id is null or p_expected_revision is null or p_decision is null
   or p_decision not in ('accepted','corrected') then
   raise exception 'invalid_review' using errcode='22023';
 end if;
 select event_id into v_submission.event_id from bkt_private.match_submissions where id=p_id;
 if not found then raise exception 'submission_unavailable' using errcode='22023'; end if;
 select * into v_event from public.bkt_events where id=v_submission.event_id for update;
 if not bkt_private.is_staff(v_event.org_id) then raise exception 'staff_required' using errcode='42501'; end if;
 select * into v_submission from bkt_private.match_submissions where id=p_id for update;
 if v_submission.status<>'pending' then return public.bkt_read_event(v_submission.event_id); end if;
 if v_event.status<>'running' or v_event.revision<>p_expected_revision then
   raise exception 'stale_revision' using errcode='40001'; end if;
 select value into v_match from public.bkt_brackets b,
   jsonb_array_elements(b.matches) where b.event_id=v_submission.event_id
   and value->>'id'=v_submission.match_id;
 if v_match is null or v_match ? 'state' or coalesce((v_match->>'cancelled')::boolean,false)
   or (v_match->'slots'->0->>'entrantId')::uuid is distinct from v_submission.entry_a
   or (v_match->'slots'->1->>'entrantId')::uuid is distinct from v_submission.entry_b then
   raise exception 'stale_match' using errcode='40001'; end if;
 select value into v_match from jsonb_array_elements(p_state->'bracket'->'matches')
   where value->>'id'=v_submission.match_id;
 if v_match is null or v_match->>'state' is distinct from 'complete'
   or (v_match->>'winnerId')::uuid is null
   or (v_match->>'winnerId')::uuid not in (
     (v_match->'slots'->0->>'entrantId')::uuid,(v_match->'slots'->1->>'entrantId')::uuid)
   or (v_match->'score'->>'a')::integer not between 0 and 4
   or (v_match->'score'->>'b')::integer not between 0 and 4
   or (v_match->'score'->>'a')::integer is null or (v_match->'score'->>'b')::integer is null
   or (v_match->'score'->>'a')::integer=(v_match->'score'->>'b')::integer
   or ((v_match->>'winnerId')::uuid=(v_match->'slots'->0->>'entrantId')::uuid
     and (v_match->'score'->>'a')::integer<=(v_match->'score'->>'b')::integer)
   or ((v_match->>'winnerId')::uuid=(v_match->'slots'->1->>'entrantId')::uuid
     and (v_match->'score'->>'b')::integer<=(v_match->'score'->>'a')::integer) then
   raise exception 'invalid_review_result' using errcode='22023'; end if;
 if p_decision='accepted' and ((v_match->>'winnerId')::uuid is distinct from v_submission.winner_entry_id
   or (v_match->'score'->>'a')::integer is distinct from v_submission.score_a
   or (v_match->'score'->>'b')::integer is distinct from v_submission.score_b) then
   raise exception 'review_differs_from_submission' using errcode='22023'; end if;
 perform public.bkt_save_event_state(v_submission.event_id,p_expected_revision,p_state);
 update bkt_private.match_submissions set status=p_decision,reviewed_at=now(),reviewed_by=v_me where id=p_id;
 return public.bkt_read_event(v_submission.event_id);
end $$;

create or replace function public.bkt_read_event(p_event_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 if not bkt_private.can_read(p_event_id) then raise exception 'event_unavailable' using errcode='42501'; end if;
 -- Preserve the reviewed moderation scrub from 106 via the same projections.
 return jsonb_build_object(
 'event',(select bkt_private.admin_scrub_row('event',e.id,to_jsonb(e)) from public.bkt_events e where e.id=p_event_id),
 'entries',(select coalesce(jsonb_agg(bkt_private.admin_scrub_row('entry',en.id,to_jsonb(en)) order by en.registered_at,en.id),'[]') from public.bkt_entries en where en.event_id=p_event_id),
 'players',(select coalesce(jsonb_agg(bkt_private.admin_scrub_row('player',p.id,to_jsonb(p)) order by p.id),'[]') from public.bkt_players p where exists(select 1 from public.bkt_entries en where en.event_id=p_event_id and en.player_id=p.id) or exists(select 1 from public.bkt_orgs o join public.bkt_events e on e.org_id=o.id where e.id=p_event_id and o.owner_id=p.id)),
 'stations',(select coalesce(jsonb_agg(bkt_private.admin_scrub_row('station',s.id,to_jsonb(s)) order by s.number),'[]') from public.bkt_stations s where s.event_id=p_event_id),
 'orgs',(select coalesce(jsonb_agg(bkt_private.admin_scrub_row('org',o.id,to_jsonb(o))),'[]') from public.bkt_orgs o join public.bkt_events e on e.org_id=o.id where e.id=p_event_id),
 'brackets',(select coalesce(jsonb_agg(to_jsonb(b)),'[]') from public.bkt_brackets b where b.event_id=p_event_id and not bkt_private.content_is_held('bracket',b.event_id)),
 'results',(select coalesce(jsonb_agg(to_jsonb(r) order by r.reported_at,r.id),'[]') from public.bkt_results r where r.event_id=p_event_id and not r.superseded and r.moderation_state not in ('hidden','quarantined')),
 'match_submissions',(select coalesce(jsonb_agg(to_jsonb(s) order by s.submitted_at,s.id),'[]') from bkt_private.match_submissions s where s.event_id=p_event_id and (s.player_id=bkt_private.me() or bkt_private.is_staff((select org_id from public.bkt_events where id=p_event_id)))),
 'revision',(select revision from public.bkt_events where id=p_event_id));
end $$;

revoke all on function public.bkt_submit_match_result(uuid,uuid,text,bigint,uuid,integer,integer),
 public.bkt_review_match_result(uuid,bigint,jsonb,text) from public,anon,authenticated;
grant execute on function public.bkt_submit_match_result(uuid,uuid,text,bigint,uuid,integer,integer),
 public.bkt_review_match_result(uuid,bigint,jsonb,text) to authenticated;
commit;
