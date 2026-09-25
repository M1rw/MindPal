/**
 * Chat store — messages, generation state, and model/mode selection.
 */

import { create } from 'zustand';
import type { ChatMessage, MemoryReceipt } from '../types/index';
import { withoutMemoryReceipts } from '../utils/chat/sessionHistory.ts';

interface ChatState {
  messages: ChatMessage[];
  isGenerating: boolean;
  abortController: AbortController | null;
  activeModel: string;
  activeMode: string;
  strategyUsed: string | null;
  composerDraft: string | null;
  editingUserId: string | null;
  addMessage: (msg: ChatMessage) => void;
  setMessages: (messages: ChatMessage[]) => void;
  updateMessage: (id: string, content: string, strategy?: string) => void;
  removeMessage: (id: string) => void;
  updateLastMessage: (content: string, strategy?: string, move?: string) => void;
  setMessageMemoryReceipt: (id: string, receipt: MemoryReceipt | null) => void;
  /** A file reached the library after its message was sent: record its id there too. */
  setAttachmentFileId: (attachmentId: string, fileId: string) => void;
  setComposerDraft: (draft: string | null) => void;
  setEditingUserId: (id: string | null) => void;
  setIsGenerating: (generating: boolean) => void;
  setAbortController: (controller: AbortController | null) => void;
  stopGeneration: () => void;
  setActiveModel: (model: string) => void;
  setActiveMode: (mode: string) => void;
  clearMessages: () => void;
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  isGenerating: false,
  strategyUsed: null,
  abortController: null,
  activeModel: 'standard',
  activeMode: 'Active Listen',
  composerDraft: null,
  editingUserId: null,
  addMessage: (msg) =>
    set((state) => {
      if (state.messages.some((m) => m.id === msg.id)) {
        return state;
      }
      return { messages: [...state.messages, msg] };
    }),
  setMessages: (messages) => set({ messages: withoutMemoryReceipts(messages), strategyUsed: null }),
  updateMessage: (id, content, strategy) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === id
          ? { ...m, content, ...(strategy ? { strategy_used: strategy } : {}) }
          : m
      ),
      strategyUsed: strategy ?? state.strategyUsed,
    })),
  removeMessage: (id) =>
    set((state) => ({
      messages: state.messages.filter((m) => m.id !== id),
    })),
  updateLastMessage: (content, strategy, move) =>
    set((state) => {
      if (state.messages.length === 0) return state;
      const last = { ...state.messages[state.messages.length - 1] };
      last.content = content;
      if (strategy) last.strategy_used = strategy;
      if (move) last.insight_move = move;
      return {
        messages: [...state.messages.slice(0, -1), last],
        strategyUsed: strategy ?? state.strategyUsed,
      };
    }),
  setMessageMemoryReceipt: (id, receipt) =>
    set((state) => ({
      messages: state.messages.map((message) => {
        if (message.id !== id) return message;
        if (receipt == null) {
          const { memoryReceipt: _ignored, ...rest } = message;
          return rest;
        }
        return { ...message, memoryReceipt: receipt };
      }),
    })),
  setAttachmentFileId: (attachmentId, fileId) =>
    set((state) => ({
      messages: state.messages.map((message) =>
        message.attachments?.some((a) => a.id === attachmentId)
          ? { ...message, attachments: message.attachments.map((a) => (a.id === attachmentId ? { ...a, fileId } : a)) }
          : message,
      ),
    })),
  setComposerDraft: (composerDraft) => set({ composerDraft }),
  setEditingUserId: (editingUserId) => set({ editingUserId }),
  setIsGenerating: (isGenerating) => set({ isGenerating }),
  setAbortController: (abortController) => set({ abortController }),
  stopGeneration: () =>
    set((state) => {
      if (state.abortController) {
        try {
          state.abortController.abort();
        } catch {
          // ignore
        }
      }
      return { isGenerating: false, abortController: null };
    }),
  setActiveModel: (activeModel) => set({ activeModel }),
  setActiveMode: (activeMode) => set({ activeMode }),
  clearMessages: () =>
    set({
      messages: [],
      strategyUsed: null,
      editingUserId: null,
      composerDraft: null,
      isGenerating: false,
      abortController: null,
    }),
}));
