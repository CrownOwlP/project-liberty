//! Parsing the one line the sidecar prints (PW-0102).
//!
//! THIS IS A SECOND IMPLEMENTATION OF A CONTRACT THAT ALREADY HAS ONE, and
//! that is deliberate rather than an oversight. `apps/web/src/lib/sidecar/
//! handshake.ts` is the producer and lives in TypeScript; this is the consumer
//! and has to live in Rust, because the shell is the parent process and reads
//! the child's stdout. There is no shared artefact the two could import.
//!
//! So the risk is drift, and the mitigation is that the contract is TINY and
//! the rules are restated here as assertions rather than as prose:
//!
//!   - a fixed prefix, so the line can be found among whatever Next logs;
//!   - a JSON body, so a field can be added without breaking the parse;
//!   - a host that MUST be loopback;
//!   - a port that must be a usable integer.
//!
//! THE LOOPBACK REFUSAL IS THE ONE THAT MATTERS AND IT IS RESTATED, NOT
//! INHERITED. `handshake.ts` refuses a non-loopback host because the shell is
//! about to point a webview at whatever the line says -- and a sidecar that
//! reported `0.0.0.0` would have the shell advertise a LAN-reachable origin as
//! its own. The producer checking it protects nothing here: this process is the
//! one that acts on the value, and a compromised or simply buggy child is
//! exactly the case where the producer's check did not run. A consumer that
//! trusted the producer's validation would be trusting the thing it is
//! validating.

use serde::Deserialize;

/// The prefix that marks the one line of stdout worth parsing.
///
/// Must equal `HANDSHAKE_PREFIX` in `apps/web/src/lib/sidecar/handshake.ts`.
pub const HANDSHAKE_PREFIX: &str = "liberty-sidecar-ready";

