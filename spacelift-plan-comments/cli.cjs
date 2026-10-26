#!/usr/bin/env node
'use strict';

const { execFile } = require('node:child_process');
const { promisify, parseArgs } = require('node:util');
const { parsePlan, reconcile } = require('./index.cjs');
const execute = promisify(execFile);

const USAGE = `Usage: node spacelift-plan-comments/cli.cjs <GitHub PR URL> [--apply]

Uses your existing gh login. Defaults to a read-only preview.
Recognizes both metadata and the existing Mozilla Spacelift plan headers.
Pass --apply to hide superseded comments with GitHub's OUTDATED reason.`;

// Compatibility with comments posted before the metadata policy is deployed
// belongs only to this manual runner. The Action still requires metadata.
function parseManualPlan(comment) {
  if ((comment.body || '').includes('<!-- spacelift-plan:')) return parsePlan(comment);
  if (comment.user?.id !== 57898261 || comment.user?.type !== 'Bot' ||
      comment.performed_via_github_app?.id !== 47046) return null;
  const header = (comment.body || '').split(/\r?\n/, 1)[0];
  const match = /^Run for Spacelift-only stack `[^`]+` has (FINISHED|FAILED) : \[view run\]\(https:\/\/mozilla\.app\.spacelift\.io\/stack\/([^\s?#)]+)\/run\/([0-7][0-9A-HJKMNP-TV-Z]{25})\)$/.exec(header);
  if (!match) return null;
  try {
    const stackId = decodeURIComponent(match[2]);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(stackId)) return null;
    return { comment, stackId, runId: match[3], state: match[1] };
  } catch {
    return null;
  }
}

async function ghApi(args) {
  const { stdout } = await execute('gh', ['api', '--hostname', 'github.com', ...args], {
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: '1' },
  });
  const result = JSON.parse(stdout);
  if (result.errors?.length) throw new Error(result.errors.map(error => error.message).join('; '));
  return result;
}

function githubViaGh(apply, api = ghApi) {
  return {
    rest: {
      pulls: { get: async ({ owner, repo, pull_number }) => ({
        data: await api([`repos/${owner}/${repo}/pulls/${pull_number}`]),
      }) },
      issues: { listComments: async ({ owner, repo, issue_number, per_page }) =>
        (await api([`repos/${owner}/${repo}/issues/${issue_number}/comments?per_page=${per_page}`,
          '--paginate', '--slurp'])).flat() },
    },
    paginate: (route, parameters) => route(parameters),
    async graphql(query, variables) {
      if (!apply && /^\s*mutation\b/.test(query)) throw new Error('Mutations require --apply.');
      const fields = Object.entries(variables).flatMap(([key, value]) =>
        (Array.isArray(value) ? value : [value]).flatMap(item =>
          ['--raw-field', `${key}${Array.isArray(value) ? '[]' : ''}=${item}`]));
      const { data } = await api(['graphql', '--raw-field', `query=${query}`, ...fields]);
      return data;
    },
  };
}

function parseOptions(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true,
    options: { apply: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) return { help: true };
  if (positionals.length !== 1) throw new Error(USAGE);
  const url = new URL(positionals[0]);
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?$/.exec(url.pathname);
  if (url.origin !== 'https://github.com' || url.username || url.password || !match) {
    throw new Error('Expected a GitHub PR URL such as https://github.com/mozilla/global-platform-admin/pull/7867');
  }
  return { owner: match[1], repo: match[2], prNumber: match[3], apply: values.apply };
}

async function main(args, api = ghApi, log = console.log) {
  const options = parseOptions(args);
  if (options.help) return log(USAGE);
  const { owner, repo, prNumber, apply } = options;
  log(`${apply ? 'Applying cleanup' : 'Dry run'}: ${owner}/${repo}#${prNumber}`);
  const counts = {};
  await reconcile({
    github: githubViaGh(apply, api), owner, repo, prNumber, dryRun: !apply,
    parseComment: parseManualPlan,
    report({ action, stack, url, reason }) {
      counts[action] = (counts[action] || 0) + 1;
      log(`${action}: ${JSON.stringify(stack)} ${url} — ${reason}`);
    },
  });
  log(Object.keys(counts).length
    ? Object.entries(counts).map(([action, count]) => `${action}: ${count}`).join(', ')
    : 'No matching Spacelift plan comments found.');
  if (!apply) log('No comments changed. Rerun with --apply to hide the superseded comments.');
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.stderr?.trim() || error.message);
    process.exitCode = 1;
  });
}

module.exports = { parseManualPlan, githubViaGh, parseOptions, main };
