'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useCodexGraphqlRequest, useCodexNavigation } from './CodexAdapters';
import { noteHref } from './CodexTree';
import CodexNotePreviewPane from './CodexNotePreviewPane';
import styles from './codex.module.css';

const PANE_WIDTH_KEY = 'ostracon-graph-pane-width';
const PANE_WIDTH_MIN = 280;
const PANE_WIDTH_MAX = 900;
const PANE_WIDTH_DEFAULT = 440;

// Sigma + graphology + ForceAtlas2 are loaded dynamically inside the mount
// effect — they're WebGL/canvas dependent and can't run server-side. The
// libraries themselves carry their own type defs; we use loose `any`-ish
// typing on the held-instance refs because the renderer is fully self-managed
// after we hand it the graph + container.

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

const NOTE_NEIGHBORHOOD_QUERY = `
  query VaultNoteNeighborhood($notePath: String!, $depth: Int) {
    vaultNoteNeighborhood(notePath: $notePath, depth: $depth) {
      scope
      nodes {
        id
        label
        kind
        folder
        pageRank
        degree
        distance
      }
      edges {
        from
        to
        weight
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
  /** Hop count from the focused note (only present in noteFocus mode). */
  distance?: number | null;
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
  /**
   * If set, switches the component into "note linkages" mode: ignores
   * `scope`, runs vaultNoteNeighborhood instead of vaultGraph, and renders
   * the focused note + cross-folder neighbors with the focused note as
   * the visual anchor.
   */
  noteFocus?: string;
  /** Hop depth for noteFocus mode. Default 2. Server caps at 5. */
  noteFocusDepth?: number;
}

// Curated palette — saturated enough to read on a dark canvas, harmonious
// rather than the random-hue salad of `hsl(<hash> 60% 65%)`.
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

const DIM_COLOR = '#2a2f3a';
const DIM_EDGE = 'rgba(120, 130, 150, 0.05)';
const HOT_EDGE = 'rgba(180, 200, 230, 0.55)';
const DEFAULT_EDGE = 'rgba(150, 160, 180, 0.18)';

export default function CodexGraph({ scope, noteFocus, noteFocusDepth = 2 }: Props) {
  const graphqlRequest = useCodexGraphqlRequest();
  const { useRouter: useNavRouter } = useCodexNavigation();
  const router = useNavRouter();
  const [rawData, setRawData] = useState<CodexGraphPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [folderFilter, setFolderFilter] = useState<Set<string>>(new Set());
  // Side preview pane: when set, the note at this path is rendered in a
  // resizable pane on the right. Click any note (in graph or list) to load it
  // here; click × in the pane header to close.
  const [viewingNotePath, setViewingNotePath] = useState<string | null>(null);
  const [paneWidth, setPaneWidth] = useState<number>(PANE_WIDTH_DEFAULT);

  // Hydrate paneWidth from localStorage on mount (avoids SSR mismatch).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(PANE_WIDTH_KEY);
    if (stored) {
      const w = parseInt(stored, 10);
      if (!Number.isNaN(w)) {
        setPaneWidth(Math.max(PANE_WIDTH_MIN, Math.min(PANE_WIDTH_MAX, w)));
      }
    }
  }, []);

  // Persist width changes (debounced via the natural rAF batching of state).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(PANE_WIDTH_KEY, String(paneWidth));
  }, [paneWidth]);

  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<unknown>(null);
  const graphRef = useRef<unknown>(null);
  const reducerStateRef = useRef({
    search: '',
    folderFilter: new Set<string>(),
    hoveredId: null as string | null,
    neighbors: null as Set<string> | null,
  });

  // Mobile detection — Sigma performs poorly under 768px and the labels are
  // unreadable at that size.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia('(max-width: 768px)');
    const update = () => setIsMobile(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, []);

  // Load graph data when scope changes.
  useEffect(() => {
    let cancelled = false;
    setRawData(null);
    setError(null);
    setHoveredId(null);
    setSearch('');
    setFolderFilter(new Set());
    (async () => {
      try {
        if (noteFocus) {
          // Cross-folder note-centric view: BFS in the full edge graph.
          const { data: payload, errors } = await graphqlRequest<{
            vaultNoteNeighborhood: CodexGraphPayload;
          }>(NOTE_NEIGHBORHOOD_QUERY, { notePath: noteFocus, depth: noteFocusDepth });
          if (cancelled) return;
          if (errors?.length) {
            setError(errors.map((e) => e.message).join('; '));
          } else {
            setRawData(payload?.vaultNoteNeighborhood ?? null);
          }
        } else {
          const { data: payload, errors } = await graphqlRequest<{
            vaultGraph: CodexGraphPayload;
          }>(GRAPH_QUERY, { scope: scope ?? null });
          if (cancelled) return;
          if (errors?.length) {
            setError(errors.map((e) => e.message).join('; '));
          } else {
            setRawData(payload?.vaultGraph ?? null);
          }
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load graph');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scope, noteFocus, noteFocusDepth]);

  // The supernode resolver groups every file by `folder`, including top-level
  // files (Home.md, README.md, CLAUDE.md) which end up as 1-note "fake folders"
  // named after the file. Filter them out as visual noise.
  const looksLikeFile = useCallback((s: string): boolean => /\.\w+$/.test(s), []);
  const data = useMemo<CodexGraphPayload | null>(() => {
    if (!rawData) return null;
    // In noteFocus mode the nodes ARE files (notes) — filtering by extension
    // would erase everything. Same for folder-scope.
    if (rawData.scope || noteFocus) return rawData;
    const visibleNodes = rawData.nodes.filter((n) => !looksLikeFile(n.id));
    const visibleIds = new Set(visibleNodes.map((n) => n.id));
    const visibleEdges = rawData.edges.filter(
      (e) => visibleIds.has(e.from) && visibleIds.has(e.to),
    );
    return { ...rawData, nodes: visibleNodes, edges: visibleEdges };
  }, [rawData, looksLikeFile, noteFocus]);

  // Stable folder → palette index map.
  const folderColorMap = useMemo(() => {
    if (!data) return new Map<string, string>();
    const folders = Array.from(new Set(data.nodes.map((n) => n.folder))).sort();
    return new Map(folders.map((f, i) => [f, FOLDER_PALETTE[i % FOLDER_PALETTE.length]]));
  }, [data]);

  // Mount Sigma + run ForceAtlas2 layout when data arrives. Re-runs on data
  // change (e.g. drilling into a folder).
  useEffect(() => {
    if (!containerRef.current || !data || isMobile) return;
    let killed = false;
    let sigmaInstance: { kill: () => void } | null = null;

    (async () => {
      const [
        { default: Sigma },
        { default: Graph },
        { default: forceAtlas2 },
        edgeCurveMod,
        nodeBorderMod,
      ] = await Promise.all([
        import('sigma'),
        import('graphology'),
        import('graphology-layout-forceatlas2'),
        import('@sigma/edge-curve'),
        import('@sigma/node-border'),
      ]);
      if (killed || !containerRef.current) return;

      const EdgeCurveProgram = edgeCurveMod.default;
      const { createNodeBorderProgram } = nodeBorderMod;
      // Bordered node program: thin darker outline around a colored fill.
      // Adds depth without writing custom GLSL shaders.
      const NodeBorderProgram = createNodeBorderProgram({
        borders: [
          {
            size: { value: 0.12, mode: 'relative' },
            color: { attribute: 'borderColor', defaultValue: '#000000' },
          },
          { size: { fill: true }, color: { attribute: 'color' } },
        ],
      });

      const graph = new Graph();
      const n = data.nodes.length;

      // In noteFocus mode we use a CONCENTRIC layout (rings by hop distance,
      // sorted by folder so same-folder neighbors cluster as arc-segments) and
      // skip ForceAtlas2 entirely — FA2 is great for emergent structure but
      // here we already know the right structure: focused note in the center,
      // neighbors radiating out by hops. Skipping FA2 also avoids the
      // hairball-on-load problem.
      const concentricPositions = noteFocus
        ? computeConcentricLayout(data.nodes, noteFocus)
        : null;

      data.nodes.forEach((node, i) => {
        const fillColor = folderColorMap.get(node.folder) ?? '#9aa3b2';
        const isFocusedNote = noteFocus && node.id === noteFocus;
        const baseSize = nodeSize(node);
        const distance = node.distance ?? 0;
        const sizedNode = noteFocus
          ? isFocusedNote
            ? Math.max(22, baseSize * 1.8)
            : Math.max(baseSize * (1 - 0.2 * distance), 5)
          : baseSize;

        // Position: concentric for noteFocus, circle initial for FA2.
        let x: number, y: number;
        if (concentricPositions) {
          const pos = concentricPositions.get(node.id) ?? { x: 0, y: 0 };
          x = pos.x;
          y = pos.y;
        } else {
          x = Math.cos((i / n) * 2 * Math.PI);
          y = Math.sin((i / n) * 2 * Math.PI);
        }

        graph.addNode(node.id, {
          x,
          y,
          size: sizedNode,
          color: fillColor,
          borderColor: isFocusedNote ? '#ffffff' : shadeHex(fillColor, -0.35),
          type: 'border',
          label: node.label,
          kind: node.kind,
          folder: node.folder,
          pageRank: node.pageRank,
          noteCount: node.noteCount,
          distance,
          isFocusedNote: Boolean(isFocusedNote),
        });
      });

      data.edges.forEach((e) => {
        if (
          graph.hasNode(e.from) &&
          graph.hasNode(e.to) &&
          !graph.hasEdge(e.from, e.to) &&
          e.from !== e.to
        ) {
          graph.addEdge(e.from, e.to, {
            type: 'curve',
            size: Math.max(0.5, Math.log1p(e.weight) * 1.4),
            color: DEFAULT_EDGE,
            weight: e.weight,
            curvature: noteFocus ? 0.1 : 0.25,
          });
        }
      });

      // FA2 only for non-focus modes (supernode + folder-scope). NoteFocus
      // uses the pre-computed concentric layout above.
      if (!noteFocus) {
        forceAtlas2.assign(graph, {
          iterations: data.scope ? 600 : 400,
          settings: {
            gravity: data.scope ? 0.3 : 1.2,
            scalingRatio: data.scope ? 8 : 30,
            strongGravityMode: false,
            barnesHutOptimize: graph.order > 80,
            linLogMode: true,
            outboundAttractionDistribution: true,
            adjustSizes: true,
            edgeWeightInfluence: 1,
            slowDown: 1,
          },
        });
      }

      const sigma = new Sigma(graph, containerRef.current, {
        renderEdgeLabels: false,
        labelSize: 13,
        labelWeight: '500',
        labelDensity: 1,
        labelGridCellSize: 50,
        labelRenderedSizeThreshold: 0,
        labelColor: { color: '#e6e9ef' },
        labelFont: 'Inter, system-ui, -apple-system, sans-serif',
        defaultNodeColor: '#9aa3b2',
        defaultEdgeColor: DEFAULT_EDGE,
        defaultNodeType: 'border',
        defaultEdgeType: 'curve',
        nodeProgramClasses: {
          border: NodeBorderProgram,
        },
        edgeProgramClasses: {
          curve: EdgeCurveProgram,
        },
        nodeReducer: (node, attrs) => makeNodeReducer(reducerStateRef)(node, attrs),
        edgeReducer: (edge, attrs) =>
          makeEdgeReducer(reducerStateRef, graph)(edge, attrs),
      });

      sigmaRef.current = sigma;
      graphRef.current = graph;
      sigmaInstance = sigma as unknown as { kill: () => void };

      // Click navigation:
      //   • Click a SUPERNODE (folder bubble) → drill into that folder's notes
      //   • Click a NOTE → open it in the side preview pane (read its content
      //     without leaving the graph). The pane has buttons for the deeper
      //     actions: "🕸 Linkages" (jump to that note's full linkage graph)
      //     and "✎ Edit" (open in editor).
      sigma.on('clickNode', ({ node }: { node: string }) => {
        const a = graph.getNodeAttributes(node) as { kind: string };
        if (a.kind === 'SUPERNODE') {
          router.push(`/admin/codex/graph?scope=${encodeURIComponent(node)}`);
          return;
        }
        setViewingNotePath(node);
      });

      // Hover state — bubble up to React, the reducer effect picks it up.
      sigma.on('enterNode', ({ node }: { node: string }) => setHoveredId(node));
      sigma.on('leaveNode', () => setHoveredId(null));

      // Camera fit after first render so the graph fills the canvas nicely.
      setTimeout(() => {
        if (!killed) sigma.getCamera().animatedReset({ duration: 600 });
      }, 100);
    })();

    return () => {
      killed = true;
      if (sigmaInstance) sigmaInstance.kill();
      sigmaRef.current = null;
      graphRef.current = null;
    };
  }, [data, folderColorMap, isMobile, router]);

  // Update the reducer state ref + refresh sigma when filters/hover change.
  // The reducers themselves read from the ref so we avoid re-creating them
  // (which would force a full re-mount of sigma).
  useEffect(() => {
    const sigma = sigmaRef.current as
      | { refresh: () => void; setSetting: (k: string, v: unknown) => void }
      | null;
    const graph = graphRef.current as
      | {
          neighbors: (id: string) => string[];
          hasNode: (id: string) => boolean;
          getNodeAttributes: (id: string) => Record<string, unknown>;
          source: (e: string) => string;
          target: (e: string) => string;
        }
      | null;
    if (!sigma || !graph) return;

    reducerStateRef.current = {
      search,
      folderFilter,
      hoveredId,
      neighbors: hoveredId ? new Set(graph.neighbors(hoveredId)) : null,
    };
    sigma.refresh();
  }, [search, folderFilter, hoveredId]);

  if (isMobile) return <MobileFallback />;
  if (error) return <div className={styles.error}>{error}</div>;
  if (!data) return <div className={styles.spinnerWrap}>Loading graph…</div>;

  const folders = Array.from(folderColorMap.keys());
  const visibleNodeCount = data.nodes.filter((n) => {
    if (search && !n.label.toLowerCase().includes(search.toLowerCase())) return false;
    if (folderFilter.size > 0 && !folderFilter.has(n.folder)) return false;
    return true;
  }).length;

  // For the side panel in noteFocus mode: split connected notes by hop
  // distance. Direct = 1-hop neighbors (most actionable); wider = everything
  // else.
  const directConnections = noteFocus
    ? data.nodes.filter((n) => (n.distance ?? 0) === 1).sort(byFolderThenLabel)
    : [];
  const widerConnections = noteFocus
    ? data.nodes.filter((n) => (n.distance ?? 0) >= 2).sort(byFolderThenLabel)
    : [];

  const linkagesUrl = (notePath: string): string =>
    '/admin/codex/graph/note/' +
    notePath
      .replace(/\.md$/i, '')
      .split(/[\\/]/g)
      .map((seg) => encodeURIComponent(seg))
      .join('/');

  // Update the URL when the user changes depth via the toolbar buttons. Uses
  // router.push so back/forward navigation reaches earlier depths.
  const setDepth = (d: number) => {
    if (!noteFocus) return;
    router.push(`${linkagesUrl(noteFocus)}?depth=${d}`);
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
                  background: active ? `${folderColorMap.get(f) ?? '#888'}33` : 'transparent',
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
          <span
            className={styles.graphHint}
            title={
              noteFocus
                ? 'Click any other note to pivot the linkages view onto it'
                : 'Click a folder bubble to drill in. Click a note to see its full cross-folder linkages.'
            }
          >
            {noteFocus ? 'click → re-pivot' : 'click → drill in / linkages'}
          </span>
        </div>
      </div>

      <div className={styles.graphHeader}>
        {noteFocus ? (
          <>
            <button
              type="button"
              className={styles.graphBackButton}
              onClick={() => router.push('/admin/codex/graph')}
            >
              ← All folders
            </button>
            <span className={styles.graphScopeLabel}>
              Linkages from: {data.nodes.find((n) => n.id === noteFocus)?.label ?? noteFocus}
            </span>
            <span className={styles.graphMeta}>
              {data.nodes.length} connected · {data.edges.length} links
            </span>
            <div className={styles.graphDepthControl}>
              <span className={styles.graphDepthLabel}>Depth</span>
              {[1, 2, 3].map((d) => (
                <button
                  key={d}
                  type="button"
                  className={
                    noteFocusDepth === d
                      ? styles.graphDepthButtonActive
                      : styles.graphDepthButton
                  }
                  onClick={() => setDepth(d)}
                  title={
                    d === 1
                      ? 'Direct connections only'
                      : `${d} hops out (much more data)`
                  }
                >
                  {d}
                </button>
              ))}
            </div>
          </>
        ) : data.scope ? (
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

      <div className={(noteFocus || viewingNotePath) ? styles.graphBodySplit : styles.graphBody}>
        {noteFocus && (
          <aside className={styles.graphLinkagesPanel}>
            {directConnections.length > 0 && (
              <section className={styles.graphLinkagesSection}>
                <h4 className={styles.graphLinkagesHeading}>
                  Direct connections
                  <span className={styles.graphLinkagesCount}>{directConnections.length}</span>
                </h4>
                <ul className={styles.graphLinkagesList}>
                  {directConnections.map((n) => (
                    <li
                      key={n.id}
                      className={
                        hoveredId === n.id || viewingNotePath === n.id
                          ? styles.graphLinkagesItemActive
                          : styles.graphLinkagesItem
                      }
                      onMouseEnter={() => setHoveredId(n.id)}
                      onMouseLeave={() => setHoveredId(null)}
                      onClick={() => setViewingNotePath(n.id)}
                      title={`View ${n.label}`}
                    >
                      <span
                        className={styles.graphLinkagesItemDot}
                        style={{ background: folderColorMap.get(n.folder) ?? '#888' }}
                      />
                      <span className={styles.graphLinkagesItemLabel}>{n.label}</span>
                      <span className={styles.graphLinkagesItemFolder}>
                        {n.folder.replace(/^\d+\s*-\s*/, '')}
                      </span>
                      <button
                        type="button"
                        className={styles.graphLinkagesItemPivot}
                        onClick={(e) => {
                          e.stopPropagation();
                          router.push(linkagesUrl(n.id));
                        }}
                        title="Pivot the linkages view onto this note"
                        aria-label="Pivot linkages"
                      >
                        🕸
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {widerConnections.length > 0 && (
              <section className={styles.graphLinkagesSection}>
                <h4 className={styles.graphLinkagesHeading}>
                  Wider neighborhood
                  <span className={styles.graphLinkagesCount}>{widerConnections.length}</span>
                </h4>
                <ul className={styles.graphLinkagesList}>
                  {widerConnections.map((n) => (
                    <li
                      key={n.id}
                      className={
                        hoveredId === n.id || viewingNotePath === n.id
                          ? styles.graphLinkagesItemActive
                          : styles.graphLinkagesItem
                      }
                      onMouseEnter={() => setHoveredId(n.id)}
                      onMouseLeave={() => setHoveredId(null)}
                      onClick={() => setViewingNotePath(n.id)}
                      title={`View ${n.label}`}
                    >
                      <span
                        className={styles.graphLinkagesItemDot}
                        style={{ background: folderColorMap.get(n.folder) ?? '#888' }}
                      />
                      <span className={styles.graphLinkagesItemLabel}>{n.label}</span>
                      <span className={styles.graphLinkagesItemFolderSubtle}>
                        {n.folder.replace(/^\d+\s*-\s*/, '')} · {n.distance ?? 0} hops
                      </span>
                      <button
                        type="button"
                        className={styles.graphLinkagesItemPivot}
                        onClick={(e) => {
                          e.stopPropagation();
                          router.push(linkagesUrl(n.id));
                        }}
                        title="Pivot the linkages view onto this note"
                        aria-label="Pivot linkages"
                      >
                        🕸
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {directConnections.length === 0 && widerConnections.length === 0 && (
              <p className={styles.graphLinkagesEmpty}>
                No linkages found at this depth. Try increasing depth in the header.
              </p>
            )}
          </aside>
        )}
        <div ref={containerRef} className={styles.graphCanvas} />
        {viewingNotePath && (
          <>
            <div
              className={styles.notePreviewResizeHandle}
              onMouseDown={(e) => startResize(e, paneWidth, setPaneWidth)}
              onDoubleClick={() => setPaneWidth(PANE_WIDTH_DEFAULT)}
              title="Drag to resize · double-click to reset"
              role="separator"
              aria-orientation="vertical"
            />
            <div className={styles.notePreviewPaneWrap} style={{ width: `${paneWidth}px` }}>
              <CodexNotePreviewPane
                notePath={viewingNotePath}
                onClose={() => setViewingNotePath(null)}
                onOpenLinkages={(p) => router.push(linkagesUrl(p))}
                onEdit={(p) => router.push(noteHref(p))}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Drag-to-resize handler for the side pane. The pane lives on the right, so
// dragging left grows it (positive delta = wider pane).
function startResize(
  e: React.MouseEvent,
  startWidth: number,
  setWidth: (w: number) => void,
) {
  e.preventDefault();
  const startX = e.clientX;
  const onMove = (ev: MouseEvent) => {
    const dx = startX - ev.clientX;
    const next = Math.max(PANE_WIDTH_MIN, Math.min(PANE_WIDTH_MAX, startWidth + dx));
    setWidth(next);
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  // Prevent text selection while dragging.
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'col-resize';
}

// Sort comparator: folder ascending, then label ascending. Used to group
// linkage list items by folder.
function byFolderThenLabel(a: CodexGraphNode, b: CodexGraphNode): number {
  const f = a.folder.localeCompare(b.folder);
  return f !== 0 ? f : a.label.localeCompare(b.label);
}

// ─── reducers (pure factories that read from a state ref) ────────────────────

type ReducerStateRef = React.MutableRefObject<{
  search: string;
  folderFilter: Set<string>;
  hoveredId: string | null;
  neighbors: Set<string> | null;
}>;

function makeNodeReducer(stateRef: ReducerStateRef) {
  return (node: string, attrs: Record<string, unknown>) => {
    const { search, folderFilter, hoveredId, neighbors } = stateRef.current;

    // Apply text + folder filters.
    const label = String(attrs.label ?? '');
    const folder = String(attrs.folder ?? '');
    if (search && !label.toLowerCase().includes(search.toLowerCase())) {
      return { ...attrs, hidden: true };
    }
    if (folderFilter.size > 0 && !folderFilter.has(folder)) {
      return { ...attrs, hidden: true };
    }

    // Apply hover dim — non-neighbors fade.
    if (hoveredId) {
      const isHot = node === hoveredId || (neighbors?.has(node) ?? false);
      if (!isHot) {
        return { ...attrs, color: DIM_COLOR, label: '', zIndex: 0 };
      }
      // Hovered node + its neighbors: keep label visible even if it'd
      // normally be culled by labelDensity.
      return { ...attrs, forceLabel: true, zIndex: 2 };
    }

    // Default: keep labels visible. Sigma's labelDensity / labelGridCellSize
    // settings handle collision automatically; at supernode level there are
    // only ~12 nodes so all fit comfortably.
    if (attrs.kind === 'SUPERNODE') {
      return { ...attrs, forceLabel: true };
    }
    return attrs;
  };
}

function makeEdgeReducer(
  stateRef: ReducerStateRef,
  graph: {
    source: (e: string) => string;
    target: (e: string) => string;
    getNodeAttributes: (id: string) => Record<string, unknown>;
  },
) {
  return (edge: string, attrs: Record<string, unknown>) => {
    const { search, folderFilter, hoveredId } = stateRef.current;

    const sId = graph.source(edge);
    const tId = graph.target(edge);
    const sAttrs = graph.getNodeAttributes(sId);
    const tAttrs = graph.getNodeAttributes(tId);
    const sLabel = String(sAttrs.label ?? '');
    const tLabel = String(tAttrs.label ?? '');
    const sFolder = String(sAttrs.folder ?? '');
    const tFolder = String(tAttrs.folder ?? '');

    const sHidden =
      (search && !sLabel.toLowerCase().includes(search.toLowerCase())) ||
      (folderFilter.size > 0 && !folderFilter.has(sFolder));
    const tHidden =
      (search && !tLabel.toLowerCase().includes(search.toLowerCase())) ||
      (folderFilter.size > 0 && !folderFilter.has(tFolder));
    if (sHidden || tHidden) return { ...attrs, hidden: true };

    if (hoveredId) {
      const involves = sId === hoveredId || tId === hoveredId;
      return { ...attrs, color: involves ? HOT_EDGE : DIM_EDGE };
    }

    return attrs;
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

// Concentric ring layout for noteFocus mode: focused note at origin,
// neighbors arranged in rings by hop distance, sorted by folder so
// same-folder neighbors cluster as arc-segments. Replaces ForceAtlas2 for
// this view since we already know the right structure.
function computeConcentricLayout(
  nodes: CodexGraphNode[],
  focusedId: string,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const byDistance = new Map<number, CodexGraphNode[]>();
  for (const n of nodes) {
    const d = n.distance ?? 0;
    if (!byDistance.has(d)) byDistance.set(d, []);
    byDistance.get(d)!.push(n);
  }

  positions.set(focusedId, { x: 0, y: 0 });

  const distances = [...byDistance.keys()].filter((d) => d > 0).sort((a, b) => a - b);
  // Ring radii grow exponentially so outer rings have proportionally more
  // circumference for their (typically much larger) populations.
  let radius = 1;
  for (const dist of distances) {
    const ringNodes = byDistance.get(dist)!;
    // Sort by folder (then label) so same-folder neighbors arc-cluster.
    ringNodes.sort((a, b) => {
      const folderCmp = a.folder.localeCompare(b.folder);
      return folderCmp !== 0 ? folderCmp : a.label.localeCompare(b.label);
    });
    const count = ringNodes.length;
    // Make sure dense outer rings have enough circumference per node.
    const minCircumferencePerNode = 0.6;
    const requiredRadius = (count * minCircumferencePerNode) / (2 * Math.PI);
    radius = Math.max(radius, requiredRadius);
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * 2 * Math.PI - Math.PI / 2;
      positions.set(ringNodes[i].id, {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
      });
    }
    radius *= 1.8;
  }

  return positions;
}

// Lighten / darken a hex color by amt in [-1, 1]. Negative = darker.
function shadeHex(hex: string, amt: number): string {
  const h = hex.startsWith('#') ? hex.slice(1) : hex;
  const exp = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const r = parseInt(exp.slice(0, 2), 16);
  const g = parseInt(exp.slice(2, 4), 16);
  const b = parseInt(exp.slice(4, 6), 16);
  const f = (x: number) => Math.max(0, Math.min(255, Math.round(x + 255 * amt)));
  return `#${[f(r), f(g), f(b)].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

function nodeSize(n: CodexGraphNode): number {
  // Sigma's size units are roughly screen-pixels at default zoom — much
  // smaller numbers than the canvas-pixel radii the previous renderer used.
  if (n.kind === 'SUPERNODE') {
    const count = n.noteCount ?? 1;
    return Math.max(8, Math.min(28, Math.sqrt(count) * 2.2));
  }
  return Math.max(3, Math.min(20, Math.sqrt(n.pageRank * 4500)));
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
          const sorted = (data?.vaultGraph.nodes ?? [])
            .slice()
            .sort((a, b) => b.pageRank - a.pageRank);
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
            <span className={styles.notePath}>influence {(h.pageRank * 100).toFixed(2)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
