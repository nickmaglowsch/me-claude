import crypto from 'crypto';
import fs from 'fs';

/**
 * Write `content` to `finalPath` atomically using a random tmp file + rename.
 * Uses O_EXCL to prevent clobbering an existing file at the tmp path
 * (symlink-race defense). On EEXIST retry up to `maxRetries` times.
 */
export function atomicWriteFile(
  finalPath: string,
  content: string,
  maxRetries = 3,
): void {
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW ?? 0); // O_NOFOLLOW not available on all platforms

  let lastErr: unknown;
  for (let i = 0; i < maxRetries; i++) {
    const rand = crypto.randomBytes(8).toString('hex');
    const tmpPath = `${finalPath}.tmp-${rand}`;
    try {
      const fd = fs.openSync(tmpPath, flags, 0o600);
      try {
        fs.writeSync(fd, content, 0, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmpPath, finalPath);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        lastErr = err;
        continue; // retry with new random name
      }
      throw err; // unexpected error — rethrow
    }
  }
  throw lastErr; // exhausted retries
}
