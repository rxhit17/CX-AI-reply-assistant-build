import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from './env.js';

/**
 * `db` is the privileged (service-role) client. It bypasses RLS, so every service function that uses it
 * must first authorize the caller (assertBrandAccess) and derive brand_id from trusted database rows.
 */
export interface Deps {
  env: Env;
  db: SupabaseClient;
}
