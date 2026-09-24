import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { POPOVER_EXIT_MS, useOverlayPresence } from '../../hooks/ui/useOverlayPresence';
import { popoverPanelClass } from '../../utils/ui/overlay';
import { cn } from '../../utils/ui/cn';

export const SettingsHeader: React.FC<{ title: string; description: string }> = ({
  title,
  description,
}) => (
  <div className="space-y-1.5">
    <h2 className="text-lg font-semibold tracking-tight text-content-primary">{title}</h2>
    <p className="text-sm text-content-secondary leading-relaxed">{description}</p>
  </div>
);

export const SettingsBlock: React.FC<
  React.PropsWithChildren<{ title: string; last?: boolean }>
> = ({ title, last, children }) => (
  <section className={cn('space-y-2 py-5', !last && 'border-b border-edge-subtle')}>
    <h3 className="text-sm font-medium text-content-primary">{title}</h3>
    <div className="space-y-3 text-sm text-content-secondary leading-relaxed">{children}</div>
  </section>
);

export const SettingsRow: React.FC<
  React.PropsWithChildren<{ label: string; description?: string; last?: boolean; danger?: boolean }>
> = ({ label, description, last, danger, children }) => (
  <div
    className={cn(
      'flex items-start sm:items-center justify-between gap-4 py-3.5',
      !last && 'border-b border-edge-subtle',
    )}
  >
    <div className="min-w-0 space-y-0.5">
      <div className={cn('text-sm font-medium', danger ? 'text-feedback-danger' : 'text-content-primary')}>
        {label}
      </div>
      {description ? (
        <p className="text-sm text-content-secondary leading-relaxed">{description}</p>
      ) : null}
    </div>
    <div className="shrink-0">{children}</div>
  </div>
);

export const settingsGhostButtonClass =
  'px-3.5 py-2 rounded-xl text-sm font-medium border border-edge-default text-content-primary bg-transparent hover:bg-surface-elevated transition-colors duration-150 ease-out focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap';

export const settingsPrimaryButtonClass =
  'px-3.5 py-2 rounded-xl text-sm font-medium border border-edge-subtle text-content-primary bg-transparent hover:bg-surface-elevated transition-colors duration-150 ease-out focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap';

export const settingsDangerButtonClass =
  'px-3.5 py-2 rounded-xl text-sm font-medium bg-feedback-danger hover:opacity-90 text-white transition-colors duration-150 ease-out focus-visible:ring-2 focus-visible:ring-feedback-danger focus-visible:outline-none disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap';

export function settingsNavItemClass(active: boolean): string {
  return cn(
    'flex items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm font-medium transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary',
    active
      ? 'bg-surface-card text-content-primary'
      : 'text-content-secondary hover:bg-surface-elevated hover:text-content-primary',
  );
}

export type SettingsSelectOption<T extends string = string> = {
  value: T;
  label: string;
  description?: string;
  /** Small visual before the label (e.g. a voice's orb colours). */
  leading?: React.ReactNode;
};

