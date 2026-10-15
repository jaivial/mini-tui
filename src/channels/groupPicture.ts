/**
 * WhatsApp group photo upload (the avatar bridge's transport). Fork
 * generations disagree on the body shape — newer ones take MULTIPART with the
 * target groupJid, the currently deployed one only accepts the JSON
 * `{image: <base64>}` shape (its muxer rejects anything else with
 * "Expected request with `Content-Type: application/json`", seen live). The
 * upload therefore tries multipart first and falls back to JSON when the fork
 * refuses the content type. The groupJid rides the query string either way,
 * because some generations read it from there.
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
  const url = `${baseUrl.replace(/\/+$/, "")}/group/updateGroupPicture/${encodeURIComponent(instance)}?groupJid=${encodeURIComponent(groupJid)}`;
  const bytes = readFileSync(filePath);
  try {
    const form = new FormData();
    form.append("groupJid", groupJid);
    form.append("file", new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }), "avatar.jpg");
    let response = await fetch(url, { method: "POST", headers: { apikey: token }, body: form, signal: AbortSignal.timeout(options?.timeoutMs ?? 20_000) });
    if (response.status === 200 || response.status === 201) return { ok: true, status: response.status, error: "" };
    const text = await response.text().catch(() => "");
    // Only a content-type refusal earns the legacy fallback: any other
    // failure (auth, unknown group) is returned as-is, honestly.
    if (!/content-type/i.test(text)) return { ok: false, status: response.status, error: text.slice(0, 160) || `status ${response.status}` };
    response = await fetch(url, {
      method: "POST",
      headers: { apikey: token, "Content-Type": "application/json" },
      body: JSON.stringify({ image: Buffer.from(bytes).toString("base64") }),
      signal: AbortSignal.timeout(options?.timeoutMs ?? 20_000),
    });
    if (response.status === 200 || response.status === 201) return { ok: true, status: response.status, error: "" };
    const jsonError = await response.text().catch(() => "");
    return { ok: false, status: response.status, error: jsonError.slice(0, 160) || `status ${response.status}` };
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}
