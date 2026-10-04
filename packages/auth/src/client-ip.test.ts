import { describe, expect, it, vi } from "vitest";

import {
  CLIENT_IP_HEADERS,
  DIRECT_TOPOLOGY,
  TRUSTED_PROXIES_VARIABLE,
  clientIpDerivation,
  describeClientIpDerivation,
  resolveTrustedProxyTopology,
  type TrustedProxyTopology
} from "./client-ip";

/* -------------------------------------------------------------------------
 * Who may assert a client address (PL-0721)
 *
 * ==========================================================================
 * THIS SUITE DRIVES THE REAL LIBRARY, AND THAT IS THE POINT
 * ==========================================================================
 *
 * The thing worth proving is not that `clientIpDerivation` returns an object
 * with the fields this file expects. It is that the IDENTITY LIBRARY, handed
 * that object, refuses to let a caller choose its own rate-limit bucket. A
 * test that re-implemented the derivation and compared the two would pass
 * forever while the library did something else -- which is precisely the
 * failure mode `rate-limit.ts` was written to end, where a dependency's
 * default was this product's security posture and no line in this repository
 * said so.
 *
 * So every case below calls `getIP` from `better-auth/api` -- the same
 * function `resolveRateLimitConfig` calls to build the bucket key -- with
 * options produced by the module under test. `better-auth` is a declared
 * dependency of this package. `packages/auth`'s boundary rule is that
 * PRODUCTION code outside `better-auth.ts` must not acquire vendor types;
 * a test asserting the vendor's behaviour is the opposite of that hazard.
 *
 * ==========================================================================
 * THE ENVIRONMENT MATTERS AND IS SET DELIBERATELY
 * ==========================================================================
 *
 * `getIP` ends with `if (isTest() || isDevelopment()) return LOCALHOST_IP`.
 * Under vitest that branch is live, and it would make every case below answer
 * `127.0.0.1` -- which is a shared bucket, so SAFE, but it would also hide
 * every real answer and make a spoof test that proves nothing. `production()`
 * pins NODE_ENV for the duration of a call so the assertions are about the
 * configuration a deployment actually runs.
 *
 * That branch is itself worth one case, at the end, because it is the reason
 * a developer cannot observe this behaviour by running the app locally.
 * ---------------------------------------------------------------------- */

const SIGN_IN = "https://liberty.test/api/auth/sign-in/email";

type GetIP = (request: Request, options: never) => string | null;

/* -------------------------------------------------------------------------
 * RUNNING THE LIBRARY AS A DEPLOYMENT RUNS IT, WHICH TOOK TWO ATTEMPTS
 *
 * `@better-auth/core`'s env module decides twice, and the two halves have
 * different lifetimes:
 *
 *     const nodeENV = env.NODE_ENV ?? "";          // captured at module load
 *     const isTest = () => nodeENV === "test" || toBoolean(env.TEST);
 *                                                  // `env.TEST` read LIVE
 *
 * and `getIP` ends with `if (isTest() || isDevelopment()) return
 * LOCALHOST_IP`. Under vitest BOTH halves are true, so every case here would
 * answer `127.0.0.1` -- safe, since one constant for everybody is the shared
 * bucket, but it would hide every real answer and make the spoof test below
 * prove nothing at all.
 *
 * So NODE_ENV has to be set before the module is EVALUATED -- hence the
 * dynamic import and `vi.resetModules()` -- and `TEST` has to be absent when
 * the function is CALLED, because that half is re-read every time. The first
 * draft of this file got the first right and the second wrong: it restored
 * the runner's `TEST=true` in a `finally` before any call, and three cases
 * failed with `127.0.0.1`. Written down because the asymmetry is invisible
 * from the call site and the failure looks like a bug in the module under
 * test.
 * ---------------------------------------------------------------------- */

const RUNNER_FLAGS = ["TEST", "VITEST"] as const;

