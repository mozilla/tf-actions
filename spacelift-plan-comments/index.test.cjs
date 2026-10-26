'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require('node:fs');
const { createRequire } = require('node:module');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { parsePlan, selectPlans, reconcile, run } = require('./index.cjs');
const { parseManualPlan, githubViaGh, parseOptions, main } = require('./cli.cjs');

const OLD_RUN = '01M5DRTNYWWAMP9VKHR5GR6SSW';
const NEW_RUN = '01M5DZCFDN5VJ0PXQVY4JPMAMH';

function legacyComment(id, runId = OLD_RUN, stack = 'root') {
  return { ...comment(id, runId, stack),
    body: `Run for Spacelift-only stack \`display name\` has FINISHED : [view run](https://mozilla.app.spacelift.io/stack/${stack}/run/${runId})\n\nPlan summary` };
}

test('manual runner supports legacy and metadata comments without changing the Action default', () => {
  const legacy = legacyComment(1, OLD_RUN, 'admin-aws-sso%2Fcloudservices');
  assert.equal(parseManualPlan(legacy).stackId, 'admin-aws-sso/cloudservices');
  assert.equal(parseManualPlan(comment(2, NEW_RUN)).runId, NEW_RUN);
  assert.deepEqual(selectPlans([legacy]), []);
  assert.equal(selectPlans([legacy], parseManualPlan)[0].keeper.comment.id, 1);
  for (const invalid of [
    { ...legacy, user: { id: 123, type: 'Bot' } },
    { ...legacy, performed_via_github_app: { id: 123 } },
    { ...legacy, body: legacy.body.replace('mozilla.app.spacelift.io', 'mozilla.app.spacelift.io.evil.test') },
    { ...legacy, body: legacy.body.replace(OLD_RUN, 'not-a-run') },
    { ...legacy, body: legacy.body.replace('admin-aws-sso%2Fcloudservices', '%ZZ') },
    { ...legacy, body: legacy.body.replace('FINISHED', 'PLANNING') },
    { ...legacy, body: `${legacy.body}\n\n<!-- spacelift-plan: {"version":2} -->` },
  ]) assert.equal(parseManualPlan(invalid), null);
});

test('CLI requires an explicit apply flag and validates the target before calling gh', async () => {
  const url = 'https://github.com/mozilla/global-platform-admin/pull/7867';
  assert.equal(parseOptions([url]).apply, false);
  assert.equal(parseOptions([url, '--apply']).apply, true);
  for (const args of [[], [url, 'extra'], [url, '--aply'], [url.replace('/pull/', '/issues/')],
    [url.replace('github.com', 'example.com')], [url.replace('github.com', 'user@github.com')]]) {
    await assert.rejects(main(args, () => assert.fail('Invalid input reached gh'), () => {}));
  }
  await assert.rejects(githubViaGh(false, () => assert.fail('Mutation reached gh'))
    .graphql('mutation Hide($id: ID!) {}', { id: 'comment-1' }), /require --apply/);
});

test('CLI previews paginated comments, applies only with the flag, and is idempotent', async () => {
  const comments = [legacyComment(1), comment(2), legacyComment(3, NEW_RUN)];
  const github = mockGitHub(comments);
  const requests = [];
  const api = async args => {
    requests.push(args);
    if (args[0] === 'graphql') {
      const fields = {};
      for (let index = 2; index < args.length; index += 2) {
        const separator = args[index].indexOf('=');
        const key = args[index].slice(0, separator);
        const value = args[index].slice(separator + 1);
        if (key.endsWith('[]')) (fields[key.slice(0, -2)] ||= []).push(value);
        else fields[key] = value;
      }
      const { query, ...variables } = fields;
      return { data: await github.graphql(query, variables) };
    }
    if (args[0].includes('/comments?')) {
      assert.ok(args.includes('--paginate'));
      assert.ok(args.includes('--slurp'));
      return [comments.slice(0, 1), comments.slice(1)];
    }
    assert.equal(args[0], 'repos/mozilla/global-platform-admin/pulls/7867');
    return { number: 7867 };
  };
  const url = 'https://github.com/mozilla/global-platform-admin/pull/7867';
  const logs = [];
  await main([url], api, line => logs.push(line));
  assert.deepEqual(github.mutations, []);
  assert.equal(logs.filter(line => line.startsWith('would hide: "root"')).length, 2);
  await main([url, '--apply'], api, () => {});
  assert.deepEqual(github.mutations, ['comment-1', 'comment-2']);
  await main([url, '--apply'], api, () => {});
  assert.deepEqual(github.mutations, ['comment-1', 'comment-2']);
  assert.equal(requests.filter(args => args[0].endsWith('/pulls/7867')).length, 3);
});

