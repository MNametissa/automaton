#!/usr/bin/env node
// Installs only beneath --prefix. No global packages, proxy, CA, or AI generators.
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
if (argv.length !== 0 && (argv.length !== 2 || argv[0] !== '--prefix')) {
  throw new Error('Usage: node conway-local/install-analysis-tools.mjs [--prefix PATH]');
}
const prefix = resolve(argv[1] ?? join(here, '../.local-work/tool-runtime'));
const npmRoot = join(prefix, 'rea');
const venv = join(prefix, 'mimic');
const python = join(venv, 'bin/python');
const commit = '8cf998ac0b365806d8e522d34107cc504ecaa345';
const requirements = [
  'requests==2.32.5 --hash=sha256:2462f94637a34fd532264295e186976db0f5d453d1cdd31473c85a6a161affb6',
  'certifi==2026.2.25 --hash=sha256:027692e4402ad994f1c42e52a4997a9763c646b73e4096e4d5d6db8af1d6f0fa',
  'charset-normalizer==3.4.4 --hash=sha256:7a32c560861a02ff789ad905a2fe94e3f840803362c84fecf1851cb4cf3dc37f',
  'idna==3.11 --hash=sha256:771a87f49d9defaf64091e6e6fe9c18d4833f140bd19464795bc32d966ca37ea',
  'urllib3==2.6.3 --hash=sha256:bf272323e553dfb2e87d9bfd225ca7b0f467b919d7bbd355436d3fd37cb0acd4',
  'setuptools==80.9.0 --hash=sha256:062d34222ad13e0cc312a4c02d73f059e86a4acbfbdea8f8f76b28c99f306922',
  'wheel==0.45.1 --hash=sha256:708e7481cc80179af0e556bbf0cc00b8444c7321e2700b8d8580231d13017248',
].join('\n') + '\n';
const env = {
  PATH: process.env.PATH,
  HOME: join(prefix, 'home'),
  LANG: 'C.UTF-8',
  XDG_CACHE_HOME: join(prefix, 'cache'),
  PIP_CACHE_DIR: join(prefix, 'cache/pip'),
  npm_config_cache: join(prefix, 'cache/npm'),
  TMPDIR: join(prefix, 'tmp'),
  GIT_TERMINAL_PROMPT: '0',
};
function run(command, args, cwd = prefix) {
  console.log(JSON.stringify({ command, args, cwd }));
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: false, timeout: 600_000 });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.status}`);
}
await mkdir(npmRoot, { recursive: true });
await mkdir(join(prefix, 'home'), { recursive: true, mode: 0o700 });
await mkdir(join(prefix, 'tmp'), { recursive: true, mode: 0o700 });
await copyFile(join(here, 'analysis-tools/package.json'), join(npmRoot, 'package.json'));
await copyFile(join(here, 'analysis-tools/package-lock.json'), join(npmRoot, 'package-lock.json'));
run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], npmRoot);
run('python3', ['-m', 'venv', venv]);
await writeFile(join(prefix, 'requirements.lock'), requirements);
// Prefer universal wheels so the hash lock works across supported Linux images.
run(python, ['-I', '-m', 'pip', 'download', '--disable-pip-version-check', '--require-hashes', '--only-binary=:all:', '--platform=any', '--no-deps', '--dest', join(prefix, 'python-wheels'), '-r', join(prefix, 'requirements.lock')]);
run(python, ['-I', '-m', 'pip', 'install', '--disable-pip-version-check', '--require-hashes', '--no-index', '--find-links', join(prefix, 'python-wheels'), '-r', join(prefix, 'requirements.lock')]);
run(python, ['-I', '-m', 'pip', 'install', '--disable-pip-version-check', '--no-deps', '--no-build-isolation', `mimic-client @ git+https://github.com/littledivy/mimic.git@${commit}`]);
run(process.execPath, [join(npmRoot, 'node_modules/rea-agents/scripts/rea.mjs'), '--version']);
run(python, ['-I', '-m', 'mimic.cli', '--help']);
await writeFile(join(prefix, 'installed.json'), JSON.stringify({ rea: '6.1.0', mimicCommit: commit, installedAt: new Date().toISOString() }, null, 2) + '\n');
console.log(`Analysis tools installed at ${prefix}`);
