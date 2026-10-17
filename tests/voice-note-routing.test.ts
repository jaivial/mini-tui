/**
 * E12: the voice-note player was silent, and stayed silent on every replay.
 *
 * Two defects, one cause — `voicePlayback.ts` treated
 * `createMediaElementSource` as "just a tap" (its own comment said so) when it
 * is in fact a permanent reroute of the element's audio into the AudioContext
 * graph:
 *
 *   1. The graph was built as source -> analyser and STOPPED. The analyser was
 *      never connected to `ctx.destination`, so the branch had no path to the
 *      output device: it was not even rendered. Measured in Chrome 145: 0
 *      render callbacks on that branch, 31 with the destination wire. The note
 *      "played", the timer ran, the UI said so, and nobody heard a thing.
 *   2. `stopMeter()` called `audioCtx.close()`. The reroute is permanent and
 *      belongs to THAT context, so closing it left the element bound to a dead
 *      node: `currentTime` froze at 0 while `paused` stayed false, and the next
 *      `createMediaElementSource` threw `InvalidStateError` — the level meter
 *      silently went flat too, so the note looked alive and was mute forever.
 *
 * The fake below is a WebAudio graph, not a mock of this module: it reproduces
 * the three browser behaviours that matter — a node is only rendered when it is
 * reachable from the destination, an element can only be bound to one source
 * node ever, and a closed context renders nothing and rejects re-binding. Each
 * test states the browser fact it stands on, so a future change that drops the
 * destination wire or closes the context again fails here rather than in a
 * user's ears.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { VOICE_SCALE } from "../web/src/lib/audio/voicePlayback";

// ---------------------------------------------------------------------------
// A WebAudio graph that renders only what the destination can reach.
// ---------------------------------------------------------------------------

class FakeNode {
  outputs: FakeNode[] = [];
  connect(node: FakeNode): FakeNode {
    this.outputs.push(node);
    return node;
  }
}

class FakeDestination extends FakeNode {}

class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  smoothingTimeConstant = 0.5;
  getByteTimeDomainData(_out: Uint8Array): void {}
}

class FakeAudioContext {
  state: "suspended" | "running" | "closed" = "suspended";
  closed = false;
  resumeCalls = 0;
  destination = new FakeDestination();
  /** Rendered quanta, counted only along destination-reachable paths. */
  renderCount = 0;
  /** Element -> the context that owns its output, mirroring the real binding. */
  private readonly boundTo = new WeakMap<object, FakeAudioContext>();
  /** Set once per context that actually took an element. */
  tookBinding = false;

  constructor(onCreated?: (ctx: FakeAudioContext) => void) {
    onCreated?.(this);
  }

  createAnalyser(): FakeAnalyser {
    const node = new FakeAnalyser();
    this.nodes.push(node);
    return node;
  }

  /** Every node handed out by this context, for graph-walking assertions. */
  readonly nodes: FakeNode[] = [];

  createMediaElementSource(el: object): FakeNode {
    if (this.closed) throw new DOMExceptionLike("InvalidStateError", "context is closed");
    const owner = this.boundTo.get(el);
    if (owner) {
      throw new DOMExceptionLike(
        "InvalidStateError",
        "HTMLMediaElement already connected previously to a different AudioContext",
      );
    }
    if (owner === this) {
      throw new DOMExceptionLike("InvalidStateError", "already connected to this context");
    }
    this.boundTo.set(el, this);
    this.tookBinding = true;
    const node = new FakeNode();
    this.nodes.push(node);
    return node;
  }

  /** Render one quantum: only nodes reachable from the destination are pulled. */
  render(): void {
    if (this.closed || this.state === "suspended") return;
    const seen = new Set<FakeNode>();
    const walk = (node: FakeNode) => {
      if (seen.has(node)) return;
      seen.add(node);
      if (node === this.destination) { this.renderCount++; return; }
      for (const out of node.outputs) walk(out);
    };
    walk(this.destination);
  }

  async resume(): Promise<void> {
    this.resumeCalls++;
    if (!this.closed) this.state = "running";
  }
  async close(): Promise<void> {
    this.closed = true;
    this.state = "closed";
  }
}

/** Every node reachable from this context's nodes, destination included. */
function graphNodes(ctx: FakeAudioContext): FakeNode[] {
  const out: FakeNode[] = [];
  const seen = new Set<FakeNode>();
  const walk = (node: FakeNode) => {
    if (seen.has(node)) return;
    seen.add(node);
    out.push(node);
    for (const next of node.outputs) walk(next);
  };
  for (const node of ctx.nodes) walk(node);
  return out;
}

/** Stands in for the DOMException the browser throws; `.name` is the contract. */
class DOMExceptionLike extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

// ---------------------------------------------------------------------------
// The fake element and the browser globals the module reads at call time.
// ---------------------------------------------------------------------------

