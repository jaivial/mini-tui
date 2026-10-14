# Project queue panel

The existing Session tasks drawer includes a read-only local project queue.
It watches the durable event stream and graph snapshot only while the drawer is
open. Closing the drawer releases the observer and its in-flight reads.

Cards show project/task identity, exact status, goal version, dependency IDs,
fence and stored result. Pending does not imply dependency readiness. Session
task cards stay separate below the queue. There are no worker/mutation
controls.

Loading, empty registry and read failures are distinct. A failed read preserves
its last snapshot with a reconnecting warning.

**Worker-alive vs registry-running**: a `running` row is backed by its lease
(owner + lease expiry, from `queue graph-read`). The card states which it is:
"Worker lease fresh · owner · renews for …" (green) or, when the lease has
expired or is absent, an explicit warning that the registry says running but no
live worker is proven and the task needs reconciliation (amber). A stale row
is never presented as a heartbeat.

**Verified live (cu, 1200x850 and 390x844)** against a real registry with real
CLI-driven transitions: pending appears via SSE while the drawer is open;
claim → running with a fresh lease (heartbeat renews it); running → blocked;
lease expiry → interrupted (needs reconciliation, fenced, no silent relaunch);
cancel of running → interrupted; cancel-reconcile → cancelled; finish with
structured closure evidence → "Closed with evidence" with the stored result.
SSE reconnect keeps the cursor (Last-Event-ID): a resumed stream delivers only
newer events, zero replays. With the registry unreadable the panel keeps the
last snapshot and shows the reconnecting warning; recovery resumes the stream.
Evidence: cu marks + screenshots (`/tmp/wa6-verify/`), transitions driven with
the `queue` CLI exactly as a worker would.
