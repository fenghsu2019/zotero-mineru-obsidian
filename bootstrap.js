/* Zotero bootstrap entry point. No network services or npm runtime required. */
var chromeHandle;
var pluginScope;

async function startup({ id, version, rootURI }) {
  await Zotero.initializationPromise;
  chromeHandle = Cc["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Ci.amIAddonManagerStartup)
    .registerChrome(Services.io.newURI(rootURI + "manifest.json"), [
      ["content", "mineru-obsidian", rootURI + "content/"],
    ]);
  pluginScope = { Zotero, Services, IOUtils, PathUtils, ChromeUtils, Cc, Ci,
    setTimeout, clearTimeout, TextEncoder, TextDecoder };
  pluginScope.globalThis = pluginScope;
  for (const file of ["core.js", "engine.js", "zotero.js"]) {
    Services.scriptloader.loadSubScriptWithOptions(rootURI + "src/" + file,
      { target: pluginScope, charset: "UTF-8", ignoreCache: true });
  }
  await pluginScope.MineruObsidianPlugin.start({ id, version, rootURI });
}

function onMainWindowLoad({ window }) {
  pluginScope?.MineruObsidianPlugin?.addWindow(window);
}

function onMainWindowUnload({ window }) {
  pluginScope?.MineruObsidianPlugin?.removeWindow(window);
}

async function shutdown() {
  if (pluginScope?.MineruObsidianPlugin) await pluginScope.MineruObsidianPlugin.stop();
  chromeHandle?.destruct();
  chromeHandle = null;
  pluginScope = null;
}

function install() {}
function uninstall() {}
