#!/usr/bin/env python3
"""Generate PUBLIC_RELEASE_MANIFEST.json for the MAYA Usage Dashboard repo.

Walks git-tracked files (git ls-files -z, null-separated to survive spaces),
skips gitignored/runtime artifacts, self-excludes the manifest, and writes
SHA-256 per file. Deterministic output: sorted by path.
"""
import hashlib
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
MANIFEST_PATH = ROOT / 'PUBLIC_RELEASE_MANIFEST.json'
SKIP_DIRS = {'__pycache__', 'node_modules', 'reports', '.git', 'maya-agent'}

def main():
    tracked = subprocess.check_output(
        ['git', '-C', str(ROOT), 'ls-files', '-z'], text=False
    ).split(b'\x00')

    entries = {}
    for raw in tracked:
        if not raw:
            continue
        rel = raw.decode('utf-8', errors='replace').replace('\\', '/')
        p = ROOT / rel
        if not p.is_file():
            continue
        if str(p) == str(MANIFEST_PATH):
            continue  # self-exclude
        if any(part in SKIP_DIRS for part in p.parts):
            continue
        sha = hashlib.sha256(p.read_bytes()).hexdigest()
        entries[rel] = {'sha256': sha, 'size': p.stat().st_size}

    manifest = {
        'version': '1.0',
        'generated': '2026-08-02T00:00:00Z',
        'total_entries': len(entries),
        'files': entries
    }
    with open(MANIFEST_PATH, 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(manifest, fh, indent=2)
        fh.write('\n')
    print(f'manifest written: {len(entries)} entries -> {MANIFEST_PATH}')
    return 0

if __name__ == '__main__':
    sys.exit(main())
