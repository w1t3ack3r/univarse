// Spec 0013 CS12 (re-scoped by ADR-030): the workflow-policy check. CI stays read-only and untrusted PR code
// never runs with privileges. A pure check over parsed workflow definitions, so the rules are proved against
// fixtures (tools/ci-policy/fixtures/, never under .github/workflows/, so GitHub never runs them) and the real
// workflow files are the positive control. CLI: `node tools/ci-policy/workflow-policy.mjs [dir]` (default
// .github/workflows); exits 1 on any problem.
//
// The rules fail closed: a trigger, permission or action reference the policy doesn't recognise is refused,
// never assumed harmless. Policy verification only; no live fork test (spec 0013 Design notes).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

/**
 * Triggers a workflow may use. `pull_request` runs from forks get a read-only token and no secrets. Anything
 * else is refused, and the privileged ones (which run with the base repository's token and secrets) are
 * named, because they must never touch PR code.
 */
export const ALLOWED_TRIGGERS = ['pull_request', 'push', 'workflow_dispatch', 'schedule'];
export const PRIVILEGED_TRIGGERS = [
  'pull_request_target',
  'workflow_run',
  'issue_comment',
  'pull_request_review_comment',
];
/** Scopes whose write access would let a run publish, sign or attest (spec 0013 CS12). */
export const PUBLISH_SCOPES = ['packages', 'id-token', 'attestations'];

/** References to the PR's own head, i.e. checking out or running PR-supplied code. */
const PR_HEAD =
  /github\.event\.pull_request\.head\.|github\.head_ref|refs\/pull\/|github\.event\.workflow_run\.head_|github\.event\.issue\.pull_request/;
/** Commands that publish, sign or attest: none may run where PR code runs. */
const PUBLISH_COMMANDS = [
  [/\bdocker\s+login\b/, 'docker login'],
  [/\bdocker\s+(image\s+)?push\b/, 'docker push'],
  [/\bbuildx\s+build\b[^\n]*--push\b/, 'docker buildx build --push'],
  [/\bcosign\s+(sign|attest|copy)\b/, 'cosign sign/attest/copy'],
  [/\b(crane|oras|skopeo)\s+(push|copy)\b/, 'registry push'],
];
const FULL_SHA = /^[^@\s]+@[0-9a-f]{40}$/;

/** The workflow's triggers as a list of names, whichever of YAML's three forms `on` uses. */
export function triggersOf(wf) {
  const on = wf?.on;
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(String);
  if (on && typeof on === 'object') return Object.keys(on);
  return [];
}

/** Every problem with one workflow; [] when it complies. `name` labels the messages. */
export function workflowProblems(wf, name = 'workflow') {
  const problems = [];
  const say = (msg) => problems.push(`${name}: ${msg}`);
  if (!wf || typeof wf !== 'object') return [`${name}: not a workflow definition`];

  const triggers = triggersOf(wf);
  if (triggers.length === 0) say('declares no triggers');
  for (const t of triggers) {
    if (PRIVILEGED_TRIGGERS.includes(t))
      say(`uses the privileged trigger ${t} (runs with the base repository's token and secrets)`);
    else if (!ALLOWED_TRIGGERS.includes(t))
      say(`trigger ${t} is not on the allowlist (${ALLOWED_TRIGGERS.join(', ')})`);
  }
  const prReachable =
    triggers.includes('pull_request') || triggers.some((t) => PRIVILEGED_TRIGGERS.includes(t));
  const privileged = triggers.filter((t) => PRIVILEGED_TRIGGERS.includes(t));

  if (wf.permissions === undefined)
    say('declares no workflow-level permissions (the token default may be write)');
  else say1(permissionProblems(wf.permissions, 'workflow permissions'));

  const jobs = wf.jobs && typeof wf.jobs === 'object' ? wf.jobs : {};
  if (Object.keys(jobs).length === 0) say('declares no jobs');
  for (const [id, job] of Object.entries(jobs)) {
    const where = `job ${id}`;
    if (job?.uses)
      say(
        `${where} calls the reusable workflow ${job.uses}; its permissions can't be checked here`,
      );
    if (job?.permissions !== undefined)
      say1(permissionProblems(job.permissions, `${where} permissions`));
    if (job?.secrets === 'inherit') say(`${where} passes every secret (secrets: inherit)`);
    const text = JSON.stringify(job ?? {});
    // GITHUB_TOKEN is the run's own, permission-bounded token; any other secret is a credential.
    for (const m of text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) {
      if (m[1] !== 'GITHUB_TOKEN' && prReachable)
        say(`${where} references the credential secrets.${m[1]} in a PR-reachable workflow`);
    }
    for (const [i, step] of (Array.isArray(job?.steps) ? job.steps : []).entries()) {
      const label = `${where} step ${step?.name ? `"${step.name}"` : i + 1}`;
      if (typeof step?.uses === 'string') {
        const uses = step.uses;
        if (
          !uses.startsWith('./') &&
          !(uses.startsWith('docker://') ? /@sha256:[0-9a-f]{64}$/.test(uses) : FULL_SHA.test(uses))
        ) {
          say(`${label} uses ${uses}, not pinned to a full commit SHA (or image digest)`);
        }
        if (/^actions\/checkout@/.test(uses)) {
          if (step.with?.['persist-credentials'] !== false)
            say(
              `${label} checks out without persist-credentials: false (the token stays on disk for later steps)`,
            );
          if (privileged.length && PR_HEAD.test(JSON.stringify(step.with ?? {}))) {
            say(
              `${label} checks out the PR's head under ${privileged.join(', ')} (untrusted code with privileges)`,
            );
          }
        }
        if (privileged.includes('workflow_run') && /^actions\/download-artifact@/.test(uses)) {
          say(
            `${label} downloads another run's artifacts under workflow_run (PR-supplied content with privileges)`,
          );
        }
      }
      if (typeof step?.run === 'string') {
        const shell = effectiveShell(wf, job, step);
        if (shell !== 'bash') {
          say(
            `${label} runs under ${shell === undefined ? "GitHub's default shell (bash -e, no pipefail)" : `shell ${JSON.stringify(shell)}`}: a failure before a pipe is masked; set defaults.run.shell: bash`,
          );
        }
        if (prReachable) {
          for (const [re, what] of PUBLISH_COMMANDS)
            if (re.test(step.run)) say(`${label} runs ${what} in a PR-reachable workflow`);
        }
        if (privileged.length && PR_HEAD.test(step.run))
          say(`${label} runs PR-supplied code under ${privileged.join(', ')}`);
      }
    }
  }
  return problems;

  function say1(list) {
    for (const p of list) say(p);
  }
}

