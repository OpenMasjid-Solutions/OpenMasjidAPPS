#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Hasan Ismail
# Regenerate config.js from the environment variables the masjid set at install
# time. The official nginx image runs every *.sh here before starting nginx.
set -eu

out="/usr/share/nginx/html/config.js"

# Escape backslashes and double quotes and strip CR/LF so a setting value can
# never break out of the JS string it's written into.
esc() {
  printf '%s' "${1:-}" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\r\n'
}

cat > "$out" <<EOF
window.OMOS_CONFIG = {
  MASJID_NAME: "$(esc "${MASJID_NAME:-Our Masjid}")",
  ANN1_TITLE: "$(esc "${ANN1_TITLE:-}")",
  ANN1_TEXT: "$(esc "${ANN1_TEXT:-}")",
  ANN2_TITLE: "$(esc "${ANN2_TITLE:-}")",
  ANN2_TEXT: "$(esc "${ANN2_TEXT:-}")",
  ANN3_TITLE: "$(esc "${ANN3_TITLE:-}")",
  ANN3_TEXT: "$(esc "${ANN3_TEXT:-}")",
  ANN4_TITLE: "$(esc "${ANN4_TITLE:-}")",
  ANN4_TEXT: "$(esc "${ANN4_TEXT:-}")",
  ANN5_TITLE: "$(esc "${ANN5_TITLE:-}")",
  ANN5_TEXT: "$(esc "${ANN5_TEXT:-}")",
  ANN6_TITLE: "$(esc "${ANN6_TITLE:-}")",
  ANN6_TEXT: "$(esc "${ANN6_TEXT:-}")",
  ROTATE_SECONDS: "$(esc "${ROTATE_SECONDS:-12}")",
  FOOTER_NOTE: "$(esc "${FOOTER_NOTE:-}")",
  SHOW_TIME: "$(esc "${SHOW_TIME:-true}")",
  TIME_FORMAT: "$(esc "${TIME_FORMAT:-12h}")",
  TIMEZONE: "$(esc "${TIMEZONE:-}")",
  LANGUAGE: "$(esc "${LANGUAGE:-en}")"
};
EOF

echo "[announcements-board] generated $out"
