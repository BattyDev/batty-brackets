begin;
do $$ begin
 if current_setting('bkt.staging',true) is distinct from 'on' then raise exception 'Staging session required'; end if;
end $$;

-- Anonymous Supabase users have the authenticated Postgres role. Read the
-- signed JWT claim, never editable user metadata, when separating guests from
-- durable accounts for privileged commands.
create function bkt_private.is_anonymous_user() returns boolean
language sql stable security definer set search_path=pg_catalog as $$
 select coalesce((auth.jwt()->>'is_anonymous')::boolean,false)
$$;

create function bkt_private.reject_anonymous_org_owner() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
 if bkt_private.is_anonymous_user() then
   raise exception 'account_upgrade_required' using errcode='42501';
 end if;
 return new;
end $$;

create trigger bkt_orgs_durable_owner
before insert or update of owner_id on public.bkt_orgs
for each row execute function bkt_private.reject_anonymous_org_owner();

create function public.bkt_sign_document(
 p_event_id uuid,p_document_id text,p_document_version integer,p_typed_name text
) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare
 v_me uuid:=bkt_private.require_me();
 v_event public.bkt_events%rowtype;
 v_entry public.bkt_entries%rowtype;
 v_changed boolean:=false;
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
 select * into v_entry from public.bkt_entries
 where event_id=p_event_id and player_id=v_me for update;
 if not found then raise exception 'entry_required' using errcode='42501'; end if;

 insert into bkt_private.signatures(entry_id,event_id,player_id,document_id,document_version,typed_name)
 values(v_entry.id,p_event_id,v_me,p_document_id,p_document_version,trim(p_typed_name))
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
 return jsonb_build_object('entry',to_jsonb(v_entry),'changed',v_changed);
end $$;

-- A player may check in only their own non-waitlisted entry. Required document
-- signatures remain private and are validated entirely on the server.
create function public.bkt_self_check_in(p_event_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare
 v_me uuid:=bkt_private.require_me();
 v_event public.bkt_events%rowtype;
 v_entry public.bkt_entries%rowtype;
 v_missing boolean;
 v_changed boolean:=false;
begin
 select * into v_event from public.bkt_events where id=p_event_id for update;
 if not found or not bkt_private.can_read(p_event_id) then
   raise exception 'event_unavailable' using errcode='42501';
 end if;
 if v_event.status<>'checkin' then raise exception 'checkin_closed' using errcode='55000'; end if;

 select * into v_entry from public.bkt_entries
 where event_id=p_event_id and player_id=v_me for update;
 if not found then raise exception 'entry_required' using errcode='42501'; end if;
 if v_entry.waitlisted then raise exception 'waitlisted' using errcode='55000'; end if;

 select exists(
   select 1 from jsonb_array_elements(v_event.documents) d
   where coalesce((d->>'required')::boolean,false)
     and not exists(
       select 1 from bkt_private.signatures s
       where s.entry_id=v_entry.id and s.event_id=p_event_id and s.player_id=v_me
         and s.document_id=d->>'id'
         and s.document_version=coalesce((d->>'version')::integer,1)
     )
 ) into v_missing;
 if v_missing then raise exception 'required_documents_incomplete' using errcode='55000'; end if;

 if v_entry.checked_in_at is null then
   update public.bkt_entries set checked_in_at=now() where id=v_entry.id returning * into v_entry;
   update public.bkt_events set revision=revision+1 where id=p_event_id;
   v_changed:=true;
 end if;
 return jsonb_build_object('entry',to_jsonb(v_entry),'changed',v_changed);
end $$;

revoke all on function bkt_private.is_anonymous_user(),bkt_private.reject_anonymous_org_owner() from public,anon,authenticated;
revoke all on function public.bkt_sign_document(uuid,text,integer,text),public.bkt_self_check_in(uuid) from public,anon,authenticated;
grant execute on function public.bkt_sign_document(uuid,text,integer,text),public.bkt_self_check_in(uuid) to authenticated;
commit;
