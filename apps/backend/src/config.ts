/* -------------------------------------------------------------------------
 * How this service is configured, as a pure function of an environment
 *
 * NOTHING HERE READS `process.env`. Every function takes the environment it
 * should consider, so every refusal below is reachable from a unit test without
 * mutating a global -- the rule `apps/web`'s `build-target.ts`,
 * `catalog/home/handler.ts` and `auth-instance.ts` all follow, and the reason
 * PW-0403's configuration branches could be witnessed at all. `main.ts` is the
 * one module that reads the real environment.
 *
 * WHAT THIS SERVICE IS. The counterparty `docs/DESKTOP_PLAYBACK.md` section 8
 * rules must exist: the desktop build forwards `/api/v1/playback/session` to an
 * authenticated backend rather than resolving providers on the machine the
 * viewer administers. Until PW-0401 that counterparty existed only as
 * `e2e/src/backend-stub.mjs`.
 *
 * WHAT IT IS NOT: a second implementation of the route. The decision and the
 * HTTP envelope are imported from `@liberty/web` and executed unchanged -- see
 * `session-endpoint.ts` for why that is the only arrangement under which "the
 * same route contract, byte for byte" is a property rather than a comparison
 * somebody maintains.
 * ---------------------------------------------------------------------- */

/** A read-only view of an environment. The shape `process.env` has. */
export type Environment = Readonly<Record<string, string | undefined>>;

export const PORT_VAR = "LIBERTY_BACKEND_PORT";
export const HOST_VAR = "LIBERTY_BACKEND_HOST";
export const TLS_CERTIFICATE_VAR = "LIBERTY_BACKEND_TLS_CERT";
export const TLS_KEY_VAR = "LIBERTY_BACKEND_TLS_KEY";
export const TLS_TERMINATED_UPSTREAM_VAR = "LIBERTY_BACKEND_TLS_TERMINATED_UPSTREAM";

/**
 * The port, when the operator names none.
 *
 * 3102 because that is the port `e2e/src/backend-stub.mjs` already listens on
 * and `e2e/src/env.ts` already points the forwarder at. A different default
 * would mean the harness had to learn a second number for the same role, and
 * the first thing anybody would do is set the variable to 3102 anyway.
 */
export const DEFAULT_PORT = 3102;

/**
 * The interface, when the operator names none.
 *
 * LOOPBACK, WHICH IS THE FAIL-SAFE DIRECTION. A service that bound every
 * interface by default would be reachable from the network the moment somebody
 * started it to try it out, before any of the configuration below had been
 * thought about. Binding outward is an opt-in an operator types.
 */
export const DEFAULT_HOST = "127.0.0.1";

/**
 * How bytes reach this service.
 *
 * `tls` is this process terminating TLS itself, from a certificate and key an
 * operator supplies. `plaintext-behind-terminator` is this process serving
 * cleartext because something in front of it -- a load balancer, an ingress, a
 * service mesh -- has already terminated TLS.
 *
 * THE SECOND IS AN EXPLICIT ACKNOWLEDGEMENT AND NEVER A FALLBACK. The desktop
 * forwarder refuses any backend origin that is not `https:`, so a cleartext
 * backend is only ever correct behind a terminator that makes the origin https
 * from the caller's side. If an absent certificate quietly meant cleartext, the
 * failure mode would be a service that starts, works on a developer's machine
 * and ships a viewer's session cookie across a network in the clear. So an
 * absent certificate is a REFUSAL, and cleartext requires the operator to say
 * so by name.
 */
export type Transport =
  | { readonly kind: "tls"; readonly certificatePath: string; readonly keyPath: string }
  | { readonly kind: "plaintext-behind-terminator" };

export interface BackendConfiguration {
  readonly host: string;
  readonly port: number;
  readonly transport: Transport;
}

export type ConfigurationRefusalReason =
  | "transport_not_configured"
  | "tls_material_incomplete"
  | "port_not_a_port"
  | "host_blank";

export type ConfigurationResolution =
  | { readonly ok: true; readonly configuration: BackendConfiguration }
  | { readonly ok: false; readonly reason: ConfigurationRefusalReason; readonly detail: string };

function trimmed(environment: Environment, name: string): string {
  return (environment[name] ?? "").trim();
}

/**
 * The configuration, or the first thing wrong with it.
 *
 * FIRST RATHER THAN ALL, deliberately: an operator fixes one variable, restarts
 * and is told the next one. Collecting every fault would read better in a log
 * and would mean this function had to decide what a partially-configured
 * service looks like, which is a state it exists to prevent.
 */
export function resolveConfiguration(environment: Environment): ConfigurationResolution {
  const host = trimmed(environment, HOST_VAR) || DEFAULT_HOST;
  if (host === "") {
    return { ok: false, reason: "host_blank", detail: `${HOST_VAR} is set to blank` };
  }

  const rawPort = trimmed(environment, PORT_VAR);
  let port = DEFAULT_PORT;
  if (rawPort !== "") {
    /*
     * DIGITS FIRST, THEN `Number`, AND THE ORDER WAS FOUND BY THE TEST. Neither
     * half is sufficient alone. `parseInt("3102nonsense")` is 3102, so a
     * service would listen on a port nobody typed. `Number` is exact about
     * trailing rubbish but generous about NOTATION: `Number("1e3")` is 1000 and
     * `Number("0x10")` is 16, both integers in range, so an operator's typo
     * becomes a port they did not choose and cannot find. A port is written in
     * decimal digits, so that is what is accepted; everything else is refused
     * rather than interpreted.
     *
     * The range test is what makes "a port" mean a port: 0 is "any free port",
     * which is never what an operator means for a service something else must
     * dial.
     */
    port = /^\d+$/.test(rawPort) ? Number(rawPort) : Number.NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return {
        ok: false,
        reason: "port_not_a_port",
        detail: `${PORT_VAR} must be an integer from 1 to 65535`
      };
    }
  }

  const certificatePath = trimmed(environment, TLS_CERTIFICATE_VAR);
  const keyPath = trimmed(environment, TLS_KEY_VAR);
  const terminatedUpstream = trimmed(environment, TLS_TERMINATED_UPSTREAM_VAR) === "true";

  if (certificatePath !== "" || keyPath !== "") {
    if (certificatePath === "" || keyPath === "") {
      /*
       * HALF OF A KEYPAIR IS A MISCONFIGURATION AND NOT A DEGRADED MODE. The
       * tempting reading -- "they set a certificate, they meant TLS, fall back
       * to cleartext until they set the key" -- produces a running service on
       * the wrong transport, which is the outcome the acknowledgement below
       * exists to prevent.
       */
      return {
        ok: false,
        reason: "tls_material_incomplete",
        detail: `${TLS_CERTIFICATE_VAR} and ${TLS_KEY_VAR} are set together or not at all`
      };
    }
    return { ok: true, configuration: { host, port, transport: { kind: "tls", certificatePath, keyPath } } };
  }

  if (terminatedUpstream) {
    return {
      ok: true,
      configuration: { host, port, transport: { kind: "plaintext-behind-terminator" } }
    };
  }

  return {
    ok: false,
    reason: "transport_not_configured",
    detail:
      `set ${TLS_CERTIFICATE_VAR} and ${TLS_KEY_VAR} to terminate TLS here, or ` +
      `${TLS_TERMINATED_UPSTREAM_VAR}=true if something in front of this service already does. ` +
      "The desktop forwarder refuses a backend origin that is not https, so cleartext is only " +
      "ever correct behind a terminator."
  };
}
