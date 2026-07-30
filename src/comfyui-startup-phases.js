// Maps ComfyUI's stdout to a human startup phase for the connection modal.
//
// Loaded as a plain <script> by index.html and via require() by
// comfyui-startup-phases.check.js — the renderer runs with contextIsolation, so
// it cannot require() this itself.

// Most advanced first, in the order ComfyUI actually reaches them: config,
// security scan, prestartup scripts, GPU/torch, custom nodes, server. The phase
// never moves backwards, so a late line from an earlier stage cannot undo
// progress already reported.
const COMFY_STARTUP_PHASES = [
  [/To see the GUI go to|Starting server/i, 'Server is starting - almost ready'],
  [/Import times for custom nodes/i, 'Custom nodes loaded, starting server'],
  [null, 'Loading custom nodes'], // reached via node paths, see below
  [/Device:\s*cuda|Total VRAM|pytorch version/i, 'Initialising GPU and PyTorch'],
  [/Prestartup times for custom nodes|\[DONE\] Security scan/i, 'Running startup scripts'],
  [/\[START\] Security scan/i, 'Running security scan'],
  [/ComfyUI startup time|Adding extra search path/i, 'Reading ComfyUI configuration']
];

const GPU_PHASE = 'Initialising GPU and PyTorch';
const NODE_PHASE = 'Loading custom nodes';

// ComfyUI does not announce each custom node as it loads - it prints import
// times only once they have all finished. Nodes do print their own arbitrary
// messages though, and the path in them names the node, which is the closest
// thing to a "currently loading X" signal the log offers.
// Closing brackets and commas are excluded because nodes print their path
// inside things like "[C:\...\custom_nodes\comfyui_controlnet_aux] | INFO -> ".
const CUSTOM_NODE_PATH = /custom_nodes[\\/]([^\\/\s:'"\]),]+)/i;

// ComfyUI colours its output, and the codes survive redirection to a file.
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;

// A bare "[INFO]" with nothing after it is not worth showing to the user.
const LEADING_LEVEL_TAG = /^\[[A-Z]+\]\s*/;

// Pure: returns the state advanced by these lines, never mutating the input.
function advanceComfyStartup(state, lines) {
  let { phase, detail } = state || {};
  phase = phase || '';
  detail = detail || '';

  for (const raw of lines) {
    if (!raw) continue;
    const line = raw.replace(ANSI_ESCAPE, '').trim();
    if (!line) continue;

    const node = line.match(CUSTOM_NODE_PATH);
    const text = line.replace(LEADING_LEVEL_TAG, '').trim();
    if (node) detail = `Loading ${node[1]}`;
    else if (text) detail = text;

    let reached = COMFY_STARTUP_PHASES.findIndex(p => p[0] && p[0].test(line));
    // The prestartup block prints custom_nodes paths in exactly the same shape
    // as the node-loading ones, so a node name only means node loading once GPU
    // init - which always lands between the two - has been reported.
    if (reached === -1 && node && phase === GPU_PHASE) {
      reached = COMFY_STARTUP_PHASES.findIndex(p => p[1] === NODE_PHASE);
    }
    if (reached === -1) continue;

    const current = COMFY_STARTUP_PHASES.findIndex(p => p[1] === phase);
    if (current === -1 || reached < current) phase = COMFY_STARTUP_PHASES[reached][1];
  }

  return { phase, detail };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { COMFY_STARTUP_PHASES, CUSTOM_NODE_PATH, advanceComfyStartup };
}
