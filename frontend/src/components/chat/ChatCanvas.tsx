import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Waves, Wind, Anchor, Copy, Check, Volume2, ThumbsUp, ThumbsDown, RefreshCw } from 'lucide-react';
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

    const { ApiClient } = await import('../../services/api');
    let current = '';

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
      },
      (err) => {
        console.error('Regeneration error:', err);
        updateMessage(target.id, 'Unable to regenerate. Please try again.');
        setIsGenerating(false);
        setRegeneratingId(null);
      },
      { model: activeModel }
    );
  }, [messages, isGenerating, activeModel, updateMessage, setIsGenerating]);

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
              const isStreamingThis = !isUser && ((isGenerating && isLast && !regeneratingId) || regeneratingId === msg.id);
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
                        {/* Empty streaming placeholder — elegant 3-bar "Thinking ..." */}
                        {isStreamingThis && msg.content === '' ? (
                          <div className="flex items-center gap-2 py-1.5 text-zinc-500 dark:text-zinc-400 animate-fade-in select-none">
                            {/* 3-bar signal icon matching reference image */}
                            <div className="flex items-end gap-[2px] h-[15px] pb-[1px]" aria-hidden="true">
                              <span
                                className="w-[2px] h-[6px] bg-zinc-400 dark:bg-zinc-500 rounded-full animate-pulse"
                                style={{ animationDuration: '1.2s', animationDelay: '0ms' }}
                              />
                              <span
                                className="w-[2px] h-[14px] bg-zinc-400 dark:bg-zinc-500 rounded-full animate-pulse"
                                style={{ animationDuration: '1.2s', animationDelay: '200ms' }}
                              />
                              <span
                                className="w-[2px] h-[9px] bg-zinc-400 dark:bg-zinc-500 rounded-full animate-pulse"
                                style={{ animationDuration: '1.2s', animationDelay: '400ms' }}
                              />
                            </div>
                            <span className="text-[14px] font-medium text-zinc-500 dark:text-zinc-400">Thinking</span>
                            <span className="flex items-center gap-[2.5px] ml-0.5" aria-hidden="true">
                              <span
                                className="w-[3px] h-[3px] rounded-full bg-zinc-400 dark:bg-zinc-500 animate-pulse"
                                style={{ animationDuration: '1.4s', animationDelay: '0ms' }}
                              />
                              <span
                                className="w-[3px] h-[3px] rounded-full bg-zinc-400 dark:bg-zinc-500 animate-pulse"
                                style={{ animationDuration: '1.4s', animationDelay: '250ms' }}
                              />
                              <span
                                className="w-[3px] h-[3px] rounded-full bg-zinc-400 dark:bg-zinc-500 animate-pulse"
                                style={{ animationDuration: '1.4s', animationDelay: '500ms' }}
                              />
                            </span>
                          </div>
                        ) : (
                          <div
                            className={[
                              'text-[15px] leading-[1.8] text-zinc-800 dark:text-zinc-100',
                              'prose prose-sm dark:prose-invert max-w-none',
                              'prose-p:my-1.5 prose-headings:mb-2 prose-headings:mt-4 prose-li:my-0.5',
                              isStreamingThis ? 'chat-streaming' : '',
                            ].join(' ')}
                            dangerouslySetInnerHTML={{ __html: htmlContent }}
                          />
                        )}

                        {/* Action row — always visible once done */}
                        {!isStreamingThis && msg.content && (
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

                            {/* Regenerate — in-place regeneration of this message */}
                            <button
                              onClick={() => handleRegenerate(msg.id)}
                              disabled={isGenerating}
                              className={`msg-action-btn p-1.5 rounded-lg text-zinc-400 hover:text-[#4140FD] hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors ${
                                isGenerating ? 'opacity-40 cursor-not-allowed' : ''
                              }`}
                              title="Regenerate" aria-label="Regenerate response"
                            >
                              <RefreshCw className={`w-4 h-4 ${regeneratingId === msg.id ? 'animate-spin' : ''}`} />
                            </button>
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
