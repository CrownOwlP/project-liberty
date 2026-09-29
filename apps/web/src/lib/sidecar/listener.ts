/* -------------------------------------------------------------------------
 * What this process is ACTUALLY listening on (PW-0105).
 *
 * THIS IS THE ONE IMPURE MODULE IN `lib/sidecar`, AND IT IS SEPARATE FROM
 * `policy.ts` FOR THAT REASON. `policy.ts` opens by promising that nothing in
 * it reads `process`, reads a clock, or throws for control flow, and that
 * promise is why its decisions can be tested without starting a server. A
 * function that has to interrogate a live listener cannot keep it. So the
 * interrogation lives here, the decision lives there, and the number crosses
 * between them as an argument.
 *
 * ==========================================================================
 * WHY THE PORT HAS TO BE DISCOVERED AT ALL
 * ==========================================================================
 *
 * gpt-architect's round-95 ruling: "Do not infer the reported port from the
 * requested PORT=0; obtain the actual bound port from the listening server."
 * Under PW-0101's contract the shell sets `PORT=0` and the kernel chooses, so
 * the environment holds the string "0" and nothing else -- reading it would
 * report a port no socket is on, to a shell that is about to point a webview
 * at it.
 *
 * Next's generated standalone entry does not hand the port to anything. It
 * creates the server, calls `listen`, and logs. There is no export, no event
 * and no callback reaching application code, and `instrumentation.register()`
 * is invoked AFTER the bind rather than before -- measured against this
 * version's own output, not read from a changelog. What IS reachable from
 * inside the process is the process's own handle table.
 *
 * `process._getActiveHandles()` IS UNDOCUMENTED AND IS USED DELIBERATELY. The
 * alternatives were worse, each in a way that matters here:
 *
 *   - Reading `PORT`: forbidden by the ruling, and wrong under the contract.
 *   - Patching `net.Server.prototype.listen` before Next loads: this module is
 *     loaded by instrumentation, which runs after the bind. Too late, and a
 *     monkey-patch of the runtime's socket layer is a larger liability than a
 *     read.
 *   - Having the shell pick a port and pass it in: rejected in terms --
 *     "Do NOT replace the kernel-selected-port design with shell-selected/
 *     free-port probing."
 *
 * The read is contained: it happens once, it is guarded for absence, and an
 * ambiguous answer is reported as ambiguous rather than guessed at. If a future
 * Node removes the function, `discoverBoundAddress` returns a refusal with a
 * reason, the startup path fails loudly, and nothing silently degrades.
 *
 * SERVERS ARE DISTINGUISHED FROM SOCKETS, AND THIS IS NOT COSMETIC. Once the
 * process is serving traffic the handle table also holds accepted connections
 * and any outbound socket the application opened, and `socket.address()`
 * answers with a `{ address, family, port }` shaped exactly like a server's.
 * An outbound connection's local port is an ephemeral number that has nothing
 * to do with the listener, and accepting one would make the Host port
 * comparison refuse valid traffic at random. `listen` is the discriminator: a
 * `net.Server` has it, a `net.Socket` does not.
 * ---------------------------------------------------------------------- */

/**
 * Where the sidecar publishes the port it found, for the parts of the process
 * that are in a different bundle.
 *
 * WHY AN ENVIRONMENT VARIABLE AND NOT A MODULE-LEVEL VARIABLE. Next compiles the
 * instrumentation entry and the proxy entry as separate Node-runtime bundles in
 * one process. A module imported by both is INSTANTIATED TWICE, so a value
 * assigned to a module-scoped binding during bootstrap is not the binding the
 * request path reads. `process.env` is the process, not a bundle, and it is the
 * smallest shared surface that does the job.
 *
 * IT IS NOT A SECRET AND IS NOT TREATED AS ONE. It is the port number of a
 * listener that every process on the machine can already enumerate. The secret
 * is the token, and that is never written here.
 *
 * It is set BY the sidecar, not by the shell -- the shell cannot know it. A
 * value already present at startup is therefore not trusted: `publishBoundPort`
 * overwrites it with what the handle table says.
 */
export const SIDECAR_ACTUAL_PORT_VAR = "LIBERTY_SIDECAR_ACTUAL_PORT";

export interface BoundAddress {
  readonly address: string;
  readonly family: string;
  readonly port: number;
}

export type ListenerDiscovery =
  | { readonly ok: true; readonly address: BoundAddress }
  | { readonly ok: false; readonly reason: string };

interface HandleLike {
  readonly address?: unknown;
  readonly listen?: unknown;
}

