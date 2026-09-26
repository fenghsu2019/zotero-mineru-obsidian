#!/usr/bin/env node
'use strict';
/* Read a real MinerU cache into an empty, isolated test vault. Never writes to the cache. */
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const core = require('../src/core.js');
const {sync} = require('../src/engine.js');

const usage = `Usage:
  node scripts/smoke-local.js --cache-root PATH --attachment ID:KEY:LIBRARY_ID --output EMPTY_DIRECTORY [--filename PDF_NAME]

The output directory must already exist, be empty, and not overlap the cache.
Example:
  mkdir /private/tmp/mineru-smoke-example
  node scripts/smoke-local.js --cache-root ~/Zotero/llm-for-zotero-mineru --attachment 123:ABCDEFGH:1 --output /private/tmp/mineru-smoke-example
`;

function contained(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function assertSafe(root, file) {
  if (!contained(root, file)) throw new Error(`Path escapes root: ${file}`);
  let current = root;
  for (const part of ['', ...path.relative(root, file).split(path.sep)]) {
    if (part) current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Symlink is not supported: ${current}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function exists(file) {
  try { await fs.stat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(usage); return; }
  const params = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!['--cache-root', '--attachment', '--output', '--filename'].includes(flag) || !args[index + 1] || params[flag] !== undefined) {
      throw new Error(`Invalid or repeated argument: ${flag}\n${usage}`);
    }
    params[flag] = args[index + 1];
  }
  if (!params['--cache-root'] || !params['--output'] || !params['--attachment']) throw new Error(usage);
  const match = params['--attachment'].match(/^([1-9]\d*):([A-Z0-9]{8}):([1-9]\d*)$/);
  if (!match) throw new Error('--attachment must be ID:KEY:LIBRARY_ID, e.g. 123:ABCDEFGH:1');
  const attachmentID = Number(match[1]), attachmentKey = match[2], libraryID = Number(match[3]);
  if (!Number.isSafeInteger(attachmentID) || !Number.isSafeInteger(libraryID)) throw new Error('IDs exceed the safe integer range');
  const cacheRoot = await fs.realpath(path.resolve(params['--cache-root']));
  const output = await fs.realpath(path.resolve(params['--output']));
  if (!(await fs.stat(cacheRoot)).isDirectory() || !(await fs.stat(output)).isDirectory()) throw new Error('Cache and output paths must be directories');
  if (contained(cacheRoot, output) || contained(output, cacheRoot)) throw new Error('Output and source cache cannot overlap');
  if ((await fs.readdir(output)).length) throw new Error('Output must be an empty, isolated directory');

  const snapshots = new Map();
  async function readSource(relative, optional = false) {
    const file = path.join(cacheRoot, String(attachmentID), relative);
    await assertSafe(cacheRoot, file);
    if (optional && !await exists(file)) { snapshots.set(file, null); return null; }
    const value = await fs.readFile(file);
    snapshots.set(file, value);
    return value;
  }
  const markdown = (await readSource('full.md')).toString('utf8');
  const manifestBytes = await readSource('manifest.json', true);
  const metadataBytes = await readSource('_llm_source.json', true);
  const manifest = manifestBytes === null ? null : JSON.parse(manifestBytes.toString('utf8'));
  const cacheMetadata = metadataBytes === null ? {} : JSON.parse(metadataBytes.toString('utf8'));
  const filename = params['--filename'] || cacheMetadata.sourceFilename || '';
  const metadata = {title: `Smoke test: ${filename || attachmentID}`, authors: [], libraryID, attachmentItemID: attachmentID,
    attachmentKey, collections: ['Local smoke test']};
  const identity = `${libraryID}-${attachmentKey}`;
  const renderArgs = {markdown, manifest, sourceFilename: cacheMetadata.sourceFilename || '', attachmentFilename: filename,
    metadata, imagePrefix: `../assets/${identity}`, restoreImages: true};
  const expected = core.render(renderArgs);
  for (const imagePath of expected.imagePaths) await readSource(imagePath);

  const calls = {writes: 0, mkdirs: 0};
  let temporary = 0;
  async function atomic(file, value) {
    await assertSafe(output, file);
    calls.writes++;
    const temp = `${file}.tmp-${process.pid}-${++temporary}`;
    await fs.writeFile(temp, value, {flag: 'wx'});
    try { await fs.rename(temp, file); }
    finally { await fs.rm(temp, {force: true}); }
  }
  const io = {
    join: path.join,
    dirname: path.dirname,
    exists,
    readText: file => fs.readFile(file, 'utf8'),
    readBytes: file => fs.readFile(file),
    writeText: atomic,
    writeBytes: atomic,
    async mkdir(directory) { await assertSafe(output, directory); calls.mkdirs++; await fs.mkdir(directory, {recursive: true}); },
    assertSafe
  };
  const attachment = {id: attachmentID, key: attachmentKey, libraryID, filename, metadata};
  const options = {io, vaultPath: output, cacheRoot, papersDir: 'papers', assetsDir: 'assets', attachments: [attachment]};
  const preview = await sync({...options, dryRun: true});
  assert.equal(preview.counts.created, 1, JSON.stringify(preview));
  assert.equal(calls.writes, 0, 'Preview wrote files');
  assert.equal(calls.mkdirs, 0, 'Preview created directories');
  assert.deepEqual(await fs.readdir(output), [], 'Preview changed output');

  const first = await sync(options);
  assert.equal(first.counts.created, 1, JSON.stringify(first));
  assert.equal(first.counts.failed + first.counts.missing + first.counts.conflicts, 0, JSON.stringify(first));
  const notePath = path.join(output, first.items[0].path);
  const note = await fs.readFile(notePath, 'utf8');
  assert.equal(note, expected.text, 'Written note differs from rendered source');
  // Reparse the generated links, then resolve every local image in the test vault.
  const parsedOutput = core.render({...renderArgs, markdown: note, manifest: null});
  assert.deepEqual(parsedOutput.imagePaths, expected.imagePaths, 'Generated image links do not round-trip');
  assert.equal(parsedOutput.referenceCount, expected.referenceCount, 'Generated image-reference count changed');
  let verifiedImages = 0;
  for (const imagePath of parsedOutput.imagePaths) {
    const destination = path.resolve(path.dirname(notePath), '..', 'assets', identity, imagePath);
    await assertSafe(output, destination);
    const sourceFile = path.join(cacheRoot, String(attachmentID), imagePath);
    assert.deepEqual(await fs.readFile(destination), snapshots.get(sourceFile), `Copied image differs: ${imagePath}`);
    verifiedImages++;
  }
  const writesBeforeSecond = calls.writes;
  const mkdirsBeforeSecond = calls.mkdirs;
  const second = await sync(options);
  assert.equal(second.counts.unchanged, 1, JSON.stringify(second));
  assert.equal(second.counts.created + second.counts.updated + second.counts.failed + second.counts.missing + second.counts.conflicts, 0, JSON.stringify(second));
  assert.equal(second.counts.imagesCopied, 0, 'Second sync copied images');
  assert.equal(calls.writes - writesBeforeSecond, 0, 'Second sync wrote files');
  assert.equal(calls.mkdirs - mkdirsBeforeSecond, 0, 'Second sync created directories');
  for (const [sourceFile, original] of snapshots) {
    await assertSafe(cacheRoot, sourceFile);
    if (original === null) assert.equal(await exists(sourceFile), false, `Source appeared during test: ${sourceFile}`);
    else assert.deepEqual(await fs.readFile(sourceFile), original, `Source changed during test: ${sourceFile}`);
  }
  process.stdout.write(JSON.stringify({ok: true, cacheReadOnly: true, attachmentID, attachmentKey, libraryID,
    fullMarkdown: path.join(cacheRoot, String(attachmentID), 'full.md'), sourceFilename: filename || null,
    output, notePath, verifiedImages, imageReferences: parsedOutput.referenceCount,
    restored: first.counts.restored, previewWrites: 0, secondSyncWrites: calls.writes - writesBeforeSecond,
    first: first.counts, second: second.counts, warnings: first.warnings}, null, 2) + '\n');
}

main().catch(error => {
  process.stderr.write(`Smoke test failed: ${error.message}\n`);
  process.exitCode = 1;
});
