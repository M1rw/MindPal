import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { POPOVER_EXIT_MS, useOverlayPresence } from '../../hooks/ui/useOverlayPresence';
import { popoverPanelClass } from '../../utils/ui/overlay';
import { ModalClose } from '../ui/Modal';
import type { SettingsNavTab } from './SettingsSidebar';

interface SettingsMobileNavProps {
  navTabs: SettingsNavTab[];
  activeTab: string;
  onChangeTab: (tab: string) => void;
  onClose: () => void;
  categoryLabel: string;
}

export const SettingsMobileNav: React.FC<SettingsMobileNavProps> = ({
  navTabs,
  activeTab,
  onChangeTab,
  onClose,
  categoryLabel,
}) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { mounted, visible } = useOverlayPresence(open, POPOVER_EXIT_MS);
  const active = navTabs.find((tab) => tab.id === activeTab) ?? navTabs[0];
  const ActiveIcon = active?.icon;

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="sm:hidden flex items-center justify-between gap-2 px-4 py-3 border-b border-edge-subtle flex-none">
      <div ref={wrapRef} className="relative min-w-0 flex-1">
        <button
          type="button"
          aria-label={categoryLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls="settings-category-menu"
          onClick={() => setOpen((current) => !current)}
          className="flex w-full items-center justify-between gap-2 rounded-xl border border-edge-subtle bg-surface-sunken px-3 py-2.5 text-sm font-medium text-content-primary transition-colors duration-150 ease-out hover:bg-surface-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
        >
          <span className="flex min-w-0 items-center gap-2">
            {ActiveIcon ? <ActiveIcon className="h-4 w-4 shrink-0 text-content-secondary" /> : null}
            <span className="truncate">{active?.label ?? 'Settings'}</span>
          </span>
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-content-muted transition-transform duration-150 ease-out ${
              open ? 'rotate-180' : ''
            }`}
            aria-hidden="true"
          />
        </button>

        {mounted ? (
          <div
            id="settings-category-menu"
            role="menu"
            aria-label={categoryLabel}
            className={popoverPanelClass(
              visible,
              'absolute left-0 right-0 top-full z-50 mt-1.5 max-h-[min(24rem,60dvh)] overflow-y-auto rounded-xl border border-edge-subtle bg-surface-card p-1.5 shadow-modal custom-scrollbar'
            )}
          >
            {navTabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = tab.id === activeTab;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="menuitem"
                  aria-current={isActive ? 'page' : undefined}
                  onClick={() => {
                    onChangeTab(tab.id);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary ${
                    isActive
                      ? 'bg-surface-subtle text-content-primary'
                      : 'text-content-primary hover:bg-surface-subtle'
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
      <ModalClose onClick={onClose} label="Close settings" />
    </div>
  );
};
