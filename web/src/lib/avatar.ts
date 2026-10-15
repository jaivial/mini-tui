/**
 * Bot avatars: one squishmoji per session, from the SpaceUI squishmoji set
 * (web/public/squish, see CREDITS.md there — static SVGs pre-rendered from
 * @usespaceui/squishmoji by scripts/gen-squishmoji.ts). The mapping is
 * deterministic — a session always wears the same face, on every device,
 * without storing anything: the hash of its id picks from the set. New
 * sessions drift through the faces as ids arrive, which is fine: a face is
 * decoration, never identity (the title is), and it matches the mockup's room
 * of squishy characters.
 */

/** The set, in display order: the faces and the tools of the trade. */
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

/** The avatar's image for a session id (any stable string). */
export const avatarSrc = (id: string): string => {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (Math.imul(31, hash) + id.charCodeAt(i)) | 0;
  const face = FACES[Math.abs(hash) % FACES.length];
  return `/squish/${face}.svg`;
};

/**
 * The faces for the mobile bot grid and any "meet the bots" surface: a short
 * stable slice of the set, distinct ids spread across distinct faces.
 */
export const gridFaces = (ids: string[]): { id: string; src: string }[] =>
  ids.map((id) => ({ id, src: avatarSrc(id) }));
