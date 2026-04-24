'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';

// useLayoutEffect on the client, useEffect on the server — avoids the
// "useLayoutEffect does nothing on the server" warning while still running
// synchronously before paint in the browser.
const useIsoLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect;
import Link from 'next/link';

// --- Types ---
type Footprint = { x: number; y: number; angle: number; born: number; flip: number };
type Ember = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  born: number;
  life: number;
  history: Array<[number, number]>;
  seed: number;
};

// --- Constants ---
// Fixed coordinate space for the collage. All image % positions are
// relative to this canvas; a single scale() keeps the whole composition
// uniform as the viewport changes.
const CANVAS_W = 1000;

const FOOT_LIFETIME = 3500;
const STRIDE_PX = 40;
const FOOT_OFFSET_PX = 6;
const FOOT_W = 10; // display width px
const FOOT_H = FOOT_W * (121 / 46); // maintain aspect ratio ~26px tall

// Collage layout for the left half. Positions + widths are percentages of
// the 50vw × 100vh container; the composition mirrors the reference
// illustration (Main-Image centred, parchment frames pinned around it).
// `shadow: true` gets a heavier drop-shadow (frontal pieces); smaller
// "pinned" frames get a lighter one.
const COLLAGE: Array<{
  src: string;
  left: string;
  top: string;
  width: string;
  shadow?: boolean;
}> = [
  // Central hydra pit — the anchor of the composition.
  { src: '/landing/Main-Image.png', left: '10%', top: '-10%', width: '100%', shadow: true },
  // Top-left: purple arcane explosion with demons.
  { src: '/landing/Image-comet.png', left: '1%', top: '-20%', width: '47%' },
  // Top-middle.
  { src: '/landing/Image-claye.png', left: '40%', top: '-18%', width: '25%' },
  // Top-right: hooded figure over a burning city.
  { src: '/landing/Image-ignys.png', left: '80%', top: '-23%', width: '51%' },
  // Mid-left: two armoured figures embracing.
  { src: '/landing/Image-lumen.png', left: '-2%', top: '11%', width: '27%' },
  // Mid-right small frame: two bearded dwarves.
  { src: '/landing/Image-John-Jason.png', left: '81%', top: '12%', width: '20%' },
  // Right: young figure with green glowing hand.
  { src: '/landing/Image-erianor.png', left: '88%', top: '36%', width: '30%' },
  // Mid-left small: wide red desert scroll.
  { src: '/landing/Image-ket.png', left: '0%', top: '68%', width: '30%' },
  // Bottom-left: armoured figure at a crystal pool.
  { src: '/landing/Image-zordaar.png', left: '-4%', top: '80%', width: '42%' },
  // Bottom-centre tiny: seated cross-legged figure.
  { src: '/landing/Image-oda.png', left: '30%', top: '84%', width: '26%' },
  // Bottom-right: King Duke scroll with crowned orc.
  { src: '/landing/Image-duke.png', left: '74%', top: '70%', width: '48%', shadow: true },
];

