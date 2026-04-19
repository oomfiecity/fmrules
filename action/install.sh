#!/usr/bin/env bash
set -euo pipefail

# Resolve version ---------------------------------------------------------
#   1. `inputs.version` (unless empty or "latest")
#   2. `github.action_ref` if it looks like a tag
#   3. the repo's latest release via `gh api`
resolve_version() {
  local input="${FMRULES_VERSION_INPUT:-}"
  local ref="${FMRULES_ACTION_REF:-}"

  if [ -n "$input" ] && [ "$input" != "latest" ]; then
    echo "$input"
    return
  fi

  if [ "$input" != "latest" ] && [ -n "$ref" ] && [[ "$ref" =~ ^v ]]; then
    echo "$ref"
    return
  fi

  gh api repos/oomfiecity/fmrules/releases/latest --jq .tag_name
}

VERSION="$(resolve_version)"
if [ -z "$VERSION" ]; then
  echo "::error::Could not resolve an fmrules version to install." >&2
  exit 1
fi

# Map runner -> release target -------------------------------------------
case "${RUNNER_OS:-}" in
  Linux)  os=linux ;;
  macOS)  os=darwin ;;
  *)
    echo "::error::Unsupported RUNNER_OS '${RUNNER_OS:-}'. fmrules ships Linux and macOS binaries only." >&2
    exit 1
    ;;
esac
case "${RUNNER_ARCH:-}" in
  X64)   arch=x64 ;;
  ARM64) arch=arm64 ;;
  *)
    echo "::error::Unsupported RUNNER_ARCH '${RUNNER_ARCH:-}'." >&2
    exit 1
    ;;
esac
TARGET="bun-${os}-${arch}"
ASSET="fmrules-${TARGET}"

# Download asset + checksum file -----------------------------------------
DOWNLOAD_DIR="${RUNNER_TEMP:-/tmp}/fmrules-download"
INSTALL_DIR="${RUNNER_TEMP:-/tmp}/fmrules/bin"
mkdir -p "$DOWNLOAD_DIR" "$INSTALL_DIR"

echo "Downloading fmrules $VERSION ($ASSET) from oomfiecity/fmrules..."
gh release download "$VERSION" \
  --repo oomfiecity/fmrules \
  --pattern "$ASSET" \
  --pattern "SHA256SUMS.txt" \
  --dir "$DOWNLOAD_DIR" \
  --clobber

# Verify checksum ---------------------------------------------------------
pushd "$DOWNLOAD_DIR" >/dev/null
expected_line=$(grep " ${ASSET}\$" SHA256SUMS.txt || true)
if [ -z "$expected_line" ]; then
  echo "::error::${ASSET} not listed in SHA256SUMS.txt for release ${VERSION}." >&2
  exit 1
fi
echo "$expected_line" | shasum -a 256 -c -
popd >/dev/null

# Install -----------------------------------------------------------------
install_path="${INSTALL_DIR}/fmrules"
mv "${DOWNLOAD_DIR}/${ASSET}" "$install_path"
chmod +x "$install_path"
if [ "$os" = "darwin" ]; then
  xattr -d com.apple.quarantine "$install_path" 2>/dev/null || true
fi

echo "$INSTALL_DIR" >> "$GITHUB_PATH"
echo "version=$VERSION" >> "$GITHUB_OUTPUT"
echo "Installed fmrules $VERSION at $install_path"
