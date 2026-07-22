#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOADER="$ROOT_DIR/scripts/load-env.sh"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mc-load-env.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

cat > "$TMP_DIR/safe.env" <<EOF
AUTH_PASS='\$(touch "$TMP_DIR/executed")'
API_KEY="literal # value"
MC_ALLOWED_HOSTS=127.0.0.1,localhost
MC_COOKIE_SECURE=1 # inline comment
MC_JSON='{"enabled":true,"label":"中文"}'
EMPTY_VALUE=
EOF

result="$(sh -c '. "$1"; load_env_file "$2"; printf "%s\n%s\n%s\n%s\n%s" "$AUTH_PASS" "$API_KEY" "$MC_COOKIE_SECURE" "$MC_JSON" "$EMPTY_VALUE"' _ "$LOADER" "$TMP_DIR/safe.env")"
expected="$(printf '%s\n%s\n%s\n%s\n%s' "\$(touch \"$TMP_DIR/executed\")" 'literal # value' '1' '{"enabled":true,"label":"中文"}' '')"
[[ "$result" == "$expected" ]]
[[ ! -e "$TMP_DIR/executed" ]]

printf 'AUTH_PASS=overridden-literal\n' > "$TMP_DIR/override.env"
result="$(sh -c '. "$1"; load_env_file "$2"; load_env_file "$3"; printf "%s" "$AUTH_PASS"' _ "$LOADER" "$TMP_DIR/safe.env" "$TMP_DIR/override.env")"
[[ "$result" == 'overridden-literal' ]]

for unsafe in 'PATH=/tmp/untrusted-bin' 'NODE_OPTIONS=--require=/tmp/payload.js' 'mc_env_line_number=1+1' 'INVALID-NAME=value'; do
  printf '%s\n' "$unsafe" > "$TMP_DIR/unsafe.env"
  if sh -c '. "$1"; load_env_file "$2"' _ "$LOADER" "$TMP_DIR/unsafe.env" >/dev/null 2>&1; then
    echo "expected unsafe env assignment to be rejected: $unsafe" >&2
    exit 1
  fi
done

echo 'load-env tests passed'
