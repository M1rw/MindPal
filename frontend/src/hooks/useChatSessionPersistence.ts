import { useEffect, useRef } from 'react';
import { useChatHistoryStore, useChatStore } from '../store/index';

export function useChatSessionPersistence() {
  const sessionIdRef = useRef<string>(`sess_${Date.now()}`);
  const { messages } = useChatStore();
  const { sessions, activeSessionId, saveSession, setActiveSessionId } = useChatHistoryStore();

  useEffect(() => {
    if (activeSessionId) {
      sessionIdRef.current = activeSessionId;
    }
  }, [activeSessionId]);

  useEffect(() => {
    if (messages.length === 0) {
      sessionIdRef.current = `sess_${Date.now()}`;
      if (activeSessionId) {
        setActiveSessionId(null);
      }
      return;
    }

    const timer = window.setTimeout(() => {
      const currentId = activeSessionId || sessionIdRef.current;
      const existingSession = sessions.find((session) => session.id === currentId);

      const firstUser = messages.find((message) => message.role === 'user');
      const title =
        existingSession?.title && existingSession.title !== 'Conversation'
          ? existingSession.title
          : firstUser
            ? firstUser.content.slice(0, 60).trim() + (firstUser.content.length > 60 ? '…' : '')
            : 'Conversation';

      const createdAt = existingSession?.createdAt || messages[0]?.timestamp || new Date().toISOString();

      saveSession({
        id: currentId,
        title,
        createdAt,
        updatedAt: new Date().toISOString(),
        messages: [...messages],
      });
    }, 1000);

    return () => window.clearTimeout(timer);
  }, [activeSessionId, messages, saveSession, sessions, setActiveSessionId]);
}
