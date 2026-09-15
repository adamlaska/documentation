/**
 * move-doc — move a doc file and rewrite everything that points at it.
 *
 * Usage:
 *   npm run move-doc -- <from> <to> [--dry-run]
 *
 * In one command this:
 *   1. rewrites every internal link in the tree that resolves to <from> so it points at <to>,
 *      preserving each link's written form (absolute URL, relative file path, `@site/…`, anchor);
 *   2. moves the file, recomputing the file's *own* relative links so they stay valid from the
 *      new location;
 *   3. updates the doc id referenced in `sidebars.json`;
 *   4. appends the old→new redirect to the `redirects` array in `vercel.json`.
 *
 * `--dry-run` prints every change without touching the filesystem. After a real run, verify with
 * `npm run build`.
 */

import path from 'node:path';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import matter from 'gray-matter';

import {
  resolveDocUrl,
  resolveDocId,
  applyRewrites,
  isExternalOrFragment,
  type Rewrite,
} from './lib/mdx-link-codemod';
import {
  buildDocsIndex,
  scanLinks,
  splitSuffix,
  detectLinkStyle,
  renderRef,
  isPartial,
  type DocsIndex,
  type LinkRecord,
} from './lib/docs-link-index';

interface Args {
  from: string;
  to: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const dryRun = argv.includes('--dry-run');
  if (positional.length !== 2) {
    console.error('usage: npm run move-doc -- <from> <to> [--dry-run]');
    process.exit(1);
  }
  return { from: positional[0], to: positional[1], dryRun };
}

/** A pending rewrite of a single file's contents. */
interface FileEdit {
  abs: string;
  content: string;
  rewrites: Rewrite[];
}

/** A human-readable description of one link rewrite, for `--dry-run` output. */
interface Change {
  file: string;
  old: string;
  next: string;
}

/** The disposition of one link under a move: rewrite it, flag it, or leave it. */
type RewritePlan =
  | { kind: 'rewrite'; rewrite: Rewrite; change: Change }
  | { kind: 'unrenderable' }
  | { kind: 'skip' };

/**
 * Render one link's rewrite, preserving its written form (`@site/…`, absolute URL, relative
 * file/url, with any `#anchor`/`?query` suffix). Shared by both planners — the only thing that
 * differs between inbound and outbound is which side moved, expressed via `target`/`container`.
 *
 * Returns `unrenderable` when the link has a byte range but its style can't be re-expressed in
 * this context (e.g. a relative URL link inside a partial, which has no base URL) so the caller
 * can surface it for manual review; `skip` when the rendered form is unchanged. Callers must
 * handle a null `record.ref.range` themselves before calling.
 */
function planLinkRewrite(
  record: LinkRecord,
  target: { abs: string; url: string | null },
  container: { abs: string; url: string | null },
  index: DocsIndex,
): RewritePlan {
  const range = record.ref.range;
  if (range === null) return { kind: 'skip' };
  const { pathPart, suffix } = splitSuffix(record.ref.rawUrl);
  const newPath = renderRef(detectLinkStyle(pathPart), target, container, index);
  if (newPath === null) return { kind: 'unrenderable' };
  const next = newPath + suffix;
  if (next === record.ref.rawUrl) return { kind: 'skip' };
  return {
    kind: 'rewrite',
    rewrite: { range, newText: next },
    change: { file: container.abs, old: record.ref.rawUrl, next },
  };
}

