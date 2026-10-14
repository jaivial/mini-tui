<script module lang="ts">
  // Module-level: every Mascot instance on the page gets a fresh svg-id scope, so two
  // copies of the same mascot never share defs ids.
  let mascotScopes = 0;
</script>

<script lang="ts">
  import { STATE_EXPRESSION, renderMascot, scopeSvgIds, type AgentMascotState, type MascotSpec } from "../mascot";

  /**
   * One squishmoji, rendered in the client from its spec (deterministic: the same
   * spec is the same avatar, seeds survive reloads). Decorative by rule — the row's
   * text carries the meaning, so this is always `aria-hidden`, never interactive.
   * The state picks the expression live (thinking→curious, success→happy, error→sad)
   * and drives the motion: idle floats, thinking breathes inside an ember halo,
   * `greet` waves three times on mount.
   */
  let {
    spec,
    state = "idle",
    /** Square size in px; the face fits inside it. */
    size = 32,
    /** Play the greeting wave (three swings) instead of the idle animation. */
    greet = false,
    /** Grey it out (a saved conversation no one can resume). */
    dim = false,
    class: klass = "",
  }: {
    spec: MascotSpec;
    state?: AgentMascotState;
    size?: number;
    greet?: boolean;
    dim?: boolean;
    class?: string;
  } = $props();

  // Per-instance id scope, regenerated per render (state changes re-render anyway).
  const face = $derived(scopeSvgIds(renderMascot(spec, state, size), `sq${++mascotScopes}`));
  /** The expression on show now: the state's override, or the spec's stored one. */
  const shown = $derived(STATE_EXPRESSION[state] ?? spec.expression);

  const anim = $derived(state === "idle" && !greet ? "pet-idle" : state === "thinking" ? "pet-think" : greet ? "pet-wave" : "");
  const grey = $derived(dim ? "opacity-60 saturate-[0.4]" : "");
</script>

<span class="relative inline-grid shrink-0 place-items-center {klass}" style="width:{size}px;height:{size}px">
  {#if state === "thinking"}
    <!-- The "thinking" halo: an ember ring pulsing behind the face. -->
    <span class="pet-halo absolute inset-[-4px] rounded-full bg-live-soft" aria-hidden="true"></span>
  {/if}
  {#key shown}
    <!-- {@html} of the library's own SVG markup, ids scoped per instance. -->
    <span class="pet-swap relative h-full w-full select-none {anim} {grey}" aria-hidden="true" data-mascot-state={state}>
      {@html face}
    </span>
  {/key}
</span>
