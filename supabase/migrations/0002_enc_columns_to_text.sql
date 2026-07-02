-- UP Line — migration 0002: *_enc columns bytea -> text
--
-- Why: lib/crypto.ts now stores AES-256-GCM ciphertext as a base64 STRING
-- (iv||authTag||ciphertext, base64) instead of raw bytes. supabase-js returns a
-- `bytea` column as a hex string ("\x...."), not a Buffer, which broke the old
-- decrypt(Buffer.from(...)) round-trip on real data. Storing base64 TEXT means the
-- value written is exactly the value read back — no driver-specific decoding.
--
-- Safety: these tables are EMPTY on the live DB, so a plain `::text` cast is safe and
-- lossless. (If they held data written by the previous bytea code, we would instead use
--   using convert_from(Y, 'UTF8')
-- because that old code stored the UTF-8 bytes of a base64/stub string — but with empty
-- tables the simple cast below is correct and avoids any encoding assumptions.)

alter table upl_bots
  alter column channel_secret_enc type text using channel_secret_enc::text;

alter table upl_bots
  alter column access_token_enc type text using access_token_enc::text;

alter table upl_provider_credentials
  alter column credential_enc type text using credential_enc::text;

alter table upl_calendar_links
  alter column refresh_token_enc type text using refresh_token_enc::text;
