/**
 * Actions shared by the header, the command palette and keyboard shortcuts,
 * so "New chat" asks the same question and does the same thing everywhere.
 */

import { SquarePen } from 'lucide-react';
import { useChatHistoryStore, useChatStore } from '../../store/index.ts';
import { confirmAction } from '../../store/confirm.ts';

/**
 * Start a fresh conversation. The current one stays in history; the person is
 * asked first only when there is something on screen to leave.
 */
export async function startNewChat(): Promise<boolean> {
  const chat = useChatStore.getState();
  if (chat.messages.length > 0) {
    const ok = await confirmAction({
      title: 'Start a new chat?',
      message: 'This conversation stays in your history, so you can come back to it.',
      confirmLabel: 'New chat',
      icon: SquarePen,
      dontAskAgainKey: 'new-chat',
    });
    if (!ok) return false;
  }
  const latest = useChatStore.getState();
  if (latest.isGenerating) latest.stopGeneration();
  latest.clearMessages();
  useChatHistoryStore.getState().setActiveSessionId(null);
  return true;
}
