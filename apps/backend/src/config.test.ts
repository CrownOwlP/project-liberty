import { describe, expect, it } from "vitest";

import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  HOST_VAR,
  PORT_VAR,
  TLS_CERTIFICATE_VAR,
  TLS_KEY_VAR,
  TLS_TERMINATED_UPSTREAM_VAR,
  resolveConfiguration
} from "./config";

/**
 * Configuration (PW-0401).
 *
 * Every branch here is reachable without mutating `process.env`, which is the
 * reason `resolveConfiguration` takes an environment instead of reading one.
 */

const TLS = {
  [TLS_CERTIFICATE_VAR]: "/etc/liberty/backend.crt",
  [TLS_KEY_VAR]: "/etc/liberty/backend.key"
} as const;

describe("the transport is never guessed", () => {
  it("refuses to start with no transport stated at all", () => {
    /*
     * THE CENTRAL REFUSAL OF THIS MODULE. The tempting default -- cleartext
     * until somebody configures TLS -- produces a service that works on a
     * developer's machine and carries a viewer's session cookie across a
     * network in the clear in production. The desktop forwarder refuses any
     * backend origin that is not https, so cleartext is only ever correct
     * behind a terminator, and that is a fact only the operator knows.
     */
    const resolution = resolveConfiguration({});
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.reason).toBe("transport_not_configured");
      expect(resolution.detail).toContain(TLS_CERTIFICATE_VAR);
      expect(resolution.detail).toContain(TLS_TERMINATED_UPSTREAM_VAR);
    }
  });

  it("terminates TLS itself when given both halves of the keypair", () => {
    const resolution = resolveConfiguration(TLS);
    expect(resolution).toEqual({
      ok: true,
      configuration: {
        host: DEFAULT_HOST,
        port: DEFAULT_PORT,
        transport: {
          kind: "tls",
          certificatePath: "/etc/liberty/backend.crt",
          keyPath: "/etc/liberty/backend.key"
        }
      }
    });
  });

  it("refuses half a keypair rather than falling back to cleartext", () => {
    for (const half of [{ [TLS_CERTIFICATE_VAR]: "/c" }, { [TLS_KEY_VAR]: "/k" }]) {
      const resolution = resolveConfiguration(half);
      expect(resolution.ok).toBe(false);
      if (!resolution.ok) expect(resolution.reason).toBe("tls_material_incomplete");
    }
  });

  it("refuses half a keypair even when cleartext was acknowledged", () => {
    /*
     * The acknowledgement says "something in front of me terminates TLS". A
     * certificate path beside it says the operator also meant to terminate it
     * here. Those are two different intentions and one of them is a mistake;
     * picking either silently is how a service ends up on the transport nobody
     * chose.
     */
    const resolution = resolveConfiguration({
      [TLS_CERTIFICATE_VAR]: "/c",
      [TLS_TERMINATED_UPSTREAM_VAR]: "true"
    });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.reason).toBe("tls_material_incomplete");
  });

  it("serves cleartext only when the operator says so by name", () => {
    const resolution = resolveConfiguration({ [TLS_TERMINATED_UPSTREAM_VAR]: "true" });
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.configuration.transport).toEqual({ kind: "plaintext-behind-terminator" });
    }
  });

  it("does not read a near-miss as the acknowledgement", () => {
    /*
     * `"TRUE"`, `"1"` and `"yes"` are all refused. A permissive read of this
     * particular variable is a permissive read of "send session cookies in the
     * clear", so the exact string is the whole vocabulary.
     */
    for (const value of ["TRUE", "True", "1", "yes", "on", " true "]) {
      const resolution = resolveConfiguration({ [TLS_TERMINATED_UPSTREAM_VAR]: value });
      const acknowledged = resolution.ok;
      expect(acknowledged, value).toBe(value.trim() === "true");
    }
  });
});

describe("where it listens", () => {
  it("binds loopback unless told otherwise", () => {
    /*
     * The fail-safe direction. A service that bound every interface by default
     * would be reachable from the network the moment somebody started it to try
     * it out, before any of the transport configuration above was considered.
     */
    const resolution = resolveConfiguration(TLS);
    expect(resolution.ok && resolution.configuration.host).toBe("127.0.0.1");
  });

  it("binds what an operator names", () => {
    const resolution = resolveConfiguration({ ...TLS, [HOST_VAR]: "0.0.0.0" });
    expect(resolution.ok && resolution.configuration.host).toBe("0.0.0.0");
  });

  it("defaults to the port the harness already dials", () => {
    expect(DEFAULT_PORT).toBe(3102);
  });

  it("refuses anything that is not a port", () => {
    for (const value of ["0", "-1", "65536", "3102nonsense", "http", "3102.5", "1e3"]) {
      const resolution = resolveConfiguration({ ...TLS, [PORT_VAR]: value });
      expect(resolution.ok, value).toBe(false);
      if (!resolution.ok) expect(resolution.reason).toBe("port_not_a_port");
    }
  });

  it("accepts a port, trimmed", () => {
    const resolution = resolveConfiguration({ ...TLS, [PORT_VAR]: " 8443\n" });
    expect(resolution.ok && resolution.configuration.port).toBe(8443);
  });
});
