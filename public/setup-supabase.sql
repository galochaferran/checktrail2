-- Anon Wheel: rooms isolate games; players belong to one room only.
-- Applied via Supabase migration; kept here for reference / re-runs.

create table if not exists public.rooms (
  code text primary key,
  host_id text not null,
  phase text not null default 'lobby',
  game jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.players (
  id text primary key,
  room_id text not null references public.rooms(code) on delete cascade,
  name text not null,
  answered int not null default 0,
  skips int not null default 0,
  kicked boolean not null default false,
  is_host boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists players_room_id_idx on public.players (room_id);

alter table public.rooms enable row level security;
alter table public.players enable row level security;

drop policy if exists "Anyone can read rooms" on public.rooms;
drop policy if exists "Anyone can insert rooms" on public.rooms;
drop policy if exists "Anyone can update rooms" on public.rooms;
drop policy if exists "Anyone can read players" on public.players;
drop policy if exists "Anyone can insert players" on public.players;
drop policy if exists "Anyone can update players" on public.players;
drop policy if exists "Anyone can delete players" on public.players;

create policy "Anyone can read rooms" on public.rooms for select using (true);
create policy "Anyone can insert rooms" on public.rooms for insert with check (true);
create policy "Anyone can update rooms" on public.rooms for update using (true);

create policy "Anyone can read players" on public.players for select using (true);
create policy "Anyone can insert players" on public.players for insert with check (true);
create policy "Anyone can update players" on public.players for update using (true);
create policy "Anyone can delete players" on public.players for delete using (true);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'rooms'
  ) then
    alter publication supabase_realtime add table public.rooms;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'players'
  ) then
    alter publication supabase_realtime add table public.players;
  end if;
end $$;