/** Run `work` with the test-runner's markers out of the environment. */
function asADeployment<T>(nodeEnv: string, work: () => T): T {
  const saved = new Map<string, string | undefined>([
    ["NODE_ENV", process.env["NODE_ENV"]],
    ...RUNNER_FLAGS.map((flag) => [flag, process.env[flag]] as [string, string | undefined])
  ]);
  process.env["NODE_ENV"] = nodeEnv;
  for (const flag of RUNNER_FLAGS) delete process.env[flag];
  try {
    return work();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const LOADED = new Map<string, Promise<GetIP>>();

/**
 * The library's own `getIP`, evaluated as the given NODE_ENV would see it.
 *
 * NOT `asADeployment(nodeEnv, async () => ...)`, WHICH IS WHAT THIS WAS AND
 * WHY IT DID NOT WORK. That helper restores the environment in a `finally`,
 * and an async callback RETURNS A PROMISE SYNCHRONOUSLY -- so the restore ran
 * before the dynamic import had evaluated anything, and the module captured
 * the runner's `NODE_ENV=test` after all. The save and restore have to span
 * the `await`, so they are written out here rather than borrowed.
 */
async function evaluateGetIP(nodeEnv: string): Promise<GetIP> {
  const savedNodeEnv = process.env["NODE_ENV"];
  const savedFlags = RUNNER_FLAGS.map((flag) => [flag, process.env[flag]] as const);
  process.env["NODE_ENV"] = nodeEnv;
  for (const flag of RUNNER_FLAGS) delete process.env[flag];
  try {
    vi.resetModules();
    return ((await import("better-auth/api")) as { getIP: GetIP }).getIP;
  } finally {
    if (savedNodeEnv === undefined) delete process.env["NODE_ENV"];
    else process.env["NODE_ENV"] = savedNodeEnv;
    for (const [flag, value] of savedFlags) {
      if (value !== undefined) process.env[flag] = value;
    }
  }
}

function loadGetIP(nodeEnv: string): Promise<GetIP> {
  const already = LOADED.get(nodeEnv);
  if (already !== undefined) return already;
  const started = evaluateGetIP(nodeEnv);
  LOADED.set(nodeEnv, started);
  return started;
}

/** `getIP` under production semantics, at load time AND at call time. */
async function resolveAsync(
  headers: Record<string, string>,
  options: unknown
): Promise<string | null> {
  const getIP = await loadGetIP("production");
  return asADeployment("production", () =>
    getIP(new Request(SIGN_IN, { headers }), options as never)
  );
}

/** The options this product would pass for a given topology. */
function optionsFor(topology: TrustedProxyTopology): unknown {
  return { advanced: { ipAddress: clientIpDerivation(topology) } };
}

const BEHIND_PROXIES: TrustedProxyTopology = { kind: "behind-proxies", hops: ["10.0.0.0/8"] };

describe("the defect this task exists to close, reproduced against the real library", () => {
  it("UNCONFIGURED, THE LIBRARY LETS A CALLER PICK ITS OWN BUCKET", async () => {
    /*
     * NOT A STRAW MAN -- THIS WAS THIS PRODUCT'S BEHAVIOUR. `better-auth.ts`
     * passed no `advanced.ipAddress`, so the library's own default applied:
     * `DEFAULT_IP_HEADERS = ["x-forwarded-for"]`, and a header carrying one
     * valid address is accepted with no trusted hop having vouched for it.
     *
     * Two values, two answers, from one caller who wrote the header itself.
     * The bucket key is `<ip>|<path>`, so that is an unbounded number of
     * three-attempt windows against the credential endpoint.
     */
    expect(await resolveAsync({ "x-forwarded-for": "203.0.113.9" }, {})).toBe("203.0.113.9");
    expect(await resolveAsync({ "x-forwarded-for": "198.51.100.7" }, {})).toBe("198.51.100.7");
  });

  it("and the same caller under the configured default cannot", async () => {
    const options = optionsFor(DIRECT_TOPOLOGY);
    expect(await resolveAsync({ "x-forwarded-for": "203.0.113.9" }, options)).toBeNull();
    expect(await resolveAsync({ "x-forwarded-for": "198.51.100.7" }, options)).toBeNull();
  });
});

describe("the default topology reads nothing a caller can write", () => {
  const options = optionsFor(DIRECT_TOPOLOGY);

  it("resolves no address at all, which is the shared-bucket fallback", async () => {
    /*
     * `null` is the REQUIRED outcome, not a gap. The acceptance says the
     * shared-bucket fallback must remain reachable and correct when no
     * topology is configured: removing it in favour of trusting something is
     * the failure this task exists to prevent.
     */
    expect(await resolveAsync({}, options)).toBeNull();
  });

  it("ignores every forwarded header, including ones it does not name", async () => {
    /*
     * IGNORED, NOT MERGED AND NOT PARTIALLY HONOURED. An untrusted forwarded
     * header is an attacker-supplied string, and the way to be sure none of
     * it reaches a decision is for no header to be read at all -- which is
     * what an empty `ipAddressHeaders` means.
     */
    const everything = {
      "x-forwarded-for": "203.0.113.9",
      "x-real-ip": "198.51.100.7",
      forwarded: "for=192.0.2.60;proto=http;by=203.0.113.43",
      "cf-connecting-ip": "192.0.2.1",
      "true-client-ip": "192.0.2.2",
      "x-client-ip": "192.0.2.3"
    };
    expect(await resolveAsync(everything, options)).toBeNull();
  });

  it("names no trusted proxies, because an empty list is not the same as none", () => {
    /*
     * A STRUCTURAL ASSERTION, AND IT GUARDS A REAL TRAP. The library branches
     * on `trustedProxies.length > 0`; an empty array falls into the
     * single-value branch, which is the spoof in the first describe. So
     * `direct` must omit the key, not supply `[]`, and this is what notices
     * if somebody "tidies" it to an empty array.
     */
    const derivation = clientIpDerivation(DIRECT_TOPOLOGY);
    expect(derivation.ipAddressHeaders).toEqual([]);
    expect("trustedProxies" in derivation).toBe(false);
  });
});

describe("a configured topology derives the client, and discards what a client prepended", () => {
  const options = optionsFor(BEHIND_PROXIES);

  it("takes the address the trusted hop vouched for", async () => {
    expect(await resolveAsync({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }, options)).toBe("203.0.113.9");
  });

  it("walks back through a chain longer than one hop", async () => {
    /*
     * The acceptance asks for this case by name. Two trusted hops in sequence
     * -- an edge proxy and an internal one -- must not make the real client
     * look like the first of them.
     */
    expect(await resolveAsync({ "x-forwarded-for": "203.0.113.9, 10.0.0.1, 10.1.2.3" }, options)).toBe(
      "203.0.113.9"
    );
  });

  it("THE SPOOF TEST: a prepended lie does not become the client", async () => {
    /*
     * THE CASE THE WHOLE TASK EXISTS FOR. The client writes `9.9.9.9` into
     * the header before the request leaves it; the proxy appends the address
     * it actually saw. Walking from the RIGHT means the first untrusted entry
     * is the one the trusted hop put there -- the real client -- and
     * everything to the left of it is discarded unread.
     *
     * The leftmost token is what a naive implementation takes, and a naive
     * implementation would return "9.9.9.9" here. That is the assertion.
     */
    const spoofed = { "x-forwarded-for": "9.9.9.9, 203.0.113.9, 10.0.0.1" };
    expect(await resolveAsync(spoofed, options)).toBe("203.0.113.9");
    expect(await resolveAsync(spoofed, options)).not.toBe("9.9.9.9");
  });

  it("one caller cannot become many by varying what it prepends", async () => {
    /*
     * THE RATE-LIMIT IDENTITY TEST, first half. Three requests from one
     * client behind the proxy, each prepending something different: all three
     * must land on the same address, therefore the same bucket. If any
     * prepended value changed the answer, the limit would be defeated by a
     * loop.
     */
    const asSeenFor = (prepended: string): Promise<string | null> =>
      resolveAsync({ "x-forwarded-for": `${prepended}, 203.0.113.9, 10.0.0.1` }, options);

    const answers = await Promise.all(["9.9.9.9", "8.8.8.8", "::1", "not-an-ip"].map(asSeenFor));
    expect(new Set(answers)).toEqual(new Set(["203.0.113.9"]));
  });

  it("two genuinely different callers get two different identities", async () => {
    /*
     * THE OTHER HALF, AND IT IS NOT REDUNDANT. A derivation that answered one
     * constant would pass every assertion above -- nobody could spoof it,
     * because nobody could influence it -- and would also give a household in
     * Oslo and an attacker in a datacentre the same bucket. Distinctness is a
     * requirement, not a side effect.
     */
    const first = await resolveAsync({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }, options);
    const second = await resolveAsync({ "x-forwarded-for": "198.51.100.7, 10.0.0.1" }, options);
    expect(first).not.toBe(second);
    expect(first).toBe("203.0.113.9");
    expect(second).toBe("198.51.100.7");
  });

  it("IPv6 clients are derived too, and are not silently dropped", async () => {
    /*
     * A dropped IPv6 client would fall into the shared bucket, which is safe
     * but would mean every IPv6 viewer sharing three sign-ins per ten seconds
     * while IPv4 viewers got their own. Asserted loosely -- the library
     * normalises IPv6 to a /64 by default, which is a deliberate choice of
     * its own and not this task's to pin -- but it must be an address and it
     * must distinguish two different networks.
     */
    const one = await resolveAsync({ "x-forwarded-for": "2001:db8:1::5, 10.0.0.1" }, options);
    const two = await resolveAsync({ "x-forwarded-for": "2001:db8:2::5, 10.0.0.1" }, options);
    expect(one).not.toBeNull();
    expect(one).not.toBe(two);
  });
});

describe("the environment states the topology, and every silence means trust nobody", () => {
  it("an unset variable is direct", () => {
    expect(resolveTrustedProxyTopology({})).toEqual({ ok: true, topology: DIRECT_TOPOLOGY });
  });

  it("an empty or blank variable is direct, because those are how it goes unset by accident", () => {
    for (const raw of ["", "   ", "\t\n"]) {
      expect(
        resolveTrustedProxyTopology({ [TRUSTED_PROXIES_VARIABLE]: raw }),
        JSON.stringify(raw)
      ).toEqual({ ok: true, topology: DIRECT_TOPOLOGY });
    }
  });

  it("reads a list of hops, trimming the spaces a human leaves", () => {
    expect(
      resolveTrustedProxyTopology({ [TRUSTED_PROXIES_VARIABLE]: "10.0.0.0/8, 192.168.1.1" })
    ).toEqual({ ok: true, topology: { kind: "behind-proxies", hops: ["10.0.0.0/8", "192.168.1.1"] } });
  });

  it("accepts the forms a real topology is written in", () => {
    for (const hop of [
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.1.1",
      "0.0.0.0/0",
      "2001:db8::/32",
      "::1",
      "fd00::/8",
      "2001:0db8:0000:0000:0000:0000:0000:0001"
    ]) {
      const resolution = resolveTrustedProxyTopology({ [TRUSTED_PROXIES_VARIABLE]: hop });
      expect(resolution.ok, `${hop}: ${resolution.ok ? "" : resolution.problems.join("; ")}`).toBe(
        true
      );
    }
  });

  it("REFUSES rather than quietly falling back to direct", () => {
    /*
     * THE DIRECTION OF THIS FAILURE IS THE WHOLE DESIGN. A deployment that
     * INTENDED to trust its proxy and mistyped one entry must not start: the
     * library filters unparseable entries out silently, and a list that
     * filters down to empty lands in the single-value branch -- re-opening
     * the spoof, in a deployment whose operator believes it is configured.
     * So an unparseable entry is a start-up failure with the entry named.
     */
    for (const hop of [
      "proxy.internal",
      "10.0.0.0/33",
      "2001:db8::/129",
      "10.0.0.256",
      "10.0.0.1/eight",
      "010.0.0.1",
      "10.0.0.0/8,,192.168.1.1",
      "2001:db8::1%eth0",
      "1:2:3:4:5:6:7:8:9"
    ]) {
      const resolution = resolveTrustedProxyTopology({ [TRUSTED_PROXIES_VARIABLE]: hop });
      expect(resolution.ok, hop).toBe(false);
      if (!resolution.ok) {
        expect(resolution.problems.join(" "), hop).toContain(TRUSTED_PROXIES_VARIABLE);
      }
    }
  });

  it("names every bad entry, not just the first", () => {
    const resolution = resolveTrustedProxyTopology({
      [TRUSTED_PROXIES_VARIABLE]: "proxy.internal, 10.0.0.0/8, 10.0.0.256"
    });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.problems).toHaveLength(2);
      expect(resolution.problems.join(" ")).toContain("proxy.internal");
      expect(resolution.problems.join(" ")).toContain("10.0.0.256");
    }
  });
});