export function LandingClient(): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // null during SSR + first paint; set by the layout-effect below using the
  // real viewport width. We don't render the collage until scale is known,
  // so there's no flash of a scale(1) oversize then animating down.
  const [collageScale, setCollageScale] = useState<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Load foot sprite once — right foot, pointing up.
    const footImg = new Image();
    footImg.src = '/foot.png';

    let width = window.innerWidth;
    let height = window.innerHeight;

    const resize = (): void => {
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = width;
      canvas.height = height;
    };
    resize();
    window.addEventListener('resize', resize);

    // --- Footprint state ---
    const prints: Footprint[] = [];
    let lastX = -1;
    let lastY = -1;
    let sideFlip = 1;

    const onMove = (e: PointerEvent): void => {
      const x = e.clientX;
      const y = e.clientY;
      if (lastX < 0) { lastX = x; lastY = y; return; }
      const dx = x - lastX;
      const dy = y - lastY;
      if (Math.hypot(dx, dy) < STRIDE_PX) return;
      const angle = Math.atan2(dy, dx);
      const px = -Math.sin(angle) * FOOT_OFFSET_PX * sideFlip;
      const py = Math.cos(angle) * FOOT_OFFSET_PX * sideFlip;
      prints.push({ x: x + px, y: y + py, angle, born: performance.now(), flip: sideFlip });
      sideFlip *= -1;
      lastX = x;
      lastY = y;
    };
    const onLeave = (): void => { lastX = -1; lastY = -1; };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerleave', onLeave);

    // --- Ember state ---
    const embers: Ember[] = [];
    let lastEmberSpawn = 0;

    const spawnEmber = (now: number): void => {
      // Origin: anywhere along the bottom of the screen.
      const ox = Math.random() * width;
      const oy = height + 8 + Math.random() * 14;
      embers.push({
        x: ox,
        y: oy,
        vx: (Math.random() - 0.5) * 2.2,
        vy: -(7 + Math.random() * 6), // shoot up FAST
        r: 0.8 + Math.random() * 1.1,
        born: now,
        life: 600 + Math.random() * 700,
        history: [],
        seed: Math.random() * 1000, // personal noise offset
      });
    };

    // --- Draw campfire glow ---
    const drawCampfire = (now: number): void => {
      const t = now / 1000;
      // Multi-frequency flicker for organic feel — wider swings now.
      const flicker =
        0.80 +
        Math.sin(t * 2.7) * 0.10 +
        Math.sin(t * 6.1) * 0.07 +
        Math.sin(t * 13.3) * 0.04 +
        Math.sin(t * 0.5) * 0.08;
      const shiftX = Math.sin(t * 3.3) * 18 + Math.sin(t * 7.9) * 9;
      const shiftY = Math.sin(t * 4.1) * 12;

      // Bottom-wide wash: orange near the bottom, fading up. Covers the whole
      // bottom strip of the screen rather than a tight circle in the corner.
      const washHeight = height * 0.75;
      const wash = ctx.createLinearGradient(0, height, 0, height - washHeight);
      wash.addColorStop(0, `rgba(255,135,35,${0.18 * flicker})`);
      wash.addColorStop(0.35, `rgba(230,90,20,${0.10 * flicker})`);
      wash.addColorStop(0.75, `rgba(180,55,10,${0.04 * flicker})`);
      wash.addColorStop(1, 'rgba(140,35,5,0)');
      ctx.fillStyle = wash;
      ctx.fillRect(0, height - washHeight, width, washHeight);

      // Hot core — concentrated flicker near the imagined fire source.
      const cx = width * 0.2 + shiftX;
      const cy = height + 30 + shiftY;
      const coreR = height * 0.55 * flicker;
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
      core.addColorStop(0, `rgba(255,200,100,${0.15 * flicker})`);
      core.addColorStop(0.4, `rgba(255,120,35,${0.09 * flicker})`);
      core.addColorStop(0.8, `rgba(210,70,15,${0.04 * flicker})`);
      core.addColorStop(1, 'rgba(170,45,5,0)');
      ctx.fillStyle = core;
      ctx.fillRect(0, 0, width, height);
    };

    // --- Draw embers (with streaking trails) ---
    const drawEmbers = (now: number): void => {
      // Additive blending makes overlapping sparks brighten rather than mute.
      ctx.globalCompositeOperation = 'lighter';

      for (let i = embers.length - 1; i >= 0; i--) {
        const em = embers[i]!;
        const age = now - em.born;
        if (age > em.life || em.y < -40) { embers.splice(i, 1); continue; }

        // Physics: launch fast then decelerate sharply — like a real spark.
        // Two sin frequencies per ember (seeded) create subtle, un-synced wander.
        const noise =
          Math.sin(now / 220 + em.seed) * 0.35 +
          Math.sin(now / 90 + em.seed * 2.7) * 0.18;
        em.y += em.vy;
        em.x += em.vx + noise;
        em.vy *= 0.97; // sharper slowdown as heat dies
        em.vx *= 0.98;
        em.vy += 0.02; // tiny bit of gravity once it's lost its heat

        // Track recent positions for the trail (keep last 10).
        em.history.push([em.x, em.y]);
        if (em.history.length > 10) em.history.shift();

        const t = age / em.life;
        const lifeAlpha = t < 0.08 ? t / 0.08 : t > 0.75 ? (1 - (t - 0.75) / 0.25) : 1;

        // Trail: tapered polyline from oldest to newest.
        if (em.history.length > 1) {
          ctx.lineCap = 'round';
          for (let j = 1; j < em.history.length; j++) {
            const [x1, y1] = em.history[j - 1]!;
            const [x2, y2] = em.history[j]!;
            const f = j / em.history.length; // 0 (oldest) → 1 (newest)
            const trailAlpha = f * f * lifeAlpha * 0.55;
            ctx.strokeStyle = `rgba(255,${120 + Math.floor(f * 90)},${30 + Math.floor(f * 60)},${trailAlpha})`;
            ctx.lineWidth = Math.max(0.5, f * em.r * 1.8);
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
          }
        }

        // Bright hot-spot at current position.
        const g = ctx.createRadialGradient(em.x, em.y, 0, em.x, em.y, em.r * 3.2);
        g.addColorStop(0, `rgba(255,245,200,${lifeAlpha})`);
        g.addColorStop(0.3, `rgba(255,160,50,${lifeAlpha * 0.9})`);
        g.addColorStop(0.7, `rgba(230,80,20,${lifeAlpha * 0.4})`);
        g.addColorStop(1, 'rgba(180,40,5,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(em.x, em.y, em.r * 3.2, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalCompositeOperation = 'source-over';
    };

    // --- Draw one footprint using the sprite ---
    const drawPrint = (p: Footprint, alpha: number): void => {
      if (!footImg.complete || footImg.naturalWidth === 0) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(p.x, p.y);
      // foot.png points upward; rotate so it faces direction of travel.
      ctx.rotate(p.angle + Math.PI / 2);
      // Flip horizontally for left foot.
      if (p.flip < 0) ctx.scale(-1, 1);
      ctx.drawImage(footImg, -FOOT_W / 2, -FOOT_H / 2, FOOT_W, FOOT_H);
      ctx.restore();
    };

    // --- Main loop ---
    let raf = 0;
    const loop = (): void => {
      const now = performance.now();
      ctx.clearRect(0, 0, width, height);

      // Campfire glow (bottom layer).
      drawCampfire(now);

      // Spawn sparks occasionally — the fire pops one every few hundred ms.
      if (now - lastEmberSpawn > 380 + Math.random() * 520) {
        spawnEmber(now);
        lastEmberSpawn = now;
      }
      drawEmbers(now);

      // Footprints on top.
      for (let i = prints.length - 1; i >= 0; i--) {
        const p = prints[i]!;
        const age = now - p.born;
        if (age > FOOT_LIFETIME) { prints.splice(i, 1); continue; }
        const t = age / FOOT_LIFETIME;
        const alpha = t < 0.4 ? 0.75 : 0.75 * Math.pow(1 - (t - 0.4) / 0.6, 1.8);
        drawPrint(p, alpha);
      }

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerleave', onLeave);
      cancelAnimationFrame(raf);
    };
  }, []);

  useIsoLayoutEffect(() => {
    const update = (): void => setCollageScale((window.innerWidth * 0.5) / CANVAS_W);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  return (
    <div className="relative flex h-screen w-screen cursor-crosshair overflow-hidden bg-[var(--parchment-sunk)]">
      {/* Full-page canvas: campfire glow + embers + footprints */}
      <canvas
        ref={canvasRef}
        className="pointer-events-none fixed inset-0 z-50 h-screen w-screen"
      />

      {/* Left — collage rendered inside a fixed CANVAS_W×CANVAS_W coordinate
          space that is scaled uniformly from its center. This keeps the whole
          composition together as the viewport changes instead of having each
          image's % position drift independently. */}
      <div className="relative hidden h-full w-1/2 md:block">
        {collageScale !== null && (
        <div
          style={{
            position: 'absolute',
            width: CANVAS_W,
            height: CANVAS_W,
            top: '50%',
            left: '50%',
            transform: `translate(-50%, -50%) scale(${collageScale})`,
            transformOrigin: 'center center',
          }}
        >
          {COLLAGE.map((img, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={img.src}
              src={img.src}
              alt=""
              draggable={false}
              className={`collage-img absolute select-none${i === 0 ? '' : ' collage-img-interactive'}`}
              style={{
                left: img.left,
                top: img.top,
                width: img.width,
                height: 'auto',
                // Stagger the fade-in so the composition assembles top→bottom
                // in COLLAGE order.
                animationDelay: `${i * 110}ms`,
                filter: img.shadow
                  ? 'drop-shadow(0px 20px 18px rgba(42,24,10,0.45)) drop-shadow(0px 6px 6px rgba(42,24,10,0.25))'
                  : 'drop-shadow(0px 12px 12px rgba(42,24,10,0.40))',
              }}
            />
          ))}
        </div>
        )}
      </div>

      {/* Right — call to action. The container itself is pointer-events:none
          so empty space on the right half doesn't block hovers on collage
          images that overflow into it; each interactive child re-enables
          its own pointer events. */}
      <div className="pointer-events-none relative z-10 flex h-full w-full flex-col items-center justify-center gap-5 px-8 md:w-1/2">
        <h1
          className="pointer-events-auto text-6xl font-bold tracking-tight text-[var(--ink)]"
          style={{ fontFamily: '"Fraunces", Georgia, serif' }}
        >
          Pit Pals
        </h1>
        <p
          className="pointer-events-auto max-w-xs text-center text-lg italic text-[var(--ink-soft)]"
          style={{ fontFamily: '"Fraunces", Georgia, serif' }}
        >
          Notes, sheets &amp; stories for your table.
        </p>
        <Link
          href="/login"
          className="pointer-events-auto mt-4 inline-block rounded-[12px] bg-[var(--ink)] px-10 py-4 text-lg font-semibold text-[var(--parchment)] shadow-[0_2px_0_rgba(0,0,0,0.2)] transition hover:bg-[var(--wine)]"
          style={{ fontFamily: '"Fraunces", Georgia, serif' }}
        >
          Begin Your Adventure
        </Link>
      </div>
    </div>
  );
}
