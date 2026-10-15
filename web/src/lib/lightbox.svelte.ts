/**
 * The image lightbox, shared by every bubble on the page: one open image at a
 * time, wherever the click came from. A module store because the transcript
 * renders many Markdown blocks but there is only ever one overlay to show.
 */
export const lightbox = $state({ open: false, src: "", alt: "" });

export function openLightbox(src: string, alt = ""): void {
  lightbox.src = src;
  lightbox.alt = alt;
  lightbox.open = true;
}

export function closeLightbox(): void {
  lightbox.open = false;
  lightbox.src = "";
  lightbox.alt = "";
}
