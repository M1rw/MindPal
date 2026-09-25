import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Camera, FolderOpen, Paperclip, Plus } from 'lucide-react';
import { POPOVER_EXIT_MS, useOverlayPresence } from '../../../hooks/ui/useOverlayPresence';
import { floatingMenuClass } from '../../../utils/ui/overlay';
import { cn } from '../../../utils/ui/cn';
import { ACCEPTED_TYPES } from '../../../files/types.ts';
import { useComposerFilesStore } from '../../../store/composerFiles.ts';
import { useLibraryStore } from '../../../store/library.ts';
import { requestCamera } from '../../camera/cameraStream.ts';

interface ComposerAttachProps {
  disabled?: boolean;
}

/**
 * The "+" in the composer: upload files, take a photo, or pick from the library.
 * The file inputs are hidden and clicked inside the tap, which iOS requires.
 */
export const ComposerAttach: React.FC<ComposerAttachProps> = ({ disabled = false }) => {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ bottom: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const captureRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const add = useComposerFilesStore((state) => state.add);
  const { mounted, visible } = useOverlayPresence(open, POPOVER_EXIT_MS);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      // Above the button, and above the keyboard on phones.
      const viewportH = window.visualViewport?.height ?? window.innerHeight;
      setMenuPos({ bottom: viewportH - rect.top + 8, left: Math.max(12, rect.left) });
    };
    update();
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    window.setTimeout(() => itemRefs.current[0]?.focus(), 0);
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (buttonRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('.composer-attach-menu')) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pickFiles = () => {
    setOpen(false);
    fileRef.current?.click();
  };

  const takePhoto = () => {
    setOpen(false);
    // Asked for inside the tap: iOS only grants the camera during a gesture.
    if (!requestCamera()) captureRef.current?.click();
  };

  const fromLibrary = () => {
    setOpen(false);
    useLibraryStore.getState().open({ picking: true });
  };

  const onFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length) add(files);
  };

  const items = [
    { id: 'files', label: 'Upload files', hint: 'Images or PDFs', icon: Paperclip, run: pickFiles },
    { id: 'camera', label: 'Take photo', hint: 'Use your camera', icon: Camera, run: takePhoto },
    { id: 'library', label: 'From library', hint: 'Files you kept', icon: FolderOpen, run: fromLibrary },
  ];

  const onMenuKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const index = itemRefs.current.findIndex((node) => node === document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      itemRefs.current[(index + step + items.length) % items.length]?.focus();
    }
    if (event.key === 'Tab') setOpen(false);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          'composer-attach-btn chat-compact-btn w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-xl text-content-secondary hover:text-content-primary hover:bg-surface-elevated transition-[transform,background-color,color] duration-200 ease-out hover:scale-110 active:scale-95 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary disabled:opacity-50 disabled:pointer-events-none',
          open && 'bg-surface-elevated text-content-primary',
        )}
        aria-label="Add files or a photo"
        title="Add files or a photo"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Plus className={cn('h-[18px] w-[18px] transition-transform duration-200 ease-out', open && 'rotate-45')} aria-hidden="true" />
      </button>
      <input ref={fileRef} type="file" accept={ACCEPTED_TYPES} multiple hidden onChange={onFiles} data-testid="composer-file-input" />
      <input ref={captureRef} type="file" accept="image/*" capture="environment" hidden onChange={onFiles} />
      {mounted && menuPos
        ? createPortal(
            <div
              role="menu"
              aria-label="Add to your message"
              className={floatingMenuClass(visible, 'composer-attach-menu chat-mode-menu w-64 bg-surface-card border border-edge-subtle rounded-xl shadow-modal p-1.5')}
              style={{ bottom: menuPos.bottom, left: menuPos.left }}
              onKeyDown={onMenuKey}
            >
              {items.map((item, index) => (
                <button
                  key={item.id}
                  ref={(node) => {
                    itemRefs.current[index] = node;
                  }}
                  type="button"
                  role="menuitem"
                  onClick={item.run}
                  className={cn(
                    'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left hover:bg-surface-subtle/70 focus-visible:bg-surface-subtle focus-visible:outline-none transition-colors duration-150',
                    index > 0 && 'mt-0.5',
                  )}
                >
                  <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-surface-subtle text-content-primary">
                    <item.icon className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-content-primary">{item.label}</span>
                    <span className="block text-xs text-content-secondary">{item.hint}</span>
                  </span>
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
};
