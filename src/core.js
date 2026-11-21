/* Shared pure rendering logic. No Zotero, Node, filesystem, or network dependency. */
(function (root) {
  "use strict";

  function fail(message) { throw new Error(message); }

  function safeRelativePath(value) {
    if (typeof value !== "string" || !value || /[\\\x00-\x1f\x7f]/.test(value) || /^[\/]/.test(value)) {
      fail("Unsafe relative path: " + String(value));
    }
    const parts = value.split("/");
    if (parts.some(part => part === ".." || /[:?#]/.test(part))) fail("Unsafe relative path: " + value);
    const clean = parts.filter(part => part && part !== ".");
    if (!clean.length) fail("Empty relative path");
    return clean.join("/");
  }

  function safeFilename(value) {
    let name = String(value || "paper").normalize("NFC").replace(/\.pdf$/i, "");
    name = name.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "_").replace(/[. ]+$/g, "").trim();
    if (!name || /^\.+$/.test(name)) name = "paper";
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = "_" + name;
    // A conservative Unicode limit leaves room for stable item keys and extensions.
    return Array.from(name).slice(0, 100).join("").replace(/[. ]+$/g, "") || "paper";
  }

  function encodePath(value) {
    return value.split("/").map(part => encodeURIComponent(part).replace(/[!'()*]/g,
      char => "%" + char.charCodeAt(0).toString(16).toUpperCase())).join("/");
  }

  function prefixPath(value) {
    if (typeof value !== "string" || !value || /[\\\x00-\x1f\x7f:?#]/.test(value) || value.startsWith("/")) {
      fail("imagePrefix must be a relative directory");
    }
    const parts = value.split("/").filter(part => part && part !== ".");
    return parts.join("/") || ".";
  }

  function decodePath(value) {
    let result;
    try { result = decodeURIComponent(value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1")); }
    catch (_) { fail("Invalid image URL encoding: " + value); }
    return result;
  }

  function htmlDecode(value) {
    return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (whole, entity) => {
      if (entity[0] === "#") {
        const numeric = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        if (!Number.isInteger(numeric) || numeric < 0 || numeric > 0x10ffff) fail("Invalid HTML image entity");
        return String.fromCodePoint(numeric);
      }
      return ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" })[entity.toLowerCase()];
    });
  }

  function protectedRanges(text) {
    const ranges = [];
    const lines = text.match(/[^\n]*(?:\n|$)/g) || [];
    let offset = 0, fence = null;
    for (const line of lines) {
      const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*?)(?:\r?\n)?$/);
      if (!fence && match) fence = { start: offset, char: match[1][0], length: match[1].length };
      else if (fence && match && match[1][0] === fence.char && match[1].length >= fence.length && !match[2].trim()) {
        ranges.push([fence.start, offset + line.length]); fence = null;
      } else if (!fence && /^(?: {4}|\t)/.test(line)) ranges.push([offset, offset + line.length]);
      offset += line.length;
    }
    if (fence) ranges.push([fence.start, text.length]);
    for (const match of text.matchAll(/<!--[\s\S]*?(?:-->|$)/g)) ranges.push([match.index, match.index + match[0].length]);
    const inside = position => ranges.some(range => range[0] <= position && position < range[1]);
    for (const match of text.matchAll(/`+/g)) {
      if (inside(match.index)) continue;
      let end = match.index + match[0].length;
      while ((end = text.indexOf(match[0], end)) !== -1) {
        if (text[end - 1] !== "`" && text[end + match[0].length] !== "`") break;
        end += match[0].length;
      }
      if (end !== -1) ranges.push([match.index, end + match[0].length]);
    }
    return ranges;
  }

  function closingBracket(text, start, open, close) {
    let depth = 1;
    for (let index = start + 1; index < text.length; index++) {
      if (text[index] === "\\") { index++; continue; }
      if (text[index] === open) depth++;
      else if (text[index] === close && --depth === 0) return index;
    }
    return -1;
  }

  function linkEnd(text, start) {
    let depth = 1, quote = null, angle = false;
    for (let index = start + 1; index < text.length; index++) {
      const char = text[index];
      if (char === "\\") { index++; continue; }
      if (quote) { if (char === quote) quote = null; continue; }
      if (angle) { if (char === ">") angle = false; continue; }
      if (char === "<" && !text.slice(start + 1, index).trim()) { angle = true; continue; }
      if ((char === '"' || char === "'") && /\s/.test(text[index - 1])) { quote = char; continue; }
      if (char === "(") depth++;
      else if (char === ")" && --depth === 0) return index;
    }
    return -1;
  }

  function destination(text, start, end) {
    const body = text.slice(start, end);
    const lead = body.match(/^\s*/)[0].length;
    if (body[lead] === "<") {
      const finish = body.indexOf(">", lead + 1);
      if (finish < 0) fail("Unclosed angle-bracket image destination");
      return { start: start + lead + 1, end: start + finish, value: body.slice(lead + 1, finish) };
    }
    let cleanEnd = body.length - body.match(/\s*$/)[0].length;
    const title = body.slice(lead, cleanEnd).match(/\s+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\))$/);
    if (title) cleanEnd = lead + title.index;
    if (cleanEnd <= lead) fail("Empty image destination");
    return { start: start + lead, end: start + cleanEnd, value: body.slice(lead, cleanEnd) };
  }

  function scanImages(text) {
    const ranges = protectedRanges(text);
    const isProtected = index => ranges.some(([start, end]) => start <= index && index < end);
    const references = [];
    const definitions = new Map();
    const labelKey = value => value.trim().replace(/\s+/g, " ").toLowerCase();
    for (const match of text.matchAll(/^ {0,3}\[([^\]\n]+)\]:[ \t]*(.+)$/gm)) {
      if (isProtected(match.index)) continue;
      const start = match.index + match[0].length - match[2].length;
      const key = labelKey(match[1]);
      if (!definitions.has(key)) definitions.set(key, destination(text, start, start + match[2].length));
    }
    for (let index = 0; index < text.length - 2; index++) {
      if (text[index] !== "!" || text[index + 1] !== "[" || isProtected(index)) continue;
      let slashes = 0;
      for (let prev = index - 1; prev >= 0 && text[prev] === "\\"; prev--) slashes++;
      if (slashes % 2) continue;
      const altEnd = closingBracket(text, index + 1, "[", "]");
      if (altEnd < 0) continue;
      if (text[altEnd + 1] === "(") {
        const end = linkEnd(text, altEnd + 1);
        if (end < 0) fail("Unclosed Markdown image link at character " + index);
        references.push({ ...destination(text, altEnd + 2, end), kind: "markdown", fullStart: index, fullEnd: end + 1 });
        index = end;
      } else {
        let key = text.slice(index + 2, altEnd), end = altEnd;
        if (text[altEnd + 1] === "[") {
          end = closingBracket(text, altEnd + 1, "[", "]");
          if (end < 0) continue;
          key = text.slice(altEnd + 2, end) || key;
        }
        const definition = definitions.get(labelKey(key));
        if (definition) references.push({ ...definition, kind: "reference", fullStart: index, fullEnd: end + 1 });
        index = end;
      }
    }
    for (const match of text.matchAll(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
      if (isProtected(match.index)) continue;
      if (/\ssrcset\s*=/i.test(match[0])) fail("HTML img srcset is unsupported; refusing to omit alternate image assets");
      const src = match[0].match(/\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      if (!src) fail("HTML img has no src attribute");
      const value = src[1] === undefined ? (src[2] === undefined ? src[3] : src[2]) : src[1];
      const valueOffset = src[0].length - value.length - (src[3] === undefined ? 1 : 0);
      const start = match.index + src.index + valueOffset;
      references.push({ start, end: start + value.length, value: htmlDecode(value), kind: "html", fullStart: match.index, fullEnd: match.index + match[0].length });
    }
    return references.sort((a, b) => a.start - b.start);
  }

  function imagePath(value, prefix, warnings) {
    if (/^https?:\/\//i.test(value)) {
      warnings.push("Remote image preserved without downloading: " + value);
      return null;
    }
    if (/^data:image\//i.test(value)) return null;
    let decoded = decodePath(value);
    if (prefix !== "." && decoded.startsWith(prefix + "/")) decoded = decoded.slice(prefix.length + 1);
    decoded = safeRelativePath(decoded);
    if (!decoded.startsWith("images/") || decoded === "images/") fail("Image is outside the MinerU images directory: " + value);
    return decoded;
  }

  function reliableFigureBlock(block) {
    return block.ambiguous !== true && ["high", "medium"].includes(block.confidence);
  }

  function restoreCaptionedFigures(text, blocks, existing) {
    const protectedPositions = protectedRanges(text);
    const captionOffsets = new Map();
    const captionPattern = /^(?:(?:(?:supplementary|extended data) +)?(?:fig(?:ure)?\.?|table)|[图表])[ \t]*[a-z]?\d+[a-z]?[ \t]*[.:：．。|｜—–][^\r\n]*/gimu;
    for (const match of text.matchAll(captionPattern)) {
      if (protectedPositions.some(([start, end]) => start <= match.index && match.index < end)) continue;
      captionOffsets.set(match[0], captionOffsets.has(match[0]) ? null : match.index);
    }
    const claims = new Map();
    const candidates = [];
    for (const block of blocks) {
      if (!Array.isArray(block.captionHints)) continue;
      const captions = new Set(block.captionHints.filter(caption => captionOffsets.has(caption)));
      for (const caption of captions) claims.set(caption, (claims.get(caption) || 0) + 1);
      if (!reliableFigureBlock(block) || block.imagePaths.length !== 1 || captions.size !== 1) continue;
      const [caption] = captions;
      const offset = captionOffsets.get(caption);
      const [path] = block.imagePaths;
      if (offset !== null && !existing.has(path)) candidates.push({ caption, offset, path });
    }
    const insertions = candidates.filter(({ caption }) => claims.get(caption) === 1)
      .sort((left, right) => right.offset - left.offset);
    for (const { offset, path } of insertions) {
      const before = text.slice(0, offset);
      const leading = before && !before.endsWith("\n\n") ? "\n" : "";
      text = before + leading + "![](" + encodePath(path) + ")\n\n" + text.slice(offset);
    }
    return { text, restoredCount: insertions.length, needsMarkerSpacing: false };
  }

  function restoreManifest(text, manifest, references, prefix, restoreImages, warnings, filenameCaseChanged) {
    if (!manifest) return { text, restoredCount: 0, needsMarkerSpacing: false };
    if (typeof manifest !== "object" || Array.isArray(manifest)) fail("Invalid MinerU manifest");
    const existing = new Set(references.map(ref => imagePath(ref.value, prefix, [])).filter(Boolean));
    const blocks = manifest.figureBlocks;
    if (blocks !== undefined && !Array.isArray(blocks)) fail("manifest.figureBlocks must be an array");
    if (!blocks || !blocks.length) {
      if (!existing.size && Array.isArray(manifest.allFigures) && manifest.allFigures.length) {
        fail("Manifest lists figures but has no reliable figureBlocks or Markdown image references");
      }
      return { text, restoredCount: 0, needsMarkerSpacing: false };
    }
    const normalizedBlocks = blocks.map(block => {
      if (!block || typeof block !== "object" || !Array.isArray(block.imagePaths) || !block.imagePaths.length) {
        fail("Malformed manifest figure block or missing imagePaths");
      }
      const paths = block.imagePaths.map(path => {
        const safe = safeRelativePath(path);
        if (!safe.startsWith("images/")) fail("Unsafe manifest image path: " + path);
        return safe;
      });
      return { ...block, imagePaths: paths };
    });
    const missing = normalizedBlocks.filter(block => block.imagePaths.some(path => !existing.has(path)));
    if (!missing.length) return { text, restoredCount: 0, needsMarkerSpacing: false };
    const original = text;
    function restoreWithoutOffsets(reason) {
      const result = restoreImages && (manifest.totalChars === original.length || manifest.totalChars === Array.from(original).length)
        ? restoreCaptionedFigures(original, normalizedBlocks, existing)
        : { text: original, restoredCount: 0, needsMarkerSpacing: false };
      warnings.push("Skipped MinerU figure restoration from offsets because " + reason + ". " +
        "Restored " + result.restoredCount + " image references from unique captions.");
      return result;
    }
    if (missing.some(block => !reliableFigureBlock(block))) {
      // Offsets refer to the pre-strip Markdown, including preceding markers and
      // line breaks. After an uncertain block, a unique caption is a safer anchor.
      return restoreWithoutOffsets("at least one missing block is ambiguous, low-confidence, or unclassified");
    }
    if (!restoreImages) fail("Manifest images are missing and automatic restoration is disabled");
    if (existing.size) fail("Markdown contains only some manifest images; refusing ambiguous partial restoration");
    const codepoints = Array.from(text).length;
    let mode;
    if (manifest.totalChars === text.length) mode = "utf16";
    else if (manifest.totalChars === codepoints) mode = "codepoint";
    else fail("Manifest totalChars does not match full.md; refusing stale figure offsets");
    const count = value => mode === "utf16" ? value.length : Array.from(value).length;
    const insertions = missing.sort((a, b) => a.markdownStart - b.markdownStart);
    const seenStarts = new Set();
    const offsetWarnings = [];
    let restoredCount = 0;
    // Offsets describe the progressively restored string. markdownEnd may include
    // a caption, so never remove markdownEnd - markdownStart characters.
    for (const block of insertions) {
      if (!Number.isInteger(block.markdownStart) || !Number.isInteger(block.markdownEnd) || block.markdownStart < 0 || block.markdownEnd < block.markdownStart) {
        fail("Invalid manifest figure offsets");
      }
      if (seenStarts.has(block.markdownStart)) fail("Multiple manifest blocks share an insertion position");
      seenStarts.add(block.markdownStart);
      if (block.markdownStart > count(text)) {
        const gap = block.markdownStart - count(text);
        // MinerU can trim trailing line breaks while retaining pre-trim offsets.
        // Match the existing resolver's bounded whitespace-only repair.
        if (gap > 64) fail("Manifest insertion offset exceeds progressively restored Markdown length by more than 64 characters");
        text += "\n".repeat(gap);
        offsetWarnings.push("Padded " + gap + " trailing line breaks to match a MinerU figure offset");
      }
      let offset = block.markdownStart;
      if (mode === "codepoint") offset = Array.from(text).slice(0, offset).join("").length;
      if (offset > 0 && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset])) {
        fail("Manifest insertion offset splits a Unicode surrogate pair");
      }
      // Check for shifted offsets in newly accepted caches without regenerating
      // previously synced notes whose filenames already matched.
      if (filenameCaseChanged && offset > 0 && offset < text.length &&
          /[\p{L}\p{N}]{2}/u.test(text.slice(offset - 1, offset + 1))) {
        return restoreWithoutOffsets("an offset in the case-renamed cache falls inside a word");
      }
      if (protectedRanges(text).some(([start, end]) => start < offset && offset < end)) fail("Manifest would insert an image inside a code block");
      const marker = block.imagePaths.map(path => "![](" + path + ")").join("\n\n");
      text = text.slice(0, offset) + marker + text.slice(offset);
      restoredCount += block.imagePaths.length;
    }
    warnings.push(...offsetWarnings, "Restored " + restoredCount + " image references from validated manifest offsets (" + mode + ")");
    return { text, restoredCount, needsMarkerSpacing: true };
  }

  function frontmatter(metadata, sourceFilename) {
    const fields = {
      mineru_sync: 1,
      type: "literature",
      source: "zotero-mineru",
      title: String(metadata.title || ""),
      authors: (metadata.authors || []).map(String),
      year: String(metadata.year || ""),
      doi: String(metadata.doi || ""),
      url: String(metadata.url || ""),
      zotero_item_key: String(metadata.itemKey || ""),
      zotero_attachment_key: String(metadata.attachmentKey || ""),
      zotero_library_id: metadata.libraryID == null ? null : metadata.libraryID,
      zotero_parent_item_id: metadata.parentItemID == null ? null : metadata.parentItemID,
      zotero_attachment_item_id: metadata.attachmentItemID == null ? null : metadata.attachmentItemID,
      zotero_uri: String(metadata.zoteroURI || ""),
      source_file: String(sourceFilename || ""),
      collections: Array.from(new Set((metadata.collections || []).map(String))).sort(),
      tags: ["zotero", "mineru"]
    };
    return "---\n" + Object.entries(fields).map(([key, value]) => key + ": " + JSON.stringify(value)).join("\n") + "\n---\n\n";
  }

  function render({ markdown, manifest = null, sourceFilename = "", attachmentFilename = "", metadata = {}, imagePrefix, restoreImages = true }) {
    if (typeof markdown !== "string") fail("markdown must be a string");
    const sourceName = sourceFilename ? sourceFilename.normalize("NFC") : "";
    const attachmentName = attachmentFilename ? attachmentFilename.normalize("NFC") : "";
    const filenameCaseChanged = !!(sourceName && attachmentName && sourceName !== attachmentName);
    if (filenameCaseChanged && sourceName.toLowerCase() !== attachmentName.toLowerCase()) {
      fail("MinerU source filename does not match the selected PDF attachment");
    }
    const prefix = prefixPath(imagePrefix);
    const warnings = [];
    let body = markdown.replace(/^---\nmineru_sync: 1\n[\s\S]*?\n---\n\n/, "");
    const initial = scanImages(body);
    const restored = restoreManifest(body, manifest, initial, prefix, restoreImages, warnings, filenameCaseChanged);
    body = restored.text;
    let refs = scanImages(body);
    // Recovered markers must occupy Markdown blocks, but only do this after all
    // progressive offsets have been consumed. Existing source layout is retained.
    if (restored.needsMarkerSpacing) {
      const blocks = refs.filter(ref => ref.kind === "markdown").sort((a, b) => b.fullStart - a.fullStart);
      for (const ref of blocks) {
        const before = body.slice(0, ref.fullStart), after = body.slice(ref.fullEnd);
        const leading = !before || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
        const trailing = !after || after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
        body = before + leading + body.slice(ref.fullStart, ref.fullEnd) + trailing + after;
      }
      refs = scanImages(body);
    }
    const paths = new Set(), edits = new Map();
    let referenceCount = 0;
    for (const ref of refs) {
      const path = imagePath(ref.value, prefix, warnings);
      if (!path) continue;
      paths.add(path); referenceCount++;
      edits.set(ref.start, { ...ref, replacement: encodePath((prefix === "." ? "" : prefix + "/") + path) });
    }
    for (const edit of Array.from(edits.values()).sort((a, b) => b.start - a.start)) body = body.slice(0, edit.start) + edit.replacement + body.slice(edit.end);
    return { text: frontmatter(metadata, sourceFilename || attachmentFilename) + body, imagePaths: Array.from(paths).sort(), referenceCount, restoredCount: restored.restoredCount, warnings: Array.from(new Set(warnings)) };
  }

  const api = { render, safeRelativePath, safeFilename };
  root.MineruSyncCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
