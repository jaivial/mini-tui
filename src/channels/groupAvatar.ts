/**
 * Group avatars (the web redesign carried to WhatsApp): every bound session
 * wears the same blob-emoji face in its WhatsApp group photo that the web
 * panel shows in the sidebar — the mockup's room of bots, on both surfaces.
 *
 * The faces are the Blobmoji set served by the SpaceUI CDN (see CREDITS.md in
 * assets/emoji/): pre-rendered once to square 512×512 JPGs (WhatsApp crops the
 * group photo circularly) at `assets/emoji/<codepoints>.jpg`. This module is
 * the server mirror of `web/src/lib/avatar.ts` — keep the FACES list and the
 * hash identical, so a session's face matches on both surfaces.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/** The set, in display order — MUST match web/src/lib/avatar.ts. */
const FACES = [
  "1f916", // robot
  "1f47d", // alien
  "1f47f", // imp
  "1f9e0", // brain
  "1f680", // rocket
  "1f4bb", // laptop
  "1f52c", // microscope
  "1f4ca", // chart
  "1f4e6", // package
  "1f9ea", // test tube
  "1f527", // wrench
  "1f4b0", // money bag
  "1f3e0", // house
  "1f4dd", // memo
  "1f9f8", // teddy bear
  "1f50c", // electric plug
  "1f3af", // direct hit
  "1f4bc", // briefcase
  "1f600", // grinning face
  "1f60e", // smiling with sunglasses
  "1f929", // star-struck
  "1f642", // slightly smiling
  "1f4ac", // speech balloon
  "1f9d1-200d-1f4bb", // technologist
] as const;

/** The session's avatar file (square JPG, upload-ready), when it exists. */
export const avatarFileFor = (sessionId: string): string | undefined => {
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) hash = (Math.imul(31, hash) + sessionId.charCodeAt(i)) | 0;
  const face = FACES[Math.abs(hash) % FACES.length];
  const file = join(import.meta.dir, "assets", "emoji", `${face}.jpg`);
  return existsSync(file) ? file : undefined;
};
