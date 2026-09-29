"use strict";
(function () {
  const paneID = "mineru-obsidian-pane";
  const observer = new MutationObserver(() => {
    const root = document.getElementById(paneID);
    if (root) { observer.disconnect(); void init(root); }
  });
  const existing = document.getElementById(paneID);
  if (existing) void init(existing);
  else observer.observe(document, { childList: true, subtree: true });

async function init(root) {
  const api = Zotero.MineruObsidianSync;
  const $ = id => root.querySelector("#mineru-obsidian-" + id);
  let collections = [], visible = [], ruleID = null;
  const selected = new Map();
  const keyOf = c => `${c.libraryID}:${c.collectionKey || c.key}`;
  function status(message) { $("status").textContent = message; }
  function showError(error) { status("未完成：" + error.message); $("report").textContent = error.stack || String(error); }
  function selectionSummary() {
    const checked = visible.filter(c => selected.has(keyOf(c))).length;
    $("selection-count").textContent = `已选 ${selected.size} 个 · 当前显示 ${visible.length} 个`;
    $("select-all-visible").checked = visible.length > 0 && checked === visible.length;
    $("select-all-visible").indeterminate = checked > 0 && checked < visible.length;
    $("select-all-visible").disabled = visible.length === 0;
    $("select-visible").disabled = visible.length === 0;
    $("clear-selection").disabled = selected.size === 0;
  }
  function renderCollections() {
    const known = new Set(collections.map(keyOf));
    const missing = [...selected.values()].filter(c => !known.has(keyOf(c)))
      .map(c => ({ ...c, missing: true }));
    const query = $("collection-search").value.trim().toLocaleLowerCase();
    visible = [...collections, ...missing].filter(c =>
      (!query || `${c.label} ${c.path || ""} ${c.name || ""}`.toLocaleLowerCase().includes(query))
      && (!$("selected-only").checked || selected.has(keyOf(c))));
    const fragment = document.createDocumentFragment();
    for (const c of visible) {
      const row = document.createElement("tr");
      row.dataset.key = keyOf(c);
      row.dataset.selected = String(selected.has(keyOf(c)));
      if (c.missing) row.dataset.missing = "true";
      const checkboxCell = document.createElement("td");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox"; checkbox.checked = selected.has(keyOf(c));
      checkbox.setAttribute("aria-label", `选择 ${c.label || c.collectionKey}`);
      checkbox.dataset.key = keyOf(c); checkboxCell.appendChild(checkbox); row.appendChild(checkboxCell);
      const name = c.name || (c.label || c.collectionKey).split(" / ").pop();
      const path = c.path || c.label || c.collectionKey;
      for (const value of [name + (c.missing ? "（无法访问）" : ""), path, c.libraryName || `文献库 ${c.libraryID}`]) {
        const cell = document.createElement("td"); cell.textContent = value; cell.title = value; row.appendChild(cell);
      }
      fragment.appendChild(row);
    }
    if (!visible.length) {
      const row = document.createElement("tr"); row.className = "empty-row";
      const cell = document.createElement("td"); cell.colSpan = 4;
      cell.textContent = $("selected-only").checked ? "没有符合条件的已选 collection。" : "没有匹配的 collection。";
      row.appendChild(cell); fragment.appendChild(row);
    }
    $("collection-rows").replaceChildren(fragment); selectionSummary();
  }
  function setSelected(key, checked) {
    const c = visible.find(value => keyOf(value) === key);
    if (!c) return;
    if (checked) selected.set(key, c); else selected.delete(key);
    if ($("selected-only").checked && !checked) { renderCollections(); return; }
    for (const row of $("collection-rows").children) {
      if (row.dataset.key !== key) continue;
      row.dataset.selected = String(checked); row.querySelector("input").checked = checked;
    }
    selectionSummary();
  }
  function fill(rule) {
    ruleID = rule?.id || null; selected.clear();
    const current = rule || api.selectedCollection();
    const choices = Array.isArray(rule?.collections) ? rule.collections : current ? [current] : [];
    for (const c of choices) {
      const ref = collections.find(value => keyOf(value) === keyOf(c))
        || { ...c, collectionKey: c.collectionKey || c.key, label: c.label || c.name || c.collectionKey || c.key };
      selected.set(keyOf(ref), ref);
    }
    $("collection-search").value = ""; $("selected-only").checked = false;
    $("vault").value = rule?.vaultPath || "";
    $("papers").value = rule?.papersDir || "raw/papers";
    $("assets").value = rule?.assetsDir || "raw/assets/mineru";
    $("cache").value = rule?.cacheRoot || "";
    $("cache").placeholder = api.defaultCacheRoot();
    updatePathTitles();
    $("mode-overwrite").checked = rule?.mode !== "protect";
    $("mode-protect").checked = rule?.mode === "protect";
    $("children").checked = rule?.includeSubcollections !== false;
    $("restore").checked = rule?.restoreImages !== false;
    $("auto").checked = !!rule?.autoSync;
    $("schedule-type").value = rule?.scheduleType || "interval";
    $("interval").value = rule?.intervalMinutes ?? 10;
    $("days").value = rule?.intervalDays ?? 2;
    $("time").value = rule?.scheduleTime || "09:00";
    updateScheduleFields();
    renderCollections(); refreshRules();
  }
  function updatePathTitles() {
    for (const id of ["vault", "cache"]) $(id).title = $(id).value || $(id).placeholder;
  }
  function updateScheduleFields() {
    const type = $("schedule-type").value;
    for (const id of ["interval", "days", "time"]) {
      const visible = id === "interval" ? type === "interval" : id === "days" ? type === "days" : type !== "interval";
      $(id).hidden = !visible;
      $(id + "-label").hidden = !visible;
    }
  }
  function read() {
    if (!selected.size) throw new Error("请在表格中至少勾选一个 collection。");
    const choices = [...selected.values()].map(c => ({libraryID:c.libraryID,collectionKey:c.collectionKey,label:c.label}));
    return { collections: choices, id: ruleID,
      label: choices.length === 1 ? choices[0].label : `${choices[0].label} 等 ${choices.length} 个 collection`,
      vaultPath: $("vault").value, papersDir: $("papers").value,
      assetsDir: $("assets").value, cacheRoot: $("cache").value,
      mode: $("mode-protect").checked ? "protect" : "overwrite",
      includeSubcollections: $("children").checked, restoreImages: $("restore").checked,
      autoSync: $("auto").checked, scheduleType: $("schedule-type").value,
      intervalMinutes: Number($("interval").value), intervalDays: Number($("days").value),
      scheduleTime: $("time").value };
  }
  function refreshRules() {
    const rules = api.getRules();
    $("rules").replaceChildren();
    for (const rule of rules) {
      const button = document.createElement("button");
      const count = Array.isArray(rule.collections) ? rule.collections.length : 1;
      const title = document.createElement("span"); title.className = "rule-title";
      title.textContent = count > 1 ? `${count} 个分类` : (rule.label || "1 个分类");
      button.appendChild(title);
      if (count > 1) {
        const detail = document.createElement("span"); detail.className = "rule-detail";
        detail.textContent = rule.collections[0]?.label || rule.label;
        button.appendChild(detail);
      }
      button.title = rule.label;
      button.setAttribute("aria-label", rule.label);
      button.setAttribute("aria-pressed", String(rule.id === ruleID));
      button.addEventListener("click", () => fill(rule)); $("rules").appendChild(button);
    }
    if (!ruleID) {
      const text = document.createElement("span"); text.className = "hint";
      text.textContent = "新任务（未保存）"; $("rules").appendChild(text);
    }
    $("remove").disabled = !ruleID;
  }
  function showReport(report) {
    if (!report) { status("还没有运行报告。"); return; }
    if (!report.counts) { status("运行失败"); $("report").textContent = JSON.stringify(report, null, 2); return; }
    const c = report.counts;
    status(`${report.dryRun ? "预览完成（未写入）" : "同步检查结束"} · 新增 ${c.created} · 更新 ${c.updated} · 缺文件 ${c.missing} · 冲突 ${c.conflicts} · 失败 ${c.failed}`);
    const coverage = report.coverage;
    const lines = coverage ? [`扫描 ${coverage.collections} 个 collection，${coverage.parentItems} 篇文献，${coverage.pdfAttachments} 个 PDF 附件；${coverage.itemsWithoutPDF} 篇未附 PDF。`] : [];
    for (const item of report.items || []) if (item.status !== "unchanged") {
      lines.push(`[${item.status}] ${item.title || item.attachmentID}\n  ${item.path || ""}${item.message ? "\n  " + item.message : ""}`);
    }
    for (const warning of report.warnings || []) lines.push("提示：" + warning);
    if (!report.dryRun) lines.push("完整报告：" + report.rule.vaultPath + "/.zotero-mineru-sync/last-report.json");
    $("report").textContent = lines.join("\n\n") || "没有可同步的 PDF 附件。";
  }
  async function run(dryRun) {
    const controls = [...root.querySelectorAll("button, input, select")].map(el => [el,el.disabled]);
    try {
      const rule = read(); controls.forEach(([el]) => el.disabled = true);
      status(dryRun ? "正在预览，请稍候…" : "正在同步，请稍候…");
      const report = await api.runRule(rule, dryRun, value => {
        status("正在处理… " + (typeof value === "string" ? value : value.title || value.attachmentID || ""));
      });
      showReport(report);
    } catch (error) { showError(error); }
    finally { controls.forEach(([el,disabled]) => el.disabled = disabled); }
  }
  try {
    collections = await api.listCollections(); fill(api.getRules()[0] || null);
    for (const id of ["vault", "cache"]) $(id).addEventListener("input", updatePathTitles);
    $("schedule-type").addEventListener("change", updateScheduleFields);
    $("collection-search").addEventListener("input", renderCollections);
    $("selected-only").addEventListener("change", renderCollections);
    $("collection-rows").addEventListener("change", event => {
      if (event.target.matches("input[type=checkbox]")) setSelected(event.target.dataset.key, event.target.checked);
    });
    $("collection-rows").addEventListener("click", event => {
      if (event.target.closest("input")) return;
      const row = event.target.closest("tr[data-key]");
      const checkbox = row?.querySelector("input");
      if (checkbox && !checkbox.disabled) setSelected(row.dataset.key, !checkbox.checked);
    });
    $("select-all-visible").addEventListener("change", event => {
      for (const c of visible) { if (event.target.checked) selected.set(keyOf(c), c); else selected.delete(keyOf(c)); }
      renderCollections();
    });
    $("select-visible").addEventListener("click", () => { for (const c of visible) selected.set(keyOf(c),c); renderCollections(); });
    $("clear-selection").addEventListener("click", () => { selected.clear(); renderCollections(); });
    $("new").addEventListener("click", () => fill(null));
    $("save").addEventListener("click", () => {
      try { const rule = api.saveRule(read()); ruleID = rule.id; refreshRules(); status("配置已保存。" + (rule.autoSync ? "将按设定时间自动同步。" : "可随时手动同步。")); }
      catch (error) { showError(error); }
    });
    $("remove").addEventListener("click", () => {
      try { if (ruleID) api.removeRule(ruleID); fill(api.getRules()[0] || null); status("配置已移除，已导出的文件保留。"); }
      catch (error) { showError(error); }
    });
    for (const [button, field, title] of [["browse-vault", "vault", "选择 Obsidian 仓库根目录"], ["browse-cache", "cache", "选择 MinerU 缓存根目录"]]) {
      $(button).addEventListener("click", async () => {
        try { const path = await api.chooseFolder(window, title); if (path) { $(field).value = path; updatePathTitles(); } }
        catch (error) { showError(error); }
      });
    }
    $("preview").addEventListener("click", () => run(true));
    $("sync").addEventListener("click", () => run(false));
    $("last").addEventListener("click", () => showReport(api.lastReport));
  } catch (error) { showError(error); }
}
})();
