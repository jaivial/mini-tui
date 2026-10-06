/**
 * The app's DAG plans client on the one hub socket.
 *
 * The plans themselves are plain data here; the app keeps a reactive copy in `$state` fed by
 * `watch` (see App.svelte) — the same split `tasks.svelte.ts` documents.
 */
import { hub } from "../hub";
import { PlanClient } from "../planClient";

export const plans = new PlanClient(hub);
