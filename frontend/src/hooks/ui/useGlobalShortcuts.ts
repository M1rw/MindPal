import { useEffect } from 'react';
import { useChatHistoryModalStore } from '../../store/index.ts';
import { startNewChat } from '../../utils/chat/appActions.ts';
import { matchesShortcut } from '../../utils/ui/shortcuts.ts';

/**
 * App-wide keys, matching ChatGPT's so they are already familiar:
 *   Ctrl/Cmd + K          open or close search (chats and actions)
 *   Ctrl/Cmd + Shift + O  new chat
 * They work while typing in the composer, which is where people use them.
 */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (matchesShortcut(event, 'k')) {
        event.preventDefault();
        const palette = useChatHistoryModalStore.getState();
        palette.setIsOpen(!palette.isOpen);
        return;
      }
      if (matchesShortcut(event, 'o', { shift: true })) {
        event.preventDefault();
        useChatHistoryModalStore.getState().setIsOpen(false);
        void startNewChat();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
