// Self-check for comfyui-startup-phases.js.
// Run: node src/comfyui-startup-phases.check.js
//
// The sample lines below are copied verbatim from a real ComfyUI 0.29 startup
// log. If ComfyUI changes its wording the phases go silent, and this is what
// catches it.

const assert = require('assert');
const { advanceComfyStartup } = require('./comfyui-startup-phases');

const STARTUP_LOG = [
  '[INFO] Adding extra search path checkpoints C:\\Users\\me\\ComfyUI-Shared\\models\\checkpoints',
  '[INFO] Setting output directory to: D:\\ComfyUI Output',
  '[START] Security scan',
  '[DONE] Security scan',
  '** ComfyUI startup time: 2026-07-30 08:45:48.130',
  '[INFO] [PRE] ComfyUI-Manager',
  'Prestartup times for custom nodes:',
  '[INFO]    0.0 seconds: C:\\AI\\ComfyUI\\ComfyUI\\custom_nodes\\rgthree-comfy',
  '[INFO] Total VRAM 12287 MB, total RAM 32705 MB',
  '[INFO] Device: cuda:0 NVIDIA GeForce RTX 3060 : cudaMallocAsync',
  '[ComfyUI-Easy-Use] web root: C:\\AI\\ComfyUI\\ComfyUI\\custom_nodes\\comfyui-easy-use\\web_version/v2 Loaded',
  'Import times for custom nodes:',
  '[INFO]    0.0 seconds: C:\\AI\\ComfyUI\\ComfyUI\\custom_nodes\\ComfyUI-GGUF',
  '[INFO] Starting server',
  '[INFO] To see the GUI go to: http://127.0.0.1:8188'
];

// Feed the log one line at a time, as the tail actually delivers it, and record
// the phase after each.
let state = { phase: '', detail: '' };
const phaseAfter = STARTUP_LOG.map(line => {
  state = advanceComfyStartup(state, [line]);
  return state.phase;
});

const at = (needle) => phaseAfter[STARTUP_LOG.findIndex(l => l.includes(needle))];

assert.strictEqual(at('Adding extra search path'), 'Reading ComfyUI configuration');
assert.strictEqual(at('[START] Security scan'), 'Running security scan');
assert.strictEqual(at('[DONE] Security scan'), 'Running startup scripts');
assert.strictEqual(at('Device: cuda:0'), 'Initialising GPU and PyTorch');
assert.strictEqual(at('Import times for custom nodes'), 'Custom nodes loaded, starting server');
assert.strictEqual(at('To see the GUI go to'), 'Server is starting - almost ready');

// '** ComfyUI startup time' matches the earliest phase but arrives after the
// security scan, so it must not drag the reported phase backwards.
assert.strictEqual(at('ComfyUI startup time'), 'Running startup scripts',
  'phase must never regress');

// A node path printed during the prestartup block must NOT be mistaken for the
// custom-node loading stage; one printed after GPU init must be.
assert.strictEqual(at('rgthree-comfy'), 'Running startup scripts',
  'prestartup node paths are not node loading');
assert.strictEqual(at('web root'), 'Loading custom nodes',
  'a node path after GPU init means nodes are loading');

// Custom node names are the "currently loading X" signal, pulled out of
// whatever path the node happens to print.
assert.strictEqual(
  advanceComfyStartup({}, ['[ComfyUI-Easy-Use] web root: C:\\AI\\ComfyUI\\ComfyUI\\custom_nodes\\comfyui-easy-use\\web_version/v2 Loaded']).detail,
  'Loading comfyui-easy-use');
assert.strictEqual(
  advanceComfyStartup({}, ['[INFO]    0.4 seconds: C:\\AI\\ComfyUI\\ComfyUI\\custom_nodes\\ComfyUI-GGUF']).detail,
  'Loading ComfyUI-GGUF');

// A line naming no node is still worth showing, minus its level tag.
assert.strictEqual(
  advanceComfyStartup({}, ['[INFO] pytorch version: 2.10.0+cu130']).detail,
  'pytorch version: 2.10.0+cu130');

// ComfyUI colours its output and the escape codes survive redirection; they
// must not reach the UI, and must not stop a phase from being recognised.
const coloured = '\x1b[32m[INFO]\x1b[0m Device: cuda:0 NVIDIA GeForce RTX 3060 : cudaMallocAsync';
const fromColoured = advanceComfyStartup({}, [coloured]);
assert.ok(!/\x1b|\[32m/.test(fromColoured.detail), 'ANSI codes are stripped from the detail');
assert.strictEqual(fromColoured.detail, 'Device: cuda:0 NVIDIA GeForce RTX 3060 : cudaMallocAsync');
assert.strictEqual(fromColoured.phase, 'Initialising GPU and PyTorch',
  'a coloured line still matches its phase');

// Nodes print their path inside brackets — the name must not keep the bracket.
assert.strictEqual(
  advanceComfyStartup({}, ['[C:\\AI\\ComfyUI\\ComfyUI\\custom_nodes\\comfyui_controlnet_aux] | INFO -> Using ckpts path']).detail,
  'Loading comfyui_controlnet_aux');

// A bare level tag carries nothing; keep whatever was on screen instead.
assert.strictEqual(
  advanceComfyStartup({ detail: 'keep me' }, ['\x1b[32m[INFO]\x1b[0m']).detail, 'keep me');

// The input state is never mutated.
const before = { phase: 'Running security scan', detail: 'x' };
advanceComfyStartup(before, ['[INFO] Starting server']);
assert.strictEqual(before.phase, 'Running security scan', 'input state must not be mutated');

// Empty and blank lines are ignored rather than blanking the detail.
assert.strictEqual(advanceComfyStartup({ detail: 'keep me' }, ['']).detail, 'keep me');

console.log('comfyui-startup-phases: all checks passed');