/** Build rewrites for links pointing AT the moved file (target moved, container unchanged). */
function planInbound(
  records: LinkRecord[],
  index: DocsIndex,
  fromAbs: string,
  toAbs: string,
  newUrl: string | null,
): { edits: FileEdit[]; unrenderable: LinkRecord[]; changes: Change[] } {
  const byFile = new Map<string, LinkRecord[]>();
  for (const record of records) {
    if (record.toFile !== fromAbs || record.fromFile === fromAbs) continue;
    const bucket = byFile.get(record.fromFile);
    if (bucket) bucket.push(record);
    else byFile.set(record.fromFile, [record]);
  }

  const edits: FileEdit[] = [];
  const unrenderable: LinkRecord[] = [];
  const changes: Change[] = [];
  const target = { abs: toAbs, url: newUrl };
  for (const [abs, recs] of byFile) {
    const file = index.files.find((candidate) => candidate.abs === abs);
    if (!file) continue;
    const container = { abs, url: index.fileToUrl.get(abs) ?? null };
    const rewrites: Rewrite[] = [];
    for (const record of recs) {
      // A range-less ref that resolves to the moved file (e.g. a markdown link whose destination
      // could not be located) is known-broken-by-the-move but not auto-fixable — flag it.
      if (record.ref.range === null) {
        unrenderable.push(record);
        continue;
      }
      const plan = planLinkRewrite(record, target, container, index);
      if (plan.kind === 'unrenderable') unrenderable.push(record);
      else if (plan.kind === 'rewrite') {
        rewrites.push(plan.rewrite);
        changes.push(plan.change);
      }
    }
    if (rewrites.length > 0) edits.push({ abs, content: file.content, rewrites });
  }
  return { edits, unrenderable, changes };
}

/** Rewrite the moved file's own relative links so they remain valid from the new location. */
function planOutbound(
  records: LinkRecord[],
  index: DocsIndex,
  fromAbs: string,
  toAbs: string,
  newUrl: string | null,
): { rewrites: Rewrite[]; changes: Change[] } {
  const rewrites: Rewrite[] = [];
  const changes: Change[] = [];
  const container = { abs: toAbs, url: newUrl };
  for (const record of records) {
    if (record.fromFile !== fromAbs || record.ref.range === null || record.toFile === null)
      continue;
    const style = detectLinkStyle(splitSuffix(record.ref.rawUrl).pathPart);
    // Absolute forms (`/x`, `@site/…`) are location-independent; only relative forms move.
    if (style !== 'fileRel' && style !== 'urlRel') continue;
    // A self-link points back at the moved file, so its target is the NEW location — `index`
    // still maps `fromAbs` to the pre-move URL, so don't look it up there.
    const target =
      record.toFile === fromAbs
        ? { abs: toAbs, url: newUrl }
        : { abs: record.toFile, url: index.fileToUrl.get(record.toFile) ?? null };
    const plan = planLinkRewrite(record, target, container, index);
    if (plan.kind === 'rewrite') {
      rewrites.push(plan.rewrite);
      changes.push(plan.change);
    }
  }
  return { rewrites, changes };
}

/**
 * Rewrite references to the moved doc in `sidebars.json`. A doc-item entry references it by id, while
 * a `link`-type entry references it by URL (`href: '/x'`) — both must be updated or the URL ones
 * 404, and the sidebar renders site-wide so one stale href breaks the build on every page. Each
 * token is matched quote-delimited so a swap can't hit a substring of a longer id or path.
 */
function updateSidebars(
  content: string,
  swaps: ReadonlyArray<readonly [from: string, to: string]>,
): { content: string; count: number } {
  let count = 0;
  let updated = content;
  for (const [from, to] of swaps) {
    if (from === to) continue;
    for (const quote of ["'", '"']) {
      const parts = updated.split(`${quote}${from}${quote}`);
      count += parts.length - 1;
      updated = parts.join(`${quote}${to}${quote}`);
    }
  }
  return { content: updated, count };
}

/** The two site settings that decide what a doc's URL looks like to a visitor. */
interface SiteUrlConfig {
  /** `baseUrl` with any trailing slash removed, e.g. `/docs`. Empty when the site is served at root. */
  baseUrl: string;
  trailingSlash: boolean;
}

/**
 * Read `baseUrl`/`trailingSlash` out of docusaurus.config.js.
 *
 * Doc URLs from `resolveDocUrl` are route paths relative to `routeBasePath` (`/faq`), while a
 * visitor's URL also carries `baseUrl` (`/docs/faq`). Redirects are served by the edge, which only
 * ever sees the visitor's URL, so the two settings must be applied before writing an entry. They're
 * matched textually rather than by requiring the config, which would run the whole Docusaurus
 * plugin chain just to read two literals.
 */
async function readSiteUrlConfig(repoRoot: string): Promise<SiteUrlConfig> {
  const content = await readFile(path.join(repoRoot, 'docusaurus.config.js'), 'utf8');
  const baseUrl = /^\s*baseUrl:\s*['"]([^'"]*)['"]/m.exec(content);
  if (!baseUrl) {
    throw new Error('move-doc: could not find a `baseUrl` literal in docusaurus.config.js');
  }
  return {
    baseUrl: baseUrl[1].replace(/\/+$/, ''),
    trailingSlash: /^\s*trailingSlash:\s*true/m.test(content),
  };
}

