import fs from 'node:fs';
import path from 'node:path';
import { authDirectory } from './auth-credentials.js';
import { openLocalFile, readLocalFile } from './local-file.js';
import { NansenError } from './api.js';

const unavailable = () => new NansenError('Private feedback recovery storage is unavailable. Repair ~/.nansen/feedback, or submit with a caller-managed --submission-id and keep the unchanged file.', 'feedback_storage_unavailable');
const cleared = { version: 1, state: 'cleared' };
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function feedbackExpiry(now) {
  const date = new Date(now), month = date.getUTCMonth();
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  if (date.getUTCMonth() !== month) date.setUTCDate(0);
  return date.toISOString();
}

// One active submission. The cleared marker contains no report or identity and
// prevents expiry/erasure from turning a later retry into a new submission.
export async function withFeedbackJournal(operation, { erase = false } = {}) {
  let fd, native, locked = false;
  const root = authDirectory(), directory = path.join(root, 'feedback');
  const file = path.join(directory, 'recovery.json'), temp = path.join(directory, 'recovery.tmp');
  const privatePath = (target, isDirectory) => {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || (isDirectory ? !stat.isDirectory() : !stat.isFile()) ||
        stat.uid !== process.getuid() || (stat.mode & (isDirectory ? 0o077 : 0o177)) || (!isDirectory && stat.nlink !== 1)) throw unavailable();
  };
  const syncDirectory = () => {
    const descriptor = fs.openSync(directory, 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  };
  const save = value => {
    let descriptor;
    try {
      privatePath(root, true); privatePath(directory, true);
      descriptor = openLocalFile(temp, { root, privateFile: true, flags: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL });
      fs.writeFileSync(descriptor, JSON.stringify(value)); fs.fsyncSync(descriptor);
      fs.closeSync(descriptor); descriptor = undefined;
      fs.renameSync(temp, file); syncDirectory();
    } catch { throw unavailable(); }
    finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  };
  let entry;
  try {
    // POSIX modes cannot establish private Windows ACLs. Fail before sending.
    if (process.platform === 'win32') throw unavailable();
    fs.mkdirSync(root, { recursive: true, mode: 0o700 }); privatePath(root, true);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); privatePath(directory, true);
    native = (await import('fs-native-extensions')).default;
    fd = openLocalFile(path.join(directory, 'recovery.lock'), { root, privateFile: true, flags: fs.constants.O_RDWR | fs.constants.O_CREAT });
    privatePath(path.join(directory, 'recovery.lock'), false);
    locked = native.tryLock(fd);
    if (!locked) throw new NansenError('Another feedback command is running. Retry after it finishes.', 'feedback_busy');
    // A killed writer may leave an uncommitted temp file. It was never sent.
    if (fs.lstatSync(temp, { throwIfNoEntry: false })) {
      if (!erase) privatePath(temp, false);
      fs.unlinkSync(temp); syncDirectory();
    }
    // Erasure atomically replaces even a damaged or insecure journal without
    // reading it. Never unlink it first: a crash in that gap could look new.
    if (!erase && fs.lstatSync(file, { throwIfNoEntry: false })) {
      privatePath(file, false);
      entry = JSON.parse(readLocalFile(file, { root, privateFile: true, maxBytes: 100000 }));
      const keys = entry.state === 'pending' ? ['version', 'state', 'submission_id', 'account', 'environment', 'expires_at', 'body'] :
        entry.state === 'confirmed' ? ['version', 'state', 'submission_id', 'account', 'environment', 'expires_at', 'feedback_id'] : ['version', 'state'];
      if (entry.version !== 1 || !['pending', 'confirmed', 'cleared'].includes(entry.state) ||
          Object.keys(entry).some(key => !keys.includes(key)) || keys.some(key => !(key in entry)) ||
          (entry.state !== 'cleared' && (!/^[A-Za-z0-9_-]{1,128}$/.test(entry.submission_id) ||
            typeof entry.account !== 'string' || !entry.account || typeof entry.environment !== 'string' || !timestamp(entry.expires_at))) ||
          (entry.state === 'pending' && typeof entry.body !== 'string') ||
          (entry.state === 'confirmed' && typeof entry.feedback_id !== 'string')) throw unavailable();
      if (entry.state !== 'cleared' && Date.parse(entry.expires_at) <= Date.now()) { save(cleared); entry = cleared; }
    }
  } catch (error) {
    if (fd !== undefined) { if (locked) native.unlock(fd); fs.closeSync(fd); }
    if (error.code === 'feedback_busy') throw error;
    throw unavailable();
  }
  try { return await operation({ entry, save, clear: () => save(cleared) }); }
  finally { try { native.unlock(fd); } finally { fs.closeSync(fd); } }
}
