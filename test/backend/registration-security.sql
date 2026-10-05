-- Disposable live or staging boundary check. All fixture rows roll back.
begin;
do $$
<<registration_security>>
declare host_user uuid:=gen_random_uuid(); player_user uuid:=gen_random_uuid(); other_user uuid:=gen_random_uuid();
 event_id uuid:=gen_random_uuid(); host_id uuid; player_id uuid; entry_id uuid; other_entry uuid;
 bundle jsonb; entry jsonb; rejected boolean; revision bigint;
begin
 insert into auth.users(id) values(host_user),(player_user),(other_user);
 perform set_config('request.jwt.claim.sub',host_user::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',host_user,'role','authenticated','is_anonymous',false)::text,true);
 execute 'set local role authenticated';
 host_id:=(public.bkt_identity('UX host')->>'id')::uuid;
 bundle:=public.bkt_create_event(event_id,jsonb_build_object('org_name','UX fixtures','name','UX disposable test','game_id','sf6',
   'capacity',2,'entry_fee',10.50,'currency','USD','documents',jsonb_build_array(jsonb_build_object('id','conduct','title','Conduct','body','Respect the room.','required',true,'version',1))));
 if (bundle->'event'->>'entry_fee')::numeric<>10.50 then raise exception 'Fee was not preserved'; end if;
 rejected:=false;
 begin perform public.bkt_create_event(gen_random_uuid(),jsonb_build_object('org_name','UX fixtures','name','Empty document','game_id','sf6','capacity',2,
   'documents',jsonb_build_array(jsonb_build_object('id','empty','title','Empty','version',1,'required',true))));
 exception when invalid_parameter_value then rejected:=true; end;
 if not rejected then raise exception 'Empty document was accepted'; end if;

 perform set_config('request.jwt.claim.sub',player_user::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',player_user,'role','authenticated','is_anonymous',true)::text,true);
 player_id:=(public.bkt_identity('UX player')->>'id')::uuid;
 entry:=public.bkt_join_event(event_id,null,false); entry_id:=(entry->>'id')::uuid;
 perform public.bkt_sign_document(event_id,'conduct',1,'UX player');
 rejected:=false;
 begin perform public.bkt_record_payment(entry_id,10.50,10.50,'forged',1);
 exception when insufficient_privilege then rejected:=true; end;
 if not rejected then raise exception 'Player forged payment'; end if;

 perform set_config('request.jwt.claim.sub',other_user::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',other_user,'role','authenticated','is_anonymous',true)::text,true);
 perform public.bkt_identity('UX other');
 other_entry:=(public.bkt_join_event(event_id,null,false)->>'id')::uuid;

 perform set_config('request.jwt.claim.sub',host_user::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',host_user,'role','authenticated','is_anonymous',false)::text,true);
 revision:=(public.bkt_read_event(event_id)->>'revision')::bigint;
 bundle:=public.bkt_record_payment(entry_id,11.50,5.25,'Cash',revision);
 if (bundle->'entry'->>'amount_paid')::numeric<>5.25 or bundle->'entry'->>'paid_at' is not null then raise exception 'Partial payment is incorrect'; end if;
 rejected:=false;
 begin perform public.bkt_record_payment(entry_id,11.50,11.50,'stale',revision);
 exception when serialization_failure then rejected:=true; end;
 if not rejected then raise exception 'Stale payment overwrote the ledger'; end if;
 rejected:=false;
 begin perform public.bkt_record_payment(entry_id,11.501,5.25,'invalid',(bundle->>'revision')::bigint);
 exception when invalid_parameter_value then rejected:=true; end;
 if not rejected then raise exception 'Sub-cent charge was accepted'; end if;

 perform set_config('request.jwt.claim.sub',other_user::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',other_user,'role','authenticated','is_anonymous',true)::text,true);
 bundle:=public.bkt_read_event(event_id);
 select value into entry from jsonb_array_elements(bundle->'entries') where value->>'id'=entry_id::text;
 if entry ? 'amount_paid' or entry ? 'payment_note' then raise exception 'Another player can read private payment details'; end if;
 execute 'reset role';
 if has_table_privilege('authenticated','bkt_private.entry_payments','SELECT') or has_function_privilege('anon','public.bkt_record_payment(uuid,numeric,numeric,text,bigint)','EXECUTE') then raise exception 'Payment privileges expanded'; end if;
 if not exists(select 1 from bkt_private.signatures s where s.entry_id=registration_security.entry_id and s.document_body='Respect the room.') then raise exception 'Signed content was not retained'; end if;
 update public.bkt_events set status='running',documents='[{"id":"conduct","title":"Conduct","body":"Respect the room and follow station calls.","required":true,"version":1}]' where id=event_id;
 if (select (documents->0->>'version')::integer from public.bkt_events where id=event_id)<>2 then raise exception 'Changed text did not advance its version'; end if;

 perform set_config('request.jwt.claim.sub',player_user::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',player_user,'role','authenticated','is_anonymous',true)::text,true);
 execute 'set local role authenticated';
 bundle:=public.bkt_read_event(event_id);
 select value into entry from jsonb_array_elements(bundle->'entries') where value->>'id'=entry_id::text;
 if entry->'signed_documents' @> '["conduct"]'::jsonb then raise exception 'Old signature counted for changed text'; end if;
 if (entry->>'amount_paid')::numeric<>5.25 then raise exception 'Player cannot read own payment'; end if;
 rejected:=false;
 begin perform public.bkt_sign_document(event_id,'conduct',1,'UX player'); exception when invalid_parameter_value then rejected:=true; end;
 if not rejected then raise exception 'Obsolete document was signed'; end if;
 perform public.bkt_sign_document(event_id,'conduct',2,'UX player');
 execute 'reset role';
end $$;
rollback;
