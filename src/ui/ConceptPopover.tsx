'use client';

// Inline document preview popover.
//
// Hover (desktop, 250ms delay) or long-press (mobile, 500ms) on a
// resolved wikilink in CodexPreview opens this card. It shows the
// linked document's title, status, tags, and the first ~200 chars of
// the body — enough context that the reader doesn't have to click
// through to know whether to navigate.
//
// Two form factors:
//   • Desktop: floating card anchored to the link via getBoundingClientRect,
//     flipped above when below would clip, centered horizontally with
//     viewport-edge clamping.
//   • Mobile (≤ 640px): full-width bottom sheet, swipe-down to dismiss.
//
// Excerpts are session-cached so re-hovering the same link is instant.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type AnchorHTMLAttributes,
} from 'react';
import type * as React from 'react';
import { createPortal } from 'react-dom';
import { useCodexGraphqlRequest, useCodexNavigation } from './CodexAdapters';
import styles from './codex.module.css';

const EXCERPT_QUERY = `
  query VaultNoteForPopover($path: String!) {
    vaultNote(path: $path) {
      path
      title
      folder
      status
      tags
      content
    }
  }
`;

interface PopoverData {
  path: string;
  title: string;
  folder: string;
  status: string | null;
  tags: string[];
  excerpt: string;
}

const EXCERPT_CACHE = new Map<string, PopoverData>();
const EXCERPT_LIMIT = 220;
const HOVER_DELAY_MS = 250;
const LONG_PRESS_MS = 500;