function comment(id, runId = OLD_RUN, stack = 'root', state = 'FINISHED') {
  const metadata = {
    version: 1, account: 'mozilla', stack_id: stack, run_id: runId,
    type: 'PROPOSED', state, commit_sha: '0123456789abcdef0123456789abcdef01234567',
  };
  return {
    id, node_id: `comment-${id}`,
    user: { id: 57898261, login: 'spacelift-io[bot]', type: 'Bot' },
    performed_via_github_app: { id: 47046 },
    created_at: '2026-10-20T23:04:55Z',
    html_url: `https://github.com/mozilla/global-platform-admin/pull/7799#issuecomment-${id}`,
    body: `Plan summary\n\n<!-- spacelift-plan: ${JSON.stringify(metadata)} -->`,
  };
}

// Replay the run order from PR 7799 using the new metadata contract. The actual
// historical comments predate metadata and are no longer selected by this action.
function planHistory() {
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
    id: c.node_id, isMinimized: false, viewerCanMinimize: true,
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

test('metadata-tagged history hides five remaining old comments and is idempotent', async () => {
  const github = mockGitHub(planHistory());
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
  const github = mockGitHub(planHistory());
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

test('groups by metadata stack ID even when visible summaries are identical', async () => {
  const github = mockGitHub([
    comment(1), comment(2, NEW_RUN),
    comment(3, OLD_RUN, 'admin-aws-sso/cloudservices'),
    comment(4, NEW_RUN, 'admin-aws-sso/cloudservices'),
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

test('rejects other authors and apps even with valid metadata', () => {
  const original = comment(1);
  const invalid = [
    { ...original, user: { ...original.user, id: 123 } },
    { ...original, user: { ...original.user, type: 'User' } },
    { ...original, performed_via_github_app: { id: 123 } },
    { ...original, performed_via_github_app: null },
  ];
  for (const c of invalid) assert.equal(parsePlan(c), null);
  assert.equal(parsePlan(original).stackId, 'root');
});

test('metadata is independent of visible text and supports policy JSON escapes', () => {
  // Same encoding as the Rego policy, including escaped paired hyphens.
  const body = `Completely different wording, without a run link.\r\n\r\n<!-- spacelift-plan: {"account":"mozilla","commit_sha":"0123456789abcdef0123456789abcdef01234567","run_id":"${OLD_RUN}","stack_id":"example\\u002d\\u002dstack/child","state":"FINISHED","type":"PROPOSED","version":1} -->\r\n`;
  const parsed = parsePlan({ ...comment(1), body });
  assert.equal(parsed.stackId, 'example--stack/child');
  assert.equal(parsed.runId, OLD_RUN);
  assert.equal(parsed.state, 'FINISHED');
});

test('ignores missing, malformed, unsupported, or ineligible metadata', () => {
  const original = comment(1);
  const valid = JSON.parse(original.body.match(/<!-- spacelift-plan: (.+) -->/)[1]);
  const invalid = [
    null, [], 'text', {},
    ...[
      { version: 2 }, { version: '1' }, { account: 'another-account' },
      { type: 'TRACKED' }, { state: 'PLANNING' },
      { stack_id: '' }, { stack_id: 123 }, { stack_id: null },
      { run_id: 'not-a-run' }, { run_id: '81M5DRTNYWWAMP9VKHR5GR6SSW' },
      { run_id: [OLD_RUN] }, { run_id: null },
    ].map(patch => ({ ...valid, ...patch })),
  ];
  for (const metadata of invalid) {
    assert.equal(parsePlan({ ...original, body: `<!-- spacelift-plan: ${JSON.stringify(metadata)} -->` }), null);
  }
  for (const body of [
    null, '', '<!-- spacelift-plan: broken JSON -->',
    original.body + '\nText after the marker',
    original.body.replace('<!-- spacelift-plan:', '> <!-- spacelift-plan:'),
    ':heavy_check_mark: **Deploy succeeded** for stack `root`',
  ]) assert.equal(parsePlan({ ...original, body }), null);
});

test('historical comments without metadata remain untouched', async () => {
  const legacy = comment(1);
  legacy.body = `Run for Spacelift-only stack \`root\` has FINISHED : [view run](https://mozilla.app.spacelift.io/stack/root/run/${OLD_RUN})`;
  const github = mockGitHub([legacy, comment(2), comment(3, NEW_RUN)]);
  await execute(github);
  assert.deepEqual(github.mutations, ['comment-2']);
  assert.equal(github.states.get(legacy.node_id).isMinimized, false);
});

test('does not hide anything when the newest result is already minimized', async () => {
  const github = mockGitHub([comment(1), comment(2, NEW_RUN)]);
  github.states.get('comment-2').isMinimized = true;
  const rows = await execute(github);
  assert.deepEqual(github.mutations, []);
  assert.ok(rows.some(row => row.action === 'skip' && row.reason.includes('leaving this stack')));
});

test('finishes pagination and reads states in batches of 100 before hiding', async () => {
  const comments = Array.from({ length: 101 }, (_, i) => comment(i + 1));
  comments.push(comment(102, NEW_RUN));
  const github = mockGitHub(comments);
  github.beforeRead = () => {
    assert.deepEqual(github.pages, [1, 2]);
    assert.deepEqual(github.mutations, []);
  };
  await execute(github);
  assert.deepEqual(github.reads.map(ids => ids.length), [100, 2]);
  assert.equal(github.mutations.length, 101);
  assert.equal(github.states.get('comment-102').isMinimized, false);
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

test('failed pagination or an empty state read cannot hide anything', async () => {
  const comments = Array.from({ length: 100 }, (_, i) => comment(i + 1));
  comments.push(comment(101, NEW_RUN));
  const github = mockGitHub(comments);
  const listComments = github.rest.issues.listComments;
  github.rest.issues.listComments = async parameters => {
    if (parameters.page === 2) throw new Error('Pagination failed');
    return listComments(parameters);
  };
  await assert.rejects(execute(github), /Pagination failed/);
  assert.deepEqual(github.mutations, []);
  assert.deepEqual(github.reads, []);
  github.rest.issues.listComments = listComments;
  github.graphql = async () => ({ nodes: [] });
  await execute(github);
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
  return { logs: [], info(message) { this.logs.push(message); } };
}

test('step logs show dry-run decisions and actual results with comment links', async () => {
  const older = comment(1);
  const keeper = comment(2, NEW_RUN);
  const github = mockGitHub([older, keeper]);
  const core = mockCore();
  const invoke = dryRun => run({ github, context: workflowContext(), core, prNumber: '7799', dryRun });
  await invoke('true');
  assert.deepEqual(core.logs, [
    `keep: "root" ${keeper.html_url} — Newest completed proposed run for this stack.`,
    `would hide: "root" ${older.html_url} — Superseded by comment 2.`,
  ]);
  assert.deepEqual(github.mutations, []);
  core.logs.length = 0;
  await invoke('false');
  assert.ok(core.logs.includes(`hide: "root" ${older.html_url} — Superseded by comment 2.`));
  core.logs.length = 0;
  await invoke('false');
  assert.ok(core.logs.includes(`skip: "root" ${older.html_url} — Already hidden or deleted.`));
  assert.deepEqual(github.mutations, ['comment-1']);
});

test('action defaults to dry run and interprets string false explicitly', async () => {
  const github = mockGitHub([comment(1), comment(2, NEW_RUN)]);
  const core = mockCore();
  for (const inputs of [{ prNumber: '7799' }, { prNumber: '7799', dryRun: 'true' }]) {
    await run({ github, context: workflowContext(), core, ...inputs });
    assert.deepEqual(github.mutations, []);
  }
  await run({ github, context: workflowContext(), core, prNumber: '7799', dryRun: 'false' });
  assert.deepEqual(github.mutations, ['comment-1']);
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
  await assert.rejects(run({ github, context: workflowContext(), core, dryRun: 'false' }),
    /positive integer/);
  github.failMutation = 'comment-1';
  await assert.rejects(run({ github, context: workflowContext(), core, prNumber: '7799', dryRun: 'false' }),
    /Temporary API failure/);
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
  } finally {
    process.chdir(cwd);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
