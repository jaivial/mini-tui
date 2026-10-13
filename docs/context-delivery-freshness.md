# Context delivery freshness

A child previously received shared findings even when current code had changed
since its last coverage snapshot. The completion-time check was too late to
prevent stale orientation from guiding the next child.

At spawn, prior coverage for the exact repo scope is re-read and its relative
files are checked against the child worktree. Symlink containment, 512KB/file,
4MB total and at most 512 files bound the check. Invalid snapshots, unreadable
files, changed digests or unresolved coverage failures suppress shared store
handover and supply a warning. Explicit brief/context files remain available,
and the child may inspect current code. No model call or spawn failure added.

Refresh findings/contracts and run contract-check to establish a new snapshot.
No prior snapshot still allows existing handover, but proves no freshness.
These are content checks, not type/caller/invariant or whole-repo guarantees.
Runtime evidence is pending; no tests or benchmark changed.
