'use client';
import { useEffect, useState } from 'react';
import { getSupabase } from '@/lib/client';
import type { Conversation } from '@/lib/inbox';
import { avatarFor, channelLabel, initials, nameOf, staffName } from '@/lib/inbox';

/**
 * Who the customer is: identity, history in numbers, tags and a note the
 * whole team sees. Tags and the note are saved on the conversation row.
 */
export function ContactPanel({ convo, onClose, onChange, toast }: {
  convo: Conversation;
  onClose: () => void;
  onChange: (patch: Partial<Conversation>) => void;
  toast: (msg: string) => void;
}) {
  const [count, setCount] = useState<number | null>(null);
  const [tagDraft, setTagDraft] = useState('');
  const [note, setNote] = useState(convo.contact_note ?? '');
  const [noteSaved, setNoteSaved] = useState(true);

  useEffect(() => {
    setNote(convo.contact_note ?? '');
    setNoteSaved(true);
    setCount(null);
    getSupabase().from('messages').select('id', { count: 'exact', head: true })
      .eq('conversation_id', convo.id).neq('kind', 'note')
      .then(({ count }) => setCount(count ?? 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convo.id]);

  // A colleague edited the note while this panel was open and we have no
  // unsaved changes of our own: show theirs.
  useEffect(() => {
    if (noteSaved) setNote(convo.contact_note ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convo.contact_note]);

  async function save(patch: Partial<Conversation>) {
    const { error } = await getSupabase().from('conversations').update(patch).eq('id', convo.id);
    if (error) { toast('Could not save: ' + error.message); return false; }
    onChange(patch);
    return true;
  }

  const tags = convo.tags ?? [];

  async function addTag() {
    const t = tagDraft.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 30);
    setTagDraft('');
    if (!t || tags.includes(t)) return;
    await save({ tags: [...tags, t] });
  }

  async function saveNote() {
    if (noteSaved) return;
    if (await save({ contact_note: note.trim() || null })) setNoteSaved(true);
  }

  const label = nameOf(convo);
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');

  return (
    <aside className="panel info">
      <header className="info-head">
        <span>Contact</span>
        <button className="icon" onClick={onClose} title="Close (Esc)">×</button>
      </header>

      <div className="info-body">
        <div className="info-who">
          <span className="avatar big" style={{ background: avatarFor(convo.id) }}>{initials(label)}</span>
          <strong>{label}</strong>
          {convo.contact_handle && convo.contact_handle !== label && <span className="dim">{convo.contact_handle}</span>}
        </div>

        <dl className="facts">
          <dt>Channel</dt><dd>{channelLabel(convo.channel)}</dd>
          <dt>Chat id</dt><dd className="mono">{convo.external_chat_id}</dd>
          <dt>First seen</dt><dd>{fmt(convo.created_at)}</dd>
          <dt>Last message from them</dt><dd>{fmt(convo.last_customer_at)}</dd>
          <dt>Messages</dt><dd>{count ?? '…'}</dd>
          <dt>Assigned to</dt><dd>{convo.assigned_to ? staffName(convo.assigned_to) : 'Nobody'}</dd>
          <dt>Status</dt><dd>{convo.status === 'resolved' ? `Resolved ${fmt(convo.resolved_at)}` : 'Open'}</dd>
        </dl>

        <label className="info-label">Tags</label>
        <div className="tag-edit">
          {tags.map((t) => (
            <span key={t} className="tag">
              {t}
              <button onClick={() => save({ tags: tags.filter((x) => x !== t) })} title="Remove tag">×</button>
            </span>
          ))}
          <input value={tagDraft} placeholder="Add tag…" onChange={(e) => setTagDraft(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(); } }}
                 onBlur={addTag} />
        </div>

        <label className="info-label" htmlFor="contact-note">
          Note for the team {!noteSaved && <span className="dim">· unsaved</span>}
        </label>
        <textarea id="contact-note" className="info-note" rows={5} value={note}
                  placeholder="VIP, prefers English, refund approved on 3 May…"
                  onChange={(e) => { setNote(e.target.value); setNoteSaved(false); }}
                  onBlur={saveNote} />
      </div>
    </aside>
  );
}
