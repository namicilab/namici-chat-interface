'use client';

/**
 * Full-screen photo viewer. In an installed app a plain link would leave the
 * app for the browser; this keeps the user here. Pinch-zoom is the browser's
 * own, so it feels native on a phone.
 */
export function Lightbox({ src, caption, onClose }: { src: string; caption?: string; onClose: () => void }) {
  return (
    <div className="lightbox" role="dialog" aria-label="Photo" onClick={onClose}>
      <header className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <button className="lb-btn" onClick={onClose} aria-label="Close">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <a className="lb-btn" href={src} download target="_blank" rel="noreferrer" aria-label="Open original">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </a>
      </header>
      <img src={src} alt={caption || 'Photo'} onClick={(e) => e.stopPropagation()} />
      {caption && <p className="lightbox-caption" onClick={(e) => e.stopPropagation()}>{caption}</p>}
    </div>
  );
}
