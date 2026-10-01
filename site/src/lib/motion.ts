/**
 * Scroll-reveal built on `motion` (the animation library from the Framer Motion author), following the
 * mindrally `motion` skill: animate only transform and opacity (GPU-composited, no layout), stagger
 * siblings, use `inView` rather than a scroll listener, and clean up.
 *
 * Progressive by construction: the CSS state of every element is its final, visible state. This
 * action hides an element only in the instant before it animates in, and only when the user has
 * not asked for reduced motion, so no-JS, crawlers, print and reduced-motion all see the whole page.
 */
import { animate, inView } from "motion";

export const reducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

interface RevealOptions {
  /** Seconds between children when `children` is set. */
  gap?: number;
  /** Reveal each direct child in turn instead of the node as a whole. */
  children?: boolean;
  y?: number;
  delay?: number;
}

/** Svelte action: `<section use:reveal>` or `<ul use:reveal={{ children: true }}>`. */
export function reveal(node: HTMLElement, options: RevealOptions = {}) {
  if (reducedMotion()) return {};
  const { gap = 0.07, children = false, y = 18, delay = 0 } = options;
  const targets = children ? Array.from(node.children) as HTMLElement[] : [node];
  if (!targets.length) return {};

  // Hidden only now, on the client, and only what is below the fold: what is already visible at load
  // is left alone so the first paint (and LCP) is never delayed by an animation.
  const below = node.getBoundingClientRect().top > innerHeight * 0.92;
  if (!below) return {};
  for (const t of targets) {
    t.style.opacity = "0";
    t.style.transform = `translateY(${y}px)`;
  }
  const DURATION = 0.6;
  const cleanups: ReturnType<typeof setTimeout>[] = [];
  const stop = inView(
    node,
    () => {
      // One animation per element with its own start delay, so each element is cleaned up by its own
      // timer rather than by a promise for the whole group: a group `finished` can resolve before the
      // last staggered element has settled, which left that one element with inline styles.
      targets.forEach((t, i) => {
        const wait = delay + (children ? i * gap : 0);
        const a = animate(t, { opacity: [0, 1], transform: [`translateY(${y}px)`, "translateY(0px)"] }, { duration: DURATION, delay: wait, ease: [0.16, 1, 0.3, 1] });
        const clear = () => {
          t.style.opacity = "";
          t.style.transform = "";
        };
        void a.finished.then(clear, clear);
        cleanups.push(setTimeout(clear, (wait + DURATION) * 1000 + 250)); // a backstop if `finished` never settles
      });
    },
    { amount: 0.2 },
  );
  return {
    destroy: () => {
      stop();
      cleanups.forEach(clearTimeout);
      // Never leave the element hidden if it is removed before it is revealed.
      for (const t of targets) {
        t.style.opacity = "";
        t.style.transform = "";
      }
    },
  };
}
