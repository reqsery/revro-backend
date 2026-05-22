# Revro Backend

Revro uses Whop plan entitlements and an AI Wallet usage balance. `plan` and
`plan_source` control feature access; `monthly_wallet_balance` and
`extra_wallet_balance` control spend only. Apply `ai-wallet-migration.sql`
before deploying wallet-aware API changes.

AI-powered platform for Roblox and Discord creators. Generate scripts, UI elements, and Discord server setups with AI.

For support, updates, and early features, join the Discord: https://discord.gg/vV2USr9phF

---

## Features

- **AI Script Generation** — Generate Roblox Lua scripts using Claude AI
- **UI Creation** — Create Roblox UI elements with AI assistance
- **Discord Bot Setup** — Configure Discord servers with AI-powered tools
- **Credit System** — Usage-based pricing with multiple subscription tiers
- **API Key Authentication** — Secure API key system for plugin integration
- **Email Notifications** — Automated emails for signup, low credits, and usage reports

---

## Tech Stack

- **Framework:** Next.js 14 (App Router)
- **Language:** TypeScript
- **Database:** Supabase (PostgreSQL)
- **Authentication:** Supabase Auth
- **AI:** Anthropic Claude API (Sonnet 4.5, 4.6, Opus 4.6)
- **Email:** Resend
- **Payments:** LemonSqueezy or Stripe (both webhook handlers included — use either or both)
- **Hosting:** Vercel
- **Monitoring:** Sentry (optional)

---

## Prerequisites

- Node.js 18+ and npm
- Supabase account
- Anthropic API key
- Resend API key
- Stripe account (test mode)
- Vercel account (for deployment)

---

## Environment Variables

Create a `.env.local` file in the root directory:

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your_supabase_service_role_key

# Anthropic Claude
CLAUDE_API_KEY=sk-ant-your_key_here

# OpenAI
OPENAI_API_KEY=sk-your_key_here

# Resend Email
RESEND_API_KEY=re_your_key_here

# Environment
NODE_ENV=production

# Payments — LemonSqueezy (use if paying with LemonSqueezy)
LEMONSQUEEZY_WEBHOOK_SECRET=your_lemonsqueezy_webhook_secret

# Payments — Stripe (use if paying with Stripe)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
# Map your Stripe Price IDs to plans (create these in the Stripe dashboard)
STRIPE_PRICE_STARTER=price_...
STRIPE_PRICE_STARTER_ANNUAL=price_...
STRIPE_PRICE_PRO=price_...
STRIPE_PRICE_PRO_ANNUAL=price_...
STRIPE_PRICE_STUDIO=price_...
STRIPE_PRICE_STUDIO_ANNUAL=price_...

# Sentry (optional)
NEXT_PUBLIC_SENTRY_DSN=your_sentry_dsn

# App URL
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

See `.env.example` for a complete list with descriptions.

---

## Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/reqsery/revro-backend.git
cd revro-backend
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set up environment variables

```bash
cp .env.example .env.local
# Edit .env.local with your actual values
```

### 4. Set up Supabase database

Go to your Supabase project and run the SQL migrations in `/database/schema.sql`.

### 5. Run development server

```bash
npm run dev
```

The API will be available at http://localhost:3000

---

## Database Schema

| Table | Purpose |
|-------|---------|
| `users` | User accounts and subscription info |
| `api_keys` | User API keys for plugin authentication |
| `conversations` | AI chat conversation history |
| `messages` | Individual messages in conversations |
| `usage_log` | Track API usage and credit consumption |
| `discord_connections` | Discord bot connections |
| `roblox_connections` | Roblox plugin connections |
| `user_settings` | User preferences |

Row Level Security (RLS) is enabled on all tables. The service role has full access; authenticated users can only access their own data.

---

## API Endpoints

See [API-DOCS.md](./API-DOCS.md) for complete endpoint documentation.

### Authentication
- `POST /api/auth/signup` — Create new account
- `POST /api/auth/login` — Login to existing account

### User Management
- `GET /api/user/me` — Get current user info
- `GET /api/user/usage` — Get usage statistics

### AI Chat
- `POST /api/chat/roblox` — Generate Roblox scripts/UI
- `POST /api/chat/discord` — Generate Discord configs
- `GET /api/chat/conversations` — Get conversation history

### Example Request

```bash
curl -H "x-api-key: your_api_key_here" \
  -H "Content-Type: application/json" \
  -d '{"message": "Create a kill brick script"}' \
  https://your-backend-url.vercel.app/api/chat/roblox
```

---

**Webhooks:**
- `POST /api/webhooks/lemonsqueezy` — LemonSqueezy subscription lifecycle events
- `POST /api/webhooks/stripe` — Stripe subscription lifecycle events

## Authentication

Revro uses two authentication methods:

### 1. Supabase Auth (Web Dashboard)
JWT tokens for web-based authentication. Users sign up with email/password or Google OAuth.

### 2. API Keys (Roblox Studio Plugin)
Secure API keys for plugin authentication. Each user gets an API key on signup.

**Include API key in requests:**
```bash
curl -H "x-api-key: your_api_key_here" \
  https://your-backend-url.vercel.app/api/user/me
```

