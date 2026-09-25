/**
 * The library view and the file viewer: which is open, and what it shows.
 */
import { create } from 'zustand';
import type { MessageAttachment } from '../files/types.ts';

export interface ViewerTarget {
  attachment: MessageAttachment;
  /** 1-based page to open a PDF at (from a [p. N] citation). */
  page?: number;
}

interface LibraryState {
  isOpen: boolean;
  /** Opened from the composer: choosing a file attaches it. */
  picking: boolean;
  viewer: ViewerTarget | null;
  cameraOpen: boolean;
  open: (options?: { picking?: boolean }) => void;
  close: () => void;
  openViewer: (target: ViewerTarget) => void;
  closeViewer: () => void;
  setCameraOpen: (open: boolean) => void;
}

export const useLibraryStore = create<LibraryState>((set) => ({
  isOpen: false,
  picking: false,
  viewer: null,
  cameraOpen: false,
  open: (options) => set({ isOpen: true, picking: Boolean(options?.picking) }),
  close: () => set({ isOpen: false, picking: false }),
  openViewer: (viewer) => set({ viewer }),
  closeViewer: () => set({ viewer: null }),
  setCameraOpen: (cameraOpen) => set({ cameraOpen }),
}));