/**
 * The shell a `run` step gets: the step's own `shell`, else the job's, else the workflow's `defaults.run.shell`.
 * Undefined means GitHub's default, which on Linux is `bash -e {0}`: no pipefail.
 */
export function effectiveShell(wf, job, step) {
  return step?.shell ?? job?.defaults?.run?.shell ?? wf?.defaults?.run?.shell;
}

/**
 * The command line GitHub runs a step's script with, for a shell setting (GitHub docs, workflow syntax:
 * `jobs.<job_id>.steps[*].shell`). Only an explicit `bash` gets `-o pipefail`.
 */
export function shellCommand(shell) {
  if (shell === undefined) return ['bash', '-e'];
  if (shell === 'bash') return ['bash', '--noprofile', '--norc', '-eo', 'pipefail'];
  if (shell === 'sh') return ['sh', '-e'];
  throw new Error(`no GitHub template for shell ${JSON.stringify(shell)}`);
}

/** Problems with one `permissions` value: only explicit read access is allowed, never write. */
export function permissionProblems(perms, where) {
  if (perms === 'read-all' || perms === 'write-all')
    return [`${where} are ${perms}; list the scopes explicitly`];
  if (perms === null || typeof perms !== 'object' || Array.isArray(perms))
    return [`${where} are not a scope map`];
  const out = [];
  for (const [scope, level] of Object.entries(perms)) {
    if (level === 'write') {
      out.push(
        PUBLISH_SCOPES.includes(scope)
          ? `${where} request ${scope}: write (publish/sign/attest)`
          : `${where} request ${scope}: write (CI is read-only)`,
      );
    } else if (level !== 'read' && level !== 'none')
      out.push(`${where} give ${scope} the unknown level ${JSON.stringify(level)}`);
  }
  return out;
}

/** Parse one workflow file's text; a parse failure is itself a problem. */
export function fileProblems(text, name) {
  let wf;
  try {
    wf = yaml.load(text);
  } catch (e) {
    return [`${name}: does not parse (${e.reason ?? e.message})`];
  }
  return workflowProblems(wf, name);
}

/** Check every .yml/.yaml file in a directory. */
export function dirProblems(dir) {
  const files = readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();
  if (files.length === 0) return [`${dir}: no workflow files`];
  return files.flatMap((f) => fileProblems(readFileSync(join(dir, f), 'utf8'), f));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dir = process.argv[2] ?? '.github/workflows';
  const problems = dirProblems(dir);
  if (problems.length) {
    console.error(
      `Workflow policy (spec 0013 CS12): ${problems.length} problem(s)\n${problems.map((p) => `- ${p}`).join('\n')}`,
    );
    process.exit(1);
  }
  console.log(
    `Workflow policy (spec 0013 CS12): ${dir} complies — read-only permissions, only ${ALLOWED_TRIGGERS.join('/')} triggers, no credentials or publishing where PR code runs. Publishing and signing were not attempted.`,
  );
}
