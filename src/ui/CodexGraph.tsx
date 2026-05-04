'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useCodexGraphqlRequest, useCodexNavigation } from './CodexAdapters';
import { noteHref } from './CodexTree';
import styles from './codex.module.css';

// react-force-graph-2d is canvas-based and SSR-incompatible. The library's
// type defs use a wide NodeObject shape that doesn't carry our custom fields
// (kind, pageRank, etc.). We type the component loosely rather than threading
// generics through the dynamic-import boundary; accessor callbacks below cast
// to the project shape.
type LooseGraphProps = Record<string, unknown>;
const ForceGraph2D = dynamic(
  () => import('react-force-graph-2d'),
  { ssr: false, loading: () => <div className={styles.spinnerWrap}>Loading graph engine…</div> },
) as unknown as React.ComponentType<LooseGraphProps & { ref?: React.Ref<unknown> }>;

const GRAPH_QUERY = `
  query VaultGraph($scope: String) {
    vaultGraph(scope: $scope) {
      scope
      nodes {
        id
        label
        kind
        folder
        pageRank
        degree
        noteCount
      }
      edges {
        from
        to
        weight
      }
    }
  }
`;

const TOP_NOTES_QUERY = `
  query VaultGraphFlat {
    vaultGraph(scope: null) {
      nodes {
        id
        label
        pageRank
        noteCount
      }
    }
  }
`;

interface CodexGraphNode {
  id: string;
  label: string;
  kind: 'SUPERNODE' | 'NOTE';
  folder: string;
  pageRank: number;
  degree: number;
  noteCount?: number | null;
}

interface CodexGraphEdge {
  from: string;
  to: string;
  weight: number;
}

interface CodexGraphPayload {
  scope: string | null;
  nodes: CodexGraphNode[];
  edges: CodexGraphEdge[];
}

interface Props {
  scope?: string;
}

// Curated palette — saturated enough to read on a dark canvas, but harmonious
// rather than the random-hue salad of `hsl(<hash> 60% 65%)`. Folders cycle
// through this list deterministically (by sorted folder name index).
const FOLDER_PALETTE = [
  '#60a5fa', // blue
  '#34d399', // emerald
  '#fbbf24', // amber
  '#f87171', // red
  '#a78bfa', // violet
  '#22d3ee', // cyan
  '#fb7185', // rose
  '#4ade80', // lime
  '#c084fc', // purple
  '#fb923c', // orange
  '#2dd4bf', // teal
  '#facc15', // yellow
];

// Fallback supernode color used only if a supernode somehow shows up without
// a matching folder palette entry. Real supernodes use the same folder palette
// as their notes (so the folder-overview reads as a true legend / preview of
// what each folder will look like when drilled into).
const SUPERNODE_FALLBACK = '#93c5fd';

