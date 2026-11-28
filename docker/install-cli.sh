#!/bin/sh
set -eu

version=${1:?Set NAPUKETTO_VERSION to an exact published CLI version}
integrity=${2:?Set NAPUKETTO_INTEGRITY to the expected CLI tarball SHA-512 SRI}
prefix=${3:?Missing installation prefix}

if ! printf '%s\n' "$version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
    echo "NAPUKETTO_VERSION must be an exact X.Y.Z release version" >&2
    exit 2
fi
if ! printf '%s\n' "$integrity" | grep -Eq '^sha512-[A-Za-z0-9+/]{86}==$'; then
    echo "NAPUKETTO_INTEGRITY must be a SHA-512 SRI" >&2
    exit 2
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
npm pack --ignore-scripts --registry https://registry.npmjs.org --pack-destination "$tmp" "@napuketto/cli@$version"
archive="$tmp/napuketto-cli-$version.tgz"
actual=$(node -e 'const {createHash}=require("node:crypto"); const {readFileSync}=require("node:fs"); process.stdout.write("sha512-" + createHash("sha512").update(readFileSync(process.argv[1])).digest("base64"))' "$archive")
if [ "$actual" != "$integrity" ]; then
    echo "CLI tarball integrity mismatch for @napuketto/cli@$version" >&2
    exit 2
fi

npm install -g --no-fund --no-audit --prefix "$prefix" "$archive"
