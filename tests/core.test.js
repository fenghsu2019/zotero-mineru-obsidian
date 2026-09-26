"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const core = require("../src/core.js");

const defaults = {
  imagePrefix: "./assets/ABC123",
  metadata: { title: "A paper", authors: ["One Author"], itemKey: "PARENT1", attachmentKey: "ABC123", libraryID: 1, parentItemID: 50, attachmentItemID: 60 },
  sourceFilename: "paper.pdf",
  attachmentFilename: "paper.pdf"
};
const render = (markdown, extra = {}) => core.render({ ...defaults, markdown, ...extra });
const body = text => text.replace(/^---\n[\s\S]*?\n---\n\n/, "");
const block = (start, image, extra = {}) => ({ markdownStart: start, markdownEnd: start + 500, imagePaths: [image], confidence: "high", ambiguous: false, ...extra });

test("loads as a Zotero subscript without Node globals", () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/core.js"), "utf8"), context);
  assert.equal(typeof context.MineruSyncCore.render, "function");
});

test("rewrites referenced images only; preserves surrounding prose, alt and titles", () => {
  const source = '# Title\n\nText ![alt [nested] \\]](images/figure (1).png "Title (a)") after.\n![second](<images/with space.png> \'Caption\')\n';
  const result = render(source);
  assert.deepEqual(result.imagePaths, ["images/figure (1).png", "images/with space.png"]);
  assert.equal(result.referenceCount, 2);
  assert.equal(result.restoredCount, 0);
  assert.equal(body(result.text), source.replace("images/figure (1).png", "assets/ABC123/images/figure%20%281%29.png").replace("images/with space.png", "assets/ABC123/images/with%20space.png"));
});

test("deduplicates copied paths but reports every local reference", () => {
  const result = render("![](images/a.png) ![](images/a.png)");
  assert.deepEqual(result.imagePaths, ["images/a.png"]);
  assert.equal(result.referenceCount, 2);
});

test("HTML preserves attributes and supports unquoted src and HTML entities", () => {
  const result = render('<IMG class="x" SRC="images/a &amp; b.png" alt="a > b">\n<img src=images/c.png width=100>');
  assert.deepEqual(result.imagePaths, ["images/a & b.png", "images/c.png"]);
  assert.match(result.text, /SRC="assets\/ABC123\/images\/a%20%26%20b.png" alt="a > b"/);
  assert.match(result.text, /src=assets\/ABC123\/images\/c.png width=100/);
  assert.throws(() => render('<img src="images/a.png" srcset="images/b.png 2x">'), /srcset/);
});

test("reference definitions are rewritten once and keep their titles", () => {
  const source = '![Figure][Fig] and ![Fig][]\n\n[Fig]: <images/a b.png> "Figure title"\n';
  const result = render(source);
  assert.deepEqual(result.imagePaths, ["images/a b.png"]);
  assert.equal(result.referenceCount, 2);
  assert.match(result.text, /\[Fig\]: <assets\/ABC123\/images\/a%20b.png> "Figure title"/);
});

test("ignores code fences, inline code, indented code, HTML comments and escaped markers", () => {
  const source = '```md\n![](images/no.png)\n```\n`![](images/no2.png)`\n    ![](images/no3.png)\n<!-- ![](images/no4.png) -->\n\\![](images/no5.png)\n![](images/yes.png)';
  const result = render(source);
  assert.deepEqual(result.imagePaths, ["images/yes.png"]);
  assert.equal(body(result.text), source.replace("images/yes.png", "assets/ABC123/images/yes.png"));
});

test("rejects local traversal, absolute paths, file URLs and unsupported local layouts", () => {
  for (const unsafe of ["images/../secret.png", "images/%2e%2e/secret.png", "images/%2F../../secret.png", "/tmp/x.png", "file:///tmp/x.png", "C:/temp/x.png", "images/\\../x.png", "//server/a.png", "assets/a.png", "images/a.png#fragment"]) {
    assert.throws(() => render(`![](${unsafe})`), /Unsafe|outside/);
  }
  assert.throws(() => render('![](images/a.png'), /Unclosed/);
  assert.throws(() => render('![](images/a.png)', { imagePrefix: "file:///tmp" }), /relative directory/);
});

test("safeRelativePath normalizes only safe dot segments and filenames remain portable", () => {
  assert.equal(core.safeRelativePath("./images//a.png"), "images/a.png");
  assert.throws(() => core.safeRelativePath("."), /Empty/);
  assert.throws(() => core.safeRelativePath("images/../a"), /Unsafe/);
  assert.equal(core.safeFilename('A: study? of <heat>.PDF'), "A_ study_ of _heat_");
  assert.equal(core.safeFilename("CON.pdf"), "_CON");
  assert.equal(core.safeFilename(".."), "paper");
  assert.ok(Array.from(core.safeFilename("文".repeat(300))).length <= 100);
});

test("nested relative destination is URL encoded while source paths remain decoded", () => {
  const result = render("![](images/a%20b.png)", { imagePrefix: "../assets/论文 ABC" });
  assert.deepEqual(result.imagePaths, ["images/a b.png"]);
  assert.match(result.text, /\.\.\/assets\/%E8%AE%BA%E6%96%87%20ABC\/images\/a%20b.png/);
});

