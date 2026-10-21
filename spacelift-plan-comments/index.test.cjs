'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require('node:fs');
const { createRequire } = require('node:module');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { parsePlan, selectPlans, reconcile, run } = require('./index.cjs');

const OLD_RUN = '01M5DRTNYWWAMP9VKHR5GR6SSW';
const NEW_RUN = '01M5DZCFDN5VJ0PXQVY4JPMAMH';

function comment(id, runId = OLD_RUN, stack = 'root', state = 'FINISHED') {
  return {
    id, node_id: `comment-${id}`,
    user: { id: 57898261, login: 'spacelift-io[bot]', type: 'Bot' },
    performed_via_github_app: { id: 47046 },
    created_at: '2026-10-20T23:04:55Z',
    html_url: `https://github.com/mozilla/global-platform-admin/pull/7799#issuecomment-${id}`,
    body: `Run for Spacelift-only stack \`display name\` has ${state} : [view run](https://mozilla.app.spacelift.io/stack/${stack}/run/${runId})\n\nPlan summary`,
  };
}

// Recorded comment/run identities from PR 7799; plan bodies are intentionally
// reduced to the header that this workflow owns.
function pr7799() {
  return [
    [6303760140, OLD_RUN],
    [6304094455, '01M5DT3BC5GKJ0SWYHMKKTHGMB'],
    [6304380444, '01M5DV99BVWMYA7PWHWQ51J9ZD'],
    [6304604691, '01M5DW84X22M24AG037ZCBG3SX'],
    [6304779045, '01M5DWZ6SJPMR6BP9T8DQGHZKA'],
    [6305177539, '01M5DYP41XXJM4AWHDPGAZM3XJ'],
    [6305338609, NEW_RUN],
  ].map(([id, runId]) => comment(id, runId));
}

function mockGitHub(comments) {
  const states = new Map(comments.map(c => [c.node_id, {
    id: c.node_id, body: c.body, isMinimized: false, viewerCanMinimize: true,
  }]));
  const api = { states, mutations: [], reads: [], pages: [], beforeRead: () => {} };
  api.rest = {
    pulls: { get: async () => ({ data: { number: 7799 } }) },
    issues: { listComments: async ({ page, per_page: size }) => {
      api.pages.push(page);
      return { data: comments.slice((page - 1) * size, page * size) };
    } },
  };
  api.paginate = async (route, parameters) => {
    const result = [];
    for (let page = 1; ; page++) {
      const { data } = await route({ ...parameters, page });
      result.push(...data);
      if (data.length < parameters.per_page) return result;
    }
  };
  api.graphql = async (query, variables) => {
    if (query.includes('query CommentStates')) {
      api.reads.push(variables.ids);
      api.beforeRead(variables.ids, api.reads.length);
      return { nodes: variables.ids.map(id => structuredClone(states.get(id) || null)) };
    }
    assert.match(query, /classifier: OUTDATED/);
    assert.match(query, /subjectId: \$id/);
    if (api.failMutation === variables.id) throw new Error('Temporary API failure');
    api.mutations.push(variables.id);
    states.get(variables.id).isMinimized = true;
    return { minimizeComment: { minimizedComment: { isMinimized: true } } };
  };
  return api;
}

async function execute(github, dryRun = false) {
  const rows = [];
  await reconcile({ github, owner: 'mozilla', repo: 'global-platform-admin',
    prNumber: 7799, dryRun, report: row => rows.push(row) });
  return rows;
}

test('PR 7799 hides exactly five remaining old comments and is idempotent', async () => {
  const github = mockGitHub(pr7799());
  github.states.get('comment-6303760140').isMinimized = true;
  const rows = await execute(github);
  assert.deepEqual(github.mutations, [6304094455, 6304380444, 6304604691, 6304779045, 6305177539]
    .map(id => `comment-${id}`));
  assert.deepEqual(rows.filter(r => r.action === 'keep').map(r => r.comment), [6305338609]);
  assert.equal(github.states.get('comment-6305338609').isMinimized, false);
  github.mutations.length = 0;
  await execute(github);
  assert.deepEqual(github.mutations, []);
});

