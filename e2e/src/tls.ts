import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

/* -------------------------------------------------------------------------
 * A THROWAWAY CERTIFICATE FOR THE STUB BACKEND (PL-0501, round 45, correction 4)
 *
 * WRITTEN BY PL-0501 INSIDE PL-0701's DECLARED SURFACE. PL-0701 is BACKLOG and
 * unowned and it is BLOCKED BEHIND PL-0501, so it could not be claimed to do
 * this work; the reviewer authorised the overlap in advance and PL-0501's
 * `surfaceWidenedOnReview` record adds `e2e/**` for exactly these files.
 * PL-0701 inherits them. Nothing here is a claim over that task's design: it is
 * the minimum harness that can prove the desktop target forwards to a backend.
 *
 * WHY A CERTIFICATE IS NEEDED AT ALL, AND WHY THE ALTERNATIVE WAS REFUSED.
 * `playback-session-implementation.desktop.ts` validates its backend origin by
 * hand -- `https` only, no credentials in the authority -- and states in terms
 * that loopback is NOT carved out, because "the whole point of the ruling is
 * that the trust boundary is not on the user's machine, so a backend on
 * 127.0.0.1 would be the exposure with the address changed". Relaxing that to
 * let a test use `http://127.0.0.1` would be weakening a security property to
 * make a test pass, which is the one thing this round may not do. So the stub
 * speaks real TLS and the server under test is given a CA to trust.
 *
 * GENERATED, NOT COMMITTED. A checked-in private key is a credential in version
 * control however harmless it is, and the repository's `.gitignore` bans
 * `*.pem` and `*.key` by pattern for exactly that reason -- so a committed one
 * could not be tracked anyway. It is minted per run into `e2e/.tls/`, valid for
 * two days, for `IP:127.0.0.1` only, and it authenticates nothing but a
 * loopback stub that serves canned playback decisions.
 *
 * `openssl` IS A REAL DEPENDENCY OF THIS PATH AND ITS ABSENCE IS A SKIP WITH A
 * SENTENCE, never a silent pass. Node cannot mint an X.509 certificate --
 * `node:crypto` can read and verify one but not issue one -- and adding a
 * JavaScript certificate authority to `e2e/package.json` would put a crypto
 * dependency in the harness to avoid a binary every CI image already has.
 * ---------------------------------------------------------------------- */

export interface StubCertificate {
  /** PEM certificate. Handed to the stub, and to the server under test as a CA. */
  readonly certificatePath: string;
  /** PEM private key. Handed to the stub only. */
  readonly privateKeyPath: string;
}

/**
 * The certificate for the stub backend, minting one if there is not a usable
 * one already, or `null` when this machine cannot mint one.
 *
 * `null` RATHER THAN A THROW. A missing `openssl` must not take down the whole
 * harness -- the web-target suite is unaffected by it and is the larger part of
 * the gate. The caller turns the `null` into a named skip, so a run without a
 * desktop target says so in the report instead of quietly covering less.
 */
export function ensureStubCertificate(directory: string): StubCertificate | null {
  const certificatePath = path.join(directory, "backend-stub.pem");
  const privateKeyPath = path.join(directory, "backend-stub.key");

  if (existsSync(certificatePath) && existsSync(privateKeyPath) && isStillValid(certificatePath)) {
    return { certificatePath, privateKeyPath };
  }

  try {
    mkdirSync(directory, { recursive: true });
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        privateKeyPath,
        "-out",
        certificatePath,
        "-days",
        "2",
        "-subj",
        "/CN=127.0.0.1",
        /*
         * A SUBJECT ALTERNATIVE NAME, and it has to be the IP form. Node
         * verifies the hostname against the SAN and does not fall back to the
         * common name, so a certificate with only `/CN=127.0.0.1` is rejected
         * by the very check this test exists to keep switched on.
         */
        "-addext",
        "subjectAltName=IP:127.0.0.1"
      ],
      { stdio: "ignore" }
    );
  } catch {
    return null;
  }

  return { certificatePath, privateKeyPath };
}

/** Whether the certificate on disk is good for at least another ten minutes. */
function isStillValid(certificatePath: string): boolean {
  try {
    execFileSync("openssl", ["x509", "-checkend", "600", "-noout", "-in", certificatePath], {
      stdio: "ignore"
    });
    return true;
  } catch {
    return false;
  }
}
