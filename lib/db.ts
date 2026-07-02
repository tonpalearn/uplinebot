import { createClient, SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase client factory.
 *
 * getServiceClient() returns a service-role client for BFF use only
 * (webhook handlers, cron dispatcher, admin API routes). It bypasses RLS
 * by design — the trusted server is already gated by application-level
 * auth + entitlement checks (see lib/entitlement.ts).
 *
 * Never expose the service-role key to the client/browser.
 */

let cachedClient: SupabaseClient | null = null;

export function getServiceClient(): SupabaseClient {
  if (cachedClient) return cachedClient;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to create the service client."
    );
  }

  cachedClient = createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return cachedClient;
}
