/* -------------------------------------------------------------------------
 * The port handshake (PW-0101; docs/DESKTOP_PLAYBACK.md §2).
 *
 * THE SIDECAR REPORTS THE PORT IT BOUND. It is not told which port to use.
 *
 * The obvious design — the shell picks a free port with `portpicker` and passes
 * it in — has a TOCTOU window between the pick and the bind, and on a machine
 * that is doing anything else that window is not theoretical. The sidecar loses
 * the race silently: it fails to bind, or binds somewhere else, and the shell
 * points a webview at a port nothing is listening on. The user sees a blank
 * window.
 *
 * So the sidecar binds first, port 0 if the shell says so, and prints ONE line
 * the shell parses. A line rather than a file because a file has its own races,
 * its own cleanup and its own permissions, and stdout is already a pipe the
 * parent owns.
 * ---------------------------------------------------------------------- */

/** The prefix that marks the one line of stdout the shell must parse. */
export const HANDSHAKE_PREFIX = "liberty-sidecar-ready";

export interface SidecarHandshake {
  readonly host: string;
  readonly port: number;
}

/**
 * The line the sidecar prints. Deliberately not JSON-only: the prefix lets the
 * shell find it among whatever Next decides to log, and the JSON body keeps it
 * parseable when a field is added.
 */
export function formatHandshake(handshake: SidecarHandshake): string {
  return `${HANDSHAKE_PREFIX} ${JSON.stringify({
    host: handshake.host,
    port: handshake.port
  })}`;
}

export type HandshakeParse =
  | { readonly ok: true; readonly handshake: SidecarHandshake }
  | { readonly ok: false; readonly reason: string };

/**
 * Parses one line. Returns a reason rather than throwing, because the shell
 * reads every line the child prints and most of them are not this one.
 *
 * REFUSES A NON-LOOPBACK HOST. The shell is about to point a webview at whatever
 * this says; a sidecar that reported `0.0.0.0` would have the shell advertise a
 * LAN-reachable origin as its own, and the bind check in `policy.ts` is not in
 * this process's control from the shell's point of view.
 */
export function parseHandshake(line: string): HandshakeParse {
  const trimmed = line.trim();
  if (!trimmed.startsWith(HANDSHAKE_PREFIX)) {
    return { ok: false, reason: "not a handshake line" };
  }
  const body = trimmed.slice(HANDSHAKE_PREFIX.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: "handshake body is not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "handshake body is not an object" };
  }
  const record = parsed as Record<string, unknown>;
  const host = record["host"];
  const port = record["port"];
  if (typeof host !== "string" || host === "") {
    return { ok: false, reason: "handshake states no host" };
  }
  if (host !== "127.0.0.1" && host !== "::1") {
    return { ok: false, reason: `handshake host ${JSON.stringify(host)} is not loopback` };
  }
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, reason: "handshake states no usable port" };
  }
  return { ok: true, handshake: { host, port } };
}
