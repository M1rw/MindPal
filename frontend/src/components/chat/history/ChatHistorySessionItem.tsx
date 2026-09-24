import React, { useEffect, useRef } from 'react';
import { Edit2, MessageSquare, Trash2 } from 'lucide-react';
import type { ChatSession } from '../../../types';
import { HighlightedText } from '../../ui/HighlightedText';

interface ChatHistorySessionItemProps {
  session: ChatSession;
  isActive: boolean;
  isEditing: boolean;
  editingTitle: string;
  onLoadSession: (session: ChatSession) => void;
  onStartRename: (event: React.MouseEvent, session: ChatSession) => void;
  onDelete: (event: React.MouseEvent, id: string) => void;
  onSaveRename: (id: string) => void;
  onEditingTitleChange: (value: string) => void;
  onEditingIdChange: (value: string | null) => void;
  /** The keyboard selection in the palette (distinct from the open chat). */
  isHighlighted?: boolean;
  /** The line that matched the search, shown under the title. */
  snippet?: string;
  /** Words to mark in the title and snippet. */
  query?: string;
  onHighlight?: () => void;
  /** Index among the palette's selectable rows, for keyboard scrolling. */
  paletteIndex?: number;
}

export const ChatHistorySessionItem: React.FC<ChatHistorySessionItemProps> = ({
  session,
  isActive,
  isEditing,
  editingTitle,
  onLoadSession,
  onStartRename,
  onDelete,
  onSaveRename,
  onEditingTitleChange,
  onEditingIdChange,
  isHighlighted = false,
  snippet,
  query = '',
  onHighlight,
  paletteIndex,
}) => {
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isEditing) return;
    const input = titleRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    input.select();
  }, [isEditing]);

  return (
    <div
      className={`history-session-item group mx-2 flex min-h-0 items-center gap-2.5 rounded-xl px-3 py-2 text-left ${
        isActive ? 'is-active' : ''
      } ${isHighlighted ? 'is-highlighted' : ''}`}
      data-palette-index={paletteIndex}
      onMouseMove={onHighlight}
    >
      {isEditing ? null : (
        <button
          type="button"
          className="history-session-item__open"
          onClick={() => onLoadSession(session)}
          aria-label={`Open conversation ${session.title}`}
        />
      )}
      <MessageSquare className="history-session-item__icon h-4 w-4 flex-shrink-0 text-content-muted" aria-hidden="true" />
      {isEditing ? (
        <input
          ref={titleRef}
          type="text"
          data-overlay-escape="ignore"
          value={editingTitle}
          aria-label="Editing conversation title"
          onChange={(e) => onEditingTitleChange(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              onSaveRename(session.id);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              onEditingIdChange(null);
            }
          }}
          onBlur={(e) => {
            const next = e.relatedTarget as Node | null;
            if (next && e.currentTarget.parentElement?.contains(next)) return;
            onSaveRename(session.id);
          }}
          onClick={(e) => e.stopPropagation()}
          className="history-rename min-w-0 flex-1 text-content-primary"
        />
      ) : (
        <span className="history-session-item__title flex min-w-0 flex-1 flex-col text-left">
          <span
            className={`truncate text-sm leading-5 ${
              isActive ? 'font-medium text-content-primary' : 'text-content-primary'
            }`}
          >
            <HighlightedText text={session.title} query={query} />
          </span>
          {snippet ? (
            <span className="truncate text-xs leading-4 text-content-muted">
              <HighlightedText text={snippet} query={query} />
            </span>
          ) : null}
        </span>
      )}
      <div
        className={`history-session-item__actions flex flex-shrink-0 items-center gap-0.5 ${
          isEditing ? 'opacity-100' : 'history-session-item__actions--touch opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100'
        }`}
      >
        <button
          type="button"
          className={`history-row-action flex items-center justify-center rounded-md transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary ${
            isEditing
              ? 'bg-brand-subtle text-brand-primary'
              : 'text-content-muted hover:bg-surface-elevated hover:text-content-primary'
          }`}
          title="Rename conversation"
          aria-label="Rename conversation"
          aria-pressed={isEditing}
          onClick={(e) => onStartRename(e, session)}
        >
          <Edit2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="history-row-action flex items-center justify-center rounded-md text-content-muted transition-colors duration-150 hover:bg-feedback-dangerSubtle hover:text-feedback-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          title="Delete conversation"
          aria-label="Delete conversation"
          onClick={(e) => onDelete(e, session.id)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
};
