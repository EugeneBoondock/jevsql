// Pace the replay: headings linger, blank lines flick past, the last frame holds.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const raw = execFileSync(process.execPath, [`examples/${process.argv[2] ?? 'contrast.mjs'}`], { encoding: 'utf8', maxBuffer: 8e6 });
const lines = raw.replace(/\r/g, '').split('\n');
while (lines.length && !lines.at(-1).trim()) lines.pop();

const pace = (line) => {
  if (!line.trim()) return 0.14;
  if (/^\s{2}\d+\./.test(line)) return 0.95;                // section heading
  if (/^\s{2}JevSQL/.test(line)) return 1.2;                 // title
  if (/^\s{5}\S/.test(line) && !/\s{2,}/.test(line.trim())) return 0.50;
  return 0.38;                                          // data row
};

const entries = [];
entries.push({ frame: 0, duration: 0.7 });
for (let i = 1; i <= lines.length; i++) entries.push({ frame: i, duration: pace(lines[i - 1]) });
entries.at(-1).duration = 4.0;

let out = '';
for (const entry of entries) {
  out += `file 'frames/f${String(entry.frame).padStart(4, '0')}.png'\nduration ${entry.duration.toFixed(2)}\n`;
}
// The concat demuxer needs the final image repeated for its duration to apply.
out += `file 'frames/f${String(entries.at(-1).frame).padStart(4, '0')}.png'\n`;
writeFileSync('scripts/out/concat.txt', out, 'utf8');
console.log(JSON.stringify({ frames: entries.length, seconds: Number(entries.reduce((s, e) => s + e.duration, 0).toFixed(1)) }));
