import React, { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../../../utils/ui/cn';

export type ComposerActivity =
  | 'dictating'
  | 'generating'
  | 'editing'
  | 'typing'
  | 'guest-empty'
  | 'empty'
  | 'guest-thread'
  | 'thread';

export const COMPOSER_NOTICE_LINES: Record<ComposerActivity, readonly string[]> = {
  empty: [
    'MindPal is a wellness companion, not a medical service.',
    'A place to think out loud — not a diagnosis.',
    'Take what helps. Leave the rest.',
  ],
  'guest-empty': [
    'Guest chats stay on this device until you sign in.',
    'MindPal is a wellness companion, not a medical service.',
    'Sign in if you want this conversation on your account.',
  ],
  typing: [
    'Send when you’re ready. This is not emergency care.',
    'You can still edit before you send.',
    'MindPal is a wellness companion, not a medical service.',
  ],
  dictating: [
    'Dictation uses this device’s mic — check the text before sending.',
    'Still a wellness chat, not a medical service.',
  ],
  editing: [
    'Sending this replaces later replies in this thread.',
    'Cancel keeps the conversation as it is.',
  ],
  generating: [
    'Replies are support, not a diagnosis.',
    'You can stop this reply at any time.',
    'If this is an emergency, use local crisis services.',
  ],
  thread: [
    'MindPal is a wellness companion, not a medical service.',
    'Saved memory can be reviewed or deleted in Settings.',
    'Not a substitute for professional care.',
  ],
  'guest-thread': [
    'This thread stays on this device until you sign in.',
    'MindPal is a wellness companion, not a medical service.',
    'Not a substitute for professional care.',
  ],
};

const CANONICAL_DISCLAIMER = COMPOSER_NOTICE_LINES.empty[0];
const ROTATE_MS = 14000;
const CROSSFADE_MS = 280;

export function resolveComposerActivity(input: {
  hasMessages: boolean;
  hasText: boolean;
  isDictating: boolean;
  isGenerating: boolean;
  isEditing?: boolean;
  isAuthenticated: boolean;
}): ComposerActivity {
  if (input.isDictating) return 'dictating';
  if (input.isGenerating) return 'generating';
  if (input.isEditing) return 'editing';
  if (input.hasText) return 'typing';
  if (!input.hasMessages) return input.isAuthenticated ? 'empty' : 'guest-empty';
  return input.isAuthenticated ? 'thread' : 'guest-thread';
}

function pickLine(activity: ComposerActivity, previous?: string): string {
  const pool = COMPOSER_NOTICE_LINES[activity];
  const choices = pool.filter((line) => line !== previous);
  const source = choices.length > 0 ? choices : pool;
  return source[Math.floor(Math.random() * source.length)];
}

function canIdleRotate(activity: ComposerActivity): boolean {
  return activity === 'empty' || activity === 'guest-empty' || activity === 'thread' || activity === 'guest-thread';
}

interface ComposerNoticeProps {
  hasMessages: boolean;
  hasText: boolean;
  isDictating: boolean;
  isGenerating: boolean;
  isEditing?: boolean;
  isAuthenticated: boolean;
}

export const ComposerNotice: React.FC<ComposerNoticeProps> = ({
  hasMessages,
  hasText,
  isDictating,
  isGenerating,
  isEditing = false,
  isAuthenticated,
}) => {
  const activity = resolveComposerActivity({
    hasMessages,
    hasText,
    isDictating,
    isGenerating,
    isEditing,
    isAuthenticated,
  });
  const activityRef = useRef(activity);
  const [line, setLine] = useState(() => pickLine(activity));
  const [phase, setPhase] = useState<'in' | 'out'>('in');
  const lineRef = useRef(line);
  const pendingRef = useRef<string | null>(null);
  lineRef.current = line;

  const swapTo = useCallback((next: string) => {
    if (next === lineRef.current && !pendingRef.current) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      pendingRef.current = null;
      setLine(next);
      setPhase('in');
      return;
    }
    pendingRef.current = next;
    setPhase('out');
  }, []);

  useEffect(() => {
    if (activityRef.current === activity) return;
    activityRef.current = activity;
    swapTo(pickLine(activity, lineRef.current));
  }, [activity, swapTo]);

  useEffect(() => {
    if (!canIdleRotate(activity)) return;
    const id = window.setInterval(() => {
      swapTo(pickLine(activity, lineRef.current));
    }, ROTATE_MS);
    return () => window.clearInterval(id);
  }, [activity, swapTo]);

  useEffect(() => {
    if (phase !== 'out') return;
    const id = window.setTimeout(() => {
      const next = pendingRef.current;
      if (!next) {
        setPhase('in');
        return;
      }
      pendingRef.current = null;
      setLine(next);
      setPhase('in');
    }, CROSSFADE_MS);
    return () => window.clearTimeout(id);
  }, [phase]);

  return (
    <>
      <p className="sr-only">{CANONICAL_DISCLAIMER}</p>
      <p
        className={cn('composer-notice', phase === 'out' && 'composer-notice--out')}
        aria-hidden="true"
      >
        {line}
      </p>
    </>
  );
};
