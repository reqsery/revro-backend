# Revro Backend - Deployment Checklist

## Pre-Deployment

### 1. Supabase Setup
- [x] Database created with all tables
- [ ] Get Supabase URL from Dashboard → Settings → API
- [ ] Get Anon Key from Dashboard → Settings → API
- [ ] Get Service Role Key from Dashboard → Settings → API (keep secret!)
- [ ] Enable Email Auth in Dashboard → Authentication → Providers

### 2. Claude API
- [ ] Get API key from console.anthropic.com
- [ ] Add payment method (required for API access)
- [ ] Test key works: `curl https://api.anthropic.com/v1/messages -H "x-api-key: YOUR_KEY"`

### 3. Resend Email
- [ ] Get API key from resend.com dashboard
- [ ] (Optional) Add custom domain for emails
- [ ] Test key works with a test email

### 4. Plugin Server
- [ ] Plugin server running on port 3600
- [ ] Generate shared secret: `openssl rand -hex 32`
- [ ] Update plugin server .env with same shared secret

## Deployment Steps

### Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin YOUR_REPO_URL
git push -u origin main
```

### Deploy to Vercel

1. Go to [vercel.com](https://vercel.com)
2. Click "Import Project"
3. Connect GitHub and select your repo
4. Framework: **Next.js** (auto-detected)
5. Root Directory: Leave as `.` (root)
6. Build Command: `npm run build` (auto-filled)
7. Click "Environment Variables"

Add these variables:

```
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGc...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc... (keep secret!)
CLAUDE_API_KEY=sk-ant-...
RESEND_API_KEY=re_...
PLUGIN_SERVER_URL=http://localhost:3600
PLUGIN_SHARED_SECRET=your-shared-secret
NEXT_PUBLIC_APP_URL=https://your-project.vercel.app
```

8. Click "Deploy"

### Post-Deployment

1. **Test API endpoints:**
   ```bash
   # Health check (should work without auth)
   curl https://your-project.vercel.app/api/health
   
   # Signup
   curl -X POST https://your-project.vercel.app/api/auth/signup \
     -H "Content-Type: application/json" \
     -d '{"email":"test@example.com","password":"testpass123"}'
   ```

2. **Update frontend .env:**
   ```
   NEXT_PUBLIC_API_URL=https://your-project.vercel.app
   ```

3. **Test full flow:**
   - Sign up
   - Login
   - Send AI message
   - Check credits deducted

## Common Issues

### "CORS Error"
- Vercel automatically handles CORS for same-domain API routes
- If frontend is on different domain, add CORS headers to API routes

### "Unauthorized" on all requests
- Check Supabase Auth is enabled
- Verify anon key is correct
- Check token is being sent in Authorization header

### "Plugin not connected"
- Plugin server must be running
- Frontend needs to connect plugin before sending tasks
- Check shared secret matches

### "Claude API error"
- Verify API key is correct
- Check you have credits in Anthropic account
- Model IDs must match actual Anthropic model names

## Environment Variables Reference

| Variable | Where to Get It | Secret? |
|----------|----------------|---------|
| NEXT_PUBLIC_SUPABASE_URL | Supabase Dashboard → API | No |
| NEXT_PUBLIC_SUPABASE_ANON_KEY | Supabase Dashboard → API | No |
| SUPABASE_SERVICE_ROLE_KEY | Supabase Dashboard → API | **YES** |
| CLAUDE_API_KEY | console.anthropic.com | **YES** |
| RESEND_API_KEY | resend.com | **YES** |
| PLUGIN_SHARED_SECRET | Generate yourself | **YES** |

## Monitoring

After deployment:
- Check Vercel logs for errors
- Monitor Supabase dashboard for database activity
- Watch Anthropic console for API usage
- Set up Vercel analytics (optional)

## Scaling Considerations

- Vercel auto-scales API routes
- Supabase free tier: 500MB database, 2GB bandwidth
- Claude API: Pay per token
- Resend free tier: 3,000 emails/month

## Next Steps

After backend is deployed:
1. Deploy v0 frontend to same Vercel project
2. Set up Stripe for payments
3. Add email templates
4. Create admin dashboard
5. Set up monitoring/alerts
