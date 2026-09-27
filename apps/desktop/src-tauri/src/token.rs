//! The per-launch token, minted from the operating system's CSPRNG (PW-0102).
//!
//! WHAT THIS TOKEN IS FOR, because it is the thing most likely to be widened by
//! accident. PW-0101 made it the separation between THIS application's loopback
//! listener and every other process on the machine. A desktop sidecar binds a
//! port on a computer where every other local process can reach it; the token is
//! what makes "a request arrived on 127.0.0.1" into "a request arrived from the
//! shell that started this sidecar".
//!
//! IT IS NOT AN ACCOUNT CREDENTIAL AND MUST NEVER BECOME ONE. PW-0402 built
//! `authorizeRoute` never to receive a `Request` so the token could not turn
//! into a login, and PW-0403's `deploymentSessionAccount` reads the session
//! cookie and nothing else so it could not turn into one from the other side.
//! This module mints it; nothing here or downstream may treat it as identity.
//!
//! THE SOURCE IS THE OS CSPRNG AND THE ALTERNATIVES ARE ALL BROKEN. A timestamp
//! is guessable by anything with a clock. A UUID's *formatting* is not entropy
//! — v4 is random, but a shell that reaches for "a UUID" often gets v1, which
//! encodes the time and the MAC address. A userspace PRNG seeded from the clock
//! or the pid is reproducible by any process that can observe either, and both
//! are observable to every process running as the same user on Windows. The
//! adversary here is a local process, which is the adversary with the best
//! possible view of all three.

use std::fmt;

/// Bytes of entropy. 32, which is `SIDECAR_TOKEN_MIN_BYTES` in
/// `apps/web/src/lib/sidecar/policy.ts`, hex-encoded to the 64 characters
/// `TOKEN_MIN_CHARS` requires.
pub const TOKEN_BYTES: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenError(String);

impl fmt::Display for TokenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "could not obtain randomness from the operating system: {}", self.0)
    }
}

/// Mint one launch token.
///
/// FAILS RATHER THAN FALLING BACK. If the OS will not provide randomness there
/// is no acceptable second choice -- every fallback a shell might reach for is
/// predictable to the local processes this token exists to exclude -- so the
/// caller surfaces a startup failure instead. `getrandom` is a thin shim over
/// `BCryptGenRandom` on Windows; it carries no generator of its own to fall back
/// to, which is why it is the dependency rather than a random-number crate.
pub fn mint() -> Result<String, TokenError> {
    let mut bytes = [0u8; TOKEN_BYTES];
    getrandom::fill(&mut bytes).map_err(|error| TokenError(error.to_string()))?;
    Ok(hex(&bytes))
}

/// Lower-case hex, written out rather than pulled in.
///
/// A dependency for sixteen characters of lookup table would be a supply-chain
/// surface for something whose correctness is visible in four lines.
fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sidecar::TOKEN_MIN_CHARS;

    #[test]
    fn a_minted_token_satisfies_the_contract_the_sidecar_enforces() {
        // 64 lower-case hex characters, which is what `policy.ts` requires and
        // what `plan_launch` refuses without. Asserted against the constant
        // rather than against the literal 64, so the two cannot drift.
        let token = mint().unwrap();
        assert_eq!(token.len(), TOKEN_MIN_CHARS);
        assert!(token.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
    }

    #[test]
    fn two_launches_do_not_share_a_token() {
        // "Per-launch" is the whole property. A constant, a hostname-derived
        // value or anything else stable across launches would let a process that
        // observed one launch talk to the next one's sidecar.
        let mut seen = std::collections::HashSet::new();
        for _ in 0..64 {
            assert!(seen.insert(mint().unwrap()), "mint() repeated a token");
        }
    }

    #[test]
    fn the_output_looks_like_entropy_rather_than_structure() {
        // Not a statistical test and not claimed as one. It catches the specific
        // failure of a "random" source that is actually a counter, a timestamp
        // or a padded constant: 256 tokens whose first four characters are
        // nearly all distinct, and no single hex digit dominating the output.
        let tokens: Vec<String> = (0..256).map(|_| mint().unwrap()).collect();
        let prefixes: std::collections::HashSet<&str> =
            tokens.iter().map(|t| &t[..4]).collect();
        assert!(prefixes.len() > 200, "only {} distinct prefixes", prefixes.len());

        let mut counts = [0usize; 16];
        for token in &tokens {
            for ch in token.chars() {
                counts[ch.to_digit(16).unwrap() as usize] += 1;
            }
        }
        let total: usize = counts.iter().sum();
        for (digit, count) in counts.iter().enumerate() {
            let share = *count as f64 / total as f64;
            assert!(
                share > 0.02 && share < 0.12,
                "hex digit {digit:x} is {share:.3} of the output, which is not entropy"
            );
        }
    }

    #[test]
    fn hex_encodes_every_byte_as_two_lower_case_digits() {
        assert_eq!(hex(&[0x00, 0x0f, 0xa5, 0xff]), "000fa5ff");
        assert_eq!(hex(&[]), "");
    }

    #[test]
    fn the_module_reaches_for_no_clock_pid_or_userspace_generator() {
        // The alternatives this module's header rejects, asserted as absences so
        // that a later edit reaching for one is a failing test rather than a
        // code review somebody might not do.
        //
        // SCOPED TO THE CODE ABOVE `#[cfg(test)]`, AND THE FIRST DRAFT WAS NOT.
        // It scanned the whole file and failed on the forbidden-word list a few
        // lines below -- a guard matching prose ABOUT the thing rather than the
        // thing, which is the exact class PL-AI-0013 had just been filed for.
        // Fifth instance in this repository; sixth if this one had shipped.
        // Comments are stripped for the same reason: the header above names
        // every one of these words while explaining why they are wrong.
        let source = include_str!("token.rs");
        let code = &source[..source.find("#[cfg(test)]").expect("the test module marks the end of the code")];
        let stripped = code
            .lines()
            .filter(|line| {
                let t = line.trim_start();
                !t.starts_with("//!") && !t.starts_with("//")
            })
            .collect::<Vec<_>>()
            .join("\n");
        for forbidden in [
            "SystemTime",
            "Instant",
            "process::id",
            "std::time",
            "rand::",
            "hostname",
        ] {
            assert!(
                !stripped.contains(forbidden),
                "token minting must not reach for {forbidden}"
            );
        }
        assert!(stripped.contains("getrandom::fill"), "non-vacuity");
    }
}
