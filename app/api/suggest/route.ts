import { NextResponse } from 'next/server';
import { admin, n8nHeaders, staffFromRequest } from '@/lib/supabase';

/**
 * Ask the n8n agent for a draft reply. The operator edits it before sending;
 * nothing reaches the customer from here.
 *
 * POST /api/suggest   { conversationId }   → { text }
 *
 * The workflow at N8N_SUGGEST_WEBHOOK_URL receives
 *   { conversationId, channel, contactName, history: [{ role, kind, body, at }] }
 * and answers with { text } from a "Respond to Webhook" node.
 */
export async function POST(req: Request) {
  const user = await staffFromRequest(req);
  if (!user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const url = process.env.N8N_SUGGEST_WEBHOOK_URL;
  if (!url) return NextResponse.json({ error: 'suggestions are not configured' }, { status: 501 });

  const body = await req.json().catch(() => null);
  const conversationId = String(body?.conversationId ?? '').trim();
  if (!conversationId) return NextResponse.json({ error: 'conversationId is required' }, { status: 400 });

  const db = admin();
  const [{ data: convo }, { data: rows }] = await Promise.all([
    db.from('conversations').select('channel, contact_name, contact_handle').eq('id', conversationId).single(),
    // Notes are for staff and stay out of what the bot reads.
    db.from('messages').select('role, kind, body, created_at')
      .eq('conversation_id', conversationId).neq('kind', 'note')
      .order('id', { ascending: false }).limit(30),
  ]);
  if (!convo) return NextResponse.json({ error: 'conversation not found' }, { status: 404 });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...n8nHeaders() },
      body: JSON.stringify({
        conversationId,
        channel: convo.channel,
        contactName: convo.contact_name || convo.contact_handle || null,
        history: (rows ?? []).reverse().map((m) => ({ role: m.role, kind: m.kind, body: m.body, at: m.created_at })),
      }),
    });
    const out = await res.json().catch(() => null);
    const text = String(out?.text ?? out?.output ?? '').trim();
    if (!res.ok || !text) {
      return NextResponse.json({ error: res.ok ? 'n8n returned no text' : 'n8n returned ' + res.status }, { status: 502 });
    }
    return NextResponse.json({ text });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 502 });
  }
}
