(function (global) {
  "use strict";
  const PREF = "extensions.mineru-obsidian-sync.rules";
  const MENU_ID = "mineru-obsidian-sync-menu";
  const CONTEXT_ID = "mineru-obsidian-sync-context";
  let timer, notifier, running = null, stopped = true, dialog;
  let lastRuns = new Map();
  const windows = new Set();

  function file(path) {
    const value = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    value.initWithPath(path);
    return value;
  }
  function contained(root, path) {
    const separator = root.includes("\\") ? "\\" : "/";
    const prefix = root.endsWith(separator) ? root : root + separator;
    return path === root || path.startsWith(prefix);
  }
  function canonical(path) {
    const value = file(path);
    value.normalize();
    return value.path;
  }
  async function assertSafe(root, path) {
    if (!contained(root, path)) throw new Error("路径超出指定目录：" + path);
    let part = file(path);
    const rootFile = file(root);
    while (part && contained(root, part.path)) {
      let symlink = false;
      try { symlink = part.isSymlink(); }
      catch (error) {
        if (error.name !== "NS_ERROR_FILE_NOT_FOUND" && error.name !== "NS_ERROR_FILE_TARGET_DOES_NOT_EXIST") throw error;
      }
      if (symlink) throw new Error("不支持符号链接路径：" + part.path);
      if (part.path === rootFile.path) break;
      part = part.parent;
    }
    // Resolve existing ancestors as a second containment check.
    part = file(path);
    while (!part.exists()) part = part.parent;
    if (!contained(canonical(root), canonical(part.path))) {
      throw new Error("路径解析后超出指定目录：" + path);
    }
  }

  function makeIO(vaultPath) {
    async function atomic(path, contents, text) {
      await assertSafe(vaultPath, path);
      const parent = PathUtils.parent(path);
      await IOUtils.makeDirectory(parent, { createAncestors: true, ignoreExisting: true });
      const tmpPath = path + ".tmp-" + Services.uuid.generateUUID().toString().replace(/[{}]/g, "");
      try {
        const options = { tmpPath, mode: "overwrite" };
        if (text) await IOUtils.writeUTF8(path, contents, options);
        else await IOUtils.write(path, contents, options);
      } finally {
        await IOUtils.remove(tmpPath, { ignoreAbsent: true });
      }
    }
    return {
      join: (...parts) => PathUtils.join(...parts),
      dirname: path => PathUtils.parent(path),
      exists: path => IOUtils.exists(path),
      readText: path => IOUtils.readUTF8(path),
      readBytes: path => IOUtils.read(path),
      writeText: (path, text) => atomic(path, text, true),
      writeBytes: (path, bytes) => atomic(path, bytes, false),
      mkdir: async path => {
        await assertSafe(vaultPath, path);
        await IOUtils.makeDirectory(path, { createAncestors: true, ignoreExisting: true });
      },
      assertSafe,
    };
  }

  function getRules() {
    const raw = Zotero.Prefs.get(PREF, true);
    if (!raw) return [];
    const rules = JSON.parse(raw);
    if (!Array.isArray(rules)) throw new Error("同步配置格式错误，未执行同步。");
    return rules;
  }
  function saveRule(rule) {
    const normalized = validateRule(rule);
    const rules = getRules();
    const index = rules.findIndex(value => value.id === normalized.id);
    if (index < 0) rules.push(normalized); else rules[index] = normalized;
    Zotero.Prefs.set(PREF, JSON.stringify(rules), true);
    lastRuns.set(normalized.id, Date.now());
    return normalized;
  }
  function collectionSelections(rule) {
    // An explicitly empty selection must not fall back to stale legacy fields.
    const input = rule.collections === undefined
      ? [{ libraryID: rule.libraryID, collectionKey: rule.collectionKey, label: rule.label }]
      : rule.collections;
    if (!Array.isArray(input) || !input.length) throw new Error("请至少勾选一个 Zotero collection。");
    const selections = new Map();
    for (const value of input) {
      const libraryID = Number(value?.libraryID);
      const collectionKey = value?.collectionKey;
      if (!Number.isSafeInteger(libraryID) || libraryID < 1 || !/^[A-Z0-9]{8}$/.test(collectionKey || "")) {
        throw new Error("无效的 Zotero collection 配置，请重新勾选。");
      }
      const id = `${libraryID}:${collectionKey}`;
      if (!selections.has(id)) selections.set(id, { libraryID, collectionKey,
        label: typeof value.label === "string" && value.label.trim() ? value.label.trim() : collectionKey });
    }
    return [...selections.values()];
  }
  function validateRule(rule) {
    const collections = collectionSelections(rule);
    if (!rule.vaultPath?.trim()) throw new Error("请选择 Obsidian 仓库目录。");
    const root = file(rule.vaultPath.trim());
    if (!root.exists() || !root.isDirectory()) throw new Error("Obsidian 仓库路径必须是已存在的文件夹。");
    const vaultPath = canonical(root.path);
    const cacheInput = rule.cacheRoot?.trim() || PathUtils.join(Zotero.DataDirectory.dir, "llm-for-zotero-mineru");
    const cacheFile = file(cacheInput);
    if (!cacheFile.exists() || !cacheFile.isDirectory()) throw new Error("找不到 MinerU 缓存目录，请先在 LLM for Zotero 中完成 PDF 解析或指定正确缓存路径。");
    const cacheRoot = canonical(cacheInput);
    if (contained(vaultPath, cacheRoot) || contained(cacheRoot, vaultPath)
        || contained(canonical(Zotero.DataDirectory.dir), vaultPath)) {
      throw new Error("目标仓库不能与 Zotero 数据目录或 MinerU 缓存重叠。");
    }
    const papersDir = MineruSyncCore.safeRelativePath(rule.papersDir || "raw/papers");
    const assetsDir = MineruSyncCore.safeRelativePath(rule.assetsDir || "raw/assets/mineru");
    for (const value of [papersDir, assetsDir]) {
      if (value.split("/").some(part => part.startsWith("."))) throw new Error("输出子目录不能使用隐藏目录。");
    }
    if (papersDir === assetsDir || papersDir.startsWith(assetsDir + "/") || assetsDir.startsWith(papersDir + "/")) {
      throw new Error("正文目录和图片目录必须分开。");
    }
    if (!["overwrite", "protect"].includes(rule.mode)) throw new Error("无效的覆盖模式。");
    const intervalMinutes = Number(rule.intervalMinutes || 10);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) {
      throw new Error("同步间隔请输入 1–1440 分钟的整数。");
    }
    const label = rule.label || collections[0].label + (collections.length > 1 ? ` 等 ${collections.length} 个 collection` : "");
    return { id: rule.id || Services.uuid.generateUUID().toString(), label, collections,
      libraryID: collections[0].libraryID, collectionKey: collections[0].collectionKey, vaultPath,
      cacheRoot, papersDir, assetsDir, intervalMinutes, mode: rule.mode,
      includeSubcollections: rule.includeSubcollections !== false,
      restoreImages: rule.restoreImages !== false, autoSync: !!rule.autoSync };
  }

  async function listCollections() {
    const result = [];
    for (const library of Zotero.Libraries.getAll()) {
      if (library.libraryType === "feed") continue;
      const collections = Zotero.Collections.getByLibrary(library.libraryID, true);
      const byID = new Map(collections.map(c => [c.id, c]));
      for (const collection of collections) {
        if (collection.deleted) continue;
        const names = [collection.name];
        const visited = new Set([collection.id]);
        let parent = byID.get(collection.parentID);
        while (parent && !visited.has(parent.id)) {
          names.unshift(parent.name); visited.add(parent.id); parent = byID.get(parent.parentID);
        }
        result.push({ libraryID: library.libraryID, collectionKey: collection.key,
          libraryName: library.name, name: collection.name, path: names.join(" / "), depth: names.length - 1,
          label: library.name + " / " + names.join(" / ") });
      }
    }
    return result.sort((a, b) => a.label.localeCompare(b.label));
  }

  function selectedCollection() {
    const pane = Zotero.getMainWindow()?.ZoteroPane;
    if (!pane) return null;
    const collections = pane.getSelectedCollections ? pane.getSelectedCollections()
      : [pane.getSelectedCollection()].filter(Boolean);
    return collections.length === 1 ? collections[0] : null;
  }

  async function collectAttachments(rule) {
    const roots = [];
    for (const selection of collectionSelections(rule)) {
      const collection = await Zotero.Collections.getByLibraryAndKeyAsync(selection.libraryID, selection.collectionKey);
      if (!collection || collection.deleted) throw new Error("所配置的 collection 已不存在：" + selection.label);
      roots.push(collection);
    }
    const parents = new Map(), attachments = new Map(), visited = new Set();
    async function visit(current) {
      if (visited.has(current.id) || current.deleted) return;
      visited.add(current.id);
      await current.loadDataType("childItems");
      for (const item of current.getChildItems(false, false) || []) {
        if (item.deleted) continue;
        if (item.isRegularItem()) parents.set(item.id, item);
        else if (item.isAttachment() && !item.parentItemID) attachments.set(item.id, { attachment: item, parent: item });
      }
      if (rule.includeSubcollections !== false) {
        await current.loadDataType("childCollections");
        for (const child of current.getChildCollections(false, false) || []) await visit(child);
      }
    }
    for (const collection of roots) await visit(collection);
    for (const parent of parents.values()) {
      await parent.loadDataType("childItems");
      for (const attachment of await Zotero.Items.getAsync(parent.getAttachments(false))) {
        if (!attachment.deleted) attachments.set(attachment.id, { attachment, parent });
      }
    }
    const records = [];
    let withoutPDF = 0;
    const hasPDF = new Set();
    for (const { attachment, parent } of attachments.values()) {
      if (attachment.attachmentContentType !== "application/pdf") continue;
      hasPDF.add(parent.id);
      await parent.loadDataType("itemData");
      await parent.loadDataType("creators");
      await parent.loadDataType("collections");
      const membership = parent.getCollections().map(id => Zotero.Collections.get(id)).filter(Boolean)
        .map(c => c.name).sort();
      const library = Zotero.Libraries.get(attachment.libraryID);
      const uriPrefix = library.libraryType === "group" ? `groups/${library.groupID}` : "library";
      const metadata = {
        title: parent.getField("title"), authors: parent.getCreators().map(c => c.name || [c.firstName, c.lastName].filter(Boolean).join(" ")),
        year: (parent.getField("date").match(/\d{4}/) || [""])[0], doi: parent.getField("DOI"), url: parent.getField("url"),
        itemKey: parent.key, attachmentKey: attachment.key, libraryID: attachment.libraryID,
        parentItemID: parent.id, attachmentItemID: attachment.id,
        zoteroURI: `zotero://select/${uriPrefix}/items/${parent.key}`, collections: membership,
      };
      records.push({ id: attachment.id, key: attachment.key, parentID: parent.id,
        libraryID: attachment.libraryID, filename: attachment.attachmentFilename || (parent.getField("title") + ".pdf"), metadata });
    }
    for (const id of parents.keys()) if (!hasPDF.has(id)) withoutPDF++;
    return { attachments: records.sort((a, b) => a.id - b.id), parentCount: parents.size, withoutPDF, collectionCount: visited.size };
  }

  async function runRule(rule, dryRun = true, onProgress) {
    if (running) throw new Error("已有同步正在运行，请稍后再试。");
    const normalized = validateRule(rule);
    running = (async () => {
      const started = new Date().toISOString();
      const coverage = await collectAttachments(normalized);
      const result = await MineruSyncEngine.sync({ ...normalized, io: makeIO(normalized.vaultPath),
        attachments: coverage.attachments, dryRun, onProgress });
      const report = { started, finished: new Date().toISOString(), rule: normalized,
        coverage: { collections: coverage.collectionCount, parentItems: coverage.parentCount,
          pdfAttachments: coverage.attachments.length, itemsWithoutPDF: coverage.withoutPDF }, ...result };
      api.lastReport = report;
      if (!dryRun) {
        const io = makeIO(normalized.vaultPath);
        const reportPath = io.join(normalized.vaultPath, ".zotero-mineru-sync", "last-report.json");
        try { await io.writeText(reportPath, JSON.stringify(report, null, 2)); }
        catch (error) { report.warnings.push("无法保存运行报告：" + error.message); }
      }
      return report;
    })();
    try { return await running; }
    finally { running = null; lastRuns.set(normalized.id, Date.now()); }
  }

  async function tick() {
    if (stopped) return;
    try {
      for (const rule of getRules()) {
        if (stopped || running) break;
        if (!rule.autoSync || Date.now() - (lastRuns.get(rule.id) || 0) < Number(rule.intervalMinutes || 10) * 60000) continue;
        try {
          const report = await runRule(rule, false);
          if (report.counts.failed || report.counts.conflicts) {
            Zotero.debug("MinerU Obsidian Sync: " + JSON.stringify(report.counts));
            notify("自动同步有失败或冲突，请打开同步面板查看报告。");
          }
        } catch (error) {
          lastRuns.set(rule.id, Date.now());
          api.lastReport = { error: error.message, rule: rule.label };
          Zotero.logError(error);
          notify("同步失败：" + error.message);
        }
      }
    } finally {
      if (!stopped) timer = setTimeout(tick, 60000);
    }
  }

  function notify(message) {
    try {
      const progress = new Zotero.ProgressWindow();
      progress.changeHeadline("MinerU → Obsidian");
      progress.addDescription(message); progress.show(); progress.startCloseTimer(6000);
    } catch (error) { Zotero.logError(error); }
  }
  function openSettings() {
    if (dialog && !dialog.closed) { dialog.focus(); return; }
    dialog = Zotero.getMainWindow().openDialog("chrome://mineru-obsidian/content/settings.xhtml?v=" + encodeURIComponent(api.version),
      "mineru-obsidian-settings", "chrome,centerscreen,resizable,width=1020,height=830", { api });
  }
  function addWindow(window) {
    if (windows.has(window)) return;
    windows.add(window);
    for (const [parentID, id, label] of [["menu_ToolsPopup", MENU_ID, "MinerU → Obsidian 同步…"],
      ["zotero-collectionmenu", CONTEXT_ID, "MinerU → Obsidian 同步设置…"]]) {
      const parent = window.document.getElementById(parentID);
      if (!parent || window.document.getElementById(id)) continue;
      const item = window.document.createXULElement("menuitem");
      item.id = id; item.setAttribute("label", label);
      item.addEventListener("command", openSettings); parent.appendChild(item);
    }
  }
  function removeWindow(window) {
    for (const id of [MENU_ID, CONTEXT_ID]) window.document.getElementById(id)?.remove();
    windows.delete(window);
  }

  const api = {
    lastReport: null, getRules, saveRule, listCollections, selectedCollection, collectAttachments,
    runRule, makeIO, validateRule, addWindow, removeWindow, openSettings,
    defaultCacheRoot: () => PathUtils.join(Zotero.DataDirectory.dir, "llm-for-zotero-mineru"),
    removeRule(id) {
      Zotero.Prefs.set(PREF, JSON.stringify(getRules().filter(rule => rule.id !== id)), true);
      lastRuns.delete(id);
    },
    async chooseFolder(window, title) {
      let FilePicker;
      try { ({ FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs")); }
      catch (_) { ({ FilePicker } = ChromeUtils.import("chrome://zotero/content/modules/filePicker.jsm")); }
      const picker = new FilePicker(); picker.init(window, title, picker.modeGetFolder);
      return await picker.show() === picker.returnOK ? picker.file : null;
    },
    async start({ version = "dev" } = {}) {
      api.version = version;
      stopped = false;
      Zotero.MineruObsidianSync = api;
      for (const window of Zotero.getMainWindows()) addWindow(window);
      notifier = Zotero.Notifier.registerObserver({ notify() {
        // Polling also sees completed MinerU jobs, which need not emit Zotero notifications.
        // Expire due times, but keep event handling free of filesystem work.
        for (const rule of getRules()) if (rule.autoSync) lastRuns.set(rule.id, 0);
      } }, ["item", "collection", "collection-item"], "mineru-obsidian-sync");
      timer = setTimeout(tick, 60000);
    },
    async stop() {
      stopped = true; clearTimeout(timer);
      if (notifier) Zotero.Notifier.unregisterObserver(notifier);
      notifier = null;
      for (const window of [...windows]) removeWindow(window);
      if (dialog && !dialog.closed) dialog.close();
      if (running) { try { await running; } catch (_) {} }
      delete Zotero.MineruObsidianSync;
    },
  };
  global.MineruObsidianPlugin = api;
})(globalThis);
