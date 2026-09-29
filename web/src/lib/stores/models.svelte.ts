/** The model catalogue, fetched once on demand and shared by every picker. */
import { api } from "../api";
import type { ModelInfo } from "../types";

class ModelStore {
  list = $state<ModelInfo[]>([]);
  status = $state<"idle" | "loading" | "ready" | "error">("idle");
  error = $state("");

  async load(force = false) {
    if (this.status === "loading" || (this.status === "ready" && !force)) return;
    this.status = "loading";
    this.error = "";
    try {
      this.list = await api.models();
      this.status = "ready";
    } catch (error) {
      this.error = (error as Error).message;
      this.status = "error";
    }
  }
}

export const models = new ModelStore();
