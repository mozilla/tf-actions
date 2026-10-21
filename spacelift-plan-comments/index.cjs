'use strict';

const BOT_ID = 57898261;
const APP_ID = 47046;
const RUN_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

const COMMENT_STATES = `query CommentStates($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on IssueComment { id isMinimized viewerCanMinimize }
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

async function readStates(github, ids) {
  const states = new Map();
  for (let start = 0; start < ids.length; start += 100) {
    const { nodes } = await github.graphql(COMMENT_STATES, { ids: ids.slice(start, start + 100) });
    for (const node of nodes) if (node?.id) states.set(node.id, node);
  }
  return states;
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
  const groups = selectPlans(comments);
  // REST comments do not expose minimized state; read it once for every selection.
  const states = await readStates(github, groups.flatMap(({ keeper, older }) =>
    [keeper, ...older].map(plan => plan.comment.node_id)));
  const record = (plan, action, reason) => report({
    stack: plan.stackId, comment: plan.comment.id,
    url: plan.comment.html_url, action, reason,
  });

  for (const { keeper, older } of groups) {
    if (states.get(keeper.comment.node_id)?.isMinimized !== false) {
      record(keeper, 'skip', 'Newest result is hidden or missing; leaving this stack untouched.');
      continue;
    }
    record(keeper, 'keep', 'Newest completed proposed run for this stack.');
    for (const plan of older) {
      const state = states.get(plan.comment.node_id);
      if (!state || state.isMinimized) {
        record(plan, 'skip', 'Already hidden or deleted.');
        continue;
      }
      if (state.viewerCanMinimize !== true) {
        throw new Error(`Cannot minimize ${plan.comment.html_url}; check the workflow token pull-requests: write permission.`);
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
  if (![true, false, 'true', 'false'].includes(dryRun)) {
    throw new Error('dry-run must be true or false.');
  }
  // Errors propagate: actions/github-script fails the step on a rejected script.
  await reconcile({
    github, ...context.repo,
    prNumber: prNumber || (!manual ? context.payload.issue.number : undefined),
    dryRun: dryRun === true || dryRun === 'true',
    report({ action, stack, url, reason }) {
      core.info(`${action}: ${JSON.stringify(stack)} ${url} — ${reason}`);
    },
  });
}

module.exports = { parsePlan, selectPlans, reconcile, run };
