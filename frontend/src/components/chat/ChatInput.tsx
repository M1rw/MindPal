import React, { useState, useRef, KeyboardEvent } from 'react';
import { useChatStore, useVoiceStore } from '../../store';
import { ApiClient } from '../../services/api';
import { ChevronDown, AudioWaveform } from 'lucide-react';

export const ChatInput: React.FC = () => {
  const [input, setInput] = useState('');
  const { messages, addMessage, updateLastMessage, isGenerating, setIsGenerating } = useChatStore();
  const { setIsActive: setIsVoiceActive } = useVoiceStore();
  const textareaRef = useRef<HTMLInputElement>(null);

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
        updateLastMessage('I am having trouble connecting right now. Take one slow breath, then try again.');
        setIsGenerating(false);
      }
    );
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="max-w-3xl mx-auto w-full px-4 pb-6 pt-2 flex flex-col items-center">
      <form
        onSubmit={handleSubmit}
        className="w-full bg-[#f0f4f9] dark:bg-[#1e1f20] rounded-full px-6 py-3 flex items-center justify-between text-slate-800 dark:text-slate-200 shadow-sm border border-transparent focus-within:border-slate-300 dark:focus-within:border-slate-700 transition-all"
      >
        <input
          ref={textareaRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask MindPal"
          className="flex-1 bg-transparent border-0 outline-none text-sm placeholder-slate-500 dark:placeholder-slate-400 text-slate-900 dark:text-slate-100 pr-4"
        />

        <div className="flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-1 text-xs font-semibold text-slate-700 dark:text-slate-300 cursor-pointer hover:opacity-80">
            <span>Standard · Active Listen</span>
            <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
          </div>

          <button
            type="button"
            onClick={() => setIsVoiceActive(true)}
            className="p-1.5 rounded-full hover:bg-slate-200/60 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
            title="Voice mode"
          >
            <AudioWaveform className="w-4 h-4" />
          </button>
        </div>
      </form>

      <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-2 text-center">
        MindPal guarantees privacy. Secure conversations & strict clinical safety protocols.
      </p>
    </div>
  );
};
