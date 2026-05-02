## License

This project is open source. Feel free to use, modify, and learn from the code.

Note: This is the backend API only. The full Revro platform is available at https://revro.dev

# Revro Backend

AI-powered platform for Roblox and Discord creators. Generate scripts, UI elements, and Discord server setups with AI.

For support, updates, and early features, join the Discord:
https:/discord.gg/vV2USr9phF
## Features

- **AI Script Generation** — Generate Roblox Lua scripts using Claude AI
- **UI Creation** — Create Roblox UI elements with AI assistance
- **Discord Bot Setup** — Configure Discord servers with AI-powered tools
- **Roblox Studio Plugin** — Direct integration with Studio via plugin server
- **Credit System** — Usage-based pricing with multiple subscription tiers
- **API Key Authentication** — Secure API key system for plugin integration
- **Email Notifications** — Automated emails for signup, low credits, and usage reports

## ️ Tech Stack

- **Framework:** Next.js 14 (App Router)
- **Language:** TypeScript
- **Database:** Supabase (PostgreSQL)
- **Authentication:** Supabase Auth
- **AI:** Anthropic Claude API (Sonnet 4.5, 4.6, Opus 4.6)
- **Email:** Resend
- **Hosting:** Vercel
- **Plugin Server:** Node.js (deployed on Render)

## Prerequisites

- Node.js 18+ and npm
- Supabase account
- Anthropic API key
- Resend API key
- Vercel account (for deployment)

## Environment Variables

Create a `.env.local` file in the root directory:

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key

# Anthropic
CLAUDE_API_KEY=your_anthropic_api_key

# Resend
RESEND_API_KEY=your_resend_api_key

# Plugin Server
PLUGIN_SERVER_URL=your_railway_plugin_server_url
PLUGIN_SHARED_SECRET=your_64_char_hex_secret

# Sentry (optional)
NEXT_PUBLIC_SENTRY_DSN=your_sentry_dsn

# App
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

## Installation

1. Clone the repository

```bash
git clone https://gitlab.com/revro1/revro-backend.git
cd revro-backend/revro-nextjs-backend
```

2. Install dependencies

```bash
npm install
```

3. Set up environment variables

```bash
cp .env.example .env.local
# Edit .env.local with your actual values
```

4. Set up Supabase database — go to your Supabase project and run the SQL migrations in `/database/schema.sql`, or manually create tables (see SETUP-GUIDE.md).

5. Run the development server

```bash
npm run dev
```

The API will be available at `http://localhost:3000`.

## ️ Database Schema

### Tables

| Table | Purpose |
|---|---|
| `users` | User accounts and subscription info |
| `api_keys` | User API keys for plugin authentication |
| `conversations` | AI chat conversation history |
| `messages` | Individual messages in conversations |
| `usage_log` | Track API usage and credit consumption |
| `discord_connections` | Discord bot connections |
| `roblox_connections` | Roblox plugin connections |
| `user_settings` | User preferences |
| `generated_bots` | Discord bots created by users |

Row Level Security (RLS) is enabled on all tables. The service role has full access; authenticated users can only access their own data.

## API Endpoints

See [API-DOCS.md](./API-DOCS.md) for complete endpoint documentation.

**Authentication:**
- `POST /api/auth/signup` — Create new account
- `POST /api/auth/login` — Login to existing account

**User:**
- `GET /api/user/me` — Get current user info
- `GET /api/user/usage` — Get usage statistics

**AI Chat:**
- `POST /api/chat/roblox` — Generate Roblox scripts/UI
- `POST /api/chat/discord` — Generate Discord configs
- `GET /api/chat/conversations` — Get conversation history

**Plugin:**
- `POST /api/plugin/task` — Send task to Roblox Studio plugin

## Authentication

Revro uses two authentication methods:

1. **Supabase Auth (Web)** — JWT tokens for web dashboard
2. **API Keys (Plugin)** — Secure API keys for Roblox Studio plugin

Include the API key in requests:

```bash
curl -H "x-api-key: your_api_key_here" \
 https://api.revro.dev/api/chat/roblox
```

## Credit System

| Plan | Price | Credits/Month | AI Model | Images |
|------|-------|---------------|----------|--------|
| Free | $0 | 25 | Sonnet 4.5 | 0 |
| Starter | $10 ($9/yr) | 150 | Sonnet 4.6 | 0 |
| Pro | $20 ($17/yr) | 500 | Opus 4.6 | 50 |
| Studio | $50 ($42/yr) | 1500 | Opus 4.6 | 150 |

## Email Templates

Automated emails are sent for:

- **Welcome** — Account creation with API key
- **Email Verification** — Verify email address
- **Password Reset** — Secure password reset link
- **Low Credits** — Warning when < 20% credits remain
- **Monthly Usage** — End-of-month usage summary
- **Payment Confirmation** — Receipt after purchase
- **Subscription Cancelled** — Cancellation confirmation

## Deployment

### Vercel (Main Backend)

1. Connect the GitLab repository to Vercel
2. Add environment variables in the Vercel dashboard
3. Deploy — Vercel auto-deploys on push to `main`

Build settings: Framework: Next.js, Build command: `npm run build`, Output: `.next`

### Railway (Plugin Server)

1. Create a Railway project
2. Connect via Railway CLI or GitHub
3. Add environment variables
4. Deploy

See [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed deployment instructions.

## Testing

```bash
# Test signup
curl -X POST http://localhost:3000/api/auth/signup \
 -H "Content-Type: application/json" \
 -d '{"email":"test@example.com","password":"testpass123","displayName":"Test User"}'

# Test with API key
curl -H "x-api-key: your_api_key" \
 http://localhost:3000/api/user/me
```

## Project Structure

```
revro-nextjs-backend/
├── app/
│  ├── api/
│  │  ├── auth/      # Authentication endpoints
│  │  ├── chat/      # AI chat endpoints
│  │  ├── plugin/     # Plugin communication
│  │  └── user/      # User management
│  └── layout.tsx
├── lib/
│  ├── supabase.ts     # Supabase client
│  ├── claude.ts      # Claude AI integration
│  ├── credits.ts     # Credit system logic
│  ├── email.ts      # Email templates & sending
│  └── auth.ts       # Auth middleware
├── .env.example
├── .env.local
├── next.config.js
├── package.json
├── tsconfig.json
└── README.md
```

## Debugging

**"Failed to create user profile"** — Check Supabase RLS policies and verify `SUPABASE_SERVICE_ROLE_KEY` is set.

**"Unauthorized"** — API key is missing or invalid, or JWT token has expired.

**Emails not sending** — Check `RESEND_API_KEY`, verify the sender domain in Resend dashboard, and check Vercel runtime logs.

Enable debug logs by adding `DEBUG=true` to `.env.local`.

## License

Proprietary — All rights reserved.

## Links

- **Website:** https://revro.dev
- **Support:** support@revro.dev

---

Built with ️ for Roblox and Discord creators

---

Last updated: April 2026
