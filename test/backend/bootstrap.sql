\set ON_ERROR_STOP on
-- Disposable local PostgreSQL only. Never run this against Supabase: real
-- Supabase supplies its own roles/auth.uid/auth.users and verifies JWTs upstream.
create role anon nologin;
create role authenticated nologin;
create schema auth;
create schema extensions;
create extension pgcrypto with schema extensions;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
 select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
/* Minimal local stand-in for Supabase's Auth JWT helper.  The admin migration
   reads only the issuer-controlled top-level `aal` claim; user_metadata is
   included here solely so tests can prove it is not an authorization source. */
create function auth.jwt() returns jsonb language sql stable as $$
 select jsonb_build_object(
   'sub',nullif(current_setting('request.jwt.claim.sub',true),''),
   'aal',coalesce(
     nullif(current_setting('request.jwt.claim.aal',true),''),
     (nullif(current_setting('request.jwt.claims',true),'')::jsonb)->>'aal',
     'aal1'
   ),
   'is_anonymous',coalesce(nullif(current_setting('request.jwt.claim.is_anonymous',true),''),'false')::boolean,
   'user_metadata',coalesce(nullif(current_setting('request.jwt.claim.user_metadata',true),''),'{}')::jsonb,
   'app_metadata',coalesce(nullif(current_setting('request.jwt.claim.app_metadata',true),''),'{}')::jsonb
 )
$$;
grant usage on schema auth to anon,authenticated;
grant execute on function auth.uid() to anon,authenticated;
grant execute on function auth.jwt() to anon,authenticated;
-- Simulate permissive Supabase defaults to prove migrations remove them.
alter default privileges in schema public grant all on tables to anon,authenticated;
