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
      if ((await lstat(directory)).isSymbolicLink()) throw new SpondError('Token-Verzeichnis darf kein Symlink sein.');
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
        if (!info.isFile() || info.isSymbolicLink()) throw new SpondError('Unsichere Token-Datei.');
        if (process.platform !== 'win32' && (info.mode & 0o077))
          throw new SpondError('Token-Datei hat zu offene Rechte. Mit chmod 600 schützen oder erneut anmelden.');
        data = JSON.parse(await readFile(path, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') throw new SpondError('Nicht angemeldet. Bitte spond login ausführen.');
        if (error instanceof SpondError) throw error;
        throw new SpondError('Token-Datei nicht lesbar. Bitte erneut anmelden.');
      }
      if (typeof data?.token !== 'string' || !data.token || /[\r\n]/.test(data.token))
        throw new SpondError('Ungültige Token-Datei. Bitte erneut anmelden.');
      // Expiration format is not guaranteed by the unofficial API. HTTP 401 remains authoritative.
      if (typeof data.expiration === 'string' && Number.isFinite(Date.parse(data.expiration)) && Date.parse(data.expiration) <= Date.now())
        throw new SpondError('Token abgelaufen. Bitte spond login ausführen.');
      return data.token;
    },
    async clear() { await rm(path, { force: true }); }
  };
}
