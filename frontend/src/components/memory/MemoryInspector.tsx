import React, { useEffect, useState } from 'react';
import { useMemoryStore } from '../../store';
import { ApiClient } from '../../services/api';
import { Brain, RefreshCw, Edit3, Save, X } from 'lucide-react';

export const MemoryInspector: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const { summary, setSummary, isLoading, setIsLoading, setError } = useMemoryStore();
  const [isEditing, setIsEditing] = useState(false);
  const [editedText, setEditedText] = useState('');

  useEffect(() => {
    if (isOpen) {
      setIsLoading(true);
      ApiClient.getMemorySummary()
        .then((res) => {
          setSummary(res);
          setEditedText(res.summary);
        })
        .catch((err) => setError(err.message))
        .finally(() => setIsLoading(false));
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleRefresh = async () => {
    setIsLoading(true);
    try {
      const res = await ApiClient.refreshMemorySummary();
      setSummary(res);
      setEditedText(res.summary);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async () => {
    setIsLoading(true);
    try {
      const res = await ApiClient.updateMemorySummary(editedText);
      setSummary(res);
      setIsEditing(false);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl shadow-2xl w-full max-w-2xl h-[75vh] flex flex-col overflow-hidden animate-fade-in">
        <div className="flex items-center justify-between p-5 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-blue-500/10 flex items-center justify-center text-blue-500">
              <Brain className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100">Memory Graph Profile</h3>
              <p className="text-xs text-slate-400">Synthesized narrative context used for personalized response building.</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {isLoading ? (
            <div className="space-y-4 animate-pulse">
              <div className="h-4 bg-slate-200 dark:bg-slate-800 rounded w-3/4" />
              <div className="h-4 bg-slate-200 dark:bg-slate-800 rounded w-full" />
              <div className="h-4 bg-slate-200 dark:bg-slate-800 rounded w-5/6" />
            </div>
          ) : isEditing ? (
            <textarea
              value={editedText}
              onChange={(e) => setEditedText(e.target.value)}
              className="w-full h-full min-h-[300px] p-4 rounded-2xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          ) : (
            <div className="prose dark:prose-invert max-w-none text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap leading-relaxed">
              {summary?.summary || 'No memory summary available yet. Start chatting to synthesize your profile!'}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 flex items-center justify-between">
          <span className="text-xs text-slate-400">
            {summary?.updated_at ? `Last updated: ${new Date(summary.updated_at).toLocaleTimeString()}` : ''}
          </span>

          <div className="flex items-center gap-2">
            {isEditing ? (
              <>
                <button
                  onClick={() => setIsEditing(false)}
                  className="px-4 py-2 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-200/60 dark:hover:bg-slate-800 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  className="px-4 py-2 rounded-xl text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 flex items-center gap-2 shadow-sm"
                >
                  <Save className="w-4 h-4" /> Save
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={handleRefresh}
                  className="p-2.5 rounded-xl text-slate-600 dark:text-slate-400 hover:bg-slate-200/60 dark:hover:bg-slate-800 transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
                  title="Resynthesize memory"
                >
                  <RefreshCw className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setIsEditing(true)}
                  className="px-4 py-2 rounded-xl text-sm font-medium bg-slate-200 dark:bg-slate-800 text-slate-800 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-700 flex items-center gap-2 transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
                >
                  <Edit3 className="w-4 h-4" /> Edit Profile
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
