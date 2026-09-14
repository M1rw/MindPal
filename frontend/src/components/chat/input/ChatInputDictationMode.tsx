import React, { type KeyboardEvent } from 'react';
import { ArrowUp, Square, X } from 'lucide-react';

interface ChatInputDictationModeProps {
  input: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  handleKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  audioVolume: number;
  hasText: boolean;
  onChangeInput: (value: string) => void;
  onCancelDictation: () => void;
  onConfirmDictation: () => void;
  onConfirmAndSendDictation: () => void;
}

export const ChatInputDictationMode: React.FC<ChatInputDictationModeProps> = ({
  input,
  textareaRef,
  handleKeyDown,
  audioVolume,
  hasText,
  onChangeInput,
  onCancelDictation,
  onConfirmDictation,
  onConfirmAndSendDictation,
}) => (
  <div className="flex flex-col w-full px-2.5 py-1 sm:px-3 animate-fade-in">
    <textarea
      id="chat-input"
      ref={textareaRef}
      rows={1}
      dir="auto"
      value={input}
      onChange={(e) => onChangeInput(e.target.value)}
      onKeyDown={handleKeyDown}
      className="w-full bg-transparent resize-none outline-none max-h-[160px] px-2 pt-1 pb-2 text-md sm:text-base opacity-65 text-content-primary placeholder-content-muted leading-relaxed min-h-[42px] transition-opacity"
      placeholder="Listening..."
      aria-label="Listening to your voice"
    />

    <div className="flex items-center justify-between w-full pt-1 pb-1 px-0.5 gap-3">
      <button
        type="button"
        onClick={onCancelDictation}
        className="voice-action-btn w-9 h-9 min-w-[36px] min-h-[36px] max-w-[36px] max-h-[36px] !min-h-[36px] aspect-square rounded-full flex items-center justify-center bg-black/5 dark:bg-white/10 text-content-secondary hover:bg-black/10 dark:hover:bg-white/20 hover:text-content-primary transition-colors active:scale-95 flex-shrink-0 p-0"
        title="Cancel dictation"
        aria-label="Cancel dictation"
      >
        <X className="w-4 h-4" />
      </button>

      <div className="flex-1 flex items-center justify-center gap-[3px] mx-2 h-8 overflow-hidden">
        {[...Array(28)].map((_, i) => {
          const centerDist = Math.abs(i - 13.5) / 13.5;
          const envelope = Math.max(0.2, 1 - centerDist * 0.7);
          const isActive = audioVolume > 3;
          const barHeight = isActive
            ? Math.max(
                3,
                Math.min(
                  22,
                  3 + (audioVolume / 100) * 19 * envelope * (0.4 + 0.6 * Math.sin(i * 0.7))
                )
              )
            : 3;

          return (
            <span
              key={i}
              className={`rounded-full transition-all duration-75 ${
                isActive && barHeight > 4
                  ? 'w-[3px] bg-brand-primary dark:bg-white'
                  : 'w-[3px] h-[3px] bg-edge-hover'
              }`}
              style={{ height: `${barHeight}px` }}
            />
          );
        })}
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          type="button"
          onClick={onConfirmDictation}
          className="voice-action-btn w-9 h-9 min-w-[36px] min-h-[36px] max-w-[36px] max-h-[36px] !min-h-[36px] aspect-square rounded-full flex items-center justify-center bg-black/5 dark:bg-white/10 text-content-secondary hover:bg-black/10 dark:hover:bg-white/20 transition-colors active:scale-95 flex-shrink-0 p-0"
          title="Done dictating"
          aria-label="Done dictating"
        >
          <Square className="w-3.5 h-3.5 fill-current" />
        </button>

        <button
          type="button"
          onClick={onConfirmAndSendDictation}
          disabled={!hasText}
          className="voice-action-btn w-9 h-9 min-w-[36px] min-h-[36px] max-w-[36px] max-h-[36px] !min-h-[36px] aspect-square rounded-full flex items-center justify-center bg-brand-primary hover:bg-brand-hover text-white transition-colors active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed shadow-sm flex-shrink-0 p-0"
          title="Send message"
          aria-label="Send message"
        >
          <ArrowUp className="w-4 h-4 stroke-[2.5]" />
        </button>
      </div>
    </div>
  </div>
);
