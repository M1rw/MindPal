import React from 'react';
import { X } from 'lucide-react';
import { useFocusTrap } from '../../hooks/ui/useFocusTrap';
import { useOverlayPresence } from '../../hooks/ui/useOverlayPresence';
import { overlayBackdropClass, overlayPanelClass, overlayShellClass } from '../../utils/ui/overlay';
import { cn } from '../../utils/ui/cn';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'panel';
export type ModalLayer = 50 | 70 | 80 | 90;

const LAYER_CLASS: Record<ModalLayer, string> = {
  50: 'z-50',
  70: 'z-[70]',
  80: 'z-[80]',
  90: 'z-[90]',
};

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  id?: string;
  panelId?: string;
  labelledBy?: string;
  label?: string;
  size?: ModalSize;
  layer?: ModalLayer;
  flush?: boolean;
  className?: string;
  panelClassName?: string;
  closeOnBackdrop?: boolean;
  inert?: boolean;
}

export function Modal({
  open,
  onClose,
  children,
  id,
  panelId,
  labelledBy,
  label,
  size = 'md',
  layer = 50,
  flush = false,
  className,
  panelClassName,
  closeOnBackdrop = true,
  inert = false,
}: ModalProps) {
  const panelRef = useFocusTrap<HTMLDivElement>({
    isOpen: open,
    onClose,
    autoFocus: true,
    paused: inert,
  });
  const { mounted, visible } = useOverlayPresence(open);

  if (!mounted) return null;

  return (
    <div
      id={id}
      className={overlayShellClass(
        visible,
        cn('mp-modal', `mp-modal--${size}`, flush && 'mp-modal--flush', LAYER_CLASS[layer], className)
      )}
      role="dialog"
      aria-modal={!inert}
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : label}
      aria-hidden={!open || inert}
      inert={inert || undefined}
    >
      <div
        className={overlayBackdropClass(visible)}
        onClick={closeOnBackdrop ? onClose : undefined}
      />
      <div
        ref={panelRef}
        id={panelId}
        className={overlayPanelClass(visible, cn('mp-modal__panel', panelClassName))}
      >
        {children}
      </div>
    </div>
  );
}

export interface ModalHeaderProps {
  kicker?: string;
  title: string;
  titleId: string;
  description?: string;
  onClose: () => void;
  closeLabel: string;
  className?: string;
}

export function ModalHeader({
  kicker,
  title,
  titleId,
  description,
  onClose,
  closeLabel,
  className,
}: ModalHeaderProps) {
  return (
    <div className={cn('mp-modal__header', className)}>
      <div className="mp-modal__heading">
        {kicker ? <p className="mp-modal__kicker">{kicker}</p> : null}
        <h2 id={titleId} className="mp-modal__title">
          {title}
        </h2>
        {description ? <p className="mp-modal__lede">{description}</p> : null}
      </div>
      <ModalClose onClick={onClose} label={closeLabel} />
    </div>
  );
}

export function ModalBody({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn('mp-modal__body', className)}>{children}</div>;
}

export function ModalFooter({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn('mp-modal__footer', className)}>{children}</div>;
}

export function ModalToolbar({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn('mp-modal__toolbar', className)}>{children}</div>;
}

export function ModalClose({
  onClick,
  label,
  className,
  tone = 'default',
}: {
  onClick: () => void;
  label: string;
  className?: string;
  tone?: 'default' | 'inverse';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('icon-hit mp-modal__close', tone === 'inverse' && 'mp-modal__close--inverse', className)}
      aria-label={label}
    >
      <X className="h-5 w-5" />
    </button>
  );
}
