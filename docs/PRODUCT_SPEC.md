# Product Spec

## Vision

Project Liberty is a premium media experience focused on fast discovery, reliable playback, transparent source selection, synchronized audio/subtitles, profile continuity, and a unified experience across authorized content sources.

## Product principles

1. Playback reliability before feature count.
2. One coherent interface across authorized providers.
3. Explainable quality selection instead of random source choice.
4. Accessibility, subtitles, and audio correctness are core features.
5. User privacy and security are defaults.
6. Legal content access is a hard architecture invariant.

## Initial user journey

1. Open the home experience.
2. Browse/search normalized metadata.
3. Open a title.
4. Resolve authorized playback candidates.
5. Rank candidates against device capability and provider health.
6. Start playback with selected audio/subtitles.
7. Persist progress and resume on another session/device.

## MVP capabilities

- Profiles and authentication boundary.
- Home/catalog/search.
- Title/episode detail.
- Provider adapter layer.
- Playback candidate normalization and ranking.
- Audio/subtitle preference policy.
- Watch progress and watchlist.
- Basic live-channel/EPG contracts for licensed sources.
- Observability for playback resolution and failure reasons.
- Responsive web application.

## Later capabilities

- Native mobile/TV clients.
- Advanced recommendation ranking.
- Offline support where provider rights permit it.
- Multi-CDN/provider health optimization.
- Watch-party/social features.
- Advanced parental controls.
- Production-grade live TV failover and DVR where licensed.
