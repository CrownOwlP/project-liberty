# Security Architecture

## Threat priorities

1. Account/session theft.
2. Unauthorized content access.
3. Provider credential leakage.
4. SSRF through provider/media URLs.
5. XSS through untrusted metadata.
6. Injection into persistence/search systems.
7. Privacy leakage through logs/telemetry.
8. Abuse of playback/session endpoints.

## Controls

- Validate all public input at transport boundaries.
- Enforce authorization server-side.
- Keep provider secrets server-only.
- Provider adapters use explicit allowlists for hosts and protocols.
- Never proxy arbitrary client-provided URLs.
- Apply output escaping and avoid raw HTML for provider metadata.
- Add rate limits for auth, search, and playback resolution.
- Use structured logs with redaction.
- Use short-lived playback/session tokens where applicable.
- Maintain an audit trail for privileged/admin actions.

## Security review requirement

Changes to auth, authorization, provider resolution, URL fetching, secrets, admin functionality, or payment/subscription logic require a security review before merge.
