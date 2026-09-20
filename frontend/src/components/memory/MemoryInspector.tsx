import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useMemoryStore, useSessionStore, useSettingsStore, useToastStore } from '../../store';
import { ApiClient } from '../../services/api/index';
import type { MemoryAtom } from '../../types';
import { Pencil, Search, Trash2 } from 'lucide-react';
import { SkeletonMemoryView } from '../ui/Skeleton';
import { MemoryInspectorHeader } from './MemoryInspectorHeader';
import { MemoryInspectorTabs } from './MemoryInspectorTabs';
import { honestMemorySummary } from '../../utils/memory/memory';
import { Modal, ModalBody } from '../ui/Modal';
import { cn } from '../../utils/ui/cn';

function typeLabel(type: string): string {
  const cleaned = type.replace(/[_/]+/g, ' ').trim();
  if (!cleaned) return 'Fact';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function atomMatches(atom: MemoryAtom, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    atom.value.toLowerCase().includes(q) ||
    atom.type.toLowerCase().includes(q) ||
    (atom.normalized_value ?? '').toLowerCase().includes(q)
  );
}

export const MemoryInspector: React.FC<{ isOpen: boolean; onClose: () => void }> = ({
  isOpen,
  onClose,
}) => {
  const { summary, setSummary, isLoading, error, setIsLoading, setError, inspectTab, highlightAtomIds } =
    useMemoryStore();
  const isAuthenticated = useSessionStore((state) => state.isAuthenticated);
  const { push: pushToast } = useToastStore();
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const [atoms, setAtoms] = useState<MemoryAtom[]>([]);
  const [activeTab, setActiveTab] = useState<'summary' | 'atoms'>(inspectTab);
  const [atomQuery, setAtomQuery] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const honestSummary = honestMemorySummary(summary?.summary);

  const handleClose = () => {
    const shouldReturn = useMemoryStore.getState().returnToSettings;
    onClose();
    if (!shouldReturn) return;
    useSettingsStore.getState().setActiveTab('personalization');
  };

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
      setActiveTab(inspectTab);
      setAtomQuery('');
      // Bump reloadKey so every open (even when already open) re-fetches data.
      // This is critical for guest users: memory atoms are saved mid-conversation
      // and the inspector may already be open from a previous view.
      setReloadKey((k) => k + 1);
    }
  }, [isOpen, inspectTab, highlightAtomIds]);

  useEffect(() => {
    if (isOpen) {
      void loadData();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, isAuthenticated, reloadKey]);

  const highlightSet = useMemo(() => new Set(highlightAtomIds), [highlightAtomIds]);
  const visibleAtoms = useMemo(
    () => atoms.filter((atom) => atomMatches(atom, atomQuery)),
    [atoms, atomQuery],
  );
  const firstHighlightId = useMemo(
    () => highlightAtomIds.find((id) => visibleAtoms.some((atom) => atom.id === id)),
    [highlightAtomIds, visibleAtoms],
  );

  useEffect(() => {
    if (!isOpen || isLoading || activeTab !== 'atoms' || !firstHighlightId) return;
    const frame = requestAnimationFrame(() => {
      highlightRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen, isLoading, activeTab, firstHighlightId, visibleAtoms]);

  const handleDeleteAtom = async (atomId: string) => {
    try {
      await ApiClient.deleteMemoryGraphItem(atomId);
      setAtoms((prev) => prev.filter((a) => a.id !== atomId));
      pushToast('Memory item deleted', 'info');
    } catch {
      pushToast('Failed to delete memory item', 'error');
    }
  };

  const handlePatchAtom = async (atomId: string, value: string): Promise<MemoryAtom> => {
    const updated = await ApiClient.patchMemoryGraphItem(atomId, value);
    setAtoms((prev) =>
      prev.map((item) =>
        item.id === atomId
          ? { ...item, value: updated.value, updated_at: updated.updated_at ?? item.updated_at }
          : item,
      ),
    );
    return updated;
  };

  const queryActive = atomQuery.trim().length > 0;

  return (
    <Modal
      id="memory-modal"
      open={isOpen}
      onClose={handleClose}
      labelledBy="memory-title"
      size="xl"
      flush
      layer={70}
    >
      <MemoryInspectorHeader onClose={handleClose} onDevice={!isAuthenticated} />

      <MemoryInspectorTabs
        activeTab={activeTab}
        atomsCount={atoms.length}
        onChangeTab={setActiveTab}
      />

      <ModalBody className="p-6 custom-scrollbar">
          {isLoading ? (
            <SkeletonMemoryView mode={activeTab} />
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-12 text-center text-feedback-danger">
              <p className="text-sm font-medium">Memory unavailable</p>
              <p className="text-sm mt-1 text-content-muted">{error}</p>
              <button
                type="button"
                onClick={() => {
                  void loadData();
                }}
                className="mt-4 px-3.5 py-2 rounded-xl text-sm font-medium bg-brand-primary text-white hover:bg-brand-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
              >
                Retry loading memory
              </button>
            </div>
          ) : activeTab === 'summary' ? (
            <div id="memory-panel-summary" role="tabpanel" aria-labelledby="memory-tab-summary">
              {!isAuthenticated && (
                <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-900/10 px-4 py-3 text-xs text-amber-700 dark:text-amber-400 leading-relaxed">
                  <strong>Stored on this device only.</strong> Sign in to sync your memory across all your devices.
                </div>
              )}
              {honestSummary ? (
                <p className="text-sm text-content-secondary whitespace-pre-wrap leading-relaxed">{honestSummary}</p>
              ) : (
                <div className="text-center py-12 text-content-muted">
                  <p className="text-sm text-content-secondary">
                    {atoms.length > 0 ? 'No summary yet.' : 'Nothing stored yet.'}
                  </p>
                  <p className="text-sm mt-1">
                    {atoms.length > 0
                      ? 'Saved facts are on the other tab.'
                      : 'Saved facts appear after a turn.'}
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div id="memory-panel-atoms" role="tabpanel" aria-labelledby="memory-tab-atoms" className="space-y-3">
              {atoms.length > 0 ? (
                <label className="memory-search">
                  <Search className="h-3.5 w-3.5 shrink-0 text-content-muted" aria-hidden="true" />
                  <input
                    type="search"
                    value={atomQuery}
                    onChange={(event) => setAtomQuery(event.target.value)}
                    placeholder="Search facts"
                    aria-label="Search saved facts"
                    className="memory-search__field"
                  />
                </label>
              ) : null}

              {atoms.length === 0 ? (
                <div className="text-center py-12 text-content-muted">
                  <p className="text-sm text-content-secondary">Nothing stored yet.</p>
                  <p className="text-sm mt-1">Saved facts appear after a turn.</p>
                  {!isAuthenticated && (
                    <p className="text-xs mt-3 text-content-muted">
                      Memories are stored in this browser only.
                    </p>
                  )}
                </div>
              ) : visibleAtoms.length === 0 ? (
                <div className="text-center py-12 text-content-muted">
                  <p className="text-sm text-content-secondary">No saved facts match</p>
                  {queryActive ? (
                    <p className="text-sm mt-1">Try a different word or memory type.</p>
                  ) : null}
                </div>
              ) : (
                <ul className="memory-atoms">
                  {visibleAtoms.map((atom) => {
                    const highlighted = highlightSet.has(atom.id);
                    return (
                      <MemoryAtomRow
                        key={atom.id}
                        atom={atom}
                        highlighted={highlighted}
                        rowRef={atom.id === firstHighlightId ? highlightRef : undefined}
                        onDelete={handleDeleteAtom}
                        onPatch={handlePatchAtom}
                        onError={(message) => pushToast(message, 'error')}
                      />
                    );
                  })}
                </ul>
              )}
            </div>
          )}
      </ModalBody>
    </Modal>
  );
};

function MemoryAtomRow({
  atom,
  highlighted,
  rowRef,
  onDelete,
  onPatch,
  onError,
}: {
  atom: MemoryAtom;
  highlighted: boolean;
  rowRef?: React.Ref<HTMLDivElement>;
  onDelete: (atomId: string) => void;
  onPatch: (atomId: string, value: string) => Promise<MemoryAtom>;
  onError: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(atom.value);
  const [saving, setSaving] = useState(false);
  const fieldRef = useRef<HTMLInputElement>(null);
  const trimmed = draft.trim();
  const canSave = trimmed.length > 0 && trimmed !== atom.value && !saving;

  useEffect(() => {
    if (!editing) {
      setDraft(atom.value);
      return;
    }
    const field = fieldRef.current;
    if (!field) return;
    field.focus({ preventScroll: true });
    field.select();
  }, [editing, atom.value]);

  const cancel = () => {
    if (saving) return;
    setDraft(atom.value);
    setEditing(false);
  };

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await onPatch(atom.id, trimmed);
      setEditing(false);
    } catch (err) {
      onError(err instanceof Error && err.message ? err.message : 'Could not update that memory item.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <li>
      <div
        ref={rowRef}
        data-atom-id={atom.id}
        aria-current={highlighted ? 'true' : undefined}
        className={cn('memory-atom', highlighted && 'is-highlight', editing && 'is-editing')}
        title={atom.created_at ? `Saved ${new Date(atom.created_at).toLocaleDateString()}` : undefined}
      >
        <span className="memory-atom__type">{typeLabel(atom.type)}</span>
        {editing ? (
          <input
            ref={fieldRef}
            type="text"
            value={draft}
            data-overlay-escape="ignore"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Escape') {
                event.preventDefault();
                cancel();
                return;
              }
              if (event.key === 'Enter') {
                event.preventDefault();
                void save();
              }
            }}
            className="memory-atom__field"
            aria-label={`Edit memory: ${atom.value}`}
            disabled={saving}
          />
        ) : (
          <p className="memory-atom__value">{atom.value}</p>
        )}

        {editing ? (
          <div className="memory-atom__edit-actions">
            <button
              type="button"
              onClick={() => {
                void save();
              }}
              disabled={!canSave}
              className="memory-atom__text-action"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={cancel} disabled={saving} className="memory-atom__text-action">
              Cancel
            </button>
          </div>
        ) : (
          <div className="memory-atom__actions">
            <button
              type="button"
              onClick={() => {
                setDraft(atom.value);
                setEditing(true);
              }}
              className="icon-hit memory-atom__icon text-content-secondary hover:bg-surface-elevated hover:text-content-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
              title="Edit this memory"
              aria-label={`Edit memory: ${atom.value}`}
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                void onDelete(atom.id);
              }}
              className="icon-hit memory-atom__icon text-content-secondary hover:bg-feedback-dangerSubtle hover:text-feedback-danger transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
              title="Forget this memory"
              aria-label={`Forget memory: ${atom.value}`}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    </li>
  );
}
