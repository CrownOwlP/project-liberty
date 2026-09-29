/* What the process is actually listening on (PW-0105).
 *
 * EVERY CASE HERE IS FED A HANDLE TABLE RATHER THAN A SOCKET. The awkward
 * outcomes -- no listener, two listeners, a handle that throws when asked, an
 * outbound connection whose local port is an ephemeral number -- are the ones
 * that decide whether the handshake reports the truth, and they are close to
 * impossible to produce on demand against a real server. `discoverBoundAddress`
 * takes the handles as an argument so they can simply be written down. */
import { afterEach, describe, expect, it } from "vitest";

import {
  SIDECAR_ACTUAL_PORT_VAR,
  actualListeningPort,
  activeHandles,
  discoverBoundAddress,
  listeningPortOnce,
  publishBoundPort,
  resetListeningPortMemo
} from "./listener";

/** A `net.Server`: it answers `address()` and it has `listen`. */
const server = (address: string, port: number, family = "IPv4") => ({
  address: () => ({ address, port, family }),
  listen: () => undefined
});

/** A `net.Socket`: same `address()` shape, NO `listen`. */
const socket = (address: string, port: number) => ({
  address: () => ({ address, port, family: "IPv4" })
});

afterEach(() => {
  resetListeningPortMemo();
  delete process.env[SIDECAR_ACTUAL_PORT_VAR];
});

describe("finding the one listening server", () => {
  it("reports the bound address of a single server", () => {
    const found = discoverBoundAddress([server("127.0.0.1", 52341)]);
    expect(found).toEqual({ ok: true, address: { address: "127.0.0.1", port: 52341, family: "IPv4" } });
  });

  it("IGNORES SOCKETS, whose local port is not the listener's", () => {
    /*
     * The failure this prevents is intermittent and would look like nothing.
     * Once the process is serving, the handle table holds accepted connections
     * and any outbound socket the application opened; an outbound socket's
     * local port is an ephemeral number chosen by the kernel for that
     * connection. Accepting one would make the Host port comparison refuse
     * valid traffic at random, in production only, under load only.
     */
    const found = discoverBoundAddress([
      socket("127.0.0.1", 41999),
      server("127.0.0.1", 52341),
      socket("10.0.0.5", 44123)
    ]);
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.address.port).toBe(52341);
  });

  it("treats one server reported twice as one answer", () => {
    const one = server("127.0.0.1", 52341);
    const found = discoverBoundAddress([one, one, server("127.0.0.1", 52341)]);
    expect(found.ok).toBe(true);
  });

  it("REFUSES rather than guesses when two different servers are listening", () => {
    const found = discoverBoundAddress([server("127.0.0.1", 52341), server("127.0.0.1", 52342)]);
    expect(found.ok).toBe(false);
    if (!found.ok) {
      expect(found.reason).toContain("52341");
      expect(found.reason).toContain("52342");
    }
  });

  it("refuses when nothing in the table is a server, and says how many it looked at", () => {
    const found = discoverBoundAddress([socket("127.0.0.1", 41999), {}, null, 7, "x"]);
    expect(found.ok).toBe(false);
    if (!found.ok) expect(found.reason).toContain("5 active handle(s)");
  });

  it("survives a handle that throws or answers nonsense when asked", () => {
    const throws = {
      address: () => {
        throw new Error("already closed");
      },
      listen: () => undefined
    };
    const nonsense = { address: () => null, listen: () => undefined };
    const portless = { address: () => ({ address: "127.0.0.1" }), listen: () => undefined };
    const zero = { address: () => ({ address: "127.0.0.1", port: 0 }), listen: () => undefined };
    const found = discoverBoundAddress([throws, nonsense, portless, zero, server("127.0.0.1", 52341)]);
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.address.port).toBe(52341);
  });

  it("reports a non-loopback bind faithfully rather than hiding it", () => {
    /* Refusing it is `bootstrap.ts`'s job. Discovery must not quietly drop the
     * one address whose presence is the emergency. */
    const found = discoverBoundAddress([server("0.0.0.0", 3000)]);
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.address.address).toBe("0.0.0.0");
  });
});

describe("the handle table this process really has", () => {
  it("is readable, and returns an array whatever Node does", () => {
    /* Not an assertion about the count -- a test runner's process holds
     * whatever it holds. This is the guard against the undocumented internal
     * disappearing: it must degrade to an empty list, never throw. */
    expect(Array.isArray(activeHandles())).toBe(true);
  });
});

describe("publishing the port across bundle boundaries", () => {
  it("round-trips through the environment", () => {
    const env: Record<string, string | undefined> = {};
    publishBoundPort(52341, env);
    expect(env[SIDECAR_ACTUAL_PORT_VAR]).toBe("52341");
    expect(actualListeningPort(env)).toBe(52341);
  });

  it("reads nothing out of an unset, empty or junk value", () => {
    for (const raw of [undefined, "", "0", "-1", "65536", "080", "3000x", " 3000"]) {
      expect(actualListeningPort({ [SIDECAR_ACTUAL_PORT_VAR]: raw }), `${raw} is not a port`).toBeNull();
    }
  });

  it("CACHES A HIT AND NEVER A MISS", () => {
    /*
     * The proxy bundle may be instantiated before the bootstrap that writes the
     * value. Caching the early `null` would freeze the port comparison off for
     * the life of the process -- a silent downgrade arrived at by an
     * optimisation, which is the shape the ruling forbids.
     */
    expect(listeningPortOnce()).toBeNull();
    publishBoundPort(52341);
    expect(listeningPortOnce()).toBe(52341);
    delete process.env[SIDECAR_ACTUAL_PORT_VAR];
    expect(listeningPortOnce(), "a hit is cached").toBe(52341);
  });
});
