import { useEffect } from 'react';
import { useChatHistoryStore, useChatStore } from '../../store/index';
import {
  deriveSessionTitle,
  shouldBumpSessionTimestamp,
  withoutMemoryReceipts,
} from '../../utils/chat/sessionHistory.ts';

export function useChatSessionPersistence() {
  const { messages } = useChatStore();
  const { saveSession, ensureActiveSessionId } = useChatHistoryStore();

  useEffect(() => {
    if (messages.length === 0) return;

    const timer = window.setTimeout(() => {
      const { sessions, activeSessionId: currentActive } = useChatHistoryStore.getState();
      const currentId = currentActive || ensureActiveSessionId();
      const existingSession = sessions.find((session) => session.id === currentId);

      if (!shouldBumpSessionTimestamp(existingSession?.messages, messages)) {
        return;
      }

      const firstUser = messages.find((message) => message.role === 'user');
      // A chat that starts with only a file is named after it.
      const fileTitle = (files?: Array<{ name: string }>) => (files?.[0]?.name ?? '').replace(/\.[a-z0-9]{2,5}$/i, '');
      const title = existingSession?.titleLocked
        ? existingSession.title
        : firstUser
          ? deriveSessionTitle(firstUser.content || fileTitle(firstUser.attachments))
          : existingSession?.title || 'New chat';

      const createdAt = existingSession?.createdAt || messages[0]?.timestamp || new Date().toISOString();

      saveSession({
        id: currentId,
        title,
        titleLocked: existingSession?.titleLocked,
        createdAt,
        updatedAt: new Date().toISOString(),
        messages: withoutMemoryReceipts(messages),
      });
    }, 1000);

    return () => window.clearTimeout(timer);
  }, [ensureActiveSessionId, messages, saveSession]);
}
