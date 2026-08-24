import { describe, expect, it } from "vitest";
import { resolveAuthConfig } from "./config";

/**
 * Auth configuration (PL-0401).
 *
 * Configuration validation is worth testing for one reason: every failure it
 * catches is a misconfiguration that would otherwise produce a system that
 * STARTS. A short secret, a session that can never refresh and a missing base
 * URL all boot cleanly and then misbehave in production under load or under
 * attack, which is the worst possible place to discover them.
 */

const valid = {
  databaseUrl: "postgres://liberty:secret@localhost:5432/liberty",
  baseUrl: "https://liberty.example",
  secret: "0123456789abcdef0123456789abcdef",
  trustedOrigins: []
};

describe("resolveAuthConfig", () => {
  it("accepts a minimal valid configuration and fills the documented defaults", () => {
    const resolved = resolveAuthConfig(valid);

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.config.requireEmailVerification).toBe(true);
    expect(resolved.config.sessionExpiresInSeconds).toBe(60 * 60 * 24 * 14);
    expect(resolved.config.sessionUpdateAgeSeconds).toBeLessThan(
      resolved.config.sessionExpiresInSeconds
    );
  });

  it("defaults to REQUIRING email verification", () => {
    // Stated as its own test because the convenient default is the opposite one
    // and it is the kind of thing that gets flipped during local development
    // and never flipped back.
    const resolved = resolveAuthConfig(valid);
    expect(resolved.ok && resolved.config.requireEmailVerification).toBe(true);
  });

  it("rejects a secret short enough to be brute-forced", () => {
    const resolved = resolveAuthConfig({ ...valid, secret: "short" });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.problems.join()).toContain("secret");
  });

  it("rejects a refresh window that can never fire", () => {
    // updateAge >= expiresIn means an in-use session is never extended and
    // simply dies mid-use. It is arithmetically wrong rather than merely
    // aggressive, which is why it is a hard failure and not a warning.
    const resolved = resolveAuthConfig({
      ...valid,
      sessionExpiresInSeconds: 60 * 60 * 24,
      sessionUpdateAgeSeconds: 60 * 60 * 24
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.problems.join()).toContain("sessionUpdateAgeSeconds");
  });

  it("rejects a session shorter than a feature film", () => {
    const resolved = resolveAuthConfig({ ...valid, sessionExpiresInSeconds: 600 });
    expect(resolved.ok).toBe(false);
  });

  it("reports every problem at once, in a stable order", () => {
    const resolved = resolveAuthConfig({ baseUrl: "not-a-url", secret: "short" });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    // More than one thing is wrong and the operator should learn all of it in
    // one restart. Sorted so that the same broken environment always produces
    // the same message, which is what makes the message diffable in CI.
    expect(resolved.problems.length).toBeGreaterThan(1);
    expect([...resolved.problems].sort()).toEqual(resolved.problems);
  });

  it("cannot express a wildcard trusted origin", () => {
    // `["*"]` is not a URL, so the schema refuses it. The failure mode being
    // prevented is a permissive CORS-ish setting copied out of a tutorial.
    expect(resolveAuthConfig({ ...valid, trustedOrigins: ["*"] }).ok).toBe(false);
  });
});
