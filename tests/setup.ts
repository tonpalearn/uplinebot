/**
 * Vitest global setup — ensures the test suite runs with zero network calls
 * and zero real credentials.
 *
 * LINE_MOCK / SLIP_MOCK make lib/line/client.ts and the slip-verification module
 * return canned responses instead of calling real external APIs.
 */
process.env.LINE_MOCK = "true";
process.env.SLIP_MOCK = "true";
process.env.SLIP_PROVIDER = "mock";

// Placeholder Supabase config so getServiceClient() can construct a client object
// even in tests that don't hit the network (createClient() does not itself connect).
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://placeholder.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "placeholder_service_role_key";

// LINE credentials — never used for real network calls under LINE_MOCK=true, but
// some code paths reference these env vars directly.
process.env.LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET ?? "test_channel_secret";
process.env.LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN ?? "test_access_token";

process.env.CRON_SECRET = process.env.CRON_SECRET ?? "test_cron_secret";

// Intentionally leave ENCRYPTION_KEY unset so lib/crypto.ts exercises its
// clearly-labeled reversible base64 stub path in tests.
