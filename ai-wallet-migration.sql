-- Separate Revro plan entitlements from spendable AI Wallet balance.
alter table public.users
  add column if not exists monthly_wallet_balance numeric(12,6) not null default 0,
  add column if not exists extra_wallet_balance numeric(12,6) not null default 0,
  add column if not exists wallet_spent numeric(12,6) not null default 0,
  add column if not exists plan_source text not null default 'legacy',
  add column if not exists billing_cycle_end timestamp without time zone;

alter table public.users drop constraint if exists users_plan_check;
alter table public.users
  add constraint users_plan_check
  check (plan = any (array['free'::text, 'starter'::text, 'pro'::text, 'dev'::text, 'studio'::text]));

update public.users
set
  plan = case when plan = 'starter' then 'dev' else plan end,
  monthly_wallet_balance = case
    when monthly_wallet_balance > 0 then monthly_wallet_balance
    when plan = 'free' then 0.5
    when plan = 'pro' then 10
    when plan in ('starter', 'dev') then 30
    when plan = 'studio' then 85
    else 0
  end,
  extra_wallet_balance = coalesce(extra_wallet_balance, 0),
  wallet_spent = coalesce(wallet_spent, 0),
  plan_source = coalesce(nullif(plan_source, ''), 'legacy'),
  billing_cycle_end = coalesce(
    billing_cycle_end,
    case
      when plan = 'free' then null
      else billing_cycle_start + interval '1 month'
    end
  );

comment on column public.users.monthly_wallet_balance is
  'Remaining included AI Wallet USD for the current plan billing cycle.';
comment on column public.users.extra_wallet_balance is
  'Remaining purchased AI Wallet USD. Top-ups stack and do not expire.';
comment on column public.users.wallet_spent is
  'Cumulative deducted AI Wallet USD for analytics and support.';
comment on column public.users.plan_source is
  'Source of entitlement such as whop, signup, manual, or legacy.';
