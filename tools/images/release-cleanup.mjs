// Spec 0013 LR10: a release cleans up ONLY what it owns.
// • Containers: every container a run starts carries the run's label (container.mjs); cleanup removes exactly the
//   containers with that label. Nothing is removed by name, so a run that fails before starting anything removes
//   nothing at all.
// • Services: a compose service the run had to start is recorded BEFORE `up --wait`, so it is stopped again even
//   when its startup fails part-way. A service that was already running is never recorded, so it is never stopped.
// `sh` is injected so the rules are unit-tested without Docker (release-cleanup.test.mjs).
import { RUN_LABEL } from './release-lib.mjs';

export function newRun(runId) {
  return { runId, started: [] };
}

/** Starts a compose service unless it is already running. Returns true when this run started it. */
export function ensureService(run, name, { sh, compose, profile = [] }) {
  const running = sh('docker', [...compose, ...profile, 'ps', '--status', 'running', '--services'], { allowFail: true })
    .stdout.split(/\r?\n/)
    .map((l) => l.trim())
    .includes(name);
  if (running) return false;
  run.started.push({ name, profile }); // recorded first: a failed `up --wait` still leaves something to stop
  sh('docker', [...compose, ...profile, 'up', '-d', '--wait', name], { stdio: 'inherit' });
  return true;
}

/** Stops a service now if (and only if) this run started it. */
export function stopIfStarted(run, name, { sh, compose }) {
  const i = run.started.findIndex((s) => s.name === name);
  if (i < 0) return;
  const [s] = run.started.splice(i, 1);
  sh('docker', [...compose, ...s.profile, 'stop', name], { allowFail: true });
}

/** Stops the services this run started and removes the containers labelled with this run's ID. Nothing else. */
export function cleanupRun(run, { sh, compose }) {
  for (const s of [...run.started].reverse()) sh('docker', [...compose, ...s.profile, 'stop', s.name], { allowFail: true });
  run.started.length = 0;
  const ids = sh('docker', ['ps', '-aq', '--filter', `label=${RUN_LABEL}=${run.runId}`], { allowFail: true })
    .stdout.split(/\s+/)
    .filter(Boolean);
  if (ids.length > 0) sh('docker', ['rm', '-f', ...ids], { allowFail: true });
}
