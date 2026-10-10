import { mkdir, readFile, writeFile, rename, rm, chmod, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SpondError } from './spond.js';
export function tokenStore(directory = process.env.SPOND_CONFIG_DIR || join(
  process.env.XDG_CONFIG_HOME && isAbsolute(process.env.XDG_CONFIG_HOME) ? process.env.XDG_CONFIG_HOME : join(homedir(), '.config'), 'spond-cli')) {
  const path = join(directory, 'token.json');
  return {
    async save(value) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if ((await lstat(directory)).isSymbolicLink()) throw new SpondError('Token directory must not be a symbolic link.');
      await chmod(directory, 0o700);
      const temp = join(directory, `.token-${randomUUID()}.tmp`);
      try {
        await writeFile(temp, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
        await rename(temp, path);
      } finally { await rm(temp, { force: true }); }
    },
    async load() {
      let data;
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) throw new SpondError('Unsafe token file.');
        if (process.platform !== 'win32' && (info.mode & 0o077))
          throw new SpondError('Token file permissions are too broad. Protect it with chmod 600 or log in again.');
        data = JSON.parse(await readFile(path, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') throw new SpondError('Not logged in. Run spond login.');
        if (error instanceof SpondError) throw error;
        throw new SpondError('Token file cannot be read. Please log in again.');
      }
      if (typeof data?.token !== 'string' || !data.token || /[\r\n]/.test(data.token))
        throw new SpondError('Invalid token file. Please log in again.');
      // Expiration format is not guaranteed by the unofficial API. HTTP 401 remains authoritative.
      if (typeof data.expiration === 'string' && Number.isFinite(Date.parse(data.expiration)) && Date.parse(data.expiration) <= Date.now())
        throw new SpondError('Token has expired. Run spond login.');
      return data.token;
    },
    async clear() { await rm(path, { force: true }); }
  };
}
