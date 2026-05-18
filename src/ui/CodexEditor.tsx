'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  parseNote,
  serializeNote,
  type Frontmatter,
} from '@chriscase/ostracon/server/client';
import { useCodexGraphqlRequest } from './CodexAdapters';
import { useShortcuts } from './useKeyboardShortcuts';
import FrontmatterForm from './FrontmatterForm';
import styles from './codex.module.css';

interface AttachmentResponse {
  path: string;
  embed: string;
  commitSha: string;
  bytes: number;
}

interface AttachmentError {
  error: string;
  maxBytes?: number;
  allowed?: string[];
}

async function uploadAttachmentRequest(
  file: File,
): Promise<{ ok: true; data: AttachmentResponse } | { ok: false; error: string }> {
  const form = new FormData();
  form.append('file', file);
  try {
    const res = await fetch('/api/admin/codex/attachment', {
      method: 'POST',
      body: form,
      credentials: 'include',
    });
    const json = (await res.json().catch(() => null)) as
      | AttachmentResponse
      | AttachmentError
      | null;
    if (!res.ok) {
      return {
        ok: false,
        error:
          (json && 'error' in json && json.error) ||
          `Upload failed (HTTP ${res.status})`,
      };
    }
    if (!json || !('embed' in json)) {
      return { ok: false, error: 'Unexpected upload response' };
    }
    return { ok: true, data: json };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Upload failed' };
  }
}

// MDEditor pulls in CodeMirror; SSR-incompatible.
const MDEditor = dynamic(
  () => import('@uiw/react-md-editor').then((m) => m.default),
  { ssr: false, loading: () => <div className={styles.spinnerWrap}>Loading editor…</div> },
);

const SAVE_NOTE = `
  mutation SaveNote($path: String!, $content: String!, $baseSha: String!, $userMessage: String) {
    saveNote(path: $path, content: $content, baseSha: $baseSha, userMessage: $userMessage) {
      kind
      newSha
      commitSha
      currentContent
      currentSha
      reason
      secrets {
        pattern
        line
        snippet
      }
    }
  }
`;

const CREATE_NOTE = `
  mutation CreateNote($path: String!, $content: String!, $userMessage: String) {
    createNote(path: $path, content: $content, userMessage: $userMessage) {
      kind
      newSha
      commitSha
      currentContent
      currentSha
      reason
      secrets {
        pattern
        line
        snippet
      }
    }
  }
`;

interface CodexSaveResult {
  kind: 'OK' | 'CONFLICT' | 'SECRETS' | 'AUTO_MANAGED' | 'NOOP';
  newSha?: string | null;
  commitSha?: string | null;
  currentContent?: string | null;
  currentSha?: string | null;
  reason?: string | null;
  secrets?: Array<{ pattern: string; line: number; snippet: string }> | null;
}

interface Props {
  path: string;
  initialContent: string;
  /** SHA of `initialContent` as observed when the note was loaded; used as baseSha. Null = create. */
  baseSha: string | null;
  isAutoManaged?: boolean;
  onCancel: () => void;
  onSaved: (newSha: string) => void;
}

type ToastState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'ok'; commitSha: string }
  | { kind: 'noop' }
  | { kind: 'auto-managed'; reason: string }
  | { kind: 'secrets'; hits: Array<{ pattern: string; line: number; snippet: string }> }
  | { kind: 'conflict'; currentContent: string; currentSha: string }
  | { kind: 'error'; message: string };

