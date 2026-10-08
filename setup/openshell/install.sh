#!/usr/bin/env bash
# Setup helper: install-openshell — installs NVIDIA OpenShell with NVIDIA's
# official release installer, so choosing OpenShell sandboxing in setup needs
# no manual install. Same pattern as install-docker.sh: the script is the
# allowlisted unit; the `curl | sh` pipe lives inside it.
#
# What the official installer sets up:
#   - Linux (amd64/arm64, glibc >= 2.28): the Debian or RPM package (the
#     `openshell` CLI plus the `openshell-gateway` systemd user service), then
#     starts that service and registers it with the CLI as gateway "openshell".
#   - macOS on Apple silicon: the Homebrew formula and its `brew services`
#     gateway, registered the same way. Intel Macs are not supported (NVIDIA
#     publishes no x86_64 macOS build), so this script refuses them up front.
# This is OpenShell's own gateway (its control plane). It is unrelated to
# NanoClaw's "openshell" gateway, which is the add-openshell skill's model
# relay that setup applies separately.
#
# When OpenShell's gateway first starts it pulls its supervisor and sandbox
# runtime images (ghcr.io/nvidia/openshell/{supervisor,sandbox}:<version>)
# before it accepts connections. setup/openshell/install-step.ts checks the result.
#
# Version: OPENSHELL_VERSION from the environment when set (passed straight
# through to the installer, which also accepts `dev` and `pre`), otherwise the
# "openshell" pin in versions.json. NanoClaw's OpenShell driver is verified
# against that pinned release. Other installer variables
# (OPENSHELL_INSTALL_METHOD, OPENSHELL_ACK_BREAKING_UPGRADE) pass through too.
#
# Idempotent: when `openshell` is already on PATH it changes nothing, unless
# that install is older than the pin: then it stops and says how to remove it,
# because an old CLI on PATH (e.g. an early pip/uv install) talks to no
# gateway NanoClaw can use, and the service fails at start.
set -euo pipefail

echo "=== NANOCLAW SETUP: INSTALL_OPENSHELL ==="

fail() {
  echo "STATUS: failed"
  echo "ERROR: $1"
  echo "=== END ==="
  exit 1
}

# The "openshell" pin in versions.json, or nothing.
read_pin() {
  local versions_file
  versions_file="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/versions.json"
  tr -d '\n' <"$versions_file" 2>/dev/null |
    grep -o '"openshell"[[:space:]]*:[[:space:]]*"[^"]*"' |
    head -n1 | sed 's/.*:[[:space:]]*"//; s/"$//' || true
}

# "X.Y.Z" from `openshell X.Y.Z` / `vX.Y.Z`, or nothing.
semver() {
  echo "$1" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true
}

# Exit 0 when version $1 < $2 (both X.Y.Z).
version_lt() {
  local a1 a2 a3 b1 b2 b3
  IFS=. read -r a1 a2 a3 <<<"$1"
  IFS=. read -r b1 b2 b3 <<<"$2"
  [ "$a1" -ne "$b1" ] && { [ "$a1" -lt "$b1" ]; return; }
  [ "$a2" -ne "$b2" ] && { [ "$a2" -lt "$b2" ]; return; }
  [ "$a3" -lt "$b3" ]
}

if command -v openshell >/dev/null 2>&1; then
  found_bin="$(command -v openshell)"
  found_version="$(openshell --version 2>/dev/null || echo unknown)"
  want="${OPENSHELL_VERSION:-$(read_pin)}"
  have="$(semver "$found_version")"
  case "$want" in
    v[0-9]*)
      want="$(semver "$want")"
      if [ -n "$have" ] && [ -n "$want" ]; then
        if version_lt "$have" "$want"; then
          echo "OPENSHELL_VERSION: $found_version"
          echo "OPENSHELL_BIN: $found_bin"
          fail "openshell $have at $found_bin is older than v$want, the release NanoClaw's OpenShell driver is verified against. Remove it the way it was installed (an early pip/uv install: 'uv tool uninstall openshell'; Homebrew: 'brew upgrade nvidia/openshell/openshell'), then re-run setup to install v$want."
        elif version_lt "$want" "$have"; then
          echo "NOTE: openshell $have is newer than the pinned v$want; NanoClaw is verified against v$want"
        fi
      fi
      ;;
  esac
  echo "STATUS: already-installed"
  echo "OPENSHELL_VERSION: $found_version"
  echo "OPENSHELL_BIN: $found_bin"
  echo "=== END ==="
  exit 0
