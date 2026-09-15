-- Category 1 — Anon Wheel
-- Tables live in schema category_one (folder in Supabase Table Editor).

create schema if not exists category_one;

grant usage on schema category_one to postgres, anon, authenticated, service_role;

create table if not exists category_one.rooms (
  code text primary key,
  host_id text not null,
  phase text not null default 'lobby',
  game jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists category_one.players (
  id text primary key,
  room_id text not null references category_one.rooms(code) on delete cascade,
  name text not null,
  answered int not null default 0,
  skips int not null default 0,
  kicked boolean not null default false,
  is_host boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists players_room_id_idx on category_one.players (room_id);

create table if not exists category_one.questions (
  id text primary key,
  room_id text not null references category_one.rooms(code) on delete cascade,
  question_text text not null,
  author_id text,
  author_name text,
  pot text not null default 'wheel' check (pot in ('wheel', 'finals')),
  status text not null default 'unanswered' check (status in ('unanswered', 'answered')),
  skip_count int not null default 0,
  answered_by_id text,
  answered_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists questions_room_status_idx
  on category_one.questions (room_id, status);

create table if not exists category_one.answered_questions (
  id uuid primary key default gen_random_uuid(),
  room_id text not null references category_one.rooms(code) on delete cascade,
  question_id text not null,
  question_text text not null,
  player_id text not null,
  player_name text not null,
  author_id text,
  author_name text,
  pot text not null default 'wheel' check (pot in ('wheel', 'finals')),
  outcome text not null default 'answered' check (outcome in ('answered', 'skipped')),
  returned_to_pool boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists answered_questions_room_id_idx
  on category_one.answered_questions (room_id);

alter table category_one.rooms enable row level security;
alter table category_one.players enable row level security;
alter table category_one.questions enable row level security;
alter table category_one.answered_questions enable row level security;

-- permissive party-game policies
drop policy if exists "Anyone can read rooms" on category_one.rooms;
drop policy if exists "Anyone can insert rooms" on category_one.rooms;
drop policy if exists "Anyone can update rooms" on category_one.rooms;
create policy "Anyone can read rooms" on category_one.rooms for select using (true);
create policy "Anyone can insert rooms" on category_one.rooms for insert with check (true);
create policy "Anyone can update rooms" on category_one.rooms for update using (true);

drop policy if exists "Anyone can read players" on category_one.players;
drop policy if exists "Anyone can insert players" on category_one.players;
drop policy if exists "Anyone can update players" on category_one.players;
drop policy if exists "Anyone can delete players" on category_one.players;
create policy "Anyone can read players" on category_one.players for select using (true);
create policy "Anyone can insert players" on category_one.players for insert with check (true);
create policy "Anyone can update players" on category_one.players for update using (true);
create policy "Anyone can delete players" on category_one.players for delete using (true);

drop policy if exists "Anyone can read questions" on category_one.questions;
drop policy if exists "Anyone can insert questions" on category_one.questions;
drop policy if exists "Anyone can update questions" on category_one.questions;
create policy "Anyone can read questions" on category_one.questions for select using (true);
create policy "Anyone can insert questions" on category_one.questions for insert with check (true);
create policy "Anyone can update questions" on category_one.questions for update using (true);

drop policy if exists "Anyone can read answered_questions" on category_one.answered_questions;
drop policy if exists "Anyone can insert answered_questions" on category_one.answered_questions;
create policy "Anyone can read answered_questions" on category_one.answered_questions for select using (true);
create policy "Anyone can insert answered_questions" on category_one.answered_questions for insert with check (true);

grant all on all tables in schema category_one to postgres, anon, authenticated, service_role;
grant all on all sequences in schema category_one to postgres, anon, authenticated, service_role;

comment on schema category_one is 'Category 1 — Anon Wheel party game tables';

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'category_one' and tablename = 'rooms'
  ) then
    alter publication supabase_realtime add table category_one.rooms;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'category_one' and tablename = 'players'
  ) then
    alter publication supabase_realtime add table category_one.players;
  end if;
end $$;
