#!/usr/bin/env python3
"""PRISM overlay, run at image build time: let noVNC's page load in one round trip.

vnc.html imports app/ui.js, whose static import graph is ~60 modules five
levels deep, and only then fetches defaults.json, mandatory.json and
package.json, one after the other. On a 300 ms link that chain alone took
~4.5 s before the viewer could even start to connect. This adds
<link rel="modulepreload"> for every module in the graph (computed from the
files in this image, so it always matches its noVNC version) and
<link rel="preload" as="fetch"> for the JSON files, so the browser asks for
all of them as soon as vnc.html arrives.

Usage: novnc-preload.py [NOVNC_ROOT]   (default /opt/bin/noVNC). Idempotent.
"""
import os
import posixpath
import re
import sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else '/opt/bin/noVNC'
PAGE = os.path.join(ROOT, 'vnc.html')
MARK = '<!-- prism:preload -->'
# Static `import ... from "x"`, `export ... from "x"` and `import "x"`.
# Dynamic import() is left alone: it is lazy on purpose.
SPEC = re.compile(r'''\b(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]''')
JSON_FILES = ('defaults.json', 'mandatory.json', 'package.json')


def strip_comments(src):
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    return re.sub(r'(?m)^\s*//.*$', '', src)


def specifiers(src):
    for m in SPEC.finditer(strip_comments(src)):
        yield m.group(1) or m.group(2)


def resolve(base_dir, spec):
    """Root-relative path for a relative specifier, or None for anything else."""
    if not spec.startswith(('./', '../')):
        return None
    path = posixpath.normpath(posixpath.join(base_dir, spec))
    return None if path.startswith('..') else path


def module_graph(html):
    queue = []
    for block in re.findall(r'<script\s+type="module"[^>]*>(.*?)</script>', html, flags=re.S):
        queue += [p for p in (resolve('', s) for s in specifiers(block)) if p]
    seen = []
    while queue:
        path = queue.pop(0)
        if path in seen:
            continue
        full = os.path.join(ROOT, path)
        if not os.path.isfile(full):
            continue
        seen.append(path)
        with open(full, encoding='utf-8') as f:
            src = f.read()
        queue += [p for p in (resolve(posixpath.dirname(path), s) for s in specifiers(src)) if p]
    return seen


def main():
    with open(PAGE, encoding='utf-8') as f:
        html = f.read()
    if MARK in html:
        print('novnc-preload: already applied')
        return 0
    if '</head>' not in html:
        print('novnc-preload: no </head> in vnc.html', file=sys.stderr)
        return 1
    modules = module_graph(html)
    if len(modules) < 10:
        print(f'novnc-preload: only {len(modules)} modules found; noVNC layout changed?', file=sys.stderr)
        return 1
    lines = [f'    {MARK}']
    lines += [f'    <link rel="modulepreload" href="{m}">' for m in modules]
    lines += [f'    <link rel="preload" as="fetch" crossorigin="anonymous" href="{j}">'
              for j in JSON_FILES if os.path.isfile(os.path.join(ROOT, j))]
    html = html.replace('</head>', '\n'.join(lines) + '\n</head>', 1)
    with open(PAGE, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f'novnc-preload: {len(modules)} modules preloaded')
    return 0


if __name__ == '__main__':
    sys.exit(main())
