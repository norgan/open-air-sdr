import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export async function writeStateFile(target, value) {
  const folder = dirname(target);
  const temporary = join(folder, `.${basename(target)}.${randomUUID()}`);
  await mkdir(folder, {recursive:true, mode:0o700});
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
