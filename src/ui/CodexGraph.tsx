'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useCodexGraphqlRequest, useCodexNavigation } from './CodexAdapters';
import { noteHref } from './CodexTree';
import styles from './codex.module.css';

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

export default function CodexGraph({ scope }: Props) {
  const graphqlRequest = useCodexGraphqlRequest();
  const { useRouter: useNavRouter } = useCodexNavigation();
  const router = useNavRouter();
  const [rawData, setRawData] = useState<CodexGraphPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [folderFilter, setFolderFilter] = useState<Set<string>>(new Set());
  // Local-graph mode: when focusedId is set, only nodes within focusDepth
  // hops of focusedId are visible. Shift+click a node to enter; click
  // empty stage or the × badge to exit.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [focusedLabel, setFocusedLabel] = useState<string>('');
  const [focusDepth, setFocusDepth] = useState<number>(2);

  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<unknown>(null);
  const graphRef = useRef<unknown>(null);
  const reducerStateRef = useRef({
    search: '',
    folderFilter: new Set<string>(),
    hoveredId: null as string | null,
    neighbors: null as Set<string> | null,
    focusVisible: null as Set<string> | null,
    focusedId: null as string | null,
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
    setFocusedId(null);
    setFocusedLabel('');
    (async () => {
      try {
        const { data: payload, errors } = await graphqlRequest<{
          vaultGraph: CodexGraphPayload;
        }>(GRAPH_QUERY, { scope: scope ?? null });
        if (cancelled) return;
        if (errors?.length) {
          setError(errors.map((e) => e.message).join('; '));
        } else {
          setRawData(payload?.vaultGraph ?? null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load graph');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scope]);

  // The supernode resolver groups every file by `folder`, including top-level
  // files (Home.md, README.md, CLAUDE.md) which end up as 1-note "fake folders"
  // named after the file. Filter them out as visual noise.
  const looksLikeFile = useCallback((s: string): boolean => /\.\w+$/.test(s), []);
  const data = useMemo<CodexGraphPayload | null>(() => {
    if (!rawData) return null;
    if (rawData.scope) return rawData;
    const visibleNodes = rawData.nodes.filter((n) => !looksLikeFile(n.id));
    const visibleIds = new Set(visibleNodes.map((n) => n.id));
    const visibleEdges = rawData.edges.filter(
      (e) => visibleIds.has(e.from) && visibleIds.has(e.to),
    );
    return { ...rawData, nodes: visibleNodes, edges: visibleEdges };
  }, [rawData, looksLikeFile]);

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
      data.nodes.forEach((node, i) => {
        const fillColor = folderColorMap.get(node.folder) ?? '#9aa3b2';
        graph.addNode(node.id, {
          // Initial position on a circle so FA2 has a sane starting layout.
          x: Math.cos((i / n) * 2 * Math.PI),
          y: Math.sin((i / n) * 2 * Math.PI),
          size: nodeSize(node),
          color: fillColor,
          // Slightly darker fill color = subtle border that gives nodes depth
          // without looking outlined.
          borderColor: shadeHex(fillColor, -0.35),
          type: 'border',
          label: node.label,
          // Custom attrs preserved for reducer logic + click handler.
          kind: node.kind,
          folder: node.folder,
          pageRank: node.pageRank,
          noteCount: node.noteCount,
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
            curvature: 0.25,
          });
        }
      });

      // ForceAtlas2 with linLogMode is the recipe for densely-connected
      // categorical graphs (our supernode case). For folder subgraphs (less
      // dense, more notes) we tune slightly differently.
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

      // Click navigation. Shift+click = enter local-graph mode (focus on
      // node + N-hop neighborhood). Regular click = navigate.
      sigma.on(
        'clickNode',
        ({
          node,
          event,
        }: {
          node: string;
          event: { original: MouseEvent | TouchEvent };
        }) => {
          const a = graph.getNodeAttributes(node) as { kind: string; label: string };
          // shiftKey only exists on MouseEvent (touch can't shift+click anyway).
          const isMouse = 'shiftKey' in event.original;
          if (isMouse && (event.original as MouseEvent).shiftKey) {
            setFocusedId(node);
            setFocusedLabel(a.label);
            return;
          }
          if (a.kind === 'SUPERNODE') {
            router.push(`/admin/codex/graph?scope=${encodeURIComponent(node)}`);
          } else {
            router.push(noteHref(node));
          }
        },
      );

      // Click on empty stage exits local-graph mode.
      sigma.on('clickStage', () => {
        setFocusedId(null);
        setFocusedLabel('');
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
      focusVisible: focusedId
        ? bfsNeighborhood(graph, focusedId, focusDepth)
        : null,
      focusedId,
    };
    sigma.refresh();
    // After a focus change, re-fit the camera to the visible subgraph.
    if (focusedId) {
      const camera = (sigma as unknown as { getCamera: () => { animatedReset: (opts: { duration: number }) => void } })
        .getCamera();
      setTimeout(() => camera.animatedReset({ duration: 500 }), 50);
    }
  }, [search, folderFilter, hoveredId, focusedId, focusDepth]);

  if (isMobile) return <MobileFallback />;
  if (error) return <div className={styles.error}>{error}</div>;
  if (!data) return <div className={styles.spinnerWrap}>Loading graph…</div>;

  const folders = Array.from(folderColorMap.keys());
  const visibleNodeCount = data.nodes.filter((n) => {
    if (search && !n.label.toLowerCase().includes(search.toLowerCase())) return false;
    if (folderFilter.size > 0 && !folderFilter.has(n.folder)) return false;
    return true;
  }).length;

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
          <span className={styles.graphHint} title="Shift+click any node to focus on its neighborhood">
            ⇧ click → local view
          </span>
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

      {focusedId && (
        <div className={styles.graphFocusBanner}>
          <span className={styles.graphFocusLabel}>
            <strong>Local view:</strong> {focusedLabel}
          </span>
          <label className={styles.graphFocusDepth}>
            <span>Depth</span>
            <input
              type="range"
              min={1}
              max={3}
              value={focusDepth}
              onChange={(e) => setFocusDepth(Number(e.target.value))}
            />
            <span className={styles.graphFocusDepthValue}>{focusDepth}</span>
          </label>
          <button
            type="button"
            className={styles.graphFocusClose}
            onClick={() => {
              setFocusedId(null);
              setFocusedLabel('');
            }}
            title="Exit local-graph view"
          >
            ×
          </button>
        </div>
      )}

      <div ref={containerRef} className={styles.graphCanvas} />
    </div>
  );
}

// ─── reducers (pure factories that read from a state ref) ────────────────────

type ReducerStateRef = React.MutableRefObject<{
  search: string;
  folderFilter: Set<string>;
  hoveredId: string | null;
  neighbors: Set<string> | null;
  focusVisible: Set<string> | null;
  focusedId: string | null;
}>;

function makeNodeReducer(stateRef: ReducerStateRef) {
  return (node: string, attrs: Record<string, unknown>) => {
    const { search, folderFilter, hoveredId, neighbors, focusVisible, focusedId } =
      stateRef.current;

    // Apply text + folder filters.
    const label = String(attrs.label ?? '');
    const folder = String(attrs.folder ?? '');
    if (search && !label.toLowerCase().includes(search.toLowerCase())) {
      return { ...attrs, hidden: true };
    }
    if (folderFilter.size > 0 && !folderFilter.has(folder)) {
      return { ...attrs, hidden: true };
    }

    // Local-graph mode: hide nodes outside the focused N-hop neighborhood.
    if (focusVisible && !focusVisible.has(node)) {
      return { ...attrs, hidden: true };
    }
    // The focused node itself gets a subtle highlight.
    if (focusedId && node === focusedId) {
      return { ...attrs, forceLabel: true, zIndex: 3, highlighted: true };
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
    const { search, folderFilter, hoveredId, focusVisible } = stateRef.current;

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
      (folderFilter.size > 0 && !folderFilter.has(sFolder)) ||
      (focusVisible && !focusVisible.has(sId));
    const tHidden =
      (search && !tLabel.toLowerCase().includes(search.toLowerCase())) ||
      (folderFilter.size > 0 && !folderFilter.has(tFolder)) ||
      (focusVisible && !focusVisible.has(tId));
    if (sHidden || tHidden) return { ...attrs, hidden: true };

    if (hoveredId) {
      const involves = sId === hoveredId || tId === hoveredId;
      return { ...attrs, color: involves ? HOT_EDGE : DIM_EDGE };
    }

    return attrs;
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

// BFS the N-hop neighborhood of `source` and return the set of node IDs
// (including the source itself). Used by local-graph mode.
function bfsNeighborhood(
  graph: { neighbors: (id: string) => string[]; hasNode: (id: string) => boolean },
  source: string,
  depth: number,
): Set<string> {
  if (!graph.hasNode(source)) return new Set([source]);
  const visited = new Set<string>([source]);
  let frontier: string[] = [source];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const n of frontier) {
      for (const neighbor of graph.neighbors(n)) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return visited;
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
