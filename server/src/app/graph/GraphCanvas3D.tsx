'use client';

// 3D star-field rendering of the note graph. Prototype — sits beside the
// 2D Sigma view at /graph-3d. Re-uses the /api/graph endpoint and the
// shared clusterKey() so groupings match the 2D mental model.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Html } from '@react-three/drei';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import * as THREE from 'three';
import { clusterKey, radiusForDegree } from './graphStyle';

type GraphPayload = {
  nodes: Array<{ id: string; title: string; tags: string[]; degree: number }>;
  edges: Array<{ source: string; target: string }>;
};

type Placed = {
  id: string;
  title: string;
  degree: number;
  cluster: string;
  pos: THREE.Vector3;
  scale: number;
};

type Cluster = {
  key: string;
  label: string;
  center: THREE.Vector3;
};

// Theme colors snapshot (read once on mount; switching theme will be picked
// up on a re-mount).
type Palette = {
  background: THREE.Color;
  edge: THREE.Color;
  candlelight: THREE.Color;
  inkSoft: string; // for HTML labels (CSS color)
  ink: string;
};

function readPalette(): Palette {
  const fallback: Palette = {
    background: new THREE.Color('#0A0806'),
    edge: new THREE.Color('#5A4F42'),
    candlelight: new THREE.Color('#D4A85A'),
    inkSoft: '#5A4F42',
    ink: '#2A241E',
  };
  if (typeof document === 'undefined') return fallback;
  const cs = getComputedStyle(document.documentElement);
  const get = (name: string, def: string) => cs.getPropertyValue(name).trim() || def;
  return {
    background: new THREE.Color(get('--parchment-deep', '#0A0806')),
    edge: new THREE.Color(get('--ink-soft', '#5A4F42')),
    candlelight: new THREE.Color(get('--candlelight', '#D4A85A')),
    inkSoft: get('--ink-soft', '#5A4F42'),
    ink: get('--ink', '#2A241E'),
  };
}

// Fibonacci-sphere distribution — uniform points on a unit sphere.
function fibSphere(i: number, n: number): THREE.Vector3 {
  if (n <= 1) return new THREE.Vector3(0, 0, 0);
  const phi = Math.acos(1 - (2 * (i + 0.5)) / n);
  const theta = Math.PI * (1 + Math.sqrt(5)) * i;
  return new THREE.Vector3(
    Math.sin(phi) * Math.cos(theta),
    Math.sin(phi) * Math.sin(theta),
    Math.cos(phi),
  );
}

function placeNodes(payload: GraphPayload): { placed: Placed[]; clusters: Cluster[] } {
  // Group by cluster key
  const buckets = new Map<string, GraphPayload['nodes']>();
  for (const n of payload.nodes) {
    const key = clusterKey(n.id);
    const arr = buckets.get(key);
    if (arr) arr.push(n);
    else buckets.set(key, [n]);
  }

  const entries = [...buckets.entries()];
  const C = entries.length;
  const galaxyRadius = C <= 1 ? 0 : 18 * Math.cbrt(C);

  const clusters: Cluster[] = [];
  const placed: Placed[] = [];

  entries.forEach(([key, ids], ci) => {
    const dir = fibSphere(ci, C);
    const center = dir.clone().multiplyScalar(galaxyRadius);
    const segs = key.split('/');
    const label = segs[segs.length - 1] || key;
    clusters.push({ key, label, center });

    const size = ids.length;
    // Scale local radius with both the count AND the typical star size so
    // dense clusters don't collapse onto themselves before relaxation.
    const avgScale = ids.reduce((s, n) => s + Math.max(1.2, radiusForDegree(n.degree) / 4), 0) / Math.max(size, 1);
    const localRadius = Math.max(2 + 1.4 * Math.cbrt(size), avgScale * (1.2 + Math.sqrt(size)));
    ids.forEach((n, i) => {
      const local = fibSphere(i, Math.max(size, 1)).multiplyScalar(localRadius);
      const pos = center.clone().add(local);
      const r = radiusForDegree(n.degree) / 4;
      placed.push({
        id: n.id,
        title: n.title,
        degree: n.degree,
        cluster: key,
        pos,
        scale: Math.max(1.2, r),
      });
    });
  });

  // Relaxation: separate any overlapping spheres. Keeps a small visible
  // gap between every pair so dense clusters don't render as one blob.
  relaxOverlaps(placed);

  return { placed, clusters };
}

