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
  LATITUDE: "$(esc "${LATITUDE:-}")",
  LONGITUDE: "$(esc "${LONGITUDE:-}")",
  CALC_METHOD: "$(esc "${CALC_METHOD:-MWL}")",
  ASR_MADHAB: "$(esc "${ASR_MADHAB:-Standard}")",
  TIMEZONE: "$(esc "${TIMEZONE:-}")",
  TIME_FORMAT: "$(esc "${TIME_FORMAT:-12h}")",
  SCREEN_ORIENTATION: "$(esc "${SCREEN_ORIENTATION:-landscape}")",
  LANGUAGE: "$(esc "${LANGUAGE:-en}")"
};
EOF

echo "[prayer-times-display] generated $out"
