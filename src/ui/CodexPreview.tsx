'use client';

import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSlug from 'rehype-slug';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import { useCodexNavigation } from './CodexAdapters';
import { noteHref } from './CodexTree';
import { useConceptPopoverDelegation } from './ConceptPopover';
import styles from './codex.module.css';

export interface CodexResolvedLink {
  target: string;
  anchor?: string | null;
  alias?: string | null;
  isEmbed: boolean;
  resolvedPath: string | null;
}

export interface CodexNote {
  path: string;
  title: string;
  folder: string;
  status?: string | null;
  tags: string[];
  isAutoManaged: boolean;
  /** SHA-256 of the file content as observed at read time. */
  sha: string;
  content: string;
  outboundLinks: CodexResolvedLink[];
  inboundLinks: Array<{
    path: string;
    title: string;
    folder: string;
    status?: string | null;
  }>;
}

interface Props {
  note: CodexNote;
  canEdit?: boolean;
  onEdit?: () => void;
  /** Optional callback to open the per-note history side panel. */
  onShowHistory?: () => void;
  /** Whether the history panel is currently open — toggles the History button's
   *  pressed/active styling so the click registers visibly even if the panel
   *  itself opens below the fold. */
  historyOpen?: boolean;
}

const ACTIVITY_HEADING_RE = /\n## Activity[^\n]*\n(?:.*?\n)*?(?=\n## |$)/s;

/**
 * Strip frontmatter from raw markdown. The vault index already parses it for
 * metadata; we don't want gray-matter to re-render it as YAML in the preview.
 */
function stripFrontmatter(content: string): string {
  if (content.startsWith('---\n')) {
    const end = content.indexOf('\n---\n', 4);
    if (end > 0) return content.slice(end + 5);
  }
  return content;
}

// Image / PDF / SVG / WebP extensions render inline through the blob route.
// Anything else gets a download link (e.g. a generic .pdf could go either
// way; we render PDFs as a link rather than embedding because most browsers
// stick a giant viewer in the page).
const INLINE_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp']);

function attachmentExt(target: string): string {
  const dot = target.lastIndexOf('.');
  if (dot < 0) return '';
  return target.slice(dot + 1).toLowerCase();
}

/**
 * Build the URL path served by `/api/admin/codex/blob/[...path]`. The blob
 * route does its own path-traversal guard via resolveVaultPath; we just
 * URL-encode each segment.
 */
function blobHref(rel: string): string {
  return (
    '/api/admin/codex/blob/' +
    rel
      .split(/[\\/]/g)
      .map((segment) => encodeURIComponent(segment))
      .join('/')
  );
}

/**
 * Replace [[wikilinks]] in the markdown source with native markdown so
 * react-markdown renders them.
 *
 * Resolved note links → markdown links to the codex route.
 * Image embeds → `![]()` markdown so react-markdown emits an `<img>` pointing
 * at the blob route (chriscase/abydonian#222).
 * PDF / other binary embeds → markdown link (no inline preview, but a click
 * opens the file via the blob route).
 * Unresolved → italic text so the user sees the broken link rather than
 * losing it silently.
 */
