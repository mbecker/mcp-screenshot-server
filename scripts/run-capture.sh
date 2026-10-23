#!/usr/bin/env bash
# Capture a website in Docker and write the results to a local folder.
#
#   npm run test:capture -- --url https://example.com --presets iphone-17,desktop --depth 1
#   npm run test:capture -- --url https://example.com --out ~/captures --max-pages 5
#
# --out <dir>   Host folder for the results (default: ./captures)
# --no-build    Reuse the existing image
# Everything else goes to scripts/capture.mjs (see --help). SCREENSHOT_UPLOAD_* and
# ALLOW_LOCAL are passed through from your environment when set.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

IMAGE_NAME="mcp-screenshot-capture"
OUT_DIR="$PROJECT_DIR/captures"
BUILD=1
ARGS=()
while (($#)); do
  case "$1" in
    --out) OUT_DIR="$2"; shift 2 ;;
    --out=*) OUT_DIR="${1#*=}"; shift ;;
    --no-build) BUILD=0; shift ;;
    *) ARGS+=("$1"); shift ;;
  esac
done

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

if ((BUILD)); then
  echo "Building Docker image..." >&2
  docker build -q -f "$PROJECT_DIR/Dockerfile.capture" -t "$IMAGE_NAME" "$PROJECT_DIR" >/dev/null
fi

echo "Output: $OUT_DIR" >&2
# Runs as the calling user so the files on the host are not owned by root
docker run --rm --init \
  --user "$(id -u):$(id -g)" \
  --shm-size=1g \
  -v "$OUT_DIR:/home/capture/output" \
  -e SCREENSHOT_UPLOAD_URL -e SCREENSHOT_UPLOAD_FIELD -e SCREENSHOT_UPLOAD_HEADERS -e ALLOW_LOCAL \
  "$IMAGE_NAME" ${ARGS[@]+"${ARGS[@]}"} \
  | sed "s#/home/capture/output#$OUT_DIR#g" # report host paths, not container paths