// Iterative pairwise repulsion. O(N²) per pass but runs once on data load
// — fine up to a few thousand nodes. Stops early when no pair moves.
function relaxOverlaps(placed: Placed[]): void {
  const GAP = 0.6;
  const MAX_ITERS = 40;
  const N = placed.length;
  for (let iter = 0; iter < MAX_ITERS; iter++) {
    let moved = false;
    for (let i = 0; i < N; i++) {
      const a = placed[i];
      if (!a) continue;
      for (let j = i + 1; j < N; j++) {
        const b = placed[j];
        if (!b) continue;
        const minDist = a.scale + b.scale + GAP;
        const dx = b.pos.x - a.pos.x;
        const dy = b.pos.y - a.pos.y;
        const dz = b.pos.z - a.pos.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= minDist * minDist) continue;
        const d = Math.sqrt(d2);
        if (d < 1e-4) {
          // Coincident — nudge along a deterministic axis so the next
          // iteration has a direction to push along.
          a.pos.x -= 0.05;
          b.pos.x += 0.05;
          moved = true;
          continue;
        }
        const push = (minDist - d) / 2;
        const ux = dx / d;
        const uy = dy / d;
        const uz = dz / d;
        a.pos.x -= ux * push;
        a.pos.y -= uy * push;
        a.pos.z -= uz * push;
        b.pos.x += ux * push;
        b.pos.y += uy * push;
        b.pos.z += uz * push;
        moved = true;
      }
    }
    if (!moved) break;
  }
}

// One InstancedMesh for all stars. emissive=star color; bloom does the glow work.
function Stars({
  placed,
  hoverIdx,
  setHoverIdx,
  candlelight,
  starColor,
  onClickIdx,
}: {
  placed: Placed[];
  hoverIdx: number | null;
  setHoverIdx: (i: number | null) => void;
  candlelight: THREE.Color;
  starColor: string;
  onClickIdx: (i: number) => void;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const instColor = useMemo(() => new THREE.Color(), []);
  const baseColor = useMemo(() => new THREE.Color(starColor), [starColor]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    placed.forEach((p, i) => {
      dummy.position.copy(p.pos);
      dummy.scale.setScalar(p.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      const intensity = 0.85 + Math.min(0.6, p.degree * 0.04);
      instColor.copy(baseColor).multiplyScalar(intensity);
      mesh.setColorAt(i, instColor);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [placed, dummy, instColor, baseColor]);

  // Hover tint: re-write color for hovered idx each frame it changes.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    placed.forEach((p, i) => {
      if (i === hoverIdx) {
        instColor.copy(candlelight).multiplyScalar(1.6);
      } else {
        const intensity = 0.85 + Math.min(0.6, p.degree * 0.04);
        instColor.copy(baseColor).multiplyScalar(intensity);
      }
      mesh.setColorAt(i, instColor);
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [hoverIdx, placed, instColor, baseColor, candlelight]);

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, placed.length]}
      onPointerMove={(e) => {
        e.stopPropagation();
        if (typeof e.instanceId === 'number') setHoverIdx(e.instanceId);
      }}
      onPointerOut={(e) => {
        e.stopPropagation();
        setHoverIdx(null);
      }}
      onClick={(e) => {
        e.stopPropagation();
        if (typeof e.instanceId === 'number') onClickIdx(e.instanceId);
      }}
    >
      <sphereGeometry args={[1, 24, 24]} />
      <meshBasicMaterial color="#FFFFFF" toneMapped={false} />
    </instancedMesh>
  );
}

