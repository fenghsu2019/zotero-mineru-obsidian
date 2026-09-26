"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const core = require("../src/core.js");

// The adapter runs against an in-memory Zotero API and filesystem model. No
// user's library, preferences, caches or destination files are accessed.
function fixture() {
  const libraries = [
    { libraryID: 1, name: "Personal", libraryType: "user" },
    { libraryID: 4, name: "Team", libraryType: "group", groupID: 99 },
    { libraryID: 5, name: "Feed", libraryType: "feed" },
  ];
  const items = new Map(), collections = new Map(), loads = [], lookups = [];
  function item(id, options = {}) {
    const value = {
      id, key: `KEY${String(id).padStart(5, "0")}`, libraryID: options.libraryID || 1,
      deleted: !!options.deleted, parentItemID: options.parentItemID,
      attachmentContentType: options.pdf ? "application/pdf" : "text/html",
      attachmentFilename: `Paper ${id}.pdf`,
      isRegularItem: () => !options.attachment,
      isAttachment: () => !!options.attachment,
      loadDataType: async type => { loads.push(`item:${id}:${type}`); },
      getAttachments: () => options.attachments || [],
      getCollections: () => [...collections.values()].filter(c => c.items.includes(value)).map(c => c.id),
      getCreators: () => [{ firstName: "Example", lastName: "Author" }],
      getField: field => ({ title: `Paper ${id}`, date: "2024-02-03", DOI: "10.example/test", url: "https://example.test" })[field] || "",
    };
    items.set(id, value);
    return value;
  }
  function collection(id, key, name, itemIDs = [], options = {}) {
    const value = {
      id, key, name, libraryID: options.libraryID || 1,
      parentID: options.parentID, deleted: !!options.deleted,
      items: itemIDs.map(id => items.get(id)),
      loadDataType: async type => { loads.push(`collection:${id}:${type}`); },
      getChildItems: () => value.items,
      getChildCollections: () => [...collections.values()].filter(c => c.parentID === id),
    };
    collections.set(id, value);
    return value;
  }
  item(100, { attachments: [101, 102, 103] });
  item(101, { attachment: true, pdf: true, parentItemID: 100 });
  item(102, { attachment: true, parentItemID: 100 });
  item(103, { attachment: true, pdf: true, parentItemID: 100, deleted: true });
  item(110, { attachments: [111] });
  item(111, { attachment: true, pdf: true, parentItemID: 110 });
  item(120, { attachments: [121] });
  item(121, { attachment: true, parentItemID: 120 });
  item(130, { attachment: true, pdf: true });
  item(140, { deleted: true });
  item(200, { libraryID: 4, attachments: [201] });
  item(201, { libraryID: 4, attachment: true, pdf: true, parentItemID: 200 });
  collection(11, "ROOT0001", "Climate", [100, 120, 130, 140]);
  collection(12, "CHILD001", "Adaptation", [100, 110], { parentID: 11 });
  collection(13, "ROOT0002", "Infrastructure", [100, 120]);
  collection(14, "DELETED1", "Deleted", [], { deleted: true });
  collection(41, "ROOT0001", "Climate", [200], { libraryID: 4 });
  collection(51, "FEED0001", "Feed collection", [], { libraryID: 5 });

  const directories = new Set(["/vault", "/zotero", "/zotero/llm-for-zotero-mineru"]);
  let saved = "", syncOptions;
  const context = vm.createContext({
    Cc: { "@mozilla.org/file/local;1": { createInstance() {
      return {
        initWithPath(value) { this.path = value; }, normalize() { this.path = path.posix.normalize(this.path); },
        exists() { return directories.has(this.path); }, isDirectory() { return this.exists(); },
      };
    } } },
    Ci: { nsIFile: {} },
    PathUtils: { join: path.posix.join, parent: path.posix.dirname },
    Services: { uuid: { generateUUID: () => ({ toString: () => "test-rule-id" }) } },
    Zotero: {
      DataDirectory: { dir: "/zotero" },
      Prefs: { get: () => saved, set: (_key, value) => { saved = value; } },
      Libraries: { getAll: () => libraries, get: id => libraries.find(l => l.libraryID === id) },
      Collections: {
        get: id => collections.get(id),
        getByLibrary: id => [...collections.values()].filter(c => c.libraryID === id),
        getByLibraryAndKeyAsync: async (libraryID, key) => {
          lookups.push(`${libraryID}:${key}`);
          return [...collections.values()].find(c => c.libraryID === libraryID && c.key === key);
        },
      },
      Items: { getAsync: async ids => ids.map(id => items.get(id)) },
    },
    MineruSyncCore: core,
    MineruSyncEngine: { sync: async options => {
      syncOptions = options;
      return { counts: { failed: 0, conflicts: 0 }, warnings: [] };
    } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/zotero.js"), "utf8"), context);
  const baseRule = { id: "existing-rule", label: "Personal / Climate", libraryID: 1,
    collectionKey: "ROOT0001", vaultPath: "/vault", mode: "overwrite" };
  return { api: context.MineruObsidianPlugin, baseRule, collections, loads, lookups,
    setRules: rules => { saved = JSON.stringify(rules); }, getSaved: () => JSON.parse(saved),
    getSyncOptions: () => syncOptions };
}

// Convert VM objects to the host realm for strict structural assertions.
const plain = value => JSON.parse(JSON.stringify(value));
const selection = (collectionKey, libraryID = 1, label = collectionKey) => ({ libraryID, collectionKey, label });

test("legacy single-collection rules normalize without losing identity or defaults", () => {
  const { api, baseRule } = fixture();
  const rule = api.validateRule(baseRule);
  assert.deepEqual(plain(rule.collections), [selection("ROOT0001", 1, baseRule.label)]);
  assert.equal(rule.id, baseRule.id);
  assert.equal(rule.collectionKey, "ROOT0001");
  assert.equal(rule.libraryID, 1);
  assert.equal(rule.includeSubcollections, true);
  assert.equal(rule.mode, "overwrite");
  assert.equal(rule.cacheRoot, "/zotero/llm-for-zotero-mineru");
});

test("multiple selections normalize numeric library IDs, deduplicate roots, and retain cross-library keys", () => {
  const { api, baseRule } = fixture();
  const rule = api.validateRule({ ...baseRule, label: "", collections: [
    selection("ROOT0001", "1", "Climate"), selection("ROOT0001", 1, "Duplicate"),
    selection("ROOT0002"), selection("ROOT0001", 4),
  ], includeSubcollections: false, intervalMinutes: 25 });
  assert.deepEqual(plain(rule.collections), [
    selection("ROOT0001", 1, "Climate"), selection("ROOT0002"), selection("ROOT0001", 4),
  ]);
  assert.equal(rule.label, "Climate 等 3 个 collection");
  assert.equal(rule.includeSubcollections, false);
  assert.equal(rule.intervalMinutes, 25);
});

test("an empty new selection never silently reuses a legacy collection", () => {
  const { api, baseRule } = fixture();
  for (const collections of [[], null, "ROOT0001"]) {
    assert.throws(() => api.validateRule({ ...baseRule, collections }), /至少勾选/);
  }
  for (const value of [null, selection("bad-key"), selection("ROOT0001", ""), selection("ROOT0001", 1.2)]) {
    assert.throws(() => api.validateRule({ ...baseRule, collections: [value] }), /无效.*collection/);
  }
});

test("saving a migrated rule updates the same task and preserves unrelated saved tasks", () => {
  const { api, baseRule, setRules, getSaved } = fixture();
  const unrelated = { ...baseRule, id: "another-task" };
  setRules([baseRule, unrelated]);
  api.saveRule({ ...baseRule, collections: [selection("ROOT0001"), selection("ROOT0002")] });
  const saved = getSaved();
  assert.equal(saved.length, 2);
  assert.equal(saved[0].id, baseRule.id);
  assert.equal(saved[0].collections.length, 2);
  assert.deepEqual(saved[1], unrelated);
});

test("collection rows expose library, collection, path and depth while hiding feeds and deleted collections", async () => {
  const { api } = fixture();
  const rows = plain(await api.listCollections());
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.find(row => row.collectionKey === "CHILD001"), {
    libraryID: 1, collectionKey: "CHILD001", libraryName: "Personal", name: "Adaptation",
    path: "Climate / Adaptation", depth: 1, label: "Personal / Climate / Adaptation",
  });
  assert.equal(rows.filter(row => row.collectionKey === "ROOT0001").length, 2);
});

test("legacy collection traversal keeps metadata and correctly excludes deleted and non-PDF attachments", async () => {
  const { api, baseRule } = fixture();
  const result = await api.collectAttachments(baseRule);
  assert.deepEqual(plain(result.attachments.map(a => a.id)), [101, 111, 130]);
  assert.equal(result.collectionCount, 2);
  assert.equal(result.parentCount, 3);
  assert.equal(result.withoutPDF, 1);
  assert.equal(result.attachments[0].metadata.zoteroURI, "zotero://select/library/items/KEY00100");
  assert.equal(result.attachments[0].metadata.parentItemID, 100);
  assert.equal(result.attachments[0].metadata.attachmentItemID, 101);
  assert.deepEqual(plain(result.attachments[0].metadata.authors), ["Example Author"]);
});

test("multiple roots without descendants include their union once and omit unselected child collections", async () => {
  const { api, baseRule } = fixture();
  const result = await api.collectAttachments({ ...baseRule,
    collections: [selection("ROOT0001"), selection("ROOT0002")], includeSubcollections: false });
  assert.deepEqual(plain(result.attachments.map(a => a.id)), [101, 130]);
  assert.equal(result.collectionCount, 2);
  assert.equal(result.parentCount, 2);
  assert.equal(result.withoutPDF, 1);
});

test("overlapping parent/child selections and duplicate roots are visited once across the entire task", async () => {
  const { api, baseRule, loads, lookups } = fixture();
  const result = await api.collectAttachments({ ...baseRule, collections: [
    selection("CHILD001"), selection("ROOT0001"), selection("ROOT0002"), selection("ROOT0001"),
  ], includeSubcollections: true });
  assert.deepEqual(plain(result.attachments.map(a => a.id)), [101, 111, 130]);
  assert.equal(result.collectionCount, 3);
  assert.equal(result.parentCount, 3);
  assert.equal(result.withoutPDF, 1);
  assert.equal(loads.filter(value => value === "collection:12:childItems").length, 1);
  assert.equal(loads.filter(value => value === "item:100:childItems").length, 1);
  assert.equal(lookups.filter(value => value === "1:ROOT0001").length, 1);
});

test("equal collection keys in distinct libraries remain independent", async () => {
  const { api, baseRule } = fixture();
  const result = await api.collectAttachments({ ...baseRule,
    collections: [selection("ROOT0001"), selection("ROOT0001", 4)], includeSubcollections: false });
  assert.deepEqual(plain(result.attachments.map(a => a.id)), [101, 130, 201]);
  assert.equal(result.collectionCount, 2);
  assert.equal(result.parentCount, 3);
  const group = result.attachments.find(a => a.libraryID === 4);
  assert.equal(group.metadata.zoteroURI, "zotero://select/groups/99/items/KEY00200");
});

test("a missing or deleted selected root fails explicitly before collecting partial data", async () => {
  for (const key of ["DELETED1", "MISSING1"]) {
    const { api, baseRule, loads } = fixture();
    await assert.rejects(api.collectAttachments({ ...baseRule, collections: [
      selection("ROOT0001"), selection(key, 1, "Unavailable collection"),
    ] }), /collection 已不存在：Unavailable collection/);
    assert.equal(loads.length, 0);
  }
});

test("runRule sends one deduplicated batch to the sync engine and reports unique coverage", async () => {
  const { api, baseRule, getSyncOptions } = fixture();
  const report = await api.runRule({ ...baseRule, collections: [
    selection("ROOT0001"), selection("CHILD001"), selection("ROOT0002"),
  ] }, true);
  assert.deepEqual(plain(report.coverage), {
    collections: 3, parentItems: 3, pdfAttachments: 3, itemsWithoutPDF: 1,
  });
  assert.equal(getSyncOptions().dryRun, true);
  assert.deepEqual(plain(getSyncOptions().attachments.map(a => a.id)), [101, 111, 130]);
  assert.equal(report.rule.collections.length, 3);
});
