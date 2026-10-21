'use strict';

const BOT_ID = 57898261;
const APP_ID = 47046;
const ORIGIN = 'https://mozilla.app.spacelift.io';
const HEADER = /^Run for Spacelift-only stack `[^`]+` has (FINISHED|FAILED) : \[view run\]\((https:\/\/[^\s)]+)\)$/;
const RUN_PATH = /^\/stack\/(.+)\/run\/([0-7][0-9A-HJKMNP-TV-Z]{25})$/;

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

// Only the custom proposed-run notification policy is in scope. In particular,
// deployment notifications and human comments quoting a plan must not match.
function parsePlan(comment) {
  if (comment.user?.id !== BOT_ID || comment.user?.type !== 'Bot' ||
      comment.performed_via_github_app?.id !== APP_ID) return null;
  const header = (comment.body || '').split(/\r?\n/, 1)[0];
  const match = HEADER.exec(header);
  if (!match) return null;
  try {
    const url = new URL(match[2]);
    const path = RUN_PATH.exec(url.pathname);
    if (url.origin !== ORIGIN || url.username || url.password ||
        url.search || url.hash || !path) return null;
    const stackId = decodeURIComponent(path[1]);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(stackId)) return null;
    return { comment, stackId, runId: path[2], state: match[1] };
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
    const batch = ids.slice(start, start + 100);
    const { nodes } = await github.graphql(COMMENT_STATES, { ids: batch });
    if (!Array.isArray(nodes) || nodes.length !== batch.length) {
      throw new Error('Incomplete comment state response; refusing to hide comments.');
    }
    for (const node of nodes) {
      if (node?.id) states.set(node.id, node);
    }
  }
  return states;
}

function unchanged(plan, state) {
  return state && typeof state.isMinimized === 'boolean' &&
    state.body === plan.comment.body;
}

async function reconcile({ github, owner, repo, prNumber, dryRun = true, report = () => {} }) {
  if (!/^[1-9][0-9]*$/.test(String(prNumber)) || !Number.isSafeInteger(Number(prNumber))) {
    throw new Error('pr_number must be a positive integer.');
  }
  // Unlike the issue-comment endpoint, this rejects ordinary issue numbers.
  await github.rest.pulls.get({ owner, repo, pull_number: Number(prNumber) });
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner, repo, issue_number: Number(prNumber), per_page: 100,
  });
  const groups = selectPlans(comments);
  // Read every page and all candidate states before performing any mutations.
  const states = await readStates(github, groups.flatMap(({ keeper, older }) =>
    [keeper, ...older].map(({ comment }) => comment.node_id)));

  const record = (plan, action, reason) => report({
    stack: plan.stackId, comment: plan.comment.id,
    url: plan.comment.html_url, action, reason,
  });

  for (const { keeper, older } of groups) {
    const all = [keeper, ...older];
    if (all.some(plan => !unchanged(plan, states.get(plan.comment.node_id)))) {
      record(keeper, 'skipped', 'Comment changed or disappeared during the scan; rerun cleanup.');
      continue;
    }
    if (states.get(keeper.comment.node_id).isMinimized) {
      record(keeper, 'skipped', 'Newest result is hidden; leaving this stack untouched.');
      continue;
    }
    record(keeper, 'keep', 'Newest completed proposed run for this stack.');
    for (const plan of older) {
      if (states.get(plan.comment.node_id).isMinimized) {
        record(plan, 'already hidden', 'Preserving existing moderation.');
        continue;
      }
      // Refresh both sides immediately before each mutation. Do not remove the
      // fallback if its replacement was deleted, edited, or manually hidden.
      const current = await readStates(github, [keeper.comment.node_id, plan.comment.node_id]);
      const replacement = current.get(keeper.comment.node_id);
      const candidate = current.get(plan.comment.node_id);
      if (!unchanged(keeper, replacement) || replacement.isMinimized) {
        record(keeper, 'skipped', 'Replacement changed or is no longer visible; stopping this stack.');
        break;
      }
      if (!unchanged(plan, candidate)) {
        record(plan, 'skipped', 'Comment changed or disappeared; rerun cleanup.');
        continue;
      }
      if (candidate.isMinimized) {
        record(plan, 'already hidden', 'Preserving existing moderation.');
        continue;
      }
      if (candidate.viewerCanMinimize !== true) {
        record(plan, 'blocked', 'Workflow token cannot minimize this comment.');
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
      record(plan, 'hidden', `Superseded by comment ${keeper.comment.id}.`);
    }
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
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
  const rows = [];
  try {
    await reconcile({
      github, ...context.repo, prNumber, dryRun,
      report(row) {
        rows.push(row);
        core.info(JSON.stringify(row));
        if (row.action === 'skipped' || row.action === 'blocked') core.warning(row.reason);
      },
    });
  } catch (error) {
    core.setFailed(error.message);
  } finally {
    core.summary.addHeading(`Spacelift plan comments${dryRun ? ' (dry run)' : ''}`);
    if (rows.length) {
      core.summary.addTable([
        ['Stack', 'Comment', 'Action', 'Reason'],
        ...rows.map(row => [escapeHtml(row.stack),
          `<a href="${escapeHtml(row.url)}">${row.comment}</a>`,
          escapeHtml(row.action), escapeHtml(row.reason)]),
      ]);
    } else {
      core.summary.addRaw('No comment changes were selected. See the job log for any errors.');
    }
    await core.summary.write();
  }
}

module.exports = { parsePlan, selectPlans, reconcile, run };
