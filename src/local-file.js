import fs from 'node:fs';
import path from 'node:path';

const unsafe = (file, reason) => Object.assign(new Error(`Refusing an unsafe local file at ${file}: ${reason}. Repair that path before retrying.`), { code: 'LOCAL_FILE_UNSAFE' });
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
function checkStat(stat, directory, privateFile, file) {
  if (!stat || (directory ? !stat.isDirectory() : !stat.isFile())) throw unsafe(file, directory ? 'expected a directory without symlinks' : 'expected a regular file without symlinks');
  if (!directory && stat.nlink !== 1) throw unsafe(file, 'file has unexpected hard links');
  if (privateFile && process.platform !== 'win32') {
    if (stat.mode & 0o022) throw unsafe(file, 'authentication path is writable by group or other users');
    if (stat.uid !== process.getuid()) throw unsafe(file, 'authentication path belongs to another user');
  }
}

// Non-private stores may use an intentionally symlinked storage root.
// Authentication and all components below either root must be link-free.
// Descriptor checks reject replacements before any bytes are read or written.
export function openLocalFile(file, { root, flags = fs.constants.O_RDONLY, mode = 0o600, privateFile = false, maxBytes = Infinity } = {}) {
  const base = path.resolve(root);
  const target = path.resolve(file);
  const relative = path.relative(base, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw unsafe(target, 'path is outside its storage root');
  const directories = [base];
  for (const part of relative.split(path.sep).slice(0, -1)) directories.push(path.join(directories.at(-1), part));
  const directoryStat = (dir, i) => i === 0 && !privateFile ? fs.statSync(dir) : fs.lstatSync(dir);
  const parents = directories.map((dir, i) => {
    const stat = directoryStat(dir, i);
    checkStat(stat, true, privateFile, dir);
    return stat;
  });
  const before = fs.lstatSync(target, { throwIfNoEntry: false });
  if (before) checkStat(before, false, privateFile, target);
  let fd;
  try {
    fd = fs.openSync(target, flags | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0), mode);
    const opened = fs.fstatSync(fd);
    checkStat(opened, false, privateFile, target);
    if (opened.size > maxBytes) throw unsafe(target, `file exceeds its ${maxBytes}-byte limit`);
    if (before && !sameFile(before, opened)) throw Object.assign(unsafe(target, 'file was replaced while opening'), { localFileRace: true });
    const after = fs.lstatSync(target);
    checkStat(after, false, privateFile, target);
    if (!sameFile(opened, after)) throw Object.assign(unsafe(target, 'file was replaced while opening'), { localFileRace: true });
    directories.forEach((dir, i) => {
      const stat = directoryStat(dir, i);
      checkStat(stat, true, privateFile, dir);
      if (!sameFile(parents[i], stat)) throw unsafe(dir, 'directory was replaced while opening');
    });
    return fd;
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (error.code === 'ELOOP') throw unsafe(target, 'file became a symbolic link while opening');
    throw error;
  }
}

export function readLocalFile(file, options) {
  const fd = openLocalFile(file, options);
  try { return fs.readFileSync(fd, 'utf8'); }
  finally { fs.closeSync(fd); }
}

export function writeLocalFile(file, contents, options) {
  const fd = openLocalFile(file, { ...options, flags: fs.constants.O_WRONLY });
  try {
    const bytes = Buffer.from(contents, 'utf8');
    fs.ftruncateSync(fd, 0);
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!written) throw new Error('Could not write the local file.');
      offset += written;
    }
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
