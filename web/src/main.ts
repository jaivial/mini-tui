import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";
import { ui } from "./lib/stores/ui.svelte";

ui.apply();

export default mount(App, { target: document.getElementById("app")! });
