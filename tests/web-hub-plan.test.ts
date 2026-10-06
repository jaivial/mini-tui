/** The hub's DAG plan topic, without a network: watch, push, who hears what, cleanup. */
import { describe, expect, test } from "bun:test";
import { Hub, type PlanSource } from "../src/web/hub";
import type { SessionPlan } from "../src/mini/plans";

const plan = (session: string, status: string): SessionPlan => ({
  session,
  updatedAt: 1,
  tasks: [
    { id: "A1", title: "map it", status, deps: [], group: "", priority: 0 },
    { id: "A2", title: "use it", status: "pending", deps: ["A1"], group: "", priority: 0 },
  ],
});

function setup(plans?: PlanSource) {
  const hub = new Hub({ get: () => ({ id: "s-1", body: "", updatedAt: 0 }), save: () => ({ ok: true as const, note: { id: "s-1", body: "", updatedAt: 0 } }) }, 1000);
  if (plans) hub.plans = plans;
  const client = () => {
    const got: unknown[] = [];
    const c = { got, send: (m: unknown) => (got.push(m), true) };
    hub.join(c);
    return c;
  };
  return { hub, client };
}
const send = (hub: InstanceType<typeof Hub>, c: { send: (m: unknown) => boolean }, m: unknown) => hub.handle(c as never, JSON.stringify(m));

describe("the hub's plan topic", () => {
  test("watching is answered with every session's plan at once", () => {
    const { hub, client } = setup({ plans: () => [plan("s-1", "running")] });
    const a = client();
    send(hub, a, { t: "plan.watch" });
    expect(a.got.at(-1)).toMatchObject({ t: "plan", plans: [{ session: "s-1", tasks: [{ id: "A1", status: "running" }, { id: "A2", deps: ["A1"] }] }] });
  });

  test("a hub updating its plan pushes it to every watcher", () => {
    let doc = plan("s-1", "running");
    const { hub, client } = setup({ plans: () => [doc] });
    const a = client();
    const b = client();
    send(hub, a, { t: "plan.watch" });
    send(hub, b, { t: "plan.watch" });
    const na = a.got.length;
    const nb = b.got.length;
    doc = plan("s-1", "done");
    hub.plansChanged();
    for (const c of [a, b]) expect(c.got.at(-1)).toMatchObject({ t: "plan", plans: [{ tasks: [{ id: "A1", status: "done" }, { id: "A2", status: "pending" }] }] });
    expect(a.got.length).toBe(na + 1);
    expect(b.got.length).toBe(nb + 1);
  });

  test("an unchanged plan is not pushed again", () => {
    const { hub, client } = setup({ plans: () => [plan("s-1", "running")] });
    const a = client();
    send(hub, a, { t: "plan.watch" });
    const n = a.got.length;
    hub.plansChanged();
    hub.plansChanged();
    expect(a.got.length).toBe(n);
  });

  test("unwatching and leaving stop the pushes", () => {
    let doc = plan("s-1", "running");
    const { hub, client } = setup({ plans: () => [doc] });
    const a = client();
    const b = client();
    send(hub, a, { t: "plan.watch" });
    send(hub, b, { t: "plan.watch" });
    send(hub, a, { t: "plan.unwatch" });
    expect(hub.planWatchers).toBe(1);
    const na = a.got.length;
    const nb = b.got.length;
    doc = plan("s-1", "done");
    hub.plansChanged();
    expect(a.got.length).toBe(na); // unwatched: nothing more, not even the push
    expect(b.got.length).toBe(nb + 1);
    hub.leave(b as never);
    expect(hub.planWatchers).toBe(0);
  });

  test("a server without plans says so instead of pretending", () => {
    const { hub, client } = setup();
    const a = client();
    send(hub, a, { t: "plan.watch" });
    expect(a.got.at(-1)).toMatchObject({ t: "error" });
  });
});
