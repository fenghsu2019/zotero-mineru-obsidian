#!/usr/bin/env python3
"""Package the source into an installable Zotero XPI; no external dependencies."""
import json
from pathlib import Path
import zipfile
from urllib.parse import urlparse

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
# Zotero's runtime requires update_url even though the upstream Mozilla schema
# marks it optional. A valid ZIP alone is not an installability check.
zotero = manifest.get("applications", {}).get("zotero", {})
for key in ("id", "update_url", "strict_max_version"):
    if not isinstance(zotero.get(key), str) or not zotero[key].strip():
        raise ValueError(f"Missing required Zotero manifest field: applications.zotero.{key}")
if manifest.get("manifest_version") != 2:
    raise ValueError("Zotero bootstrap plugins require manifest_version 2")
if json.loads((root / "package.json").read_text(encoding="utf-8"))["version"] != manifest["version"]:
    raise ValueError("package.json and manifest.json versions differ")
update_url = zotero["update_url"]
if urlparse(update_url).scheme != "https" or not urlparse(update_url).netloc:
    raise ValueError("update_url must use HTTPS; data/file/chrome URLs make the add-on unusable under Zotero's default update-security policy")
destination = root / "dist" / f"mineru-obsidian-sync-{manifest['version']}.xpi"
destination.parent.mkdir(exist_ok=True)
sources = [root / "manifest.json", root / "bootstrap.js"]
for folder in ("src", "content"):
    sources.extend(sorted((root / folder).rglob("*")))
with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
    for path in sources:
        if path.is_file():
            name = path.relative_to(root).as_posix()
            archive.write(path, name)
with zipfile.ZipFile(destination) as archive:
    assert archive.testzip() is None
    for name in ("manifest.json", "bootstrap.js", "src/core.js", "src/engine.js", "src/zotero.js", "content/preferences.xhtml", "content/settings.js", "content/icons/md2obsidian.png"):
        assert name in archive.namelist(), f"Missing {name}"
print(destination)
