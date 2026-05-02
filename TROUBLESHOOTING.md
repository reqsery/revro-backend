# Troubleshooting Guide

Common issues and solutions for Revro Backend deployment and development.

## Build & Deployment Issues

### "Module not found: Can't resolve '@/lib/...'"

**Cause:** Path aliases not configured properly

**Solution:**
- Verify `tsconfig.json` has `"baseUrl": "."` and `"paths": { "@/*": ["./*"] }`
- Check `next.config.js` includes the webpack alias configuration
- Restart dev server after changing config

### "Cannot find module" during build

**Cause:** Dependencies missing or in wrong section

**Solution:**
- Move TypeScript and type packages to `dependencies` (not `devDependencies`)
- Run `npm install` to ensure all packages are installed
- Clear `.next` folder and rebuild: `rm -rf .next && npm run build`

### Build runs out of memory

**Cause:** Insufficient RAM on hosting platform

**Solution:**
- Deploy to Vercel (unlimited build RAM for Next.js)
- Avoid free hosting tiers with <1GB RAM for Next.js builds

### "Error: Could not find a production build"

**Cause:** Build step didn't complete or `.next` folder missing

**Solution:**
- Check build logs for errors during `npm run build`
- Verify Build Command is set to `npm run build`
- Try clearing build cache and redeploying

---

## Authentication Issues

### "Unauthorized" on all API requests

**Cause:** Missing or invalid authentication

**Solutions:**
1. **For web requests:** Include valid JWT token in `Authorization: Bearer <token>` header
2. **For plugin requests:** Include API key in `x-api-key` header
3. Verify Supabase Auth is enabled in dashboard
4. Check `SUPABASE_SERVICE_KEY` is set correctly in environment variables

### "Failed to create user profile"

**Cause:** Supabase RLS policies blocking service role or missing env var

**Solution:**
- Verify `SUPABASE_SERVICE_KEY` (service_role key) is set in environment variables
- Check Supabase RLS policies allow service role to insert/update
- Review Supabase logs for detailed error messages

### Users can't sign up with Google OAuth

**Cause:** OAuth configuration incomplete

**Solution:**
- Verify Google OAuth is enabled in Supabase dashboard
- Check redirect URIs include your Supabase callback URL
- Ensure Google OAuth consent screen is configured and published

---

## Database Issues

### "supabaseUrl is required" error

**Cause:** Environment variables not available at build time

**Solution:**
- Set both `SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_URL` to the same value
- Verify environment variables are saved in hosting platform
- Redeploy after adding missing variables

### Connection timeouts or database errors

**Cause:** Network issues or incorrect credentials

**Solution:**
- Check Supabase project status (dashboard.supabase.com)
- Verify `SUPABASE_URL` points to correct project
- Ensure service key hasn't been rotated/changed
- Check connection limits haven't been exceeded (Supabase free tier: 500MB)

---

## Email Issues

### Emails not sending

**Cause:** Resend configuration or API key issues

**Solutions:**
1. Verify `RESEND_API_KEY` is correct and active
2. Check sender domain is verified in Resend dashboard
3. Review Vercel function logs for detailed errors
4. Ensure "from" email uses verified domain (e.g., `support@revro.dev`)
5. Check Resend API usage hasn't exceeded limits (free: 100 emails/day)

### Emails go to spam

**Cause:** SPF/DKIM/DMARC not configured

**Solution:**
- Add SPF, DKIM, and DMARC records to your domain's DNS
- Follow Resend's domain verification guide
- Use a verified sender address

---

## API & Integration Issues

### Claude API errors

**Cause:** Invalid API key or insufficient credits

**Solution:**
- Verify `CLAUDE_API_KEY` is correct
- Check Anthropic account has available credits
- Review error message for specific API errors (rate limits, invalid requests)
- Ensure model IDs in code match available Anthropic models

### Stripe webhooks not working

**Cause:** Webhook signature verification failing

**Solution:**
- Verify webhook endpoint URL is correct in Stripe dashboard
- Check `STRIPE_SECRET_KEY` matches your Stripe account mode (test/live)
- Ensure webhook signature is being validated correctly
- Review Stripe dashboard for webhook delivery attempts and errors

---

## Performance Issues

### Slow API responses

**Causes & Solutions:**
1. **Cold starts (serverless):** First request after inactivity is slower - normal behavior
2. **Database queries:** Add indexes to frequently queried columns in Supabase
3. **External API calls:** Claude/OpenAI can take 2-10 seconds - expected for AI generation
4. **Large payloads:** Reduce response size or implement pagination

### Function timeouts

**Cause:** Vercel serverless functions have 10s timeout (free tier)

**Solution:**
- Optimize slow database queries
- Consider Pro plan for 60s timeouts if needed
- For long-running tasks, implement async processing

---

## Local Development Issues

### "Port 3000 already in use"

**Solution:**
```bash
# Kill process on port 3000
npx kill-port 3000

# Or use different port
npm run dev -- -p 3001
```

### Hot reload not working

**Solution:**
- Restart dev server
- Clear `.next` folder: `rm -rf .next`
- Check file watcher limits (Linux): `echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf`

---

## Getting Help

If you're still experiencing issues:

1. **Check Logs:**
   - Vercel: Dashboard → Your Project → Deployments → View Function Logs
   - Supabase: Dashboard → Logs
   - Sentry: If configured, check error reports

2. **Common Log Locations:**
   - Build errors: Vercel deployment logs
   - Runtime errors: Vercel function logs
   - Database errors: Supabase logs

3. **Support Channels:**
   - Discord: https://discord.gg/vV2USr9phF
   - Email: support@revro.dev
   - GitHub Issues: Report bugs on the repository

---

**Last updated:** April 2026