export default function CodexGraph({ scope }: Props) {
  const graphqlRequest = useCodexGraphqlRequest();
  const { useRouter: useNavRouter } = useCodexNavigation();
  const router = useNavRouter();
  const [data, setData] = useState<CodexGraphPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<{ width: number; height: number }>({
    width: 800,
    height: 600,
  });
  const [isMobile, setIsMobile] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [folderFilter, setFolderFilter] = useState<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<unknown>(null);

  // Mobile detection — react-force-graph performs poorly under 768px.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia('(max-width: 768px)');
    const update = () => setIsMobile(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, []);

  // Resize observer drives the force-graph viewport.
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize({ width: Math.max(300, width), height: Math.max(300, height) });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // Load graph data when scope changes.
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    setHoveredId(null);
    setSearch('');
    setFolderFilter(new Set());
    (async () => {
      try {
        const { data: payload, errors } = await graphqlRequest<{
          vaultGraph: CodexGraphPayload;
        }>(GRAPH_QUERY, { scope: scope ?? null });
        if (cancelled) return;
        if (errors?.length) {
          setError(errors.map((e) => e.message).join('; '));
        } else {
          setData(payload?.vaultGraph ?? null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load graph');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scope]);

  // Stable folder → palette index map. Supernodes have id === folder, so
  // the supernode palette lookup hits the same map.
  const folderColorMap = useMemo(() => {
    if (!data) return new Map<string, string>();
    const folders = Array.from(new Set(data.nodes.map((n) => n.folder))).sort();
    return new Map(folders.map((f, i) => [f, FOLDER_PALETTE[i % FOLDER_PALETTE.length]]));
  }, [data]);

  // Adjacency map for hover-highlight and local-mode neighbor lookup.
  const neighbors = useMemo(() => {
    const map = new Map<string, Set<string>>();
    if (!data) return map;
    data.nodes.forEach((n) => map.set(n.id, new Set()));
    data.edges.forEach((e) => {
      map.get(e.from)?.add(e.to);
      map.get(e.to)?.add(e.from);
    });
    return map;
  }, [data]);

  // PageRank-based "is this label important enough to render at this zoom"
  // threshold lookup. We pre-compute a percentile rank so the show/hide
  // decision is constant-time per frame.
  const pageRankPercentile = useMemo(() => {
    const map = new Map<string, number>();
    if (!data) return map;
    const sorted = [...data.nodes].sort((a, b) => a.pageRank - b.pageRank);
    sorted.forEach((n, i) => {
      map.set(n.id, sorted.length === 1 ? 1 : i / (sorted.length - 1));
    });
    return map;
  }, [data]);

  // Pre-position nodes so the simulation starts from a sensible layout instead
  // of all-near-origin. For supernodes (folder overview): even circle around
  // origin so high cross-folder link counts can't collapse everything to the
  // centroid. For folder subgraphs: golden-angle spiral with radius = 1 -
  // pageRank so hubs end up central.
  const positionedNodes = useMemo(() => {
    if (!data) return [];
    const r = Math.min(size.width, size.height) / 2 - 80;
    if (!data.scope) {
      // Supernode view: circle, sorted by noteCount so big folders are
      // adjacent (less wraparound for cross-folder links).
      const sorted = [...data.nodes].sort(
        (a, b) => (b.noteCount ?? 0) - (a.noteCount ?? 0),
      );
      const n = sorted.length;
      return sorted.map((node, i) => ({
        ...node,
        x: Math.cos((i / n) * 2 * Math.PI) * r * 0.8,
        y: Math.sin((i / n) * 2 * Math.PI) * r * 0.8,
      }));
    }
    // Folder-scope view.
    const sorted = [...data.nodes].sort((a, b) => b.pageRank - a.pageRank);
    const maxRank = Math.max(1e-9, ...sorted.map((n) => n.pageRank));
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    return sorted.map((n, i) => ({
      ...n,
      x: Math.cos(i * goldenAngle) * (1 - n.pageRank / maxRank) * r,
      y: Math.sin(i * goldenAngle) * (1 - n.pageRank / maxRank) * r,
    }));
  }, [data, size.width, size.height]);

  // Tune the d3 force simulation for less hairball on dense graphs. We push
  // the link distance way out from the library default of ~30 and crank charge
  // (repulsion) so unrelated nodes find their own breathing room. We mutate
  // the existing forces (link, charge) rather than importing d3-force as a
  // new dep — react-force-graph-2d already wires those up internally.
  useEffect(() => {
    const fg = fgRef.current as
      | {
          d3Force?: (name: string, force?: unknown) => unknown;
          d3ReheatSimulation?: () => void;
          zoomToFit?: (ms?: number, padding?: number) => unknown;
        }
      | null;
    if (!fg || !data) return;
    const linkForce = fg.d3Force?.('link') as
      | { distance: (n: number) => unknown; strength: (n: number) => unknown }
      | undefined;
    if (linkForce) {
      // Supernode view: HUGE spacing — only ~15 nodes but very high cross-link
      // density (avg ~7 links/node), so weaker links would collapse everything
      // to centroid. Folder subgraph: tighter but still wider than default.
      const baseDist = data.scope ? 90 : 320;
      linkForce.distance(baseDist);
      // Weak link strength = repulsion wins. We want spread, not tight clusters.
      linkForce.strength(data.scope ? 0.25 : 0.05);
    }
    const chargeForce = fg.d3Force?.('charge') as
      | { strength: (n: number) => unknown; distanceMax?: (n: number) => unknown }
      | undefined;
    if (chargeForce) {
      // Negative = repulsion. Big negative = lots of space between nodes.
      // Supernode view needs MUCH more — 15 highly-connected nodes pile up.
      chargeForce.strength(data.scope ? -350 : -2400);
      // Cap effective distance so far-away nodes don't slow the simulation.
      chargeForce.distanceMax?.(data.scope ? 600 : 2000);
    }
    // Reheat so the new params take effect on already-positioned data.
    fg.d3ReheatSimulation?.();
    // After the simulation has had time to settle, zoom to fit the whole
    // graph. Without this the camera defaults are usually too tight or too
    // loose for the new layout.
    const zoomTimer = setTimeout(() => {
      fg.zoomToFit?.(800, 80);
    }, 1500);
    return () => clearTimeout(zoomTimer);
  }, [data]);

  // Dim/highlight rules — node/link visibility for filter, alpha for hover.
  const matchesSearch = useCallback(
    (n: CodexGraphNode): boolean => {
      if (!search.trim()) return true;
      return n.label.toLowerCase().includes(search.toLowerCase());
    },
    [search],
  );

  const passesFolderFilter = useCallback(
    (n: CodexGraphNode): boolean => {
      if (folderFilter.size === 0) return true;
      return folderFilter.has(n.folder);
    },
    [folderFilter],
  );

  const isVisible = useCallback(
    (n: CodexGraphNode): boolean => matchesSearch(n) && passesFolderFilter(n),
    [matchesSearch, passesFolderFilter],
  );

  const linkIsVisible = useCallback(
    (l: { source: CodexGraphNode | string; target: CodexGraphNode | string }): boolean => {
      const sId = typeof l.source === 'string' ? l.source : l.source.id;
      const tId = typeof l.target === 'string' ? l.target : l.target.id;
      // Link visible if both endpoints are visible per filters.
      const sNode = data?.nodes.find((n) => n.id === sId);
      const tNode = data?.nodes.find((n) => n.id === tId);
      if (!sNode || !tNode) return false;
      return isVisible(sNode) && isVisible(tNode);
    },
    [data, isVisible],
  );

  // For hover dimming: the node + its neighbors stay full-bright; everything
  // else dims. Memoized as a hot-path function (called per node per frame).
  const isHotForHover = useCallback(
    (id: string): boolean => {
      if (!hoveredId) return true;
      if (id === hoveredId) return true;
      return neighbors.get(hoveredId)?.has(id) ?? false;
    },
    [hoveredId, neighbors],
  );

  const linkIsHotForHover = useCallback(
    (l: { source: CodexGraphNode | string; target: CodexGraphNode | string }): boolean => {
      if (!hoveredId) return true;
      const sId = typeof l.source === 'string' ? l.source : l.source.id;
      const tId = typeof l.target === 'string' ? l.target : l.target.id;
      return sId === hoveredId || tId === hoveredId;
    },
    [hoveredId],
  );

  if (isMobile) {
    return <MobileFallback />;
  }

  if (error) {
    return <div className={styles.error}>{error}</div>;
  }

  if (!data) {
    return <div className={styles.spinnerWrap}>Loading graph…</div>;
  }

  const links = data.edges.map((e) => ({ source: e.from, target: e.to, weight: e.weight }));
  const visibleNodeCount = data.nodes.filter(isVisible).length;
  const folders = Array.from(folderColorMap.keys());

  // Adaptive label-visibility threshold — at low zoom (zoomed out), only show
  // the top-N labels by pageRank. As you zoom in, more labels appear.
  // pctThreshold is "show labels for nodes whose pageRank percentile >= this".
  const labelThreshold = (globalScale: number): number => {
    if (globalScale >= 2.5) return 0; // Very zoomed in: show all
    if (globalScale >= 1.5) return 0.4; // Mid: top 60%
    if (globalScale >= 0.8) return 0.7; // Default: top 30%
    return 0.9; // Zoomed way out: only top 10%
  };

  return (
    <div className={styles.graphRoot}>
      <div className={styles.graphToolbar}>
        <input
          type="search"
          className={styles.graphSearch}
          placeholder="Search nodes…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className={styles.graphFolderFilter}>
          {folders.map((f) => {
            const active = folderFilter.has(f);
            return (
              <button
                key={f}
                type="button"
                className={active ? styles.graphFolderChipActive : styles.graphFolderChip}
                style={{
                  borderColor: folderColorMap.get(f) ?? '#888',
                  background: active
                    ? `${folderColorMap.get(f) ?? '#888'}33`
                    : 'transparent',
                }}
                onClick={() => {
                  setFolderFilter((prev) => {
                    const next = new Set(prev);
                    if (next.has(f)) next.delete(f);
                    else next.add(f);
                    return next;
                  });
                }}
                title={`Toggle folder: ${f}`}
              >
                <span
                  className={styles.graphFolderChipDot}
                  style={{ background: folderColorMap.get(f) ?? '#888' }}
                />
                {f.replace(/^\d+\s*-\s*/, '')}
              </button>
            );
          })}
          {(folderFilter.size > 0 || search) && (
            <button
              type="button"
              className={styles.graphResetButton}
              onClick={() => {
                setFolderFilter(new Set());
                setSearch('');
              }}
            >
              Reset
            </button>
          )}
        </div>
      </div>

      <div className={styles.graphHeader}>
        {data.scope ? (
          <>
            <button
              type="button"
              className={styles.graphBackButton}
              onClick={() => router.push('/admin/codex/graph')}
            >
              ← All folders
            </button>
            <span className={styles.graphScopeLabel}>{data.scope}</span>
            <span className={styles.graphMeta}>
              {visibleNodeCount}
              {visibleNodeCount !== data.nodes.length ? ` / ${data.nodes.length}` : ''} notes
            </span>
          </>
        ) : (
          <>
            <span className={styles.graphScopeLabel}>All folders</span>
            <span className={styles.graphMeta}>
              {visibleNodeCount}
              {visibleNodeCount !== data.nodes.length ? ` / ${data.nodes.length}` : ''} folders ·{' '}
              {data.edges.length} cross-folder links
            </span>
          </>
        )}
      </div>

      <div ref={containerRef} className={styles.graphCanvas}>
        <ForceGraph2D
          ref={fgRef as React.Ref<unknown>}
          graphData={{ nodes: positionedNodes, links }}
          width={size.width}
          height={size.height}
          nodeId="id"
          nodeVisibility={(n: CodexGraphNode) => isVisible(n)}
          linkVisibility={(l: { source: CodexGraphNode | string; target: CodexGraphNode | string }) =>
            linkIsVisible(l)
          }
          nodeLabel={(n: CodexGraphNode) =>
            n.kind === 'SUPERNODE'
              ? `${n.label} · ${n.noteCount ?? 0} notes`
              : `${n.label} · pr ${(n.pageRank * 100).toFixed(2)} · ${n.folder}`
          }
          onNodeHover={(n: CodexGraphNode | null) => setHoveredId(n?.id ?? null)}
          nodeCanvasObject={(
            n: CodexGraphNode & { x?: number; y?: number },
            ctx: CanvasRenderingContext2D,
            globalScale: number,
          ) => {
            if (n.x === undefined || n.y === undefined) return;
            const radius = nodeRadius(n);
            const hot = isHotForHover(n.id);
            const baseAlpha = hot ? 1 : 0.18;
            // Supernodes have id === folder per the resolver, so the same
            // folderColorMap drives both supernode + note coloring.
            const color =
              folderColorMap.get(n.folder) ??
              (n.kind === 'SUPERNODE' ? SUPERNODE_FALLBACK : '#9aa3b2');

            // Glow for hover-target / hover-neighbors.
            if (hoveredId && hot && globalScale > 0.4) {
              ctx.save();
              const glow = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, radius * 3.5);
              glow.addColorStop(0, withAlpha(color, 0.4));
              glow.addColorStop(1, withAlpha(color, 0));
              ctx.fillStyle = glow;
              ctx.beginPath();
              ctx.arc(n.x, n.y, radius * 3.5, 0, Math.PI * 2);
              ctx.fill();
              ctx.restore();
            }

            // Dot.
            ctx.beginPath();
            ctx.arc(n.x, n.y, radius, 0, Math.PI * 2);
            ctx.fillStyle = withAlpha(color, baseAlpha);
            ctx.fill();
            ctx.strokeStyle = hoveredId === n.id
              ? withAlpha('#ffffff', 0.9)
              : withAlpha('#000000', 0.35 * baseAlpha);
            ctx.lineWidth = hoveredId === n.id ? 1.5 : 0.5;
            ctx.stroke();

            // Label visibility — show if hovered/neighbor (always), or if this
            // node's pageRank percentile is above the zoom-dependent threshold.
            const pct = pageRankPercentile.get(n.id) ?? 0;
            const threshold = labelThreshold(globalScale);
            const showLabel =
              n.kind === 'SUPERNODE' ||
              (hoveredId && hot) ||
              pct >= threshold;
            if (!showLabel) return;

            const label = truncateLabel(n.label, n.kind === 'SUPERNODE' ? 30 : 22);
            const fontSize = Math.max(9, 12 / globalScale);
            ctx.font = `${n.kind === 'SUPERNODE' ? '600 ' : ''}${fontSize}px system-ui, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            const labelY = n.y + radius + 3 / globalScale;
            // Outline-style text for legibility without a heavy background plate.
            ctx.lineWidth = 3 / globalScale;
            ctx.strokeStyle = withAlpha('#000000', 0.7 * baseAlpha);
            ctx.strokeText(label, n.x, labelY);
            ctx.fillStyle = withAlpha('#ffffff', 0.95 * baseAlpha);
            ctx.fillText(label, n.x, labelY);
          }}
          nodePointerAreaPaint={(
            n: CodexGraphNode & { x?: number; y?: number },
            color: string,
            ctx: CanvasRenderingContext2D,
          ) => {
            // Hit-test area = the dot only, NOT the label. Otherwise wide
            // labels would steal clicks from neighbors.
            if (n.x === undefined || n.y === undefined) return;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(n.x, n.y, nodeRadius(n), 0, Math.PI * 2);
            ctx.fill();
          }}
          linkColor={(l: {
            weight: number;
            source: CodexGraphNode | string;
            target: CodexGraphNode | string;
          }) => {
            const hot = linkIsHotForHover(l);
            const baseAlpha = hot ? 0.55 : 0.08;
            // Slight folder-color tint at the source side for cross-folder
            // legibility. We just use a neutral grey for now (canvas2d doesn't
            // do gradient links easily without per-segment paint).
            return withAlpha('#b8c1d4', baseAlpha);
          }}
          linkWidth={(l: { weight: number }) => Math.max(0.8, Math.log1p(l.weight) * 1.2)}
          linkCurvature={data.scope ? 0.15 : 0.05}
          linkDirectionalParticles={(l: {
            weight: number;
            source: CodexGraphNode | string;
            target: CodexGraphNode | string;
          }) => {
            // Particles only when this link is "hot" via hover, otherwise the
            // canvas churn dominates idle frames.
            if (!hoveredId || !linkIsHotForHover(l)) return 0;
            return Math.min(4, Math.max(1, Math.floor(l.weight)));
          }}
          linkDirectionalParticleSpeed={0.008}
          linkDirectionalParticleWidth={2}
          backgroundColor="rgba(0, 0, 0, 0)"
          cooldownTicks={300}
          d3AlphaDecay={0.02}
          d3VelocityDecay={0.35}
          warmupTicks={50}
          onNodeClick={(node: CodexGraphNode) => {
            if (node.kind === 'SUPERNODE') {
              router.push(`/admin/codex/graph?scope=${encodeURIComponent(node.id)}`);
            } else {
              router.push(noteHref(node.id));
            }
          }}
        />
      </div>
    </div>
  );
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function nodeRadius(n: CodexGraphNode): number {
  // Tuned so supernode size variance reads (a 90-note folder vs a 2-note one
  // should be obvious) and per-folder note-radii spread enough to be useful.
  if (n.kind === 'SUPERNODE') {
    const count = n.noteCount ?? 1;
    return Math.max(14, Math.min(50, Math.sqrt(count) * 3.5));
  }
  return Math.max(3.5, Math.sqrt(n.pageRank * 4500));
}

function truncateLabel(label: string, max: number): string {
  return label.length > max ? label.slice(0, max - 1) + '…' : label;
}

// Paint helper — accept hex or rgba and reapply alpha.
function withAlpha(color: string, alpha: number): string {
  if (color.startsWith('rgba')) {
    return color.replace(/rgba\(([^)]+)\)/, (_m, inner) => {
      const parts = inner.split(',').map((p: string) => p.trim());
      return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
    });
  }
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const expanded = hex.length === 3
      ? hex.split('').map((c) => c + c).join('')
      : hex;
    const r = parseInt(expanded.slice(0, 2), 16);
    const g = parseInt(expanded.slice(2, 4), 16);
    const b = parseInt(expanded.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}

function MobileFallback() {
  const graphqlRequest = useCodexGraphqlRequest();
  const [hits, setHits] = useState<Array<{ id: string; label: string; pageRank: number }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, errors } = await graphqlRequest<{
          vaultGraph: { nodes: Array<{ id: string; label: string; pageRank: number }> };
        }>(TOP_NOTES_QUERY);
        if (cancelled) return;
        if (errors?.length) {
          setError(errors.map((e) => e.message).join('; '));
        } else {
          // Even at supernode level we get pageRank summed per folder, which
          // gives a useful "biggest folders" sort. PR 3 will surface true
          // top-notes via a dedicated query.
          const sorted = (data?.vaultGraph.nodes ?? []).slice().sort(
            (a, b) => b.pageRank - a.pageRank,
          );
          setHits(sorted);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <div className={styles.spinnerWrap}>Loading…</div>;
  if (error) return <div className={styles.error}>{error}</div>;

  return (
    <div className={styles.mobileGraphFallback}>
      <h3>Top folders by influence</h3>
      <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
        The interactive graph is hidden on small screens. Open this page on a wider viewport
        to explore the link graph visually.
      </p>
      <ul className={styles.mobileFolderList}>
        {hits.map((h) => (
          <li key={h.id}>
            <strong>{h.label}</strong>
            <span className={styles.notePath}>
              influence {(h.pageRank * 100).toFixed(2)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
