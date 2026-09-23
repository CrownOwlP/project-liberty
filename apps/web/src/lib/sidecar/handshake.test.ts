/* The port handshake (PW-0101). The shell points a webview at whatever this
 * parses, so every refusal here is a window that never opens on the wrong thing. */
import { describe, expect, it } from "vitest";

import { HANDSHAKE_PREFIX, formatHandshake, parseHandshake } from "./handshake";

describe("the sidecar reports the port it bound", () => {
  it("round-trips", () => {
    const line = formatHandshake({ host: "127.0.0.1", port: 51234 });
    const parsed = parseHandshake(line);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.handshake).toEqual({ host: "127.0.0.1", port: 51234 });
  });

  it("is findable among the rest of the child's stdout", () => {
    /* The prefix exists because Next logs whatever it likes on the same pipe. */
    const lines = ["   ▲ Next.js 16.3.1", "   - Local: http://127.0.0.1:51234", formatHandshake({ host: "127.0.0.1", port: 51234 })];
    const found = lines.map(parseHandshake).filter((r) => r.ok);
    expect(found).toHaveLength(1);
  });

  it("ignores a line that is not a handshake, rather than throwing", () => {
    expect(parseHandshake("ready").ok).toBe(false);
    expect(parseHandshake("").ok).toBe(false);
  });

  it("refuses a non-loopback host", () => {
    /* The shell would otherwise advertise a LAN-reachable origin as its own. */
    const line = `${HANDSHAKE_PREFIX} ${JSON.stringify({ host: "0.0.0.0", port: 3000 })}`;
    const parsed = parseHandshake(line);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("not loopback");
  });

  it("refuses a malformed body instead of half-reading it", () => {
    for (const body of ["{", "[]", "7", '{"host":"127.0.0.1"}', '{"port":80}', '{"host":"127.0.0.1","port":0}', '{"host":"127.0.0.1","port":70000}', '{"host":"127.0.0.1","port":"80"}']) {
      expect(parseHandshake(`${HANDSHAKE_PREFIX} ${body}`).ok, body).toBe(false);
    }
  });
});
