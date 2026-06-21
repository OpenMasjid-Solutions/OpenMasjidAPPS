# Announcements Board

A clean, full-screen rotating notice board for the screens in your masjid. Part of the
[OpenMasjidAPPS](../../README.md) catalog for [OpenMasjidOS](https://github.com/hasan-ismail/OpenMasjidOS).

It cycles through the announcements you enter — Jummah timings, classes, fundraisers,
reminders — with a live clock, the date, and an optional footer note.

## How it's built

- A small static site (`src/`) — vanilla HTML/CSS/ES modules, no framework, no external
  network calls. Slides crossfade with a progress bar (collapses to instant when the device
  prefers reduced motion).
- Served by `nginx`. At container start, `docker-entrypoint.d/40-omos-config.sh` writes the
  masjid's install settings into `config.js`, which the page reads from `window.OMOS_CONFIG`.

## Settings

Up to six announcement slots (`ANN1..ANN6`, each a title + details), plus `MASJID_NAME`,
`ROTATE_SECONDS`, `FOOTER_NOTE`, `SHOW_TIME`, `TIME_FORMAT`, `TIMEZONE`, and `LANGUAGE`.
Blank slots are skipped. To change announcements later, update the settings in OpenMasjidOS
and restart the app.

## Local preview

Open `src/index.html` in a browser; it uses the development defaults in `src/config.js`.

## Image

Published by CI to `ghcr.io/hasan-ismail/openmasjid-announcements-board` and pinned by tag in
`docker-compose.yml`.