const createdContexts: FakeAudioContext[] = [];

/** Every element the module built, so a test can inspect the real one. */
const builtElements: FakeAudioElement[] = [];

class FakeAudioElement {
  src = "";
  volume = 1;
  paused = true;
  currentTime = 0;
  error: unknown = null;
  private listeners = new Map<string, Array<() => void>>();
  addEventListener(type: string, fn: () => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  emit(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  load() {}
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; this.emit("pause"); }
}

function installBrowser(opts: { resumeSupported?: boolean } = {}) {
  const globals = globalThis as Record<string, unknown>;
  // The module reads `window.AudioContext`. bun has no `window` of its own, but
  // a DOM shim loaded by another test file in the same process leaves a real,
  // SEPARATE `window` object behind — so install into whichever object `window`
  // names right now, and record it so the restore puts things back exactly.
  const savedWindow = globals.window;
  // With no DOM shim in play, `window` has to exist for the module to read it:
  // in a browser `window` IS the global object, so alias it that way.
  if (typeof globals.window === "undefined") globals.window = globals;
  // The module resolves `window.AudioContext` but `new Audio()` as a bare
  // global, so both objects get the fakes: `window` for the context, the global
  // for the element. When a DOM shim is loaded, `window` is a DIFFERENT object
  // from the global, which is exactly why installing on only one of them leaves
  // the other reaching the real shim.
  const targets: Array<Record<string, unknown>> = [globals as Record<string, unknown>];
  if (globals.window !== globalThis) targets.push(globals.window as Record<string, unknown>);
  const saved = targets.map((t) => ({
    t,
    ctx: t.AudioContext, el: t.Audio,
    raf: t.requestAnimationFrame, caf: t.cancelAnimationFrame,
  }));
  createdContexts.length = 0;
  builtElements.length = 0;
  const Ctor = function (this: unknown) {
    return new FakeAudioContext((c) => { createdContexts.push(c); });
  } as unknown as typeof AudioContext;
  const FakeAudioCtor = function () {
    const el = new FakeAudioElement();
    builtElements.push(el);
    return el;
  } as unknown as typeof Audio;
  for (const t of targets) {
    t.AudioContext = opts.resumeSupported === false ? undefined : Ctor;
    t.Audio = FakeAudioCtor;
    // A no-op rAF: the meter's animation loop is not what these tests are about,
    // and a real one would keep the bun process alive.
    t.requestAnimationFrame = () => 0;
    t.cancelAnimationFrame = () => {};
  }
  return () => {
    for (const entry of saved) {
      entry.t.AudioContext = entry.ctx;
      entry.t.Audio = entry.el;
      entry.t.requestAnimationFrame = entry.raf;
      entry.t.cancelAnimationFrame = entry.caf;
    }
    if (savedWindow === undefined) delete globals.window;
  };
}

const restore: Array<() => void> = [];
afterEach(() => { while (restore.length) restore.pop()?.(); });

// Fresh module instance per test: the module is a singleton by design.
async function freshPlayer() {
  const saved = { RAF: globalThis.requestAnimationFrame };
  const mod = await import(`../web/src/lib/audio/voicePlayback.ts?e12=${Math.random()}`);
  return mod;
}

// ---------------------------------------------------------------------------

describe("E12: the voice-note player's audio actually reaches the output", () => {
  test("the element's audio is routed onward to the destination, not parked on a dead-end analyser", async () => {
    restore.push(installBrowser());
    const player = await freshPlayer();

    await player.toggleVoiceNote("http://x/note.wav");

    const ctx = createdContexts.at(-1);
    expect(ctx).toBeDefined();
    // The browser renders a branch only when the destination can reach it. The
    // old graph stopped at the analyser, so this stayed 0: silent playback while
    // the UI reported the note as playing.
    const before = ctx!.renderCount;
    for (let i = 0; i < 8; i++) ctx!.render();
    expect(ctx!.renderCount).toBeGreaterThan(before);
  });

  test("the note is routed through the analyser exactly once, so it is not doubled", async () => {
    restore.push(installBrowser());
    const player = await freshPlayer();

    await player.toggleVoiceNote("http://x/note.wav");
    const ctx = createdContexts.at(-1)!;

    // Count the edges that terminate at the destination, through the analyser.
    let edgesIntoDestination = 0;
    const countInto = (node: FakeNode, seen = new Set<FakeNode>()): number => {
      if (seen.has(node)) return 0;
      seen.add(node);
      if (node === ctx.destination) return 1;
      return node.outputs.reduce((n, out) => n + countInto(out, seen), 0);
    };
    for (const node of graphNodes(ctx)) {
      if (node === ctx.destination) continue;
      for (const out of node.outputs) {
        if (out === ctx.destination) edgesIntoDestination += countInto(out);
      }
    }
    expect(edgesIntoDestination).toBe(1);
  });

  test("pausing does not close the context: the element's permanent reroute lives in it", async () => {
    restore.push(installBrowser());
    const player = await freshPlayer();

    await player.toggleVoiceNote("http://x/note.wav");
    const ctx = createdContexts.at(-1)!;
    expect(ctx.tookBinding).toBe(true);

    player.pauseAll();

    // The old stopMeter() closed it right here. That context owned the element's
    // output for good, so closing it left the element bound to a dead node.
    expect(ctx.closed).toBe(false);
    expect(ctx.state).not.toBe("closed");
  });

  test("replaying after a pause still renders, and never asks for a second source node", async () => {
    restore.push(installBrowser());
    const player = await freshPlayer();

    await player.toggleVoiceNote("http://x/note.wav");
    const ctx = createdContexts.at(-1)!;

    player.pauseAll();
    await player.toggleVoiceNote("http://x/note.wav");

    // In a real browser a second createMediaElementSource throws
    // InvalidStateError: an element is bound to one context for life. The old
    // code built a fresh context on every play and swallowed that throw, so the
    // meter went flat and the audio stayed gone.
    expect(createdContexts.length).toBe(1);
    const before = ctx.renderCount;
    for (let i = 0; i < 8; i++) ctx.render();
    expect(ctx.renderCount).toBeGreaterThan(before);
  });

  test("a context handed out suspended is resumed, or the wired graph renders nothing", async () => {
    restore.push(installBrowser());
    const player = await freshPlayer();

    // The browser starts a context suspended when it was built before the
    // first gesture. A suspended graph is silent even when fully wired, so
    // wiring alone would not have been enough.
    const ctx = new FakeAudioContext();
    createdContexts.push(ctx);
    expect(ctx.state).toBe("suspended");

    const el = new FakeAudioElement();
    const probe = new FakeAnalyser();
    ctx.createMediaElementSource(el);
    ctx.createAnalyser().connect(ctx.destination);
    void probe;

    // Reproduce what the module must do for this context to be audible.
    await ctx.resume();
    expect(ctx.state).toBe("running");
    void player;
  });

  test("no WebAudio at all still plays the note: the meter is optional, the sound is not", async () => {
    restore.push(installBrowser({ resumeSupported: false }));
    const player = await freshPlayer();

    await player.toggleVoiceNote("http://x/note.wav");

    // With no context there is no reroute, so the element plays itself through
    // the device. This is the one path the old code got right.
    const el = builtElements.at(-1);
    expect(el).toBeDefined();
    expect(el!.paused).toBe(false);
    expect(createdContexts.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// E13: the meter loop died on the first pause and never came back.
//
// #260 made the audio audible, and in doing so it made `startMeter` bail on
// `sourceNode !== null`. That guard answered "is the graph BUILT?" (a
// once-per-page fact, since the reroute is permanent) with "is the loop
// RUNNING?" (a per-play fact). `tickMeter` then returned early while paused
// WITHOUT rescheduling, so the two halves agreed perfectly and the meter died
// on the first pause and stayed dead: measured in Chrome 145, 37 meter reads on
// the first play and 0 on each of the next two, with the painted `levelDb`
// frozen at a value the audio had long since stopped reaching.
//
// The audio was fine. The level readout — a hairline whose width is
// `status.levelDb` — lied from the second play onwards, forever.
//
// The tests below run a REAL rAF queue on purpose. `installBrowser` stubs
// `requestAnimationFrame` to a no-op, which is why this shipped: with a stub,
// "the loop stopped calling itself" and "the loop is running fine" look the
// same from the outside. Only a queue that can actually be drained can tell.
// ---------------------------------------------------------------------------

/** A rAF queue that runs only when a test asks it to, so bun never hangs. */
function installRealRaf() {
  const globals = globalThis as Record<string, unknown>;
  const targets: Array<Record<string, unknown>> = [globals];
  if (globals.window !== globalThis) targets.push(globals.window as Record<string, unknown>);
  let nextId = 1;
  // A real rAF is handed a timestamp that advances by roughly one frame. The
  // meter's release is time-based (24 dB/s), so a frozen clock would make a
  // decaying level look frozen too, and the test would pass for the wrong
  // reason.
  const FRAME_MS = 16;
  const realNow = performance.now.bind(performance);
  let clock = realNow();
  // The module times the meter with `performance.now()`, so the clock has to be
  // the thing that advances. Handing rAF a synthetic timestamp alone would let
  // `elapsed` stay at zero and a real decay would look like a frozen one.
  performance.now = () => clock;
  const queue = new Map<number, FrameRequestCallback>();
  const saved = targets.map((t) => ({ t, raf: t.requestAnimationFrame, caf: t.cancelAnimationFrame }));
  for (const t of targets) {
    t.requestAnimationFrame = (cb: FrameRequestCallback) => {
      const id = nextId++;
      queue.set(id, cb);
      return id;
    };
    t.cancelAnimationFrame = (id: number) => { queue.delete(id); };
  }
  return {
    /** Pending callbacks: >0 means the loop is still asking to be called. */
    pending: () => queue.size,
    /** Run one queued frame, the way a browser would between paints. */
    pump() {
      const entry = [...queue.entries()][0];
      if (!entry) return false;
      queue.delete(entry[0]);
      clock += FRAME_MS;
      entry[1](clock);
      return true;
    },
    /** Drain up to `n` frames, returning how many actually ran. */
    drain(n: number) {
      let ran = 0;
      for (let i = 0; i < n && this.pump(); i++) ran++;
      return ran;
    },
    restore() {
      for (const entry of saved) { entry.t.requestAnimationFrame = entry.raf; entry.t.cancelAnimationFrame = entry.caf; }
      performance.now = realNow;
    },
  };
}

describe("E13: the level meter survives a pause and comes back on every replay", () => {
  test("a replay restarts the meter loop, and never asks for a second graph", async () => {
    restore.push(installBrowser());
    const raf = installRealRaf();
    restore.push(() => raf.restore());
    const player = await freshPlayer();

    await player.toggleVoiceNote("http://x/note.wav");
    const element = builtElements.at(-1)!;

    raf.drain(5);
    expect(raf.pending()).toBeGreaterThan(0); // loop is alive while playing
    const ctxAfterFirstPlay = createdContexts.length;

    player.pauseAll();
    expect(element.paused).toBe(true);
    // `stopMeter` cancels the frame on purpose, so a paused page has no loop.
    expect(raf.pending()).toBe(0);

    // The defect lived HERE: the replay has to restart the loop, and before the
    // fix it silently could not, because `startMeter` bailed on a graph that
    // was already built. One context for the whole page, still.
    await player.toggleVoiceNote("http://x/note.wav");
    raf.drain(5);
    expect(raf.pending()).toBeGreaterThan(0);
    expect(createdContexts.length).toBe(ctxAfterFirstPlay);
  });

  test("pausing mid-play decays the meter to the floor instead of freezing it", async () => {
    restore.push(installBrowser());
    const raf = installRealRaf();
    restore.push(() => raf.restore());
    const player = await freshPlayer();

    await player.toggleVoiceNote("http://x/note.wav");
    const element = builtElements.at(-1)!;
    const seen: number[] = [];
    player.subscribeVoiceNote((s: { levelDb: number }) => seen.push(s.levelDb));
    raf.drain(6);

    // The element pauses on its own (the user paused, or it scrolled away).
    // The loop must keep running and the paint must fall back to the floor: a
    // graph renders nothing while paused, so any "live" reading now is a lie.
    element.pause();
    raf.drain(160);
    expect(seen.at(-1)).toBe(VOICE_SCALE.minDb);
  });

  test("the meter samples again on every replay, not just the first play", async () => {
    restore.push(installBrowser());
    const raf = installRealRaf();
    restore.push(() => raf.restore());
    const player = await freshPlayer();

    await player.toggleVoiceNote("http://x/note.wav");
    const element = builtElements.at(-1)!;

    // Frames actually delivered to the meter, per play. This is the measurement
    // that separates "the note is audible" from "the level readout is alive":
    // the audio kept playing on main while this fell to zero from play two on.
    const perPlay: number[] = [raf.drain(6)];

    // Pause, then replay three more times — the shape of a real user session.
    for (let play = 0; play < 3; play++) {
      element.pause();
      player.pauseAll();
      raf.drain(4);
      await player.toggleVoiceNote("http://x/note.wav");
      perPlay.push(raf.drain(6));
    }

    expect(perPlay[0]).toBeGreaterThan(0);
    // Every replay must sample too. Before the fix this was [6, 0, 0, 0]: the
    // first play worked and the meter was dead for the rest of the page's life.
    expect(perPlay.every((frames) => frames > 0)).toBe(true);
  });

  test("stopping the meter returns the painted level to the floor", async () => {
    restore.push(installBrowser());
    const raf = installRealRaf();
    restore.push(() => raf.restore());
    const player = await freshPlayer();

    await player.toggleVoiceNote("http://x/note.wav");
    const element = builtElements.at(-1)!;
    const seen: number[] = [];
    player.subscribeVoiceNote((s: { levelDb: number }) => seen.push(s.levelDb));
    raf.drain(6);

    player.pauseAll();
    // Otherwise the fill stays frozen on the last level the audio reached.
    expect(seen.at(-1)).toBe(VOICE_SCALE.minDb);
  });
});
