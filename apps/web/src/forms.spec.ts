// Every form is method="post". Our forms submit through their onSubmit handlers, but if the page hasn't hydrated (slow
// network, a script that failed to load) the browser submits natively, and a GET form puts its fields, a password
// included, in the URL: the address bar, history, and server logs.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return e.name.endsWith('.tsx') ? [path] : [];
  });
}

/** Each `<form` opening tag's text, up to its first `>` (attributes may span lines). */
function formTags(source: string): string[] {
  return [...source.matchAll(/<form\b[^>]*>/g)].map((m) => m[0]);
}

describe('forms', () => {
  const tags = sources(join(__dirname)).flatMap((file) => formTags(readFileSync(file, 'utf8')).map((tag) => ({ file, tag })));

  it('finds the forms it checks', () => {
    expect(tags.length).toBeGreaterThanOrEqual(9);
  });

  it('are all method="post", so a native submit never puts a field in the URL', () => {
    expect(tags.filter(({ tag }) => !/\bmethod="post"/.test(tag)).map(({ file }) => file)).toEqual([]);
  });
});
