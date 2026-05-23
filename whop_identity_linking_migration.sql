-- Whop purchases must attach to Revro account identity, not billing email.
alter table public.users
  add column if not exists whop_user_id text,
  add column if not exists whop_membership_id text,
  add column if not exists whop_product_id text,
  add column if not exists whop_plan_id text;

create index if not exists users_whop_user_id_idx on public.users(whop_user_id);
create index if not exists users_whop_membership_id_idx on public.users(whop_membership_id);

create table if not exists public.whop_entitlements (
  id uuid primary key default gen_random_uuid(),
  revro_user_id uuid references public.users(id) on delete set null,
  whop_user_id text,
  whop_membership_id text,
  whop_product_id text,
  whop_plan_id text,
  plan text,
  interval text,
  wallet_topup_amount numeric(12,6),
  status text not null default 'pending',
  source text not null default 'webhook',
  last_event_action text,
  last_payload jsonb,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create unique index if not exists whop_entitlements_membership_unique
  on public.whop_entitlements(whop_membership_id)
  where whop_membership_id is not null;
create index if not exists whop_entitlements_revro_user_idx on public.whop_entitlements(revro_user_id);
create index if not exists whop_entitlements_whop_user_idx on public.whop_entitlements(whop_user_id);

create table if not exists public.whop_checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  revro_user_id uuid not null references public.users(id) on delete cascade,
  checkout_token_hash text not null unique,
  expected_plan text,
  expected_product_id text not null,
  expected_plan_id text,
  expected_wallet_topup numeric(12,6),
  whop_user_id text,
  status text not null default 'pending',
  expires_at timestamp with time zone not null,
  claimed_at timestamp with time zone,
  created_at timestamp with time zone not null default now()
);

create index if not exists whop_checkout_sessions_user_idx on public.whop_checkout_sessions(revro_user_id);
create index if not exists whop_checkout_sessions_status_idx on public.whop_checkout_sessions(status);

alter table public.whop_entitlements enable row level security;
alter table public.whop_checkout_sessions enable row level security;

drop policy if exists "Users can read own Whop entitlements" on public.whop_entitlements;
create policy "Users can read own Whop entitlements"
  on public.whop_entitlements
  for select
  to authenticated
  using (auth.uid() = revro_user_id);

drop policy if exists "Users can read own Whop checkout sessions" on public.whop_checkout_sessions;
create policy "Users can read own Whop checkout sessions"
  on public.whop_checkout_sessions
  for select
  to authenticated
  using (auth.uid() = revro_user_id);

comment on table public.whop_entitlements is
  'Whop membership/product records linked to Revro users. Unlinked records are claim/relink candidates and must not be matched by email.';
comment on table public.whop_checkout_sessions is
  'Signed Revro checkout sessions used to bind Whop webhooks to revro_user_id.';

