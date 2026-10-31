//! Allocator knobs for a short-lived, mostly single-threaded process.
//!
//! glibc gives every thread that allocates its own arena (up to 8 x cores), and an arena's freed
//! pages stay resident until something trims them. This process runs a handful of helper threads
//! (the model call, command readers, the hub) that each touch large buffers once (a request body,
//! a response, a command page), so per-thread arenas mostly hold memory nobody reuses.
//! `mallopt` is used instead of `MALLOC_ARENA_MAX` so the setting does not leak into the
//! environment of the commands the agent runs.

/// At the start of `main`, before any helper thread exists.
pub fn tune() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    unsafe {
        libc::mallopt(libc::M_ARENA_MAX, 2);
    }
}

/// Hand freed heap pages back to the kernel after a step that dropped a lot at once (a
/// compaction, a full trajectory export, the end of a turn).
pub fn trim() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    unsafe {
        libc::malloc_trim(0);
    }
}