function Edges({ placed, edges, color }: { placed: Placed[]; edges: GraphPayload['edges']; color: THREE.Color }) {
  const positions = useMemo(() => {
    const idIdx = new Map<string, number>();
    placed.forEach((p, i) => idIdx.set(p.id, i));
    const pts: number[] = [];
    for (const e of edges) {
      const a = idIdx.get(e.source);
      const b = idIdx.get(e.target);
      if (a == null || b == null) continue;
      const pa = placed[a]?.pos;
      const pb = placed[b]?.pos;
      if (!pa || !pb) continue;
      pts.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
    }
    return new Float32Array(pts);
  }, [placed, edges]);

  const geomRef = useRef<THREE.BufferGeometry>(null);
  useEffect(() => {
    const g = geomRef.current;
    if (!g) return;
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.computeBoundingSphere();
  }, [positions]);

  return (
    <lineSegments>
      <bufferGeometry ref={geomRef} />
      <lineBasicMaterial color={color} transparent opacity={0.18} blending={THREE.AdditiveBlending} depthWrite={false} />
    </lineSegments>
  );
}

// Per-campaign labels — grouped by the top-level path segment so each
// campaign gets one big banner rather than the deeper-segment label that
// used to crowd the inside of every cluster orb.
//
// Implemented with drei <Html> (DOM-projected) instead of drei <Text>
// (troika SDF) because troika spawns Web Workers that chain importScripts
// of further blob: URLs — incompatible with our CSP.
function CampaignLabels({ placed }: { placed: Placed[] }) {
  const groups = useMemo(() => {
    const m = new Map<string, { center: THREE.Vector3; count: number }>();
    for (const p of placed) {
      const top = (p.cluster.split('/')[0] || p.cluster).trim();
      if (!top) continue;
      const e = m.get(top);
      if (!e) {
        m.set(top, { center: p.pos.clone(), count: 1 });
      } else {
        e.center.add(p.pos);
        e.count += 1;
      }
    }
    return [...m.entries()].map(([key, { center, count }]) => ({
      key,
      label: key.replace(/[-_]/g, ' '),
      center: center.divideScalar(count),
    }));
  }, [placed]);

  return (
    <>
      {groups.map((g) => (
        <Html
          key={g.key}
          position={[g.center.x, g.center.y, g.center.z]}
          center
          distanceFactor={20}
          pointerEvents="none"
        >
          <div
            style={{
              color: '#FFFFFF',
              fontFamily: 'Inter, system-ui, sans-serif',
              fontSize: 18,
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              opacity: 0.7,
              textShadow: '0 0 6px rgba(0,0,0,0.85), 0 1px 2px rgba(0,0,0,0.6)',
              whiteSpace: 'nowrap',
            }}
          >
            {g.label}
          </div>
        </Html>
      ))}
    </>
  );
}

// Per-node labels — always rendered, opacity ramps from 0 (far) to 1 (near
// or hovered). useFrame lerps each frame so the ease feels smooth instead
// of snapping when the camera crosses a threshold.
function NodeLabels({
  placed,
  hoverIdx,
}: {
  placed: Placed[];
  hoverIdx: number | null;
}) {
  return (
    <>
      {placed.map((p, i) => (
        <NodeLabel key={p.id} p={p} hover={i === hoverIdx} />
      ))}
    </>
  );
}

