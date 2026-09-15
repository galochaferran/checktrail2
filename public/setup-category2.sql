-- Category 2 — Mirror Vote (schema folder: category_two)
-- See also migrations applied via Supabase MCP.

create schema if not exists category_two;
comment on schema category_two is 'Category 2 — anonymous most-likely voting game';

grant usage on schema category_two to anon, authenticated, service_role;

create table if not exists category_two.rooms (
  code text primary key,
  host_id text not null,
  phase text not null default 'lobby' check (phase in ('lobby', 'playing', 'results')),
  question_count int not null default 20,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists category_two.players (
  id text primary key,
  room_id text not null references category_two.rooms(code) on delete cascade,
  name text not null,
  is_host boolean not null default false,
  question_order jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists category_two.question_bank (
  id text primary key,
  prompt text not null,
  trait_key text not null,
  trait_label text not null,
  body_part text not null default 'torso',
  sort_order int not null default 0
);

create table if not exists category_two.votes (
  id uuid primary key default gen_random_uuid(),
  room_id text not null references category_two.rooms(code) on delete cascade,
  question_id text not null references category_two.question_bank(id),
  voter_id text not null,
  nominee_id text not null,
  created_at timestamptz not null default now(),
  unique (room_id, question_id, voter_id)
);

alter table category_two.rooms enable row level security;
alter table category_two.players enable row level security;
alter table category_two.question_bank enable row level security;
alter table category_two.votes enable row level security;

grant all on all tables in schema category_two to anon, authenticated, service_role;
grant all on all sequences in schema category_two to anon, authenticated, service_role;
