# Spacelift plan comments action

[MZCLD-4481](https://mozilla-hub.atlassian.net/browse/MZCLD-4481) keeps the newest
completed proposed-run result visible for each stack on a PR. Previous results
are minimized with GitHub's `OUTDATED` reason, preserving expandable history.

The caller workflow listens for comments created or edited by
`spacelift-io[bot]`. The action verifies the bot's numeric user ID and originating
GitHub App ID before matching the comments produced by Mozilla's
[`spacelift_only_pr.rego` notification policy](https://github.com/mozilla/global-platform-admin/blob/main/spacelift/tf/root/policies/notification/spacelift_only_pr.rego).
It takes the stack ID from the run URL, not the display name. Deploy
notifications, native Spacelift comments with other formats, and other authors'
comments are ignored. The account is restricted to `mozilla.app.spacelift.io`.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `github-token` | `${{ github.token }}` | Token with `pull-requests: write` in the caller repository. |
| `pr-number` | Event's PR number | Optional for `issue_comment`; required for `workflow_dispatch`. |
| `dry-run` | `true` | Report decisions without changing comments. Set explicitly to `false` to minimize them. |

The repository is always taken from the caller's GitHub context. There is no
cross-repository token or target-repository input. Workflow input names are up
to the caller; pass their values to these action inputs. Only `issue_comment`
and `workflow_dispatch` events on the caller's default branch are supported.

## Caller workflow

Add this file to `.github/workflows/hide-outdated-spacelift-plans.yaml` in each
repository using the notification policy. Replace the reference placeholder
with a full commit SHA containing this action before merging the caller.

```yaml
name: Hide outdated Spacelift plans

on:
  issue_comment:
    types: [created, edited]
  workflow_dispatch:
    inputs:
      pr_number:
        description: Pull request to reconcile
        type: string
        required: true
      dry_run:
        description: Report changes without hiding comments
        type: boolean
        default: true

permissions: {}

jobs:
  hide:
    if: >-
      (github.event_name == 'issue_comment' &&
       github.event.issue.pull_request != null &&
       github.event.comment.user.id == 57898261) ||
      (github.event_name == 'workflow_dispatch' &&
       github.ref == format('refs/heads/{0}', github.event.repository.default_branch))
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      pull-requests: write
    concurrency:
      group: spacelift-plan-comments-${{ github.event.issue.number || inputs.pr_number }}
      cancel-in-progress: false
    steps:
      - name: Reconcile Spacelift plan comments
        uses: mozilla/tf-actions/spacelift-plan-comments@REPLACE_WITH_TF_ACTIONS_COMMIT_SHA
        with:
          pr-number: ${{ github.event.issue.number || inputs.pr_number }}
          dry-run: ${{ github.event_name == 'workflow_dispatch' && inputs.dry_run }}
```

Comment events apply cleanup automatically; manual runs default to dry-run.
To observe automatic events without hiding anything during an initial rollout,
temporarily set the action's `dry-run` input to `true` in the caller.

GitHub downloads the pinned action and its helper together. The composite
loads the helper from `github.action_path`; it does not check out or execute
code from the caller repository. No `contents: read` permission is needed for
the cleanup job. The caller's Actions policy must allow this action and
`actions/github-script`.

## Selection and recovery

Spacelift run IDs are ULIDs, so sorting them by ASCII order selects the newest
run even when an older run finishes later. Equal timestamps use the remainder
of the run ID as a deterministic tie break. Duplicate comments for one run
keep the most recently created comment, then the greatest comment ID. Editing
a comment does not promote its run. A `FAILED` result supersedes an older
successful result; starting a new run alone does not hide the old plan.

The helper reads all comment pages and minimization states before making any
changes. It checks that the replacement still exists, has the same body, and
is visible before each mutation. Runs are serialized per PR and always scan
current comments, so a delayed event or replaced pending workflow cannot make
its triggering comment the winner. Already minimized comments stay minimized,
with their existing reason. A hidden newest result pauses cleanup for that
stack. The helper never automatically unhides comments; if the latest result
is deleted or manually hidden, a maintainer must restore the desired comment
before rerunning cleanup. GitHub reads and writes are not atomic; a deletion
immediately after the final check still needs this manual recovery.

## Deployment and backfill

Merge and publish this action in `mozilla/tf-actions` first. Then pin each
caller to the resulting full commit SHA and merge the caller into its
repository's default branch to activate comment events. No Spacelift policy
deployment, PAT, or Spacelift API credential is required. Pin upgrades can be
managed by Dependabot's `github-actions` ecosystem in consuming repositories.

In Actions, choose **Hide outdated Spacelift plans**, then **Run workflow** on
the default branch. Enter a PR number and leave `dry_run` enabled first. The
job summary links the selected comments and reports the exact decisions. A
dry run also checks `viewerCanMinimize` with the actual workflow token. Rerun
with `dry_run` disabled to apply the changes. API failures fail the job;
transient HTTP failures are retried by `actions/github-script`. Rerunning is
safe after a partial failure. There is no scheduled sweep: rerun manually to
recover a missed event or failed job.

For PR 7799, the initial acceptance case keeps comment `6305338609`, leaves
`6303760140` hidden, and minimizes `6304094455`, `6304380444`, `6304604691`,
`6304779045`, and `6305177539`.

## Local tests

Run from the repository root with Node.js 22 or newer:

```sh
node --test spacelift-plan-comments/index.test.cjs
```

The same tests run in this repository's Actions workflow when the action or
its test workflow changes. They also exercise the composite entrypoint from
a different working directory to verify it loads the bundled helper.

References: [Spacelift run IDs](https://docs.spacelift.io/integrations/cloud-providers/aws.html#session-tagging),
[GitHub comment minimization](https://docs.github.com/en/graphql/reference/issues#minimizecomment).
