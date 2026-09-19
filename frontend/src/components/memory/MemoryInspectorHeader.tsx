import React from 'react';
import { ModalHeader } from '../ui/Modal';

interface MemoryInspectorHeaderProps {
  onClose: () => void;
  onDevice?: boolean;
}

export const MemoryInspectorHeader: React.FC<MemoryInspectorHeaderProps> = ({
  onClose,
  onDevice = false,
}) => (
  <ModalHeader
    kicker={onDevice ? 'This device' : 'Account'}
    title="Memory"
    titleId="memory-title"
    description={
      onDevice
        ? 'Facts saved on this device. Sign in to keep them with your account.'
        : 'Facts saved from your conversations to this account.'
    }
    onClose={onClose}
    closeLabel="Close memory"
  />
);
