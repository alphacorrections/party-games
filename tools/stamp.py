#!/usr/bin/env python3
"""Stamp every local module import and page asset with one version string.

Phones (iOS Safari especially) cache each JS file separately for up to 10
minutes on GitHub Pages, so after a deploy a phone can run a mix of old and
new modules. Giving every import the same ?v= makes the whole app update as
one unit: an old page loads only old files, a new page only new ones.

Run before every commit:  python3 tools/stamp.py
"""
import re, subprocess, time, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
try:
    ver = subprocess.check_output(['git', 'rev-parse', '--short', 'HEAD'], cwd=root, text=True).strip() + '-' + time.strftime('%m%d%H%M')
except Exception:
    ver = time.strftime('%Y%m%d%H%M%S')

js_imp = re.compile(r"""((?:from\s+|import\(\s*)(['"]))(\.{1,2}/[^'"?]+?\.js)(?:\?v=[^'"]*)?(\2)""")
html_asset = re.compile(r"""((?:src|href)=")((?:src|css)/[^"?]+?\.(?:js|css))(?:\?v=[^"]*)?(")""")
inline_imp = re.compile(r"""((?:from\s+|import\(\s*)(['"]))(\./src/[^'"?]+?\.js|src/[^'"?]+?\.js)(?:\?v=[^'"]*)?(\2)""")

n = 0
for p in list((root / 'src').rglob('*.js')):
    s = p.read_text(); t = js_imp.sub(lambda m: f"{m.group(1)}{m.group(3)}?v={ver}{m.group(4)}", s)
    if t != s: p.write_text(t); n += 1
for p in root.glob('*.html'):
    s = p.read_text()
    t = html_asset.sub(lambda m: f"{m.group(1)}{m.group(2)}?v={ver}{m.group(3)}", s)
    t = inline_imp.sub(lambda m: f"{m.group(1)}{m.group(3)}?v={ver}{m.group(4)}", t)
    if t != s: p.write_text(t); n += 1
print(f"stamped {n} files with v={ver}")
