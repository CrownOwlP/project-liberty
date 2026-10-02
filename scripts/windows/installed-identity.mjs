/* -------------------------------------------------------------------------
 * The names and paths an installation actually has (PW-0503)
 *
 * EVERY VALUE HERE IS DERIVED. Not one of them is typed into this file.
 * `productName` and `identifier` come out of `src-tauri/tauri.conf.json`, the
 * executable name out of `src-tauri/Cargo.toml`'s `[[bin]]`, and the relative
 * paths inside the install and the writable root out of
 * `src-tauri/src/sidecar.rs` -- the constants the shell itself compiles
 * against. `verify-install.mjs` established the technique in round 99 and
 * records what it cost to learn: three separate drifts in four rounds, each
 * one a fact written down in a third place, and the last of them turned the
 * workflow's only install assertion into a check that the MSI carried a file
 * nothing ever starts.
 *
 * A derivation that cannot find its source THROWS. Falling back to a literal
 * would reintroduce exactly the copy this module exists to avoid, and it would
 * do it at the moment the real value had just moved.
 * ---------------------------------------------------------------------- */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT } from "./lifecycle-cases.mjs";

const TAURI_CONF = join(REPO_ROOT, "apps", "desktop", "src-tauri", "tauri.conf.json");
const CARGO_TOML = join(REPO_ROOT, "apps", "desktop", "src-tauri", "Cargo.toml");
const SIDECAR_RS = join(REPO_ROOT, "apps", "desktop", "src-tauri", "src", "sidecar.rs");

function required(value, what, where) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `${where} no longer provides ${what}, so this harness cannot derive it. Do not hard-code ` +
        `it here: a copy of this value is how the Windows workflow's install check drifted into ` +
        `proving nothing.`
    );
  }
  return value;
}

/** `pub const NAME: &str = "value";`, the same shape `verify-install.mjs` reads. */
export function rustConstant(source, name) {
  const found = new RegExp(`${name}\\s*:\\s*&str\\s*=\\s*"([^"]+)"`).exec(source)?.[1];
  return required(found, `${name} as a string literal`, "apps/desktop/src-tauri/src/sidecar.rs");
}

/** The first `[[bin]] name = "..."`, which is what Tauri ships as the .exe. */
export function cargoBinaryName(toml) {
  const found = /\[\[bin\]\][\s\S]*?name\s*=\s*"([^"]+)"/.exec(toml)?.[1];
  return required(found, "a [[bin]] name", "apps/desktop/src-tauri/Cargo.toml");
}

export function readIdentity({
  tauriConfPath = TAURI_CONF,
  cargoTomlPath = CARGO_TOML,
  sidecarRsPath = SIDECAR_RS
} = {}) {
  const conf = JSON.parse(readFileSync(tauriConfPath, "utf8"));
  const rust = readFileSync(sidecarRsPath, "utf8");

  const productName = required(conf.productName, "productName", "tauri.conf.json");
  const identifier = required(conf.identifier, "identifier", "tauri.conf.json");
  const binary = cargoBinaryName(readFileSync(cargoTomlPath, "utf8"));

  return Object.freeze({
    /** WiX installs to `%ProgramFiles%\<productName>` by default. */
    productName,
    /** `app_local_data_dir` on Windows is `%LOCALAPPDATA%\<identifier>`. */
    identifier,
    executable: `${binary}.exe`,
    /** Relative to the install root; the shell reads these from the same place. */
    serverEntry: rustConstant(rust, "SERVER_RELATIVE_PATH"),
    nodeExecutable: rustConstant(rust, "NODE_RELATIVE_PATH"),
    /** Relative to the writable root, created at first launch, never by the MSI. */
    writableSubdirectories: Object.freeze([
      rustConstant(rust, "DATA_RELATIVE_PATH"),
      rustConstant(rust, "CACHE_RELATIVE_PATH"),
      rustConstant(rust, "LOG_RELATIVE_PATH")
    ])
  });
}

/**
 * Where the installation and the user's data each live, given an environment.
 *
 * `env` IS PASSED IN rather than read, which keeps this testable off Windows
 * and -- more usefully -- makes the dependency on `%LOCALAPPDATA%` visible.
 * The Rust side deliberately resolves the writable root through the platform
 * API instead of the variable, because a redirected profile is honoured rather
 * than guessed at; this harness has no such API, so it reads the variable and
 * says so. On a runner the two agree. On a redirected corporate profile they
 * may not, and that is a RIG observation rather than something this can claim.
 */
export function locations(identity, env) {
  const programFiles = env.ProgramFiles;
  const localAppData = env.LOCALAPPDATA;
  if (!programFiles || !localAppData) {
    throw new Error(
      `%ProgramFiles% and %LOCALAPPDATA% must both be set to locate an installation; got ` +
        `ProgramFiles=${String(programFiles)} LOCALAPPDATA=${String(localAppData)}.`
    );
  }
  const installRoot = `${programFiles}\\${identity.productName}`;
  return Object.freeze({
    installRoot,
    executablePath: `${installRoot}\\${identity.executable}`,
    /*
     * THE FACT THAT DECIDES BOTH F2 AND F3, and it is worth stating rather
     * than discovering: the MSI never creates this directory. The application
     * does, at first launch, through Tauri's path API. So an upgrade cannot
     * disturb it and an uninstall cannot remove it -- user data survives both
     * because it was never the installer's to touch. F2's "user data
     * preserved" is therefore a property to VERIFY, not a feature to build,
     * and F3's "states what user data it keeps" has one honest answer: all of
     * it, here.
     */
    userDataRoot: `${localAppData}\\${identity.identifier}`
  });
}
