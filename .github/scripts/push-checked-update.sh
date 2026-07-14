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
    git push --force-with-lease origin "HEAD:refs/heads/$branch"

    pr_number="$(gh pr list \
      --base main \
      --head "$branch" \
      --state open \
      --limit 1 \
      --json number \
      --jq '.[0].number // empty')"
    if [[ -z "$pr_number" ]]; then
      gh pr create \
        --base main \
        --head "$branch" \
        --title "$message" \
        --body "Automated state update. The existing CI workflow is dispatched against this exact commit before merge."
      pr_number="$(gh pr list \
        --base main \
        --head "$branch" \
        --state open \
        --limit 1 \
        --json number \
        --jq '.[0].number // empty')"
    fi
    if [[ -z "$pr_number" ]]; then
      echo "Could not resolve the automation pull request for $branch." >&2
      exit 1
    fi

    # Branch protection requires the CI job named `test` on the exact commit
    # being merged. workflow_dispatch is intentionally used because GitHub
    # permits GITHUB_TOKEN-triggered dispatches without allowing event loops or
    # requiring a separate PAT for workflow-created pull requests.
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

    # Strict status checks also require the tested commit to remain up to date.
    # If main moved during CI, preserve the branch and let the next run rebase it.
    git fetch origin "refs/heads/main:refs/remotes/origin/main"
    if ! git merge-base --is-ancestor origin/main HEAD; then
      echo "Main moved while CI ran; leaving $branch intact for the next run." >&2
      exit 1
    fi

    gh pr merge "$pr_number" --squash --delete-branch
    ;;

  *)
    usage
    ;;
esac