function NodeLabel({ p, hover }: { p: Placed; hover: boolean }) {
  // We mutate the inner div's opacity directly via ref so the per-frame
  // lerp doesn't trigger React re-renders.
  const divRef = useRef<HTMLDivElement>(null);
  const cur = useRef(0);
  // Empirical fade range — node positions span tens of units so a 25..90
  // window means labels pop in once you're inside a cluster but stay clean
  // at the framing camera distance.
  const NEAR = 25;
  const FAR = 90;
  useFrame((state) => {
    const el = divRef.current;
    if (!el) return;
    const dist = state.camera.position.distanceTo(p.pos);
    const distFade = THREE.MathUtils.clamp(1 - (dist - NEAR) / (FAR - NEAR), 0, 1);
    const target = hover ? 1 : distFade;
    cur.current = THREE.MathUtils.lerp(cur.current, target, 0.15);
    el.style.opacity = String(cur.current);
    // Cull from layout entirely once invisible — keeps hundreds of
    // off-screen labels from contributing layout cost.
    el.style.display = cur.current > 0.01 ? 'block' : 'none';
  });
  return (
    <Html
      position={[p.pos.x, p.pos.y + p.scale + 0.4, p.pos.z]}
      center
      pointerEvents="none"
      zIndexRange={[10, 0]}
    >
      <div
        ref={divRef}
        style={{
          color: '#FFFFFF',
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: 12,
          fontWeight: 500,
          padding: '2px 6px',
          background: 'rgb(0 0 0 / 0.45)',
          borderRadius: 4,
          whiteSpace: 'nowrap',
          opacity: 0,
          willChange: 'opacity',
        }}
      >
        {p.title}
      </div>
    </Html>
  );
}

function CameraFitter({ placed }: { placed: Placed[] }) {
  const { camera } = useThree();
  const did = useRef(false);
  useEffect(() => {
    if (did.current || placed.length === 0) return;
    did.current = true;
    const box = new THREE.Box3();
    for (const p of placed) box.expandByPoint(p.pos);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius, 10);
    camera.position.set(sphere.center.x, sphere.center.y, sphere.center.z + r * 2.4);
    camera.lookAt(sphere.center);
    camera.updateProjectionMatrix();
  }, [placed, camera]);
  return null;
}

type LoadPhase = 'fetching' | 'placing' | 'ready' | 'error';

// Preset palettes pulled from DESIGN.md and ACCENT_PALETTE in lib/users.ts.
// We keep hex literals here because three.js materials need real colour
// values, not CSS variables — this is the same exception that lets the
// rest of this file use #FFFFFF.
const STAR_PRESETS: Array<{ id: string; label: string; hex: string }> = [
  { id: 'white', label: 'Starlight', hex: '#FFFFFF' },
  { id: 'candlelight', label: 'Candlelight', hex: '#D4A85A' },
  { id: 'moss', label: 'Moss', hex: '#7B8A5F' },
  { id: 'sage', label: 'Sage', hex: '#6B7F8E' },
  { id: 'wine', label: 'Wine', hex: '#8B4A52' },
  { id: 'embers', label: 'Embers', hex: '#B5572A' },
  { id: 'wisteria', label: 'Wisteria', hex: '#6A5D8B' },
  { id: 'ink', label: 'Ink', hex: '#2A241E' },
];

const BG_PRESETS: Array<{ id: string; label: string; hex: string }> = [
  { id: 'shadow', label: 'Shadow', hex: '#0A0806' },
  { id: 'ink', label: 'Ink', hex: '#1E1A15' },
  { id: 'vellum-night', label: 'Vellum (night)', hex: '#3A342E' },
  { id: 'parchment', label: 'Parchment', hex: '#F4EDE0' },
  { id: 'parchment-sunk', label: 'Parchment sunk', hex: '#EAE1CF' },
  { id: 'wine', label: 'Wine', hex: '#3B1F22' },
  { id: 'sage', label: 'Sage', hex: '#1F2B33' },
];

const STORAGE_KEY = 'graph3d:colors';

