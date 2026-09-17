begin;
do $$ begin
 if current_setting('bkt.staging',true) is distinct from 'on' then raise exception 'Staging session required'; end if;
end $$;

-- The private schema is already hidden and has every client grant revoked.
-- RLS with no policies is a second barrier if that schema is ever exposed by
-- project configuration by mistake. Trusted SECURITY DEFINER commands retain
-- access as the migration owner.
alter table bkt_private.identities enable row level security;
alter table bkt_private.staff enable row level security;
alter table bkt_private.contacts enable row level security;
alter table bkt_private.create_requests enable row level security;
alter table bkt_private.invites enable row level security;
alter table bkt_private.readers enable row level security;
alter table bkt_private.claims enable row level security;
alter table bkt_private.attempts enable row level security;
alter table bkt_private.signatures enable row level security;

create index bkt_staff_player on bkt_private.staff(player_id);
create index bkt_create_requests_actor on bkt_private.create_requests(actor);
create index bkt_invites_event on bkt_private.invites(event_id);
create index bkt_readers_player on bkt_private.readers(player_id);
create index bkt_claims_event on bkt_private.claims(event_id);
create index bkt_claims_consumed_by on bkt_private.claims(consumed_by) where consumed_by is not null;
create index bkt_signatures_entry_event_player on bkt_private.signatures(entry_id,event_id,player_id);
create index bkt_orgs_owner on public.bkt_orgs(owner_id);
create index bkt_events_org on public.bkt_events(org_id);
create index bkt_results_reported_by on public.bkt_results(reported_by) where reported_by is not null;
commit;
