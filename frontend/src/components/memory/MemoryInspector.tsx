import React, { useEffect, useState } from 'react';
import { useMemoryStore, useToastStore } from '../../store';
import { ApiClient } from '../../services/api';
import type { MemoryAtom } from '../../types';
import { Brain, RefreshCw, X, Trash2, Tag, Calendar } from 'lucide-react';

export const MemoryInspector: React.FC<{ isOpen: boolean; onClose: () => void }> = ({
  isOpen,
  onClose,
}) => {
  const { summary, setSummary, isLoading, setIsLoading, setError } = useMemoryStore();
  const { push: pushToast } = useToastStore();
  const [atoms, setAtoms] = useState<MemoryAtom[]>([]);
  const [activeTab, setActiveTab] = useState<'summary' | 'atoms'>('summary');

  const loadData = async () => {
    setIsLoading(true);
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
    } catch (err: any) {
      setError(err.message);
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
    } catch (err: any) {
      setError(err.message);
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
      <div className="bg-white dark:bg-[#18181B] border border-black/[0.08] dark:border-white/[0.08] rounded-2xl shadow-xl w-full max-w-2xl h-[80vh] flex flex-col overflow-hidden text-zinc-900 dark:text-zinc-100 animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-zinc-100 dark:border-zinc-800">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-[#EFF3FB] dark:bg-[#6572F2]/20 flex items-center justify-center text-[#4140FD] dark:text-[#A39CF9]">
              <Brain className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base sm:text-lg font-bold text-gray-900 dark:text-gray-100">
                Memory Profile
              </h3>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Synthesized narrative context and durable personal insights.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none"
            aria-label="Close memory modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Switcher */}
        <div className="flex items-center gap-2 px-6 pt-3 border-b border-gray-100 dark:border-zinc-800">
          <button
            type="button"
            onClick={() => setActiveTab('summary')}
            className={`pb-2.5 text-xs font-semibold border-b-2 transition-colors ${
              activeTab === 'summary'
                ? 'border-[#4140FD] text-[#4140FD] dark:text-[#A39CF9]'
                : 'border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'
            }`}
          >
            Narrative Summary
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('atoms')}
            className={`pb-2.5 text-xs font-semibold border-b-2 transition-colors flex items-center gap-1.5 ${
              activeTab === 'atoms'
                ? 'border-[#4140FD] text-[#4140FD] dark:text-[#A39CF9]'
                : 'border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'
            }`}
          >
            <span>Durable Memory Atoms</span>
            {atoms.length > 0 && (
              <span className="px-1.5 py-0.2 rounded-full bg-gray-100 dark:bg-zinc-800 text-[10px]">
                {atoms.length}
              </span>
            )}
          </button>
        </div>

        {/* Content Pane */}
        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
          {isLoading ? (
            <div className="space-y-4 animate-pulse">
              <div className="h-4 bg-gray-200 dark:bg-zinc-800 rounded w-3/4" />
              <div className="h-4 bg-gray-200 dark:bg-zinc-800 rounded w-full" />
              <div className="h-4 bg-gray-200 dark:bg-zinc-800 rounded w-5/6" />
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
                    className="p-3.5 rounded-2xl bg-gray-50 dark:bg-zinc-800/50 border border-gray-100 dark:border-zinc-800 flex items-start justify-between gap-3"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="px-2 py-0.5 rounded-md bg-[#EFF3FB] dark:bg-[#6572F2]/20 text-[#4140FD] dark:text-[#A39CF9] text-[10px] font-bold uppercase tracking-wider flex items-center gap-1">
                          <Tag className="w-2.5 h-2.5" />
                          {atom.type}
                        </span>
                        {atom.created_at && (
                          <span className="text-[11px] text-gray-400 flex items-center gap-1">
                            <Calendar className="w-2.5 h-2.5" />
                            {new Date(atom.created_at).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-800 dark:text-gray-200 font-medium">
                        {atom.value}
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleDeleteAtom(atom.id)}
                      className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/30 text-gray-400 hover:text-red-500 transition-colors"
                      title="Forget this memory"
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
        <div className="p-4 border-t border-gray-100 dark:border-zinc-800 bg-gray-50/50 dark:bg-zinc-900/50 flex items-center justify-between">
          <span className="text-xs text-gray-400">
            {summary?.updated_at
              ? `Last synthesized: ${new Date(summary.updated_at).toLocaleDateString()}`
              : ''}
          </span>

          <div className="flex items-center gap-2">
            <button
              onClick={handleRefresh}
              disabled={isLoading}
              className="px-3.5 py-2 rounded-xl text-xs font-semibold bg-gray-100 dark:bg-zinc-800 hover:bg-gray-200 dark:hover:bg-zinc-700 text-gray-700 dark:text-gray-300 flex items-center gap-1.5 transition-colors disabled:opacity-50"
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
