/** Transient notifications, shaped like shadcn toasts. */

export type ToastTone = "info" | "ok" | "err";

export interface Toast {
  id: number;
  title: string;
  detail?: string;
  tone: ToastTone;
}

let next = 1;

class ToastStore {
  items = $state<Toast[]>([]);

  push(title: string, options: { detail?: string; tone?: ToastTone; ttl?: number } = {}) {
    const id = next++;
    this.items = [...this.items, { id, title, detail: options.detail, tone: options.tone ?? "info" }];
    const ttl = options.ttl ?? 4200;
    if (ttl > 0) setTimeout(() => this.dismiss(id), ttl);
    return id;
  }

  dismiss(id: number) {
    this.items = this.items.filter((t) => t.id !== id);
  }
}

export const toasts = new ToastStore();
