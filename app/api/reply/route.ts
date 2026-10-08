import { NextResponse } from 'next/server';
import { admin, n8nHeaders, staffFromRequest } from '@/lib/supabase';

type Kind = 'text' | 'image' | 'audio' | 'video' | 'file' | 'note';

type Outbound = {
  conversationId: string;
  messageId: number;
  channel: string;
  externalChatId: string;
  kind: Exclude<Kind, 'note'>;
  text: string;
  mediaUrl: string | null;
  fileName: string | null;
  mimeType: string | null;
};

const MEDIA_KINDS = ['image', 'audio', 'video', 'file'];
const PREVIEW_ICON: Record<string, string> = { image: '📷', audio: '🎤', video: '🎬', file: '📎' };
const PREVIEW_DEFAULT: Record<string, string> = { image: 'Photo', audio: 'Voice message', video: 'Video', file: 'File' };

/**
 * An operator sent a message from the inbox. It is stored, then handed to n8n
 * to deliver on whichever platform the conversation came in on — namici-ci
 * never talks to Telegram or WhatsApp itself, which is what keeps it
 * channel-agnostic.
 *
 * POST /api/reply   { conversationId, text, kind?, mediaUrl?, fileName?, mimeType? }   send
 * POST /api/reply   { conversationId, text, kind: 'note' }                             internal note, never delivered
 * POST /api/reply   { retryMessageId }                                                 re-deliver a stored reply
 *
 * Browser session required.
 */
export async function POST(req: Request) {
  const user = await staffFromRequest(req);
  if (!user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const body = await req.json().catch(() => null);
  const db = admin();

  // A retry re-sends what is already stored and never inserts the message a
  // second time, so the thread does not show the reply twice.
  if (body?.retryMessageId != null) {
    const { data: msg } = await db
      .from('messages')
      .select('id, conversation_id, role, kind, body, media_url, media_name, media_mime, conversations(channel, external_chat_id)')
      .eq('id', body.retryMessageId)
      .single();
    const convo = (msg as any)?.conversations;
    if (!msg || msg.role !== 'agent' || msg.kind === 'note' || !convo) {
      return NextResponse.json({ error: 'message not found' }, { status: 404 });
    }
    const result = await deliverAndRecord({
      conversationId: msg.conversation_id,
      messageId: msg.id,
      channel: convo.channel,
      externalChatId: convo.external_chat_id,
      kind: msg.kind,
      text: msg.body ?? '',
      mediaUrl: msg.media_url,
      fileName: msg.media_name,
      mimeType: msg.media_mime,
    });
    return NextResponse.json({ ok: true, messageId: msg.id, ...result });
  }

  const conversationId = String(body?.conversationId ?? '').trim();
  const text = String(body?.text ?? '').trim();
  const kind: Kind = ['image', 'audio', 'video', 'file', 'note'].includes(body?.kind) ? body.kind : 'text';
  const mediaUrl = String(body?.mediaUrl ?? '').trim();
  const fileName = String(body?.fileName ?? '').trim().slice(0, 200) || null;
  const mimeType = String(body?.mimeType ?? '').trim().slice(0, 100) || null;

  if (!conversationId) {
    return NextResponse.json({ error: 'conversationId is required' }, { status: 400 });
  }
  if (MEDIA_KINDS.includes(kind) && !mediaUrl) {
    return NextResponse.json({ error: `a ${kind} message needs a mediaUrl` }, { status: 400 });
  }
  if ((kind === 'text' || kind === 'note') && !text) {
    return NextResponse.json({ error: 'text is required' }, { status: 400 });
  }

  const { data: convo, error: readError } = await db
    .from('conversations')
    .select('channel, external_chat_id, assigned_to')
    .eq('id', conversationId)
    .single();

  if (readError || !convo) {
    return NextResponse.json({ error: 'conversation not found' }, { status: 404 });
  }

  const isMedia = MEDIA_KINDS.includes(kind);

  // Store first. If delivery fails the operator can see their message is
  // recorded and retry, rather than wondering whether it was sent twice.
  const { data: inserted, error: insertError } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      role: 'agent',
      kind,
      body: text,
      media_url: isMedia ? mediaUrl : null,
      media_name: isMedia ? fileName : null,
      media_mime: isMedia ? mimeType : null,
      sent_by: user.email ?? null,
      sent_by_id: user.id,
      delivery_status: kind === 'note' ? null : 'pending',
    })
    .select('id')
    .single();

  if (insertError || !inserted) {
    return NextResponse.json({ error: insertError?.message ?? 'insert failed' }, { status: 500 });
  }

  // A note is for the team: it does not move the list or reach the customer.
  if (kind === 'note') {
    return NextResponse.json({ ok: true, messageId: inserted.id, delivered: true, deliveryError: '' });
  }

  const preview = isMedia
    ? `${PREVIEW_ICON[kind]} ${text || (kind === 'file' && fileName) || PREVIEW_DEFAULT[kind]}`
    : text;

  await db
    .from('conversations')
    .update({
      last_message_at: new Date().toISOString(),
      last_preview: preview.slice(0, 140),
      unread: 0,
      // Whoever answers an unowned chat owns it.
      ...(convo.assigned_to ? {} : { assigned_to: user.email ?? null }),
    })
    .eq('id', conversationId);

  const result = await deliverAndRecord({
    conversationId,
    messageId: inserted.id,
    channel: convo.channel,
    externalChatId: convo.external_chat_id,
    kind: kind as Outbound['kind'],
    text,
    mediaUrl: isMedia ? mediaUrl : null,
    fileName: isMedia ? fileName : null,
    mimeType: isMedia ? mimeType : null,
  });

  return NextResponse.json({ ok: true, messageId: inserted.id, ...result });
}

/**
 * Hand one reply to n8n and write the outcome onto the message, so every
 * member of staff sees "Not delivered" — not only the browser that sent it.
 *
 * The workflow may answer with { externalMessageId } (the platform's id for
 * the sent message); it is stored so delivered/read receipts can find the row.
 */
async function deliverAndRecord(payload: Outbound) {
  let delivered = false;
  let deliveryError = '';
  let externalMessageId: string | null = null;
  try {
    const res = await fetch(process.env.N8N_OUTBOUND_WEBHOOK_URL!, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...n8nHeaders() },
      body: JSON.stringify(payload),
    });
    delivered = res.ok;
    if (!res.ok) deliveryError = 'n8n returned ' + res.status;
    const out = await res.json().catch(() => null);
    const ext = out?.externalMessageId ?? out?.message_id ?? null;
    if (ext != null) externalMessageId = String(ext);
  } catch (e: any) {
    deliveryError = String(e?.message ?? e);
  }

  await admin()
    .from('messages')
    .update({
      delivery_status: delivered ? 'sent' : 'failed',
      delivery_error: delivered ? null : deliveryError.slice(0, 300),
      ...(externalMessageId ? { external_message_id: externalMessageId } : {}),
    })
    .eq('id', payload.messageId)
    // A receipt may already have moved it to delivered/read.
    .in('delivery_status', ['pending', 'failed', 'sent']);

  return { delivered, deliveryError };
}
