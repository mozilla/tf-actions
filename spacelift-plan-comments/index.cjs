'use strict';

const BOT_ID = 57898261;
const APP_ID = 47046;
const RUN_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

const COMMENT_STATES = `query CommentStates($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on IssueComment { id body isMinimized viewerCanMinimize }
  }
}`;
const MINIMIZE = `mutation HideOutdatedPlan($id: ID!) {
  minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) {
    minimizedComment { isMinimized }
  }
}`;

// The notification policy appends a versioned JSON marker. Visible wording
// and links are not part of the contract; comments without metadata are ignored.
function parsePlan(comment) {
  if (comment.user?.id !== BOT_ID || comment.user?.type !== 'Bot' ||
      comment.performed_via_github_app?.id !== APP_ID) return null;
  const match = /(?:^|\n)<!-- spacelift-plan: (.+) -->\s*$/.exec(comment.body || '');
  if (!match) return null;
  try {
    const metadata = JSON.parse(match[1]);
    if (metadata?.version !== 1 || metadata.account !== 'mozilla' ||
        metadata.type !== 'PROPOSED' || !['FINISHED', 'FAILED'].includes(metadata.state) ||
        typeof metadata.stack_id !== 'string' || !metadata.stack_id ||
        typeof metadata.run_id !== 'string' || !RUN_ID.test(metadata.run_id)) return null;
    return { comment, stackId: metadata.stack_id, runId: metadata.run_id, state: metadata.state };
  } catch {
    return null;
  }
}

function compare(a, b) {
  // Spacelift run IDs are fixed-width ULIDs: ASCII order follows run creation
  // time. Equal timestamps have a deterministic run-ID tie break. Never order
  // different runs by comment creation/update time: old runs can finish late.
  if (a.runId !== b.runId) return a.runId < b.runId ? -1 : 1;
  if (a.comment.created_at !== b.comment.created_at) {
    return a.comment.created_at < b.comment.created_at ? -1 : 1;
  }
  return a.comment.id - b.comment.id;
}

function selectPlans(comments) {
  const groups = new Map();
  for (const comment of comments) {
    const plan = parsePlan(comment);
    if (!plan) continue;
    const group = groups.get(plan.stackId) || [];
    group.push(plan);
    groups.set(plan.stackId, group);
  }
  return [...groups.entries()].map(([stackId, plans]) => {
    plans.sort(compare);
    return { stackId, keeper: plans.at(-1), older: plans.slice(0, -1) };
  });
}

function unchanged(plan, state) {
  return state && state.id === plan.comment.node_id && typeof state.isMinimized === 'boolean' &&
    state.body === plan.comment.body;
}

async function reconcile({ github, owner, repo, prNumber, dryRun = true, report = () => {} }) {
  if (!/^[1-9][0-9]*$/.test(String(prNumber)) || !Number.isSafeInteger(Number(prNumber))) {
    throw new Error('pr_number must be a positive integer.');
  }
  // Unlike the issue-comment endpoint, this rejects ordinary issue numbers.
  await github.rest.pulls.get({ owner, repo, pull_number: Number(prNumber) });
  // Finish pagination before choosing the newest run for each stack.
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner, repo, issue_number: Number(prNumber), per_page: 100,
  });
  const record = (plan, action, reason) => report({
    stack: plan.stackId, comment: plan.comment.id,
    url: plan.comment.html_url, action, reason,
  });

  for (const { keeper, older } of selectPlans(comments)) {
    record(keeper, 'keep', 'Newest completed proposed run for this stack.');
    for (const plan of older) {
      // Refresh both sides immediately before each mutation. Do not remove the
      // fallback if its replacement was deleted, edited, or manually hidden.
      const { nodes } = await github.graphql(COMMENT_STATES, {
        ids: [keeper.comment.node_id, plan.comment.node_id],
      });
      if (!Array.isArray(nodes) || nodes.length !== 2) {
        throw new Error('Incomplete comment state response; refusing to hide comments.');
      }
      const [replacement, candidate] = nodes;
      if (!unchanged(keeper, replacement) || replacement.isMinimized) {
        record(keeper, 'skip', 'Replacement changed or is no longer visible; stopping this stack.');
        break;
      }
      if (!unchanged(plan, candidate)) {
        record(plan, 'skip', 'Comment changed or disappeared; rerun cleanup.');
        continue;
      }
      if (candidate.isMinimized) {
        record(plan, 'skip', 'Already hidden; preserving existing moderation.');
        continue;
      }
      if (candidate.viewerCanMinimize !== true) {
        record(plan, 'skip', 'Workflow token cannot minimize this comment.');
        throw new Error('Cannot minimize comments; check the workflow token pull-requests: write permission.');
      }
      if (dryRun) {
        record(plan, 'would hide', `Superseded by comment ${keeper.comment.id}.`);
        continue;
      }
      const result = await github.graphql(MINIMIZE, { id: plan.comment.node_id });
      if (result.minimizeComment?.minimizedComment?.isMinimized !== true) {
        throw new Error(`GitHub did not confirm minimization of comment ${plan.comment.id}.`);
      }
      record(plan, 'hide', `Superseded by comment ${keeper.comment.id}.`);
    }
  }
}

// Action inputs are explicit so callers can name their workflow_dispatch inputs
// however they like. Both event types default to dry-run unless opted in.
async function run({ github, context, core, prNumber, dryRun = 'true' }) {
  const manual = context.eventName === 'workflow_dispatch';
  if (!manual && (context.eventName !== 'issue_comment' ||
      !context.payload.issue?.pull_request ||
      context.payload.comment?.user?.id !== BOT_ID)) return;
  const defaultBranch = context.payload.repository.default_branch;
  if (context.ref !== `refs/heads/${defaultBranch}`) {
    throw new Error('Cleanup must run from the default branch.');
  }
  prNumber = prNumber || (!manual ? context.payload.issue.number : undefined);
  if (![true, false, 'true', 'false'].includes(dryRun)) {
    throw new Error('dry-run must be true or false.');
  }
  dryRun = dryRun === true || dryRun === 'true';
  try {
    await reconcile({
      github, ...context.repo, prNumber, dryRun,
      report({ action, stack, url, reason }) {
        core.info(`${action}: ${JSON.stringify(stack)} ${url} — ${reason}`);
      },
    });
  } catch (error) {
    core.setFailed(error.message);
  }
}

module.exports = { parsePlan, selectPlans, reconcile, run };
