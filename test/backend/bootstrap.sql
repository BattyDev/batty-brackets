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
create function auth.jwt() returns jsonb language sql stable as $$
 select jsonb_build_object(
   'sub',nullif(current_setting('request.jwt.claim.sub',true),''),
   'is_anonymous',coalesce(nullif(current_setting('request.jwt.claim.is_anonymous',true),''),'false')::boolean,
   'user_metadata','{}'::jsonb,'app_metadata','{}'::jsonb)
$$;
grant usage on schema auth to anon,authenticated;
grant execute on function auth.uid() to anon,authenticated;
grant execute on function auth.jwt() to anon,authenticated;
-- Simulate permissive Supabase defaults to prove migrations remove them.
alter default privileges in schema public grant all on tables to anon,authenticated;