test('dry run reports the same changes without any mutations', async () => {
  const github = mockGitHub(pr7799());
  github.states.get('comment-6303760140').isMinimized = true;
  const rows = await execute(github, true);
  assert.equal(rows.filter(r => r.action === 'would hide').length, 5);
  assert.deepEqual(github.mutations, []);
});

test('late arrival and edits cannot promote an older run', () => {
  const old = comment(3);
  old.created_at = '2026-10-22T00:00:00Z';
  old.updated_at = '2026-10-23T00:00:00Z';
  const newest = comment(2, NEW_RUN);
  assert.equal(selectPlans([newest, old])[0].keeper.comment.id, 2);
});

test('groups by stack ID even when display names are identical', async () => {
  const github = mockGitHub([
    comment(1), comment(2, NEW_RUN),
    comment(3, OLD_RUN, 'admin-aws-sso/cloudservices'),
    comment(4, NEW_RUN, 'admin-aws-sso%2Fcloudservices'),
  ]);
  await execute(github);
  assert.deepEqual(github.mutations, ['comment-1', 'comment-3']);
});

test('a latest failure supersedes success; a pending run does not', async () => {
  const github = mockGitHub([
    comment(1), comment(2, NEW_RUN, 'root', 'FAILED'),
    comment(3, NEW_RUN, 'other-stack', 'PLANNING'),
    comment(4, OLD_RUN, 'other-stack'),
  ]);
  const rows = await execute(github);
  assert.deepEqual(github.mutations, ['comment-1']);
  assert.deepEqual(rows.filter(r => r.action === 'keep').map(r => r.comment), [2, 4]);
});

test('duplicate run results choose creation time then numeric comment ID', () => {
  const first = comment(1);
  const last = comment(10);
  const edited = comment(9);
  edited.created_at = '2026-10-20T22:00:00Z';
  edited.updated_at = '2026-10-24T00:00:00Z';
  assert.equal(selectPlans([last, first, edited])[0].keeper.comment.id, 10);
});

test('rejects other authors, apps, hosts, malformed IDs, and deploy notifications', () => {
  const original = comment(1);
  const invalid = [
    { ...original, user: { ...original.user, id: 123 } },
    { ...original, user: { ...original.user, type: 'User' } },
    { ...original, performed_via_github_app: { id: 123 } },
    { ...original, performed_via_github_app: null },
    { ...original, body: original.body.replace('mozilla.app.spacelift.io', 'mozilla.app.spacelift.io.evil.test') },
    { ...original, body: original.body.replace('mozilla.app.spacelift.io', 'user@mozilla.app.spacelift.io') },
    { ...original, body: original.body.replace(OLD_RUN, 'not-a-run') },
    { ...original, body: original.body.replace(OLD_RUN, '81M5DRTNYWWAMP9VKHR5GR6SSW') },
    { ...original, body: original.body.replace('/stack/root/', '/stack/%ZZ/') },
    { ...original, body: ':heavy_check_mark: **Deploy succeeded** for stack `root`' },
    { ...original, body: `A quoted plan:\n${original.body}` },
  ];
  for (const c of invalid) assert.equal(parsePlan(c), null);
  assert.equal(parsePlan(original).stackId, 'root');
  assert.equal(parsePlan({ ...original, body: original.body.replaceAll('\n', '\r\n') }).runId, OLD_RUN);
});

test('does not hide anything when the newest result is already minimized', async () => {
  const github = mockGitHub([comment(1), comment(2, NEW_RUN)]);
  github.states.get('comment-2').isMinimized = true;
  const rows = await execute(github);
  assert.deepEqual(github.mutations, []);
  assert.equal(rows[0].action, 'skipped');
});

test('reads past 100 comments and all state batches before hiding anything', async () => {
  const comments = Array.from({ length: 101 }, (_, i) => comment(i + 1));
  comments.push(comment(102, NEW_RUN));
  const github = mockGitHub(comments);
  github.beforeRead = (ids, count) => {
    if (count <= 2) assert.deepEqual(github.mutations, []);
  };
  await execute(github);
  assert.deepEqual(github.pages, [1, 2]);
  assert.equal(github.reads[0].length, 100);
  assert.equal(github.reads[1].length, 2);
  assert.equal(github.mutations.length, 101);
  assert.equal(github.states.get('comment-102').isMinimized, false);
});

