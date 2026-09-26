'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {sync} = require('../src/engine.js');

// Rendering is independently covered by core.test.js. This small renderer makes
// the IO/ownership tests independent of Markdown parsing details.
globalThis.MineruSyncCore = {
  render({markdown, imagePrefix, metadata}) {
    const imagePaths = [...markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(match => match[1]);
    return {text: `---\ntitle: ${metadata.title}\n---\n${markdown.replace(/\]\(([^)]+)\)/g, (_, value) => `](${imagePrefix}/${value})`)}`,
      imagePaths, referenceCount: imagePaths.length, restoredCount: 0, warnings: []};
  }
};

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mineru-engine-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const vaultPath = path.join(root, 'vault');
  const cacheRoot = path.join(root, 'cache');
  await fs.mkdir(vaultPath);
  await fs.mkdir(path.join(cacheRoot, '10', 'images'), {recursive: true});
  await fs.writeFile(path.join(cacheRoot, '10', 'full.md'), '# Paper\n\n![Figure](images/figure.png)\n');
  await fs.writeFile(path.join(cacheRoot, '10', 'images', 'figure.png'), new Uint8Array([1, 2, 3, 4]));
  const calls = {writes: 0, mkdirs: 0};
  const io = {
    join: path.join,
    dirname: path.dirname,
    async exists(file) { try { await fs.stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } },
    readText: file => fs.readFile(file, 'utf8'),
    readBytes: file => fs.readFile(file),
    async mkdir(directory) { calls.mkdirs++; await fs.mkdir(directory, {recursive: true}); },
    async writeText(file, text) { calls.writes++; await fs.writeFile(`${file}.tmp`, text); await fs.rename(`${file}.tmp`, file); },
    async writeBytes(file, value) { calls.writes++; await fs.writeFile(`${file}.tmp`, value); await fs.rename(`${file}.tmp`, file); },
    async assertSafe(directory, file) {
      const relative = path.relative(directory, file);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Path escaped root');
      let current = directory;
      for (const part of ['', ...relative.split(path.sep)]) {
        if (part) current = path.join(current, part);
        try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Symlink rejected: ${current}`); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  };
  const attachment = {id: 10, key: 'ABCDEFGH', parentID: 9, libraryID: 1, filename: 'Example Paper.pdf', metadata: {title: 'Example paper'}};
  const options = {io, vaultPath, cacheRoot, papersDir: 'papers', assetsDir: 'assets', attachments: [attachment]};
  const note = path.join(vaultPath, 'papers', 'Example Paper--1-ABCDEFGH.md');
  const asset = path.join(vaultPath, 'assets', '1-ABCDEFGH', 'images', 'figure.png');
  const stateFile = path.join(vaultPath, '.zotero-mineru-sync', 'state.json');
  return {root, vaultPath, cacheRoot, io, calls, attachment, options, note, asset, stateFile};
}

async function filesUnder(directory) {
  const results = [];
  async function walk(current) {
    for (const entry of await fs.readdir(current, {withFileTypes: true})) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(file);
      else results.push([path.relative(directory, file), Array.from(await fs.readFile(file))]);
    }
  }
  await walk(directory);
  return results.sort((a, b) => a[0].localeCompare(b[0]));
}

test('creates portable note/assets and the second sync does not write', async t => {
  const f = await fixture(t);
  const first = await sync(f.options);
  assert.equal(first.counts.created, 1);
  assert.equal(first.counts.imagesCopied, 1);
  assert.match(await fs.readFile(f.note, 'utf8'), /\.\.\/assets\/1-ABCDEFGH\/images\/figure\.png/);
  assert.deepEqual(Array.from(await fs.readFile(f.asset)), [1, 2, 3, 4]);
  const state = JSON.parse(await fs.readFile(f.stateFile, 'utf8'));
  assert.equal(state.schema, 1);
  assert.equal(state.entries['1-ABCDEFGH'].notePath, 'papers/Example Paper--1-ABCDEFGH.md');
  const writeCount = f.calls.writes;
  const second = await sync(f.options);
  assert.equal(second.counts.unchanged, 1);
  assert.equal(second.counts.imagesCopied, 0);
  assert.equal(f.calls.writes, writeCount);
});

test('dry run performs no filesystem mutation', async t => {
  const f = await fixture(t);
  const before = await filesUnder(f.root);
  const result = await sync({...f.options, dryRun: true});
  assert.equal(result.counts.created, 1);
  assert.equal(result.counts.imagesCopied, 1);
  assert.equal(f.calls.writes, 0);
  assert.equal(f.calls.mkdirs, 0);
  assert.deepEqual(await filesUnder(f.root), before);
});

test('overwrite updates managed local edits and same-name source images', async t => {
  const f = await fixture(t);
  await sync(f.options);
  await fs.writeFile(f.note, 'Obsidian edits');
  await fs.writeFile(f.asset, new Uint8Array([99]));
  await fs.writeFile(path.join(f.cacheRoot, '10', 'full.md'), 'Revised\n![Figure](images/figure.png)\n');
  await fs.writeFile(path.join(f.cacheRoot, '10', 'images', 'figure.png'), new Uint8Array([5, 6, 7]));
  const result = await sync(f.options);
  assert.equal(result.counts.updated, 1);
  assert.equal(result.counts.imagesCopied, 1);
  assert.match(await fs.readFile(f.note, 'utf8'), /Revised/);
  assert.deepEqual(Array.from(await fs.readFile(f.asset)), [5, 6, 7]);
});

test('protect detects edited Markdown before writing any images', async t => {
  const f = await fixture(t);
  await sync(f.options);
  await fs.writeFile(f.note, 'Keep my edits');
  await fs.writeFile(path.join(f.cacheRoot, '10', 'images', 'figure.png'), new Uint8Array([8]));
  const writes = f.calls.writes;
  const result = await sync({...f.options, mode: 'protect'});
  assert.equal(result.counts.conflicts, 1);
  assert.equal(f.calls.writes, writes);
  assert.equal(await fs.readFile(f.note, 'utf8'), 'Keep my edits');
  assert.deepEqual(Array.from(await fs.readFile(f.asset)), [1, 2, 3, 4]);
});

test('protect checks image baselines and allows unedited source updates', async t => {
  const f = await fixture(t);
  await sync(f.options);
  await fs.writeFile(path.join(f.cacheRoot, '10', 'images', 'figure.png'), new Uint8Array([5]));
  assert.equal((await sync({...f.options, mode: 'protect'})).counts.updated, 1);
  await fs.writeFile(f.asset, new Uint8Array([9]));
  const result = await sync({...f.options, mode: 'protect'});
  assert.equal(result.counts.conflicts, 1);
  assert.deepEqual(Array.from(await fs.readFile(f.asset)), [9]);
});

test('unowned existing Markdown is preserved even in overwrite mode', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.note), {recursive: true});
  await fs.writeFile(f.note, 'An original manuscript');
  const result = await sync(f.options);
  assert.equal(result.counts.conflicts, 1);
  assert.equal(f.calls.writes, 0);
  assert.equal(await fs.readFile(f.note, 'utf8'), 'An original manuscript');
});

test('unowned conflicting images are preserved in overwrite mode', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.asset), {recursive: true});
  await fs.writeFile(f.asset, new Uint8Array([9]));
  const result = await sync(f.options);
  assert.equal(result.counts.conflicts, 1);
  assert.equal(f.calls.writes, 0);
  assert.deepEqual(Array.from(await fs.readFile(f.asset)), [9]);
});

test('missing image never leaves a new note with broken links', async t => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.cacheRoot, '10', 'images', 'figure.png'));
  const result = await sync(f.options);
  assert.equal(result.counts.missing, 1);
  assert.match(result.items[0].message, /image is missing/);
  assert.equal(f.calls.writes, 0);
  assert.equal(await f.io.exists(f.note), false);
});

test('missing full.md is reported while other attachments continue', async t => {
  const f = await fixture(t);
  const missing = {...f.attachment, id: 11, key: 'MISSING1'};
  const result = await sync({...f.options, attachments: [missing, f.attachment]});
  assert.equal(result.counts.missing, 1);
  assert.equal(result.counts.created, 1);
});

test('duplicate collection membership is deduplicated and filenames remain stable after rename', async t => {
  const f = await fixture(t);
  const first = await sync({...f.options, attachments: [f.attachment, f.attachment]});
  assert.equal(first.items.length, 1);
  assert.equal(first.counts.created, 1);
  f.attachment.filename = 'Renamed PDF.pdf';
  const second = await sync(f.options);
  assert.equal(second.items[0].path, 'papers/Example Paper--1-ABCDEFGH.md');
  assert.equal(second.counts.unchanged, 1);
  const before = await filesUnder(f.vaultPath);
  await sync({...f.options, attachments: []});
  assert.deepEqual(await filesUnder(f.vaultPath), before);
});

test('path traversal, unsafe IDs, and symlink destinations fail before writes', async t => {
  const f = await fixture(t);
  await assert.rejects(sync({...f.options, papersDir: '../outside'}), /Unsafe/);
  const badID = await sync({...f.options, attachments: [{...f.attachment, key: '../../oops'}]});
  assert.equal(badID.counts.failed, 1);
  await fs.writeFile(path.join(f.cacheRoot, '10', 'full.md'), '![Figure](../outside.png)');
  assert.equal((await sync(f.options)).counts.failed, 1);
  await fs.writeFile(path.join(f.cacheRoot, '10', 'full.md'), '![Figure](images/figure.png)');
  await fs.symlink(f.cacheRoot, path.join(f.vaultPath, 'assets'));
  assert.equal((await sync(f.options)).counts.failed, 1);
  assert.equal(f.calls.writes, 0);
});

test('invalid state fails closed rather than replacing the state', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.stateFile), {recursive: true});
  await fs.writeFile(f.stateFile, '{broken');
  await assert.rejects(sync(f.options), /Cannot safely read sync state/);
  assert.equal(f.calls.writes, 0);
  assert.equal(await fs.readFile(f.stateFile, 'utf8'), '{broken');
});

test('source changing during a read is reported without destination writes', async t => {
  const f = await fixture(t);
  const originalRead = f.io.readText;
  let reads = 0;
  f.io.readText = async file => {
    const value = await originalRead(file);
    if (file === path.join(f.cacheRoot, '10', 'full.md') && ++reads === 1) await fs.writeFile(file, `${value}\nConcurrent update`);
    return value;
  };
  const result = await sync(f.options);
  assert.equal(result.counts.failed, 1);
  assert.match(result.items[0].message, /cache changed/);
  assert.equal(f.calls.writes, 0);
});

test('failed state commit restores existing note/assets and a retry succeeds', async t => {
  const f = await fixture(t);
  await sync(f.options);
  const originalNote = await fs.readFile(f.note, 'utf8');
  const originalState = await fs.readFile(f.stateFile, 'utf8');
  await fs.writeFile(path.join(f.cacheRoot, '10', 'full.md'), 'Updated\n![Figure](images/figure.png)');
  await fs.writeFile(path.join(f.cacheRoot, '10', 'images', 'figure.png'), new Uint8Array([8]));
  const writeText = f.io.writeText;
  let failOnce = true;
  f.io.writeText = async (file, text) => {
    if (file === f.stateFile && failOnce) { failOnce = false; throw new Error('Simulated disk write failure'); }
    return writeText(file, text);
  };
  const result = await sync(f.options);
  assert.equal(result.counts.failed, 1);
  assert.equal(result.counts.updated, 0);
  assert.equal(result.counts.imagesCopied, 0);
  assert.equal(await fs.readFile(f.note, 'utf8'), originalNote);
  assert.equal(await fs.readFile(f.stateFile, 'utf8'), originalState);
  assert.deepEqual(Array.from(await fs.readFile(f.asset)), [1, 2, 3, 4]);
  const retry = await sync({...f.options, mode: 'protect'});
  assert.equal(retry.counts.updated, 1);
  assert.match(await fs.readFile(f.note, 'utf8'), /Updated/);
  assert.deepEqual(Array.from(await fs.readFile(f.asset)), [8]);
});

test('interrupted first write can recover identical unowned generated files', async t => {
  const f = await fixture(t);
  const writeText = f.io.writeText;
  let failOnce = true;
  f.io.writeText = async (file, text) => {
    if (file === f.stateFile && failOnce) { failOnce = false; throw new Error('Simulated interruption'); }
    return writeText(file, text);
  };
  const first = await sync(f.options);
  assert.equal(first.counts.failed, 1);
  assert.equal(await f.io.exists(f.stateFile), false);
  assert.match(first.warnings.join('\n'), /interrupted write/);
  const retry = await sync(f.options);
  assert.equal(retry.counts.unchanged, 1);
  assert.equal(await f.io.exists(f.stateFile), true);
});

test('long Unicode PDF filenames fit filesystem byte limits without splitting characters', async t => {
  const f = await fixture(t);
  f.attachment.filename = `${'气候适应研究🌏'.repeat(30)}.pdf`;
  const result = await sync(f.options);
  assert.equal(result.counts.created, 1);
  const filename = path.basename(result.items[0].path);
  assert.ok(Buffer.byteLength(filename, 'utf8') < 255);
  assert.ok(!filename.includes('\uFFFD'));
  assert.equal(await f.io.exists(path.join(f.vaultPath, result.items[0].path)), true);
});

test('real Markdown core integrates relative links, metadata, and manifest restoration', async t => {
  const f = await fixture(t);
  const stub = globalThis.MineruSyncCore;
  const core = require('../src/core.js');
  globalThis.MineruSyncCore = core;
  try {
    const original = 'Opening paragraph.\n\nFigure caption.';
    await fs.writeFile(path.join(f.cacheRoot, '10', 'full.md'), original);
    await fs.writeFile(path.join(f.cacheRoot, '10', '_llm_source.json'), JSON.stringify({sourceFilename: f.attachment.filename}));
    await fs.writeFile(path.join(f.cacheRoot, '10', 'manifest.json'), JSON.stringify({
      totalChars: original.length,
      figureBlocks: [{imagePaths: ['images/figure.png'], confidence: 'high', markdownStart: 20, markdownEnd: 34}]
    }));
    const first = await sync(f.options);
    assert.equal(first.counts.created, 1);
    assert.equal(first.counts.restored, 1);
    const text = await fs.readFile(f.note, 'utf8');
    assert.match(text, /mineru_sync: 1/);
    assert.match(text, /title: "Example paper"/);
    assert.match(text, /!\[\]\(\.\.\/assets\/1-ABCDEFGH\/images\/figure\.png\)/);
    assert.match(text, /Figure caption\./);
    assert.deepEqual(Array.from(await fs.readFile(f.asset)), [1, 2, 3, 4]);
    const second = await sync(f.options);
    assert.equal(second.counts.unchanged, 1);
    assert.equal(second.counts.imagesCopied, 0);
  } finally { globalThis.MineruSyncCore = stub; }
});
