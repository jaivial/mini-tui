/**
 * Micro-interactions on Motion (motion.dev), as Svelte actions.
 *
 * `motion/mini` (Web Animations API, ~2.5 KB) plus the gesture helpers: the full
 * `motion` entry is ~25 KB more for a JS animation engine nothing here needs.
 *
 * Spring-shaped curves for anything the hand drives (a press, a hover lift) and short tweens for entrances, so
 * the UI answers like a physical thing without ever making the reader wait. Every action is a
 * no-op under `prefers-reduced-motion`: the CSS kill switch in app.css cannot reach animations
 * that Motion runs through the Web Animations API with its own timing.
 */
import { animate } from "motion/mini";
import { hover, press, stagger } from "motion";

/** A press: quick in, a touch of overshoot on the way back (a spring's shape, as a curve). */
export const SPRING = { duration: 0.22, ease: [0.34, 1.56, 0.64, 1] as [number, number, number, number] };
export const SOFT_SPRING = { duration: 0.28, ease: [0.22, 1.2, 0.36, 1] as [number, number, number, number] };
const EASE_OUT = [0.16, 1, 0.3, 1] as const;

export function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type Cleanup = { destroy?: () => void };

/** Rise into place on mount. `delay` in seconds lets a caller stagger siblings by index. */
export function enter(node: HTMLElement, opts: { y?: number; scale?: number; delay?: number; duration?: number } = {}): Cleanup {
  if (reducedMotion()) return {};
  const { y = 6, scale = 1, delay = 0, duration = 0.32 } = opts;
  const a = animate(node, { opacity: [0, 1], y: [y, 0], scale: [scale, 1] }, { duration, delay, ease: EASE_OUT });
  return { destroy: () => a.stop() };
}

/** Children rise in one after another on mount (a list arriving reads as a list, not a block). */
export function staggerChildren(node: HTMLElement, opts: { selector?: string; step?: number; y?: number } = {}): Cleanup {
  if (reducedMotion()) return {};
  const items = node.querySelectorAll<HTMLElement>(opts.selector ?? ":scope > *");
  if (!items.length) return {};
  const a = animate(items, { opacity: [0, 1], y: [opts.y ?? 6, 0] }, { duration: 0.3, delay: stagger(opts.step ?? 0.035), ease: EASE_OUT });
  return { destroy: () => a.stop() };
}

/** Squash on press, spring back on release. Replaces the CSS `:active` scale where it is used. */
export function pressable(node: HTMLElement, scale = 0.96): Cleanup {
  if (reducedMotion()) return {};
  const stop = press(node, (el) => {
    if ((el as HTMLButtonElement).disabled) return;
    animate(el, { scale }, SPRING);
    return () => animate(el, { scale: 1 }, SPRING);
  });
  return { destroy: stop };
}

/** A small lift on hover (cards, rows). Pointer-only: touch never gets a stuck hover. */
export function lift(node: HTMLElement, y = -1.5): Cleanup {
  if (reducedMotion()) return {};
  const stop = hover(node, (el) => {
    animate(el, { y }, SOFT_SPRING);
    return () => animate(el, { y: 0 }, SOFT_SPRING);
  });
  return { destroy: stop };
}

/** A one-shot attention pulse (a status that just changed). Call it, nothing to clean up. */
export function pulse(node: Element | null | undefined): void {
  if (!node || reducedMotion()) return;
  animate(node, { scale: [1, 1.06, 1] }, { duration: 0.45, ease: EASE_OUT });
}

/** A one-shot shake for a refused input. */
export function shake(node: Element | null | undefined): void {
  if (!node || reducedMotion()) return;
  animate(node, { x: [0, -6, 5, -3, 2, 0] }, { duration: 0.4, ease: "easeOut" });
}

/** Svelte transition (`transition:popIn`): Svelte owns the timing, so outros still delay unmount. */
export function popIn(_node: Element, { y = 6, scale = 0.97, duration = 220 }: { y?: number; scale?: number; duration?: number } = {}) {
  if (reducedMotion()) return { duration: 0 };
  return {
    duration,
    css: (t: number) => {
      const e = 1 - Math.pow(1 - t, 3);
      return `opacity:${e};transform:translateY(${(1 - e) * y}px) scale(${scale + (1 - scale) * e})`;
    },
  };
}
