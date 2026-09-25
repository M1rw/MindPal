import { useChatHistoryStore } from '../../store/history.ts';
import { useMemoryStore } from '../../store/memory.ts';
import { useSettingsStore } from '../../store/settings.ts';
import { useUsageStore } from '../../store/usage.ts';
import { resetSettingsSync } from '../sync/settingsSync.ts';
import { useComposerFilesStore } from '../../store/composerFiles.ts';
import { useLibraryStore } from '../../store/library.ts';
import { forgetSessionFiles } from '../../files/session.ts';
import { clearThumbs } from '../../files/localStore.ts';
import { claim, isGuestOwner, setOwner } from './owner.ts';

/**
 * Everything account-specific that is on screen belongs to the previous owner
 * the moment the account changes, so it goes before anything new is fetched.
 */
export function handOver(uid: string | null): void {
  const previous = claim();
  const next = setOwner(uid);
  if (next === previous) return;
  // A guest's per-network credits are not the account's, and vice versa.
  useUsageStore.getState().clearQuota();
  useMemoryStore.setState({ summary: null, isOpen: false, error: null });
  useChatHistoryStore.getState().switchOwner(next.owner);
  resetSettingsSync();
  // Files belong to their owner: pictures, readings and open views go, and an
  // account's thumbnails leave this device with it.
  useComposerFilesStore.getState().clear();
  useComposerFilesStore.setState({ allowance: null });
  useLibraryStore.setState({ isOpen: false, viewer: null, cameraOpen: false });
  forgetSessionFiles();
  if (!isGuestOwner(previous)) void clearThumbs();
  // An account's preferences (reply style, voice, quick actions...) are its
  // own: they leave with it instead of staying for the guest or the next
  // account. A guest's own choices carry into the account they sign in to.
  if (!isGuestOwner(previous)) {
    const { theme } = useSettingsStore.getState().settings;
    useSettingsStore.getState().resetSettings();
    useSettingsStore.getState().updateSettings({ theme });
  }
}
