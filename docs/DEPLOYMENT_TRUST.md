# Deployment trust: which hop may assert a client address

**Task:** PL-0721. **Ruling it implements:** gpt-architect's round-110 security
review of PL-0719.

This document states one thing: **who, in front of this application, is allowed
to tell it where a request came from.** The default answer is **nobody**, and
that is deliberate.

---

## 1. The short version

| | |
|---|---|
| Variable | `LIBERTY_TRUSTED_PROXIES` |
| Default when unset, empty or blank | **Trust nobody.** No forwarded header is read. |
| Format | A comma-separated list of IPv4/IPv6 addresses or CIDR ranges |
| Example | `LIBERTY_TRUSTED_PROXIES=10.0.0.0/8` |
| A value that will not parse | **The application refuses to start**, naming the entry |
| Header read when configured | `x-forwarded-for`, and nothing else |

If you are not sure, **leave it unset**. The cost is stated in §3 and it is a
cost you will notice; the cost of getting it wrong is one you will not.

---

## 2. What this is for

The identity library rate-limits authentication by **client IP and path** —
three credential attempts per ten seconds per address, a policy
`packages/auth/src/rate-limit.ts` owns and explains. That control is only worth
anything if the address cannot be chosen by the caller.

Behind a reverse proxy, every request arrives from the proxy, so the client's
real address is only knowable from a header the proxy adds. A header is just a
string the request carries, and the application cannot tell by looking whether
a given `X-Forwarded-For` was appended by your load balancer or typed by an
attacker. **The only thing that makes the difference is knowing which hop put
it there** — which is what this variable states.

### 2.1 The defect this closed

The library's default is not "resolve nothing". It is to read
`x-forwarded-for`, and — with no trusted hop configured — to accept a header
carrying exactly one valid address. Until PL-0721, this application passed no
configuration at all, so that default was its behaviour. Driving the library's
own `getIP` under `NODE_ENV=production` with no options:

```
no headers                                -> null
x-forwarded-for: "203.0.113.9"            -> "203.0.113.9"
x-forwarded-for: "198.51.100.7"           -> "198.51.100.7"
x-forwarded-for: "203.0.113.9, 10.0.0.1"  -> null
x-real-ip: "203.0.113.9"                  -> null
```

Lines two and three are one caller landing in two buckets, by writing a header
itself. A loop over that header turns a three-attempts-per-ten-seconds limit
into no limit at all. `packages/auth/src/client-ip.test.ts` reproduces it
against the real library, so the fix cannot be undone quietly.

---

## 3. The default: trust nobody

With `LIBERTY_TRUSTED_PROXIES` unset, the application passes
`ipAddressHeaders: []`. No forwarded header is read, by name or by pattern, so
nothing a caller writes can reach a rate-limit bucket.

The library then resolves no address and falls back to **one shared bucket per
path for the entire deployment**: three sign-ins per ten seconds for everybody
at once. It logs a warning saying so.

**This is a real cost and it is not a bug.** At any scale it is a
self-inflicted denial of service on the sign-in page. It is still the right
default, for the reason the ruling gives: a shared bucket is a limit that is
too *tight*, which is visible, annoying and survivable. A spoofable header is a
limit that is *absent*, which is invisible and survivable only until somebody
notices. The remedy is to configure the topology below — not to trust a header.

---

## 4. Configuring a topology

List the hops that sit in front of this application:

```
LIBERTY_TRUSTED_PROXIES=10.0.0.0/8
LIBERTY_TRUSTED_PROXIES=10.0.0.0/8, 192.168.1.1
LIBERTY_TRUSTED_PROXIES=2001:db8::/32
```

With that set, the application reads `x-forwarded-for` and walks the chain
**from the right**, skipping trusted hops, and takes the first entry that is
not one of them. The rightmost entry is the one appended by whoever actually
spoke to the server, so anything a client prepended is discarded unread.
Measured, with `10.0.0.0/8` trusted:

