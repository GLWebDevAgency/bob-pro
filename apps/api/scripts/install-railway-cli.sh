#!/usr/bin/env sh
set -eu

# Binary and digest are pinned to the immutable Railway v5.26.0 GitHub release.
# Keeping this outside npm avoids executing the package's postinstall and its
# deprecated tar dependency in the privileged CI environment.
version='5.26.0'
archive='railway-v5.26.0-x86_64-unknown-linux-gnu.tar.gz'
sha256='f1b7e5abccfc4bf044342b97a39778fd10ab4c7744a6d29b9a2a9f84ed918769'
url="https://github.com/railwayapp/cli/releases/download/v${version}/${archive}"
install_dir="${RAILWAY_CLI_INSTALL_DIR:-$HOME/.local/bin}"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM
mkdir -p "$install_dir"

# Retry : un flake réseau du download ne doit pas se transformer en faux
# incident de topologie « unavailable » côté moniteur.
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
  --retry 3 --retry-delay 2 --retry-all-errors \
  --output "$tmp_dir/$archive" "$url"
printf '%s  %s\n' "$sha256" "$tmp_dir/$archive" | sha256sum --check --status
tar --extract --gzip --file "$tmp_dir/$archive" --directory "$tmp_dir" railway
install -m 0755 "$tmp_dir/railway" "$install_dir/railway"

actual_version="$("$install_dir/railway" --version)"
[ "$actual_version" = "railway $version" ] || {
  echo "Unexpected Railway CLI version: $actual_version" >&2
  exit 1
}

if [ -n "${GITHUB_PATH:-}" ]; then
  printf '%s\n' "$install_dir" >>"$GITHUB_PATH"
fi
