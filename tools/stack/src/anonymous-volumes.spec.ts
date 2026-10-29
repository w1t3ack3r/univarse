import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO } from './config.js';
import { downSteps } from './docker.js';

// A container removed without `-v` leaves the anonymous volumes Docker made for its image's VOLUME paths: 62 MB of
// PostgreSQL per release from the migrate smoke, an empty one per restore (2026-10-28). `down -v` is the opposite
// danger: on the stack's file it removes the stack's data.
const RM_WITHOUT_V = /\[\s*'rm',\s*'-f',(?!\s*'-v')/;
const DOWN_WITH_VOLUMES = /'down'[^\]\n]*'(?:-v|--volumes)'|\bdown\s+(?:[^\s"'`]+\s+)*?(?:-v|--volumes)\b/;

function problems(files: readonly { path: string; text: string }[]): string[] {
  const out: string[] = [];
  for (const f of files)
    f.text.split('\n').forEach((line, i) => {
      if (RM_WITHOUT_V.test(line)) out.push(`${f.path}:${String(i + 1)}: a container removed without -v`);
      if (DOWN_WITH_VOLUMES.test(line)) out.push(`${f.path}:${String(i + 1)}: down with its volumes`);
    });
  return out;
}

function sources(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.(?:ts|mjs|json)$/.test(e.name) && !p.endsWith('anonymous-volumes.spec.ts')) out.push({ path: relative(REPO, p), text: readFileSync(p, 'utf8') });
  }
  return out;
}

describe('anonymous volumes', () => {
  it('the checks find what they look for (negative controls)', () => {
    expect(problems([{ path: 'a.ts', text: "docker(['rm', '-f', name]);" }])).toHaveLength(1);
    expect(problems([{ path: 'a.mjs', text: "sh('docker', ['rm', '-f', ...ids]);" }])).toHaveLength(1);
    expect(problems([{ path: 'a.ts', text: "compose(['down', '--remove-orphans', '-v'], env());" }])).toHaveLength(1);
    expect(problems([{ path: 'a.ts', text: "spawnSync('docker', ['compose', 'down', '--volumes']);" }])).toHaveLength(1);
    expect(problems([{ path: 'package.json', text: '"x": "docker compose -f f.yml down -v",' }])).toHaveLength(1);
    expect(problems([{ path: 'package.json', text: '"x": "docker compose -f f.yml down --remove-orphans --volumes",' }])).toHaveLength(1);
    // What is allowed: `-v` on a removal, `down` alone, and removing images or named volumes.
    expect(problems([{ path: 'a.ts', text: "docker(['rm', '-f', '-v', name]); compose(['down', '--remove-orphans']); docker(['volume', 'rm', '-f', v]); docker(['image', 'rm', '-f', t]);" }])).toEqual([]);
  });

  it('no tool removes a container without -v, and none takes a project down with its volumes', () => {
    const files = [...sources(join(REPO, 'tools')), { path: 'package.json', text: readFileSync(join(REPO, 'package.json'), 'utf8') }];
    expect(files.length).toBeGreaterThan(50);
    expect(problems(files)).toEqual([]);
  });

  it('a teardown removes the containers with their anonymous volumes, then goes down, keeping named volumes', () => {
    expect(downSteps(['--remove-orphans'])).toEqual([['rm', '-s', '-f', '-v'], ['down', '--remove-orphans']]);
    expect(downSteps()).toEqual([['rm', '-s', '-f', '-v'], ['down']]);
  });

  it('stack:down and the restore\'s teardown both take their projects down that way', () => {
    expect(readFileSync(join(REPO, 'tools', 'stack', 'src', 'down.ts'), 'utf8')).toMatch(/for \(const step of downSteps\(\)\)/);
    expect(readFileSync(join(REPO, 'tools', 'stack', 'src', 'restore', 'real.ts'), 'utf8')).toMatch(/for \(const step of downSteps\(\['--remove-orphans'\]\)\) compose\(step, env\(\)\)/);
  });
});
