/** Transient notifications, shaped like shadcn toasts. */

export type ToastTone = "info" | "ok" | "err";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  title: string;
  detail?: string;
  tone: ToastTone;
  action?: ToastAction;
}

let next = 1;

/**
 * Timers pause while a toast is hovered or holds focus, so reaching for its button never races the
 * clock; they resume with what was left. A toast with an action stays longer (8s, not 4.2s): it asks
 * for a decision, not just a glance.
 */
class ToastStore {
  items = $state<Toast[]>([]);
  #timers = new Map<number, { left: number; started: number; handle?: ReturnType<typeof setTimeout> }>();

  push(title: string, options: { detail?: string; tone?: ToastTone; ttl?: number; action?: ToastAction } = {}) {
    const id = next++;
    this.items = [...this.items.slice(-3), { id, title, detail: options.detail, tone: options.tone ?? "info", action: options.action }];
    const ttl = options.ttl ?? (options.action ? 8000 : 4200);
    if (ttl > 0) {
      this.#timers.set(id, { left: ttl, started: 0 });
      this.resume(id);
    }
    return id;
  }

  pause(id: number) {
    const t = this.#timers.get(id);
    if (!t?.handle) return;
    clearTimeout(t.handle);
    t.handle = undefined;
    t.left = Math.max(0, t.left - (Date.now() - t.started));
  }

  resume(id: number) {
    const t = this.#timers.get(id);
    if (!t || t.handle) return;
    t.started = Date.now();
    t.handle = setTimeout(() => this.dismiss(id), t.left);
  }

  dismiss(id: number) {
    const t = this.#timers.get(id);
    if (t?.handle) clearTimeout(t.handle);
    this.#timers.delete(id);
    this.items = this.items.filter((toast) => toast.id !== id);
  }
}

export const toasts = new ToastStore();
