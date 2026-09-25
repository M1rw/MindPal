import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, Check, ChevronDown, Loader2, Mic, Square } from 'lucide-react';
import { POPOVER_EXIT_MS, useOverlayPresence } from '../../../hooks/ui/useOverlayPresence';
import { floatingMenuClass } from '../../../utils/ui/overlay';

type ReplyTier = 'standard' | 'pro';

/* Send / stop / live-voice button: 36px visual on mobile, 40px on sm+.
   44px touch-target is enforced by the .chat-compact-btn CSS rule on
   pointer:coarse devices, so no inline min-w/min-h is needed here. */
const COMPOSER_ACTION_SIZE =
  'w-9 h-9 sm:w-10 sm:h-10 aspect-square flex-shrink-0 flex items-center justify-center';
/* Same hover as the other composer buttons: a small, smooth scale. No lift or
   growing shadow, which the composer pill clipped and which looked like overflow. */
const COMPOSER_ACTION_MOTION =
  'transition-[transform,background-color,color,opacity] duration-200 ease-out hover:scale-105 active:scale-95 motion-reduce:transition-none motion-reduce:hover:scale-100';
const COMPOSER_MUTED_TILE = `bg-surface-elevated dark:bg-edge-default text-content-secondary hover:bg-edge-hover hover:text-content-primary cursor-pointer ${COMPOSER_ACTION_MOTION}`;
const COMPOSER_SEND_TILE = `bg-content-primary text-content-inverse hover:opacity-90 cursor-pointer ${COMPOSER_ACTION_MOTION}`;

function WaveformIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M5 10v4M9.5 5v14M14.5 8v8M19 10v4"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
      />
    </svg>
  );
}

const REPLY_TIERS: ReadonlyArray<{
  id: ReplyTier;
  label: string;
  description: string;
}> = [
  {
    id: 'standard',
    label: 'Standard',
    description: '1 credit per reply.',
  },
  {
    id: 'pro',
    label: 'Pro',
    description: '2 credits per reply. Same model; more complete answers.',
  },
];

interface ChatInputActionsProps {
  hasText: boolean;
  /** A file in the composer is still being read: sending waits. */
  filesReading?: boolean;
  isGenerating: boolean;
  isPro: boolean;
  selectorOpen: boolean;
  selectorRef?: React.RefObject<HTMLDivElement | null>;
  onToggleSelector: () => void;
  onCloseSelector: () => void;
  onSelectStandard: () => void;
  onSelectPro: () => void;
  onStartDictation: () => void;
  onStartLiveVoice?: () => void;
  liveVoiceEnabled?: boolean;
  onStop: () => void;
  onSend: () => void;
}

