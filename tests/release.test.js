"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mineru-release-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["manifest.json", "package.json", "bootstrap.js", "src", "content"]) {
    fs.cpSync(path.join(projectRoot, name), path.join(root, name), { recursive: true });
  }
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(path.join(projectRoot, "scripts/build.py"), path.join(root, "scripts/build.py"));
  return root;
}

function readJSON(root, name) {
  return JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
}

function changeJSON(root, name, edit) {
  const value = readJSON(root, name);
  edit(value);
  fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2));
}

function build(root) {
  const result = spawnSync("python3", [path.join(root, "scripts/build.py")], {
    cwd: root, encoding: "utf8"
  });
  assert.ifError(result.error);
  return result;
}

function assertRejected(root, expectedError) {
  const result = build(root);
  assert.notEqual(result.status, 0, "An uninstallable release must not build successfully");
  assert.match(result.stderr, expectedError);
  assert.equal(fs.existsSync(path.join(root, "dist")), false,
    "Validation must fail before publishing an XPI");
}

test("release rejects the missing update_url that Zotero reports as an invalid extension", t => {
  const root = fixture(t);
  changeJSON(root, "manifest.json", manifest => {
    delete manifest.applications.zotero.update_url;
  });
  assertRejected(root, /Missing required Zotero manifest field: applications\.zotero\.update_url/);
});

test("release rejects a data update URL disabled by Zotero's default update security", t => {
  const root = fixture(t);
  changeJSON(root, "manifest.json", manifest => {
    manifest.applications.zotero.update_url = "data:application/json,%7B%22addons%22%3A%7B%7D%7D";
  });
  assertRejected(root, /update_url must use HTTPS/);
});

test("release rejects inconsistent package and install-manifest versions", t => {
  const root = fixture(t);
  changeJSON(root, "package.json", metadata => {
    metadata.version = "0.0.0-release-test";
  });
  assertRejected(root, /package\.json and manifest\.json versions differ/);
});

test("current release builds an intact XPI with matching manifest and package metadata", t => {
  const root = fixture(t);
  const manifest = readJSON(root, "manifest.json");
  const metadata = readJSON(root, "package.json");
  const result = build(root);
  assert.equal(result.status, 0, result.stderr);
  const archive = path.join(root, "dist", `mineru-obsidian-sync-${manifest.version}.xpi`);
  assert.equal(result.stdout.trim(), archive);
  const inspected = spawnSync("python3", ["-c", [
    "import json, sys, zipfile",
    "with zipfile.ZipFile(sys.argv[1]) as archive:",
    "    print(json.dumps({'manifest': json.loads(archive.read('manifest.json')), 'files': archive.namelist(), 'settings': archive.read('content/settings.xhtml').decode('utf-8'), 'corruptEntry': archive.testzip()}))"
  ].join("\n"), archive], { encoding: "utf8" });
  assert.ifError(inspected.error);
  assert.equal(inspected.status, 0, inspected.stderr);
  const packed = JSON.parse(inspected.stdout);
  assert.equal(packed.corruptEntry, null);
  assert.deepEqual(packed.manifest, manifest);
  assert.equal(packed.manifest.version, metadata.version);
  assert.equal(new URL(packed.manifest.applications.zotero.update_url).protocol, "https:");
  assert.ok(packed.settings.includes(`settings.css?v=${encodeURIComponent(manifest.version)}`));
  assert.ok(packed.settings.includes(`settings.js?v=${encodeURIComponent(manifest.version)}`));
  assert.ok(!packed.settings.includes("__VERSION__"));
  for (const name of ["manifest.json", "bootstrap.js", "src/core.js", "src/engine.js",
    "src/zotero.js", "content/settings.xhtml", "content/settings.js"]) {
    assert.ok(packed.files.includes(name), `Missing packaged file: ${name}`);
  }
});
