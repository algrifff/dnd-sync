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
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { clusterKey, radiusForDegree } from './graphStyle';
import { GroupEditor, buildCollabUrl, type Group } from './GraphCanvas';

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
// Per-frame scratch — declared once at module scope so the Stars hot loop
// doesn't allocate. Avoids GC pressure for ~hundreds of stars × 60fps.
const SCRATCH_NDC = new THREE.Vector3();
const SCRATCH_MOUSE_WORLD = new THREE.Vector3();

// Magnetic pull radius in NDC (screen) units. Cursor must be within this
// proximity in screen-space for a star to feel the tug. The same radius
// also drives a colour ramp toward candlelight — closer = warmer.
const MAGNET_RADIUS_NDC = 0.25;
// Maximum fractional pull toward the cursor at the very centre. Stars
// only travel up to MAGNET_STRENGTH × (cursor-world − star-world).
const MAGNET_STRENGTH = 0.18;
// Two travelling wave fields. Each star samples both waves at its own
// world position so neighbours move coherently (a wave passing over them)
// but distant stars are unrelated. Direction shape is fixed; amplitude /
// spatial-frequency / temporal-speed are runtime controls so the user
// can tune the motion live.
//
// (kx, ky, kz) is the wave-vector direction; multiplying by the user's
// frequency value scales how short the wavelength is. omega is the base
// temporal frequency, scaled by the user's speed value.
const WAVE_A_DIR = { kx: 0.045, ky: 0.0, kz: 0.025, omega: 0.45 };
const WAVE_B_DIR = { kx: 0.0, ky: 0.05, kz: 0.035, omega: 0.62 };

const DEFAULT_WAVE_AMP = 0.6;
const DEFAULT_WAVE_FREQ = 1.0;
const DEFAULT_WAVE_SPEED = 1.0;
const MOTION_STORAGE_KEY = 'graph3d:motion';
const GROUPS_APPLY_KEY = 'graph3d:groupsApply';
const HOVER_LABELS_KEY = 'graph3d:hoverLabels';

