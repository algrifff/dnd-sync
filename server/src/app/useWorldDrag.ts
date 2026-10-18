'use client';

// Pointer-driven reorder for the worlds rail. One code path for mouse
// and touch: a mouse drag starts after 5 px of travel; a finger has to
// hold still for 350 ms first, so a swipe still scrolls the drawer.
// The list reorders live as the pointer crosses slot centres, and the
// click that ends a drag never reaches the world button, so a drop
// never switches worlds.

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { moveTo, nearestSlot } from './world-rail';

const MOUSE_SLOP_PX = 5;
const TOUCH_SLOP_PX = 8;
const LONG_PRESS_MS = 350;

type Gesture = {
  id: string;
  pointerId: number;
  mouse: boolean;
  startX: number;
  startY: number;
  startOrder: string[];
  centres: number[];
  order: string[];
  active: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

export function useWorldDrag({
  railRef,
  ids,
  onPreview,
  onDrop,
  onCancel,
}: {
  railRef: RefObject<HTMLElement | null>;
  ids: readonly string[];
  /** The order to show while dragging. */
  onPreview: (order: string[]) => void;
  onDrop: (order: string[], movedId: string) => void;
  /** The drag ended without a new order (Escape, pointercancel, or a drop
   *  in place). Gets the order from before the drag. */
  onCancel: (startOrder: string[]) => void;
}): {
  draggingId: string | null;
  onPointerDown: (e: React.PointerEvent<HTMLElement>, id: string) => void;
  /** Swallows the click that ends a drag. Attach as onClickCapture. */
  onClickCapture: (e: React.MouseEvent) => void;
} {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const swallowClick = useRef<boolean>(false);
  const latest = useRef({ ids, onPreview, onDrop, onCancel });
  latest.current = { ids, onPreview, onDrop, onCancel };

  const end = useRef<(commit: boolean) => void>(() => {});

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>, id: string): void => {
      if (e.button !== 0 || gesture.current) return;
      swallowClick.current = false;
      const rail = railRef.current;
      if (!rail) return;
      const centres = [...rail.querySelectorAll<HTMLElement>('[data-world-id]')].map((el) => {
        const r = el.getBoundingClientRect();
        return r.top + r.height / 2;
      });
      const mouse = e.pointerType === 'mouse';
      if (mouse) e.currentTarget.setPointerCapture(e.pointerId);
      const g: Gesture = {
        id,
        pointerId: e.pointerId,
        mouse,
        startX: e.clientX,
        startY: e.clientY,
        startOrder: [...latest.current.ids],
        centres,
        order: [...latest.current.ids],
        active: false,
        timer: null,
      };
      gesture.current = g;

      const activate = (): void => {
        g.active = true;
        setDraggingId(id);
      };
      if (!mouse) g.timer = setTimeout(activate, LONG_PRESS_MS);

      const onMove = (ev: PointerEvent): void => {
        if (ev.pointerId !== g.pointerId) return;
        if (!g.active) {
          const dist = Math.hypot(ev.clientX - g.startX, ev.clientY - g.startY);
          if (g.mouse && dist > MOUSE_SLOP_PX) activate();
          else if (!g.mouse && dist > TOUCH_SLOP_PX) end.current(false);
          if (!g.active) return;
        }
        const order = moveTo(g.startOrder, g.id, nearestSlot(g.centres, ev.clientY));
        if (order.join() === g.order.join()) return;
        g.order = order;
        latest.current.onPreview(order);
      };
      const onUp = (ev: PointerEvent): void => {
        if (ev.pointerId === g.pointerId) end.current(true);
      };
      const onCancel = (ev: PointerEvent): void => {
        if (ev.pointerId === g.pointerId) end.current(false);
      };
      const onKey = (ev: KeyboardEvent): void => {
        if (ev.key === 'Escape') end.current(false);
      };

      end.current = (commit: boolean): void => {
        if (gesture.current !== g) return;
        if (g.timer) clearTimeout(g.timer);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('keydown', onKey);
        gesture.current = null;
        if (!g.active) return;
        setDraggingId(null);
        swallowClick.current = true;
        if (commit && g.order.join() !== g.startOrder.join()) {
          latest.current.onDrop(g.order, g.id);
        } else {
          latest.current.onCancel(g.startOrder);
        }
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKey);
    },
    [railRef],
  );

  // Once a long press has turned into a drag, the finger must move the
  // world, not scroll the drawer. Needs a non-passive listener that is
  // already attached when the touch starts.
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const onTouchMove = (e: TouchEvent): void => {
      if (gesture.current?.active) e.preventDefault();
    };
    const onContextMenu = (e: Event): void => {
      if (gesture.current) e.preventDefault();
    };
    rail.addEventListener('touchmove', onTouchMove, { passive: false });
    rail.addEventListener('contextmenu', onContextMenu);
    return () => {
      rail.removeEventListener('touchmove', onTouchMove);
      rail.removeEventListener('contextmenu', onContextMenu);
      end.current(false);
    };
  }, [railRef]);

  const onClickCapture = useCallback((e: React.MouseEvent): void => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  return { draggingId, onPointerDown, onClickCapture };
}
