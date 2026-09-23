import { NextResponse } from 'next/server';
import { admin, staffFromRequest } from '@/lib/supabase';

/**
 * An operator sent a message from the inbox. It is stored, then handed to n8n
 * to deliver on whichever platform the conversation came in on — namici-ci
 * never talks to Telegram or WhatsApp itself, which is what keeps it
 * channel-agnostic.
 *
 * POST /api/reply   { conversationId, text }   (browser session required)
 */
export async function POST(req: Request) {
  const user = await staffFromRequest(req);
  if (!user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const body = await req.json().catch(() => null);
  const conversationId = String(body?.conversationId ?? '').trim();
  const text = String(body?.text ?? '').trim();
  const kind = body?.kind === 'image' ? 'image' : 'text';
  const mediaUrl = String(body?.mediaUrl ?? '').trim();

  if (!conversationId) {
    return NextResponse.json({ error: 'conversationId is required' }, { status: 400 });
  }
  if (kind === 'image' && !mediaUrl) {
    return NextResponse.json({ error: 'an image message needs a mediaUrl' }, { status: 400 });
  }
  if (kind === 'text' && !text) {
    return NextResponse.json({ error: 'text is required' }, { status: 400 });
  }

  const db = admin();

  const { data: convo, error: readError } = await db
    .from('conversations')
    .select('channel, external_chat_id')
    .eq('id', conversationId)
    .single();

  if (readError || !convo) {
    return NextResponse.json({ error: 'conversation not found' }, { status: 404 });
  }

  // Store first. If delivery fails the operator can see their message is
  // recorded and retry, rather than wondering whether it was sent twice.
  const { error: insertError } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      role: 'agent',
      kind,
      body: text,
      media_url: kind === 'image' ? mediaUrl : null,
    });

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  await db
    .from('conversations')
    .update({
      last_message_at: new Date().toISOString(),
      last_preview: (kind === 'image' ? (text ? '\uD83D\uDCF7 ' + text : '\uD83D\uDCF7 Photo') : text).slice(0, 140),
      unread: 0,
    })
    .eq('id', conversationId);

  let delivered = false;
  let deliveryError = '';
  try {
    const res = await fetch(process.env.N8N_OUTBOUND_WEBHOOK_URL!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversationId,
        channel: convo.channel,
        externalChatId: convo.external_chat_id,
        kind,
        text,
        mediaUrl: kind === 'image' ? mediaUrl : null,
      }),
    });
    delivered = res.ok;
    if (!res.ok) deliveryError = 'n8n returned ' + res.status;
  } catch (e: any) {
    deliveryError = String(e?.message ?? e);
  }

  return NextResponse.json({ ok: true, delivered, deliveryError });
}