export function SettingsSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
}: {
  value: T;
  options: ReadonlyArray<SettingsSelectOption<T>>;
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const selected = options[selectedIndex] ?? options[0];
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();
  const { mounted, visible } = useOverlayPresence(open, POPOVER_EXIT_MS);
  const [menuPos, setMenuPos] = useState<{
    top?: number;
    bottom?: number;
    right: number;
    minWidth: number;
    maxHeight: number;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(selectedIndex);
    const timeoutId = window.setTimeout(() => {
      optionRefs.current[selectedIndex]?.focus();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [open, selectedIndex]);

  // Hover moves focus too; it must not scroll the list under the pointer.
  const hoverFocusRef = useRef(false);
  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.focus({ preventScroll: hoverFocusRef.current });
    hoverFocusRef.current = false;
  }, [activeIndex, open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (wrapRef.current?.contains(target)) return;
      const menu = document.getElementById(listboxId);
      if (menu?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, listboxId]);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const el = buttonRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const minWidth = Math.max(rect.width, 180);
      const right = Math.max(12, window.innerWidth - rect.right);
      const spaceBelow = window.innerHeight - rect.bottom;
      const estimatedHeight = Math.min(options.length * 60 + 16, 360);
      // Long lists (12 voices) scroll inside the menu instead of running off the screen.
      const MARGIN = 18;
      if (spaceBelow < estimatedHeight && rect.top > spaceBelow) {
        setMenuPos({
          bottom: window.innerHeight - rect.top + 6,
          right,
          minWidth,
          maxHeight: Math.max(160, Math.min(420, rect.top - MARGIN)),
        });
        return;
      }
      setMenuPos({
        top: rect.bottom + 6,
        right,
        minWidth,
        maxHeight: Math.max(160, Math.min(420, spaceBelow - MARGIN)),
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, options.length]);

  const selectValue = (next: T) => {
    onChange(next);
    setOpen(false);
    buttonRef.current?.focus();
  };

  const onListboxKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % options.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + options.length) % options.length);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(options.length - 1);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const option = options[activeIndex];
      if (option) selectValue(option.value);
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    }
  };

  const menu =
    mounted && menuPos
      ? createPortal(
          <div
            id={listboxId}
            className={popoverPanelClass(
              visible,
              'settings-select-menu bg-surface-card border border-edge-subtle rounded-xl shadow-modal p-1.5 overflow-y-auto overscroll-contain',
            )}
            style={{
              top: menuPos.top,
              bottom: menuPos.bottom,
              right: menuPos.right,
              minWidth: menuPos.minWidth,
              maxHeight: menuPos.maxHeight,
            }}
            role="listbox"
            aria-label={ariaLabel}
            aria-activedescendant={`${listboxId}-${options[activeIndex]?.value ?? 'none'}`}
            tabIndex={-1}
            data-overlay-escape="ignore"
            onKeyDown={onListboxKeyDown}
          >
            {options.map((option, index) => {
              const isSelected = option.value === selected?.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  id={`${listboxId}-${option.value}`}
                  role="option"
                  aria-selected={isSelected}
                  tabIndex={activeIndex === index ? 0 : -1}
                  ref={(node) => {
                    optionRefs.current[index] = node;
                  }}
                  onClick={() => selectValue(option.value)}
                  onMouseEnter={() => {
                    hoverFocusRef.current = true;
                    setActiveIndex(index);
                  }}
                  className={cn(
                    'w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg text-left transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary',
                    index > 0 && 'mt-0.5',
                    isSelected ? 'bg-surface-subtle' : 'hover:bg-surface-subtle/60',
                  )}
                >
                  <div className="min-w-0 flex items-center gap-2.5">
                    {option.leading}
                    <div className="min-w-0">
                    <div className="text-sm font-medium text-content-primary">{option.label}</div>
                    {option.description ? (
                      <div className="text-xs text-content-secondary mt-0.5">{option.description}</div>
                    ) : null}
                    </div>
                  </div>
                  {isSelected ? <Check className="w-4 h-4 text-content-secondary flex-shrink-0" /> : null}
                </button>
              );
            })}
          </div>,
          document.body,
        )
      : null;

  return (
    <div ref={wrapRef} className="relative" data-overlay-escape={open ? 'ignore' : undefined}>
      <button
        type="button"
        ref={buttonRef}
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) setOpen(true);
          }
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={ariaLabel}
        className="settings-select-trigger flex items-center justify-between gap-1.5 min-w-[7.5rem] px-2.5 py-1.5 rounded-xl text-sm font-medium text-content-primary border border-edge-subtle bg-transparent hover:bg-surface-elevated transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary disabled:opacity-50 disabled:pointer-events-none"
      >
        <span className="flex min-w-0 items-center gap-2">
          {selected?.leading}
          <span className="truncate">{selected?.label ?? 'Choose'}</span>
        </span>
        <ChevronDown
          className={cn(
            'w-3.5 h-3.5 text-content-muted transition-transform duration-150 ease-out flex-shrink-0',
            open && 'rotate-180',
          )}
          aria-hidden="true"
        />
      </button>
      {menu}
    </div>
  );
}
