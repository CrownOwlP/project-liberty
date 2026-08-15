# Live TV Architecture Notes

Live TV is supported only for licensed/authorized channel feeds.

## Components

- channel catalog normalization;
- EPG ingestion;
- provider health and regional availability;
- playback candidate resolution;
- start-over/DVR capability flags where rights permit;
- failover among authorized feeds;
- latency telemetry.

## Data freshness

EPG and channel-health jobs should be asynchronous. The web request path reads normalized state and performs only lightweight authorization/resolution.
