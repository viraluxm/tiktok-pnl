// Server-side environment variable validation.
// Throws at import time if any required var is missing,
// so a misconfigured deploy fails loudly at startup.

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const SUPABASE_URL = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
export const SUPABASE_ANON_KEY = requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');
export const SUPABASE_SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
export const TIKTOK_SHOP_APP_KEY = requireEnv('TIKTOK_SHOP_APP_KEY');
export const TIKTOK_SHOP_APP_SECRET = requireEnv('TIKTOK_SHOP_APP_SECRET');
export const ENCRYPTION_KEY = requireEnv('ENCRYPTION_KEY');
