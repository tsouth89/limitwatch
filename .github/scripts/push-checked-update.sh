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
        --body "Automated state update. The existing CI workflow passed against this exact commit before merge."
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

    # Strict protection evaluates the PR's synthetic merge commit. Wait until
    # GitHub has combined the exact current base and automation head.
    base_sha="$(git rev-parse origin/main)"
    merge_sha=""
    for _ in $(seq 1 60); do
      candidate="$(gh api \
        "repos/$GITHUB_REPOSITORY/git/ref/pull/$pr_number/merge" \
        --jq '.object.sha' 2>/dev/null || true)"
      parents=""
      if [[ -n "$candidate" ]]; then
        parents="$(gh api "repos/$GITHUB_REPOSITORY/commits/$candidate" \
          --jq '.parents[].sha' 2>/dev/null || true)"
      fi
      if [[ -n "$candidate" ]] && grep -qx "$base_sha" <<<"$parents" && grep -qx "$sha" <<<"$parents"; then
        merge_sha="$candidate"
        break
      fi
      sleep 2
    done
    if [[ -z "$merge_sha" ]]; then
      echo "Timed out waiting for PR $pr_number to combine current main $base_sha with automation head $sha." >&2
      exit 1
    fi

    # A branch pointing at the synthetic commit lets workflow_dispatch create
    # the native GitHub Actions `test` check on the exact commit protection
    # evaluates. API-created checks can cause GitHub to refresh the merge ref,
    # immediately making those checks stale.
    check_branch="automation-merge-check-$pr_number"
    if gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/$check_branch" >/dev/null 2>&1; then
      gh api \
        --method PATCH \
        "repos/$GITHUB_REPOSITORY/git/refs/heads/$check_branch" \
        --field sha="$merge_sha" \
        -F force=true \
        --silent
    else
      gh api \
        --method POST \
        "repos/$GITHUB_REPOSITORY/git/refs" \
        --field ref="refs/heads/$check_branch" \
        --field sha="$merge_sha" \
        --silent
    fi

    gh workflow run ci.yml --ref "$check_branch"

    run_id=""
    for _ in $(seq 1 60); do
      run_id="$(gh run list \
        --workflow ci.yml \
        --branch "$check_branch" \
        --event workflow_dispatch \
        --commit "$merge_sha" \
        --limit 1 \
        --json databaseId \
        --jq '.[0].databaseId // empty')"
      [[ -n "$run_id" ]] && break
      sleep 2
    done
    if [[ -z "$run_id" ]]; then
      echo "Timed out waiting for merge CI to start for $merge_sha; leaving $branch intact." >&2
      exit 1
    fi

    gh run watch "$run_id" --exit-status
    gh api \
      --method DELETE \
      "repos/$GITHUB_REPOSITORY/git/refs/heads/$check_branch" \
      --silent

    # Preserve the state branch if main or the synthetic merge commit changed
    # while CI ran; the next automation run will rebase and try again.
    git fetch origin "refs/heads/main:refs/remotes/origin/main"
    current_merge_sha="$(gh api \
      "repos/$GITHUB_REPOSITORY/git/ref/pull/$pr_number/merge" \
      --jq '.object.sha' 2>/dev/null || true)"
    if [[ "$(git rev-parse origin/main)" != "$base_sha" || "$current_merge_sha" != "$merge_sha" ]]; then
      echo "Main or PR merge ref moved while CI ran; leaving $branch intact for the next run." >&2
      exit 1
    fi

    merge_ready="false"
    for _ in $(seq 1 30); do
      merge_state="$(gh pr view "$pr_number" --json mergeStateStatus --jq '.mergeStateStatus')"
      case "$merge_state" in
        CLEAN|HAS_HOOKS|UNSTABLE)
          merge_ready="true"
          break
          ;;
      esac
      sleep 2
    done
    if [[ "$merge_ready" != "true" ]]; then
      echo "Timed out waiting for PR $pr_number to become mergeable." >&2
      exit 1
    fi

    gh pr merge "$pr_number" --squash --delete-branch
    ;;

  *)
    usage
    ;;
esac
