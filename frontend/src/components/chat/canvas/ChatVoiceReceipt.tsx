import React, { useId, useState } from 'react';
import { Check, ChevronDown, Copy, Phone } from 'lucide-react';
import { cn } from '../../../utils/ui/cn';
import { formatCallDuration } from '../../../utils/chat/sessionHistory.ts';

interface ChatVoiceReceiptProps {
  htmlContent: string;
  usedS?: number;
  onCopy: () => void;
  copied: boolean;
}

export const ChatVoiceReceipt: React.FC<ChatVoiceReceiptProps> = ({
  htmlContent,
  usedS,
  onCopy,
  copied,
}) => {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const duration = formatCallDuration(usedS);
  const summaryLabel = open ? 'Hide recap' : 'Show recap';
  const name = duration
    ? `Call ended, ${duration}. ${summaryLabel}`
    : `Call ended. ${summaryLabel}`;

  return (
    <div className="chat-call-ended">
      <button
        type="button"
        className="chat-call-ended__toggle"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={name}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="chat-call-ended__rule chat-call-ended__rule--start" aria-hidden="true" />
        <span className="chat-call-ended__label">
          <Phone className="h-3 w-3" aria-hidden="true" />
          <span>Call ended</span>
          {duration ? <span className="chat-call-ended__duration">{duration}</span> : null}
          <ChevronDown
            className={cn('chat-call-ended__chevron h-3 w-3', open && 'is-open')}
            aria-hidden="true"
          />
        </span>
        <span className="chat-call-ended__rule chat-call-ended__rule--end" aria-hidden="true" />
      </button>
      <div
        id={panelId}
        className={cn('chat-call-ended__collapse', open && 'is-open')}
        inert={!open || undefined}
        aria-hidden={!open || undefined}
      >
        <div className="chat-call-ended__collapse-inner">
          <div className="chat-call-ended__panel">
            <div
              dir="auto"
              className="chat-call-ended__body"
              dangerouslySetInnerHTML={{ __html: htmlContent }}
            />
            <button
              type="button"
              onClick={onCopy}
              className={cn('chat-call-ended__copy', copied && 'is-copied')}
              aria-label={copied ? 'Copied recap' : 'Copy recap'}
              tabIndex={open ? undefined : -1}
            >
              {copied ? <Check className="h-3 w-3" aria-hidden="true" /> : <Copy className="h-3 w-3" aria-hidden="true" />}
              <span>{copied ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
