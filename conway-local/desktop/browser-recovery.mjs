import fs from 'node:fs';
import path from 'node:path';

// Only at container bootstrap, before any browser starts, on this desktop's
// exclusively mounted state volume. Never call while a browser can be running.
// A replacement container has a new hostname, so Chromium cannot itself prove
// that the previous container's persistent-profile locks are stale.
export function recoverDesktopBrowserProfiles(root) {
  let stat;
  try { stat = fs.lstatSync(root); }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  if (!stat.isDirectory()) throw new Error('Browser state must be a real directory');
  let removed = 0;
  for (const session of fs.readdirSync(root, { withFileTypes: true })) {
    if (!session.isDirectory()) continue;
    const profile = path.join(root, session.name, 'profile');
    try { if (!fs.lstatSync(profile).isDirectory()) continue; }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      const file = path.join(profile, name);
      try {
        if (fs.lstatSync(file).isSymbolicLink()) { fs.unlinkSync(file); removed++; }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return removed;
}
