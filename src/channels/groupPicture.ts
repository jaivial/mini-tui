/**
 * WhatsApp group photo upload (the avatar bridge's transport). The evo-weai
 * fork takes the icon as MULTIPART with the target groupJid — not as the JSON
 * `{image: <base64>}` body the older calls used (that shape is rejected by the
 * current fork). The groupJid also rides the query string, because some fork
 * generations read it from there; sending both is harmless and covers both.
 */

import { readFileSync } from "node:fs";

export async function setGroupPicture(
  baseUrl: string,
  instance: string,
  token: string,
  groupJid: string,
  filePath: string,
  options?: { timeoutMs?: number },
): Promise<{ ok: boolean; status: number; error: string }> {
  const form = new FormData();
  form.append("groupJid", groupJid);
  const bytes = readFileSync(filePath);
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }), "avatar.jpg");
  let response: Response;
  try {
    response = await fetch(
      `${baseUrl.replace(/\/+$/, "")}/group/updateGroupPicture/${encodeURIComponent(instance)}?groupJid=${encodeURIComponent(groupJid)}`,
      { method: "POST", headers: { apikey: token }, body: form, signal: AbortSignal.timeout(options?.timeoutMs ?? 20_000) },
    );
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }
  if (response.status === 200 || response.status === 201) return { ok: true, status: response.status, error: "" };
  const text = await response.text().catch(() => "");
  return { ok: false, status: response.status, error: text.slice(0, 160) || `status ${response.status}` };
}