describe("this parser and the library's agree about every hop this one accepts", () => {
  /*
   * THE DRIFT THIS CLOSES. This module's validation is deliberately narrower
   * than the library's, so that a doubtful entry is a loud refusal rather
   * than a silent filter. Narrower is only safe if it is a SUBSET: an entry
   * accepted here that the library then discarded would leave `trustedProxies`
   * shorter than configured, and if it emptied the list entirely the spoof
   * would be back -- in a deployment that believes it is configured.
   *
   * So every accepted form is driven through the real `getIP`: a chain whose
   * rightmost hop IS that proxy must resolve to the client in front of it. If
   * the library had rejected the entry, the chain would resolve to the proxy
   * itself and this fails.
   */
  const CLIENT = "203.0.113.9";
  const cases: readonly { readonly hop: string; readonly proxy: string }[] = [
    { hop: "10.0.0.0/8", proxy: "10.4.5.6" },
    { hop: "172.16.0.0/12", proxy: "172.16.9.9" },
    { hop: "192.168.1.1", proxy: "192.168.1.1" },
    { hop: "2001:db8::/32", proxy: "2001:db8:dead:beef::1" },
    { hop: "fd00::/8", proxy: "fd00::abcd" },
    { hop: "2001:0db8:0000:0000:0000:0000:0000:0001", proxy: "2001:db8::1" }
  ];

  for (const { hop, proxy } of cases) {
    it(`the library honours ${hop}`, async () => {
      const resolution = resolveTrustedProxyTopology({ [TRUSTED_PROXIES_VARIABLE]: hop });
      expect(resolution.ok).toBe(true);
      if (!resolution.ok) return;

      const resolved = await resolveAsync(
        { "x-forwarded-for": `${CLIENT}, ${proxy}` },
        optionsFor(resolution.topology)
      );
      expect(resolved, `${hop} did not cover ${proxy}; the library discarded the entry`).toBe(
        CLIENT
      );
    });
  }
});