export const ChatInputActions: React.FC<ChatInputActionsProps> = ({
  hasText,
  filesReading = false,
  isGenerating,
  isPro,
  selectorOpen,
  selectorRef,
  onToggleSelector,
  onCloseSelector,
  onSelectStandard,
  onSelectPro,
  onStartDictation,
  onStartLiveVoice,
  liveVoiceEnabled = false,
  onStop,
  onSend,
}) => {
  const compactHidden = hasText || isGenerating;
  const selectedIndex = isPro ? 1 : 0;
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();
  const selected = REPLY_TIERS[selectedIndex];

  useEffect(() => {
    if (!selectorOpen) return;
    setActiveIndex(selectedIndex);
    const timeoutId = window.setTimeout(() => {
      optionRefs.current[selectedIndex]?.focus();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [selectorOpen, selectedIndex]);

  useEffect(() => {
    if (!selectorOpen) return;
    optionRefs.current[activeIndex]?.focus();
  }, [activeIndex, selectorOpen]);

  useEffect(() => {
    if (!selectorOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseSelector();
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selectorOpen, onCloseSelector]);

  const selectTier = (tier: ReplyTier) => {
    if (isGenerating) return;
    if (tier === 'pro') onSelectPro();
    else onSelectStandard();
  };

  const onListboxKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % REPLY_TIERS.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + REPLY_TIERS.length) % REPLY_TIERS.length);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(REPLY_TIERS.length - 1);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectTier(REPLY_TIERS[activeIndex].id);
      return;
    }
    if (event.key === 'Tab') {
      onCloseSelector();
    }
  };

  const [menuPos, setMenuPos] = useState<{ bottom: number; right: number } | null>(null);
  const menuOpen = selectorOpen && !compactHidden;
  const { mounted: menuMounted, visible: menuVisible } = useOverlayPresence(menuOpen, POPOVER_EXIT_MS);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    const update = () => {
      const el = buttonRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // Fix 7: use visualViewport.height (shrinks when keyboard opens) instead of
      // window.innerHeight (which stays constant on iOS/Android), so the menu
      // always appears above the virtual keyboard rather than behind it.
      const viewportH = window.visualViewport?.height ?? window.innerHeight;
      setMenuPos({
        bottom: viewportH - rect.top + 8,
        right: Math.max(12, window.innerWidth - rect.right),
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    // Reposition when the virtual keyboard animates in/out on mobile.
    window.visualViewport?.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, [menuOpen]);

  const menu =
    menuMounted && menuPos
      ? createPortal(
          <div
            id={listboxId}
            className={floatingMenuClass(
              menuVisible,
              'chat-mode-menu w-72 bg-surface-card border border-edge-subtle rounded-xl shadow-modal p-1.5'
            )}
            style={{ bottom: menuPos.bottom, right: menuPos.right }}
            role="listbox"
            aria-label="Reply mode"
            aria-activedescendant={`${listboxId}-${REPLY_TIERS[activeIndex].id}`}
            tabIndex={-1}
            onKeyDown={onListboxKeyDown}
          >
            {REPLY_TIERS.map((tier, index) => {
              const isSelected = selected.id === tier.id;
              return (
                <button
                  key={tier.id}
                  type="button"
                  id={`${listboxId}-${tier.id}`}
                  role="option"
                  aria-selected={isSelected}
                  tabIndex={activeIndex === index ? 0 : -1}
                  ref={(node) => {
                    optionRefs.current[index] = node;
                  }}
                  onClick={() => selectTier(tier.id)}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-left transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary ${
                    index > 0 ? 'mt-1' : ''
                  } ${isSelected ? 'bg-surface-subtle' : 'hover:bg-surface-subtle/60'}`}
                >
                  <div>
                    <div className="text-sm font-medium text-content-primary">{tier.label}</div>
                    <div className="text-xs text-content-secondary mt-0.5">{tier.description}</div>
                  </div>
                  {isSelected && <Check className="w-4 h-4 text-brand-primary flex-shrink-0" />}
                </button>
              );
            })}
          </div>,
          document.body
        )
      : null;

  return (
    <div className="flex items-center gap-1.5 pr-1 self-center">
      <div
        ref={selectorRef}
        className={`flex items-center gap-1 transition-all duration-200 ease-out ${
          compactHidden
            ? 'max-w-0 opacity-0 overflow-hidden pointer-events-none'
            : 'max-w-[320px] opacity-100'
        }`}
        aria-hidden={compactHidden}
        inert={compactHidden}
      >
        <div className="relative flex items-center">
          <button
            type="button"
            id="model-selector-btn"
            ref={buttonRef}
            onClick={() => {
              if (isGenerating) return;
              onToggleSelector();
            }}
            onKeyDown={(event) => {
              if (isGenerating) return;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (!selectorOpen) onToggleSelector();
              }
            }}
            disabled={isGenerating}
            aria-haspopup="listbox"
            aria-expanded={selectorOpen}
            aria-controls={listboxId}
            aria-label={`Reply mode: ${selected.label}`}
            className="chat-compact-btn flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-sm font-medium text-content-secondary hover:text-content-primary hover:bg-surface-elevated transition-all duration-200 ease-out hover:scale-[1.03] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary disabled:opacity-50 disabled:pointer-events-none cursor-pointer"
          >
            <span>{selected.label}</span>
            <ChevronDown
              className={`w-3.5 h-3.5 text-content-muted transition-transform duration-150 ease-out ${
                selectorOpen ? 'rotate-180' : ''
              }`}
            />
          </button>
          {menu}
        </div>

        <button
          type="button"
          onClick={onStartDictation}
          className="chat-compact-btn w-8 h-8 flex items-center justify-center rounded-xl text-content-secondary hover:text-content-primary hover:bg-surface-elevated transition-all duration-200 ease-out hover:scale-110 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary cursor-pointer"
          title="Dictate with your microphone"
          aria-label="Dictate with your microphone"
        >
          <Mic className="w-4 h-4" />
        </button>
      </div>

      <PrimaryComposerAction
        hasText={hasText}
        filesReading={filesReading}
        isGenerating={isGenerating}
        liveVoiceEnabled={liveVoiceEnabled}
        onStartLiveVoice={onStartLiveVoice}
        onStop={onStop}
        onSend={onSend}
      />
    </div>
  );
};

function PrimaryComposerAction({
  hasText,
  filesReading,
  isGenerating,
  liveVoiceEnabled,
  onStartLiveVoice,
  onStop,
  onSend,
}: {
  hasText: boolean;
  filesReading: boolean;
  isGenerating: boolean;
  liveVoiceEnabled: boolean;
  onStartLiveVoice?: () => void;
  onStop: () => void;
  onSend: () => void;
}) {
  const mode: 'stop' | 'send' | 'reading' | 'live' = isGenerating
    ? 'stop'
    : filesReading
      ? 'reading'
      : hasText
        ? 'send'
        : 'live';
  const liveAvailable = Boolean(liveVoiceEnabled && onStartLiveVoice);
  const disabled = (mode === 'live' && !liveAvailable) || mode === 'reading';
  const label =
    mode === 'stop'
      ? 'Stop generating'
      : mode === 'reading'
        ? 'Reading your file'
        : mode === 'send'
        ? 'Send message'
        : liveAvailable
          ? 'Start live voice'
          : 'Live voice unavailable';
  const title = mode === 'stop' ? 'Stop generating' : mode === 'send' ? 'Send' : label;

  return (
    <button
      id="action-btn"
      type="button"
      disabled={disabled}
      onClick={() => {
        if (mode === 'stop') onStop();
        else if (mode === 'send') onSend();
        else onStartLiveVoice?.();
      }}
      className={`${COMPOSER_ACTION_SIZE} rounded-full focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none ${
        mode === 'send'
          ? COMPOSER_SEND_TILE
          : `${COMPOSER_MUTED_TILE}${
              mode === 'live'
                ? ' disabled:pointer-events-none disabled:hover:bg-edge-default disabled:hover:text-content-secondary'
                : ''
            }`
      }`}
      aria-label={label}
      title={title}
    >
      {mode === 'stop' ? (
        <Square className="w-3.5 h-3.5 fill-current" />
      ) : mode === 'reading' ? (
        <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" />
      ) : mode === 'send' ? (
        <ArrowUp className="w-4 h-4 sm:w-5 sm:h-5" />
      ) : (
        <WaveformIcon className="w-4 h-4 sm:w-5 sm:h-5" />
      )}
    </button>
  );
}
