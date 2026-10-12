# Synthetic Live TV fixtures — TEST INPUT ONLY, NOT A CHANNEL LIST

Every file in this directory is **invented**. Read this before using any of it
for anything.

- **No file here is a channel list.** Nothing in `apps/web` imports this
  directory, and `apps/web/src/lib/livetv/feed-configuration.ts` has no
  fixture-backed default in any environment — the Live TV surface's shipped
  state is "no licensed live feed is configured", which is true of this
  installation. `fixtures.test.ts` and `live-page-data.test.ts` assert both
  mechanically.
- **Every host is under `example.invalid`.** RFC 6761 reserves `.invalid` as a
  name that is guaranteed never to resolve, so nothing here can be mistaken for,
  or accidentally pointed at, a real origin. There is no real host, no real
  stream, no credential and no token anywhere in these files.
- **Every channel, programme and provider name is made up.** "Aurora", "Meridian"
  and "Polaris" are the invented brands this repository already uses for its demo
  catalogue. Nothing here corresponds to a real broadcaster, and nothing here is
  a claim that Project Liberty carries anything.
- **Why fixtures at all.** `docs/CONTENT_RIGHTS.md` and `docs/LIVE_TV.md` place
  live acquisition behind a licensed feed (task PL-0602, blocked). The parsing,
  organisation and presentation layer in `apps/web/src/lib/livetv/**` is built
  and tested against these synthetic documents instead, so that when an
  authorized feed exists there is a tested reader waiting for it. Using a
  third-party public playlist as a test input would be using somebody's index as
  permission, which `docs/LIVE_TV.md` refuses in those words.

| File | What it is for |
| --- | --- |
| `authorized-synthetic.m3u` | A well-formed playlist: attributes, groups, `#EXTGRP`, `#PLAYLIST`. |
| `hostile-synthetic.m3u` | Deliberately malformed: BOM, CRLF, an entry with no URL, an attribute with no value, an escaped quote, a comma inside a quoted group, duplicates, a non-HTTP scheme, no trailing newline. |
| `unauthorized-origin.m3u` | Well-formed and pointed at an origin no authorization declares. Must be rejected entry by entry. |
| `synthetic-epg.xml` | XMLTV: two channels, a midnight crossing, a DST crossing, `+0530` and `-0330` offsets, an overlap, an unknown-channel programme, a missing `stop`. |
| `hostile-doctype-epg.xml` | An XXE attempt. The reader must refuse the whole document at the declaration, never resolve it. |
