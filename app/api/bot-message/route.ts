import { NextResponse } from 'next/server';
import { admin, checkApiKey } from '@/lib/supabase';

/**
 * n8n posts the AI's reply here after sending it to the customer, so the
 * operator sees the same thread the customer sees. Without this the inbox
 * would show questions with no answers.
 *
 * POST /api/bot-message   { conversationId, text }
 */
export async function POST(req: Request) {
  if (!checkApiKey(req)) {
    return NextResponse.json({ error: 'bad api key' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const conversationId = String(body?.conversationId ?? '').trim();
  const text = String(body?.text ?? '').trim();

  if (!conversationId || !text) {
    return NextResponse.json({ error: 'conversationId and text are required' }, { status: 400 });
  }

  const db = admin();
  const { error } = await db
    .from('messages')
    .insert({ conversation_id: conversationId, role: 'ai', body: text });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await db
    .from('conversations')
    .update({ last_message_at: new Date().toISOString() })
    .eq('id', conversationId);

  return NextResponse.json({ ok: true });
}
