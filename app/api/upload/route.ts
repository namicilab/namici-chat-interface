import { NextResponse } from 'next/server';
import { admin, checkApiKey } from '@/lib/supabase';

/**
 * Takes a raw image body and puts it in storage, returning a URL that
 * /api/inbound will accept as mediaUrl.
 *
 * This exists so n8n never needs Supabase credentials. It already holds the
 * namici-ci API key, and namici-ci stays the only thing that talks to the
 * database — which is what keeps a new chat platform from touching anything
 * but its own workflow.
 *
 * POST /api/upload
 *   headers: x-api-key, content-type: image/jpeg
 *   body:    the raw bytes
 * ->  { mediaUrl }
 */

const MAX_BYTES = 12 * 1024 * 1024;

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export async function POST(req: Request) {
  if (!checkApiKey(req)) {
    return NextResponse.json({ error: 'bad api key' }, { status: 401 });
  }

  const contentType = (req.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  const ext = EXT[contentType];
  if (!ext) {
    return NextResponse.json(
      { error: `unsupported content-type "${contentType}"`, supported: Object.keys(EXT) },
      { status: 415 }
    );
  }

  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength === 0) {
    return NextResponse.json({ error: 'empty body' }, { status: 400 });
  }
  if (bytes.byteLength > MAX_BYTES) {
    return NextResponse.json({ error: 'file is larger than 12MB' }, { status: 413 });
  }

  // A conversation id is optional here: the caller may be uploading before the
  // conversation row exists, which is exactly what the Telegram path does.
  const scope = String(new URL(req.url).searchParams.get('conversationId') || 'inbound')
    .replace(/[^a-zA-Z0-9-]/g, '');
  const path = `${scope}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  const db = admin();
  const { error } = await db.storage.from('chat-media').upload(path, bytes, {
    contentType,
    cacheControl: '3600',
    upsert: false,
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { data } = db.storage.from('chat-media').getPublicUrl(path);
  return NextResponse.json({ mediaUrl: data.publicUrl, path });
}