for (const change of ['delete', 'edit', 'hide']) {
  test(`replacement ${change} during cleanup leaves the fallback visible`, async () => {
    const github = mockGitHub([comment(1), comment(2, NEW_RUN)]);
    github.beforeRead = (ids, count) => {
      if (count !== 2) return;
      if (change === 'delete') github.states.delete('comment-2');
      if (change === 'edit') github.states.get('comment-2').body = 'Changed';
      if (change === 'hide') github.states.get('comment-2').isMinimized = true;
    };
    await execute(github);
    assert.deepEqual(github.mutations, []);
  });
}

test('a candidate edited during cleanup is not hidden', async () => {
  const github = mockGitHub([comment(1), comment(2, NEW_RUN)]);
  github.beforeRead = (ids, count) => {
    if (count === 2) github.states.get('comment-1').body = 'Changed';
  };
  await execute(github);
  assert.deepEqual(github.mutations, []);
});

test('permission failure also fails a dry run and makes no mutations', async () => {
  const github = mockGitHub([comment(1), comment(2, NEW_RUN)]);
  github.states.get('comment-1').viewerCanMinimize = false;
  await assert.rejects(execute(github, true), /pull-requests: write/);
  assert.deepEqual(github.mutations, []);
});

test('rerun completes after a partial API failure without repeating successful writes', async () => {
  const github = mockGitHub([comment(1), comment(2), comment(3, NEW_RUN)]);
  github.failMutation = 'comment-2';
  await assert.rejects(execute(github), /Temporary API failure/);
  assert.deepEqual(github.mutations, ['comment-1']);
  github.failMutation = null;
  await execute(github);
  assert.deepEqual(github.mutations, ['comment-1', 'comment-2']);
});

test('failed pagination or state loading cannot produce a partial selection', async () => {
  const github = mockGitHub([comment(1), comment(2, NEW_RUN)]);
  const paginate = github.paginate;
  github.paginate = async () => { throw new Error('Pagination failed'); };
  await assert.rejects(execute(github), /Pagination failed/);
  assert.deepEqual(github.mutations, []);
  github.paginate = paginate;
  github.graphql = async () => ({ nodes: [] });
  await assert.rejects(execute(github), /Incomplete comment state response/);
  assert.deepEqual(github.mutations, []);
});

test('rejects non-PR targets and invalid manual input before writing', async () => {
  const github = mockGitHub([comment(1), comment(2, NEW_RUN)]);
  for (const prNumber of ['', '0', '-1', '1e3', '7799; echo hi']) {
    await assert.rejects(reconcile({ github, prNumber }), /positive integer/);
  }
  github.rest.pulls.get = async () => { throw new Error('Not a pull request'); };
  await assert.rejects(execute(github), /Not a pull request/);
  assert.deepEqual(github.mutations, []);
});

function workflowContext() {
  return {
    eventName: 'workflow_dispatch', ref: 'refs/heads/main',
    repo: { owner: 'mozilla', repo: 'global-platform-admin' },
    payload: { repository: { default_branch: 'main' } },
  };
}

function mockCore() {
  const core = { failures: [], info() {}, warning() {}, setFailed(message) { this.failures.push(message); } };
  core.summary = { addHeading() { return this; }, addTable() { return this; },
    addRaw() { return this; }, async write() {} };
  return core;
}

test('action defaults to dry run and interprets string false explicitly', async () => {
  const github = mockGitHub([comment(1), comment(2, NEW_RUN)]);
  const core = mockCore();
  for (const inputs of [{ prNumber: '7799' }, { prNumber: '7799', dryRun: 'true' }]) {
    await run({ github, context: workflowContext(), core, ...inputs });
    assert.deepEqual(github.mutations, []);
  }
  await run({ github, context: workflowContext(), core, prNumber: '7799', dryRun: 'false' });
  assert.deepEqual(github.mutations, ['comment-1']);
  assert.deepEqual(core.failures, []);
});

test('manual workflow refuses non-default branch execution', async () => {
  const context = workflowContext();
  context.ref = 'refs/heads/untrusted';
  await assert.rejects(run({ context, core: mockCore() }), /default branch/);
});

