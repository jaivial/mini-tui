# Project queue panel

The existing Session tasks drawer includes a read-only local project queue.
It watches the durable event stream and graph snapshot only while the drawer is
open. Closing the drawer releases the observer and its in-flight reads.

Cards show project/task identity, exact status, goal version, dependency IDs,
fence and stored result. Running registry state is explicitly not called a live
heartbeat. Pending does not imply dependency readiness. Session task cards stay
separate below the queue. There are no worker/mutation controls.

Loading, empty registry and read failures are distinct. A failed read preserves
its last snapshot with a reconnecting warning. The isolated local API empty-registry path was inspected with cu at 1200x850
and 390x844. Drawer position/z-order fixes were applied and re-inspected.
Populated cards, event transitions and failure states remain unverified.
No production task registry or model was invoked.
