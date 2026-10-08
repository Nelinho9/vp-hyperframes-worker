import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
export function jobEnvironment(jobDir, baseEnv = process.env) {
  const cache = join(jobDir, '__extract-cache');
  mkdirSync(cache, { recursive: true });
  return { ...baseEnv, HYPERFRAMES_EXTRACT_CACHE_DIR: cache, HYPERFRAMES_NO_UPDATE_CHECK: '1', HYPERFRAMES_NO_AUTO_INSTALL: '1' };
}
