import { useState } from 'react';
import { useTrackerStore } from '@/state/useTrackerStore';
import { commentThreads } from '@/state/selectors';
import { SIDE_LABELS, type CommentKind, type ShotComment, type ShotRow, type Side } from '@/state/schema';
import { stampTime } from '@/lib/format';
import { useIdentity } from '@/components/ui/hooks';

/**
 * Notes and concerns on one shot. A concern stays open — counted on the
 * overview, flagged on the tile — until someone resolves it; a note is for
 * information. An executive's comments default to concerns.
 */
export function CommentThread({ row }: { row: ShotRow }) {
  const identity = useIdentity();
  const addComment = useTrackerStore((s) => s.addComment);
  const setResolved = useTrackerStore((s) => s.setCommentResolved);
  const [text, setText] = useState('');
  const [kind, setKind] = useState<CommentKind>(identity?.role === 'executive' ? 'concern' : 'note');
  const [side, setSide] = useState<Side | null>(row.usage === 'mag' || row.usage === 'pr' ? row.usage : null);

  const threads = commentThreads(row);
  const post = () => {
    if (!text.trim()) return;
    addComment(row.id, { kind, text, side });
    setText('');
  };

  return (
    <div className="comments">
      {threads.length === 0 && <p className="muted small">No comments yet.</p>}
      {threads.map(({ comment, replies }) => (
        <Thread key={comment.id} rowId={row.id} comment={comment} replies={replies} onResolve={(r) => setResolved(row.id, comment.id, r)} />
      ))}

      <div className="compose">
        <textarea
          className="field"
          rows={2}
          placeholder={kind === 'concern' ? 'Raise a concern for the team…' : 'Add a note…'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) post();
          }}
        />
        <div className="compose-row">
          <div className="segmented segmented-sm">
            <button className={kind === 'concern' ? 'seg-active' : ''} onClick={() => setKind('concern')}>
              Concern
            </button>
            <button className={kind === 'note' ? 'seg-active' : ''} onClick={() => setKind('note')}>
              Note
            </button>
          </div>
          <select className="field field-select field-sm" value={side ?? ''} onChange={(e) => setSide((e.target.value || null) as Side | null)}>
            <option value="">Whole shot</option>
            <option value="mag">Magazine</option>
            <option value="pr">Press release</option>
          </select>
          <button className="btn btn-primary btn-sm" disabled={!text.trim()} onClick={post}>
            Post
          </button>
        </div>
      </div>
    </div>
  );
}

function Thread({
  rowId,
  comment,
  replies,
  onResolve,
}: {
  rowId: string;
  comment: ShotComment;
  replies: ShotComment[];
  onResolve: (resolved: boolean) => void;
}) {
  const addComment = useTrackerStore((s) => s.addComment);
  const [reply, setReply] = useState('');
  const [replying, setReplying] = useState(false);
  const isConcern = comment.kind === 'concern';

  return (
    <div className={`thread ${isConcern ? (comment.resolved ? 'thread-resolved' : 'thread-open') : ''}`}>
      <CommentBody comment={comment} />
      {replies.map((r) => (
        <div key={r.id} className="reply">
          <CommentBody comment={r} />
        </div>
      ))}
      {isConcern && comment.resolved && (
        <p className="muted small">
          Resolved by {comment.resolvedBy || 'someone'} · {stampTime(comment.resolvedAt)}
        </p>
      )}

      {replying ? (
        <div className="compose compose-reply">
          <textarea className="field" rows={2} autoFocus value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply…" />
          <div className="compose-row">
            <button className="btn btn-ghost btn-sm" onClick={() => setReplying(false)}>
              Cancel
            </button>
            {isConcern && !comment.resolved && (
              <button
                className="btn btn-sm"
                disabled={!reply.trim()}
                onClick={() => {
                  addComment(rowId, { kind: 'note', text: reply, side: comment.side, replyTo: comment.id });
                  onResolve(true);
                  setReply('');
                  setReplying(false);
                }}
              >
                Reply &amp; resolve
              </button>
            )}
            <button
              className="btn btn-primary btn-sm"
              disabled={!reply.trim()}
              onClick={() => {
                addComment(rowId, { kind: 'note', text: reply, side: comment.side, replyTo: comment.id });
                setReply('');
                setReplying(false);
              }}
            >
              Reply
            </button>
          </div>
        </div>
      ) : (
        <div className="thread-actions">
          <button className="link-btn" onClick={() => setReplying(true)}>
            Reply
          </button>
          {isConcern && (
            <button className="link-btn" onClick={() => onResolve(!comment.resolved)}>
              {comment.resolved ? 'Reopen' : 'Mark resolved'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function CommentBody({ comment }: { comment: ShotComment }) {
  return (
    <>
      <div className="comment-head">
        <strong>{comment.author || 'Someone'}</strong>
        {comment.role === 'executive' && <span className="role-badge">Exec</span>}
        {comment.kind === 'concern' && !comment.replyTo && (
          <span className={`kind-badge ${comment.resolved ? 'kind-resolved' : 'kind-concern'}`}>{comment.resolved ? 'Resolved' : 'Concern'}</span>
        )}
        {comment.side && <span className={`track-label track-label-${comment.side}`}>{SIDE_LABELS[comment.side]}</span>}
        <span className="muted small">{stampTime(comment.at)}</span>
      </div>
      <p className="comment-text">{comment.text}</p>
    </>
  );
}
