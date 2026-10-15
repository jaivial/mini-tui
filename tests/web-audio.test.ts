/**
 * v6-F: the web's voice-note logic.
 *
 * Only the logic is asserted here — the components are DOM. What each test
 * pins down, and the failure each one would otherwise ship:
 *
 *   1. A browser recording is classified as AUDIO. `.webm` is one container for
 *      audio and video and the allowlist stores a single mime for it
 *      ("video/webm"), so without the name rule a note recorded in Chrome
 *      would render as a download link instead of a player — the whole feature,
 *      silently dead on the most common browser.
 *   2. That rule stays NARROW: a real video, a real .mp3 and an unrelated .webm
 *      are untouched. A name check that matched any `.webm` would put a video
 *      bubble on the audio player.
 *   3. A voice note still rides the prompt as a normal attachment, so the text
 *      a text-only client reads keeps carrying its link and nothing is lost
 *      when `attachments` is absent.
 *
 * The Control UI ports themselves are upstream code; what is worth pinning is
 * the classification this app owns.
 */
import { describe, expect, test } from "bun:test";

import { transcriptAttachment, attachmentLinksLine, type Attachment } from "../src/web/attachments";

const att = (over: Partial<Attachment>): Attachment => ({
  id: "a1",
  name: "nota-de-voz-12-30-00.webm",
  mime: "video/webm",
  size: 2048,
  path: "/tmp/a1.webm",
  url: "/api/attachments/a1",
  ...over,
});

describe("transcriptAttachment: recorded voice notes are audio", () => {
  test("a .webm take recorded in the browser is audio, not video", () => {
    // What the recorder actually produces: MediaRecorder's default container,
    // stored under the .webm allowlist entry, whose stored mime is video/webm.
    expect(transcriptAttachment(att({})).kind).toBe("audio");
  });

  test("the rule is narrow: video, mp3 and unrelated .webm files are not", () => {
    expect(transcriptAttachment(att({ name: "clip.webm" })).kind).toBe("file");
    expect(transcriptAttachment(att({ name: "nota-de-voz.webm.mp4" })).kind).toBe("file");
    expect(transcriptAttachment(att({ name: "song.mp3", mime: "audio/mpeg" })).kind).toBe("audio");
    expect(transcriptAttachment(att({ name: "shot.png", mime: "image/png" })).kind).toBe("image");
  });

  test("an m4a take is audio through the mime alone, no name rule needed", () => {
    expect(transcriptAttachment(att({ name: "nota-de-voz-12-30-00.m4a", mime: "audio/mp4" })).kind).toBe("audio");
  });

  test("the transcript still carries the id, url, mime and name the web needs", () => {
    const shaped = transcriptAttachment(att({ name: "nota-de-voz-12-30-00.webm" }));
    expect(shaped).toEqual({ id: "a1", kind: "audio", mime: "video/webm", url: "/api/attachments/a1", name: "nota-de-voz-12-30-00.webm" });
  });
});

describe("attachmentLinksLine: the text-only path is untouched", () => {
  test("a voice note still appears as a markdown link in the prompt text", () => {
    const line = attachmentLinksLine([att({})]);
    expect(line).toContain("nota-de-voz-12-30-00.webm");
    expect(line).toContain("(/api/attachments/a1)");
  });

  test("images stay inline and other files stay links", () => {
    expect(attachmentLinksLine([att({ name: "a.png", mime: "image/png" })])).toMatch(/^!\[a\.png\]/);
    expect(attachmentLinksLine([att({ name: "a.zip", mime: "application/zip" })])).toMatch(/^\[a\.zip\]/);
  });
});