/* Dependency-free synchronization engine. IO adapters must atomically replace files. */
(function (root) {
  'use strict';
  const STATE_DIR = '.zotero-mineru-sync';
  let generation = 0;

  function relativePath(value, label) {
    if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') || /[\x00-\x1f:*?"<>|]/.test(value)) {
      throw new Error(`Unsafe ${label}: ${String(value)}`);
    }
    const parts = value.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
      throw new Error(`Unsafe ${label}: ${value}`);
    }
    return value;
  }

  function bytes(value) {
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    return new Uint8Array(value);
  }

  function equalBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function relativeBetween(fromDirectory, toDirectory) {
    const from = fromDirectory.split('/').filter(Boolean);
    const to = toDirectory.split('/').filter(Boolean);
    let common = 0;
    while (common < from.length && common < to.length && from[common] === to[common]) common++;
    return [...from.slice(common).map(() => '..'), ...to.slice(common)].join('/') || '.';
  }

  function identityOf(attachment) {
    const libraryID = Number(attachment.libraryID);
    const id = Number(attachment.id);
    if (!Number.isSafeInteger(libraryID) || libraryID < 1 || !Number.isSafeInteger(id) || id < 1 || !/^[A-Za-z0-9_-]{1,32}$/.test(attachment.key || '')) {
      throw new Error('Attachment must have a positive libraryID/id and a safe Zotero attachment key');
    }
    return `${libraryID}-${attachment.key}`;
  }

  function noteFilename(filename, identity) {
    const clean = String(filename || 'paper.pdf').replace(/\.pdf$/i, '').normalize('NFC')
      .replace(/[\\/\x00-\x1f\x7f:*?"<>|]/g, '-').replace(/[. ]+$/g, '').trim();
    let stem = '', byteLength = 0;
    for (const character of clean) {
      const point = character.codePointAt(0);
      const length = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
      if (byteLength + length > 160) break;
      stem += character;
      byteLength += length;
    }
    stem = stem.replace(/[. ]+$/g, '') || 'paper';
    return `${stem}--${identity}.md`;
  }

  function checkedState(value) {
    if (!value || value.schema !== 1 || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) {
      throw new Error('Invalid sync state; expected schema 1 and an entries object');
    }
    const destinations = new Set();
    for (const [identity, entry] of Object.entries(value.entries)) {
      if (!/^\d+-[A-Za-z0-9_-]+$/.test(identity) || !entry || typeof entry !== 'object') throw new Error('Invalid sync state entry');
      relativePath(entry.notePath, 'state note path');
      relativePath(entry.baselinePath, 'state baseline path');
      if (!entry.notePath.endsWith('.md') || entry.notePath.startsWith(`${STATE_DIR}/`) || !entry.baselinePath.startsWith(`${STATE_DIR}/baselines/${identity}/`) || !Array.isArray(entry.assets)) {
        throw new Error('Invalid sync state ownership/baseline');
      }
      for (const path of [entry.notePath, ...entry.assets.map(asset => asset.path)]) {
        relativePath(path, 'state destination');
        if (destinations.has(path)) throw new Error('Duplicate destination in sync state');
        destinations.add(path);
      }
      for (const asset of entry.assets) {
        relativePath(asset.sourcePath, 'state source image');
        relativePath(asset.baselinePath, 'state image baseline');
        if (!asset.sourcePath.startsWith('images/') || !asset.baselinePath.startsWith(`${STATE_DIR}/baselines/${identity}/`) || asset.path.startsWith(`${STATE_DIR}/`)) {
          throw new Error('Invalid sync state asset');
        }
      }
    }
    return value;
  }

  function failure(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  async function sync(options) {
    const {io, vaultPath, cacheRoot, attachments, dryRun = false, restoreImages = true, onProgress} = options;
    const mode = options.mode || 'overwrite';
    if (!['overwrite', 'protect'].includes(mode)) throw new Error('Sync mode must be overwrite or protect');
    if (!io || !Array.isArray(attachments) || !vaultPath || !cacheRoot) throw new Error('Missing sync IO, vault, cache, or attachments');
    const papersDir = relativePath(options.papersDir || 'Zotero/papers', 'papers directory');
    const assetsDir = relativePath(options.assetsDir || 'Zotero/assets', 'assets directory');
    if ([papersDir, assetsDir].some(path => path === STATE_DIR || path.startsWith(`${STATE_DIR}/`) || path === '.obsidian' || path.startsWith('.obsidian/'))) {
      throw new Error('Output directories cannot use plugin state or Obsidian settings directories');
    }
    const core = root.MineruSyncCore || (typeof require === 'function' ? require('./core.js') : null);
    if (!core || typeof core.render !== 'function') throw new Error('Markdown core is unavailable');
    const result = {dryRun: !!dryRun, counts: {created: 0, updated: 0, unchanged: 0, conflicts: 0, missing: 0, failed: 0, imagesCopied: 0, restored: 0}, items: [], warnings: []};
    const target = async path => {
      relativePath(path, 'destination');
      const absolute = io.join(vaultPath, ...path.split('/'));
      await io.assertSafe(vaultPath, absolute);
      return absolute;
    };
    const source = async path => {
      const absolute = io.join(cacheRoot, ...path.split('/'));
      await io.assertSafe(cacheRoot, absolute);
      return absolute;
    };
    const statePath = await target(`${STATE_DIR}/state.json`);
    let state = {schema: 1, entries: {}};
    if (await io.exists(statePath)) {
      try { state = checkedState(JSON.parse(await io.readText(statePath))); }
      catch (error) { throw new Error(`Cannot safely read sync state: ${error.message}`); }
    }
    // Validate all recorded destinations, including entries outside the current collection.
    for (const entry of Object.values(state.entries)) {
      await target(entry.notePath);
      await target(entry.baselinePath);
      for (const asset of entry.assets) { await target(asset.path); await target(asset.baselinePath); }
    }
    const seen = new Set();

    async function progress(item) {
      result.items.push(item);
      const countKey = item.status === 'conflict' ? 'conflicts' : item.status;
      if (Object.prototype.hasOwnProperty.call(result.counts, countKey)) result.counts[countKey]++;
      if (onProgress) {
        try { await onProgress(item, result); }
        catch (error) { result.warnings.push(`Progress callback failed: ${error.message}`); }
      }
    }

    for (const attachment of attachments) {
      const item = {attachmentID: attachment.id, title: attachment.metadata?.title || attachment.filename || '', status: 'failed'};
      try {
        const identity = identityOf(attachment);
        if (seen.has(identity)) continue;
        seen.add(identity);
        const oldEntry = state.entries[identity];
        const notePath = oldEntry?.notePath || `${papersDir}/${noteFilename(attachment.filename, identity)}`;
        const assetRoot = `${assetsDir}/${identity}`;
        item.path = notePath;
        const absoluteNote = await target(notePath);
        const sourceTexts = [];
        async function snapshotText(name, required) {
          const path = await source(`${attachment.id}/${name}`);
          const exists = await io.exists(path);
          if (!exists && required) throw failure(`MinerU output is missing: ${path}`, 'MISSING');
          const content = exists ? await io.readText(path) : null;
          sourceTexts.push({path, content});
          return content;
        }
        const markdown = await snapshotText('full.md', true);
        const manifestText = await snapshotText('manifest.json', false);
        const sourceText = await snapshotText('_llm_source.json', false);
        const manifest = manifestText === null ? null : JSON.parse(manifestText);
        const sourceMetadata = sourceText === null ? null : JSON.parse(sourceText);
        const noteDirectory = notePath.split('/').slice(0, -1).join('/');
        const rendered = core.render({markdown, manifest, sourceFilename: sourceMetadata?.sourceFilename, attachmentFilename: attachment.filename,
          metadata: attachment.metadata || {}, imagePrefix: relativeBetween(noteDirectory, assetRoot), restoreImages});
        if (!rendered || typeof rendered.text !== 'string' || !Array.isArray(rendered.imagePaths)) throw new Error('Markdown core returned an invalid rendering');
        const warnings = Array.isArray(rendered.warnings) ? rendered.warnings : [];
        item.warnings = warnings;
        result.warnings.push(...warnings.map(warning => `${identity}: ${warning}`));
        item.references = rendered.referenceCount || 0;
        item.images = rendered.imagePaths.length;
        item.restored = rendered.restoredCount || 0;
        const images = [];
        // Read every referenced source before touching any destination.
        for (const sourcePath of new Set(rendered.imagePaths)) {
          relativePath(sourcePath, 'source image path');
          if (!sourcePath.startsWith('images/')) throw new Error(`Image must be under the cache images directory: ${sourcePath}`);
          const absoluteSource = await source(`${attachment.id}/${sourcePath}`);
          if (!await io.exists(absoluteSource)) throw failure(`Referenced MinerU image is missing: ${absoluteSource}`, 'MISSING');
          const imageBytes = bytes(await io.readBytes(absoluteSource));
          const path = `${assetRoot}/${sourcePath}`;
          if (path === notePath) throw new Error(`Image destination collides with the Markdown note: ${path}`);
          const absoluteTarget = await target(path);
          const previous = await io.exists(absoluteTarget) ? bytes(await io.readBytes(absoluteTarget)) : null;
          const owned = oldEntry?.assets.find(asset => asset.path === path);
          const changed = previous === null || !equalBytes(previous, imageBytes);
          if (previous !== null && changed) {
            if (!owned) throw failure(`An unowned image already exists: ${path}`, 'CONFLICT');
            if (mode === 'protect') {
              const baselinePath = await target(owned.baselinePath);
              if (!await io.exists(baselinePath) || !equalBytes(previous, bytes(await io.readBytes(baselinePath)))) {
                throw failure(`Obsidian image was modified: ${path}`, 'CONFLICT');
              }
            }
          }
          images.push({sourcePath, absoluteSource, imageBytes, path, absoluteTarget, previous, changed, owned});
        }
        const previousText = await io.exists(absoluteNote) ? await io.readText(absoluteNote) : null;
        const noteChanged = previousText !== rendered.text;
        if (previousText !== null && noteChanged) {
          if (!oldEntry) throw failure(`An unowned Markdown file already exists: ${notePath}`, 'CONFLICT');
          if (mode === 'protect') {
            const baselinePath = await target(oldEntry.baselinePath);
            if (!await io.exists(baselinePath) || previousText !== await io.readText(baselinePath)) {
              throw failure(`Obsidian Markdown was modified: ${notePath}`, 'CONFLICT');
            }
          }
        }
        async function verifySources() {
          for (const snapshot of sourceTexts) {
            await io.assertSafe(cacheRoot, snapshot.path);
            const exists = await io.exists(snapshot.path);
            if (exists !== (snapshot.content !== null) || (exists && await io.readText(snapshot.path) !== snapshot.content)) {
              throw new Error(`MinerU cache changed during synchronization; retry: ${snapshot.path}`);
            }
          }
          for (const image of images) {
            await io.assertSafe(cacheRoot, image.absoluteSource);
            if (!await io.exists(image.absoluteSource) || !equalBytes(image.imageBytes, bytes(await io.readBytes(image.absoluteSource)))) {
              throw new Error(`MinerU image changed during synchronization; retry: ${image.absoluteSource}`);
            }
          }
        }
        async function verifyDestinations() {
          await io.assertSafe(vaultPath, absoluteNote);
          const noteExists = await io.exists(absoluteNote);
          if (noteExists !== (previousText !== null) || (noteExists && await io.readText(absoluteNote) !== previousText)) throw new Error(`Markdown destination changed during synchronization: ${notePath}`);
          for (const image of images) {
            await io.assertSafe(vaultPath, image.absoluteTarget);
            const exists = await io.exists(image.absoluteTarget);
            if (exists !== (image.previous !== null) || (exists && !equalBytes(image.previous, bytes(await io.readBytes(image.absoluteTarget))))) {
              throw new Error(`Image destination changed during synchronization: ${image.path}`);
            }
          }
        }
        await verifySources();
        const changedImages = images.filter(image => image.changed);
        const status = previousText === null ? 'created' : noteChanged || changedImages.length ? 'updated' : 'unchanged';
        if (!dryRun && (!oldEntry || status !== 'unchanged')) {
          // Unique immutable baselines keep old state valid if a write fails.
          let baselineRoot;
          do { baselineRoot = `${STATE_DIR}/baselines/${identity}/${Date.now()}-${++generation}`; }
          while (await io.exists(await target(baselineRoot)));
          const baselinePath = `${baselineRoot}/note.md`;
          await io.mkdir(io.dirname(await target(baselinePath)));
          await io.writeText(await target(baselinePath), rendered.text);
          const newAssets = new Map((oldEntry?.assets || []).map(asset => [asset.path, asset]));
          for (const image of images) {
            // Reuse immutable byte baselines when only the note metadata changed.
            if (image.owned) {
              const priorBaseline = await target(image.owned.baselinePath);
              if (await io.exists(priorBaseline) && equalBytes(image.imageBytes, bytes(await io.readBytes(priorBaseline)))) continue;
            }
            const imageBaseline = `${baselineRoot}/${image.sourcePath}`;
            const absoluteBaseline = await target(imageBaseline);
            await io.mkdir(io.dirname(absoluteBaseline));
            await io.writeBytes(absoluteBaseline, image.imageBytes);
            newAssets.set(image.path, {path: image.path, sourcePath: image.sourcePath, baselinePath: imageBaseline});
          }
          await verifySources();
          await verifyDestinations();
          const touched = [];
          let noteTouched = false;
          try {
            for (const image of changedImages) {
              await io.mkdir(io.dirname(image.absoluteTarget));
              touched.push(image);
              await io.writeBytes(image.absoluteTarget, image.imageBytes);
            }
            if (noteChanged) {
              await io.mkdir(io.dirname(absoluteNote));
              noteTouched = true;
              await io.writeText(absoluteNote, rendered.text);
            }
            await verifySources();
            const nextState = {schema: 1, entries: {...state.entries, [identity]: {notePath, baselinePath, assets: [...newAssets.values()]}}};
            await io.mkdir(io.dirname(statePath));
            await io.writeText(statePath, JSON.stringify(nextState, null, 2) + '\n');
            state = nextState;
          } catch (error) {
            const rollbackErrors = [];
            if (noteTouched && previousText !== null) {
              try { await io.writeText(absoluteNote, previousText); } catch (rollback) { rollbackErrors.push(rollback.message); }
            }
            for (const image of touched.reverse()) {
              if (image.previous !== null) {
                try { await io.writeBytes(image.absoluteTarget, image.previous); } catch (rollback) { rollbackErrors.push(rollback.message); }
              }
            }
            if ((noteTouched && previousText === null) || touched.some(image => image.previous === null)) {
              result.warnings.push(`${identity}: An interrupted write may have left new files; existing files were restored where possible. Rerun to adopt identical generated files.`);
            }
            if (rollbackErrors.length) result.warnings.push(`${identity}: Rollback was incomplete: ${rollbackErrors.join('; ')}`);
            throw error;
          }
        }
        result.counts.imagesCopied += changedImages.length;
        if (noteChanged) result.counts.restored += item.restored;
        item.status = status;
        item.imagesCopied = changedImages.length;
        if (dryRun) item.message = 'Preview only; no files were changed';
      } catch (error) {
        item.status = error.code === 'CONFLICT' ? 'conflict' : error.code === 'MISSING' ? 'missing' : 'failed';
        item.message = error.message;
      }
      await progress(item);
    }
    return result;
  }

  const api = {sync};
  root.MineruSyncEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
