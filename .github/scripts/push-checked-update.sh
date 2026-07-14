#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 prepare <branch> | publish <branch> <message> <file>..." >&2
  exit 2
}

mode="${1:-}"
branch="${2:-}"
[[ -n "$mode" && -n "$branch" ]] || usage

git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"
export GIT_AUTHOR_NAME="github-actions[bot]"
export GIT_AUTHOR_EMAIL="github-actions[bot]@users.noreply.github.com"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

case "$mode" in
  prepare)
    git fetch origin "refs/heads/main:refs/remotes/origin/main"

    # Resume an update that passed discovery but did not reach main. Keeping this
    # branch prevents short-lived feed items from being rediscovered or lost.
    if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
      git fetch origin "refs/heads/$branch:refs/remotes/origin/$branch"
      git switch --force-create "$branch" "origin/$branch"
      git rebase origin/main
    else
      git switch --create "$branch"
    fi
    ;;

  publish)
    message="${3:-}"
    [[ -n "$message" && "$#" -ge 4 ]] || usage
    shift 3

    git add -- "$@"
    if ! git diff --cached --quiet; then
      git commit -m "$message"
    fi

    git fetch origin "refs/heads/main:refs/remotes/origin/main"
    if [[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]]; then
      echo "No automation state change to publish."
      if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
        git push origin --delete "$branch"
      fi
      exit 0
    fi

    if ! git merge-base --is-ancestor origin/main HEAD; then
      echo "Automation branch is not based on current main; leaving it intact for the next run." >&2
      exit 1
    fi

    sha="$(git rev-parse HEAD)"
    base_sha="$(git rev-parse origin/main)"
    git push --force-with-lease origin "HEAD:refs/heads/$branch"

    # Test the exact commit before publishing it through the repository-scoped
    # deploy-key bypass. workflow_dispatch is allowed from GITHUB_TOKEN without
    # enabling recursive workflow events.
    gh workflow run ci.yml --ref "$branch"

    run_id=""
    for _ in $(seq 1 60); do
      run_id="$(gh run list \
        --workflow ci.yml \
        --branch "$branch" \
        --event workflow_dispatch \
        --commit "$sha" \
        --limit 1 \
        --json databaseId \
        --jq '.[0].databaseId // empty')"
      [[ -n "$run_id" ]] && break
      sleep 2
    done
    if [[ -z "$run_id" ]]; then
      echo "Timed out waiting for CI to start for $sha; leaving $branch intact." >&2
      exit 1
    fi

    gh run watch "$run_id" --exit-status

    # Preserve the state branch if main moved while CI ran; the next automation
    # run will rebase it and repeat the test before publishing.
    git fetch origin "refs/heads/main:refs/remotes/origin/main"
    if [[ "$(git rev-parse origin/main)" != "$base_sha" ]]; then
      echo "Main moved while CI ran; leaving $branch intact for the next run." >&2
      exit 1
    fi

    git push origin "$sha:refs/heads/main"
    git push origin --delete "$branch"
    ;;

  *)
    usage
    ;;
esac
