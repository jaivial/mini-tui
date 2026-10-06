/**
 * The app's task board client on the one hub socket.
 *
 * The board itself is plain data here; the app keeps a reactive copy in `$state` fed by `watch`
 * (see App.svelte), which is what Svelte tracks — the same split `notes.svelte.ts` documents.
 */
import { hub } from "../hub";
import { TasksClient } from "../tasksClient";

export const tasks = new TasksClient(hub);