export function GraphCanvas3D({ groupId }: { groupId: string }): React.ReactElement {
  const router = useRouter();
  const [data, setData] = useState<GraphPayload | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [palette, setPalette] = useState<Palette | null>(null);
  const [phase, setPhase] = useState<LoadPhase>('fetching');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [starColor, setStarColor] = useState<string>('#FFFFFF');
  const [bgColor, setBgColor] = useState<string>('#0A0806');
  useEffect(() => {
    setPalette(readPalette());
    if (typeof window !== 'undefined') {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as { star?: string; bg?: string };
          if (parsed.star) setStarColor(parsed.star);
          if (parsed.bg) setBgColor(parsed.bg);
        }
      } catch {
        /* ignore */
      }
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ star: starColor, bg: bgColor }),
      );
    } catch {
      /* ignore quota / private mode */
    }
  }, [starColor, bgColor]);

  useEffect(() => {
    let cancelled = false;
    setPhase('fetching');
    void fetch('/api/graph?scope=all&phase=full', { credentials: 'same-origin' })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j: GraphPayload) => {
        if (cancelled) return;
        setPhase('placing');
        setData(j);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error('[graph-3d] fetch failed', err);
        setErrorMsg(String(err));
        setPhase('error');
      });
    return () => {
      cancelled = true;
    };
  }, [groupId]);

  const { placed } = useMemo(() => {
    if (!data) return { placed: [] as Placed[], clusters: [] as Cluster[] };
    return placeNodes(data);
  }, [data]);

  useEffect(() => {
    if (phase === 'placing' && placed.length > 0) setPhase('ready');
    if (phase === 'placing' && data && placed.length === 0) setPhase('ready');
  }, [phase, placed.length, data]);

  const onClickIdx = (i: number) => {
    const p = placed[i];
    if (p) router.push(`/notes/${p.id}`);
  };

  if (!palette) {
    return <div className="relative flex-1" style={{ minHeight: 0, minWidth: 0 }} />;
  }

  return (
    <div
      className="relative flex-1"
      style={{ background: bgColor, minHeight: 0, minWidth: 0 }}
    >
      <Canvas
        camera={{ position: [0, 0, 60], fov: 55, near: 0.1, far: 2000 }}
        dpr={[1, 2]}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      >
        <color attach="background" args={[bgColor]} />
        <fog attach="fog" args={[bgColor, 60, 320]} />
        <ambientLight intensity={0.25} />

        {placed.length > 0 && (
          <>
            <CameraFitter placed={placed} />
            <Stars
              placed={placed}
              hoverIdx={hoverIdx}
              setHoverIdx={setHoverIdx}
              candlelight={palette.candlelight}
              starColor={starColor}
              onClickIdx={onClickIdx}
            />
            <Edges placed={placed} edges={data?.edges ?? []} color={palette.edge} />
            <NodeLabels placed={placed} hoverIdx={hoverIdx} />
            <CampaignLabels placed={placed} />
          </>
        )}

        <OrbitControls enablePan enableZoom enableRotate enableDamping dampingFactor={0.08} />

        <EffectComposer>
          <Bloom luminanceThreshold={0.2} luminanceSmoothing={0.3} intensity={1.6} mipmapBlur />
        </EffectComposer>
      </Canvas>

      <ColorPanel
        starColor={starColor}
        bgColor={bgColor}
        onStarChange={setStarColor}
        onBgChange={setBgColor}
        onReset={() => {
          setStarColor('#FFFFFF');
          setBgColor('#0A0806');
        }}
      />

      {phase !== 'ready' && (
        <LoadingOverlay
          phase={phase}
          color={palette.inkSoft}
          accent={`#${palette.candlelight.getHexString()}`}
          errorMsg={errorMsg}
          nodeCount={data?.nodes.length ?? 0}
          edgeCount={data?.edges.length ?? 0}
        />
      )}
      {phase === 'ready' && data && data.nodes.length === 0 && (
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none"
          style={{ color: palette.inkSoft, fontFamily: 'Inter, system-ui, sans-serif', fontSize: 13 }}
        >
          No notes yet — create some to populate the star map.
        </div>
      )}
    </div>
  );
}

