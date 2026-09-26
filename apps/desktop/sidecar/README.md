# The packaged sidecar

Produced by `scripts/package-sidecar.mjs`; nothing here is written by hand and
nothing here is committed except this file and `.gitignore`.

After packaging, the layout is exactly what `src/sidecar.rs` expects:

```
sidecar/
  node.exe          the Node runtime that runs the server
  server/
    server.js       the Next standalone entry point
    .next/          the chunks the server reads from disk at runtime
    ...
```

## Why a runtime plus a tree, and not one executable

`pkg`, Node SEA and `bun --compile` were each considered and none of them can
swallow a Next standalone tree. The tree is not one entry point: it is a server
*plus* a `.next` directory the server reads from disk at runtime, including
chunk files it resolves by path. A single-file packer produces a binary that
starts and then cannot find its own pages.

This is recorded here, and in `src/sidecar.rs`, so the shortcut is not attempted
a second time and abandoned a second time.

## Why the directory is tracked and its contents are not

`tauri-build` validates `bundle.resources` at build time and fails when a
declared path is absent. `cargo check --target x86_64-pc-windows-msvc` is this
crate's only verification, so an untracked directory would make the check
depend on whether somebody had run the packaging script first.
