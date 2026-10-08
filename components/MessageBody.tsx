'use client';
import type { Message } from '@/lib/inbox';
import { parseLocation } from '@/lib/inbox';

/** The inside of a bubble, by message kind. */
export function MessageBody({ m, onMediaLoad, onOpenImage }: {
  m: Message;
  onMediaLoad: () => void;
  onOpenImage: (src: string, caption?: string) => void;
}) {
  const cls = 'bubble media ' + m.role;

  if (m.kind === 'image' && m.media_url) {
    const src = m.media_url;
    return (
      <a className={cls} href={src} target="_blank" rel="noreferrer"
         onClick={(e) => { e.preventDefault(); onOpenImage(src, m.body || undefined); }}>
        <img src={m.media_url} alt={m.body || 'Image'} loading="lazy" onLoad={onMediaLoad} />
        {m.body && <span className="caption">{m.body}</span>}
      </a>
    );
  }

  if (m.kind === 'audio' && m.media_url) {
    return (
      <div className={cls + ' audio'}>
        <audio controls preload="metadata" src={m.media_url} />
        {m.body && <span className="caption">{m.body}</span>}
      </div>
    );
  }

  if (m.kind === 'video' && m.media_url) {
    return (
      <div className={cls}>
        <video controls preload="metadata" src={m.media_url} onLoadedMetadata={onMediaLoad} />
        {m.body && <span className="caption">{m.body}</span>}
      </div>
    );
  }

  if (m.kind === 'file' && m.media_url) {
    return (
      <div className={'bubble ' + m.role}>
        <a className="file-link" href={m.media_url} target="_blank" rel="noreferrer">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" strokeLinejoin="round" />
            <path d="M14 3v5h5" strokeLinejoin="round" />
          </svg>
          <span>{m.media_name || 'File'}</span>
        </a>
        {m.body && m.body !== m.media_name && <div className="file-caption">{m.body}</div>}
      </div>
    );
  }

  if (m.kind === 'location') {
    const loc = parseLocation(m.body);
    if (loc) {
      return (
        <div className={'bubble ' + m.role}>
          <a className="file-link" href={`https://maps.google.com/?q=${loc.lat},${loc.lng}`}
             target="_blank" rel="noreferrer">
            <span aria-hidden>📍</span>
            <span>{loc.label || `${loc.lat}, ${loc.lng}`}</span>
          </a>
        </div>
      );
    }
  }

  return <div className={'bubble ' + (m.kind === 'note' ? 'note' : m.role)}>{m.body}</div>;
}

/** Ticks under the operator's own replies. */
export function DeliveryMark({ status }: { status: Message['delivery_status'] }) {
  if (status === 'pending') return <span className="tick" title="Sending">⏱</span>;
  if (status === 'sent') return <span className="tick" title="Sent">✓</span>;
  if (status === 'delivered') return <span className="tick" title="Delivered">✓✓</span>;
  if (status === 'read') return <span className="tick read" title="Read">✓✓</span>;
  return null;
}
