import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileText, ImageIcon, MessageSquarePlus, Pencil, Search, Trash2, UploadCloud } from 'lucide-react';
import { Modal, ModalBody, ModalHeader } from '../ui/Modal';
import { cn } from '../../utils/ui/cn';
import { useLibraryStore } from '../../store/library.ts';
import { useComposerFilesStore } from '../../store/composerFiles.ts';
import { useSessionStore, useToastStore } from '../../store';
import { confirmAction } from '../../store/confirm.ts';
import { libraryApi } from '../../files/api.ts';
import { deleteLocalFile, listLocalLibrary, renameLocalFile } from '../../files/localStore.ts';
import { attachExisting } from '../../files/attachExisting.ts';
import { ACCEPTED_TYPES, formatBytes, type LibraryFile, type LibraryUsage } from '../../files/types.ts';

type Filter = 'all' | 'image' | 'pdf';

/** Guest defaults, until the allowance arrives (backend/configs/json/api_limits.json). */
const GUEST_FILES = 10;
const GUEST_DAYS = 7;

function when(seconds: number): string {
  const date = new Date(seconds > 1e12 ? seconds : seconds * 1000);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function Meter({ usage }: { usage: LibraryUsage }) {
  const fraction = usage.bytes_limit ? Math.min(1, usage.bytes / usage.bytes_limit) : 0;
  return (
    <div className="library-meter" aria-label="Library storage">
      <div className="library-meter__track">
        <div className="library-meter__fill" style={{ width: `${Math.max(2, fraction * 100)}%` }} />
      </div>
      <p className="library-meter__label">
        {formatBytes(usage.bytes)} of {formatBytes(usage.bytes_limit)} · {usage.files} of {usage.files_limit} files
      </p>
    </div>
  );
}

export const LibraryModal: React.FC = () => {
  const isOpen = useLibraryStore((state) => state.isOpen);
  const picking = useLibraryStore((state) => state.picking);
  const close = useLibraryStore((state) => state.close);
  const signedIn = useSessionStore((state) => state.isAuthenticated);
  const pushToast = useToastStore((state) => state.push);
  const allowance = useComposerFilesStore((state) => state.allowance);
  const [files, setFiles] = useState<LibraryFile[]>([]);
  const [usage, setUsage] = useState<LibraryUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [renaming, setRenaming] = useState<string | null>(null);
  const localUrls = useRef<string[]>([]);
  const uploadRef = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (q: string) => {
      setLoading(true);
      setError('');
      try {
        if (signedIn) {
          const res = await libraryApi.list(q);
          setFiles(res.files);
          setUsage(res.usage);
        } else {
          localUrls.current.forEach((url) => URL.revokeObjectURL(url));
          localUrls.current = [];
          const records = await listLocalLibrary(allowance?.library_files || GUEST_FILES, allowance?.library_days || GUEST_DAYS);
          const needle = q.trim().toLowerCase();
          const matching = needle
            ? records.filter((r) =>
                `${r.name} ${r.digest.title} ${r.digest.summary} ${r.digest.pages.map((p) => p.text.slice(0, 400)).join(' ')}`
                  .toLowerCase()
                  .includes(needle),
              )
            : records;
          setFiles(
            matching.map((r) => {
              const thumb = URL.createObjectURL(r.thumb);
              localUrls.current.push(thumb);
              return {
                id: r.id,
                name: r.name,
                mime: r.mime,
                kind: r.kind,
                size: r.size,
                pages: r.pages,
                content: r.digest.content,
                title: r.digest.title,
                summary: r.digest.summary,
                previews: r.previews.length,
                created_at: r.createdAt,
                thumb_url: thumb,
                local: true,
              };
            }),
          );
          setUsage(null);
        }
      } catch (err) {
        setError((err as Error).message || 'Could not load your library.');
      } finally {
        setLoading(false);
      }
    },
    [signedIn, allowance?.library_files, allowance?.library_days],
  );

  useEffect(() => {
    if (!isOpen) return;
    const timer = window.setTimeout(() => void load(query), query ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [isOpen, query, load]);

  useEffect(
    () => () => {
      localUrls.current.forEach((url) => URL.revokeObjectURL(url));
    },
    [],
  );

  const shown = useMemo(() => files.filter((f) => filter === 'all' || f.kind === filter), [files, filter]);

  const attach = async (file: LibraryFile) => {
    try {
      await attachExisting(file.local ? { localId: file.id } : { fileId: file.id });
      close();
    } catch (err) {
      pushToast((err as Error).message || 'Could not attach that file.', 'error');
    }
  };

  const openFile = (file: LibraryFile) => {
    useLibraryStore.getState().openViewer({
      attachment: { id: file.local ? file.id : `lib_${file.id}`, kind: file.kind, name: file.name, pages: file.pages, fileId: file.local ? undefined : file.id },
    });
  };

  const remove = async (file: LibraryFile) => {
    const ok = await confirmAction({
      title: `Delete "${file.name}"?`,
      message: 'It leaves your library. Chats that used it keep their messages.',
      confirmLabel: 'Delete',
      tone: 'danger',
      icon: Trash2,
    });
    if (!ok) return;
    try {
      if (file.local) await deleteLocalFile(file.id);
      else await libraryApi.remove(file.id);
      setFiles((current) => current.filter((f) => f.id !== file.id));
      if (usage) setUsage({ ...usage, files: usage.files - 1, bytes: Math.max(0, usage.bytes - file.size) });
    } catch (err) {
      pushToast((err as Error).message || 'Could not delete that file.', 'error');
    }
  };

  const rename = async (file: LibraryFile, name: string) => {
    setRenaming(null);
    const clean = name.trim();
    if (!clean || clean === file.name) return;
    try {
      if (file.local) await renameLocalFile(file.id, clean);
      else await libraryApi.rename(file.id, clean);
      setFiles((current) => current.map((f) => (f.id === file.id ? { ...f, name: clean } : f)));
    } catch (err) {
      pushToast((err as Error).message || 'Could not rename that file.', 'error');
    }
  };

  const onUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!picked.length) return;
    // Added to the message being written; each is kept in the library as it is read.
    useComposerFilesStore.getState().add(picked);
    close();
  };

  const description = signedIn
    ? 'Images and PDFs you shared, synced to your account.'
    : `Kept on this device for ${allowance?.library_days || GUEST_DAYS} days. Sign in to keep files in your account.`;

  return (
    <Modal open={isOpen} onClose={close} labelledBy="library-title" size="xl" flush layer={70} swipeable>
      <ModalHeader
        kicker={picking ? 'Attach from' : undefined}
        title="Library"
        titleId="library-title"
        description={description}
        onClose={close}
        closeLabel="Close library"
      />
      <div className="library-toolbar">
        <label className="library-search">
          <Search className="h-4 w-4 text-content-muted" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search names and contents"
            aria-label="Search your library"
          />
        </label>
        <div className="library-filters" role="tablist" aria-label="Show">
          {(['all', 'image', 'pdf'] as Filter[]).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={filter === value}
              className={cn('library-filter', filter === value && 'is-active')}
              onClick={() => setFilter(value)}
            >
              {value === 'all' ? 'All' : value === 'image' ? 'Images' : 'PDFs'}
            </button>
          ))}
        </div>
        <button type="button" className="library-upload" onClick={() => uploadRef.current?.click()}>
          <UploadCloud className="h-4 w-4" aria-hidden="true" /> Add files
        </button>
        <input ref={uploadRef} type="file" accept={ACCEPTED_TYPES} multiple hidden onChange={onUpload} />
      </div>
      {usage ? <Meter usage={usage} /> : null}

      <ModalBody className="library-body custom-scrollbar">
        {loading && !files.length ? (
          <div className="library-grid" aria-busy="true">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="library-card library-card--skeleton" />
            ))}
          </div>
        ) : error ? (
          <div className="library-empty">
            <p className="text-sm font-medium text-feedback-danger">{error}</p>
            <button type="button" className="library-upload mt-3" onClick={() => void load(query)}>
              Try again
            </button>
          </div>
        ) : !shown.length ? (
          <div className="library-empty">
            <div className="library-empty__art" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <p className="text-sm font-medium text-content-primary">{query ? 'Nothing matches that.' : 'Nothing here yet.'}</p>
            <p className="mt-1 text-sm text-content-secondary">
              {query ? 'Try other words.' : 'Photos and PDFs you share in chat appear here.'}
            </p>
          </div>
        ) : (
          <ul className="library-grid">
            {shown.map((file, index) => (
              <li key={file.id} className="library-card" style={{ '--i': index } as React.CSSProperties}>
                <button
                  type="button"
                  className="library-card__preview"
                  onClick={() => (picking ? void attach(file) : openFile(file))}
                  aria-label={picking ? `Attach ${file.name}` : `Open ${file.name}`}
                >
                  {file.thumb_url ? (
                    <img src={file.thumb_url} alt="" loading="lazy" draggable={false} />
                  ) : file.kind === 'pdf' ? (
                    <FileText className="h-6 w-6 text-content-muted" aria-hidden="true" />
                  ) : (
                    <ImageIcon className="h-6 w-6 text-content-muted" aria-hidden="true" />
                  )}
                  {file.kind === 'pdf' ? <span className="library-card__badge">PDF · {file.pages}p</span> : null}
                </button>
                <div className="library-card__meta">
                  {renaming === file.id ? (
                    <input
                      className="library-card__rename"
                      defaultValue={file.name}
                      autoFocus
                      aria-label="New name"
                      onBlur={(e) => void rename(file, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void rename(file, (e.target as HTMLInputElement).value);
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                    />
                  ) : (
                    <p className="library-card__name" title={file.name}>
                      {file.name}
                    </p>
                  )}
                  <p className="library-card__sub">
                    {when(file.created_at)} · {formatBytes(file.size)}
                  </p>
                  {file.summary ? <p className="library-card__summary">{file.summary}</p> : null}
                </div>
                <div className="library-card__actions">
                  <button type="button" onClick={() => void attach(file)} aria-label={`Attach ${file.name} to your message`} title="Attach to message">
                    <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
                  </button>
                  <button type="button" onClick={() => setRenaming(file.id)} aria-label={`Rename ${file.name}`} title="Rename">
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                  </button>
                  <button type="button" onClick={() => void remove(file)} aria-label={`Delete ${file.name}`} title="Delete">
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </ModalBody>
    </Modal>
  );
};
