'use client';

// Vault-wide find-and-replace (chriscase/abydonian#226).
//
// Flow: user types query + replacement, optional flags (case, regex, whole
// word, wikilink-aware, glob scope) → Preview button runs the non-mutating
// vaultPreviewReplacement query → list of matches with excerpts → Apply
// button calls vaultApplyReplacement which commits the whole batch in one
// git commit.

import { useEffect, useState } from 'react';
import { useCodexGraphqlRequest } from './CodexAdapters';
import styles from './codex.module.css';

const PREVIEW_QUERY = `
  query PreviewReplacement(
    $query: String!
    $replacement: String!
    $caseSensitive: Boolean
    $regex: Boolean
    $wholeWord: Boolean
    $wikilinkAware: Boolean
    $pathScope: [String!]
  ) {
    vaultPreviewReplacement(
      query: $query
      replacement: $replacement
      caseSensitive: $caseSensitive
      regex: $regex
      wholeWord: $wholeWord
      wikilinkAware: $wikilinkAware
      pathScope: $pathScope
    ) {
      totalMatches
      fileCount
      truncated
      error
      matches {
        path
        count
        excerpts { line column snippet }
      }
    }
  }
`;

const APPLY_MUTATION = `
  mutation ApplyReplacement(
    $query: String!
    $replacement: String!
    $caseSensitive: Boolean
    $regex: Boolean
    $wholeWord: Boolean
    $wikilinkAware: Boolean
    $pathScope: [String!]
    $commitMessage: String
  ) {
    vaultApplyReplacement(
      query: $query
      replacement: $replacement
      caseSensitive: $caseSensitive
      regex: $regex
      wholeWord: $wholeWord
      wikilinkAware: $wikilinkAware
      pathScope: $pathScope
      commitMessage: $commitMessage
    ) {
      kind
      commitSha
      filesChanged
      totalReplacements
      reason
    }
  }
`;

interface PreviewExcerpt {
  line: number;
  column: number;
  snippet: string;
}
interface PreviewMatch {
  path: string;
  count: number;
  excerpts: PreviewExcerpt[];
}
interface PreviewResponse {
  totalMatches: number;
  fileCount: number;
  truncated: boolean;
  error?: string | null;
  matches: PreviewMatch[];
}
interface ApplyResponse {
  kind: 'OK' | 'NOOP' | 'INVALID';
  commitSha?: string | null;
  filesChanged?: string[] | null;
  totalReplacements?: number | null;
  reason?: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called after a successful apply so the parent can refresh the tree. */
  onApplied?: (totalReplacements: number, filesChanged: number) => void;
}

