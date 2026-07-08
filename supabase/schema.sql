create extension if not exists pgcrypto;

create table if not exists public.feed_runs (
  id uuid primary key default gen_random_uuid(),
  generated_at timestamptz not null default now(),
  mode jsonb not null default '{}'::jsonb,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.feed_runs enable row level security;

drop policy if exists "Authenticated users can read feed runs" on public.feed_runs;
create policy "Authenticated users can read feed runs"
  on public.feed_runs
  for select
  to authenticated
  using (true);

create index if not exists feed_runs_created_at_idx
  on public.feed_runs (created_at desc);

create table if not exists public.saved_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  post_key text not null,
  kind text not null check (kind in ('like', 'bookmark')),
  source_id text,
  source_name text,
  article_url text not null,
  article_title text,
  article_snapshot jsonb not null default '{}'::jsonb,
  comment_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, post_key, kind)
);

alter table public.saved_posts enable row level security;

drop policy if exists "Users can read their saved posts" on public.saved_posts;
create policy "Users can read their saved posts"
  on public.saved_posts
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their saved posts" on public.saved_posts;
create policy "Users can insert their saved posts"
  on public.saved_posts
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their saved posts" on public.saved_posts;
create policy "Users can update their saved posts"
  on public.saved_posts
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their saved posts" on public.saved_posts;
create policy "Users can delete their saved posts"
  on public.saved_posts
  for delete
  to authenticated
  using (auth.uid() = user_id);

create index if not exists saved_posts_user_kind_created_at_idx
  on public.saved_posts (user_id, kind, created_at desc);

create or replace function public.set_saved_posts_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_saved_posts_updated_at on public.saved_posts;
create trigger set_saved_posts_updated_at
  before update on public.saved_posts
  for each row
  execute function public.set_saved_posts_updated_at();
