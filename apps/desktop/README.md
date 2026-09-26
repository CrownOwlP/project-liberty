# `apps/desktop` — the Windows shell (PW-0102)

A Tauri v2 application that owns the lifetime of a Next.js sidecar.

## What is verified, and what is not

This is the honest boundary, stated first because everything else depends on it.

| | how | status |
| --- | --- | --- |
| the handshake contract, the supervision budget, the launch plan, the failure text | `cargo test` | **25 tests, green** |
| this crate's Windows-only code, including the Job Object | `cargo check --target x86_64-pc-windows-msvc --no-default-features` | **compiles** |
| the full shell including Tauri, for Windows | `cargo check --target x86_64-pc-windows-msvc` | **blocked upstream** — ADR-009 |
| it launches, WebView2 renders, the Job Object kills the sidecar, the installer works | a Windows runner or a real machine | **not observed** |

Nothing in this directory may be read as evidence for the last row. No Windows
binary can be produced or run in the environment this was written in.

## Layout

```
src-tauri/
  Cargo.toml        exact pins, and Cargo.lock is committed
  build.rs          runs tauri-build for the Windows target only
  tauri.conf.json   window, bundle targets, and the sidecar resources
  src/
    main.rs         three lines; everything testable is in the library
    lib.rs          the module list and the run() stub
    handshake.rs    parses the line the sidecar prints
    job.rs          the Win32 Job Object that kills orphans
    sidecar.rs      where the runtime lives and what it is started with
    supervision.rs  how many restarts, and when to stop
    failure.rs      what the user is told when it will not start
scripts/
  package-sidecar.mjs  lays out node.exe + the standalone tree
sidecar/            produced, not authored; see its README
```

## The four decisions worth knowing before changing anything

**The sidecar reports its port; the shell never picks one.** Picking a free port
and passing it in has a TOCTOU window between the pick and the bind, and the
shell loses the race silently — it points a webview at a port nothing is
listening on and the user sees a blank window. `apps/web/src/lib/sidecar/handshake.ts`
is the producer; `src/handshake.rs` is the consumer and re-validates everything,
including the loopback rule, because a consumer that trusted the producer's
validation would be trusting the thing it is validating.

**The launch token travels in the environment, never in `argv`.** On Windows a
process's command line is readable by any process running as the same user and
is shown in Task Manager. PW-0101 made that token the thing separating this
application's listener from every other local process.

**A Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, because every
user-mode alternative fails in the same place.** A `Drop` impl, an exit handler,
the child polling for its parent, `taskkill /T` — none of them run when the
shell is *killed*. The kernel enforces the job. The failure this prevents is the
one users actually report: "it will not start the second time", which is an
orphaned `node.exe` still holding the loopback port.

**A runtime plus a tree, not one executable.** `pkg`, Node SEA and
`bun --compile` cannot swallow a Next standalone tree — it is a server *plus* a
`.next` directory read from disk at runtime. A single-file packer produces a
binary that starts and then cannot find its own pages.

## Building

```bash
# tests and the Windows cross-check, from anywhere
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml \
  --target x86_64-pc-windows-msvc --no-default-features

# packaging, on a machine that has a node.exe to ship
npm run build:desktop -w @liberty/web
LIBERTY_SIDECAR_NODE=/path/to/node.exe node scripts/package-sidecar.mjs
```

The packaging script verifies its own output against the Rust constants, so an
edit to `src/sidecar.rs` that moves the layout fails the build rather than
first launch on somebody's machine.
