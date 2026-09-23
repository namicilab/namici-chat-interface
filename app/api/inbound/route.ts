import { NextResponse } from 'next/server';
import { admin, checkApiKey } from '@/lib/supabase';

/**
 * n8n posts every incoming customer message here.
 *
 * The reply tells n8n whether to run the AI. That is the whole handoff: while
 * a conversation is in 'human' mode this returns forwardToAi:false and n8n
 * stops, so the bot cannot talk over the operator.
 *
 * POST /api/inbound
 *   { channel, externalChatId, text, contactName?, contactHandle? }
 * ->  { conversationId, mode, forwardToAi }
 */
export async function POST(req: Request) {
  if (!checkApiKey(req)) {
    return NextResponse.json({ error: 'bad api key' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const channel = String(body?.channel || '').trim();
  const externalChatId = String(body?.externalChatId ?? '').trim();
  const text = String(body?.text ?? '').trim();
  const kind = body?.kind === 'image' ? 'image' : 'text';
  const mediaUrl = String(body?.mediaUrl ?? '').trim();

  if (!channel || !externalChatId) {
    return NextResponse.json(
      { error: 'channel and externalChatId are required' },
      { status: 400 }
    );
  }
  if (!text && !mediaUrl) {
    return NextResponse.json(
      { error: 'send text, mediaUrl, or both' },
      { status: 400 }
    );
  }

  const db = admin();

  // One row per (channel, chat id). Upsert so the first message of a new
  // conversation and the hundredth take exactly the same path.
  const { data: convo, error: upsertError } = await db
    .from('conversations')
    .upsert(
      {
        channel,
        external_chat_id: externalChatId,
        contact_name: body?.contactName ?? null,
        contact_handle: body?.contactHandle ?? null,
        last_message_at: new Date().toISOString(),
      },
      { onConflict: 'channel,external_chat_id', ignoreDuplicates: false }
    )
    .select()
    .single();

  if (upsertError || !convo) {
    return NextResponse.json({ error: upsertError?.message ?? 'upsert failed' }, { status: 500 });
  }

  const { error: msgError } = await db
    .from('messages')
    .insert({
      conversation_id: convo.id,
      role: 'customer',
      kind: mediaUrl ? 'image' : kind,
      body: text,
      media_url: mediaUrl || null,
    });

  if (msgError) {
    return NextResponse.json({ error: msgError.message }, { status: 500 });
  }

  await db
    .from('conversations')
    .update({
      last_message_at: new Date().toISOString(),
      last_preview: (mediaUrl ? (text ? '\uD83D\uDCF7 ' + text : '\uD83D\uDCF7 Photo') : text).slice(0, 140),
      unread: (convo.unread ?? 0) + 1,
    })
    .eq('id', convo.id);

  return NextResponse.json({
    conversationId: convo.id,
    mode: convo.mode,
    forwardToAi: convo.mode === 'ai',
  });
}