fi

case "$(uname -s)" in
  Darwin)
    case "$(uname -m)" in
      arm64 | aarch64) ;;
      *) fail "OpenShell does not support Intel Macs: NVIDIA publishes it for Apple silicon Macs and Linux only." ;;
    esac
    command -v brew >/dev/null 2>&1 ||
      fail "Homebrew is required to install OpenShell on macOS. Install it from https://brew.sh, then re-run."
    ;;
  Linux)
    if [ "$(id -u)" -ne 0 ] && ! sudo -n true 2>/dev/null; then
      fail "Installing OpenShell's Linux package needs root or passwordless sudo. Run 'sudo -v' first, or install it yourself: https://docs.nvidia.com/openshell/latest/about/installation"
    fi
    ;;
  *)
    fail "Unsupported platform for OpenShell: $(uname -s)"
    ;;
esac

if ! command -v curl >/dev/null 2>&1; then
  fail "curl not available."
fi

if [ -z "${OPENSHELL_VERSION:-}" ] && [ "${OPENSHELL_INSTALL_METHOD:-}" != "snap" ]; then
  OPENSHELL_VERSION="$(read_pin)"
  [ -n "$OPENSHELL_VERSION" ] || fail "versions.json has no \"openshell\" pin; set OPENSHELL_VERSION to the release to install."
fi
# Snap installs take a channel, not a release tag; the installer refuses a tag.
if [ "${OPENSHELL_INSTALL_METHOD:-}" = "snap" ]; then
  echo "NOTE: snap installs ignore the versions.json pin"
fi
export OPENSHELL_VERSION="${OPENSHELL_VERSION:-}"

# The installer's gateway wait defaults to 30s, which a first image pull on a
# slow link can exceed (the gateway listens only after the pull).
export OPENSHELL_INSTALL_GATEWAY_TIMEOUT="${OPENSHELL_INSTALL_GATEWAY_TIMEOUT:-180}"

# Fetch the installer from the pinned release tag, so the script and the
# packages it installs come from the same release. `dev`/`pre` have no tag.
case "$OPENSHELL_VERSION" in
  v[0-9]*) installer_ref="$OPENSHELL_VERSION" ;;
  *) installer_ref="main" ;;
esac

echo "STEP: openshell-official-install"
echo "OPENSHELL_PIN: ${OPENSHELL_VERSION:-snap}"
# /bin/sh by absolute path: a foreign `sh` first on PATH must not run the installer.
curl -fsSL "https://raw.githubusercontent.com/NVIDIA/OpenShell/${installer_ref}/install.sh" | /bin/sh ||
  fail "OpenShell's installer failed; its output is above."

# Homebrew's bin may not be on this shell's PATH yet; the Linux packages use /usr/bin.
if ! command -v openshell >/dev/null 2>&1 && command -v brew >/dev/null 2>&1; then
  PATH="$(brew --prefix)/bin:$PATH"
fi
hash -r 2>/dev/null || true

command -v openshell >/dev/null 2>&1 || fail "openshell not found on PATH after install."

echo "STATUS: installed"
echo "OPENSHELL_VERSION: $(openshell --version 2>/dev/null || echo unknown)"
echo "OPENSHELL_BIN: $(command -v openshell)"
echo "=== END ==="
