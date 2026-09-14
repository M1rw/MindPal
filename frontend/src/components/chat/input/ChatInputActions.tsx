import React from 'react';
import { ArrowUp, AudioWaveform, Check, ChevronDown, Mic, Square } from 'lucide-react';

interface ChatInputActionsProps {
  hasText: boolean;
  isGenerating: boolean;
  isPro: boolean;
  selectorOpen: boolean;
  selectorRef?: React.RefObject<HTMLDivElement | null>;
  onToggleSelector: () => void;
  onSelectStandard: () => void;
  onSelectPro: () => void;
  onStartDictation: () => void;
  onToggleGenerateOrVoice: () => void;
}

export const ChatInputActions: React.FC<ChatInputActionsProps> = ({
  hasText,
  isGenerating,
  isPro,
  selectorOpen,
  selectorRef,
  onToggleSelector,
  onSelectStandard,
  onSelectPro,
  onStartDictation,
  onToggleGenerateOrVoice,
}) => (
  <div className="flex items-center gap-1.5 pr-0.5 pb-0.5 self-end">
    <div
      ref={selectorRef}
      className={`flex items-center gap-1 transition-all duration-300 ease-out ${
        hasText
          ? 'max-w-0 opacity-0 overflow-hidden pointer-events-none -translate-x-1'
          : 'max-w-[320px] opacity-100 translate-x-0'
      }`}
    >
      <div className="relative flex items-center">
        <button
          type="button"
          id="model-selector-btn"
          onClick={onToggleSelector}
          className="chat-compact-btn flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-sm font-medium text-content-secondary hover:text-content-primary hover:bg-surface-elevated transition-all"
        >
          <span>{isPro ? 'Pro' : 'Standard'}</span>
          {isPro && (
            <span className="bg-brand-subtle text-brand-primary text-2xs px-1.5 py-0.5 rounded font-bold uppercase tracking-wider">
              PRO
            </span>
          )}
          <ChevronDown
            className={`w-3.5 h-3.5 text-content-muted transition-transform duration-150 ${
              selectorOpen ? 'rotate-180' : ''
            }`}
          />
        </button>

        {selectorOpen && (
          <div
            id="unified-dropdown"
            className="absolute bottom-full right-0 mb-2 w-72 bg-surface-card border border-edge-subtle rounded-xl specular-card shadow-modal p-1.5 z-50 animate-scale-in"
            role="menu"
          >
            <button
              type="button"
              onClick={onSelectStandard}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-left transition-colors ${
                !isPro ? 'bg-surface-subtle' : 'hover:bg-surface-subtle/60'
              }`}
            >
              <div>
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-content-primary">Standard</span>
                  <span className="text-2xs font-semibold text-content-muted bg-surface-sunken px-1.5 py-0.5 rounded">
                    1x
                  </span>
                </div>
                <div className="text-xs text-content-secondary mt-0.5">
                  Warm peer support. Fast, safe & lightweight.
                </div>
              </div>
              {!isPro && <Check className="w-4 h-4 text-brand-primary flex-shrink-0" />}
            </button>

            <button
              type="button"
              onClick={onSelectPro}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-left transition-colors mt-1 ${
                isPro ? 'bg-surface-subtle' : 'hover:bg-surface-subtle/60'
              }`}
            >
              <div>
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-content-primary">Pro</span>
                  <span className="bg-brand-subtle text-brand-primary text-2xs px-1.5 py-0.5 rounded font-bold uppercase tracking-wider">
                    PRO · 2X
                  </span>
                </div>
                <div className="text-xs text-content-secondary mt-0.5">
                  Clinical reasoning & deep analysis. Uses 2x compute.
                </div>
              </div>
              {isPro && <Check className="w-4 h-4 text-brand-primary flex-shrink-0" />}
            </button>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onStartDictation}
        className="chat-compact-btn w-8 h-8 flex items-center justify-center rounded-xl text-content-secondary hover:text-content-primary hover:bg-surface-elevated transition-colors"
        title="Start voice dictation"
        aria-label="Voice dictation"
      >
        <Mic className="w-4 h-4" />
      </button>
    </div>

    <button
      id="action-btn"
      type="button"
      onClick={onToggleGenerateOrVoice}
      className={`w-9 h-9 sm:w-10 sm:h-10 min-w-[36px] min-h-[36px] sm:min-w-[40px] sm:min-h-[40px] aspect-square flex-shrink-0 flex items-center justify-center rounded-full transition-all duration-150 focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none ${
        isGenerating
          ? 'bg-surface-sunken text-content-primary hover:bg-edge-default'
          : hasText
          ? 'bg-content-primary text-content-inverse shadow-sm hover:opacity-90 active:scale-95'
          : 'bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/20 text-content-primary'
      }`}
      aria-label={
        isGenerating ? 'Stop generating' : hasText ? 'Send message' : 'Open live voice conversation'
      }
      title={isGenerating ? 'Stop generating' : hasText ? 'Send' : 'Live Voice Mode'}
    >
      {isGenerating ? (
        <Square className="w-3.5 h-3.5 fill-current" />
      ) : hasText ? (
        <ArrowUp className="w-4 h-4 sm:w-5 sm:h-5" />
      ) : (
        <AudioWaveform className="w-4 h-4 sm:w-5 sm:h-5 text-content-secondary" />
      )}
    </button>
  </div>
);