test("remote and embedded images are preserved without filesystem copying", () => {
  const source = "![](https://example.test/a.png) ![](data:image/png;base64,YQ==)";
  const result = render(source);
  assert.equal(body(result.text), source);
  assert.deepEqual(result.imagePaths, []);
  assert.equal(result.warnings.length, 1);
});

test("stable frontmatter escapes strings and collections are deterministic", () => {
  const metadata = { ...defaults.metadata, title: 'Title: "heat"\nsecond line', authors: ['A: [person]', 'O\'Brien'], collections: ["B", "A", "B"], zoteroURI: "zotero://select/library/items/PARENT1" };
  const result = render("Original body\n", { metadata });
  const title = result.text.split("\n").find(line => line.startsWith("title: ")).slice(7);
  assert.equal(JSON.parse(title), metadata.title);
  assert.match(result.text, /collections: \["A","B"\]/);
  assert.match(result.text, /zotero_parent_item_id: 50/);
  assert.match(result.text, /zotero_attachment_item_id: 60/);
  assert.equal(body(result.text), "Original body\n");
  assert.equal(render("Original body\n", { metadata }).text, result.text);
});

test("rendering exported content again is idempotent", () => {
  const first = render("Text\n![](images/a.png)\n");
  const second = render(first.text);
  assert.equal(second.text, first.text);
  assert.deepEqual(second.imagePaths, first.imagePaths);
  assert.equal(second.referenceCount, 1);
});

test("progressive restoration preserves captions rather than deleting manifest span", () => {
  const source = "Intro\n\nCaption one.\n\nCaption two.\nTail";
  const firstMarker = "![](images/a.png)";
  const firstStart = source.indexOf("Caption one");
  const secondStart = source.indexOf("Caption two") + firstMarker.length;
  const manifest = { totalChars: source.length, figureBlocks: [block(firstStart, "images/a.png"), block(secondStart, "images/b.png")] };
  const result = render(source, { manifest });
  assert.equal(result.restoredCount, 2);
  assert.deepEqual(result.imagePaths, ["images/a.png", "images/b.png"]);
  assert.equal(body(result.text), "Intro\n\n![](assets/ABC123/images/a.png)\n\nCaption one.\n\n![](assets/ABC123/images/b.png)\n\nCaption two.\nTail");
  assert.equal(render(result.text, { manifest }).text, result.text);
});

test("restoration supports codepoint and UTF-16 manifest offsets", () => {
  const source = "😀 Intro\nCaption";
  for (const codepoint of [false, true]) {
    const start = source.indexOf("Caption") - (codepoint ? 1 : 0);
    const manifest = { totalChars: source.length - (codepoint ? 1 : 0), figureBlocks: [block(start, "images/a.png")] };
    const result = render(source, { manifest });
    assert.equal(body(result.text), "😀 Intro\n\n![](assets/ABC123/images/a.png)\n\nCaption");
  }
});

test("bounded trailing whitespace repair matches the existing MinerU resolver", () => {
  const source = "Caption";
  const result = render(source, { manifest: { totalChars: source.length, figureBlocks: [block(source.length + 8, "images/a.png")] } });
  assert.equal(body(result.text), source + "\n".repeat(8) + "![](assets/ABC123/images/a.png)");
  assert.ok(result.warnings.some(message => message.includes("8 trailing line breaks")));
});

test("restoration rejects stale, ambiguous, low-confidence and unsupported manifests", () => {
  const source = "Caption";
  const manifests = [
    { totalChars: 100, figureBlocks: [block(0, "images/a.png")] },
    { totalChars: source.length, figureBlocks: [block(0, "images/a.png", { ambiguous: true })] },
    { totalChars: source.length, figureBlocks: [block(0, "images/a.png", { confidence: "low" })] },
    { totalChars: source.length, figureBlocks: [block(0, "images/../a.png")] },
    { totalChars: source.length, figureBlocks: [block(500, "images/a.png")] },
    { totalChars: source.length, figureBlocks: [block(0, "images/a.png"), block(0, "images/b.png")] },
    { totalChars: source.length, allFigures: ["images/a.png"] }
  ];
  for (const manifest of manifests) assert.throws(() => render(source, { manifest }));
  assert.throws(() => render(source, { manifest: { totalChars: source.length, figureBlocks: [block(0, "images/a.png")] }, restoreImages: false }), /disabled/);
});

test("already present figure markers need no restoration, even if their manifest location is ambiguous", () => {
  const result = render("![](images/a.png)", { manifest: { figureBlocks: [block(0, "images/a.png", { confidence: "low", ambiguous: true })] } });
  assert.equal(result.restoredCount, 0);
  assert.equal(result.referenceCount, 1);
});

test("does not silently export partially missing image markers", () => {
  assert.throws(() => render("![](images/a.png)", { manifest: { figureBlocks: [block(0, "images/a.png"), block(50, "images/b.png")] } }), /partial restoration/);
});

test("attachment source filename mismatch fails before export", () => {
  assert.throws(() => render("Text", { sourceFilename: "another.pdf" }), /filename does not match/);
});