---

## Credit System

| Plan | Price | Credits/Month | AI Model | Images |
|------|-------|---------------|----------|--------|
| Free | $0 | 25 | Sonnet 4.5 | 0 |
| Starter | $10/mo ($9/yr) | 150 | Sonnet 4.6 | 0 |
| Pro | $20/mo ($17/yr) | 500 | Opus 4.6 | 50 |
| Studio | $50/mo ($42/yr) | 1500 | Opus 4.6 | 150 |

### Credit Costs
- Simple script: 2-5 credits
- Medium script: 5-10 credits
- Complex system: 10-15 credits
- UI element: 5-15 credits
- Image generation: 5 credits

---

## Email Templates

Automated emails are sent for:

- **Welcome** — Account creation with API key
- **Email Verification** — Verify email address
- **Password Reset** — Secure password reset link
- **Low Credits** — Warning when < 20% credits remain
- **Monthly Usage** — End-of-month usage summary
- **Payment Confirmation** — Receipt after purchase
- **Subscription Cancelled** — Cancellation confirmation

---

## Deployment

### Deploy to Vercel (Recommended)

1. **Sign in to Vercel**
   - Go to [vercel.com](https://vercel.com)
   - Sign in with GitHub

2. **Import Project**
   - Click "Add New..." → "Project"
   - Select `revro-backend` from your repositories
   - Click Import

3. **Configure**
   - Framework Preset: Next.js (auto-detected)
   - Root Directory: `.` (leave as-is)
   - Build Command: `npm run build` (auto-filled)
   - Output Directory: `.next` (auto-filled)

4. **Add Environment Variables**
   - Click "Environment Variables"
   - Add all variables from `.env.example` file
   - Required variables: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `RESEND_API_KEY`, `NODE_ENV`
   - Optional now (add later): `CLAUDE_API_KEY`, `OPENAI_API_KEY`, `STRIPE_SECRET_KEY`
   - Make sure both `SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_URL` are set to the same value

5. **Deploy**
   - Click Deploy
   - Wait 3-5 minutes
   - Your backend will be live at `https://your-project.vercel.app`

6. **Auto-Deploy**
   - Vercel automatically deploys on every push to `main`
   - No additional configuration needed

---

## Testing

### Test Signup
```bash
curl -X POST http://localhost:3000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "testpass123",
    "displayName": "Test User"
  }'
```

### Test with API Key
```bash
curl -H "x-api-key: your_api_key" \
  http://localhost:3000/api/user/me
```

### Test AI Generation
```bash
curl -X POST http://localhost:3000/api/chat/roblox \
  -H "x-api-key: your_api_key" \
  -H "Content-Type: application/json" \
  -d '{"message": "Create a simple part that changes color"}'
```

---

## Project Structure

```
revro-backend/
├── app/
<<<<<<< HEAD
│   ├── api/
│   │   ├── auth/           # Authentication endpoints
│   │   ├── chat/           # AI chat endpoints
│   │   ├── plugin/         # Plugin communication
│   │   └── user/           # User management
│   ├── layout.tsx          # Root layout
│   └── global-error.tsx    # Global error handler
=======
│  ├── api/
│  │  ├── auth/      # Authentication endpoints
│  │  ├── chat/      # AI chat endpoints
│  │  ├── plugin/    # Plugin communication
│  │  ├── user/      # User management
│  │  └── webhooks/
│  │     ├── lemonsqueezy/  # LemonSqueezy subscription webhooks
│  │     └── stripe/        # Stripe subscription webhooks
│  └── layout.tsx
>>>>>>> 4ca6d8b (feat: add LemonSqueezy and Stripe webhook handlers)
├── lib/
│   ├── supabase.ts         # Supabase client configuration
│   ├── claude.ts           # Claude AI integration
│   ├── credits.ts          # Credit system logic
│   ├── email.ts            # Email templates & sending
│   └── auth.ts             # Auth middleware
├── .env.example            # Environment variables template
├── next.config.js          # Next.js configuration
├── package.json            # Dependencies
├── tsconfig.json           # TypeScript configuration
└── README.md               # This file
```

---

## Troubleshooting

See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for common issues and solutions.

**Quick Fixes:**
- **Build errors:** Check all env vars are set, especially both Supabase URL versions
- **Unauthorized errors:** Verify `SUPABASE_SERVICE_KEY` is correct
- **Email not sending:** Check `RESEND_API_KEY` and verify sender domain
- **Module not found:** Run `npm install` and ensure path aliases are configured

---

## Contributing

This is a proprietary project, but bug reports and suggestions are welcome.

1. Join our [Discord](https://discord.gg/vV2USr9phF)
2. Report issues on GitHub
3. Email support@revro.dev

---

## License

MIT License - see [LICENSE](./LICENSE) for details.

---

## Links

- **Website:** https://revro.dev
- **Support:** support@revro.dev
- **Discord:** https://discord.gg/vV2USr9phF
- **Twitter:** [@RevroDev](https://twitter.com/RevroDev)

---

**Built with care for Roblox and Discord creators**

*Last updated: April 2026*
