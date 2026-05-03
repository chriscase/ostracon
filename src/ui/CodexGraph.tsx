'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
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
) as unknown as React.ComponentType<LooseGraphProps>;

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
  const containerRef = useRef<HTMLDivElement>(null);

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

  // For folder subgraphs, pre-position notes in a golden-angle spiral with
  // radius = 1 - pageRank so hubs end up central. The force simulation will
  // fine-tune from there.
  const positionedNodes = useMemo(() => {
    if (!data) return [];
    if (!data.scope) return data.nodes; // Supernodes use default force layout.
    const sorted = [...data.nodes].sort((a, b) => b.pageRank - a.pageRank);
    const maxRank = Math.max(1e-9, ...sorted.map((n) => n.pageRank));
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    const r = Math.min(size.width, size.height) / 2 - 60;
    return sorted.map((n, i) => ({
      ...n,
      x: Math.cos(i * goldenAngle) * (1 - n.pageRank / maxRank) * r,
      y: Math.sin(i * goldenAngle) * (1 - n.pageRank / maxRank) * r,
    }));
  }, [data, size.width, size.height]);

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

  return (
    <div className={styles.graphRoot}>
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
            <span className={styles.graphMeta}>{data.nodes.length} notes</span>
          </>
        ) : (
          <>
            <span className={styles.graphScopeLabel}>All folders</span>
            <span className={styles.graphMeta}>
              {data.nodes.length} folders · {data.edges.length} cross-folder links
            </span>
          </>
        )}
      </div>

      <div ref={containerRef} className={styles.graphCanvas}>
        <ForceGraph2D
          graphData={{ nodes: positionedNodes, links }}
          width={size.width}
          height={size.height}
          nodeId="id"
          nodeLabel={(n: CodexGraphNode) =>
            n.kind === 'SUPERNODE'
              ? `${n.label} (${n.noteCount} notes)`
              : `${n.label} · pr ${(n.pageRank * 100).toFixed(2)}`
          }
          nodeCanvasObject={(
            n: CodexGraphNode & { x?: number; y?: number },
            ctx: CanvasRenderingContext2D,
            globalScale: number,
          ) => {
            // Always-visible label (closes #208). Draws the dot + label text in
            // canvas space so users don't have to hover to identify nodes.
            // We size + color the dot with the same heuristic the legacy
            // nodeVal/nodeColor props would have used.
            if (n.x === undefined || n.y === undefined) return;
            const radius = nodeRadius(n);
            // Dot.
            ctx.beginPath();
            ctx.arc(n.x, n.y, radius, 0, Math.PI * 2);
            ctx.fillStyle = n.kind === 'SUPERNODE' ? '#78c8ff' : folderColor(n.folder);
            ctx.fill();
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
            ctx.lineWidth = 0.5;
            ctx.stroke();
            // Label.
            const label = truncateLabel(n.label, n.kind === 'SUPERNODE' ? 30 : 22);
            const fontSize = Math.max(9, 12 / globalScale);
            ctx.font = `${n.kind === 'SUPERNODE' ? '600 ' : ''}${fontSize}px system-ui, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            const textWidth = ctx.measureText(label).width;
            const padX = 4 / globalScale;
            const padY = 2 / globalScale;
            const labelY = n.y + radius + 3 / globalScale;
            // Background plate for legibility.
            ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
            ctx.fillRect(
              n.x - textWidth / 2 - padX,
              labelY,
              textWidth + padX * 2,
              fontSize + padY * 2,
            );
            ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
            ctx.fillText(label, n.x, labelY + padY);
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
          linkWidth={(l: { weight: number }) => Math.max(0.5, Math.log1p(l.weight))}
          linkColor={() => 'rgba(180, 180, 200, 0.3)'}
          linkDirectionalParticles={(l: { weight: number }) =>
            l.weight > 2 ? Math.min(3, Math.floor(l.weight / 2)) : 0
          }
          linkDirectionalParticleSpeed={0.005}
          backgroundColor="rgba(0, 0, 0, 0)"
          cooldownTicks={100}
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

function folderColor(folder: string): string {
  // Stable, deterministic color from the folder name.
  let h = 0;
  for (let i = 0; i < folder.length; i++) {
    h = (h * 31 + folder.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(h) % 360;
  return `hsl(${hue} 60% 65%)`;
}

function nodeRadius(n: CodexGraphNode): number {
  // Mirrors the legacy `nodeVal` heuristic but as a real radius (not the
  // sqrt-applied area react-force-graph uses internally). Tuned so supernodes
  // dominate visually and per-folder note-radii spread enough to read.
  if (n.kind === 'SUPERNODE') return Math.max(8, Math.sqrt((n.noteCount ?? 1) * 4));
  return Math.max(3, Math.sqrt(n.pageRank * 4000));
}

function truncateLabel(label: string, max: number): string {
  return label.length > max ? label.slice(0, max - 1) + '…' : label;
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
