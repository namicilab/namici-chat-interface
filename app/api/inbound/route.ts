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

  if (!channel || !externalChatId || !text) {
    return NextResponse.json(
      { error: 'channel, externalChatId and text are all required' },
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
    .insert({ conversation_id: convo.id, role: 'customer', body: text });

  if (msgError) {
    return NextResponse.json({ error: msgError.message }, { status: 500 });
  }

  await db
    .from('conversations')
    .update({ last_message_at: new Date().toISOString(), unread: (convo.unread ?? 0) + 1 })
    .eq('id', convo.id);

  return NextResponse.json({
    conversationId: convo.id,
    mode: convo.mode,
    forwardToAi: convo.mode === 'ai',
  });
}
