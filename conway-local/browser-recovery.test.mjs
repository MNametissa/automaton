import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recoverDesktopBrowserProfiles } from './desktop/browser-recovery.mjs';

test('exclusive desktop startup removes stale Chromium singleton links and preserves profile data', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'browser-recovery-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const profile=path.join(root,'main','profile'); fs.mkdirSync(profile,{recursive:true});
  fs.writeFileSync(path.join(profile,'Cookies'),'preserve');
  for(const name of ['SingletonLock','SingletonSocket','SingletonCookie']) fs.symlinkSync('old-container-389',path.join(profile,name));
  assert.equal(recoverDesktopBrowserProfiles(root),3);
  assert.equal(fs.readFileSync(path.join(profile,'Cookies'),'utf8'),'preserve');
  assert.equal(recoverDesktopBrowserProfiles(root),0);
});

test('startup recovery never follows session/profile symlinks or removes unexpected files', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'browser-recovery-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const outside=path.join(root,'outside'); fs.mkdirSync(outside);
  fs.symlinkSync('live-host-12',path.join(outside,'SingletonLock'));
  const state=path.join(root,'browser'); fs.mkdirSync(state);
  fs.symlinkSync(outside,path.join(state,'linked-session'));
  fs.mkdirSync(path.join(state,'main'));
  fs.symlinkSync(outside,path.join(state,'main','profile'));
  fs.mkdirSync(path.join(state,'worker','profile'),{recursive:true});
  fs.writeFileSync(path.join(state,'worker','profile','SingletonCookie'),'keep regular file');
  assert.equal(recoverDesktopBrowserProfiles(state),0);
  assert.equal(fs.readlinkSync(path.join(outside,'SingletonLock')),'live-host-12');
  assert.equal(fs.readFileSync(path.join(state,'worker','profile','SingletonCookie'),'utf8'),'keep regular file');
  assert.equal(recoverDesktopBrowserProfiles(path.join(root,'absent')),0);
  fs.symlinkSync(state,path.join(root,'linked-root'));
  assert.throws(()=>recoverDesktopBrowserProfiles(path.join(root,'linked-root')),/real directory/);
});