test('comment events verify PR and author; mutations require an explicit input', async () => {
  const github = mockGitHub([comment(1), comment(2, NEW_RUN)]);
  const context = workflowContext();
  context.eventName = 'issue_comment';
  context.payload.issue = { number: 7799 };
  context.payload.comment = comment(2, NEW_RUN);
  const core = mockCore();
  await run({ github, context, core });
  assert.deepEqual(github.mutations, []);
  context.payload.issue.pull_request = {};
  context.payload.comment.user.id = 100;
  await run({ github, context, core });
  assert.deepEqual(github.mutations, []);
  context.payload.comment.user.id = 57898261;
  await run({ github, context, core });
  assert.deepEqual(github.mutations, []);
  await run({ github, context, core, dryRun: 'false' });
  assert.deepEqual(github.mutations, ['comment-1']);
});

test('action uses the caller repository, PR input, and default branch', async () => {
  const github = mockGitHub([comment(1), comment(2, NEW_RUN)]);
  const context = workflowContext();
  context.repo = { owner: 'mozilla', repo: 'sandbox-infra' };
  context.ref = 'refs/heads/master';
  context.payload.repository.default_branch = 'master';
  // These workflow inputs deliberately differ from the composite action's
  // inputs. The action must use its supplied inputs, not inspect their names.
  context.payload.inputs = { pr_number: '9999', dry_run: 'true' };
  const targets = [];
  github.rest.pulls.get = async parameters => {
    targets.push(parameters);
    return { data: { number: parameters.pull_number } };
  };
  const listComments = github.rest.issues.listComments;
  github.rest.issues.listComments = async parameters => {
    assert.equal(parameters.owner, 'mozilla');
    assert.equal(parameters.repo, 'sandbox-infra');
    assert.equal(parameters.issue_number, 123);
    return listComments(parameters);
  };
  const core = mockCore();
  await run({ github, context, core, prNumber: '123', dryRun: 'false' });
  assert.deepEqual(targets, [{ owner: 'mozilla', repo: 'sandbox-infra', pull_number: 123 }]);
  assert.deepEqual(github.mutations, ['comment-1']);
  assert.deepEqual(core.failures, []);
});

test('invalid dry-run values cannot enable mutations', async () => {
  const github = mockGitHub([comment(1), comment(2, NEW_RUN)]);
  for (const dryRun of ['', 'False', '0', 0, null]) {
    await assert.rejects(run({ github, context: workflowContext(), core: mockCore(),
      prNumber: '7799', dryRun }), /dry-run must be true or false/);
  }
  assert.deepEqual(github.mutations, []);
});

test('manual runs require a PR input and propagate API errors to the job', async () => {
  const github = mockGitHub([comment(1), comment(2, NEW_RUN)]);
  const core = mockCore();
  await run({ github, context: workflowContext(), core, dryRun: 'false' });
  assert.match(core.failures[0], /positive integer/);
  github.failMutation = 'comment-1';
  await run({ github, context: workflowContext(), core, prNumber: '7799', dryRun: 'false' });
  assert.equal(core.failures[1], 'Temporary API failure');
  assert.deepEqual(github.mutations, []);
});

test('composite entrypoint loads its bundled helper outside the caller checkout', async () => {
  const action = readFileSync(path.join(__dirname, 'action.yml'), 'utf8');
  const script = action.split('        script: |\n')[1]
    .split('\n').map(line => line.slice(10)).join('\n');
  const directory = mkdtempSync(path.join(tmpdir(), 'spacelift-action-test-'));
  const cwd = process.cwd();
  const variables = {
    SPACELIFT_ACTION_PATH: __dirname,
    SPACELIFT_PR_NUMBER: '7799',
    SPACELIFT_DRY_RUN: 'false',
  };
  const previous = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]]));
  try {
    // A relative require from the caller repository would execute this file.
    writeFileSync(path.join(directory, 'index.cjs'), 'throw new Error("Loaded caller code");');
    process.chdir(directory);
    Object.assign(process.env, variables);
    const github = mockGitHub([comment(1), comment(2, NEW_RUN)]);
    const core = mockCore();
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const invoke = new AsyncFunction('require', 'github', 'context', 'core', script);
    await invoke(createRequire(path.join(directory, 'github-script.cjs')),
      github, workflowContext(), core);
    assert.deepEqual(github.mutations, ['comment-1']);
    assert.deepEqual(core.failures, []);
  } finally {
    process.chdir(cwd);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
