import React, { useEffect, useState } from 'react';
import { useMemoryStore, useToastStore } from '../../store';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { ApiClient } from '../../services/api/index';
import type { MemoryAtom } from '../../types';
import { Brain, RefreshCw, Trash2, Tag, Calendar } from 'lucide-react';
import { SkeletonMemoryView } from '../ui/Skeleton';
import { MemoryInspectorHeader } from './MemoryInspectorHeader';
import { MemoryInspectorTabs } from './MemoryInspectorTabs';

export const MemoryInspector: React.FC<{ isOpen: boolean; onClose: () => void }> = ({
  isOpen,
  onClose,
}) => {
  const { summary, setSummary, isLoading, error, setIsLoading, setError } = useMemoryStore();
  const { push: pushToast } = useToastStore();
  const modalContentRef = useFocusTrap<HTMLDivElement>({
    isOpen,
    onClose,
    autoFocus: true,
  });
  const [atoms, setAtoms] = useState<MemoryAtom[]>([]);
  const [activeTab, setActiveTab] = useState<'summary' | 'atoms'>('summary');

  const loadData = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [sumRes, graphRes] = await Promise.allSettled([
        ApiClient.getMemorySummary(),
        ApiClient.getMemoryGraph(),
      ]);

      if (sumRes.status === 'fulfilled') {
        setSummary(sumRes.value);
      }
      if (graphRes.status === 'fulfilled') {
        setAtoms(graphRes.value?.atoms || []);
      }
      if (sumRes.status === 'rejected' || graphRes.status === 'rejected') {
        const failedResource = sumRes.status === 'rejected' ? 'summary' : 'memory items';
        setError(`Could not load your memory ${failedResource}. Please try again.`);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load memory context.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadData();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleRefresh = async () => {
    setIsLoading(true);
    try {
      const res = await ApiClient.refreshMemorySummary();
      setSummary(res);
      pushToast('Memory summary resynthesized', 'success');
      loadData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to refresh memory summary.');
      pushToast('Could not refresh memory summary', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteAtom = async (atomId: string) => {
    try {
      await ApiClient.deleteMemoryGraphItem(atomId);
      setAtoms((prev) => prev.filter((a) => a.id !== atomId));
      pushToast('Memory item deleted', 'info');
    } catch (err) {
      pushToast('Failed to delete memory item', 'error');
    }
  };

  return (
    <div
      id="memory-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/75 backdrop-blur-sm p-4 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label="Memory Profile"
    >
      <div
        ref={modalContentRef}
        className="bg-surface-card border border-edge-subtle rounded-2xl specular-card shadow-modal w-full max-w-2xl h-[80vh] flex flex-col overflow-hidden text-content-primary animate-fade-in"
      >
        <MemoryInspectorHeader onClose={onClose} />

        <MemoryInspectorTabs
          activeTab={activeTab}
          atomsCount={atoms.length}
          onChangeTab={setActiveTab}
        />

        {/* Content Pane */}
        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
          {isLoading ? (
            <SkeletonMemoryView mode={activeTab} />
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-12 text-center text-rose-600 dark:text-rose-400">
              <p className="text-sm font-medium">Memory unavailable</p>
              <p className="text-xs mt-1 text-content-muted">{error}</p>
              <button
                type="button"
                onClick={loadData}
                className="mt-4 px-3.5 py-2 rounded-xl text-xs font-semibold bg-brand-primary text-white hover:bg-brand-hover transition-colors"
              >
                Retry loading memory
              </button>
            </div>
          ) : activeTab === 'summary' ? (
            <div className="prose dark:prose-invert max-w-none text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed">
              {summary?.summary || (
                <div className="text-center py-12 text-gray-400 dark:text-gray-500">
                  <Brain className="w-10 h-10 mx-auto mb-2 opacity-40" />
                  <p>No memory summary synthesized yet.</p>
                  <p className="text-xs mt-1">Start chatting with MindPal to build your personal memory profile!</p>
                </div>
              )}
            </div>
          ) : (
            /* Atoms Tab */
            <div className="space-y-3">
              {atoms.length === 0 ? (
                <div className="text-center py-12 text-gray-400 dark:text-gray-500">
                  <p>No memory atoms extracted yet.</p>
                  <p className="text-xs mt-1">MindPal records important preferences, traits, and goals automatically.</p>
                </div>
              ) : (
                atoms.map((atom) => (
                  <div
                    key={atom.id}
                    className="p-3.5 rounded-2xl bg-surface-subtle border border-edge-subtle flex items-start justify-between gap-3"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="px-2 py-0.5 rounded-md bg-brand-subtle text-brand-primary text-2xs font-bold uppercase tracking-wider flex items-center gap-1">
                          <Tag className="w-2.5 h-2.5" />
                          {atom.type}
                        </span>
                        {atom.created_at && (
                          <span className="text-xs text-content-muted flex items-center gap-1">
                            <Calendar className="w-2.5 h-2.5" />
                            {new Date(atom.created_at).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-content-primary font-medium">
                        {atom.value}
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleDeleteAtom(atom.id)}
                      className="p-1.5 rounded-lg hover:bg-rose-500/10 text-content-muted hover:text-rose-500 transition-colors"
                      title="Forget this memory"
                      aria-label={`Forget memory: ${atom.value}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-edge-subtle bg-surface-subtle/50 flex items-center justify-between">
          <span className="text-xs text-content-muted">
            {summary?.updated_at
              ? `Last synthesized: ${new Date(summary.updated_at).toLocaleDateString()}`
              : ''}
          </span>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRefresh}
              disabled={isLoading}
              className="px-3.5 py-2 rounded-xl text-xs font-semibold bg-surface-subtle hover:bg-surface-elevated text-content-primary border border-edge-subtle flex items-center gap-1.5 transition-all active:scale-95 disabled:opacity-50"
              title="Resynthesize memory"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
              <span>Resynthesize</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
