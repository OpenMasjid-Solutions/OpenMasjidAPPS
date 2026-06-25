# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Hasan Ismail
# Announcements Board — a static site served by nginx.
# Settings are injected at container start into config.js (see
# docker-entrypoint.d/40-omos-config.sh), so the same image works for any masjid.
FROM nginx:1.27-alpine

LABEL org.opencontainers.image.title="OpenMasjid Announcements Board" \
      org.opencontainers.image.description="A full-screen rotating announcements board for masjid screens." \
      org.opencontainers.image.source="https://github.com/OpenMasjid-Solutions/OpenMasjidAPPS" \
      org.opencontainers.image.licenses="MIT"

COPY src/ /usr/share/nginx/html/
COPY docker-entrypoint.d/40-omos-config.sh /docker-entrypoint.d/40-omos-config.sh
RUN chmod +x /docker-entrypoint.d/40-omos-config.sh

EXPOSE 80
