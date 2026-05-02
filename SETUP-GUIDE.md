# Revro — Local Development Setup Guide

Complete guide for setting up the Revro backend for local development.

---

## Prerequisites

Before you begin, ensure you have:

- **Node.js** 18.0 or higher — [Download](https://nodejs.org/)
- **npm** or **yarn**
- **Git** — [Download](https://git-scm.com/)
- **VS Code** (recommended)
- **Supabase account** — [Sign up](https://supabase.com/)
- **Anthropic API key** — [Get key](https://console.anthropic.com/)
- **Resend account** — [Sign up](https://resend.com/)

Verify your setup:

```bash
node --version # Should be v18.0.0 or higher
npm --version  # Should be 9.0.0 or higher
git --version  # Any recent version
```

---

## Step 1: Clone the Repository

```bash
git clone https://gitlab.com/revro1/revro-backend.git
cd revro-backend/revro-nextjs-backend
```

---

## Step 2: Install Dependencies

```bash
npm install
```

This installs: Next.js 14, React, Supabase client, Anthropic SDK, Resend, TypeScript.

If you see vulnerabilities:

```bash
npm audit fix
```

---

## ️ Step 3: Set Up Supabase

### 3.1 Create Supabase Project

1. Go to [supabase.com](https://supabase.com/)
2. Click **New Project**
3. Set the name to **Revro**, choose a database password, and select your region
4. Wait ~2 minutes for the project to be ready

### 3.2 Get Supabase Credentials

1. Go to **Project Settings → API**
2. Copy the **Project URL**, **anon public** key, and **service_role** key

### 3.3 Create Database Tables

In the Supabase **SQL Editor**, run:

```sql
-- Users table
CREATE TABLE users (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 email TEXT UNIQUE NOT NULL,
 display_name TEXT,
 plan TEXT DEFAULT 'free',
 credits_used INTEGER DEFAULT 0,
 credits_total INTEGER DEFAULT 25,
 images_generated INTEGER DEFAULT 0,
 billing_cycle_start TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
 created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
 updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- API Keys table
CREATE TABLE api_keys (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID REFERENCES users(id) ON DELETE CASCADE,
 key TEXT UNIQUE NOT NULL,
 name TEXT DEFAULT 'Default API Key',
 created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Conversations table
CREATE TABLE conversations (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID REFERENCES users(id) ON DELETE CASCADE,
 title TEXT,
 type TEXT, -- 'roblox' or 'discord'
 created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
 updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Messages table
CREATE TABLE messages (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
 role TEXT NOT NULL, -- 'user' or 'assistant'
 content TEXT NOT NULL,
 credits_used INTEGER DEFAULT 0,
 created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Usage log table
CREATE TABLE usage_log (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID REFERENCES users(id) ON DELETE CASCADE,
 action TEXT NOT NULL,
 credits_used INTEGER DEFAULT 0,
 metadata JSONB,
 created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Discord connections table
CREATE TABLE discord_connections (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID REFERENCES users(id) ON DELETE CASCADE,
 guild_id TEXT NOT NULL,
 guild_name TEXT,
 bot_token TEXT,
 is_active BOOLEAN DEFAULT true,
 created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Roblox connections table
CREATE TABLE roblox_connections (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID REFERENCES users(id) ON DELETE CASCADE,
 roblox_user_id TEXT,
 is_active BOOLEAN DEFAULT true,
 created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- User settings table
CREATE TABLE user_settings (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
 theme TEXT DEFAULT 'dark',
 notifications_enabled BOOLEAN DEFAULT true,
 created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
 updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Generated bots table
CREATE TABLE generated_bots (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID REFERENCES users(id) ON DELETE CASCADE,
 bot_name TEXT,
 bot_config JSONB,
 created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### 3.4 Set Up Row Level Security (RLS)

```sql
-- Enable RLS on all tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE discord_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE roblox_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE generated_bots ENABLE ROW LEVEL SECURITY;

-- Users table policies
CREATE POLICY "Backend full access on users" ON users
FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Users read own data" ON users
FOR SELECT TO authenticated USING (auth.uid() = id);

CREATE POLICY "Users update own data" ON users
FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- API keys policies
CREATE POLICY "Backend full access on api_keys" ON api_keys
FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Users read own api_keys" ON api_keys
FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- Repeat the same pattern for remaining tables
```

---

## Step 4: Get API Keys

### Anthropic (Claude AI)

1. Go to [console.anthropic.com](https://console.anthropic.com/)
2. Navigate to **API Keys** and click **Create Key**
3. Copy the key — it starts with `sk-ant-`
4. Note: a payment method is required to use the API

### Resend (Email)

1. Go to [resend.com](https://resend.com/)
2. Navigate to **API Keys** and click **Create API Key**
3. Name it "Revro Development" and copy the key — it starts with `re_`

---

## ️ Step 5: Configure Environment Variables

```bash
cp .env.example .env.local
```

Open `.env.local` and fill in your values:

```env
# Supabase Configuration
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key_here
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here

# Anthropic (Claude AI)
CLAUDE_API_KEY=sk-ant-your_key_here

# Resend (Email)
RESEND_API_KEY=re_your_key_here

# Plugin Server (use localhost for local testing)
PLUGIN_SERVER_URL=http://localhost:3600
PLUGIN_SHARED_SECRET=generate_a_64_character_random_hex_string

# Sentry (optional)
NEXT_PUBLIC_SENTRY_DSN=your_sentry_dsn_here

# App Configuration
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

Generate a plugin shared secret:

```bash
# Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Mac/Linux
openssl rand -hex 32

# Windows (PowerShell)
-join ((48..57) + (65..70) | Get-Random -Count 64 | % {[char]$_})
```

---

## Step 6: Run Development Server

```bash
npm run dev
```

The server starts at `http://localhost:3000`.

---

## Step 7: Test the Setup

```bash
# Should return {"error":"Unauthorized"} — this is correct
curl http://localhost:3000/api/user/me

# Test signup
curl -X POST http://localhost:3000/api/auth/signup \
 -H "Content-Type: application/json" \
 -d "{\"email\":\"test@example.com\",\"password\":\"testpass123\",\"displayName\":\"Test User\"}"
```

Verify the test user appears in Supabase Table Editor under the `users` table.

---

## Step 8: Set Up Plugin Server (Optional)

The plugin server handles communication between the website and Roblox Studio plugin.

```bash
cd ../revro-plugin-server
npm install
```

Create `.env`:

```env
PORT=3600
SHARED_SECRET=same_64_char_secret_from_main_backend
```

Start it:

```bash
npm start
# Plugin server running on http://localhost:3600
```

---

## ️ Development Tools

### Recommended VS Code Extensions

- **ES7+ React/Redux snippets** — Quick code snippets
- **Prettier** — Code formatting
- **ESLint** — Code linting
- **TypeScript** — Better TypeScript support
- **Tailwind CSS IntelliSense** — Tailwind autocomplete

### VS Code Settings

Create `.vscode/settings.json`:

```json
{
 "editor.formatOnSave": true,
 "editor.defaultFormatter": "esbenp.prettier-vscode",
 "typescript.tsdk": "node_modules/typescript/lib"
}
```

---

## Troubleshooting

**"Module not found"**

```bash
rm -rf node_modules package-lock.json
npm install
```

**"Port 3000 already in use"**

```bash
# Windows
netstat -ano | findstr :3000
taskkill /PID <PID> /F

# Mac/Linux
lsof -ti:3000 | xargs kill -9

# Or use a different port
npm run dev -- -p 3001
```

**"Supabase connection failed"** — Check environment variables are correct and the Supabase project is active.

**"Claude API error"** — Check the API key is valid and a payment method is added to your Anthropic account.

**"Email not sending"** — Verify `RESEND_API_KEY` and check the sender domain is verified in Resend dashboard.

---

## Development Workflow

```bash
git checkout -b feature/my-new-feature
# Make changes
npm run dev
git add .
git commit -m "Add new feature"
git push origin feature/my-new-feature
```

Vercel auto-deploys when you merge to `main`.

---

## Useful Commands

```bash
npm run dev     # Start development server
npm run build    # Build for production
npm start      # Start production server
npm run lint     # Lint code
npm run type-check  # Run TypeScript compiler
```

---

## Cleanup

```bash
rm -rf .next             # Clear build cache
rm -rf node_modules package-lock.json # Reinstall dependencies
npm install
```

---

## Setup Checklist

- [ ] Node.js 18+ installed
- [ ] Repository cloned
- [ ] `npm install` complete
- [ ] Supabase project created
- [ ] Database tables and RLS policies created
- [ ] API keys obtained (Anthropic, Resend)
- [ ] `.env.local` configured
- [ ] Dev server starts with `npm run dev`
- [ ] Test signup returns a user and API key
- [ ] User visible in Supabase Table Editor

---

## Resources

- [Next.js Documentation](https://nextjs.org/docs)
- [Supabase Documentation](https://supabase.com/docs)
- [Anthropic API Docs](https://docs.anthropic.com/)
- [Resend Documentation](https://resend.com/docs)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)

---

## Tips

- **Use TypeScript** — Catch errors before runtime
- **Test with real data** — Don't rely only on mock data
- **Check logs** — Use `console.log` liberally during development
- **Use Supabase Studio** — Great for debugging database issues
- **Enable debug mode** — Add `DEBUG=true` to `.env.local`
- **Hot reload** — Next.js auto-reloads on file changes
- **Use Git** — Commit often, commit early

---

## Getting Help

If you're stuck:

1. Check this guide again
2. Check error messages in terminal
3. Check Vercel/Supabase logs
4. Search the error on Google
5. Check Next.js documentation
6. Contact support@revro.dev

---

**You're ready to develop!**

---

Last updated: April 2026
