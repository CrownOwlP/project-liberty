# Content Rights and Provider Policy

This file is a non-negotiable architecture boundary.

## Allowed source classes

- Content licensed to Project Liberty.
- Media owned by the user and accessed with their authorization.
- Public-domain media.
- Third-party provider integrations whose terms/API authorize the requested access and playback behavior.

## Not allowed

- DRM circumvention.
- Bypassing paywalls or subscription checks.
- Bypassing authentication, access controls, or geographic restrictions.
- Scraping or resolving unauthorized streams.
- Re-hosting or redistributing media without rights.
- Designing fallback logic whose purpose is to evade provider enforcement.

## Engineering enforcement

- Every `StreamCandidate` carries a normalized rights classification.
- Provider adapters are responsible for proving/establishing authorization before returning candidates.
- Playback policy may optimize among authorized candidates; it may not manufacture unauthorized candidates.
- Any new provider integration requires a documented rights basis in the implementation PR.
