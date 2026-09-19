import React, { useState, useEffect, useRef } from 'react';
import { ApiClient } from '../../../services/api/index';
import type { MemoryReceipt } from '../../../types';
import { cn } from '../../../utils/ui/cn';
import { useOverlayPresence } from '../../../hooks/ui/useOverlayPresence';

interface ChatMemoryReceiptProps {
  receipt: MemoryReceipt;
  active?: boolean;
  onReview: () => void;
  onDismiss: () => void;
}

const HOLD_MS = 7000;
const FADE_MS = 180;

function receiptSummary(receipt: MemoryReceipt): string {
  const labels = receipt.saved.map((item) => item.text).filter(Boolean);
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} · ${labels[1]}`;
  return `${labels[0]} and ${labels.length - 1} more`;
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export const ChatMemoryReceipt: React.FC<ChatMemoryReceiptProps> = ({
  receipt,
  active = true,
  onReview,
  onDismiss,
}) => {
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const { mounted, visible } = useOverlayPresence(open && active, FADE_MS);
  const interactingRef = useRef(false);
  const holdTimerRef = useRef<number | null>(null);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const summary = receiptSummary(receipt);

  const clearHold = () => {
    if (holdTimerRef.current != null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };

  const requestClose = () => {
    if (!open) return;
    if (prefersReducedMotion()) {
      onDismissRef.current();
      return;
    }
    setOpen(false);
  };

  const scheduleHold = () => {
    clearHold();
    holdTimerRef.current = window.setTimeout(() => {
      if (interactingRef.current || undoing || error) return;
      requestClose();
    }, HOLD_MS);
  };

  useEffect(() => {
    if (!open || !active || undoing || error) {
      clearHold();
      return;
    }
    scheduleHold();
    return clearHold;
  }, [open, active, undoing, error]);

  useEffect(() => {
    if (open && active) return;
    if (prefersReducedMotion()) {
      onDismissRef.current();
    }
  }, [open, active]);

  useEffect(() => {
    if (mounted) return;
    if (open && active) return;
    onDismissRef.current();
  }, [open, active, mounted]);

  if (!summary || !mounted) return null;

  const handleUndo = async () => {
    if (undoing) return;
    setUndoing(true);
    setError(null);
    try {
      await Promise.all(receipt.saved.map((item) => ApiClient.deleteMemoryGraphItem(item.id)));
      requestClose();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not undo. Review memory to edit.');
    } finally {
      setUndoing(false);
    }
  };

  const onInteractStart = () => {
    interactingRef.current = true;
    clearHold();
    if (!open && !prefersReducedMotion()) setOpen(true);
  };

  const onInteractEnd = () => {
    interactingRef.current = false;
    if (open && active && !undoing && !error) scheduleHold();
  };

  return (
    <div
      className={cn('memory-receipt', !visible && 'memory-receipt--out')}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      onMouseEnter={onInteractStart}
      onMouseLeave={onInteractEnd}
      onFocusCapture={onInteractStart}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          onInteractEnd();
        }
      }}
    >
      <p className="memory-receipt__copy">
        <span className="sr-only">Saved to memory. </span>
        <span className="memory-receipt__mark" aria-hidden="true">
          Saved
        </span>{' '}
        <span className="memory-receipt__fact">{summary}</span>
      </p>
      <div className="memory-receipt__actions">
        <button type="button" onClick={onReview} className="memory-receipt__action" aria-label="Review memory">
          Review
        </button>
        <button
          type="button"
          onClick={() => {
            void handleUndo();
          }}
          disabled={undoing}
          className="memory-receipt__action"
          aria-label={undoing ? 'Undoing memory save' : 'Undo save to memory'}
        >
          {undoing ? 'Undoing…' : 'Undo'}
        </button>
      </div>
      {error ? <p className="memory-receipt__error">{error}</p> : null}
    </div>
  );
};
