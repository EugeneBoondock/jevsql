import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/** Process environment wins; local settings take precedence over shared defaults. */
export function loadEnvFiles(files = ['.env.local', '.env']) {
  for (const file of files) {
    if (!existsSync(file)) continue;
    const values = parseEnv(readFileSync(file, 'utf8'));
    for (const [name, value] of Object.entries(values)) {
      if (!(name in process.env)) process.env[name] = value;
    }
  }
}
