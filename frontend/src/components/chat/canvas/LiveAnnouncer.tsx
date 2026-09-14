import React, { useEffect, useState, useRef } from 'react';
import { useChatStore } from '../../../store';

/**
 * WCAG 2.1 Screen Reader Live Announcer
 * Exposes real-time streaming updates and status transitions to assistive technology via an aria-live region.
 */
export const LiveAnnouncer: React.FC = () => {
  const isGenerating = useChatStore((s) => s.isGenerating);
  const messages = useChatStore((s) => s.messages);
  const [announcement, setAnnouncement] = useState('');
  const prevGeneratingRef = useRef(isGenerating);

  useEffect(() => {
    if (isGenerating && !prevGeneratingRef.current) {
      setAnnouncement('MindPal is generating a response...');
    } else if (!isGenerating && prevGeneratingRef.current) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg.role === 'assistant') {
        const preview = lastMsg.content.slice(0, 120);
        setAnnouncement(`MindPal finished responding: ${preview}`);
      } else {
        setAnnouncement('MindPal response finished.');
      }
    }
    prevGeneratingRef.current = isGenerating;
  }, [isGenerating, messages]);

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      role="status"
      className="sr-only select-none pointer-events-none"
    >
      {announcement}
    </div>
  );
};