/** A vercel.json redirect entry. `permanent: false` matches every existing entry in the file. */
interface VercelRedirect {
  source: string;
  destination: string;
}

/**
 * Build the vercel.json entry for a doc URL move, in the shape the file already uses throughout:
 * the source is a capture group ending in `/?` so it matches with or without a trailing slash,
 * and the destination is the fully-qualified path including `baseUrl`.
 */
function buildVercelRedirect(oldUrl: string, newUrl: string, site: SiteUrlConfig): VercelRedirect {
  // Collapse the doubled slashes that appear when baseUrl is empty or the doc URL is bare `/`.
  const qualify = (url: string) => `/${site.baseUrl}/${url}`.replace(/\/{2,}/g, '/').replace(/\/$/, '');
  const destination = qualify(newUrl);
  return {
    source: `/(${qualify(oldUrl).slice(1)}/?)`,
    destination: site.trailingSlash ? `${destination}/` : destination,
  };
}

/** Byte offsets of the `[` and `]` bounding the top-level `redirects` array. */
function findRedirectsArray(content: string): { open: number; close: number } {
  const key = /"redirects"\s*:\s*\[/.exec(content);
  if (!key) throw new Error('move-doc: vercel.json has no "redirects" array');
  const open = key.index + key[0].length - 1;

  // Scan for the matching bracket rather than regex-matching the end, so a `]` inside a source
  // pattern string can't be mistaken for the end of the array.
  let depth = 0;
  let inString = false;
  for (let i = open; i < content.length; i++) {
    const char = content[i];
    if (inString) {
      if (char === '\\') i++;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '[') depth++;
    else if (char === ']' && --depth === 0) return { open, close: i };
  }
  throw new Error('move-doc: vercel.json "redirects" array is never closed');
}

/**
 * Append a redirect to the `redirects` array in vercel.json. Idempotent on `source`.
 *
 * The entry is spliced in as text instead of round-tripping through `JSON.parse`/`stringify`:
 * vercel.json is hand-formatted, and re-stringifying it would reformat all of its existing entries
 * and bury the one line that actually changed. The result is parsed before it is written, so a
 * botched splice fails here rather than at deploy time.
 */
async function appendVercelRedirect(
  vercelPath: string,
  entry: VercelRedirect,
  dryRun: boolean,
): Promise<'appended' | 'exists'> {
  const content = await readFile(vercelPath, 'utf8');
  if (content.includes(`"source": "${entry.source}"`)) return 'exists';

  const { open, close } = findRedirectsArray(content);
  const text =
    `    { "source": "${entry.source}",\n` +
    `      "destination": "${entry.destination}",\n` +
    `      "permanent": false }`;

  // Append after the last existing entry; fall back to filling an empty array.
  const lastEntryEnd = content.lastIndexOf('}', close);
  const insertAt = lastEntryEnd > open ? lastEntryEnd + 1 : open + 1;
  const insertion = lastEntryEnd > open ? `,\n${text}` : `\n${text}\n  `;
  const next = content.slice(0, insertAt) + insertion + content.slice(insertAt);

  try {
    JSON.parse(next);
  } catch (error) {
    throw new Error(
      `move-doc: appending the redirect produced invalid JSON in ${path.basename(vercelPath)}: ${error}`,
    );
  }

  if (!dryRun) await writeFile(vercelPath, next);
  return 'appended';
}

/**
 * Move `fromAbs` to `toAbs`, preferring `git mv` so the rename is staged and git records it as a
 * rename — preserving `git log --follow` history. The moved file's own links are rewritten right
 * after, which would otherwise drop content similarity below git's rename-detection threshold and
 * make the move read as delete+add. Falls back to a filesystem move when git can't do it (outside a
 * work tree, or an untracked source); the move still happens, just unstaged. Returns true when the
 * move was staged via git.
 */
async function moveFile(fromAbs: string, toAbs: string, repoRoot: string): Promise<boolean> {
  await mkdir(path.dirname(toAbs), { recursive: true });
  try {
    execFileSync('git', ['mv', fromAbs, toAbs], { cwd: repoRoot, stdio: 'pipe' });
    return true;
  } catch {
    await rename(fromAbs, toAbs);
    return false;
  }
}

async function main(): Promise<void> {
  const { from, to, dryRun } = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const fromAbs = path.resolve(repoRoot, from);
  const toAbs = path.resolve(repoRoot, to);
  const docsRoot = path.join(repoRoot, 'docs');

  for (const [label, raw, abs] of [
    ['from', from, fromAbs],
    ['to', to, toAbs],
  ] as const) {
    // A leading slash makes the arg an absolute path, so it resolves outside the repo. It usually
    // means the caller passed a site URL ("/docs/…") instead of a repo-relative file path.
    if (raw.startsWith('/')) {
      console.error(
        `move-doc: <${label}> starts with '/': ${raw}\n` +
          `  Pass a repo-relative file path, not a site URL — drop the leading slash, e.g. '${raw.replace(
            /^\/+/,
            '',
          )}'.`,
      );
      process.exit(1);
    }
    if (!abs.startsWith(docsRoot + path.sep) || !/\.mdx?$/.test(abs)) {
      console.error(`move-doc: <${label}> must be a .md/.mdx file under docs/: ${abs}`);
      process.exit(1);
    }
  }
  if (fromAbs === toAbs) {
    console.error('move-doc: <from> and <to> are the same path');
    process.exit(1);
  }
  if (!existsSync(fromAbs)) {
    console.error(`move-doc: <from> does not exist: ${fromAbs}`);
    process.exit(1);
  }
  if (existsSync(toAbs)) {
    console.error(`move-doc: <to> already exists: ${toAbs}`);
    process.exit(1);
  }

  const index = await buildDocsIndex(repoRoot);
  const fromFile = index.files.find((file) => file.abs === fromAbs);
  if (!fromFile) {
    console.error(`move-doc: <from> is not an indexed doc: ${fromAbs}`);
    process.exit(1);
  }

  const partial = isPartial(fromAbs);
  const frontmatter = matter(fromFile.content).data as Record<string, unknown>;
  const toRel = path.join('docs', path.relative(docsRoot, toAbs));
  const oldUrl = partial ? null : resolveDocUrl(fromFile.rel, frontmatter);
  const newUrl = partial ? null : resolveDocUrl(toRel, frontmatter);
  const oldId = partial ? null : resolveDocId(fromFile.rel, frontmatter);
  const newId = partial ? null : resolveDocId(toRel, frontmatter);

  const { records, unparsed } = scanLinks(index);
  const {
    edits,
    unrenderable,
    changes: inboundChanges,
  } = planInbound(records, index, fromAbs, toAbs, newUrl);
  const { rewrites: outboundRewrites, changes: outboundChanges } = planOutbound(
    records,
    index,
    fromAbs,
    toAbs,
    newUrl,
  );
  const movedContent = applyRewrites(fromFile.content, outboundRewrites);

  const sidebarsPath = path.join(repoRoot, 'sidebars.json');
  const sidebarsBefore = await readFile(sidebarsPath, 'utf8');
  const sidebarsSwaps: Array<readonly [string, string]> = [];
  if (oldId && newId) sidebarsSwaps.push([oldId, newId]);
  if (oldUrl && newUrl) sidebarsSwaps.push([oldUrl, newUrl]);
  const sidebarsResult = updateSidebars(sidebarsBefore, sidebarsSwaps);

  // Glossary terms are rendered into runtime quicklook tooltips from the generated
  // static/glossary.json, which `yarn build` does NOT validate. If a glossary source partial
  // was rewritten (or moved), the generated JSON must be regenerated separately.
  const isGlossary = (p: string) => p.replace(/\\/g, '/').includes('/partials/glossary/');
  const touchedGlossary =
    edits.some((edit) => isGlossary(edit.abs)) || isGlossary(fromAbs) || isGlossary(toAbs);
  const glossaryReminder =
    'Glossary content was affected — run `yarn build-glossary` to refresh static/glossary.json ' +
    '(the quicklook tooltips). `yarn build` does not flag stale glossary links.';

  // A relative link inside a partial cannot be resolved statically: a partial has no fixed URL,
  // so `../x` depends on which page imports it. Such links are never auto-rewritten — flag them
  // (like expression links) so a move never silently leaves one pointing at the old location.
  const ambiguousPartialLinks = records.filter((record) => {
    if (record.toFile !== null || !isPartial(record.fromFile)) return false;
    const { pathPart } = splitSuffix(record.ref.rawUrl);
    if (isExternalOrFragment(pathPart)) return false;
    return pathPart.startsWith('.');
  });

  const inboundRefCount = edits.reduce((sum, edit) => sum + edit.rewrites.length, 0);
  console.log(
    `${dryRun ? '[dry-run] ' : ''}move ${fromFile.rel} -> ${path.relative(repoRoot, toAbs)}`,
  );
  if (!partial)
    console.log(
      `  url:  ${oldUrl}  ->  ${newUrl}${oldUrl === newUrl ? '  (unchanged: slug override)' : ''}`,
    );
  console.log(`  inbound link rewrites: ${inboundRefCount} across ${edits.length} file(s)`);
  for (const edit of edits)
    console.log(`    ${path.relative(repoRoot, edit.abs)} (${edit.rewrites.length})`);
  console.log(`  moved-file relative links rewritten: ${outboundRewrites.length}`);
  console.log(`  sidebars.json references updated (id + href): ${sidebarsResult.count}`);

  if (unrenderable.length > 0) {
    console.warn(
      `  WARNING: ${unrenderable.length} reference(s) could not be rewritten (review manually):`,
    );
    for (const record of unrenderable) {
      console.warn(`    ${path.relative(repoRoot, record.fromFile)}: ${record.ref.rawUrl}`);
    }
  }
  if (unparsed.length > 0) {
    console.warn(
      `  WARNING: ${unparsed.length} file(s) could not be parsed and were not scanned for references:`,
    );
    for (const { file } of unparsed) console.warn(`    ${path.relative(repoRoot, file)}`);
  }
  if (ambiguousPartialLinks.length > 0) {
    console.warn(
      `  WARNING: ${ambiguousPartialLinks.length} relative link(s) inside partials cannot be resolved ` +
        `(a partial has no fixed URL); if this move affects their target, update them manually:`,
    );
    for (const record of ambiguousPartialLinks) {
      console.warn(`    ${path.relative(repoRoot, record.fromFile)}: ${record.ref.rawUrl}`);
    }
  }

  // A partial has no URL, and a slug override can leave the URL unchanged — neither needs a redirect.
  const redirect =
    !partial && oldUrl && newUrl && oldUrl !== newUrl
      ? buildVercelRedirect(oldUrl, newUrl, await readSiteUrlConfig(repoRoot))
      : null;
  const vercelPath = path.join(repoRoot, 'vercel.json');

  if (dryRun) {
    const allChanges = [...inboundChanges, ...outboundChanges];
    if (allChanges.length > 0) {
      console.log('\n  rewrites:');
      for (const change of allChanges) {
        console.log(
          `    ${path.relative(repoRoot, change.file)}: ${change.old}  ->  ${change.next}`,
        );
      }
    }
    if (redirect) {
      const status = await appendVercelRedirect(vercelPath, redirect, true);
      console.log(
        `\n  vercel.json redirect (${status}): ` +
          `{ "source": "${redirect.source}", "destination": "${redirect.destination}", "permanent": false }`,
      );
    }
    if (touchedGlossary) console.log(`\n  ${glossaryReminder}`);
    console.log('\n[dry-run] no files were changed.');
    return;
  }

  for (const edit of edits) {
    await writeFile(edit.abs, applyRewrites(edit.content, edit.rewrites));
  }
  const staged = await moveFile(fromAbs, toAbs, repoRoot);
  await writeFile(toAbs, movedContent);
  if (!staged)
    console.warn('  note: moved without git (untracked source or no work tree) — move is unstaged');
  if (sidebarsResult.count > 0) await writeFile(sidebarsPath, sidebarsResult.content);

  if (redirect) {
    const status = await appendVercelRedirect(vercelPath, redirect, false);
    console.log(`  vercel.json: ${status} redirect ${redirect.source} -> ${redirect.destination}`);
  }

  console.log('\nDone. Next: `npm run build` to verify links.');
  if (touchedGlossary) console.log(`Also: ${glossaryReminder}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
