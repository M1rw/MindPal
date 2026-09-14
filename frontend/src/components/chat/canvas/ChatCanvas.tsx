import React, { useEffect, useRef, useState, useCallback } from 'react';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { useChatStore, useAuthStore } from '../../../store';
import { renderMarkdown } from '../../../utils/markdown';
import { useGreeting } from '../../../hooks/useGreeting';
import { getFirestoreDb } from '../../../services/firebase/firestoreDb';
import { LiveAnnouncer } from './LiveAnnouncer';
import { ChatCanvasEmptyState } from './ChatCanvasEmptyState';
import { ChatCanvasMessage } from './ChatCanvasMessage';

interface ChatCanvasProps {
  onSelectMood?: (text: string) => void;
  children?: React.ReactNode;
}

type FeedbackKind = 'thumbs_up' | 'thumbs_down';

// Save feedback to Firestore (fire-and-forget, non-blocking)
async function saveFeedback(
  userId: string | null,
  messageId: string,
  content: string,
  kind: FeedbackKind
) {
  try {
    const db = getFirestoreDb();
    if (!db) return;
    await addDoc(collection(db, 'message_feedback'), {
      userId: userId ?? 'anonymous',
      messageId,
      content: content.slice(0, 500), // truncate to avoid large writes
      kind,
      createdAt: serverTimestamp(),
    });
  } catch {
    // silently ignore — feedback is best-effort
  }
}

export const ChatCanvas: React.FC<ChatCanvasProps> = ({ onSelectMood, children }) => {
  const { messages, isGenerating, updateMessage, setIsGenerating, activeModel } = useChatStore();
  const { user } = useAuthStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [thumbsState, setThumbsState] = useState<Record<string, FeedbackKind | null>>({});
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const { greeting, isLoading: greetingLoading } = useGreeting(
    user ? { uid: user.uid, displayName: user.displayName } : null
  );

  // Smooth scroll on new messages/tokens
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isGenerating]);

  // Stop speech on unmount
  useEffect(() => () => { window.speechSynthesis?.cancel(); }, []);

  const copyToClipboard = useCallback((id: string, text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  }, []);

  const toggleSpeak = useCallback((id: string, text: string) => {
    if (speakingId === id) {
      window.speechSynthesis.cancel();
      setSpeakingId(null);
      return;
    }
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.onend = () => setSpeakingId(null);
    utt.onerror = () => setSpeakingId(null);
    window.speechSynthesis.speak(utt);
    setSpeakingId(id);
  }, [speakingId]);

  const handleThumb = useCallback(async (msgId: string, content: string, kind: FeedbackKind) => {
    setThumbsState((prev) => ({
      ...prev,
      [msgId]: prev[msgId] === kind ? null : kind,
    }));
    await saveFeedback(user?.uid ?? null, msgId, content, kind);
  }, [user?.uid]);

  const handleRegenerate = useCallback(async (targetMsgId?: string) => {
    if (isGenerating) return;

    // Find target assistant message
    const target = targetMsgId
      ? messages.find((m) => m.id === targetMsgId)
      : [...messages].reverse().find((m) => m.role === 'assistant');

    if (!target || target.role !== 'assistant') return;

    const targetIdx = messages.findIndex((m) => m.id === target.id);
    if (targetIdx === -1) return;

    // Find the user message that prompted this assistant message
    let userMsg: (typeof messages)[0] | undefined;
    for (let i = targetIdx - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        userMsg = messages[i];
        break;
      }
    }
    if (!userMsg) return;

    const userIdx = messages.findIndex((m) => m.id === userMsg.id);
    const history = messages.slice(Math.max(0, userIdx - 10), userIdx);

    setIsGenerating(true);
    setRegeneratingId(target.id);

    // In-place regeneration: CLEAR existing content, do NOT add a new message!
    updateMessage(target.id, '');

    const { ApiClient } = await import('../../../services/api');
    let current = '';

    const controller = new AbortController();
    useChatStore.getState().setAbortController(controller);

    await ApiClient.streamChat(
      userMsg.content,
      history,
      (chunk, strategy) => {
        current += chunk;
        updateMessage(target.id, current, strategy);
      },
      () => {
        setIsGenerating(false);
        setRegeneratingId(null);
        useChatStore.getState().setAbortController(null);
      },
      (err) => {
        console.error('Regeneration error:', err);
        updateMessage(target.id, 'Unable to regenerate. Please try again.');
        setIsGenerating(false);
        setRegeneratingId(null);
        useChatStore.getState().setAbortController(null);
      },
      { model: activeModel, signal: controller.signal }
    );
  }, [messages, isGenerating, activeModel, updateMessage, setIsGenerating]);

  return (
    <div
      id="chat-canvas"
      ref={scrollRef}
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
      aria-label="Conversation history"
      className="relative flex-1 overflow-y-auto custom-scrollbar flex flex-col"
    >
      {/* Screen Reader Live Announcements */}
      <LiveAnnouncer />

      {messages.length === 0 ? (
        <ChatCanvasEmptyState
          greeting={greeting}
          greetingLoading={greetingLoading}
          onSelectMood={onSelectMood}
        >
          {children}
        </ChatCanvasEmptyState>
      ) : (
        /* ── Conversation Thread ── */
        <div className="flex-1 py-8 px-4 sm:px-6 max-w-3xl w-full mx-auto">
          <div className="space-y-6">
            {messages.map((msg, idx) => {
              const isUser = msg.role === 'user';
              const isLast = idx === messages.length - 1;
              const isStreamingThis = !isUser && ((isGenerating && isLast && !regeneratingId) || regeneratingId === msg.id);
              const htmlContent = renderMarkdown(msg.content);
              const thumbed = thumbsState[msg.id] ?? null;

              return (
                <ChatCanvasMessage
                  key={msg.id}
                  msg={msg}
                  index={idx}
                  isUser={isUser}
                  isStreamingThis={isStreamingThis}
                  isGenerating={isGenerating}
                  regeneratingId={regeneratingId}
                  copiedId={copiedId}
                  speakingId={speakingId}
                  thumbed={thumbed}
                  htmlContent={htmlContent}
                  onCopy={copyToClipboard}
                  onToggleSpeak={toggleSpeak}
                  onThumb={handleThumb}
                  onRegenerate={handleRegenerate}
                />
              );
            })}
          </div>

          <div ref={bottomRef} className="h-8" />
        </div>
      )}
    </div>
  );
};
