-- Baxberi managed PostgreSQL schema. Run once in Supabase SQL Editor.
create table if not exists public.users (
  username text primary key check (username ~ '^[a-z0-9_]{3,20}$'),
  data jsonb not null,
  created_at timestamptz not null default now()
);
create table if not exists public.sessions (
  token_hash text primary key check (length(token_hash) = 64),
  username text not null references public.users(username) on delete cascade,
  expires_at bigint not null
);
create index if not exists sessions_expiry_idx on public.sessions(expires_at);
create table if not exists public.follows (
  follower text not null references public.users(username) on delete cascade,
  following text not null references public.users(username) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower, following),
  check (follower <> following)
);
create index if not exists follows_target_idx on public.follows(following);
create table if not exists public.visitors (
  profile_username text not null references public.users(username) on delete cascade,
  visitor_username text not null references public.users(username) on delete cascade,
  visited_at bigint not null,
  primary key (profile_username, visitor_username),
  check (profile_username <> visitor_username)
);
create index if not exists visitors_recent_idx on public.visitors(profile_username, visited_at desc);
create table if not exists public.gifts (
  id bigint generated always as identity primary key,
  sender text not null references public.users(username) on delete cascade,
  recipient text not null references public.users(username) on delete cascade,
  gift text not null check (length(gift) <= 8),
  created_at bigint not null
);
create index if not exists gifts_recipient_idx on public.gifts(recipient, id desc);
create index if not exists gifts_sender_idx on public.gifts(sender, id desc);
create table if not exists public.reactions (
  id bigint generated always as identity primary key,
  sender text not null references public.users(username) on delete cascade,
  recipient text not null references public.users(username) on delete cascade,
  emoji text not null check (emoji in ('❤️','😂','👏','🔥','😍')),
  created_at bigint not null
);
create index if not exists reactions_recipient_idx on public.reactions(recipient, id desc);
create table if not exists public.chats (
  id bigint generated always as identity primary key,
  channel text not null references public.users(username) on delete cascade,
  sender text not null references public.users(username) on delete cascade,
  text varchar(200) not null,
  created_at bigint not null
);
create index if not exists chats_history_idx on public.chats(channel, id desc);

create or replace function public.trim_chat_history(p_channel text)
returns void language sql security definer set search_path = public as $$
  delete from public.chats c
  where c.channel = p_channel
    and c.id not in (select id from public.chats where channel = p_channel order by id desc limit 100);
$$;

-- Only the server's service role may access user/session data. Never put the
-- service role key in browser code or commit it to the repository.
alter table public.users enable row level security;
alter table public.sessions enable row level security;
alter table public.follows enable row level security;
alter table public.visitors enable row level security;
alter table public.gifts enable row level security;
alter table public.reactions enable row level security;
alter table public.chats enable row level security;
revoke all on public.users, public.sessions, public.follows, public.visitors,
  public.gifts, public.reactions, public.chats from anon, authenticated;
grant all on public.users, public.sessions, public.follows, public.visitors,
  public.gifts, public.reactions, public.chats to service_role;
grant usage, select on all sequences in schema public to service_role;
revoke all on function public.trim_chat_history(text) from public, anon, authenticated;
grant execute on function public.trim_chat_history(text) to service_role;
