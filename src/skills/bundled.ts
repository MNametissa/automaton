import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { AutomatonDatabase } from '../types.js';
import { parseSkillMd } from './format.js';

const bundleRoot = fileURLToPath(new URL('../../resources/skills/', import.meta.url));
interface Bundle { name: string; path: string; version: string; source: string; sha256: string }

export function loadBundledSkills(db: AutomatonDatabase): void {
  const manifest = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'manifest.json'), 'utf8')) as Bundle[];
  for (const entry of manifest) {
    const file = fs.realpathSync(path.join(bundleRoot, entry.path));
    if (!file.startsWith(fs.realpathSync(bundleRoot) + path.sep)) throw new Error('Invalid bundled skill path');
    const content = fs.readFileSync(file, 'utf8');
    if (createHash('sha256').update(content).digest('hex') !== entry.sha256) throw new Error(`Bundled skill integrity failed: ${entry.name}`);
    const skill = parseSkillMd(content, file);
    if (!skill) throw new Error(`Invalid bundled skill: ${entry.name}`);
    const existing = db.getSkillByName(entry.name);
    db.upsertSkill({ ...skill, name: entry.name, autoActivate: false,
      enabled: existing?.enabled ?? true, installedAt: existing?.installedAt ?? skill.installedAt });
  }
  db.setKV('skills.bundle', JSON.stringify(manifest.map(({ name, version, source, sha256 }) => ({ name, version, source, sha256 }))));
}
