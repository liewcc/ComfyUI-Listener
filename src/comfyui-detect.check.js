// Self-check for comfyui-detect.js. Run: node src/comfyui-detect.check.js
// Builds a fake Comfy Desktop layout in a temp dir and asserts that detection
// picks the right install and that the generated launcher is well-formed.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { detect, buildLauncherScripts } = require('./comfyui-detect');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-detect-'));
const appDataDir = path.join(root, 'AppData');
const desktopDir = path.join(appDataDir, 'Comfy Desktop');
fs.mkdirSync(desktopDir, { recursive: true });

// Two installs whose directories exist, plus a cloud entry and a stale entry
// whose files were deleted. Path has a space on purpose.
function makeInstallDir(name) {
  const installPath = path.join(root, name);
  const comfyDir = path.join(installPath, 'ComfyUI');
  fs.mkdirSync(path.join(comfyDir, '.venv', 'Scripts'), { recursive: true });
  fs.writeFileSync(path.join(comfyDir, 'main.py'), '');
  fs.writeFileSync(path.join(comfyDir, '.venv', 'Scripts', 'python.exe'), '');
  return installPath;
}

const oldInstall = makeInstallDir('My ComfyUI Old');
const newInstall = makeInstallDir('My ComfyUI New');

fs.writeFileSync(path.join(desktopDir, 'installations.json'), JSON.stringify([
  { installPath: oldInstall, status: 'installed', lastLaunchedAt: 100, launchArgs: '--enable-manager' },
  { sourceId: 'cloud', status: 'installed', lastLaunchedAt: 999 },
  { installPath: path.join(root, 'Uninstalled'), status: 'installed', lastLaunchedAt: 500 },
  { installPath: newInstall, status: 'installed', lastLaunchedAt: 300, launchArgs: '--enable-manager --port 9999' }
]));
fs.writeFileSync(path.join(desktopDir, 'settings.json'), JSON.stringify({
  outputDir: 'D:\\ComfyUI Output',
  inputDir: 'D:\\ComfyUI Input'
}));
fs.writeFileSync(path.join(desktopDir, 'shared_model_paths.yaml'), '');

const candidate = detect({ appDataDir, homeDir: path.join(root, 'nope') });
assert.ok(candidate, 'should find a Comfy Desktop install');

// Most recently launched *usable* install wins; the cloud entry has no
// installPath and the stale entry has no main.py on disk.
assert.strictEqual(candidate.comfyDir, path.join(newInstall, 'ComfyUI'));
assert.strictEqual(candidate.kind, 'desktop');

// Desktop's own --port must not survive — the listener dials a port of its own.
assert.ok(!candidate.extraArgs.includes('--port'), 'saved --port should be stripped');
assert.ok(!candidate.extraArgs.includes('9999'), 'stripped --port must take its value with it');
assert.ok(candidate.extraArgs.includes('--enable-manager'), 'other launch args are kept');

const batPath = path.join(root, 'start_comfyui_server.bat');
const { bat, vbs } = buildLauncherScripts(candidate, 8188, batPath);

// Values are quoted unconditionally — cmd strips them before python sees them.
assert.ok(bat.includes('--port "8188"'), 'bat carries the requested port');
assert.ok(bat.includes(`"${candidate.python}"`), 'interpreter is quoted');
assert.ok(bat.includes(`cd /d "${candidate.comfyDir}"`), 'runs from the ComfyUI directory');
assert.ok(bat.includes('"D:\\ComfyUI Output"'), 'paths with spaces are quoted');
assert.ok(!/^pause/m.test(bat), 'no pause — the window is hidden and would hang');

assert.ok(vbs.includes(`"""${batPath}"""`), 'vbs quotes the bat path for Run()');
assert.ok(vbs.includes(', 0, False'), 'vbs must run the bat with a hidden window');

// A machine with neither Comfy Desktop nor a portable install finds nothing.
assert.strictEqual(
  detect({ appDataDir: path.join(root, 'empty'), homeDir: path.join(root, 'empty') }),
  null,
  'no install anywhere should return null'
);

fs.rmSync(root, { recursive: true, force: true });
console.log('comfyui-detect: all checks passed');
