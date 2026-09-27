import { createBackendServer } from "./server";
import { resolveConfiguration } from "./config";

/* -------------------------------------------------------------------------
 * The entrypoint (PW-0401)
 *
 * THE ONE MODULE IN THIS SERVICE THAT READS `process.env`, and the one that
 * exits. Everything else takes what it needs, which is what makes every refusal
 * below reachable from a unit test without mutating a global.
 *
 * IT REFUSES TO START ON A CONFIGURATION IT CANNOT SERVE, rather than starting
 * degraded. A backend that came up on cleartext because a certificate path was
 * missing would work on a developer's machine and carry a viewer's session
 * cookie across a network in the clear in production; see `config.ts` for why
 * cleartext is an acknowledgement an operator types rather than a fallback.
 *
 * IT DOES NOT REFUSE TO START WITHOUT AN IDENTITY STORE OR A PROVIDER, and that
 * is deliberate and is required by the acceptance. A backend with no identity
 * store answers `authentication_not_configured` with a 503; one with no
 * provider answers the contract's own `provider_not_configured`, which is
 * exactly what the web target already does. Both are honest states an operator
 * can deploy into and then fix, and neither is a reason to have no service.
 * ---------------------------------------------------------------------- */

const resolution = resolveConfiguration(process.env);

if (!resolution.ok) {
  console.error(`liberty backend: ${resolution.reason}: ${resolution.detail}`);
  process.exit(1);
}

const { host, port, transport } = resolution.configuration;
const server = createBackendServer(resolution.configuration, {
  observe: (line) => {
    console.log(line);
  }
});

server.listen(port, host, () => {
  console.log(`liberty backend listening on ${transport.kind} ${host}:${port}`);
});

/*
 * A container stops with SIGTERM. Closing the server lets in-flight requests
 * finish instead of being cut mid-response, which for this route means a
 * viewer's session request either succeeds or fails cleanly rather than
 * arriving as a truncated body the forwarder cannot parse.
 */
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => {
      process.exit(0);
    });
  });
}