function makeExcerpt(content: string): string {
  // Drop frontmatter + leading whitespace, collapse blank lines, take
  // the first paragraph-ish. Strip wikilink/markdown syntax for
  // readability (the popover isn't a renderer, just a preview).
  let body = content;
  if (body.startsWith('---\n')) {
    const end = body.indexOf('\n---', 4);
    if (end !== -1) body = body.slice(end + 4);
  }
  body = body
    .replace(/^\s+/, '')
    .replace(/^#.*$/gm, '') // strip heading lines
    .replace(/\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/g, (_, t, a) => a ?? t)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1')
    .replace(/\n{2,}/g, ' · ')
    .replace(/\n/g, ' ')
    .trim();
  if (body.length > EXCERPT_LIMIT) {
    return body.slice(0, EXCERPT_LIMIT).trimEnd() + '…';
  }
  return body;
}

export interface ConceptPopoverProps {
  /** Path the user's link points to (vault-relative). */
  path: string;
  /** Bounding rect of the anchor element on desktop (window-relative).
   *  Mobile ignores this — the sheet is always bottom-anchored. */
  anchorRect: DOMRect | null;
  /** True when triggered by long-press on touch — switches form factor
   *  to the bottom sheet. */
  isTouch: boolean;
  onClose: () => void;
  /** Override the route the "Open" button navigates to. Defaults to
   *  `/admin/codex/note/<path>` (URL-encoded). */
  noteHref?: (path: string) => string;
}

export default function ConceptPopover({
  path,
  anchorRect,
  isTouch,
  onClose,
  noteHref,
}: ConceptPopoverProps) {
  const graphqlRequest = useCodexGraphqlRequest();
  const { useRouter } = useCodexNavigation();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  // data/loading/error are all keyed on `path` and resync inside the
  // effect below — DO NOT initialize from the cache at mount, because
  // when the parent reuses this instance with a new `path` prop (user
  // glides from one link to the next without entering the card), the
  // useState initial value doesn't re-run and `data` would stay stale.
  // The effect handles both initial-mount + path-change cases.
  const [data, setData] = useState<PopoverData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    placement: 'above' | 'below';
  } | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Sync data when path changes (including initial mount). Cancel any
  // in-flight fetch from the previous path so a slow response can't
  // clobber the new path's state.
  useEffect(() => {
    let cancelled = false;
    const cached = EXCERPT_CACHE.get(path);
    if (cached) {
      setData(cached);
      setLoading(false);
      setError(null);
      // Reset position so it re-measures against the new anchor.
      setPosition(null);
      return;
    }
    setData(null);
    setLoading(true);
    setError(null);
    setPosition(null);
    (async () => {
      try {
        const { data: payload, errors } = await graphqlRequest<{
          vaultNote: {
            path: string;
            title: string;
            folder: string;
            status: string | null;
            tags: string[];
            content: string;
          } | null;
        }>(EXCERPT_QUERY, { path });
        if (cancelled) return;
        if (errors?.length || !payload?.vaultNote) {
          setError('Document not found');
          setLoading(false);
          return;
        }
        const next: PopoverData = {
          path: payload.vaultNote.path,
          title: payload.vaultNote.title,
          folder: payload.vaultNote.folder,
          status: payload.vaultNote.status ?? null,
          tags: payload.vaultNote.tags,
          excerpt: makeExcerpt(payload.vaultNote.content),
        };
        EXCERPT_CACHE.set(path, next);
        setData(next);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load preview');
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, graphqlRequest]);

  // Desktop positioning — runs once anchor + card are both available.
  useEffect(() => {
    if (isTouch) return;
    if (!anchorRect || !cardRef.current) return;

    const card = cardRef.current;
    const cardW = card.offsetWidth;
    const cardH = card.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = 8;

    // Try below first; flip above if it would overflow.
    const fitsBelow = anchorRect.bottom + gap + cardH <= vh - 8;
    const placement: 'above' | 'below' = fitsBelow ? 'below' : 'above';

    const top =
      placement === 'below'
        ? anchorRect.bottom + gap
        : Math.max(8, anchorRect.top - gap - cardH);

    // Center horizontally on the anchor, but clamp to viewport edges.
    const desiredLeft = anchorRect.left + anchorRect.width / 2 - cardW / 2;
    const left = Math.max(8, Math.min(vw - cardW - 8, desiredLeft));

    setPosition({ top, left, placement });
  }, [anchorRect, isTouch, data, loading]);

  // Dismiss on Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Desktop: dismiss on click anywhere outside the card. Also dismiss
  // on page scroll or window resize — the anchored position would be
  // stale otherwise. (Mobile sheet has its own backdrop tap; ignore
  // these listeners on touch.)
  useEffect(() => {
    if (isTouch) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!cardRef.current) return;
      if (cardRef.current.contains(e.target as Node)) return;
      onClose();
    };
    const onScrollOrResize = () => onClose();
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [isTouch, onClose]);

  const handleOpen = useCallback(() => {
    const target = data?.path ?? path;
    const href = noteHref
      ? noteHref(target)
      : '/admin/codex/note/' +
        target
          .replace(/\.md$/i, '')
          .split(/[\\/]/g)
          .map((seg) => encodeURIComponent(seg))
          .join('/');
    onClose();
    router.push(href);
  }, [data, path, noteHref, onClose, router]);

  if (!mounted) return null;

  // ─── Touch / mobile: bottom sheet ───────────────────────────────────────
  if (isTouch) {
    return createPortal(
      <div
        className={styles.conceptSheetBackdrop}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
        role="dialog"
        aria-modal="true"
        aria-label="Document preview"
      >
        <div className={styles.conceptSheet}>
          <div className={styles.conceptSheetHandle} aria-hidden="true" />
          {renderBody({ data, loading, error })}
          <div className={styles.conceptSheetActions}>
            <button
              type="button"
              className={styles.conceptSheetSecondary}
              onClick={onClose}
            >
              Close
            </button>
            <button
              type="button"
              className={styles.conceptSheetPrimary}
              onClick={handleOpen}
              disabled={!data}
            >
              Open document
            </button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  // ─── Desktop: floating card ─────────────────────────────────────────────
  // Render off-screen on first paint so we can measure for positioning,
  // then move into place via the position effect.
  const style: React.CSSProperties = position
    ? { top: position.top, left: position.left, opacity: 1 }
    : { top: -10000, left: -10000, opacity: 0 };

  return createPortal(
    <div
      ref={cardRef}
      className={styles.conceptCard}
      style={style}
      onMouseLeave={onClose}
      role="dialog"
      aria-label="Document preview"
    >
      <button
        type="button"
        className={styles.conceptCardClose}
        onClick={onClose}
        aria-label="Close preview"
        title="Close (Esc)"
      >
        ✕
      </button>
      {renderBody({ data, loading, error })}
      <div className={styles.conceptCardActions}>
        <button
          type="button"
          className={styles.conceptCardOpenButton}
          onClick={handleOpen}
          disabled={!data}
        >
          Open →
        </button>
      </div>
    </div>,
    document.body,
  );
}

function renderBody({
  data,
  loading,
  error,
}: {
  data: PopoverData | null;
  loading: boolean;
  error: string | null;
}): ReactNode {
  if (loading && !data) {
    return (
      <div className={styles.conceptBody}>
        <div className={styles.conceptSkeletonTitle} />
        <div className={styles.conceptSkeletonExcerpt} />
        <div className={styles.conceptSkeletonExcerpt} />
      </div>
    );
  }
  if (error) {
    return <div className={styles.conceptError}>{error}</div>;
  }
  if (!data) return null;
  return (
    <div className={styles.conceptBody}>
      <div className={styles.conceptHeader}>
        <h4 className={styles.conceptTitle}>{data.title}</h4>
        {data.status && (
          <span className={styles.conceptStatus}>{data.status}</span>
        )}
      </div>
      <div className={styles.conceptFolder}>{data.folder}</div>
      {data.excerpt && <p className={styles.conceptExcerpt}>{data.excerpt}</p>}
      {data.tags.length > 0 && (
        <div className={styles.conceptTagRow}>
          {data.tags.slice(0, 6).map((t) => (
            <span key={t} className={styles.conceptTag}>
              #{t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Event-delegation helper for codex wikilinks ────────────────────────
//
// Replaces the previous per-link PreviewLink component (which created
// one React component instance + 4 hooks + 6 event handlers per
// wikilink — for documents with hundreds of links that's a real perf
// drag during hover and re-renders). Instead, the markdown container
// uses a single delegated listener, plain <a> tags underneath, and
// one popover state at the document level.
//
// Hosts call `useConceptPopoverDelegation()` and spread the returned
// handler set onto the markdown wrapper div. The hook returns the
// popover element to render alongside the markdown (or null).

export interface DelegationState {
  path: string;
  anchorRect: DOMRect | null;
  isTouch: boolean;
}

export interface DelegationProps {
  /** Spread these onto the wrapping div around <ReactMarkdown>. */
  containerProps: {
    onMouseOver: (e: React.MouseEvent<HTMLDivElement>) => void;
    onMouseOut: (e: React.MouseEvent<HTMLDivElement>) => void;
    onTouchStart: (e: React.TouchEvent<HTMLDivElement>) => void;
    onTouchEnd: (e: React.TouchEvent<HTMLDivElement>) => void;
    onTouchMove: (e: React.TouchEvent<HTMLDivElement>) => void;
    onTouchCancel: (e: React.TouchEvent<HTMLDivElement>) => void;
    onClickCapture: (e: React.MouseEvent<HTMLDivElement>) => void;
  };
  /** Render this in the same tree as the container — it's a portal
   *  internally so DOM position doesn't matter, but React must mount
   *  it for the popover to appear. */
  popover: ReactNode;
}

/** Wire codex-wikilink popovers via event delegation on a single
 *  container element. Returns `containerProps` to spread onto the
 *  markdown wrapper, and a `popover` ReactNode to render. */
export function useConceptPopoverDelegation(
  noteHref?: (path: string) => string,
): DelegationProps {
  const [open, setOpen] = useState<DelegationState | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current);
      if (longPressTimerRef.current) window.clearTimeout(longPressTimerRef.current);
    };
  }, []);

  const findWikilinkAnchor = (target: EventTarget | null): {
    el: HTMLAnchorElement;
    path: string;
  } | null => {
    if (!(target instanceof HTMLElement)) return null;
    const a = target.closest('a');
    if (!a) return null;
    const href = a.getAttribute('href');
    if (!href) return null;
    const path = decodeCodexHref(href);
    if (!path) return null;
    return { el: a, path };
  };

  const cancelHover = () => {
    if (hoverTimerRef.current) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };
  const cancelLongPress = () => {
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const onMouseOver = (e: React.MouseEvent<HTMLDivElement>) => {
    const hit = findWikilinkAnchor(e.target);
    if (!hit) return;
    cancelHover();
    const el = hit.el;
    const path = hit.path;
    hoverTimerRef.current = window.setTimeout(() => {
      setOpen({ path, anchorRect: el.getBoundingClientRect(), isTouch: false });
    }, HOVER_DELAY_MS);
  };

  const onMouseOut = (e: React.MouseEvent<HTMLDivElement>) => {
    // Only cancel if we're leaving the anchor we were hovering. The
    // related target check is loose — any movement off a wikilink
    // cancels the pending hover; the popover's own onMouseLeave still
    // dismisses an opened card.
    const hit = findWikilinkAnchor(e.target);
    if (hit) cancelHover();
  };

  const onTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    const hit = findWikilinkAnchor(e.target);
    if (!hit) return;
    cancelLongPress();
    const el = hit.el;
    const path = hit.path;
    longPressTimerRef.current = window.setTimeout(() => {
      suppressClickRef.current = true;
      setOpen({ path, anchorRect: el.getBoundingClientRect(), isTouch: true });
    }, LONG_PRESS_MS);
  };

  const onTouchEnd = () => cancelLongPress();
  const onTouchMove = () => cancelLongPress();
  const onTouchCancel = () => cancelLongPress();

  const onClickCapture = (e: React.MouseEvent<HTMLDivElement>) => {
    // If the user long-pressed, suppress the synthetic click that some
    // browsers fire after the touch ends.
    if (suppressClickRef.current) {
      const hit = findWikilinkAnchor(e.target);
      if (hit) {
        e.preventDefault();
        e.stopPropagation();
      }
      suppressClickRef.current = false;
    }
  };

  return {
    containerProps: {
      onMouseOver,
      onMouseOut,
      onTouchStart,
      onTouchEnd,
      onTouchMove,
      onTouchCancel,
      onClickCapture,
    },
    popover: open ? (
      <ConceptPopover
        path={open.path}
        anchorRect={open.anchorRect}
        isTouch={open.isTouch}
        onClose={() => setOpen(null)}
        noteHref={noteHref}
      />
    ) : null,
  };
}

// Legacy export — kept so existing call sites importing PreviewLink
// don't break during the migration. New code should use
// useConceptPopoverDelegation() instead.
export type PreviewLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href?: string;
  children?: ReactNode;
  node?: unknown;
};
export function PreviewLink({ href, children, node: _node, ...rest }: PreviewLinkProps) {
  void _node;
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}

/** Decode a /admin/codex/note/... href back to a vault-relative path
 *  (with `.md` re-appended). Returns null for non-codex hrefs. */
function decodeCodexHref(href: string): string | null {
  const m = href.match(/\/admin\/codex\/note\/(.+?)(?:#.*)?$/);
  if (!m) return null;
  const decoded = m[1]
    .split('/')
    .map((seg) => decodeURIComponent(seg))
    .join('/');
  return decoded.endsWith('.md') ? decoded : decoded + '.md';
}
