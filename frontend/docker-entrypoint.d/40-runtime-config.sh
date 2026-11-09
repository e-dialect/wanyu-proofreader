#!/bin/sh
set -eu

admin_ui_value="$(printf '%s' "${ENABLE_POCKETBASE_ADMIN_UI:-false}" | tr '[:upper:]' '[:lower:]')"

case "$admin_ui_value" in
  1|true|yes|on)
    admin_ui_mode="enabled"
    ;;
  0|false|no|off|'')
    admin_ui_mode="disabled"
    ;;
  *)
    echo "Invalid ENABLE_POCKETBASE_ADMIN_UI value: ${ENABLE_POCKETBASE_ADMIN_UI}" >&2
    exit 1
    ;;
esac

cp "/opt/fangji/nginx/pocketbase-admin-${admin_ui_mode}.conf" \
  /etc/nginx/snippets/pocketbase-admin.conf
echo "PocketBase Admin UI proxy: ${admin_ui_mode}"

trusted_proxy_cidrs="${TRUSTED_PROXY_CIDRS:-172.16.0.0/12}"
trusted_proxy_file="/etc/nginx/snippets/trusted-proxies.conf"
: > "$trusted_proxy_file"
old_ifs="$IFS"
IFS=','
for proxy_cidr in $trusted_proxy_cidrs; do
  proxy_cidr="$(printf '%s' "$proxy_cidr" | tr -d '[:space:]')"
  case "$proxy_cidr" in
    ''|*[!0-9A-Fa-f:./]*)
      echo "Invalid TRUSTED_PROXY_CIDRS entry: ${proxy_cidr}" >&2
      exit 1
      ;;
  esac
  printf 'set_real_ip_from %s;\n' "$proxy_cidr" >> "$trusted_proxy_file"
done
IFS="$old_ifs"
echo "Configured trusted proxy CIDRs."

backend_url="${VITE_BACKEND_URL:-${PB_URL:-}}"

# Keep content-hashed bundles immutable. Rewriting a placeholder also rewrote
# the old equality sentinel, so configured URLs were ignored; on restart the
# placeholder was gone altogether. Only this small, uncached file is mutable.
runtime_config=/usr/share/nginx/html/runtime-config.js
temporary_config="$(mktemp "${runtime_config}.XXXXXX")"
trap 'rm -f "$temporary_config"' EXIT HUP INT TERM
FANGJI_RUNTIME_BACKEND_URL="$backend_url" awk 'BEGIN {
  value = ENVIRON["FANGJI_RUNTIME_BACKEND_URL"]
  if (value != "" && value !~ /^https?:\/\/[^\/[:space:]]+/) exit 1
  for (n = 1; n < 33; n++) if (index(value, sprintf("%c", n))) exit 1
  if (index(value, sprintf("%c", 127))) exit 1
  printf "globalThis.__FANGJI_BACKEND_URL__ = \""
  for (n = 1; n <= length(value); n++) {
    c = substr(value, n, 1)
    if (c == "\\") printf "\\\\"
    else if (c == "\"") printf "\\\""
    else printf "%s", c
  }
  print "\";"
}' > "$temporary_config" || {
  echo "Invalid frontend backend URL; expected an HTTP(S) URL without whitespace or control characters." >&2
  exit 1
}
case "${FANGJI_TELEMETRY_ENABLED:-0}" in
  0|1) ;;
  *) echo "FANGJI_TELEMETRY_ENABLED must be 0 or 1" >&2; exit 1 ;;
esac
case "${FANGJI_BUILD_SHA:-unknown}" in
  ''|*[!A-Za-z0-9._:-]*) echo "Invalid build identifier" >&2; exit 1 ;;
esac
if [ "${FANGJI_TELEMETRY_ENABLED:-0}" = 1 ]; then telemetry_value=true; else telemetry_value=false; fi
case "${FANGJI_NATIVE_DELIVERY_ENABLED:-1}" in
  0) native_delivery_value=false ;;
  1) native_delivery_value=true ;;
  *) echo "FANGJI_NATIVE_DELIVERY_ENABLED must be 0 or 1" >&2; exit 1 ;;
esac
printf 'globalThis.__FANGJI_TELEMETRY_ENABLED__ = %s;\n' "$telemetry_value" >> "$temporary_config"
printf 'globalThis.__FANGJI_NATIVE_DELIVERY_ENABLED__ = %s;\n' "$native_delivery_value" >> "$temporary_config"
printf 'globalThis.__FANGJI_BUILD_SHA__ = "%s";\n' "${FANGJI_BUILD_SHA:-unknown}" >> "$temporary_config"
chmod 644 "$temporary_config"
mv -f "$temporary_config" "$runtime_config"
trap - EXIT HUP INT TERM
echo "Configured frontend runtime backend address."
