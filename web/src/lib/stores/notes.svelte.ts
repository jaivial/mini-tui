/** The app's notes client on the one hub socket, with Svelte reactivity on what the UI reads. */
import { hub } from "../hub";
import { NotesClient } from "../notesClient";

export type { NoteSave } from "../notesClient";

class ReactiveNotes extends NotesClient {
  override values = $state({}) as NotesClient["values"];
  override live = $state(false);
}

export const notes = new ReactiveNotes(hub);
