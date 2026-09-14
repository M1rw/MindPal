import React from 'react';
import { Check, Clock, Edit2, Trash2 } from 'lucide-react';
import type { ChatSession } from '../../../types';

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
}

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);

  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 2) return 'yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffWeeks < 5) return `${diffWeeks} wk ago`;
  if (diffMonths < 12) return `${diffMonths} mo ago`;
  return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
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
}) => (
  <div
    key={session.id}
    onClick={() => !isEditing && onLoadSession(session)}
    className={`group w-full flex items-center justify-between px-4 py-2.5 transition-colors cursor-pointer text-left ${
      isActive ? 'bg-brand-subtle/80 hover:bg-brand-subtle' : 'hover:bg-surface-subtle'
    }`}
    role="button"
    tabIndex={0}
    onKeyDown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onLoadSession(session);
      }
    }}
  >
    <div className="flex-1 min-w-0 pr-2">
      <div className="flex items-center gap-2">
        {isEditing ? (
          <input
            type="text"
            autoFocus
            value={editingTitle}
            onChange={(e) => onEditingTitleChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.stopPropagation();
                onSaveRename(session.id);
              } else if (e.key === 'Escape') {
                e.stopPropagation();
                onEditingIdChange(null);
              }
            }}
            onBlur={() => onSaveRename(session.id)}
            onClick={(e) => e.stopPropagation()}
            className="w-full bg-surface-subtle px-2 py-0.5 rounded text-sm outline-none border border-brand-primary text-content-primary"
          />
        ) : (
          <>
            <span
              className={`text-sm font-medium truncate ${
                isActive ? 'text-brand-primary font-semibold' : 'text-content-primary'
              }`}
            >
              {session.title}
            </span>
            {isActive && (
              <span className="flex-shrink-0 flex items-center gap-1 text-2xs font-semibold px-1.5 py-0.5 rounded-md bg-brand-subtle text-brand-primary">
                <Check className="w-2.5 h-2.5" />
                Active
              </span>
            )}
          </>
        )}
      </div>
      <div className="flex items-center gap-1.5 mt-0.5">
        <Clock className="w-3 h-3 text-content-muted flex-shrink-0" />
        <span className="text-xs text-content-muted">
          {formatRelativeTime(session.updatedAt || session.createdAt)}
        </span>
        <span className="text-xs text-content-muted/60">·</span>
        <span className="text-xs text-content-muted">
          {session.messages.length} message{session.messages.length !== 1 ? 's' : ''}
        </span>
      </div>
    </div>

    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity flex-shrink-0">
      <button
        type="button"
        onClick={(e) => onStartRename(e, session)}
        className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors"
        title="Rename conversation"
        aria-label="Rename conversation"
      >
        <Edit2 className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={(e) => onDelete(e, session.id)}
        className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 text-zinc-400 hover:text-red-500 transition-colors"
        title="Delete conversation"
        aria-label="Delete conversation"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  </div>
);