function rewriteWikilinks(content: string, links: CodexResolvedLink[]): string {
  if (links.length === 0) return content;

  // Re-scan the content with the same regex so we can splice deterministically;
  // GraphQL gives us one link per occurrence in document order.
  const RE = /(!)?\[\[([^\]|#\n]+)(?:#([^\]|\n]+))?(?:\|([^\]\n]+))?\]\]/g;
  let cursor = 0;
  let out = '';
  let i = 0;
  for (const m of content.matchAll(RE)) {
    const link = links[i++];
    if (!link) break;
    out += content.slice(cursor, m.index ?? 0);
    cursor = (m.index ?? 0) + m[0].length;

    const display = link.alias ?? link.target.split(/[\\/]/g).pop() ?? link.target;
    if (link.isEmbed) {
      const ext = attachmentExt(link.target);
      // Resolve the embed path: if the GraphQL resolver matched it as a note
      // (rare for images but possible if the user actually embedded a .md),
      // we trust resolvedPath. Otherwise we assume the target is a vault-
      // relative attachment path; if it's bare basename ("foo.png") we try
      // the default attachments dir as a fallback.
      const path =
        link.resolvedPath ??
        (link.target.includes('/') ? link.target : `_attachments/${link.target}`);
      if (INLINE_IMAGE_EXTS.has(ext)) {
        out += `![${display}](${blobHref(path)})`;
      } else if (ext === 'pdf') {
        // Render PDFs as a download link with a hint — embedding them inline
        // hijacks the page in most browsers.
        out += `[📄 ${display}](${blobHref(path)})`;
      } else if (link.resolvedPath) {
        // Embed of a note (transclusion). Render as a clickable link to the
        // note rather than a placeholder.
        const href = noteHref(link.resolvedPath);
        out += `[${display}](${href}${link.anchor ? '#' + link.anchor : ''})`;
      } else {
        out += `*![[${display}]]*`;
      }
    } else if (link.resolvedPath) {
      const href = noteHref(link.resolvedPath);
      out += `[${display}](${href}${link.anchor ? '#' + link.anchor : ''})`;
    } else {
      // Unresolved: render as italic with the original text in title attr.
      out += `*${display}*`;
    }
  }
  out += content.slice(cursor);
  return out;
}

function statusClass(status: string | null | undefined): string | null {
  switch ((status ?? '').toLowerCase()) {
    case 'active':
      return styles.statusActive;
    case 'paused':
      return styles.statusPaused;
    case 'archived':
      return styles.statusArchived;
    default:
      return null;
  }
}

export default function CodexPreview({ note, canEdit, onEdit, onShowHistory, historyOpen }: Props) {
  const { Link } = useCodexNavigation();
  const md = useMemo(() => {
    const stripped = stripFrontmatter(note.content);
    return rewriteWikilinks(stripped, note.outboundLinks);
  }, [note.content, note.outboundLinks]);

  // One delegated set of hover / long-press handlers for ALL wikilinks
  // in the rendered markdown — instead of N PreviewLink components, one
  // listener at the wrapper. Major perf win on documents with many
  // cross-references (_Glossary.md has ~300 wikilinks).
  const { containerProps: wikilinkHandlers, popover } =
    useConceptPopoverDelegation();

  const sClass = statusClass(note.status);
  const showAutoBanner = note.isAutoManaged && ACTIVITY_HEADING_RE.test(note.content);

  return (
    // The delegated wikilink-popover handlers attach to the root so any
    // codex-route <a> rendered anywhere in this view (markdown body,
    // "Linked from" list, future surfaces) opens the preview popover
    // without extra wiring.
    <div {...wikilinkHandlers}>
      <div className={styles.noteHeader}>
        <h2 style={{ margin: 0 }}>{note.title}</h2>
        {sClass && <span className={`${styles.statusBadge} ${sClass}`}>{note.status}</span>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem' }}>
          {onShowHistory && (
            <button
              type="button"
              className={`${styles.btnSecondary}${historyOpen ? ' ' + styles.btnSecondaryActive : ''}`}
              onClick={onShowHistory}
              aria-pressed={historyOpen ? 'true' : 'false'}
            >
              {historyOpen ? 'Hide history' : 'History'}
            </button>
          )}
          {canEdit && onEdit && (
            <button type="button" className={styles.btnPrimary} onClick={onEdit}>
              Edit
            </button>
          )}
        </div>
      </div>
      <div className={styles.notePath}>{note.path}</div>

      {note.tags.length > 0 && (
        <div className={styles.tagRow}>
          {note.tags.map((t) => (
            <span key={t} className={styles.tag}>#{t}</span>
          ))}
        </div>
      )}

      {showAutoBanner && (
        <div className={styles.autoBanner}>
          The <code>## Activity</code> section in this note is regenerated nightly by the
          journal-mining script. Anything you add inside that section will be overwritten.
        </div>
      )}

      <div className={styles.markdown}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeSlug, [rehypeAutolinkHeadings, { behavior: 'wrap' }]]}
        >
          {md}
        </ReactMarkdown>
      </div>
      {popover}

      {note.inboundLinks.length > 0 && (
        <div className={styles.inboundLinks}>
          <h3>Linked from</h3>
          <ul>
            {note.inboundLinks.map((link) => (
              <li key={link.path}>
                <Link href={noteHref(link.path)}>{link.title}</Link>
                <span className={styles.notePath} style={{ marginLeft: '0.5rem' }}>
                  {link.folder}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
