import React, { useState, useRef, KeyboardEvent } from 'react';
import { useChatStore, useVoiceStore } from '../../store';
import { ApiClient } from '../../services/api';
import { Send, Mic, StopCircle } from 'lucide-react';

export const ChatInput: React.FC = () => {
  const [input, setInput] = useState('');
  const { messages, addMessage, updateLastMessage, isGenerating, setIsGenerating } = useChatStore();
  const { setIsActive: setIsVoiceActive } = useVoiceStore();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isGenerating) return;

    const userMessageId = `usr_${Date.now()}`;
    const userMsg = {
      id: userMessageId,
      role: 'user' as const,
      content: trimmed,
      timestamp: new Date().toISOString(),
    };

    addMessage(userMsg);
    setInput('');
    setIsGenerating(true);

    const assistantMsgId = `msg_${Date.now()}`;
    addMessage({
      id: assistantMsgId,
      role: 'assistant' as const,
      content: '',
      timestamp: new Date().toISOString(),
    });

    let currentContent = '';

    await ApiClient.streamChat(
      trimmed,
      messages.slice(-10),
      (chunk, strategy) => {
        currentContent += chunk;
        updateLastMessage(currentContent, strategy);
      },
      () => {
        setIsGenerating(false);
      },
      (err) => {
        console.error('Chat error:', err);
        updateLastMessage('An error occurred while generating a response. Please try again.');
        setIsGenerating(false);
      }
    );
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="max-w-4xl mx-auto w-full px-4 pb-4 pt-2">
      <form onSubmit={handleSubmit} className="relative rounded-2xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-lg focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-transparent transition-all">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask MindPal anything..."
          rows={2}
          className="w-full resize-none bg-transparent px-4 py-3 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none text-sm leading-relaxed"
        />

        <div className="flex items-center justify-between px-3 py-2 border-t border-slate-100 dark:border-slate-700/60">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setIsVoiceActive(true)}
              className="p-2 rounded-xl text-slate-500 hover:text-blue-500 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
              title="Open Voice Mode"
            >
              <Mic className="w-5 h-5" />
            </button>
          </div>

          <button
            type="submit"
            disabled={!input.trim() || isGenerating}
            className={`p-2 rounded-xl flex items-center justify-center transition-all ${
              input.trim() && !isGenerating
                ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-md'
                : 'bg-slate-200 dark:bg-slate-700 text-slate-400 cursor-not-allowed'
            } focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none`}
            title="Send Message"
          >
            {isGenerating ? (
              <StopCircle className="w-5 h-5 animate-spin" />
            ) : (
              <Send className="w-5 h-5" />
            )}
          </button>
        </div>
      </form>
    </div>
  );
};