export default function FindReplaceDialog({ open, onClose, onApplied }: Props) {
  const graphqlRequest = useCodexGraphqlRequest();
  const [query, setQuery] = useState<string>('');
  const [replacement, setReplacement] = useState<string>('');
  const [caseSensitive, setCaseSensitive] = useState<boolean>(false);
  const [regex, setRegex] = useState<boolean>(false);
  const [wholeWord, setWholeWord] = useState<boolean>(false);
  const [wikilinkAware, setWikilinkAware] = useState<boolean>(false);
  const [pathScope, setPathScope] = useState<string>('');
  const [commitMessage, setCommitMessage] = useState<string>('');
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewing, setPreviewing] = useState<boolean>(false);
  const [applying, setApplying] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setReplacement('');
    setCaseSensitive(false);
    setRegex(false);
    setWholeWord(false);
    setWikilinkAware(false);
    setPathScope('');
    setCommitMessage('');
    setPreview(null);
    setError(null);
    setPreviewing(false);
    setApplying(false);
  }, [open]);

  if (!open) return null;

  const buildVariables = () => ({
    query,
    replacement,
    caseSensitive,
    regex,
    wholeWord,
    wikilinkAware,
    pathScope: pathScope.trim()
      ? pathScope
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      : null,
  });

  async function runPreview() {
    setError(null);
    setPreview(null);
    setPreviewing(true);
    try {
      const { data, errors } = await graphqlRequest<{ vaultPreviewReplacement: PreviewResponse }>(
        PREVIEW_QUERY,
        buildVariables(),
      );
      if (errors?.length) {
        setError(errors.map((e) => e.message).join('; '));
        return;
      }
      const out = data?.vaultPreviewReplacement;
      if (!out) {
        setError('Empty preview response');
        return;
      }
      if (out.error) setError(out.error);
      setPreview(out);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setPreviewing(false);
    }
  }

  async function runApply() {
    if (!preview || preview.totalMatches === 0) return;
    if (
      !confirm(
        `Apply replacement to ${preview.totalMatches} match${preview.totalMatches === 1 ? '' : 'es'} across ${preview.matches.length} file${preview.matches.length === 1 ? '' : 's'}? This is a single git commit.`,
      )
    )
      return;
    setApplying(true);
    setError(null);
    try {
      const { data, errors } = await graphqlRequest<{ vaultApplyReplacement: ApplyResponse }>(
        APPLY_MUTATION,
        { ...buildVariables(), commitMessage: commitMessage.trim() || null },
      );
      if (errors?.length) {
        setError(errors.map((e) => e.message).join('; '));
        return;
      }
      const r = data?.vaultApplyReplacement;
      if (!r) {
        setError('Empty apply response');
        return;
      }
      switch (r.kind) {
        case 'OK': {
          const tr = r.totalReplacements ?? 0;
          const fc = r.filesChanged?.length ?? 0;
          onApplied?.(tr, fc);
          onClose();
          break;
        }
        case 'NOOP':
        case 'INVALID':
          setError(r.reason ?? `Apply failed (${r.kind})`);
          break;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Apply failed');
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className={styles.modalBackdrop} onClick={onClose} role="presentation">
      <div
        className={styles.modal}
        style={{ width: 'min(720px, 92vw)', maxHeight: '88vh', overflow: 'auto' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <h3 style={{ marginTop: 0 }}>Find &amp; replace across vault</h3>
        <p style={{ marginTop: 0, fontSize: '0.85rem', opacity: 0.85 }}>
          Auto-managed paths (<code>70 - Journals/</code>, <code>80 - Daily/</code>) are
          always skipped. Preview is non-mutating; Apply commits all changes in one
          git commit.
        </p>

        <div className={styles.frontmatterRow}>
          <label className={styles.modalLabel}>
            Find
            <input
              type="text"
              className={styles.modalInput}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
              spellCheck={false}
            />
          </label>
          <label className={styles.modalLabel}>
            Replace with
            <input
              type="text"
              className={styles.modalInput}
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              spellCheck={false}
            />
          </label>
        </div>

        <div className={styles.findReplaceFlags}>
          <label>
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={(e) => setCaseSensitive(e.target.checked)}
            />{' '}
            Case-sensitive
          </label>
          <label>
            <input
              type="checkbox"
              checked={regex}
              onChange={(e) => {
                setRegex(e.target.checked);
                if (e.target.checked) setWikilinkAware(false);
              }}
            />{' '}
            Regex
          </label>
          <label>
            <input
              type="checkbox"
              checked={wholeWord}
              onChange={(e) => setWholeWord(e.target.checked)}
              disabled={regex}
            />{' '}
            Whole word
          </label>
          <label>
            <input
              type="checkbox"
              checked={wikilinkAware}
              onChange={(e) => {
                setWikilinkAware(e.target.checked);
                if (e.target.checked) setRegex(false);
              }}
              disabled={regex}
            />{' '}
            Wikilink-aware (treat query/replacement as old/new vault paths)
          </label>
        </div>

        <label className={styles.modalLabel}>
          Path scope (optional, glob; comma- or whitespace-separated)
          <input
            type="text"
            className={styles.modalInput}
            value={pathScope}
            onChange={(e) => setPathScope(e.target.value)}
            placeholder="20 - Products/*.md, 30 - Architecture/**/*.md"
            spellCheck={false}
          />
        </label>

        <label className={styles.modalLabel}>
          Commit message (optional)
          <input
            type="text"
            className={styles.modalInput}
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            placeholder={`Replace "${query || '...'}" → "${replacement || '...'}" via admin panel`}
          />
        </label>

        {error && <div className={styles.toastError}>{error}</div>}

        {preview && !preview.error && (
          <div className={styles.findReplacePreview}>
            <div>
              <strong>
                {preview.totalMatches} match{preview.totalMatches === 1 ? '' : 'es'}
              </strong>{' '}
              in {preview.matches.length} file{preview.matches.length === 1 ? '' : 's'}
              {preview.truncated && ' (preview list truncated)'}
            </div>
            <ul className={styles.findReplaceMatchList}>
              {preview.matches.map((m) => (
                <li key={m.path}>
                  <div className={styles.findReplaceMatchPath}>
                    <code>{m.path}</code>
                    <span className={styles.findReplaceMatchCount}>
                      {m.count} match{m.count === 1 ? '' : 'es'}
                    </span>
                  </div>
                  {m.excerpts.length > 0 && (
                    <ul className={styles.findReplaceExcerptList}>
                      {m.excerpts.map((ex, i) => (
                        <li key={i}>
                          <span className={styles.findReplaceLine}>
                            {ex.line}:{ex.column}
                          </span>{' '}
                          <code>{ex.snippet}</code>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className={styles.editorActions} style={{ marginTop: '1rem' }}>
          <button type="button" onClick={onClose} className={styles.btnSecondary} disabled={applying}>
            Cancel
          </button>
          <button
            type="button"
            onClick={runPreview}
            className={styles.btnSecondary}
            disabled={previewing || applying || !query.trim()}
          >
            {previewing ? 'Searching…' : 'Preview'}
          </button>
          <button
            type="button"
            onClick={runApply}
            className={styles.btnDanger}
            disabled={
              applying ||
              previewing ||
              !preview ||
              preview.totalMatches === 0 ||
              !!preview.error
            }
          >
            {applying ? 'Applying…' : `Apply${preview ? ` (${preview.totalMatches})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
