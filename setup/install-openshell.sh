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
# before it accepts connections. setup/openshell-install.ts checks the result.
#
# Version: OPENSHELL_VERSION from the environment when set (passed straight
# through to the installer, which also accepts `dev` and `pre`), otherwise the
# "openshell" pin in versions.json. NanoClaw's OpenShell driver is verified
# against that pinned release. Other installer variables
# (OPENSHELL_INSTALL_METHOD, OPENSHELL_ACK_BREAKING_UPGRADE) pass through too.
#
# Idempotent: when `openshell` is already on PATH it changes nothing.
set -euo pipefail

echo "=== NANOCLAW SETUP: INSTALL_OPENSHELL ==="

fail() {
  echo "STATUS: failed"
  echo "ERROR: $1"
  echo "=== END ==="
  exit 1
}

if command -v openshell >/dev/null 2>&1; then
  echo "STATUS: already-installed"
  echo "OPENSHELL_VERSION: $(openshell --version 2>/dev/null || echo unknown)"
  echo "OPENSHELL_BIN: $(command -v openshell)"
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
  versions_file="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/versions.json"
  OPENSHELL_VERSION="$(tr -d '\n' <"$versions_file" 2>/dev/null |
    grep -o '"openshell"[[:space:]]*:[[:space:]]*"[^"]*"' |
    head -n1 | sed 's/.*:[[:space:]]*"//; s/"$//')" || true
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
