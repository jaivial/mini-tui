# Queue client lifecycle

The read-only client aborts its snapshot fetch when its final observer leaves.
A new observer can start a new generation immediately instead of being blocked
by the old in-flight refresh. Old fetch completion and old EventSource events
cannot publish into the new generation. Each fetch retains its own 10s timeout,
cleared on completion. Failed reads still retry after 5s, only while observed.

Snapshots require bounded arrays, unique node IDs, field types, nonnegative
fences and existing edge endpoints. Listener exceptions do not stop delivery to
other observers. No queue mutation, worker launch, model call or new polling.

This prepares the shared client; it does not wire the queue panel or prove pixels.
Runtime and UI proof remain pending. No tests or benchmark changed.
