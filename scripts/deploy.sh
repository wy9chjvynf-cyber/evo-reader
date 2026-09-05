#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Hay cambios sin commitear. Commitea o descarta antes de desplegar." >&2
  exit 1
fi

GH_PAGES=1 npm run build
touch dist/.nojekyll

worktree=$(mktemp -d)
git fetch origin gh-pages >/dev/null 2>&1 || true

if git rev-parse --verify origin/gh-pages >/dev/null 2>&1; then
  # Start from whatever is already live so previously deployed content-hashed
  # assets (JS, the pdf.worker) stick around for any client that still has an
  # older build loaded and hasn't re-fetched index.html yet.
  git worktree add -B gh-pages "$worktree" origin/gh-pages >/dev/null
else
  git worktree add --detach "$worktree" >/dev/null
  git -C "$worktree" checkout --orphan gh-pages >/dev/null
  git -C "$worktree" rm -rf . >/dev/null 2>&1 || true
fi

# Overlay the new build ON TOP without deleting existing files first, so old
# hashed assets from previous deploys are preserved rather than destroyed.
cp -R dist/. "$worktree"/

git -C "$worktree" add -A
git -C "$worktree" commit -m "Deploy EvoReader build to GitHub Pages" --quiet || echo "Nada nuevo que desplegar."
git -C "$worktree" push origin gh-pages

git worktree remove "$worktree" --force

echo "Listo: https://$(gh api user --jq .login).github.io/evo-reader/"
