import { mount } from "svelte";
import "./app.css";
import { ui } from "./lib/stores/ui.svelte";
import { workspace } from "./lib/workspace";

ui.apply();

// The windows, panes and sidebar are shared by every device: wait for the server's copy (briefly, so
// an offline tab still opens) before the stores that read it are created.
await workspace.whenReady();
const { default: App } = await import("./App.svelte");

export default mount(App, { target: document.getElementById("app")! });
