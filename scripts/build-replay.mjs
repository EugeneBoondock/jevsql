// Capture the showcase output and build a terminal replay page.
//
// The page renders the real captured output — colours and all — and exposes
// window.showFrame(n) so a screenshotting driver can step through it one line
// at a time. Nothing is re-typed by hand: if the showcase output changes, the
// replay changes with it.

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'scripts', 'out');
mkdirSync(out, { recursive: true });

const raw = execFileSync(process.execPath, [path.join(root, 'examples', 'showcase.mjs')],
  { env: { ...process.env, FORCE_COLOR: '1' }, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });

const COLOURS = { 31: 'red', 32: 'green', 33: 'yellow', 36: 'cyan', 90: 'grey' };
const escapeHtml = (value) => value.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Convert one line of ANSI-coloured text into HTML spans. */
function toHtml(line) {
  let html = '', open = 0;
  let index = 0;
  const state = { colour: null, bold: false, dim: false };
  const emit = (text) => {
    if (!text) return;
    const classes = [state.colour, state.bold ? 'bold' : null, state.dim ? 'dim' : null].filter(Boolean);
    html += classes.length ? `<span class="${classes.join(' ')}">${escapeHtml(text)}</span>` : escapeHtml(text);
  };
  const pattern = /\[(\d+)m/g;
  let match;
  while ((match = pattern.exec(line)) !== null) {
    emit(line.slice(index, match.index));
    const code = Number(match[1]);
    if (code === 0) { state.colour = null; state.bold = false; state.dim = false; }
    else if (code === 1) state.bold = true;
    else if (code === 2) state.dim = true;
    else if (COLOURS[code]) state.colour = COLOURS[code];
    index = pattern.lastIndex;
  }
  emit(line.slice(index));
  void open;
  return html || '&nbsp;';
}

const lines = raw.replace(/\r/g, '').split('\n');
while (lines.length && !lines.at(-1).trim()) lines.pop();
const rendered = lines.map(toHtml);

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>JevSQL</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root { --bg:#0b0d12; --fg:#d7dce5; --grey:#7c8598; --green:#4ade80; --red:#fb7185; --yellow:#fbbf24; --cyan:#67e8f9; --pink:#ff2d87; }
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; background:#05070b; height:100%; }
  body { display:flex; align-items:center; justify-content:center; }
  .frame { width:1280px; height:720px; background:var(--bg); border-radius:12px; overflow:hidden;
    box-shadow:0 30px 90px rgba(255,45,135,.16), 0 0 0 1px rgba(255,255,255,.06); display:flex; flex-direction:column; }
  .bar { height:36px; flex:0 0 36px; background:#11141b; display:flex; align-items:center; padding:0 14px; gap:8px;
    border-bottom:1px solid rgba(255,255,255,.06); }
  .dot { width:11px; height:11px; border-radius:50%; }
  .title { margin-left:10px; color:var(--grey); font:12px/1 'JetBrains Mono', monospace; letter-spacing:.06em; }
  pre { margin:0; padding:14px 22px; flex:1 1 auto; overflow:hidden;
    font:13px/1.44 'JetBrains Mono', ui-monospace, monospace; color:var(--fg); white-space:pre; }
  .red{color:var(--red)} .green{color:var(--green)} .yellow{color:var(--yellow)} .cyan{color:var(--cyan)} .grey{color:var(--grey)}
  .bold{font-weight:700} .dim{color:var(--grey)}
  .cursor { display:inline-block; width:8px; height:15px; background:var(--pink); vertical-align:-3px; }
</style></head>
<body>
  <div class="frame">
    <div class="bar">
      <span class="dot" style="background:#ff5f57"></span>
      <span class="dot" style="background:#febc2e"></span>
      <span class="dot" style="background:#28c840"></span>
      <span class="title">jevsql — npm run showcase</span>
    </div>
    <pre id="out"></pre>
  </div>
<script>
  const LINES = ${JSON.stringify(rendered)};
  const VISIBLE = 33;
  const out = document.getElementById('out');
  window.totalFrames = LINES.length;
  window.showFrame = (n) => {
    const shown = LINES.slice(0, Math.max(0, Math.min(n, LINES.length)));
    const window_ = shown.slice(Math.max(0, shown.length - VISIBLE));
    out.innerHTML = window_.join('\\n') + '<span class="cursor"></span>';
  };
  window.showFrame(0);
</script>
</body></html>`;

const file = path.join(out, 'replay.html');
writeFileSync(file, page, 'utf8');
console.log(JSON.stringify({ file, lines: lines.length }));
