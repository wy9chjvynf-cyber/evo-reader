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
git worktree add -B gh-pages "$worktree" >/dev/null
find "$worktree" -mindepth 1 -maxdepth 1 -not -name ".git" -exec rm -rf {} +
cp -R dist/. "$worktree"/

git -C "$worktree" add -A
git -C "$worktree" commit -m "Deploy EvoReader build to GitHub Pages" --quiet || echo "Nada nuevo que desplegar."
git -C "$worktree" push origin gh-pages

git worktree remove "$worktree" --force

echo "Listo: https://$(gh api user --jq .login).github.io/evo-reader/"