export default function CodexEditor({
  path,
  initialContent,
  baseSha,
  isAutoManaged = false,
  onCancel,
  onSaved,
}: Props) {
  const graphqlRequest = useCodexGraphqlRequest();
  // Parse initialContent into frontmatter + body once per (path, initialContent)
  // change. State holds the form-edited frontmatter + the body text separately;
  // we re-serialize on save.
  const initialParsed = useMemo(() => parseNote(initialContent), [initialContent]);
  const [frontmatter, setFrontmatter] = useState<Frontmatter>(initialParsed.data);
  const [body, setBody] = useState<string>(initialParsed.content);
  const [userMessage, setUserMessage] = useState<string>('');
  const [toast, setToast] = useState<ToastState>({ kind: 'idle' });
  const [frontmatterCollapsed, setFrontmatterCollapsed] = useState<boolean>(false);
  // currentBaseSha tracks the latest SHA the server has confirmed — bumped after
  // a successful save so the next save uses the new value.
  const [currentBaseSha, setCurrentBaseSha] = useState<string | null>(baseSha);
  // Snapshot of the serialized initial content; used to compute `dirty` even
  // when the form mutates frontmatter without touching the body.
  const initialSerialized = useMemo(
    () => serializeNote(initialParsed.data, initialParsed.content),
    [initialParsed],
  );

  // Reset editor state when switching notes.
  useEffect(() => {
    setFrontmatter(initialParsed.data);
    setBody(initialParsed.content);
    setCurrentBaseSha(baseSha);
    setUserMessage('');
    setToast({ kind: 'idle' });
    setFrontmatterCollapsed(false);
  }, [path, initialParsed, baseSha]);

  const content = useMemo(
    () => serializeNote(frontmatter, body),
    [frontmatter, body],
  );
  const dirty = content !== initialSerialized;

  // Keep the latest content in a ref so the keyboard shortcut handler always
  // reads the current value without stale closures.
  const contentRef = useRef<string>(content);
  contentRef.current = content;

  async function handleSave() {
    if (toast.kind === 'saving') return;
    setToast({ kind: 'saving' });

    try {
      const isCreate = currentBaseSha === null;
      const query = isCreate ? CREATE_NOTE : SAVE_NOTE;
      const variables: Record<string, unknown> = {
        path,
        content,
        userMessage: userMessage.trim() || undefined,
      };
      if (!isCreate) variables.baseSha = currentBaseSha;

      const { data, errors } = await graphqlRequest<{
        saveNote?: CodexSaveResult;
        createNote?: CodexSaveResult;
      }>(query, variables);

      if (errors?.length) {
        setToast({ kind: 'error', message: errors.map((e) => e.message).join('; ') });
        return;
      }

      const result = data?.saveNote ?? data?.createNote;
      if (!result) {
        setToast({ kind: 'error', message: 'Empty response from server' });
        return;
      }

      switch (result.kind) {
        case 'OK':
          setCurrentBaseSha(result.newSha ?? null);
          setToast({ kind: 'ok', commitSha: result.commitSha ?? '' });
          if (result.newSha) onSaved(result.newSha);
          break;
        case 'NOOP':
          setToast({ kind: 'noop' });
          if (result.newSha) setCurrentBaseSha(result.newSha);
          break;
        case 'AUTO_MANAGED':
          setToast({ kind: 'auto-managed', reason: result.reason ?? 'File is auto-managed' });
          break;
        case 'SECRETS':
          setToast({ kind: 'secrets', hits: result.secrets ?? [] });
          break;
        case 'CONFLICT':
          setToast({
            kind: 'conflict',
            currentContent: result.currentContent ?? '',
            currentSha: result.currentSha ?? '',
          });
          break;
      }
    } catch (err) {
      setToast({ kind: 'error', message: err instanceof Error ? err.message : 'Save failed' });
    }
  }

  function handleAcceptTheirs() {
    if (toast.kind !== 'conflict') return;
    const reparsed = parseNote(toast.currentContent);
    setFrontmatter(reparsed.data);
    setBody(reparsed.content);
    setCurrentBaseSha(toast.currentSha);
    setToast({ kind: 'idle' });
  }

  function handleOverrideMine() {
    if (toast.kind !== 'conflict') return;
    // Force-save by bumping baseSha to the server's current SHA, then re-saving.
    setCurrentBaseSha(toast.currentSha);
    setToast({ kind: 'idle' });
    // The next click on Save will succeed (or hit a fresh conflict).
  }

  // Cmd+S / Ctrl+S triggers save, scoped to this editor instance.
  // This is the editor-local binding; the global Cmd+K palette and Cmd+P
  // quick-open live one level up in CodexBrowser.
  useShortcuts({
    'mod+s': (e) => {
      e.preventDefault();
      // Only fire when the editor is dirty + savable; otherwise the browser's
      // own Save dialog should NOT pop up either, so we still preventDefault.
      if (toast.kind === 'saving') return;
      if (!dirty && currentBaseSha !== null) return;
      void handleSave();
    },
  });

  // ─── Attachment upload (chriscase/abydonian#221) ────────────────────────
  const [uploading, setUploading] = useState<boolean>(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const appendEmbed = useCallback((embed: string) => {
    setBody((prev) => {
      // Append on its own line. Two newlines so the embed becomes a
      // standalone paragraph; one newline if the body already ends with one.
      const sep = prev.endsWith('\n\n') ? '' : prev.endsWith('\n') ? '\n' : '\n\n';
      return prev + sep + embed + '\n';
    });
  }, []);

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;
      setUploading(true);
      setUploadError(null);
      try {
        for (const file of list) {
          const result = await uploadAttachmentRequest(file);
          if (!result.ok) {
            setUploadError(result.error);
            return;
          }
          appendEmbed(result.data.embed);
        }
      } finally {
        setUploading(false);
      }
    },
    [appendEmbed],
  );

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      if (!e.dataTransfer.files?.length) return;
      e.preventDefault();
      setDragActive(false);
      await handleFiles(e.dataTransfer.files);
    },
    [handleFiles],
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragActive(true);
  }, []);
  const onDragLeave = useCallback(() => setDragActive(false), []);

  const onPaste = useCallback(
    async (e: React.ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length === 0) return;
      // Only handle paste when we got actual file blobs (e.g. screenshot
      // copy-paste). Plain-text paste continues to flow into the editor.
      e.preventDefault();
      await handleFiles(files);
    },
    [handleFiles],
  );

  const onPickFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files) await handleFiles(files);
      if (e.target) e.target.value = '';
    },
    [handleFiles],
  );

  return (
    <div className={styles.editorRoot}>
      <div className={styles.editorHeader}>
        <div>
          <strong>{baseSha === null ? 'New document' : 'Editing'}</strong>
          <span className={styles.notePath} style={{ marginLeft: '0.5rem' }}>{path}</span>
        </div>
        <div className={styles.editorActions}>
          {baseSha !== null && (
            <a
              href={
                // next-intl middleware excludes any URL containing `.` as a
                // static-asset, so we strip the .md extension and segment-
                // encode (mirrors noteHref). The page route re-appends .md
                // server-side from the joined segments.
                '/admin/codex/graph/note/' +
                path
                  .replace(/\.md$/i, '')
                  .split(/[\\/]/g)
                  .map((seg) => encodeURIComponent(seg))
                  .join('/')
              }
              className={styles.btnSecondary}
              title="Show this document's link graph (across all folders)"
            >
              🕸 Linkages
            </a>
          )}
          <button type="button" onClick={onCancel} className={styles.btnSecondary}>
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={toast.kind === 'saving' || (!dirty && baseSha !== null)}
            className={styles.btnPrimary}
            title="Save (⌘S)"
          >
            {toast.kind === 'saving' ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {isAutoManaged && (
        <div className={styles.autoBanner}>
          This document has an auto-managed Activity section that the nightly journal-mining
          script regenerates. Edit safe sections (Sessions, Decisions, Notes) only.
        </div>
      )}

      <input
        type="text"
        className={styles.editorCommitMessage}
        placeholder="Why? (optional — adds context to this commit)"
        value={userMessage}
        onChange={(e) => setUserMessage(e.target.value)}
        aria-label="Optional commit reason"
      />

      <FrontmatterForm
        data={frontmatter}
        onChange={setFrontmatter}
        collapsed={frontmatterCollapsed}
        onToggleCollapsed={() => setFrontmatterCollapsed((v) => !v)}
      />

      <div className={styles.attachmentToolbar}>
        <button
          type="button"
          className={styles.btnSecondary}
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? 'Uploading…' : '+ Attach file'}
        </button>
        <span className={styles.attachmentHint}>
          Or drag-and-drop / paste an image directly into the editor.
        </span>
        <input
          ref={fileInputRef}
          type="file"
          style={{ display: 'none' }}
          onChange={onPickFile}
          accept="image/*,.pdf"
        />
      </div>
      {uploadError && <div className={styles.toastError}>Upload error: {uploadError}</div>}

      <div
        className={`${styles.editorBody} ${dragActive ? styles.editorBodyDropActive : ''}`}
        data-color-mode="dark"
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onPaste={onPaste}
      >
        <MDEditor
          value={body}
          onChange={(v) => setBody(v ?? '')}
          height={500}
          preview="live"
          visibleDragbar={false}
        />
        {dragActive && (
          <div className={styles.editorDropOverlay}>Drop to attach to this document</div>
        )}
      </div>

      <Toast toast={toast} onAcceptTheirs={handleAcceptTheirs} onOverrideMine={handleOverrideMine} />
    </div>
  );
}

