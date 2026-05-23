# Revro Backend

Revro is an AI platform for Roblox and Discord creators. The backend powers
Supabase auth, Gemini/OpenAI generation, Roblox Studio plugin tasks, Discord
builder flows, Whop billing, Resend lifecycle emails, and AI Wallet usage
deduction.

## Billing Model

Plan entitlement and usage balance are separate:

- `plan` and `plan_source` control product access.
- `monthly_wallet_balance` is included plan wallet balance and resets each
  billing cycle.
- `extra_wallet_balance` is purchased top-up balance and does not expire.
- `wallet_spent` tracks lifetime wallet usage.
- `billing_cycle_end` controls the next included-wallet reset.
- Whop membership identity (`whop_user_id`, `whop_membership_id`,
  `whop_product_id`, `whop_plan_id`) links purchases to the Revro user record.

Wallet money must never upgrade a user's plan. Manual/admin balance edits only
change spend capacity, not entitlement. Whop webhooks must resolve a signed
checkout session or existing Whop membership link before applying a plan; raw
purchase email is not enough to assign entitlement.

## Plans

| Plan | Price | Included AI Wallet | Access |
|------|-------|--------------------|--------|
| Free | $0 | $0.50 one-time gift | Standard queue, 2,000 character prompts |
| Pro | $19/mo or $190/yr | $10 monthly or $120 annual upfront | Priority queue, 16,000 character prompts, VS Code/Cursor access, private projects |
| Dev | $49/mo or $490/yr | $30 monthly or $360 annual upfront | 64,000 character context, GitHub sync, multi-file debugging, file uploads, advanced Studio workflows |
| Studio | $129/mo or $1,290/yr | $85 monthly or $1,020 annual upfront | Team wallet for up to 5 developers, automation/playtest loops, highest priority, priority support |

Top-ups are `$5`, `$10`, `$25`, and `$50` AI Wallet purchases. Top-up balance
stacks forever, does not expire, and does not change plan tier.

Usage cost depends on provider, model, input tokens, output tokens, image cost,
file context cost, and automation. Server routes perform all wallet deductions;
client-side cost estimates are informational only.

## Core Systems

- Supabase Auth and user profile readback
- AI chat for Roblox scripts, UI, Discord planning, and image prompt refinement
- Gemini routing for low-cost/simple requests
- OpenAI/Codex routing for advanced Roblox coding tasks
- Roblox Studio plugin connection, task queue, polling, and result reporting
- Discord builder with safe-mode reuse/update behavior
- Whop webhooks for memberships and top-ups
- Resend lifecycle emails

## Environment

Production requires:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `OPENAI_API_KEY`
- `GEMINI_API_KEY`
- `WHOP_WEBHOOK_SECRET`
- Whop plan/product IDs for Pro, Dev, Studio, annual variants, and top-ups
- `RESEND_API_KEY`
- `CRON_SECRET`

Do not commit secret values.

## Database

Apply `ai-wallet-migration.sql` and `whop_identity_linking_migration.sql`
before deploying wallet-aware billing changes. The legacy credit columns may
remain for compatibility, but they are no longer the source of truth for
billing.

Important tables:

| Table | Purpose |
|-------|---------|
| `users` | User profiles, plan entitlement, AI Wallet balances |
| `api_keys` | Hashed plugin/API keys |
| `conversations` | Chat conversation metadata |
| `messages` | Chat messages |
| `usage_log` | Provider/model/token/cost analytics and wallet deductions |
| `whop_entitlements` | Linked or claimable Whop memberships/top-ups |
| `whop_checkout_sessions` | Signed checkout sessions that bind Whop purchases to `revro_user_id` |
| `roblox_connections` | Active Studio plugin sessions |
| `roblox_tasks` | Queued Studio plugin work |
| `discord_connections` | Discord user/bot connection data |

## Usage Logging

Generation routes should log non-secret analytics:

- `provider`
- `model`
- `inputTokens`
- `outputTokens`
- `imageCost`
- `fileContextCost`
- `estimatedRealUsdCost`
- `deductedWalletAmount`
- `userId`

Never log API keys, raw plugin keys, Supabase service keys, auth tokens, or
provider secrets.

## Development

```bash
npm install
npm run dev
npm run build
```

For production verification, check Vercel logs for `[AI route]`,
`[AI generation]`, `[AI Wallet]`, `[Plugin/status]`, `[Plugin/task]`,
`[Plugin/poll]`, and `[Conversations delete]`.
