import { cn } from './cn';

export function overlayShellClass(visible: boolean, className?: string) {
  return cn(
    'fixed inset-0 flex items-end sm:items-center justify-center p-0 sm:p-6',
    visible ? 'pointer-events-auto' : 'pointer-events-none',
    className
  );
}

export function overlayBackdropClass(visible: boolean, className?: string) {
  return cn('overlay-backdrop', visible ? 'is-open' : 'is-closing', className);
}

export function overlayPanelClass(visible: boolean, className?: string) {
  return cn('overlay-panel', visible ? 'is-open' : 'is-closing', className);
}

export function popoverPanelClass(visible: boolean, className?: string) {
  return cn('overlay-popover', visible ? 'is-open' : 'is-closing', className);
}

export function floatingMenuClass(visible: boolean, className?: string) {
  return cn('overlay-menu', visible ? 'is-open' : 'is-closing', className);
}
