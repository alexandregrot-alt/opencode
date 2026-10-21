#!/bin/bash
# Installs workspace dependencies for Claude Code cloud sessions.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# The cloud proxy refuses bun's GitHub tarball download for ghostty-web, so bun install
# exits non-zero after installing everything else. The package is restored below instead.
bun install || true

# "github:anomalyco/ghostty-web#<sha>" from packages/app/package.json.
spec=$(bun -e 'const p = require("./packages/app/package.json"); console.log(p.dependencies?.["ghostty-web"] ?? p.devDependencies["ghostty-web"])')
sha=${spec##*#}
repo=${spec#github:}
repo=${repo%#*}
target="node_modules/.bun/ghostty-web@github+${repo//\//+}+${sha:0:7}/node_modules/ghostty-web"

if [ ! -f "$target/dist/ghostty-web.js" ]; then
  clone=$(mktemp -d)
  trap 'rm -rf "$clone"' EXIT
  git clone --quiet --filter=blob:none "https://github.com/$repo" "$clone"
  git -C "$clone" checkout --quiet "$sha"
  mkdir -p "$target"
  # dist is committed upstream, so no build step is needed.
  cp -r "$clone"/{package.json,dist,ghostty-vt.wasm,README.md,LICENSE} "$target/"
  patchfile=$(bun -e 'const p = require("./package.json").patchedDependencies; console.log(Object.entries(p).find(([k]) => k.startsWith("ghostty-web@"))?.[1] ?? "")')
  if [ -n "$patchfile" ]; then patch --quiet -p1 -d "$target" < "$patchfile"; fi
fi

# Fail the hook if anything other than ghostty-web is still missing.
bun install --frozen-lockfile 2>&1 | grep -v "ghostty-web" | grep -E "^error:" && exit 1
exit 0
