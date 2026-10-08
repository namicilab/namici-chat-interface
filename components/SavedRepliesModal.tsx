'use client';
import { useState } from 'react';
import { getSupabase } from '@/lib/client';
import type { SavedReply } from '@/lib/inbox';

/** Add, edit and delete the team's saved replies. */
export function SavedRepliesModal({ replies, email, onClose, onChanged, toast }: {
  replies: SavedReply[];
  email: string;
  onClose: () => void;
  onChanged: () => void;
  toast: (msg: string) => void;
}) {
  const [editing, setEditing] = useState<SavedReply | null>(null);
  const [shortcut, setShortcut] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  function edit(r: SavedReply | null) {
    setEditing(r);
    setShortcut(r?.shortcut ?? '');
    setBody(r?.body ?? '');
  }

  async function save() {
    const s = shortcut.trim().replace(/^\//, '').replace(/\s+/g, '-').toLowerCase();
    if (!s || !body.trim()) return toast('A saved reply needs a shortcut and text.');
    setBusy(true);
    const db = getSupabase().from('saved_replies');
    const { error } = editing
      ? await db.update({ shortcut: s, body: body.trim() }).eq('id', editing.id)
      : await db.insert({ shortcut: s, body: body.trim(), created_by: email || null });
    setBusy(false);
    if (error) return toast('Could not save: ' + error.message);
    edit(null);
    onChanged();
  }

  async function remove(r: SavedReply) {
    if (!confirm(`Delete /${r.shortcut}?`)) return;
    const { error } = await getSupabase().from('saved_replies').delete().eq('id', r.id);
    if (error) return toast('Could not delete: ' + error.message);
    if (editing?.id === r.id) edit(null);
    onChanged();
  }

  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-label="Saved replies">
        <header className="modal-head">
          <strong>Saved replies</strong>
          <button className="icon" onClick={onClose} title="Close (Esc)">×</button>
        </header>

        <p className="dim modal-lede">
          Type <code>/</code> in the reply box to use one. <code>{'{name}'}</code> becomes the customer&apos;s first name.
        </p>

        <div className="saved-list">
          {replies.length === 0 && <p className="dim">None yet.</p>}
          {replies.map((r) => (
            <div key={r.id} className={'saved-item' + (editing?.id === r.id ? ' on' : '')}>
              <button className="saved-main" onClick={() => edit(r)}>
                <code>/{r.shortcut}</code>
                <span>{r.body}</span>
              </button>
              <button className="linkish danger" onClick={() => remove(r)}>Delete</button>
            </div>
          ))}
        </div>

        <div className="saved-form">
          <input value={shortcut} onChange={(e) => setShortcut(e.target.value)} placeholder="shortcut, e.g. hours" />
          <textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)}
                    placeholder="Hi {name}! We're open 9:00–17:00, Monday to Friday." />
          <div className="saved-actions">
            {editing && <button className="linkish" onClick={() => edit(null)}>Cancel</button>}
            <button className="btn" disabled={busy} onClick={save}>{editing ? 'Save changes' : 'Add reply'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
