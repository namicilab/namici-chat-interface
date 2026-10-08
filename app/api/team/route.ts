import { NextResponse } from 'next/server';
import { admin, staffFromRequest } from '@/lib/supabase';

/**
 * What the inbox needs to know about the install: who can be assigned a chat,
 * and which optional features are configured on the server.
 *
 * GET /api/team   (browser session required)
 *   → { staff: string[], suggest: boolean, push: boolean, vapidPublicKey: string | null }
 */
export async function GET(req: Request) {
  const user = await staffFromRequest(req);
  if (!user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  // Staff are the accounts in Authentication → Users; the browser cannot list
  // them with the anon key.
  const { data } = await admin().auth.admin.listUsers({ perPage: 200 });
  const staff = (data?.users ?? [])
    .map((u) => u.email)
    .filter((e): e is string => Boolean(e))
    .sort((a, b) => a.localeCompare(b));

  const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || null;
  return NextResponse.json({
    staff,
    suggest: Boolean(process.env.N8N_SUGGEST_WEBHOOK_URL),
    push: Boolean(vapidPublicKey && process.env.VAPID_PRIVATE_KEY),
    vapidPublicKey,
  });
}
