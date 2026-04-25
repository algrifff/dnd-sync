'use client';

// 3D star-field rendering of the note graph. Prototype — sits beside the
// 2D Sigma view at /graph-3d. Re-uses the /api/graph endpoint and the
// shared clusterKey() so groupings match the 2D mental model.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Canvas, useThree } from '@react-three/fiber';
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

// One InstancedMesh for all stars. emissive=white; bloom does the glow work.
function Stars({
  placed,
  hoverIdx,
  setHoverIdx,
  candlelight,
  onClickIdx,
}: {
  placed: Placed[];
  hoverIdx: number | null;
  setHoverIdx: (i: number | null) => void;
  candlelight: THREE.Color;
  onClickIdx: (i: number) => void;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const instColor = useMemo(() => new THREE.Color(), []);
  const white = useMemo(() => new THREE.Color('#FFFFFF'), []);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    placed.forEach((p, i) => {
      dummy.position.copy(p.pos);
      dummy.scale.setScalar(p.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      // emissive baked into instance color via MeshBasicMaterial-equivalent;
      // we use MeshStandardMaterial below with emissive=white and modulate
      // via per-instance color (acts as a multiplier on emissive).
      const intensity = 0.85 + Math.min(0.6, p.degree * 0.04);
      instColor.copy(white).multiplyScalar(intensity);
      mesh.setColorAt(i, instColor);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [placed, dummy, instColor, white]);

  // Hover tint: re-write color for hovered idx each frame it changes.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    placed.forEach((p, i) => {
      if (i === hoverIdx) {
        instColor.copy(candlelight).multiplyScalar(1.6);
      } else {
        const intensity = 0.85 + Math.min(0.6, p.degree * 0.04);
        instColor.copy(white).multiplyScalar(intensity);
      }
      mesh.setColorAt(i, instColor);
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [hoverIdx, placed, instColor, white, candlelight]);

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

function ClusterLabels({ clusters, color }: { clusters: Cluster[]; color: string }) {
  return (
    <>
      {clusters.map((c) => (
        <Html key={c.key} position={[c.center.x, c.center.y, c.center.z]} center distanceFactor={28} pointerEvents="none">
          <div
            style={{
              color,
              fontFamily: 'Inter, system-ui, sans-serif',
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              opacity: 0.55,
              whiteSpace: 'nowrap',
            }}
          >
            {c.label}
          </div>
        </Html>
      ))}
    </>
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

function HoverLabel({ placed, idx, color }: { placed: Placed[]; idx: number | null; color: string }) {
  if (idx == null || !placed[idx]) return null;
  const p = placed[idx];
  return (
    <Html position={[p.pos.x, p.pos.y + p.scale + 0.4, p.pos.z]} center pointerEvents="none">
      <div
        style={{
          color,
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: 12,
          fontWeight: 500,
          padding: '2px 6px',
          background: 'rgb(0 0 0 / 0.45)',
          borderRadius: 4,
          whiteSpace: 'nowrap',
        }}
      >
        {p.title}
      </div>
    </Html>
  );
}

type LoadPhase = 'fetching' | 'placing' | 'ready' | 'error';

export function GraphCanvas3D({ groupId }: { groupId: string }): React.ReactElement {
  const router = useRouter();
  const [data, setData] = useState<GraphPayload | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [palette, setPalette] = useState<Palette | null>(null);
  const [phase, setPhase] = useState<LoadPhase>('fetching');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  useEffect(() => {
    setPalette(readPalette());
  }, []);

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

  const { placed, clusters } = useMemo(() => {
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
      style={{ background: `#${palette.background.getHexString()}`, minHeight: 0, minWidth: 0 }}
    >
      <Canvas
        camera={{ position: [0, 0, 60], fov: 55, near: 0.1, far: 2000 }}
        dpr={[1, 2]}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      >
        <color attach="background" args={[`#${palette.background.getHexString()}`]} />
        <fog attach="fog" args={[`#${palette.background.getHexString()}`, 60, 320]} />
        <ambientLight intensity={0.25} />

        {placed.length > 0 && (
          <>
            <CameraFitter placed={placed} />
            <Stars
              placed={placed}
              hoverIdx={hoverIdx}
              setHoverIdx={setHoverIdx}
              candlelight={palette.candlelight}
              onClickIdx={onClickIdx}
            />
            <Edges placed={placed} edges={data?.edges ?? []} color={palette.edge} />
            <ClusterLabels clusters={clusters} color={palette.inkSoft} />
            <HoverLabel placed={placed} idx={hoverIdx} color="#FFFFFF" />
          </>
        )}

        <OrbitControls enablePan enableZoom enableRotate enableDamping dampingFactor={0.08} />

        <EffectComposer>
          <Bloom luminanceThreshold={0.2} luminanceSmoothing={0.3} intensity={1.6} mipmapBlur />
        </EffectComposer>
      </Canvas>

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
