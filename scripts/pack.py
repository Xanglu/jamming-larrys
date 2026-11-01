#!/usr/bin/env python3
"""Build a distributable zip of the runtime extension files.

Only files the browser actually loads are packaged: manifest, scripts, pages,
bundled Trystero, icons and the audio keepalive. Development files (node_modules,
src/, scripts/, opencode.json) stay out, so the friend just unzips and loads the
folder unpacked.
"""

import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
TOP_DIR = "jamming-larrys"

ALWAYS = [
    "manifest.json",
    "background.js",
    "content.js",
    "content-radio.js",
    "rg-bridge.js",
    "content.css",
    "offscreen.html",
    "offscreen.js",
    "popup.html",
    "popup.css",
    "popup.js",
    "keepalive.wav",
    "vendor/trystero.bundle.js",
    "INSTALL.txt",
]

# Extensions that must exist on disk when referenced from the manifest.
FILE_SUFFIXES = (".js", ".css", ".html", ".png", ".wav", ".json")


def manifest_files():
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    found = []

    def walk(node):
        if isinstance(node, dict):
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)
        elif isinstance(node, str) and node.endswith(FILE_SUFFIXES):
            if "://" not in node and not node.startswith("_"):
                found.append(node)

    walk(manifest)
    return manifest, found


def main():
    manifest, referenced = manifest_files()

    files = list(ALWAYS)
    for name in referenced:
        if name not in files:
            files.append(name)

    missing = [name for name in files if not (ROOT / name).is_file()]
    if missing:
        print("Missing runtime files:", ", ".join(missing), file=sys.stderr)
        return 1

    version = manifest["version"]
    DIST.mkdir(exist_ok=True)
    out = DIST / f"jamming-larrys-v{version}.zip"

    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in files:
            archive.write(ROOT / name, f"{TOP_DIR}/{name}")

    size = out.stat().st_size
    print(f"{out.relative_to(ROOT)}  ({len(files)} files, {size / 1024:.1f} KB)")
    for name in files:
        print(f"  {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
