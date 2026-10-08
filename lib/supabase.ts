import { createClient } from '@supabase/supabase-js';

/** Service-role client. Server only — bypasses RLS, never import from a component. */
export function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

/** Resolves the staff member behind a browser request, or null. */
export async function staffFromRequest(req: Request) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const { data } = await admin().auth.getUser(token);
  return data.user ?? null;
}

/**
 * Sent on every call to an n8n webhook. Anyone holding a bare webhook URL
 * could message your customers, so the workflow should reject requests
 * without it. Same headers the Handover extension sends, so one workflow
 * serves both.
 */
export function n8nHeaders(): Record<string, string> {
  const secret = process.env.N8N_WEBHOOK_SECRET;
  return secret ? { 'x-handover-secret': secret, 'x-namici-secret': secret } : {};
}
