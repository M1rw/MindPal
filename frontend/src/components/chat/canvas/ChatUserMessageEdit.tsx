import React, { useEffect, useLayoutEffect, useRef, useState, KeyboardEvent } from 'react';
import { cn } from '../../../utils/ui/cn';

interface ChatUserMessageEditProps {
  messageId: string;
  initialValue: string;
  hasLaterReplies: boolean;
  onCancel: () => void;
  onSave: (id: string, content: string) => void;
}

export const ChatUserMessageEdit: React.FC<ChatUserMessageEditProps> = ({
  messageId,
  initialValue,
  hasLaterReplies,
  onCancel,
  onSave,
}) => {
  const [value, setValue] = useState(initialValue);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const trimmed = value.trim();
  const canSend = trimmed.length > 0;

  const fitHeight = () => {
    const el = fieldRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 256)}px`;
  };

  useLayoutEffect(() => {
    fitHeight();
  }, []);

  useEffect(() => {
    const el = fieldRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (canSend) onSave(messageId, trimmed);
    }
  };

  return (
    <div className="chat-user-edit" role="group" aria-label="Edit message">
      <textarea
        ref={fieldRef}
        dir="auto"
        spellCheck={false}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          window.requestAnimationFrame(fitHeight);
        }}
        onKeyDown={handleKeyDown}
        className="chat-user-edit__field custom-scrollbar w-full resize-none bg-transparent text-start text-base leading-relaxed text-content-primary outline-none"
        aria-label="Edit message"
        aria-describedby={hasLaterReplies ? `edit-hint-${messageId}` : undefined}
      />
      <div className="chat-user-edit__bar">
        {hasLaterReplies ? (
          <p id={`edit-hint-${messageId}`} className="chat-user-edit__hint">
            Later replies stay until you send.
          </p>
        ) : (
          <span />
        )}
        <div className="chat-user-edit__actions">
          <button
            type="button"
            onClick={onCancel}
            className="chat-user-edit__cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => canSend && onSave(messageId, trimmed)}
            disabled={!canSend}
            className={cn('chat-user-edit__send', !canSend && 'is-disabled')}
            title={
              hasLaterReplies
                ? 'Send this instead — later replies in this thread will be removed.'
                : 'Send'
            }
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
};
