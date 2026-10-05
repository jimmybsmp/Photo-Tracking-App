import { useState } from 'react';
import { getIdentity, setIdentity } from '@/lib/identity';
import type { Role } from '@/state/schema';
import { Modal } from '@/components/ui/Modal';

/**
 * "Who are you?" — asked once per machine. Every stage someone marks and
 * every comment they write carries this name, which is what makes progress
 * accountable across sites: "QC ✓ · Jo, 14:02".
 */
export function IdentityDialog({ onDone, required }: { onDone: () => void; required: boolean }) {
  const current = getIdentity();
  const [name, setName] = useState(current?.name ?? '');
  const [role, setRole] = useState<Role>(current?.role ?? 'staff');

  const submit = () => {
    if (!name.trim()) return;
    setIdentity({ name: name.trim(), role });
    onDone();
  };

  return (
    <Modal as="form" title={required ? 'Welcome to PhotoTrack' : 'Your name'} onClose={required ? undefined : onDone} onSubmit={submit}>
      <p className="muted">
        Your name goes on every stage you mark and every comment you write, so everyone — at every site — can see
        who did what, and when.
      </p>
      <label className="field-label">
        <span>Name</span>
        <input className="field" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Jo Martin" />
      </label>
      <div className="field-label">
        <span>Role</span>
        <div className="segmented">
          <button type="button" className={role === 'staff' ? 'seg-active' : ''} onClick={() => setRole('staff')}>
            Production staff
          </button>
          <button type="button" className={role === 'executive' ? 'seg-active' : ''} onClick={() => setRole('executive')}>
            Executive
          </button>
        </div>
        <span className="muted small">
          An executive's comments default to concerns, which stay open until someone on the team resolves them.
        </span>
      </div>
      <div className="modal-actions">
        {!required && (
          <button type="button" className="btn" onClick={onDone}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn btn-primary" disabled={!name.trim()}>
          {required ? 'Start' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}