function Toast({
  toast,
  onAcceptTheirs,
  onOverrideMine,
}: {
  toast: ToastState;
  onAcceptTheirs: () => void;
  onOverrideMine: () => void;
}) {
  switch (toast.kind) {
    case 'idle':
    case 'saving':
      return null;
    case 'ok':
      return (
        <div className={styles.toastOk}>
          Saved · commit {toast.commitSha.slice(0, 7) || '(pending)'}
        </div>
      );
    case 'noop':
      return <div className={styles.toastInfo}>No changes to save.</div>;
    case 'auto-managed':
      return <div className={styles.toastError}>{toast.reason}</div>;
    case 'secrets':
      return (
        <div className={styles.toastError}>
          <strong>Refused: secret-like content detected.</strong>
          <ul style={{ margin: '0.5rem 0 0 1rem', padding: 0 }}>
            {toast.hits.map((h, i) => (
              <li key={i}>
                <code>{h.pattern}</code> at line {h.line}: <code>{h.snippet}</code>
              </li>
            ))}
          </ul>
          <p style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}>
            Remove the credential and re-save. Vault content is not the place for secrets.
          </p>
        </div>
      );
    case 'conflict':
      return (
        <div className={styles.toastConflict}>
          <strong>Conflict — this file changed on disk while you were editing.</strong>
          <p style={{ margin: '0.5rem 0', fontSize: '0.85rem' }}>
            Choose how to resolve. <em>Discard mine</em> drops your edits and loads the latest;
            <em> Override</em> updates your baseline and re-tries the save (your changes will
            land as a new commit on top of theirs).
          </p>
          <div className={styles.editorActions}>
            <button type="button" onClick={onAcceptTheirs} className={styles.btnSecondary}>
              Discard mine
            </button>
            <button type="button" onClick={onOverrideMine} className={styles.btnDanger}>
              Override
            </button>
          </div>
        </div>
      );
    case 'error':
      return <div className={styles.toastError}>Error: {toast.message}</div>;
  }
}
