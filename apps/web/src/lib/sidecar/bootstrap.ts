/* -------------------------------------------------------------------------
 * The sidecar startup path (PW-0105).
 *
 * WHAT THIS TASK EXISTS FOR, IN ONE SENTENCE: `checkBindSafety` was written,
 * documented, unit-tested and CALLED BY NOTHING. gpt-architect's round-95
 * ruling turned that finding into a standing invariant -- "No sidecar security
 * control may exist only as an unused helper" -- and this file is the call.
 *
 * ==========================================================================
 * WHERE IN STARTUP THIS RUNS, AND THE ONE PLACE THE RULING CANNOT BE MET
 * ==========================================================================
 *
 * Requirement A asks that the bind check run "BEFORE the listener becomes
 * externally usable". In this process it cannot, and the reason is not a
 * preference:
 *
 *   Next 16.3.1's generated standalone entry constructs the server, calls
 *   `listen()`, and only then awaits `instrumentation.register()`. Measured on
 *   this version: `listen()` returns at ~243ms, the `listening` event fires at
 *   ~259ms, `register()` runs after both. There is no earlier hook. An
 *   application module cannot execute before its own framework binds a socket,
 *   because nothing has loaded the application yet.
 *
 * So the contract is met in the two places it can be, and the gap is stated
 * rather than papered over:
 *
 *   1. HERE, as early as application code runs at all: a failed check emits an
 *      actionable diagnostic and exits non-zero, so the process does not go on
 *      serving.
 *   2. AT THE REQUEST BOUNDARY, in `authorizeRequest`, which re-runs the same
 *      check and refuses. That closes the milliseconds between the bind and
 *      the exit -- the window this file cannot remove.
 *
 * Nothing downgrades. A sidecar whose environment fails the check serves
 * nothing at any point and then dies.
 *
 * THE HANDSHAKE IS EMITTED FROM HERE AND NOWHERE ELSE, once, after the bound
 * address has been established from the live listener rather than from `PORT`.
 * `handshake.ts` has had `formatHandshake` since PW-0101 with no caller but its
 * own test; that is the same defect as the unused bind check and it is closed
 * by the same commit.
 * ---------------------------------------------------------------------- */
import { formatHandshake } from "./handshake";
import {
  activeHandles,
  discoverBoundAddress,
  publishBoundPort,
  type BoundAddress
} from "./listener";
import {
  LOOPBACK_HOST_LITERALS,
  NODE_PORT_VAR,
  SIDECAR_HOST_VAR,
  checkBindSafety,
  isSidecarMode,
  readSidecarEnvironment,
  type BindRefusalCode
} from "./policy";

export type SidecarBootstrapOutcome =
  | { readonly status: "not-a-sidecar" }
  | { readonly status: "refused"; readonly code: BindRefusalCode; readonly detail: string }
  | { readonly status: "listener-unknown"; readonly reason: string }
  | { readonly status: "bind-not-loopback"; readonly address: BoundAddress }
  | {
      readonly status: "ready";
      readonly address: BoundAddress;
      readonly handshake: string;
    };

/**
 * What should happen, decided without doing any of it.
 *
 * PURE, AND GIVEN ITS INPUTS. The environment and the handle table arrive as
 * arguments so that every outcome below -- including "two listeners" and "no
 * listener", which are awkward to produce on purpose -- is reachable from a
 * unit test without binding a socket or mutating the real process.
 */
export function planSidecarBootstrap(
  env: Readonly<Record<string, string | undefined>>,
  handles: readonly unknown[]
): SidecarBootstrapOutcome {
  const environment = readSidecarEnvironment(env);

  /* A HOSTED DEPLOYMENT MUST NOT BE AFFECTED BY ANY OF THIS. No token, no
   * sidecar, no diagnostic, no handshake line in its logs. */
  if (!isSidecarMode(environment)) return { status: "not-a-sidecar" };

  const safety = checkBindSafety(environment);
  if (!safety.ok) return { status: "refused", code: safety.code, detail: safety.detail };

  const discovery = discoverBoundAddress(handles);
  if (!discovery.ok) return { status: "listener-unknown", reason: discovery.reason };

  /*
   * THE ENVIRONMENT SAID LOOPBACK; THIS IS WHETHER THE KERNEL AGREED.
   *
   * `checkBindSafety` can only inspect what the shell asked for. A socket on
   * `0.0.0.0` with `HOSTNAME=127.0.0.1` in the environment is exactly the
   * failure the bind check is supposed to prevent and exactly the one it cannot
   * observe. This is the observation, and it is a hard refusal: invariant 5.
   */
  if (!LOOPBACK_HOST_LITERALS.includes(discovery.address.address.toLowerCase())) {
    return { status: "bind-not-loopback", address: discovery.address };
  }

  return {
    status: "ready",
    address: discovery.address,
    handshake: formatHandshake({
      host: discovery.address.address,
      port: discovery.address.port
    })
  };
}

