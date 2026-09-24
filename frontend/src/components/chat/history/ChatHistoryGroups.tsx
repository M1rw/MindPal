import React from 'react';
import type { ChatSession } from '../../../types';
import { ChatHistorySessionItem } from './ChatHistorySessionItem';

interface ChatHistoryGroupsProps {
  groups: Array<{ label: string; items: ChatSession[] }>;
  activeSessionId: string | null;
  editingId: string | null;
  editingTitle: string;
  onLoadSession: (session: ChatSession) => void;
  onStartRename: (event: React.MouseEvent, session: ChatSession) => void;
  onDelete: (event: React.MouseEvent, id: string) => void;
  onSaveRename: (id: string) => void;
  onEditingTitleChange: (value: string) => void;
  onEditingIdChange: (value: string | null) => void;
  /** Palette support: which row the keyboard is on, matched lines, search words. */
  highlightedId?: string | null;
  snippets?: Record<string, string>;
  query?: string;
  onHighlight?: (id: string) => void;
  /** Palette index of each session id. */
  paletteIndex?: Record<string, number>;
  onTogglePin?: (event: React.MouseEvent, id: string) => void;
}

export const ChatHistoryGroups: React.FC<ChatHistoryGroupsProps> = ({
  groups,
  activeSessionId,
  editingId,
  editingTitle,
  onLoadSession,
  onStartRename,
  onDelete,
  onSaveRename,
  onEditingTitleChange,
  onEditingIdChange,
  highlightedId = null,
  snippets,
  query = '',
  onHighlight,
  paletteIndex,
  onTogglePin,
}) => (
  <div className="py-2">
    {groups.map(({ label, items }) => (
      <div key={label} className="mb-1">
        <div className="palette-section pt-3">
          {label}
        </div>
        <div className="history-session-list">
          {items.map((session) => (
            <ChatHistorySessionItem
              key={session.id}
              session={session}
              isActive={session.id === activeSessionId}
              isEditing={editingId === session.id}
              editingTitle={editingTitle}
              onLoadSession={onLoadSession}
              onStartRename={onStartRename}
              onDelete={onDelete}
              onSaveRename={onSaveRename}
              onEditingTitleChange={onEditingTitleChange}
              onEditingIdChange={onEditingIdChange}
              isHighlighted={highlightedId === session.id}
              snippet={snippets?.[session.id]}
              query={query}
              onHighlight={onHighlight ? () => onHighlight(session.id) : undefined}
              paletteIndex={paletteIndex?.[session.id]}
              onTogglePin={onTogglePin}
            />
          ))}
        </div>
      </div>
    ))}
  </div>
);
