import { createClient } from '@supabase/supabase-js';

// Client-side Supabase client (uses anon key)
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// Server-side admin client (bypasses RLS - use carefully!)
export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,  
  process.env.SUPABASE_SERVICE_KEY!  
);