describe("what a reader of the surface report is told", () => {
  it("the default says what it costs and what to do about it", () => {
    const line = describeClientIpDerivation(DIRECT_TOPOLOGY);
    expect(line).toContain("shared bucket");
    expect(line).toContain(TRUSTED_PROXIES_VARIABLE);
  });

  it("a configured topology names the hops and the precondition", () => {
    const line = describeClientIpDerivation(BEHIND_PROXIES);
    expect(line).toContain("10.0.0.0/8");
    expect(line).toContain(CLIENT_IP_HEADERS[0] ?? "");
    /* The precondition is not a footnote: configuring this on a deployment
     * whose origin is publicly reachable is worse than leaving it unset. */
    expect(line).toContain("unreachable except through");
  });
});

describe("the development fallback, named so nobody learns it the hard way", () => {
  it("resolves every caller to localhost, which is a shared bucket and not a spoof", async () => {
    /*
     * `getIP` ends with `if (isTest() || isDevelopment()) return LOCALHOST_IP`.
     * This is why a developer running locally cannot observe either the
     * defect or its fix, and it is why every other case in this file pins
     * NODE_ENV=production.
     *
     * It is SAFE -- one constant for everybody is the shared bucket, and no
     * header influences it, so nothing can be spoofed. It is asserted here
     * rather than left implicit because "I tested it locally and the header
     * did nothing" is a conclusion somebody would otherwise draw about
     * production.
     */
    const inDevelopment = await loadGetIP("development");
    const options = optionsFor(DIRECT_TOPOLOGY) as never;

    expect(inDevelopment(new Request(SIGN_IN), options)).toBe("127.0.0.1");
    expect(
      inDevelopment(new Request(SIGN_IN, { headers: { "x-forwarded-for": "9.9.9.9" } }), options)
    ).toBe("127.0.0.1");

    /* AND THE PRODUCTION MODULE IS STILL THE PRODUCTION ONE. `vi.resetModules`
     * gave this case its own evaluation; if it had replaced the shared one,
     * every assertion in this file would quietly become a statement about
     * development. */
    expect(await resolveAsync({ "x-forwarded-for": "9.9.9.9" }, optionsFor(DIRECT_TOPOLOGY))).toBeNull();
  });
});