function addressOf(handle: unknown): BoundAddress | null {
  if (typeof handle !== "object" || handle === null) return null;
  const candidate = handle as HandleLike;
  if (typeof candidate.address !== "function") return null;
  /* A server listens; a socket does not. See the header. */
  if (typeof candidate.listen !== "function") return null;
  let reported: unknown;
  try {
    reported = (candidate.address as () => unknown).call(handle);
  } catch {
    /* A handle that has already closed throws or answers null. Neither is a
     * listener, and neither is an error worth propagating out of a scan. */
    return null;
  }
  if (typeof reported !== "object" || reported === null) return null;
  const record = reported as Record<string, unknown>;
  const address = record["address"];
  const port = record["port"];
  const family = record["family"];
  if (typeof address !== "string" || address === "") return null;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return { address, family: typeof family === "string" ? family : "", port };
}

/**
 * The one listening server among a set of handles.
 *
 * PURE: it is given the handles rather than fetching them, so the ambiguous and
 * empty cases are testable without a socket.
 *
 * TWO LISTENERS IS A REFUSAL, NOT A CHOICE. If something in the process has
 * opened a second server, there is no basis in the handle table for deciding
 * which one the shell is about to be told about, and picking the first is how a
 * handshake comes to advertise the wrong port. Distinct is measured by
 * address-and-port, so a single server reported twice is still one answer.
 */
export function discoverBoundAddress(handles: readonly unknown[]): ListenerDiscovery {
  const found = new Map<string, BoundAddress>();
  for (const handle of handles) {
    const address = addressOf(handle);
    if (address === null) continue;
    found.set(`${address.address}:${address.port}`, address);
  }
  const addresses = [...found.values()];
  if (addresses.length === 0) {
    return {
      ok: false,
      reason: `no listening server was found among ${handles.length} active handle(s)`
    };
  }
  if (addresses.length > 1) {
    return {
      ok: false,
      reason: `${addresses.length} listening servers were found (${addresses
        .map((one) => `${one.address}:${one.port}`)
        .join(", ")}); the sidecar cannot say which one the shell should be told about`
    };
  }
  const only = addresses[0];
  /* Narrowing for the compiler; `addresses.length === 1` already established it. */
  if (only === undefined) return { ok: false, reason: "no listening server was found" };
  return { ok: true, address: only };
}

/** The process's active handles, or an empty list where the internal is absent. */
export function activeHandles(): readonly unknown[] {
  const candidate = (process as unknown as Record<string, unknown>)["_getActiveHandles"];
  if (typeof candidate !== "function") return [];
  try {
    const handles = (candidate as () => unknown).call(process);
    return Array.isArray(handles) ? handles : [];
  } catch {
    return [];
  }
}

/** Records a discovered port where the request path's bundle can read it. */
export function publishBoundPort(
  port: number,
  env: Record<string, string | undefined> = process.env
): void {
  env[SIDECAR_ACTUAL_PORT_VAR] = String(port);
}

/**
 * The actual listening port, or `null` when this process never established one.
 *
 * `null` IS A REAL ANSWER AND THE CALLER MUST HANDLE IT. It is what a hosted
 * deployment returns, what an edge bundle returns, and what a sidecar returns
 * if discovery failed -- though in that last case the startup path has already
 * exited non-zero, so a request path observing it is not a state that should
 * outlive a millisecond.
 */
export function actualListeningPort(
  env: Readonly<Record<string, string | undefined>> = process.env
): number | null {
  const raw = env[SIDECAR_ACTUAL_PORT_VAR];
  if (raw === undefined || !/^[1-9][0-9]{0,4}$/.test(raw)) return null;
  const port = Number.parseInt(raw, 10);
  return port >= 1 && port <= 65535 ? port : null;
}

/**
 * The same answer, computed at most once per bundle instance.
 *
 * THE MEMO ONLY CACHES A HIT. `proxy.ts` states, correctly, that the
 * environment cannot change under a running server and so should be read once
 * rather than per request. This one variable is the exception it did not have:
 * the process WRITES it during bootstrap, and the proxy bundle may well have
 * been instantiated first. Caching a `null` would therefore freeze the answer
 * to "unknown" for the life of the process on the strength of having asked too
 * early -- which is the silent downgrade, arrived at by an optimisation.
 */
let memoisedPort: number | null = null;

export function listeningPortOnce(
  env: Readonly<Record<string, string | undefined>> = process.env
): number | null {
  if (memoisedPort !== null) return memoisedPort;
  memoisedPort = actualListeningPort(env);
  return memoisedPort;
}

/** Test seam; see `listeningPortOnce`. */
export function resetListeningPortMemo(): void {
  memoisedPort = null;
}
