import { createClient } from '@supabase/supabase-js';

/** Service-role client. Server only — bypasses RLS, never import from a component. */
export function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

/** Rejects the request unless n8n sent the shared secret. */
export function checkApiKey(req: Request) {
  const sent = req.headers.get('x-api-key');
  return Boolean(sent) && sent === process.env.NAMICI_API_KEY;
}

/** Resolves the staff member behind a browser request, or null. */
export async function staffFromRequest(req: Request) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const { data } = await admin().auth.getUser(token);
  return data.user ?? null;
}
