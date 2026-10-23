// Shared test tooling for the API's static guards (spec 0019's writer bound, CI9, spec 0018's policy guard): a
// type-checked program over apps/api, and its production sources. Moved here from spec 0015's CI10 guard when CI10
// was retired (spec 0022, after spec 0016's database capture replaced it). Test tooling: excluded from the build.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as TS from 'typescript';

const require = createRequire(import.meta.url);
const ts = require('typescript') as typeof TS;

export const API_DIR = fileURLToPath(new URL('../../', import.meta.url));
export const SRC = join(API_DIR, 'src');

/** A program over the API's sources (plus optional virtual files), with types. */
export function apiProgram(virtual: Readonly<Record<string, string>> = {}): TS.Program {
  const cfg = ts.getParsedCommandLineOfConfigFile(
    join(API_DIR, 'tsconfig.json'),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      },
    },
  );
  if (!cfg) throw new Error('could not read apps/api/tsconfig.json');
  const host = ts.createCompilerHost(cfg.options);
  const norm = (f: string) => ts.sys.resolvePath(f).replace(/\\/g, '/');
  const virt = new Map(Object.entries(virtual).map(([p, t]) => [norm(p), t]));
  const getSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (f) => virt.has(norm(f)) || ts.sys.fileExists(f);
  host.readFile = (f) => virt.get(norm(f)) ?? ts.sys.readFile(f);
  host.getSourceFile = (f, lang, onError, create) => {
    const v = virt.get(norm(f));
    return v !== undefined
      ? ts.createSourceFile(f, v, lang, true)
      : getSourceFile(f, lang, onError, create);
  };
  return ts.createProgram([...cfg.fileNames, ...virt.keys()], cfg.options, host);
}

/**
 * Production sources under apps/api/src: not tests, not test tooling, and not any guard's virtual fixtures (each
 * guard compiles its fixtures under a `__<name>_fixtures__` directory).
 */
export function productionFiles(program: TS.Program): TS.SourceFile[] {
  const src = SRC.replace(/\\/g, '/');
  return program.getSourceFiles().filter((sf) => {
    const f = sf.fileName.replace(/\\/g, '/');
    return (
      f.startsWith(`${src}/`) &&
      !/\.(int\.)?spec\.ts$/.test(f) &&
      !f.includes('/testing/') &&
      !/\/__[a-z_]+_fixtures__\//.test(f) &&
      !f.endsWith('.d.ts')
    );
  });
}
