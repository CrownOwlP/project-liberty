# Observability

## Required signals

- request ID / playback session ID;
- provider resolution duration;
- number of candidates returned/rejected;
- winning candidate reason and score dimensions;
- startup time;
- rebuffer events;
- playback failure reason;
- A/V drift measurement when available;
- subtitle/audio-selection fallback reason.

## Privacy

Do not log raw tokens, cookies, full provider URLs, payment data, or unnecessary personal profile fields.
