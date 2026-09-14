import React from 'react';
import { Brain, X } from 'lucide-react';

interface MemoryInspectorHeaderProps {
  onClose: () => void;
}

export const MemoryInspectorHeader: React.FC<MemoryInspectorHeaderProps> = ({ onClose }) => (
  <div className="flex items-center justify-between p-5 border-b border-edge-subtle">
    <div className="flex items-center gap-3">
      <div className="w-10 h-10 rounded-2xl bg-brand-subtle flex items-center justify-center text-brand-primary shadow-sm">
        <Brain className="w-5 h-5" />
      </div>
      <div>
        <h3 className="text-base sm:text-lg font-bold text-content-primary">Memory Profile</h3>
        <p className="text-xs text-content-secondary">
          Synthesized narrative context and durable personal insights.
        </p>
      </div>
    </div>
    <button
      onClick={onClose}
      className="p-1.5 rounded-full hover:bg-surface-subtle text-content-muted hover:text-content-primary transition-colors focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none active:scale-95"
      aria-label="Close memory modal"
    >
      <X className="w-5 h-5" />
    </button>
  </div>
);
