#!/usr/bin/env bash
# cjvibe installer — downloads the latest release binary and adds it to PATH.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/MaxNoragami/cjvibe/main/install.sh | bash
#
set -euo pipefail

REPO="MaxNoragami/cjvibe"
INSTALL_DIR="${CJVIBE_INSTALL_DIR:-$HOME/.local/bin}"

# Detect OS + arch
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS" in
  linux)  PLATFORM="linux" ;;
  darwin) PLATFORM="darwin" ;;
  *)      echo "Unsupported OS: $OS"; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64)  ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)             echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

BINARY="cjvibe-${PLATFORM}-${ARCH}"

# Get latest release tag
echo "Fetching latest release..."
TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep '"tag_name"' | head -1 | cut -d'"' -f4)

if [ -z "$TAG" ]; then
  echo "Error: Could not determine latest release."
  exit 1
fi

URL="https://github.com/${REPO}/releases/download/${TAG}/${BINARY}"

echo "Downloading cjvibe ${TAG} (${PLATFORM}-${ARCH})..."
mkdir -p "$INSTALL_DIR"
curl -fsSL "$URL" -o "${INSTALL_DIR}/cjvibe"
chmod +x "${INSTALL_DIR}/cjvibe"

# Ensure INSTALL_DIR is in PATH
add_to_path() {
  local shell_rc="$1"
  if [ -f "$shell_rc" ]; then
    if ! grep -q "$INSTALL_DIR" "$shell_rc" 2>/dev/null; then
      echo "" >> "$shell_rc"
      echo "# cjvibe" >> "$shell_rc"
      echo "export PATH=\"${INSTALL_DIR}:\$PATH\"" >> "$shell_rc"
      echo "Updated $shell_rc"
    fi
  fi
}

if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
  echo ""
  echo "${INSTALL_DIR} is not in your PATH. Adding it..."

  # Detect shell and update rc
  SHELL_NAME="$(basename "${SHELL:-/bin/bash}")"
  case "$SHELL_NAME" in
    bash)
      add_to_path "$HOME/.bashrc"
      ;;
    zsh)
      add_to_path "$HOME/.zshrc"
      ;;
    fish)
      FISH_CONF="$HOME/.config/fish/config.fish"
      if [ -f "$FISH_CONF" ]; then
        if ! grep -q "$INSTALL_DIR" "$FISH_CONF" 2>/dev/null; then
          echo "" >> "$FISH_CONF"
          echo "# cjvibe" >> "$FISH_CONF"
          echo "fish_add_path ${INSTALL_DIR}" >> "$FISH_CONF"
          echo "Updated $FISH_CONF"
        fi
      else
        mkdir -p "$(dirname "$FISH_CONF")"
        echo "# cjvibe" > "$FISH_CONF"
        echo "fish_add_path ${INSTALL_DIR}" >> "$FISH_CONF"
        echo "Created $FISH_CONF"
      fi
      ;;
    *)
      add_to_path "$HOME/.profile"
      ;;
  esac

  export PATH="${INSTALL_DIR}:$PATH"
fi

echo ""
echo "✓ cjvibe ${TAG} installed to ${INSTALL_DIR}/cjvibe"
echo ""
echo "Run 'cjvibe' to get started. You may need to restart your shell or run:"
echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