```
"203.0.113.9, 10.0.0.1"            -> 203.0.113.9
"203.0.113.9, 10.0.0.1, 10.1.2.3"  -> 203.0.113.9   (two trusted hops)
"9.9.9.9, 203.0.113.9, 10.0.0.1"   -> 203.0.113.9   (the lie is discarded)
```

### 4.1 Only `x-forwarded-for`

`X-Real-IP`, `Forwarded`, `CF-Connecting-IP` and the rest are **not** read, and
adding one is not a small change. The library tries configured headers in order
and takes the first that yields an address, so a second header can only ever
widen what is accepted, never narrow it — and each one is another string
something upstream might not be overwriting. One header, with a chain the
trusted hop appends to, covers every proxy this application is likely to sit
behind.

If your proxy only sets `X-Real-IP`, **configure it to set
`X-Forwarded-For`** rather than adding a header here.

---

## 5. The precondition. Read this one.

> **Configuring `LIBERTY_TRUSTED_PROXIES` is sound only if the application
> cannot be reached except through those hops.**

The same measurement that shows the algorithm working also shows its limit:

```
"203.0.113.9"                      -> 203.0.113.9
"203.0.113.9, 198.51.100.1"        -> 198.51.100.1
```

A request that did **not** arrive through a trusted hop still has its rightmost
untrusted entry honoured. That is not a flaw in the algorithm — nothing in a
header can distinguish a forged chain from a real one without knowing who spoke
to the socket — but it means that if an attacker can reach your origin
directly, bypassing the proxy, they are back to choosing their own bucket.

**On a deployment whose origin is publicly reachable, setting this variable is
worse than leaving it unset.** Before setting it, confirm that the application's
listening address is reachable only from the proxy — a private network, a
firewall rule, a service mesh, a unix socket. This repository cannot check that
for you, which is why it is written here.

---

## 6. Why a bad value stops the application

An entry this application cannot parse is a **start-up failure**, with the
entry named. It does not fall back to the safe default, and that is on purpose
in both directions:

- The library filters entries it cannot parse out of the trusted list
  **silently**. A list with one typo could filter down to empty, and an empty
  trusted list falls into the branch that accepts a single-valued
  `X-Forwarded-For` from anybody — re-opening §2.1 **on a deployment whose
  operator believes it is configured**.
- Falling back to "trust nobody" would be safe but dishonest: the operator
  asked for one posture and would silently get another, and would find out
  through a support ticket about rate limits.

The parser is deliberately **stricter** than the library's. It rejects
hostnames, out-of-range prefixes, leading-zero octets (`010.0.0.1` is octal to
some parsers and decimal to others) and IPv6 zone indices. Being stricter can
only produce a refusal to start, never a quiet acceptance — and
`client-ip.test.ts` drives every accepted form through the library's own `getIP`
to prove the two agree.

---

## 7. Local development

`getIP` ends with `if (isTest() || isDevelopment()) return "127.0.0.1"`. On a
development or test build **every caller resolves to localhost**, whatever this
variable says and whatever headers are sent.

That is safe — one constant for everybody is the shared bucket, and no header
influences it — but it means **you cannot observe any of this by running
locally.** "I set the header and nothing happened" is not evidence about
production. The test suite pins `NODE_ENV=production` before loading the
library for exactly this reason.

---

## 8. What this does not do

- **It does not change how many requests are allowed.** `rate-limit.ts` owns
  the limits; this owns who a request is attributed to. Nothing here can
  loosen, widen or disable a rule.
- **It is not used for anything but rate-limit identity.** No geo-IP, no IP
  reputation, no blocklists. Deriving the address correctly is this document;
  what else might be done with one is not.
- **It gives no caller a way to nominate its own identity**, for any purpose,
  under any configuration. There is no development carve-out and no override.

---

## 9. Where the code is

| | |
|---|---|
| Policy and parser | `packages/auth/src/client-ip.ts` |
| Evidence, against the real library | `packages/auth/src/client-ip.test.ts` |
| Where it reaches the vendor | `packages/auth/src/better-auth.ts`, `advanced.ipAddress` |
| The limits this protects | `packages/auth/src/rate-limit.ts` |
