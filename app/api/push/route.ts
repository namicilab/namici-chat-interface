import { NextResponse } from 'next/server';
import webpush from 'web-push';
import { admin } from '@/lib/supabase';

/**
 * Web Push for new customer messages, so staff hear about them with the tab
 * closed. Called by a Supabase Database Webhook on INSERT into `messages`
 * (Database → Webhooks), with the header  x-push-secret: <PUSH_WEBHOOK_SECRET>.
 *
 * A chat with an assignee alerts only them; an unowned chat alerts everyone.
 */
export async function POST(req: Request) {
  const secret = process.env.PUSH_WEBHOOK_SECRET;
  if (!secret || req.headers.get('x-push-secret') !== secret) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return NextResponse.json({ error: 'VAPID keys are not configured' }, { status: 501 });

  const body = await req.json().catch(() => null);
  const m = body?.record;
  if (body?.type !== 'INSERT' || body?.table !== 'messages' || m?.role !== 'customer') {
    return NextResponse.json({ ok: true, skipped: true });
  }

  const db = admin();
  const { data: c } = await db
    .from('conversations')
    .select('id, channel, contact_name, contact_handle, external_chat_id, mode, assigned_to')
    .eq('id', m.conversation_id)
    .single();
  if (!c) return NextResponse.json({ ok: true, skipped: true });

  let q = db.from('push_subscriptions').select('id, endpoint, p256dh, auth');
  if (c.assigned_to) q = q.eq('email', c.assigned_to);
  const { data: subs } = await q;
  if (!subs?.length) return NextResponse.json({ ok: true, sent: 0 });

  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', pub, priv);

  const who = c.contact_name || c.contact_handle || c.external_chat_id;
  const preview = m.kind === 'text' ? String(m.body ?? '') : (m.body || `Sent ${m.kind === 'image' ? 'a photo' : 'a ' + m.kind}`);
  const payload = JSON.stringify({
    title: c.mode === 'human' ? `${who} is waiting for you` : `${who} · ${c.channel}`,
    body: preview.slice(0, 160),
    conversationId: c.id,
  });

  let sent = 0;
  const gone: number[] = [];
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600 });
      sent++;
    } catch (e: any) {
      // The browser dropped the subscription (uninstalled, cleared data).
      if (e?.statusCode === 404 || e?.statusCode === 410) gone.push(s.id);
    }
  }));
  if (gone.length) await db.from('push_subscriptions').delete().in('id', gone);

  return NextResponse.json({ ok: true, sent, removed: gone.length });
}
