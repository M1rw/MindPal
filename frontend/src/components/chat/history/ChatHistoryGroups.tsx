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
}) => (
  <div className="py-2">
    {groups.map(({ label, items }) => (
      <div key={label} className="mb-1">
        <div className="px-5 pt-3 pb-1.5 text-xs font-medium text-content-muted">
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
            />
          ))}
        </div>
      </div>
    ))}
  </div>
);