/**
 * The operator-facing line for an outcome that stops startup.
 *
 * ACTIONABLE MEANS IT NAMES THE VARIABLE AND THE VALUE THAT IS WRONG. It never
 * names the token: `checkBindSafety` reports that one's LENGTH, and repeating a
 * secret into a log to help someone debug it is how the secret leaves the
 * machine.
 */
export function describeSidecarBootstrapOutcome(outcome: SidecarBootstrapOutcome): string {
  switch (outcome.status) {
    case "not-a-sidecar":
      return "sidecar: not a sidecar launch (no launch token was supplied); nothing to check";
    case "refused":
      return `sidecar: REFUSING TO SERVE (${outcome.code}) -- ${outcome.detail}`;
    case "listener-unknown":
      return `sidecar: REFUSING TO SERVE -- the bound port could not be established from the running server: ${outcome.reason}. The handshake must report the port the kernel chose, and ${NODE_PORT_VAR} is not that port under the PORT=0 launch contract.`;
    case "bind-not-loopback":
      return `sidecar: REFUSING TO SERVE -- the listener is bound to ${JSON.stringify(outcome.address.address)}:${outcome.address.port}, which is not a loopback address. ${SIDECAR_HOST_VAR} claimed loopback; the socket disagrees, and a sidecar reachable from the network is the failure the bind check exists to prevent.`;
    case "ready":
      return `sidecar: listening on ${outcome.address.address}:${outcome.address.port}`;
  }
}

export interface SidecarBootstrapIO {
  readonly env: Record<string, string | undefined>;
  readonly handles: () => readonly unknown[];
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly exit: (code: number) => void;
}

/**
 * ONE HANDSHAKE PER PROCESS.
 *
 * Requirement B says "exactly one". `register()` is called once per runtime, so
 * in practice this flag never fires -- which is the reason to have it: the cost
 * of being wrong about that is a shell that reads a second line, and the cost of
 * the flag is a boolean.
 */
let handshakeEmitted = false;

/** Test seam. Module state outlives `vi.resetModules()` in some pool configs. */
export function resetSidecarBootstrapState(): void {
  handshakeEmitted = false;
}

function productionIO(): SidecarBootstrapIO {
  return {
    env: process.env,
    handles: activeHandles,
    /* `process.stdout.write`, not `console.log`: the shell parses this stream
     * line by line and a logger that decides to prefix or buffer would break the
     * one line that has to arrive intact. */
    stdout: (line) => void process.stdout.write(`${line}\n`),
    stderr: (line) => void process.stderr.write(`${line}\n`),
    exit: (code) => process.exit(code)
  };
}

/**
 * Runs the startup path. Returns what it decided, for the caller's log.
 *
 * ON REFUSAL IT EXITS, AND THAT IS THE POINT. The catalog bootstrap next door
 * deliberately does not throw, because a misconfigured metadata source is worth
 * less than a running application. The opposite is true here: a sidecar that
 * cannot establish its own bind safety is a listener with no guarantee about who
 * can reach it, and continuing to serve is the harm.
 */
export function runSidecarBootstrap(
  io: SidecarBootstrapIO = productionIO()
): SidecarBootstrapOutcome {
  const outcome = planSidecarBootstrap(io.env, io.handles());

  if (outcome.status === "not-a-sidecar") return outcome;

  if (outcome.status !== "ready") {
    io.stderr(describeSidecarBootstrapOutcome(outcome));
    io.exit(1);
    return outcome;
  }

  /* Published before the line is printed: the shell may act on the handshake
   * immediately, and the request path must already be able to read the port. */
  publishBoundPort(outcome.address.port, io.env);

  if (!handshakeEmitted) {
    handshakeEmitted = true;
    io.stdout(outcome.handshake);
  }
  return outcome;
}
