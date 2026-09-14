import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Waves, Wind, Anchor, Copy, Check, Volume2, ThumbsUp, ThumbsDown, RefreshCw, BarChart2 } from 'lucide-react';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { useChatStore, useAuthStore } from '../../store';
import { renderMarkdown } from '../../utils/markdown';
import { useGreeting } from '../../hooks/useGreeting';
import { getFirestoreDb } from '../../services/firestoreDb';

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
  const { messages, isGenerating, addMessage, updateLastMessage, setIsGenerating, activeModel } = useChatStore();
  const { user } = useAuthStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [thumbsState, setThumbsState] = useState<Record<string, FeedbackKind | null>>({});
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

  const handleRegenerate = useCallback(async () => {
    // Find last user message and re-send it
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUser || isGenerating) return;

    // Remove last assistant message and re-trigger
    const { ApiClient } = await import('../../services/api');
    const history = messages.slice(0, -1).filter((m) => m.role !== 'assistant' || messages.indexOf(m) < messages.length - 1);

    setIsGenerating(true);
    const assistantMsgId = `msg_regen_${Date.now()}`;
    addMessage({ id: assistantMsgId, role: 'assistant', content: '', timestamp: new Date().toISOString() });

    let current = '';
    await ApiClient.streamChat(
      lastUser.content,
      messages.slice(-12, -1),
      (chunk) => {
        current += chunk;
        updateLastMessage(current);
      },
      () => setIsGenerating(false),
      () => { updateLastMessage('Unable to regenerate. Please try again.'); setIsGenerating(false); },
      { model: activeModel }
    );
  }, [messages, isGenerating, activeModel, addMessage, updateLastMessage, setIsGenerating]);

  return (
    <div
      id="chat-canvas"
      ref={scrollRef}
      className="flex-1 overflow-y-auto custom-scrollbar flex flex-col"
    >
      {messages.length === 0 ? (
        /* ── Empty State ── */
        <div className="flex-1 flex flex-col items-center justify-center text-center px-4 animate-fade-in my-auto -translate-y-6 sm:-translate-y-8">
          <div className="w-full max-w-2xl text-center mb-6">
            <h1 className="text-4xl sm:text-5xl font-medium tracking-tight mb-2">
              {greetingLoading ? (
                <span className="inline-block h-12 w-64 rounded-xl bg-zinc-200 dark:bg-zinc-800 animate-pulse" aria-hidden="true" />
              ) : (
                <span
                  id="greeting-text"
                  className="bg-clip-text text-transparent bg-gradient-to-r from-[#A39CF9] via-[#6572F2] to-[#4140FD] animate-fade-in"
                >
                  {greeting}
                </span>
              )}
            </h1>
            <p className="text-2xl sm:text-3xl text-zinc-600 dark:text-zinc-300 font-medium tracking-tight mb-6">
              What&apos;s on your mind today?
            </p>

            {/* Mood chips */}
            <div className="flex flex-wrap justify-center gap-2.5 sm:gap-3 mb-6">
              <button type="button" onClick={() => onSelectMood?.('I feel overwhelmed')}
                className="px-4 py-2.5 rounded-2xl bg-[#f0f4f9] dark:bg-gemini-darkSurface hover:bg-black/[0.06] dark:hover:bg-white/[0.08] text-sm font-medium text-zinc-700 dark:text-zinc-200 flex items-center gap-2 transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none select-none">
                <Waves className="w-4 h-4 text-[#2563EB] dark:text-[#3B82F6]" />
                <span>I feel overwhelmed</span>
              </button>
              <button type="button" onClick={() => onSelectMood?.("I'm feeling anxious")}
                className="px-4 py-2.5 rounded-2xl bg-[#f0f4f9] dark:bg-gemini-darkSurface hover:bg-black/[0.06] dark:hover:bg-white/[0.08] text-sm font-medium text-zinc-700 dark:text-zinc-200 flex items-center gap-2 transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none select-none">
                <Wind className="w-4 h-4 text-[#9333EA] dark:text-[#A855F7]" />
                <span>I&apos;m feeling anxious</span>
              </button>
              <button type="button" onClick={() => onSelectMood?.('I feel stuck')}
                className="px-4 py-2.5 rounded-2xl bg-[#f0f4f9] dark:bg-gemini-darkSurface hover:bg-black/[0.06] dark:hover:bg-white/[0.08] text-sm font-medium text-zinc-700 dark:text-zinc-200 flex items-center gap-2 transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none select-none">
                <Anchor className="w-4 h-4 text-[#E11D48] dark:text-[#FB7185]" />
                <span>I feel stuck</span>
              </button>
            </div>
          </div>
          <div className="w-full max-w-3xl">{children}</div>
        </div>
      ) : (
        /* ── Conversation Thread ── */
        <div className="flex-1 py-8 px-4 sm:px-6 max-w-3xl w-full mx-auto">
          <div className="space-y-6">
            {messages.map((msg, idx) => {
              const isUser = msg.role === 'user';
              const isLast = idx === messages.length - 1;
              const isStreaming = isLast && isGenerating && !isUser;
              const htmlContent = renderMarkdown(msg.content);
              const thumbed = thumbsState[msg.id] ?? null;

              return (
                <div
                  key={msg.id}
                  className={`flex ${isUser ? 'justify-end' : 'justify-start'} animate-msg-in`}
                  style={{ animationDelay: `${Math.min(idx * 15, 80)}ms` }}
                >
                  <div className={`flex flex-col ${isUser ? 'items-end max-w-[78%]' : 'items-start w-full'}`}>
                    {isUser ? (
                      /* User bubble — matches chatbox surface */
                      <div className="px-4 py-2.5 rounded-[20px] bg-[#f0f4f9] dark:bg-gemini-darkSurface text-zinc-900 dark:text-zinc-100 text-[15px] leading-relaxed">
                        {msg.content}
                      </div>
                    ) : (
                      /* Assistant — clean prose, no card */
                      <div className="w-full">
                        {/* Empty streaming placeholder — elegant "Thinking…" */}
                        {isStreaming && msg.content === '' ? (
                          <div className="flex items-center gap-2 py-1 text-zinc-400 dark:text-zinc-500 animate-fade-in">
                            <BarChart2 className="w-4 h-4 opacity-70" />
                            <span className="text-[14px] font-medium">Thinking</span>
                            <span className="flex gap-0.5">
                              <span className="w-1 h-1 rounded-full bg-zinc-400 dark:bg-zinc-500 animate-bounce" style={{ animationDelay: '0ms' }} />
                              <span className="w-1 h-1 rounded-full bg-zinc-400 dark:bg-zinc-500 animate-bounce" style={{ animationDelay: '120ms' }} />
                              <span className="w-1 h-1 rounded-full bg-zinc-400 dark:bg-zinc-500 animate-bounce" style={{ animationDelay: '240ms' }} />
                            </span>
                          </div>
                        ) : (
                          <div
                            className={[
                              'text-[15px] leading-[1.8] text-zinc-800 dark:text-zinc-100',
                              'prose prose-sm dark:prose-invert max-w-none',
                              'prose-p:my-1.5 prose-headings:mb-2 prose-headings:mt-4 prose-li:my-0.5',
                              isStreaming ? 'chat-streaming' : '',
                            ].join(' ')}
                            dangerouslySetInnerHTML={{ __html: htmlContent }}
                          />
                        )}

                        {/* Action row — always visible once done */}
                        {!isStreaming && msg.content && (
                          <div className="flex items-center gap-0.5 mt-2.5">
                            {/* Copy */}
                            <button
                              onClick={() => copyToClipboard(msg.id, msg.content)}
                              className="msg-action-btn p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                              title="Copy" aria-label="Copy response"
                            >
                              {copiedId === msg.id
                                ? <Check className="w-4 h-4 text-emerald-500" />
                                : <Copy className="w-4 h-4" />}
                            </button>

                            {/* Read aloud — toggle */}
                            <button
                              onClick={() => toggleSpeak(msg.id, msg.content)}
                              className={`msg-action-btn p-1.5 rounded-lg transition-colors ${
                                speakingId === msg.id
                                  ? 'text-[#4140FD] bg-[#4140FD]/10'
                                  : 'text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                              }`}
                              title={speakingId === msg.id ? 'Stop reading' : 'Read aloud'}
                              aria-label="Read aloud"
                            >
                              <Volume2 className="w-4 h-4" />
                            </button>

                            {/* Thumbs Up — saves to Firestore */}
                            <button
                              onClick={() => handleThumb(msg.id, msg.content, 'thumbs_up')}
                              className={`msg-action-btn p-1.5 rounded-lg transition-colors ${
                                thumbed === 'thumbs_up'
                                  ? 'text-emerald-500 bg-emerald-50 dark:bg-emerald-950/30'
                                  : 'text-zinc-400 hover:text-emerald-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                              }`}
                              title="Good response" aria-label="Good response"
                            >
                              <ThumbsUp className="w-4 h-4" />
                            </button>

                            {/* Thumbs Down — saves to Firestore */}
                            <button
                              onClick={() => handleThumb(msg.id, msg.content, 'thumbs_down')}
                              className={`msg-action-btn p-1.5 rounded-lg transition-colors ${
                                thumbed === 'thumbs_down'
                                  ? 'text-red-500 bg-red-50 dark:bg-red-950/30'
                                  : 'text-zinc-400 hover:text-red-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                              }`}
                              title="Bad response" aria-label="Bad response"
                            >
                              <ThumbsDown className="w-4 h-4" />
                            </button>

                            {/* Regenerate — only on last assistant message */}
                            {isLast && (
                              <button
                                onClick={handleRegenerate}
                                className="msg-action-btn p-1.5 rounded-lg text-zinc-400 hover:text-[#4140FD] hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                                title="Regenerate" aria-label="Regenerate response"
                              >
                                <RefreshCw className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div ref={bottomRef} className="h-8" />
        </div>
      )}
    </div>
  );
};
