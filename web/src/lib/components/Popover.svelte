<script lang="ts">
  import { mount, unmount } from "svelte";
  import type { Snippet } from "svelte";
  import PopoverBody from "./PopoverBody.svelte";

  /**
   * A popover drawn through a portal: its card lives in `document.body`, not where the trigger sits.
   *
   * The sidebar is a narrow, scrolling rail, and a task card is wider than the rail should ever grow.
   * In place, the rail would clip it; merely fixed to the viewport it would drift off its button when
   * the rail scrolls. Through a portal the card is a sibling of everything else in the page: it floats
   * over the panes, over the rail and over whatever else is above them, and it is placed from its
   * anchor's box every time it opens and again whenever the window scrolls or resizes.
   *
   * `placement` says which side the card prefers. It flips to the other side when the screen has no
   * room that way, and it is always clamped inside the viewport. `clear` names an element the card must
   * not sit over (the sidebar rail): a card opened from inside it opens over the content instead, which
   * is the whole reason it left the rail in the first place.
   */
  let {
    open = false,
    anchor,
    placement = "right",
    role = "dialog",
    label,
    onclose,
    oncard,
    clear,
    width = "w-72",
    children,
  }: {
    open?: boolean;
    /** The element the card is placed against, read fresh on every move. */
    anchor: () => HTMLElement | null;
    placement?: "right" | "bottom";
    role?: string;
    label?: string;
    onclose?: () => void;
    /** The card element, handed up as soon as it exists (to measure it, or to place a card beside it). */
    oncard?: (el: HTMLElement | null) => void;
    /** An element the card must clear (the sidebar rail), read fresh on every move like the anchor. */
    clear?: () => HTMLElement | null;
    /** Card width, so a nested card can be narrower than the one it hangs off. */
    width?: string;
    children: Snippet;
  } = $props();

  const GAP = 8;
  const MARGIN = 8;
  /** Used to place the card before its own size is known, and to keep it off the far edge. */
  const CARD_W = 288;
  const CARD_H = 320;

  let top = $state(0);
  let left = $state(0);
  const at = () => ({ top, left });
  // Plain, not reactive: the card's element is only ever read while placing, and making it state
  // would mean every placement re-rendered the card that is being placed.
  let card: HTMLElement | null = null;
  /** Set from the anchor: the container the card must open beside, not over. */
  let edge: HTMLElement | null = null;
  let portal: HTMLDivElement | null = null;
  let app: Record<string, unknown> | null = null;

  /** Where the card goes: beside (or under) its anchor, flipped and clamped to stay on screen. */
  function place() {
    const el = anchor();
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w = card?.offsetWidth || CARD_W;
    const h = card?.offsetHeight || CARD_H;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let l = placement === "right" ? r.right + GAP : r.left;
    // No room that way: take the other side rather than run off the edge.
    if (l + w > vw - MARGIN) l = placement === "right" ? r.left - GAP - w : vw - MARGIN - w;
    // Over the rail it was opened from: step out of it, or take the far side of the anchor instead.
    const box = (clear?.() ?? edge ?? el.closest("aside"))?.getBoundingClientRect();
    if (box && l < box.right && l + w > box.left) {
      const out = box.right + GAP;
      l = out + w <= vw - MARGIN ? out : Math.max(MARGIN, r.left - GAP - w);
    }
    let t = placement === "right" ? r.top - 4 : r.bottom + GAP;
    left = Math.round(Math.max(MARGIN, Math.min(l, Math.max(MARGIN, vw - w - MARGIN))));
    top = Math.round(Math.max(MARGIN, Math.min(t, Math.max(MARGIN, vh - h - MARGIN))));
  }

  // The card is mounted for as long as it is open and re-placed whenever the anchor or the window
  // moves: a scroll of the rail, a window switch or a resize all keep it on its own button.
  $effect(() => {
    if (!open) return;
    portal = document.createElement("div");
    portal.dataset.popover = "";
    document.body.appendChild(portal);
    app = mount(PopoverBody, {
      target: portal,
      props: {
        at,
        role,
        label,
        width,
        children,
        oncard: (el: HTMLElement | null) => {
          card = el;
          oncard?.(el);
        },
      },
    }) as Record<string, unknown>;
    place();
    const settle = requestAnimationFrame(place);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
    ro?.observe(portal);
    return () => {
      ro?.disconnect();
      cancelAnimationFrame(settle);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      if (app) unmount(app, { outro: false });
      app = null;
      card = null;
      portal?.remove();
      portal = null;
    };
  });

  // Escape closes, and so does a press outside both the card and its anchor: the card lives in the
  // portal, so "outside" has to be tested against the anchor as well as against the card.
  $effect(() => {
    if (!open) return;
    function onkey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onclose?.();
    }
    function onpress(e: PointerEvent) {
      const t = e.target as Node | null;
      if (!t || card?.contains(t) || anchor()?.contains(t)) return;
      onclose?.();
    }
    document.addEventListener("keydown", onkey, true);
    document.addEventListener("pointerdown", onpress, true);
    return () => {
      document.removeEventListener("keydown", onkey, true);
      document.removeEventListener("pointerdown", onpress, true);
    };
  });

  /** The card element itself, so a caller can measure it or place a nested card against it. */
  export function element(): HTMLElement | null {
    return card;
  }

  /** Re-place the card now (a caller that moved its anchor without scrolling). */
  export function reposition(): void {
    place();
  }

</script>