function Stars({
  placed,
  hoverIdx,
  setHoverIdx,
  candlelight,
  baseColors,
  onClickIdx,
  offsetsRef,
  proxRef,
  waveAmpRef,
  waveFreqRef,
  waveSpeedRef,
}: {
  placed: Placed[];
  hoverIdx: number | null;
  setHoverIdx: (i: number | null) => void;
  candlelight: THREE.Color;
  // Per-instance base colour. Lets group overrides slot in on top of
  // the global starColor without touching this component's logic.
  baseColors: THREE.Color[];
  onClickIdx: (i: number) => void;
  // Per-star magnet/proximity buffers — owned by the parent so labels
  // can read the same lerped values. Stars writes them every frame.
  offsetsRef: React.RefObject<Float32Array>;
  proxRef: React.RefObject<Float32Array>;
  waveAmpRef: React.RefObject<number>;
  waveFreqRef: React.RefObject<number>;
  waveSpeedRef: React.RefObject<number>;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const instColor = useMemo(() => new THREE.Color(), []);
  const fallbackColor = useMemo(() => new THREE.Color('#FFFFFF'), []);
  // Stars currently rendering with a non-zero proximity tint. Diff-set
  // so a star whose tint just decayed past the threshold gets one
  // final repaint back to base.
  const paintedSet = useRef<Set<number>>(new Set());

  useEffect(() => {
    paintedSet.current = new Set();
  }, [placed.length]);

  useFrame((state) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const { camera, pointer, clock } = state;
    const t = clock.getElapsedTime();
    const offsets = offsetsRef.current;
    const prox = proxRef.current;
    if (!offsets || !prox) return;
    if (offsets.length !== placed.length * 3 || prox.length !== placed.length) return;
    const waveAmp = waveAmpRef.current ?? DEFAULT_WAVE_AMP;
    const waveFreq = waveFreqRef.current ?? DEFAULT_WAVE_FREQ;
    const waveSpeed = waveSpeedRef.current ?? DEFAULT_WAVE_SPEED;

    // Ease factor for the offset/proximity lerps. Lower = slower, smoother
    // settle. 0.12 reads as "magnetic" without overshoot.
    const EASE = 0.12;
    // Snap-to-zero threshold so we eventually reach exactly 0 and can
    // mark a star "done painting" instead of approaching forever.
    const EPS = 0.002;

    const newPainted = new Set<number>();
    let colorsDirty = false;

    for (let i = 0; i < placed.length; i++) {
      const p = placed[i];
      if (!p) continue;

      // Compute target offset/proximity for this frame.
      // Hovered star: target proximity = 1 (full candlelight), no
      //   position pull (so it doesn't slide under the cursor).
      // Unhovered, in-radius: proximity by screen distance; pull by k².
      // Else: target = 0 (decays back).
      let targetX = 0, targetY = 0, targetZ = 0;
      let targetProx = 0;
      if (i === hoverIdx) {
        targetProx = 1;
      } else {
        SCRATCH_NDC.copy(p.pos).project(camera);
        if (SCRATCH_NDC.z < 1) {
          const dx = pointer.x - SCRATCH_NDC.x;
          const dy = pointer.y - SCRATCH_NDC.y;
          const screenDist = Math.sqrt(dx * dx + dy * dy);
          if (screenDist < MAGNET_RADIUS_NDC) {
            const k = 1 - screenDist / MAGNET_RADIUS_NDC;
            const strength = k * k * MAGNET_STRENGTH;
            SCRATCH_MOUSE_WORLD.set(pointer.x, pointer.y, SCRATCH_NDC.z).unproject(camera);
            targetX = (SCRATCH_MOUSE_WORLD.x - p.pos.x) * strength;
            targetY = (SCRATCH_MOUSE_WORLD.y - p.pos.y) * strength;
            targetZ = (SCRATCH_MOUSE_WORLD.z - p.pos.z) * strength;
            targetProx = k;
          }
        }
      }

      // Ease current offset/proximity toward target. When the cursor
      // moves away (or onto a label), target → 0 and the star drifts
      // back over a few frames instead of snapping. This is the popping
      // fix.
      const i3 = i * 3;
      let cx = offsets[i3] ?? 0;
      let cy = offsets[i3 + 1] ?? 0;
      let cz = offsets[i3 + 2] ?? 0;
      cx += (targetX - cx) * EASE;
      cy += (targetY - cy) * EASE;
      cz += (targetZ - cz) * EASE;
      if (Math.abs(cx) < EPS) cx = 0;
      if (Math.abs(cy) < EPS) cy = 0;
      if (Math.abs(cz) < EPS) cz = 0;
      offsets[i3] = cx;
      offsets[i3 + 1] = cy;
      offsets[i3 + 2] = cz;

      let cp = prox[i] ?? 0;
      cp += (targetProx - cp) * EASE;
      if (cp < EPS) cp = 0;
      prox[i] = cp;

      // Two travelling waves sampled at the star's world position.
      // freq scales the spatial wavevector (shorter wavelength = more
      // ripples visible across the field). speed scales omega.
      const phaseA =
        (WAVE_A_DIR.kx * p.pos.x + WAVE_A_DIR.ky * p.pos.y + WAVE_A_DIR.kz * p.pos.z) * waveFreq -
        WAVE_A_DIR.omega * waveSpeed * t;
      const phaseB =
        (WAVE_B_DIR.kx * p.pos.x + WAVE_B_DIR.ky * p.pos.y + WAVE_B_DIR.kz * p.pos.z) * waveFreq -
        WAVE_B_DIR.omega * waveSpeed * t;
      const wA = Math.sin(phaseA);
      const wB = Math.sin(phaseB);
      const driftX = (wA + wB * 0.4) * waveAmp;
      const driftY = (wB - wA * 0.5) * waveAmp;
      const driftZ = (wA * 0.6 + wB * 0.7) * waveAmp;

      dummy.position.set(
        p.pos.x + cx + driftX,
        p.pos.y + cy + driftY,
        p.pos.z + cz + driftZ,
      );
      dummy.scale.setScalar(p.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      // Colour write — paint while the eased proximity is non-zero.
      // Covers both the magnet ramp AND hover (target=1 for hover), so
      // hover-in/out lerps as smoothly as the magnet does.
      if (cp > 0) {
        newPainted.add(i);
        const intensity = 0.85 + Math.min(0.6, p.degree * 0.04);
        instColor.copy(baseColors[i] ?? fallbackColor).multiplyScalar(intensity);
        instColor.lerp(candlelight, cp);
        // At cp=1 the multiplier reaches 1.6, matching the previous
        // hard-coded hover treatment for bloom intensity.
        instColor.multiplyScalar(1 + cp * 0.6);
        mesh.setColorAt(i, instColor);
        colorsDirty = true;
      }
    }
    mesh.instanceMatrix.needsUpdate = true;

    // Final repaint to base for stars whose tint just decayed below EPS
    // this frame. Without this they'd be stuck on the last lerped colour.
    for (const idx of paintedSet.current) {
      if (newPainted.has(idx)) continue;
      const p = placed[idx];
      if (!p) continue;
      const intensity = 0.85 + Math.min(0.6, p.degree * 0.04);
      instColor.copy(baseColors[idx] ?? fallbackColor).multiplyScalar(intensity);
      mesh.setColorAt(idx, instColor);
      colorsDirty = true;
    }
    paintedSet.current = newPainted;

    if (colorsDirty && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  // Initial / on-change colour paint — re-runs whenever the per-instance
  // base colours change (group toggle, group edits, global star colour).
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    placed.forEach((p, i) => {
      const intensity = 0.85 + Math.min(0.6, p.degree * 0.04);
      instColor.copy(baseColors[i] ?? fallbackColor).multiplyScalar(intensity);
      mesh.setColorAt(i, instColor);
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [placed, instColor, baseColors, fallbackColor]);

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
          className="g3d-label-wrap"
        >
          <div
            className="g3d-label"
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
  visDistRef,
  proxRef,
  hoverLabelsRef,
}: {
  placed: Placed[];
  visDistRef: React.RefObject<number>;
  proxRef: React.RefObject<Float32Array>;
  hoverLabelsRef: React.RefObject<boolean>;
}) {
  return (
    <>
      {placed.map((p, i) => (
        <NodeLabel
          key={p.id}
          idx={i}
          p={p}
          visDistRef={visDistRef}
          proxRef={proxRef}
          hoverLabelsRef={hoverLabelsRef}
        />
      ))}
    </>
  );
}

function NodeLabel({
  p,
  idx,
  visDistRef,
  proxRef,
  hoverLabelsRef,
}: {
  p: Placed;
  idx: number;
  visDistRef: React.RefObject<number>;
  proxRef: React.RefObject<Float32Array>;
  hoverLabelsRef: React.RefObject<boolean>;
}) {
  // We mutate the inner div's opacity directly via ref so the per-frame
  // lerp doesn't trigger React re-renders. The visibility distance comes
  // from a ref so the panel can change it without re-mounting every label.
  const divRef = useRef<HTMLDivElement>(null);
  const cur = useRef(0);
  useFrame((state) => {
    const el = divRef.current;
    if (!el) return;
    const dist = state.camera.position.distanceTo(p.pos);
    const vis = visDistRef.current ?? DEFAULT_LABEL_VIS;
    // smoothstep(edge0, edge1, x) → 0..1 ramp; we invert so labels are
    // 1 inside `vis` and ramp down to 0 over a fixed feather window.
    const distFade =
      1 - THREE.MathUtils.smoothstep(dist, vis - LABEL_FEATHER, vis + LABEL_FEATHER);
    // Proximity (cursor near star, including hover) — already lerped in
    // Stars, so reading it here piggy-backs on the same easing curve.
    // Hover ends up here because Stars sets targetProx=1 for hoverIdx.
    // The user can disable the proximity-driven label fade-in via the
    // panel toggle, leaving only the distance-fade behaviour and the
    // glow ramp on the sphere itself.
    //
    // Labels respond to a much tighter window than the glow: smoothstep
    // remaps prox so anything below LABEL_PROX_THRESHOLD reads as 0,
    // and only the inner ~25% of the magnet radius lights up a title.
    // Hovering a star still gives prox=1, which clamps to 1 after the
    // remap, so direct hover always shows the label.
    const proxArr = proxRef.current;
    const proxRaw = (hoverLabelsRef.current ?? true) && proxArr ? (proxArr[idx] ?? 0) : 0;
    const prox = THREE.MathUtils.smoothstep(proxRaw, LABEL_PROX_THRESHOLD, 1);
    const target = Math.max(distFade, prox);
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
      className="g3d-label-wrap"
    >
      <div
        ref={divRef}
        className="g3d-label"
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
const LABEL_STORAGE_KEY = 'graph3d:labels';

// Single-knob fade — labels are fully opaque inside `visDist`, transparent
// outside, with a fixed soft feather so the transition smooths instead of
// snapping. Empirically 60 with a 15-unit feather frames a single cluster
// nicely without flooding the view at galaxy distance.
const DEFAULT_LABEL_VIS = 60;
const LABEL_FEATHER = 15;
// Hover labels only show when the magnet proximity is above this
// threshold — i.e. the cursor is in the inner ~25% of the magnet radius.
// Without it the glow's wider catchment lit up a swarm of titles every
// time the cursor moved.
const LABEL_PROX_THRESHOLD = 0.75;

export function GraphCanvas3D({ groupId }: { groupId: string }): React.ReactElement {
  const router = useRouter();
  const [data, setData] = useState<GraphPayload | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [palette, setPalette] = useState<Palette | null>(null);
  const [phase, setPhase] = useState<LoadPhase>('fetching');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [starColor, setStarColor] = useState<string>('#FFFFFF');
  const [bgColor, setBgColor] = useState<string>('#0A0806');
  const [labelVis, setLabelVis] = useState<number>(DEFAULT_LABEL_VIS);
  const [hoverLabels, setHoverLabels] = useState<boolean>(true);
  const [waveAmp, setWaveAmp] = useState<number>(DEFAULT_WAVE_AMP);
  const [waveFreq, setWaveFreq] = useState<number>(DEFAULT_WAVE_FREQ);
  const [waveSpeed, setWaveSpeed] = useState<number>(DEFAULT_WAVE_SPEED);
  // Mirror tunables into refs so the per-frame inner loops read live
  // values without each setState re-rendering Stars / NodeLabels.
  const visDistRef = useRef<number>(DEFAULT_LABEL_VIS);
  // Mirror the hover-labels toggle into a ref so the per-frame label
  // opacity loop reads the live value without re-rendering each label.
  const hoverLabelsRef = useRef<boolean>(true);
  useEffect(() => { hoverLabelsRef.current = hoverLabels; }, [hoverLabels]);
  const waveAmpRef = useRef<number>(DEFAULT_WAVE_AMP);
  const waveFreqRef = useRef<number>(DEFAULT_WAVE_FREQ);
  const waveSpeedRef = useRef<number>(DEFAULT_WAVE_SPEED);
  useEffect(() => { visDistRef.current = labelVis; }, [labelVis]);
  useEffect(() => { waveAmpRef.current = waveAmp; }, [waveAmp]);
  useEffect(() => { waveFreqRef.current = waveFreq; }, [waveFreq]);
  useEffect(() => { waveSpeedRef.current = waveSpeed; }, [waveSpeed]);

  // Per-star magnet/proximity buffers, owned here so both Stars and
  // NodeLabels read the same lerped values. Resized below once `placed`
  // is computed.
  const offsetsRef = useRef<Float32Array>(new Float32Array(0));
  const proxRef = useRef<Float32Array>(new Float32Array(0));

  // ── Groups (shared with the 2D view via Yjs) ──────────────────────
  // Same doc name as GraphCanvas.tsx (`graph-groups:<groupId>`) so any
  // edit here propagates to the 2D view and to peers, and vice-versa.
  const groupsYdoc = useMemo(() => new Y.Doc(), [groupId]);
  const groupsProvider = useMemo(
    () =>
      new HocuspocusProvider({
        url: buildCollabUrl(),
        name: `graph-groups:${groupId}`,
        document: groupsYdoc,
      }),
    [groupsYdoc, groupId],
  );
  const groupsMap = useMemo(() => groupsYdoc.getMap<Group>('groups'), [groupsYdoc]);
  useEffect(() => {
    return () => {
      groupsProvider.destroy();
      groupsYdoc.destroy();
    };
  }, [groupsProvider, groupsYdoc]);

  const [groupsState, setGroupsState] = useState<Group[]>([]);
  useEffect(() => {
    const apply = (): void => {
      const arr: Group[] = [];
      groupsMap.forEach((value) => {
        if (value && typeof value === 'object') arr.push(value);
      });
      setGroupsState(arr);
    };
    apply();
    groupsMap.observe(apply);
    return () => groupsMap.unobserve(apply);
  }, [groupsMap]);

  const [groupsApply, setGroupsApply] = useState<boolean>(false);

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
      try {
        const raw = window.localStorage.getItem(LABEL_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as { vis?: number };
          if (typeof parsed.vis === 'number') setLabelVis(parsed.vis);
        }
      } catch {
        /* ignore */
      }
      try {
        const raw = window.localStorage.getItem(HOVER_LABELS_KEY);
        if (raw === '0') setHoverLabels(false);
      } catch {
        /* ignore */
      }
      try {
        const raw = window.localStorage.getItem(MOTION_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as { amp?: number; freq?: number; speed?: number };
          if (typeof parsed.amp === 'number') setWaveAmp(parsed.amp);
          if (typeof parsed.freq === 'number') setWaveFreq(parsed.freq);
          if (typeof parsed.speed === 'number') setWaveSpeed(parsed.speed);
        }
      } catch {
        /* ignore */
      }
      try {
        const raw = window.localStorage.getItem(GROUPS_APPLY_KEY);
        if (raw === '1') setGroupsApply(true);
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
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(
        LABEL_STORAGE_KEY,
        JSON.stringify({ vis: labelVis }),
      );
    } catch {
      /* ignore */
    }
  }, [labelVis]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(HOVER_LABELS_KEY, hoverLabels ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [hoverLabels]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(
        MOTION_STORAGE_KEY,
        JSON.stringify({ amp: waveAmp, freq: waveFreq, speed: waveSpeed }),
      );
    } catch {
      /* ignore */
    }
  }, [waveAmp, waveFreq, waveSpeed]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(GROUPS_APPLY_KEY, groupsApply ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [groupsApply]);

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
    offsetsRef.current = new Float32Array(placed.length * 3);
    proxRef.current = new Float32Array(placed.length);
  }, [placed.length]);

  // Tags currently in use across all nodes — fed into GroupEditor's
  // tag-picker dropdown.
  const paletteTags = useMemo(() => {
    const set = new Set<string>();
    if (data) {
      for (const n of data.nodes) {
        for (const t of n.tags ?? []) set.add(t.toLowerCase());
      }
    }
    return [...set].sort();
  }, [data]);

  // Per-node-id → group lookup (only when groupsApply is on). A node's
  // group is the first group whose `notes` includes it OR whose `tags`
  // overlap any of the node's tags. Mirrors the 2D resolution order.
  const nodeGroupMap = useMemo(() => {
    const m = new Map<string, Group>();
    if (!groupsApply || !data) return m;
    for (const g of groupsState) {
      const tagSet = new Set(g.tags.map((t) => t.toLowerCase()));
      for (const path of g.notes) if (!m.has(path)) m.set(path, g);
      for (const n of data.nodes) {
        if (m.has(n.id)) continue;
        if (n.tags?.some((t) => tagSet.has(t.toLowerCase()))) m.set(n.id, g);
      }
    }
    return m;
  }, [data, groupsState, groupsApply]);

  // Per-instance base colour. Default = global star colour; group
  // override applies when one matches and the toggle is on.
  const baseColors = useMemo(() => {
    return placed.map((p) => {
      const g = nodeGroupMap.get(p.id);
      return new THREE.Color(g ? g.color : starColor);
    });
  }, [placed, nodeGroupMap, starColor]);

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
      {/* Lock the entire <Html> label subtree out of the pointer event
          path. drei's <Html pointerEvents="none"> only sets the
          outermost wrapper; an internal transform layer keeps default
          'auto' which was absorbing clicks meant for the spheres
          underneath. The subtree selector with !important nukes that
          completely so cursor and clicks pass through to the canvas. */}
      <style>{`.g3d-label-wrap, .g3d-label-wrap *, .g3d-label, .g3d-label * { pointer-events: none !important; user-select: none !important; }`}</style>
      <Canvas
        camera={{ position: [0, 0, 60], fov: 55, near: 0.1, far: 2000 }}
        dpr={[1, 2]}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      >
        <color attach="background" args={[bgColor]} />
        {/* No <fog>. Fog distances are world-space, so as the camera
            zooms out every star drifts toward the fog colour and the
            view appears to grow heavier. The bloom + emissive stars
            already give enough depth without it. */}
        <ambientLight intensity={0.25} />

        {placed.length > 0 && (
          <>
            <CameraFitter placed={placed} />
            <Stars
              placed={placed}
              hoverIdx={hoverIdx}
              setHoverIdx={setHoverIdx}
              candlelight={palette.candlelight}
              baseColors={baseColors}
              onClickIdx={onClickIdx}
              offsetsRef={offsetsRef}
              proxRef={proxRef}
              waveAmpRef={waveAmpRef}
              waveFreqRef={waveFreqRef}
              waveSpeedRef={waveSpeedRef}
            />
            <Edges placed={placed} edges={data?.edges ?? []} color={palette.edge} />
            <NodeLabels
              placed={placed}
              visDistRef={visDistRef}
              proxRef={proxRef}
              hoverLabelsRef={hoverLabelsRef}
            />
            <CampaignLabels placed={placed} />
          </>
        )}

        <OrbitControls enablePan enableZoom enableRotate enableDamping dampingFactor={0.08} />

        <EffectComposer>
          <Bloom luminanceThreshold={0.2} luminanceSmoothing={0.3} intensity={1.6} mipmapBlur />
        </EffectComposer>
      </Canvas>

      <PanelStack
        starColor={starColor}
        bgColor={bgColor}
        onStarChange={setStarColor}
        onBgChange={setBgColor}
        onColorReset={() => {
          setStarColor('#FFFFFF');
          setBgColor('#0A0806');
        }}
        labelVis={labelVis}
        onLabelVisChange={setLabelVis}
        hoverLabels={hoverLabels}
        onHoverLabelsChange={setHoverLabels}
        onLabelReset={() => setLabelVis(DEFAULT_LABEL_VIS)}
        waveAmp={waveAmp}
        waveFreq={waveFreq}
        waveSpeed={waveSpeed}
        onWaveAmpChange={setWaveAmp}
        onWaveFreqChange={setWaveFreq}
        onWaveSpeedChange={setWaveSpeed}
        onMotionReset={() => {
          setWaveAmp(DEFAULT_WAVE_AMP);
          setWaveFreq(DEFAULT_WAVE_FREQ);
          setWaveSpeed(DEFAULT_WAVE_SPEED);
        }}
        groups={groupsState}
        groupsApply={groupsApply}
        onGroupsApplyChange={setGroupsApply}
        onGroupCreate={() => {
          const id =
            typeof crypto !== 'undefined' && 'randomUUID' in crypto
              ? crypto.randomUUID()
              : `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
          const palette = ['#D4A85A', '#7B8A5F', '#8B4A52', '#6B7F8E', '#B5572A', '#6A5D8B'];
          const color = palette[groupsState.length % palette.length] ?? '#D4A85A';
          const g: Group = {
            id,
            name: `Group ${groupsState.length + 1}`,
            color,
            tags: [],
            notes: [],
          };
          groupsMap.set(id, g);
        }}
        onGroupUpdate={(g) => groupsMap.set(g.id, g)}
        onGroupDelete={(id) => groupsMap.delete(id)}
        paletteTags={paletteTags}
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

// Master show/hide for the right-edge panels. Persists alongside the
// individual panel state under the same key so it round-trips with the
// page. Collapsed state shows only a tiny pill so the canvas reads clean.
const PANELS_OPEN_KEY = 'graph3d:panelsOpen';

function PanelStack({
  starColor,
  bgColor,
  onStarChange,
  onBgChange,
  onColorReset,
  labelVis,
  onLabelVisChange,
  hoverLabels,
  onHoverLabelsChange,
  onLabelReset,
  waveAmp,
  waveFreq,
  waveSpeed,
  onWaveAmpChange,
  onWaveFreqChange,
  onWaveSpeedChange,
  onMotionReset,
  groups,
  groupsApply,
  onGroupsApplyChange,
  onGroupCreate,
  onGroupUpdate,
  onGroupDelete,
  paletteTags,
}: {
  starColor: string;
  bgColor: string;
  onStarChange: (hex: string) => void;
  onBgChange: (hex: string) => void;
  onColorReset: () => void;
  labelVis: number;
  onLabelVisChange: (v: number) => void;
  hoverLabels: boolean;
  onHoverLabelsChange: (v: boolean) => void;
  onLabelReset: () => void;
  waveAmp: number;
  waveFreq: number;
  waveSpeed: number;
  onWaveAmpChange: (v: number) => void;
  onWaveFreqChange: (v: number) => void;
  onWaveSpeedChange: (v: number) => void;
  onMotionReset: () => void;
  groups: Group[];
  groupsApply: boolean;
  onGroupsApplyChange: (v: boolean) => void;
  onGroupCreate: () => void;
  onGroupUpdate: (g: Group) => void;
  onGroupDelete: (id: string) => void;
  paletteTags: string[];
}) {
  const [open, setOpen] = useState<boolean>(true);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(PANELS_OPEN_KEY);
      if (raw === '0') setOpen(false);
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(PANELS_OPEN_KEY, open ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [open]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Show controls"
        aria-label="Show controls"
        className="absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-full border bg-[var(--vellum)] text-[var(--ink-soft)] shadow-[0_6px_18px_rgb(var(--ink-rgb)/0.10)] transition hover:bg-[var(--parchment-sunk)] hover:text-[var(--ink)]"
        style={{ borderColor: 'var(--rule)', pointerEvents: 'auto' }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <line x1="4" y1="6" x2="20" y2="6" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="18" x2="20" y2="18" />
          <circle cx="9" cy="6" r="1.5" fill="currentColor" />
          <circle cx="15" cy="12" r="1.5" fill="currentColor" />
          <circle cx="7" cy="18" r="1.5" fill="currentColor" />
        </svg>
      </button>
    );
  }

  return (
    <div
      className="absolute right-3 top-3 z-10 flex flex-col gap-2"
      style={{ pointerEvents: 'auto' }}
    >
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setOpen(false)}
          title="Hide controls"
          aria-label="Hide controls"
          className="flex h-6 w-6 items-center justify-center rounded-full border bg-[var(--vellum)] text-[var(--ink-soft)] shadow-[0_3px_10px_rgb(var(--ink-rgb)/0.08)] transition hover:bg-[var(--parchment-sunk)] hover:text-[var(--ink)]"
          style={{ borderColor: 'var(--rule)' }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>
      </div>
      <ColorPanel
        starColor={starColor}
        bgColor={bgColor}
        onStarChange={onStarChange}
        onBgChange={onBgChange}
        onReset={onColorReset}
      />
      <LabelPanel
        visDist={labelVis}
        onVisDistChange={onLabelVisChange}
        hoverLabels={hoverLabels}
        onHoverLabelsChange={onHoverLabelsChange}
        onReset={onLabelReset}
      />
      <MotionPanel
        amp={waveAmp}
        freq={waveFreq}
        speed={waveSpeed}
        onAmpChange={onWaveAmpChange}
        onFreqChange={onWaveFreqChange}
        onSpeedChange={onWaveSpeedChange}
        onReset={onMotionReset}
      />
      <GroupsPanel
        groups={groups}
        apply={groupsApply}
        onApplyChange={onGroupsApplyChange}
        onCreate={onGroupCreate}
        onUpdate={onGroupUpdate}
        onDelete={onGroupDelete}
        paletteTags={paletteTags}
      />
    </div>
  );
}

function GroupsPanel({
  groups,
  apply,
  onApplyChange,
  onCreate,
  onUpdate,
  onDelete,
  paletteTags,
}: {
  groups: Group[];
  apply: boolean;
  onApplyChange: (v: boolean) => void;
  onCreate: () => void;
  onUpdate: (g: Group) => void;
  onDelete: (id: string) => void;
  paletteTags: string[];
}) {
  const [open, setOpen] = useState<boolean>(false);
  return (
    <div
      className="rounded-[10px] border bg-[var(--vellum)] text-[var(--ink)] shadow-[0_6px_18px_rgb(var(--ink-rgb)/0.10)]"
      style={{ borderColor: 'var(--rule)', width: 240 }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
        aria-expanded={open}
        aria-label="Toggle groups panel"
      >
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
          Groups
        </span>
        <span aria-hidden className="flex items-center gap-1.5 text-[11px] text-[var(--ink-muted)]">
          <span>{groups.length}</span>
          <span>{open ? '▾' : '▸'}</span>
        </span>
      </button>
      {open && (
        <div className="space-y-2 px-3 pb-3">
          <label className="flex items-center justify-between gap-2 text-[11px] text-[var(--ink-soft)]">
            <span className="uppercase tracking-wide text-[var(--ink-muted)]">
              Apply group colours
            </span>
            <input
              type="checkbox"
              checked={apply}
              onChange={(e) => onApplyChange(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--candlelight)]"
            />
          </label>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-[var(--ink-muted)]">
              Synced with the 2D view.
            </span>
            <button
              type="button"
              onClick={onCreate}
              className="shrink-0 rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] px-2 py-0.5 text-xs text-[var(--ink-soft)] transition hover:bg-[var(--parchment-sunk)] hover:text-[var(--ink)]"
            >
              + New
            </button>
          </div>
          {groups.length === 0 ? (
            <div className="text-xs text-[var(--ink-muted)]">No groups yet.</div>
          ) : (
            <ul className="max-h-72 space-y-2 overflow-y-auto">
              {groups.map((g) => (
                <GroupEditor
                  key={g.id}
                  group={g}
                  paletteTags={paletteTags}
                  onUpdate={(next) => onUpdate(next)}
                  onDelete={() => onDelete(g.id)}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function MotionPanel({
  amp,
  freq,
  speed,
  onAmpChange,
  onFreqChange,
  onSpeedChange,
  onReset,
}: {
  amp: number;
  freq: number;
  speed: number;
  onAmpChange: (v: number) => void;
  onFreqChange: (v: number) => void;
  onSpeedChange: (v: number) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState<boolean>(false);
  return (
    <div
      className="rounded-[10px] border bg-[var(--vellum)] text-[var(--ink)] shadow-[0_6px_18px_rgb(var(--ink-rgb)/0.10)]"
      style={{ borderColor: 'var(--rule)', width: 200 }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
        aria-expanded={open}
        aria-label="Toggle motion panel"
      >
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
          Motion
        </span>
        <span aria-hidden className="text-[var(--ink-muted)]">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="space-y-2 px-3 pb-3">
          <FloatSliderRow
            label="Amplitude"
            value={amp}
            min={0}
            max={4}
            step={0.05}
            onChange={onAmpChange}
          />
          <FloatSliderRow
            label="Frequency"
            value={freq}
            min={0}
            max={4}
            step={0.05}
            onChange={onFreqChange}
          />
          <FloatSliderRow
            label="Speed"
            value={speed}
            min={0}
            max={4}
            step={0.05}
            onChange={onSpeedChange}
          />
          <button
            type="button"
            onClick={onReset}
            className="w-full rounded-[6px] border px-2 py-1 text-xs text-[var(--ink-soft)] transition hover:bg-[var(--parchment-sunk)] hover:text-[var(--ink)]"
            style={{ borderColor: 'var(--rule)' }}
          >
            Reset
          </button>
        </div>
      )}
    </div>
  );
}

function FloatSliderRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-[11px] text-[var(--ink-soft)]">
      <div className="flex items-center justify-between">
        <span className="uppercase tracking-wide text-[var(--ink-muted)]">{label}</span>
        <span className="tabular-nums text-[var(--ink-soft)]">{value.toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[var(--candlelight)]"
      />
    </label>
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
      className="rounded-[10px] border bg-[var(--vellum)] text-[var(--ink)] shadow-[0_6px_18px_rgb(var(--ink-rgb)/0.10)]"
      style={{ borderColor: 'var(--rule)', width: 200 }}
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
  );
}

function LabelPanel({
  visDist,
  onVisDistChange,
  hoverLabels,
  onHoverLabelsChange,
  onReset,
}: {
  visDist: number;
  onVisDistChange: (v: number) => void;
  hoverLabels: boolean;
  onHoverLabelsChange: (v: boolean) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState<boolean>(false);
  // 0..300 covers typical camera framing for a small world to a large
  // galaxy. The fixed feather (LABEL_FEATHER) gives a consistent ease so
  // the user only ever has to think about "how far do I want to see".
  const MIN = 0;
  const MAX = 300;
  return (
    <div
      className="rounded-[10px] border bg-[var(--vellum)] text-[var(--ink)] shadow-[0_6px_18px_rgb(var(--ink-rgb)/0.10)]"
      style={{ borderColor: 'var(--rule)', width: 200 }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
        aria-expanded={open}
        aria-label="Toggle label panel"
      >
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
          Label range
        </span>
        <span aria-hidden className="flex items-center gap-1.5 text-[11px] text-[var(--ink-muted)]">
          <span>{Math.round(visDist)}</span>
          <span>{open ? '▾' : '▸'}</span>
        </span>
      </button>
      {open && (
        <div className="space-y-2 px-3 pb-3">
          <SliderRow
            label="Show within"
            value={visDist}
            min={MIN}
            max={MAX}
            onChange={onVisDistChange}
          />
          <label className="flex items-center justify-between gap-2 text-[11px] text-[var(--ink-soft)]">
            <span className="uppercase tracking-wide text-[var(--ink-muted)]">
              Hover labels
            </span>
            <input
              type="checkbox"
              checked={hoverLabels}
              onChange={(e) => onHoverLabelsChange(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--candlelight)]"
            />
          </label>
          <button
            type="button"
            onClick={onReset}
            className="w-full rounded-[6px] border px-2 py-1 text-xs text-[var(--ink-soft)] transition hover:bg-[var(--parchment-sunk)] hover:text-[var(--ink)]"
            style={{ borderColor: 'var(--rule)' }}
          >
            Reset
          </button>
        </div>
      )}
    </div>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-[11px] text-[var(--ink-soft)]">
      <div className="flex items-center justify-between">
        <span className="uppercase tracking-wide text-[var(--ink-muted)]">{label}</span>
        <span className="tabular-nums text-[var(--ink-soft)]">{Math.round(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[var(--candlelight)]"
      />
    </label>
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
