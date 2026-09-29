/**
 * The chat the user is composing, before a session exists.
 *
 * "New chat" creates nothing on the server: it clears the active session and shows an empty
 * chat. The session is created by the first message, on the target, host, folder and model chosen
 * here. Until then there is nothing to stop, close or persist, so opening and abandoning a draft
 * costs nothing.
 */
class Draft {
  /** "local", or a host id. */
  targetId = $state("local");
  /** Only set when the user picked one; empty means "the server's default (last used) model". */
  model = $state("");
  cwd = $state("");
}

export const draft = new Draft();
