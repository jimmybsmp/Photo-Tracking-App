import { useEffect, useRef, type FormEvent, type ReactNode } from 'react';

/**
 * A dialog. It closes from its ✕, from Escape, or from a click that both
 * starts and ends on the dimmed backdrop — never from a click that merely
 * *ends* there. A browser fires `click` on the nearest common ancestor when
 * the press and the release land on different elements, so with a plain
 * `onClick` on the backdrop, clicking into a field and letting go a few
 * pixels outside the panel (easy on a trackpad) shut the whole dialog.
 */
export function Modal({
  title,
  children,
  onClose,
  wide,
  as = 'div',
  onSubmit,
}: {
  title: ReactNode;
  children: ReactNode;
  /** Omit to make the dialog impossible to dismiss (a required first step). */
  onClose?: () => void;
  wide?: boolean;
  as?: 'div' | 'form';
  onSubmit?: () => void;
}) {
  const pressedOnBackdrop = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && closeRef.current) {
        e.stopPropagation();
        closeRef.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const Panel = as;
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        pressedOnBackdrop.current = e.target === e.currentTarget;
      }}
      onMouseUp={(e) => {
        if (pressedOnBackdrop.current && e.target === e.currentTarget) onClose?.();
        pressedOnBackdrop.current = false;
      }}
    >
      <Panel
        className={`modal ${wide ? 'modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        onSubmit={
          onSubmit
            ? (e: FormEvent) => {
                e.preventDefault();
                onSubmit();
              }
            : undefined
        }
      >
        <div className="modal-header">
          <h2>{title}</h2>
          {onClose && (
            <button type="button" className="icon-btn" onClick={onClose} title="Close (Esc)">
              ✕
            </button>
          )}
        </div>
        {children}
      </Panel>
    </div>
  );
}
