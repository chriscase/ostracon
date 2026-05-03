'use client';

// Form-based frontmatter editor (chriscase/abydonian#220).
//
// Replaces the previous behavior where frontmatter rendered as raw YAML in
// the markdown body and required hand-typing. The form sits above the
// markdown editor; values flow back through serializeNote() on save.
//
// Known fields get dedicated controls (tags, status, aliases, related,
// date). Unknown fields pass through unchanged via the `data` object the
// caller passes in/out.

import { useCallback, useState, type KeyboardEvent } from 'react';
import { DEFAULT_STATUS_OPTIONS, type Frontmatter } from '@chriscase/ostracon/server/client';
import styles from './codex.module.css';

interface Props {
  data: Frontmatter;
  onChange: (next: Frontmatter) => void;
  /** Optional override of the status dropdown choices. */
  statusOptions?: ReadonlyArray<string>;
  /** When true, hide the form (used during create-flow when defaults work). */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

export default function FrontmatterForm({
  data,
  onChange,
  statusOptions = DEFAULT_STATUS_OPTIONS,
  collapsed = false,
  onToggleCollapsed,
}: Props) {
  const setField = useCallback(
    (key: keyof Frontmatter, value: unknown) => {
      onChange({ ...data, [key]: value });
    },
    [data, onChange],
  );

  // Identify "unknown" fields so we can preserve them and surface that the
  // form is keeping them around.
  const knownKeys = new Set([
    'tags',
    'status',
    'aliases',
    'related',
    'date',
    'created',
    'repo',
    'last_mined',
  ]);
  const unknownEntries = Object.entries(data).filter(
    ([k, v]) =>
      !knownKeys.has(k) && v !== undefined && v !== null && v !== '',
  );

  if (collapsed) {
    return (
      <div className={styles.frontmatterCollapsed}>
        <button
          type="button"
          className={styles.frontmatterToggle}
          onClick={onToggleCollapsed}
        >
          ▸ Frontmatter
          {data.status && (
            <span className={styles.frontmatterCollapsedBadge}>{data.status}</span>
          )}
          {data.tags && data.tags.length > 0 && (
            <span className={styles.frontmatterCollapsedBadge}>
              {data.tags.length} tag{data.tags.length === 1 ? '' : 's'}
            </span>
          )}
        </button>
      </div>
    );
  }

  return (
    <div className={styles.frontmatterForm}>
      <div className={styles.frontmatterHeader}>
        <strong>Frontmatter</strong>
        {onToggleCollapsed && (
          <button
            type="button"
            className={styles.frontmatterToggle}
            onClick={onToggleCollapsed}
          >
            ▾ Hide
          </button>
        )}
      </div>

      <div className={styles.frontmatterRow}>
        <label className={styles.frontmatterLabel}>
          Status
          <select
            className={styles.frontmatterInput}
            value={data.status ?? ''}
            onChange={(e) => setField('status', e.target.value || undefined)}
          >
            <option value="">— none —</option>
            {statusOptions.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.frontmatterLabel}>
          Date
          <input
            type="text"
            className={styles.frontmatterInput}
            value={(data.date as string | undefined) ?? ''}
            onChange={(e) => setField('date', e.target.value || undefined)}
            placeholder="YYYY-MM-DD"
          />
        </label>

        <label className={styles.frontmatterLabel}>
          Repo
          <input
            type="text"
            className={styles.frontmatterInput}
            value={(data.repo as string | undefined) ?? ''}
            onChange={(e) => setField('repo', e.target.value || undefined)}
            placeholder="owner/repo"
          />
        </label>
      </div>

      <ChipField
        label="Tags"
        values={data.tags ?? []}
        onChange={(next) => setField('tags', next)}
        placeholder="add tag…"
      />

      <ChipField
        label="Aliases"
        values={data.aliases ?? []}
        onChange={(next) => setField('aliases', next)}
        placeholder="add alias…"
      />

      <ChipField
        label="Related"
        values={data.related ?? []}
        onChange={(next) => setField('related', next)}
        placeholder="[[wikilink]]…"
      />

      {unknownEntries.length > 0 && (
        <div className={styles.frontmatterUnknown}>
          <strong>Other fields</strong> (preserved on save):{' '}
          {unknownEntries.map(([k]) => (
            <code key={k} className={styles.frontmatterUnknownChip}>
              {k}
            </code>
          ))}
        </div>
      )}
    </div>
  );
}

function ChipField({
  label,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState<string>('');

  const commit = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (values.includes(trimmed)) {
      setDraft('');
      return;
    }
    onChange([...values, trimmed]);
    setDraft('');
  }, [draft, values, onChange]);

  const removeAt = useCallback(
    (idx: number) => {
      onChange(values.filter((_, i) => i !== idx));
    },
    [values, onChange],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === ',') {
        // Comma also commits — common in tag UIs.
        e.preventDefault();
        commit();
      } else if (e.key === 'Backspace' && draft === '' && values.length > 0) {
        e.preventDefault();
        removeAt(values.length - 1);
      }
    },
    [commit, draft, values.length, removeAt],
  );

  return (
    <label className={styles.frontmatterLabel}>
      {label}
      <div className={styles.chipField}>
        {values.map((v, i) => (
          <span key={`${v}-${i}`} className={styles.chip}>
            {v}
            <button
              type="button"
              className={styles.chipRemove}
              onClick={() => removeAt(i)}
              aria-label={`Remove ${label} ${v}`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          type="text"
          className={styles.chipInput}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={commit}
          placeholder={placeholder}
          spellCheck={false}
        />
      </div>
    </label>
  );
}
