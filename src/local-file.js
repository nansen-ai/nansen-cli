import fs from 'node:fs';
import path from 'node:path';

const unsafe = () => Object.assign(new Error('Refusing an unsafe local file. Restore a regular file inside the CLI storage directory.'), { code: 'LOCAL_FILE_UNSAFE' });
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
function checkStat(stat, directory, privateFile) {
  if (!stat || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (!directory && stat.nlink !== 1) ||
      (privateFile && process.platform !== 'win32' && ((stat.mode & 0o022) || stat.uid !== process.getuid()))) throw unsafe();
}

// The root is a trusted CLI storage path, never a path supplied by a server.
// Check each component below it; home ancestors may legitimately be symlinks.
// Descriptor checks reject replacements before any bytes are read or written.
export function openLocalFile(file, { root, flags = fs.constants.O_RDONLY, mode = 0o600, privateFile = false, maxBytes = Infinity } = {}) {
  const base = path.resolve(root);
  const target = path.resolve(file);
  const relative = path.relative(base, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw unsafe();
  const directories = [base];
  for (const part of relative.split(path.sep).slice(0, -1)) directories.push(path.join(directories.at(-1), part));
  const parents = directories.map(dir => {
    const stat = fs.lstatSync(dir);
    checkStat(stat, true, privateFile);
    return stat;
  });
  const before = fs.lstatSync(target, { throwIfNoEntry: false });
  if (before) checkStat(before, false, privateFile);
  let fd;
  try {
    fd = fs.openSync(target, flags | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0), mode);
    const opened = fs.fstatSync(fd);
    checkStat(opened, false, privateFile);
    if (opened.size > maxBytes || (before && !sameFile(before, opened))) throw unsafe();
    const after = fs.lstatSync(target);
    checkStat(after, false, privateFile);
    if (!sameFile(opened, after)) throw unsafe();
    directories.forEach((dir, i) => {
      const stat = fs.lstatSync(dir);
      checkStat(stat, true, privateFile);
      if (!sameFile(parents[i], stat)) throw unsafe();
    });
    return fd;
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    throw error;
  }
}

export function readLocalFile(file, options) {
  const fd = openLocalFile(file, options);
  try { return fs.readFileSync(fd, 'utf8'); }
  finally { fs.closeSync(fd); }
}