function LoadingOverlay({
  phase,
  color,
  accent,
  errorMsg,
  nodeCount,
  edgeCount,
}: {
  phase: LoadPhase;
  color: string;
  accent: string;
  errorMsg: string | null;
  nodeCount?: number;
  edgeCount?: number;
}) {
  const status =
    phase === 'fetching'
      ? 'Charting the heavens…'
      : phase === 'placing'
      ? `Placing ${nodeCount ?? 0} stars and ${edgeCount ?? 0} ley-lines…`
      : phase === 'error'
      ? `Failed to load: ${errorMsg ?? 'unknown error'}`
      : '';
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 pointer-events-none">
      {phase !== 'error' && <Spinner accent={accent} />}
      <div
        style={{
          color,
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: 13,
          letterSpacing: '0.02em',
        }}
      >
        {status}
      </div>
    </div>
  );
}

function ColorPanel({
  starColor,
  bgColor,
  onStarChange,
  onBgChange,
  onReset,
}: {
  starColor: string;
  bgColor: string;
  onStarChange: (hex: string) => void;
  onBgChange: (hex: string) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState<boolean>(true);
  return (
    <div
      className="absolute right-3 top-3 z-10"
      style={{ pointerEvents: 'auto' }}
    >
      <div
        className="rounded-[10px] border bg-[var(--vellum)] text-[var(--ink)] shadow-[0_6px_18px_rgb(var(--ink-rgb)/0.10)]"
        style={{ borderColor: 'var(--rule)', minWidth: 220 }}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
          aria-expanded={open}
          aria-label="Toggle colour panel"
        >
          <span className="text-xs font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
            Colours
          </span>
          <span aria-hidden className="flex items-center gap-1.5">
            <ColorChip color={starColor} />
            <ColorChip color={bgColor} />
            <span className="text-[var(--ink-muted)]">{open ? '▾' : '▸'}</span>
          </span>
        </button>
        {open && (
          <div className="space-y-3 px-3 pb-3">
            <ColorRow
              label="Star"
              value={starColor}
              presets={STAR_PRESETS}
              onChange={onStarChange}
            />
            <ColorRow
              label="Background"
              value={bgColor}
              presets={BG_PRESETS}
              onChange={onBgChange}
            />
            <button
              type="button"
              onClick={onReset}
              className="w-full rounded-[6px] border px-2 py-1 text-xs text-[var(--ink-soft)] transition hover:bg-[var(--parchment-sunk)] hover:text-[var(--ink)]"
              style={{ borderColor: 'var(--rule)' }}
            >
              Reset to defaults
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ColorRow({
  label,
  value,
  presets,
  onChange,
}: {
  label: string;
  value: string;
  presets: Array<{ id: string; label: string; hex: string }>;
  onChange: (hex: string) => void;
}) {
  const normalized = value.toLowerCase();
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wide text-[var(--ink-muted)]">
          {label}
        </span>
        <label
          className="flex items-center gap-1.5 text-[11px] text-[var(--ink-soft)] cursor-pointer"
          title="Custom colour"
        >
          <span>Custom</span>
          <input
            type="color"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="h-5 w-7 cursor-pointer rounded-[4px] border bg-transparent p-0"
            style={{ borderColor: 'var(--rule)' }}
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => {
          const selected = p.hex.toLowerCase() === normalized;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onChange(p.hex)}
              title={`${p.label} (${p.hex})`}
              aria-label={p.label}
              aria-pressed={selected}
              className="h-6 w-6 rounded-full transition hover:scale-110"
              style={{
                background: p.hex,
                boxShadow: selected
                  ? '0 0 0 2px var(--candlelight)'
                  : '0 0 0 1px var(--rule)',
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

function ColorChip({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="inline-block h-3 w-3 rounded-full"
      style={{ background: color, boxShadow: '0 0 0 1px var(--rule)' }}
    />
  );
}

function Spinner({ accent }: { accent: string }) {
  return (
    <div
      style={{
        width: 28,
        height: 28,
        borderRadius: '50%',
        border: `2px solid ${accent}33`,
        borderTopColor: accent,
        animation: 'g3d-spin 0.9s linear infinite',
      }}
    >
      <style>{`@keyframes g3d-spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}