/// The loopback hosts a handshake may name.
///
/// Deliberately NOT including `localhost`: the sidecar's own `policy.ts` admits
/// it as a BIND host, but a name has to be resolved and on Windows it can
/// resolve to either family or, with a hosts-file entry, to something else
/// entirely. The shell builds a URL from this value, so it takes addresses only.
const LOOPBACK_HOSTS: [&str; 2] = ["127.0.0.1", "::1"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Handshake {
    pub host: String,
    pub port: u16,
}

impl Handshake {
    /// The origin the webview is pointed at.
    ///
    /// IPv6 is bracketed, which is not decoration: `http://::1:41999/` is not a
    /// URL, and the shell would silently fail to navigate.
    pub fn origin(&self) -> String {
        if self.host.contains(':') {
            format!("http://[{}]:{}", self.host, self.port)
        } else {
            format!("http://{}:{}", self.host, self.port)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandshakeError {
    /// Not the line we are looking for. The common case -- most of the child's
    /// output is Next's own logging -- and therefore NOT an error to surface.
    NotHandshake,
    /// The line claimed to be a handshake and was not usable. This one IS worth
    /// surfacing: it means the contract broke.
    Malformed(String),
}

#[derive(Deserialize)]
struct Body {
    host: Option<String>,
    port: Option<i64>,
}

/// Parse one line of the child's stdout.
///
/// Returns `NotHandshake` rather than an error for ordinary log lines, because
/// the caller reads EVERY line and most of them are not this one. Distinguishing
/// the two is what lets a malformed handshake be reported while Next's startup
/// banner is ignored.
pub fn parse(line: &str) -> Result<Handshake, HandshakeError> {
    let trimmed = line.trim();
    let Some(rest) = trimmed.strip_prefix(HANDSHAKE_PREFIX) else {
        return Err(HandshakeError::NotHandshake);
    };

    let body: Body = serde_json::from_str(rest.trim())
        .map_err(|_| HandshakeError::Malformed("handshake body is not JSON".into()))?;

    let Some(host) = body.host.filter(|h| !h.is_empty()) else {
        return Err(HandshakeError::Malformed("handshake states no host".into()));
    };
    if !LOOPBACK_HOSTS.contains(&host.as_str()) {
        return Err(HandshakeError::Malformed(format!(
            "handshake host {host:?} is not a loopback address"
        )));
    }

    // `i64` first, then narrowed, so that 0, a negative and 70000 are each
    // REFUSED rather than wrapping into a plausible port. Deserializing straight
    // into `u16` would make serde reject them with its own message, which says
    // "invalid value" and not which rule was broken.
    let Some(port) = body.port else {
        return Err(HandshakeError::Malformed("handshake states no port".into()));
    };
    if !(1..=65535).contains(&port) {
        return Err(HandshakeError::Malformed(format!(
            "handshake port {port} is not in 1..=65535"
        )));
    }

    Ok(Handshake {
        host,
        port: port as u16,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_line_the_sidecar_prints() {
        let parsed = parse(r#"liberty-sidecar-ready {"host":"127.0.0.1","port":41999}"#).unwrap();
        assert_eq!(
            parsed,
            Handshake {
                host: "127.0.0.1".into(),
                port: 41999
            }
        );
        assert_eq!(parsed.origin(), "http://127.0.0.1:41999");
    }

    #[test]
    fn brackets_an_ipv6_host_so_the_url_is_navigable() {
        // `http://::1:41999/` is not a URL. Without the brackets the shell
        // silently fails to navigate and the user sees a blank window.
        let parsed = parse(r#"liberty-sidecar-ready {"host":"::1","port":41999}"#).unwrap();
        assert_eq!(parsed.origin(), "http://[::1]:41999");
    }

    #[test]
    fn ordinary_log_lines_are_not_errors() {
        // The caller reads every line the child prints. If these were errors the
        // shell would report a broken contract on Next's startup banner.
        for line in ["  ▲ Next.js 16.3.1", "", "ready in 200ms", "liberty-sidecar"] {
            assert_eq!(parse(line), Err(HandshakeError::NotHandshake), "{line:?}");
        }
    }

    #[test]
    fn a_non_loopback_host_is_refused() {
        // THE CENTRAL SAFETY ASSERTION. The shell is about to point a webview at
        // this value; accepting 0.0.0.0 would advertise a LAN-reachable origin
        // as the application's own.
        for host in ["0.0.0.0", "192.168.1.10", "example.com", "localhost"] {
            let line = format!(r#"liberty-sidecar-ready {{"host":"{host}","port":41999}}"#);
            match parse(&line) {
                Err(HandshakeError::Malformed(_)) => {}
                other => panic!("{host} must be refused, got {other:?}"),
            }
        }
    }

    #[test]
    fn an_unusable_port_is_refused_rather_than_wrapped() {
        // 70000 as a u16 is 4464, which is a perfectly plausible port. Narrowing
        // after the range check is what stops that.
        for port in ["0", "-1", "70000", "65536", "\"41999\"", "null"] {
            let line = format!(r#"liberty-sidecar-ready {{"host":"127.0.0.1","port":{port}}}"#);
            match parse(&line) {
                Err(HandshakeError::Malformed(_)) => {}
                other => panic!("port {port} must be refused, got {other:?}"),
            }
        }
    }

    #[test]
    fn a_handshake_shaped_line_with_no_body_is_malformed_not_ignored() {
        // The distinction the caller depends on: this claimed to be a handshake,
        // so the contract broke and somebody should hear about it.
        match parse("liberty-sidecar-ready") {
            Err(HandshakeError::Malformed(_)) => {}
            other => panic!("expected Malformed, got {other:?}"),
        }
    }

    #[test]
    fn an_added_field_does_not_break_the_parse() {
        // The reason the body is JSON rather than two positional values.
        let parsed =
            parse(r#"liberty-sidecar-ready {"host":"127.0.0.1","port":41999,"pid":1234}"#).unwrap();
        assert_eq!(parsed.port, 41999);
    }
}
