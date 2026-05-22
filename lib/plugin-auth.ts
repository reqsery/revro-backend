import { NextRequest } from 'next/server';
import { supabaseAdmin } from './supabase';
import { createHash } from 'crypto';

export function getPluginApiKey(request: NextRequest): string {
  const headerKey = request.headers.get('x-api-key')?.trim();
  if (headerKey) return headerKey;

  const authHeader = request.headers.get('authorization')?.trim() ?? '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }

  return '';
}

export function hashPluginApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

export async function getUserIdByPluginApiKey(apiKey: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('api_keys')
    .select('user_id')
    .eq('key_hash', hashPluginApiKey(apiKey))
    .single();

  if (error || !data) return null;
  return data.user_id as string;
}
