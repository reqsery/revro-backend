-- Keep plugin API keys out of PostgREST filter URLs by authenticating with hashes.
ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS key_hash text;

UPDATE public.api_keys
SET key_hash = encode(digest(key, 'sha256'), 'hex')
WHERE key_hash IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS api_keys_key_hash_key
  ON public.api_keys (key_hash);
