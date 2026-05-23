// Register global error logging to file
window.onerror = function (message, source, lineno, colno, error) {
  const errMsg = `Global JS Error: ${message} at ${source}:${lineno}:${colno}`;
  if (window.api && typeof window.api.logDebug === 'function') {
    window.api.logDebug({ message: errMsg });
  }
  console.error(errMsg, error);
  return false;
};

window.addEventListener('unhandledrejection', function (event) {
  const errMsg = `Global Unhandled Promise Rejection: ${event.reason}`;
  if (window.api && typeof window.api.logDebug === 'function') {
    window.api.logDebug({ message: errMsg });
  }
  console.error(errMsg, event.reason);
});

// Global Application State
let comfyuiUrl = 'http://127.0.0.1:8188';
let comfyOutputDir = '';  // Local path to ComfyUI's output folder (for Open in Viewer)
let clientId = generateUUID();
let ws = null;
let wsInstance = null; // Unique token to detect stale WebSocket handlers
let isConnecting = false; // Guard against concurrent connection attempts
let currentWorkflow = null;
let currentWorkflowFilename = '';
let activePromptId = null;
let pendingPromptId = null; // Captures prompt_id from execution_start before POST response returns
let savedForPromptId = null;  // Prevents duplicate auto-saves when multiple output nodes fire 'executed'
let promptSavedPath   = null;  // Local path of the file saved for the current prompt (shared across multiple output nodes)
let paramMappings = []; // Array to track custom inputs and their corresponding nodes in the workflow JSON
let imageSlots = []; // Array of { nodeId, rotateNodeId, enabled, rotation } — one entry per LoadImage node found in workflow
let historyImages = [];
let outputFolderPath = '';
let currentPreviewUrl = null; // Stores object URL for active generation's in-progress preview
let lastSubmittedWorkflow = null; // Snapshot of the workflow actually sent (with randomized seeds)
let webUiWorkflow = null;         // Optional web-UI format workflow JSON for PNG metadata embedding
let isCompareMode = false;        // Active state of image comparison mode
let selectedCompareSlot = 0;      // Current compare slot selected (0: Slot 1, 1: Slot 2, 2: Slot 3)

// Global progress state for multi-sampler workflow tracking (fully dynamic — discovered from live WS events)
let totalWorkflowSteps = 0;      // Running estimate of total steps (updated as new sampler nodes are seen)
let currentExecutionSteps = 0;   // Accumulated steps of completed sampler nodes in current run
let lastSamplerNodeId = null;    // The ID of the KSampler currently (or most recently) executing
let lastSamplerStep = 0;         // Last reported step of the current KSampler node
let samplerNodeMaxMap = {};       // Maps nodeId -> max steps, discovered from live progress events
let estimatedSamplerCount = 0;   // Number of sampler nodes in the workflow (used for early estimate)


// Helper: Proxy HTTP requests to ComfyUI through Electron Main Process to completely bypass browser CORS limits
async function comfyFetch(path, options = {}) {
  const url = `${comfyuiUrl}${path}`;
  
  let bodyData = null;
  if (options.body) {
    try {
      bodyData = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    } catch (e) {
      bodyData = options.body;
    }
  }

  const response = await window.api.comfyRequest({
    url,
    method: options.method || 'GET',
    body: bodyData,
    headers: options.headers || {}
  });
  
  if (!response.ok) {
    throw new Error(response.error || `HTTP Error: ${response.status}`);
  }
  
  return {
    ok: response.ok,
    status: response.status,
    json: async () => response.data
  };
}

// Initialize DOM elements
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initConnection();
  initWorkflowLoader();
  initWebUiWorkflowLoader();
  initGeneration();
  initOutputSettings();
  initCompareFeature();
});

// Helper: Generate UUID for ComfyUI client identification
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// 1. Navigation Tab Switching
function initTabs() {
  const navItems = document.querySelectorAll('.nav-item');
  const tabPanes = document.querySelectorAll('.tab-pane');
  
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const tabId = item.getAttribute('data-tab');
      
      // Open file explorer if open-output-folder clicked and return early without switching tabs
      if (tabId === 'tab-open-output-folder') {
        if (outputFolderPath) {
          window.api.openPath({ path: outputFolderPath }).then(result => {
            if (!result.ok) {
              showToast('Explorer Error', result.error || 'Could not open folder', 'error');
            }
          });
        } else {
          showToast('Output Folder Not Configured', 'Please configure an output folder in Output Setting to enable File Explorer access.', 'warning');
        }
        return;
      }
      
      // Update tab selection visually first for other tabs
      navItems.forEach(nav => nav.classList.remove('active'));
      tabPanes.forEach(pane => pane.classList.remove('active'));
      
      item.classList.add('active');
      const activePane = document.getElementById(tabId);
      if (activePane) activePane.classList.add('active');
    });
  });
}

// 2. Connection Management (REST & WebSockets)
function initConnection() {
  const urlInput = document.getElementById('comfyui-url');
  const btnConnect = document.getElementById('btn-connect');
  const previewSelect = document.getElementById('preview-method-select');

  // Load saved ComfyUI address from localStorage
  const savedUrl = localStorage.getItem('comfyui_url');
  if (savedUrl) {
    comfyuiUrl = savedUrl;
    urlInput.value = savedUrl;
  }

  // ── ComfyUI Output Dir ────────────────────────────────────────────────────
  const outputDirInput = document.getElementById('comfyui-output-dir');
  const btnSelectOutputDir = document.getElementById('btn-select-comfyui-output-dir');
  const savedOutputDir = localStorage.getItem('comfyui_output_dir') || '';
  if (savedOutputDir) {
    comfyOutputDir = savedOutputDir;
    if (outputDirInput) outputDirInput.value = savedOutputDir;
  }
  if (btnSelectOutputDir && outputDirInput) {
    btnSelectOutputDir.addEventListener('click', async () => {
      const result = await window.api.selectOutputFolder();
      if (result) {
        comfyOutputDir = result;
        outputDirInput.value = result;
        localStorage.setItem('comfyui_output_dir', result);
      }
    });
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Load saved preview method from localStorage (default: 'auto')
  const savedPreviewMethod = localStorage.getItem('preview_method') || 'auto';
  if (previewSelect) {
    previewSelect.value = savedPreviewMethod;
    previewSelect.addEventListener('change', () => {
      localStorage.setItem('preview_method', previewSelect.value);
    });
  }

  btnConnect.addEventListener('click', () => {
    comfyuiUrl = urlInput.value.trim().replace(/\/$/, ""); // Trim trailing slash
    localStorage.setItem('comfyui_url', comfyuiUrl);
    connectToComfyUI();
  });

  // Try auto-connecting on start
  connectToComfyUI();
}

function connectToComfyUI() {
  // Prevent concurrent connection attempts — avoids duplicate WebSocket handlers
  if (isConnecting) {
    window.api.logDebug({ message: 'connectToComfyUI: skipped (already connecting)' });
    return;
  }
  isConnecting = true;

  updateConnectionStatus('connecting', 'Connecting...');

  // Close existing socket synchronously before starting a new one
  if (ws) {
    const old = ws;
    ws = null;
    wsInstance = null;
    try { old.close(); } catch (e) {}
  }

  // Check HTTP API first
  comfyFetch(`/system_stats`)
    .then(response => {
      return response.json();
    })
    .then(stats => {
      // Connect WebSocket
      const wsUrl = comfyuiUrl.replace(/^http/, 'ws') + `/ws?clientId=${clientId}`;
      setupWebSocket(wsUrl);
    })
    .catch(err => {
      console.error('ComfyUI Connection error:', err);
      updateConnectionStatus('disconnected', 'Failed to connect (Not running/wrong address)');
    })
    .finally(() => {
      isConnecting = false;
    });
}

function updateConnectionStatus(state, label) {
  if (window.api && typeof window.api.logDebug === 'function') {
    window.api.logDebug({ message: `updateConnectionStatus: state=${state}, label=${label}, hasWorkflow=${!!currentWorkflow}` });
  }
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  
  statusDot.className = `status-dot ${state}`;
  statusText.textContent = label;
  
  const btnGenerate = document.getElementById('btn-generate');
  if (state === 'connected' && currentWorkflow) {
    btnGenerate.classList.remove('btn-disabled');
    btnGenerate.disabled = false;
  } else {
    btnGenerate.classList.add('btn-disabled');
    btnGenerate.disabled = true;
    if (state === 'disconnected') {
      btnGenerate.innerHTML = `
        <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        <span>Generate Image</span>
      `;
      btnGenerate.classList.remove('btn-danger');
      btnGenerate.classList.add('btn-primary');
    }
  }
}

function setupWebSocket(wsUrl) {
  // Assign a unique token to this particular socket instance.
  // Each handler closure captures its own token; if the global wsInstance
  // has changed by the time the handler fires, the handler is stale and ignored.
  const myToken = Symbol('ws-token');
  wsInstance = myToken;

  const socket = new WebSocket(wsUrl);
  socket.binaryType = 'arraybuffer';
  ws = socket;

  socket.onopen = () => {
    if (wsInstance !== myToken) return; // Stale handler — a newer connection replaced us
    updateConnectionStatus('connected', 'Connected');
    checkQueueStatus();
    // Refresh image previews that couldn't load before connection was ready (e.g. on app restart)
    refreshImagePreviews();
  };

  socket.onmessage = (event) => {
    if (wsInstance !== myToken) return; // Stale handler — ignore
    try {
      // ── Diagnostic: log the raw data type of every incoming frame ───────────
      // This tells us whether binary frames arrive at all, and as what type.
      if (event.data instanceof ArrayBuffer) {
        console.log(`[WS RAW] Binary ArrayBuffer received, byteLength=${event.data.byteLength}`);
        handleBinaryMessage(event.data);
        return;
      }
      if (event.data instanceof Blob) {
        console.log(`[WS RAW] Binary Blob received, size=${event.data.size} — converting to ArrayBuffer`);
        event.data.arrayBuffer().then(buf => handleBinaryMessage(buf));
        return;
      }
      // ── String (JSON) message ─────────────────────────────────────────────
      if (typeof event.data === 'string') {
        window.api.logDebug({ message: `WS Raw: ${event.data.substring(0, 300)}` });
      } else {
        console.warn('[WS RAW] Unknown data type:', typeof event.data, event.data);
      }
      const data = JSON.parse(event.data);
      handleWebSocketMessage(data);
    } catch (e) {
      window.api.logDebug({ message: `WS error parsing: ${e.message}` });
      console.error('Failed to parse WS data:', e);
    }
  };

  socket.onerror = (err) => {
    if (wsInstance !== myToken) return;
    console.error('WS Error:', err);
    updateConnectionStatus('disconnected', 'WebSocket Error');
  };

  socket.onclose = () => {
    if (wsInstance !== myToken) return;
    const statusDot = document.getElementById('status-dot');
    if (statusDot.classList.contains('connected')) {
      updateConnectionStatus('disconnected', 'Connection Closed');
    }
  };
}

async function checkQueueStatus() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  
  try {
    const response = await comfyFetch(`/queue`);
    const data = await response.json();
    const running = data.queue_running.length;
    const pending = data.queue_pending.length;
    document.getElementById('queue-status').textContent = `Running: ${running} / Pending: ${pending}`;
  } catch (err) {
    document.getElementById('queue-status').textContent = 'Fetch Failed';
  }
}

// 3. Workflow File Loading & Dynamic Input UI Generation
function initWorkflowLoader() {
  const btnLoad   = document.getElementById('btn-load-workflow');
  const btnReload = document.getElementById('btn-reload-workflow');

  // Load button — opens file picker for API format
  if (btnLoad) {
    btnLoad.addEventListener('click', async () => {
      try {
        const fileData = await window.api.selectWorkflowFile();
        if (fileData) loadWorkflow(fileData.content, fileData.fileName);
      } catch (err) {
        alert(err.message);
      }
    });
  }

  // Reload / clear button (hidden, used programmatically)
  if (btnReload) {
    btnReload.addEventListener('click', () => {
      currentWorkflow = null;
      localStorage.removeItem('comfyui_workflow_json');
      localStorage.removeItem('comfyui_workflow_filename');
      const filenameEl = document.getElementById('workflow-filename');
      if (filenameEl) { filenameEl.value = ''; filenameEl.classList.remove('loaded'); }

      document.getElementById('no-params-msg').classList.remove('hidden');
      document.getElementById('dynamic-params-container').classList.add('hidden');
      document.getElementById('params-count').textContent = '0 parameters detected';

      const qwenPanel = document.getElementById('qwen-prompts-panel');
      if (qwenPanel) qwenPanel.classList.add('hidden');
      const qwenContainer = document.getElementById('qwen-prompts-container');
      if (qwenContainer) qwenContainer.innerHTML = '';
      const qwenCountBadge = document.getElementById('qwen-params-count');
      if (qwenCountBadge) qwenCountBadge.textContent = '0 prompts';

      const inputImagesPanel = document.getElementById('input-images-panel');
      if (inputImagesPanel) inputImagesPanel.classList.add('hidden');
      const inputImagesContainer = document.getElementById('input-images-container');
      if (inputImagesContainer) inputImagesContainer.innerHTML = '';
      const inputImagesCount = document.getElementById('input-images-count');
      if (inputImagesCount) inputImagesCount.textContent = '0 active';
      imageSlots = [];

      const sidebarBadge = document.getElementById('sidebar-params-badge');
      if (sidebarBadge) { sidebarBadge.style.display = 'none'; sidebarBadge.textContent = '0'; }

      const btnGenerate = document.getElementById('btn-generate');
      btnGenerate.classList.add('btn-disabled');
      btnGenerate.disabled = true;

      // Reset compare mode and update button state
      toggleCompareMode(false);
      updateCompareButtonState();
    });
  }

  // Load persisted API workflow from localStorage on startup
  const savedWorkflowStr = localStorage.getItem('comfyui_workflow_json');
  const savedFilename    = localStorage.getItem('comfyui_workflow_filename');
  if (savedWorkflowStr && savedFilename) {
    try {
      loadWorkflow(JSON.parse(savedWorkflowStr), savedFilename);
    } catch (e) {
      console.error('Failed to restore persisted workflow:', e);
      localStorage.removeItem('comfyui_workflow_json');
      localStorage.removeItem('comfyui_workflow_filename');
    }
  }
}

function saveWorkflowToLocalStorage() {
  if (currentWorkflow) {
    // Collect the current values from the DOM inputs and write them into currentWorkflow
    paramMappings.forEach(mapping => {
      const inputEl = document.getElementById(mapping.elementId);
      if (inputEl) {
        let value = inputEl.value;
        if (mapping.type === 'number') {
          value = Number(value);
        }
        if (currentWorkflow[mapping.nodeId] && currentWorkflow[mapping.nodeId].inputs) {
          currentWorkflow[mapping.nodeId].inputs[mapping.key] = value;
        }
      }
    });

    // Also persist image slot rotation values back into the workflow JSON
    imageSlots.forEach(slotState => {
      if (!slotState.nodeId) return;
      // Persist image filename
      const hiddenInput = document.getElementById(`img-slot-${slotState.slotIndex}-hidden`);
      if (hiddenInput && hiddenInput.value && currentWorkflow[slotState.nodeId]) {
        currentWorkflow[slotState.nodeId].inputs.image = hiddenInput.value;
      }
      // Persist rotation value
      if (slotState.rotateNodeId && currentWorkflow[slotState.rotateNodeId]) {
        currentWorkflow[slotState.rotateNodeId].inputs.rotation = slotState.rotation;
      }
    });

    localStorage.setItem('comfyui_workflow_json', JSON.stringify(currentWorkflow));
    localStorage.setItem('comfyui_workflow_filename', currentWorkflowFilename);
  }
}


function loadWorkflow(workflowJson, filename) {
  // ComfyUI workflows can be in API format or standard UI format.
  // Standard UI format has 'templates' / 'nodes'. API format has direct numerical keys.
  // The API uses the direct numerical keys version (API Format). We look for that.
  let isApiFormat = true;
  
  // Simple check: API format has keys that are numeric (strings) representing nodes
  const keys = Object.keys(workflowJson);
  const numericKeys = keys.filter(k => !isNaN(parseInt(k)));
  
  if (numericKeys.length === 0) {
    isApiFormat = false;
  }
  
  if (!isApiFormat) {
    alert("This JSON file is in standard 'Web Format' instead of 'API Format'!\n\nTo export the correct format: In ComfyUI settings, check 'Enable Dev mode', then click 'Save (API Format)' in the menu.");
    return;
  }

  currentWorkflow = workflowJson;
  currentWorkflowFilename = filename;

  localStorage.setItem('comfyui_workflow_json', JSON.stringify(workflowJson));
  localStorage.setItem('comfyui_workflow_filename', filename);

  // Show loaded filename in the text input
  const filenameEl = document.getElementById('workflow-filename');
  if (filenameEl) {
    filenameEl.value = filename;
    filenameEl.classList.add('loaded');
  }

  // Parse parameters dynamically
  generateDynamicParamsUI(workflowJson);

  // Enable Generate button if connected
  const statusDot = document.getElementById('status-dot');
  if (statusDot.classList.contains('connected')) {
    const btnGenerate = document.getElementById('btn-generate');
    btnGenerate.classList.remove('btn-disabled');
    btnGenerate.disabled = false;
  }
  updateCompareButtonState();
}

// Generate UI elements dynamically from nodes in workflow JSON
function generateDynamicParamsUI(workflow) {
  const container = document.getElementById('dynamic-params-container');
  container.innerHTML = '';
  const qwenContainer = document.getElementById('qwen-prompts-container');
  if (qwenContainer) {
    qwenContainer.innerHTML = '';
  }
  const imagesContainer = document.getElementById('input-images-container');
  if (imagesContainer) {
    imagesContainer.innerHTML = '';
  }
  paramMappings = [];
  imageSlots = [];
  
  let paramCount = 0;
  let qwenCount = 0;

  // --- Pre-scan: build a map of LoadImage nodes and their associated ImageRotate nodes ---
  // For each LoadImage node, find ImageRotate nodes whose `image` input links to it.
  const loadImageNodes = {}; // nodeId -> node
  const rotateNodeForLoad = {}; // loadImageNodeId -> rotateNodeId

  for (const nodeId in workflow) {
    const node = workflow[nodeId];
    if (!node || !node.inputs) continue;
    if (node.class_type === 'LoadImage') {
      loadImageNodes[nodeId] = node;
    }
  }

  // Find ImageRotate nodes directly connected to each LoadImage
  for (const nodeId in workflow) {
    const node = workflow[nodeId];
    if (!node || !node.inputs) continue;
    if (node.class_type === 'ImageRotate') {
      const imgInput = node.inputs.image;
      if (Array.isArray(imgInput) && loadImageNodes[String(imgInput[0])]) {
        const loadId = String(imgInput[0]);
        // Only assign first found rotate node per LoadImage
        if (!rotateNodeForLoad[loadId]) {
          rotateNodeForLoad[loadId] = nodeId;
        }
      }
    }
  }

  // --- Pre-scan: find and sort KSampler / Sampler nodes to group them by pass order ---
  const samplerNodes = [];
  for (const nodeId in workflow) {
    const node = workflow[nodeId];
    if (!node || !node.inputs) continue;
    const classType = node.class_type || '';
    const isSamplerOrNoise = classType.includes('Sampler') || classType.includes('Noise') || classType === 'KSampler' || classType === 'KSamplerAdvanced';
    if (isSamplerOrNoise) {
      samplerNodes.push({ id: nodeId, node: node });
    }
  }

  // Helper to trace if targetId is downstream of startId
  const isDownstream = (wf, targetId, startId, visited = new Set()) => {
    if (targetId === startId) return true;
    if (visited.has(targetId)) return false;
    visited.add(targetId);
    const n = wf[targetId];
    if (!n || !n.inputs) return false;
    for (const key in n.inputs) {
      const val = n.inputs[key];
      if (Array.isArray(val) && val.length === 2) {
        if (isDownstream(wf, String(val[0]), startId, visited)) {
          return true;
        }
      }
    }
    return false;
  };

  samplerNodes.sort((a, b) => {
    if (isDownstream(workflow, b.id, a.id)) return -1;
    if (isDownstream(workflow, a.id, b.id)) return 1;
    return parseInt(a.id) - parseInt(b.id);
  });
  
  // Iterate through all nodes in the workflow JSON
  for (const nodeId in workflow) {
    const node = workflow[nodeId];
    if (!node || !node.inputs) continue;
    
    const classType = node.class_type || '';
    
    // Custom label (ComfyUI metadata title)
    let nodeTitle = (node._meta && node._meta.title) ? node._meta.title : `${classType} (#${nodeId})`;
    
    // 1. Text Encoders (Prompts)
    if (classType === 'CLIPTextEncode') {
      if (typeof node.inputs.text === 'string') {
        paramCount++;
        const val = node.inputs.text;
        
        // Guess if it's Positive or Negative prompt
        const isNegative = val.toLowerCase().includes('bad') || 
                           val.toLowerCase().includes('ugly') || 
                           val.toLowerCase().includes('nsfw') || 
                           nodeTitle.toLowerCase().includes('negative');
        
        const label = isNegative ? `Negative Prompt (${nodeTitle})` : `Positive Prompt (${nodeTitle})`;
        
        const paramId = `param-${nodeId}-text`;
        const rows = isNegative ? 3 : 13;
        const paramEl = createParamElement(paramId, label, nodeId, 'text', 'textarea', val, 1, rows);
        container.appendChild(paramEl);
        
        paramMappings.push({
          nodeId: nodeId,
          key: 'text',
          elementId: paramId,
          type: 'string'
        });
      }
    }

    // 1b. TextEncodeQwenImageEditPlus (Qwen Image Edit Prompt Encoder)
    if (classType === 'TextEncodeQwenImageEditPlus') {
      if (typeof node.inputs.prompt === 'string') {
        qwenCount++;
        const val = node.inputs.prompt;

        // Identify Positive vs Negative based on node title (prioritized)
        let isNegative = false;
        const lowerTitle = nodeTitle.toLowerCase();
        if (lowerTitle.includes('negative') || lowerTitle.includes('neg')) {
          isNegative = true;
        } else if (lowerTitle.includes('positive') || lowerTitle.includes('postive') || lowerTitle.includes('pos')) {
          isNegative = false;
        } else {
          isNegative = val.trim() === '';
        }

        const label = isNegative
          ? `🚫 Negative Prompt (${nodeTitle})`
          : `✏️ Edit Prompt (${nodeTitle})`;

        const paramId = `param-${nodeId}-prompt`;
        const paramEl = createQwenPromptElement(paramId, label, nodeId, val);
        if (qwenContainer) {
          qwenContainer.appendChild(paramEl);
        } else {
          container.appendChild(paramEl);
        }

        paramMappings.push({
          nodeId: nodeId,
          key: 'prompt',
          elementId: paramId,
          type: 'string'
        });
      }
    }
    
    // 2. KSamplers, SamplerCustom, RandomNoise & other generator nodes
    // Skip KSamplers here, we will render them in sorted pass order below
    const isSamplerOrNoise = classType.includes('Sampler') || classType.includes('Noise') || classType === 'KSampler' || classType === 'KSamplerAdvanced';
    
    if (isSamplerOrNoise) {
      continue;
    }

    // 3. LoadImage Nodes → now rendered in the Input Images panel (skip here)
    // (Handled below in the Input Images section)
  }

  // --- Post-scan: Render KSamplers in sorted execution pass order ---
  // Now add the sampler nodes in their sorted execution order!
  samplerNodes.forEach((item, index) => {
    const nodeId = item.id;
    const node = item.node;
    const classType = node.class_type || 'KSampler';
    const userTitle = node._meta && node._meta.title;
    
    let samplerLabel = classType;
    if (samplerNodes.length > 1) {
      const passNames = ['First Pass', 'Second Pass', 'Third Pass', 'Fourth Pass', 'Fifth Pass'];
      const passLabel = passNames[index] || `Pass ${index + 1}`;
      samplerLabel = userTitle && userTitle !== 'KSampler' && userTitle !== 'KSamplerAdvanced'
        ? `${passLabel} (${userTitle})`
        : `${passLabel} (${classType})`;
    } else {
      samplerLabel = userTitle || classType;
    }

    // Create group container for this sampler node
    const groupEl = document.createElement('div');
    groupEl.className = 'ksampler-group';
    
    const groupTitleEl = document.createElement('div');
    groupTitleEl.className = 'ksampler-group-title';
    
    const titleText = document.createElement('span');
    titleText.textContent = samplerLabel;
    
    const nodeTag = document.createElement('span');
    nodeTag.className = 'ksampler-group-node';
    nodeTag.textContent = `#${nodeId}`;
    
    groupTitleEl.appendChild(titleText);
    groupTitleEl.appendChild(nodeTag);
    groupEl.appendChild(groupTitleEl);
    
    let hasInputs = false;

    // Seed / Noise Seed (Common keys for generation seeds)
    const seedKey = node.inputs.seed !== undefined ? 'seed' : (node.inputs.noise_seed !== undefined ? 'noise_seed' : null);
    if (seedKey && typeof node.inputs[seedKey] === 'number') {
      paramCount++;
      hasInputs = true;
      const paramId = `param-${nodeId}-${seedKey}`;
      const paramEl = createSeedParamElement(paramId, 'Random Seed', nodeId, node.inputs[seedKey]);
      groupEl.appendChild(paramEl);
      
      paramMappings.push({
        nodeId: nodeId,
        key: seedKey,
        elementId: paramId,
        type: 'number',
        isSeed: true
      });
    }
    
    // Steps
    if (node.inputs.steps !== undefined && typeof node.inputs.steps === 'number') {
      paramCount++;
      hasInputs = true;
      const paramId = `param-${nodeId}-steps`;
      const paramEl = createParamElement(paramId, 'Steps', nodeId, 'steps', 'number', node.inputs.steps);
      groupEl.appendChild(paramEl);
      
      paramMappings.push({
        nodeId: nodeId,
        key: 'steps',
        elementId: paramId,
        type: 'number'
      });
    }

    // CFG Scale
    if (node.inputs.cfg !== undefined && typeof node.inputs.cfg === 'number') {
      paramCount++;
      hasInputs = true;
      const paramId = `param-${nodeId}-cfg`;
      const paramEl = createParamElement(paramId, 'CFG Scale', nodeId, 'cfg', 'number', node.inputs.cfg, 0.1);
      groupEl.appendChild(paramEl);
      
      paramMappings.push({
        nodeId: nodeId,
        key: 'cfg',
        elementId: paramId,
        type: 'number'
      });
    }

    // Denoise
    if (node.inputs.denoise !== undefined && typeof node.inputs.denoise === 'number') {
      paramCount++;
      hasInputs = true;
      const paramId = `param-${nodeId}-denoise`;
      const paramEl = createParamElement(paramId, 'Denoise', nodeId, 'denoise', 'number', node.inputs.denoise, 0.01);
      groupEl.appendChild(paramEl);
      
      paramMappings.push({
        nodeId: nodeId,
        key: 'denoise',
        elementId: paramId,
        type: 'number'
      });
    }

    if (hasInputs) {
      container.appendChild(groupEl);
    }
  });

  // --- Input Images Panel: render up to 3 LoadImage slots ---
  const loadIds = Object.keys(loadImageNodes);
  const MAX_SLOTS = 3;
  const inputImagesPanel = document.getElementById('input-images-panel');
  const inputImagesCount = document.getElementById('input-images-count');

  if (loadIds.length > 0) {
    if (inputImagesPanel) inputImagesPanel.classList.remove('hidden');

    for (let slotIndex = 0; slotIndex < MAX_SLOTS; slotIndex++) {
      const loadId = loadIds[slotIndex] || null;
      const rotateId = loadId ? (rotateNodeForLoad[loadId] || null) : null;
      const defaultImage = loadId ? (loadImageNodes[loadId].inputs.image || '') : '';
      const defaultRotation = rotateId ? (workflow[rotateId].inputs.rotation || 'none') : 'none';

      // Restore persisted enabled state from localStorage (fall back to enabled if active)
      const savedEnabled = localStorage.getItem(`img_slot_${slotIndex}_enabled`);
      const restoredEnabled = loadId !== null
        ? (savedEnabled !== null ? savedEnabled === 'true' : true)
        : false;

      // Register slot state
      const slotState = {
        slotIndex,
        nodeId: loadId,
        rotateNodeId: rotateId,
        enabled: restoredEnabled,
        rotation: defaultRotation,
        imageFilename: defaultImage
      };
      imageSlots.push(slotState);

      if (imagesContainer) {
        const slotEl = createImageInputSlotElement(slotState, workflow);
        imagesContainer.appendChild(slotEl);
      }

      // Add image filename to paramMappings so it persists and gets written on generate
      if (loadId) {
        const paramId = `img-slot-${slotIndex}-hidden`;
        paramMappings.push({
          nodeId: loadId,
          key: 'image',
          elementId: paramId,
          type: 'string',
          isImageSlot: true
        });
      }
    }

    const activeCount = loadIds.length;
    if (inputImagesCount) {
      inputImagesCount.textContent = `${Math.min(activeCount, MAX_SLOTS)} active`;
    }
  } else {
    if (inputImagesPanel) inputImagesPanel.classList.add('hidden');
  }
  
  // Handle Qwen Prompts panel visibility and count
  const qwenPanel = document.getElementById('qwen-prompts-panel');
  const qwenCountBadge = document.getElementById('qwen-params-count');
  if (qwenPanel) {
    if (qwenCount > 0) {
      qwenPanel.classList.remove('hidden');
      if (qwenCountBadge) {
        qwenCountBadge.textContent = `${qwenCount} prompt${qwenCount > 1 ? 's' : ''}`;
      }
    } else {
      qwenPanel.classList.add('hidden');
    }
  }

  // Handle general parameters panel visibility and count
  const sidebarBadge = document.getElementById('sidebar-params-badge');
  if (paramCount > 0) {
    document.getElementById('no-params-msg').classList.add('hidden');
    container.classList.remove('hidden');
    document.getElementById('params-count').textContent = `${paramCount} parameters detected`;
    if (sidebarBadge) {
      sidebarBadge.textContent = paramCount;
      sidebarBadge.style.display = 'inline-block';
    }
  } else {
    document.getElementById('no-params-msg').classList.remove('hidden');
    container.classList.add('hidden');
    document.getElementById('params-count').textContent = 'No adjustable parameters detected';
    if (sidebarBadge) {
      sidebarBadge.style.display = 'none';
      sidebarBadge.textContent = '0';
    }
  }

  // Add auto-save listeners to all inputs in paramMappings (both regular and Qwen inputs)
  paramMappings.forEach(mapping => {
    const inputEl = document.getElementById(mapping.elementId);
    if (inputEl) {
      inputEl.addEventListener('input', saveWorkflowToLocalStorage);
      inputEl.addEventListener('change', saveWorkflowToLocalStorage);
    }
  });

  if (window.updateAutosavePreview) {
    window.updateAutosavePreview();
  }
}

function createParamElement(id, label, nodeId, key, inputType, defaultValue, step = 1, rows = 3) {
  const item = document.createElement('div');
  item.className = 'param-item';
  
  const header = document.createElement('div');
  header.className = 'param-header';
  
  const name = document.createElement('span');
  name.className = 'param-name';
  name.textContent = label;
  
  const node = document.createElement('span');
  node.className = 'param-node';
  node.textContent = `Node: ${nodeId}.${key}`;
  
  header.appendChild(name);
  header.appendChild(node);
  item.appendChild(header);
  
  const inputGroup = document.createElement('div');
  inputGroup.className = 'input-group';
  
  let input;
  if (inputType === 'textarea') {
    input = document.createElement('textarea');
    input.value = defaultValue;
    input.rows = rows;
  } else {
    input = document.createElement('input');
    input.type = inputType;
    input.value = defaultValue;
    if (inputType === 'number') {
      input.step = step;
      if (step < 1) {
        input.type = 'number';
      }
    }
  }
  input.id = id;
  
  inputGroup.appendChild(input);
  item.appendChild(inputGroup);
  
  return item;
}

// Creates a styled prompt editor for TextEncodeQwenImageEditPlus nodes
function createQwenPromptElement(id, label, nodeId, defaultValue) {
  const isNegative = label.includes('🚫');

  const item = document.createElement('div');
  item.className = `param-item qwen-prompt-item ${isNegative ? 'qwen-negative' : 'qwen-positive'}`;

  // ── Header ──────────────────────────────────────────────────────────────
  const header = document.createElement('div');
  header.className = 'param-header';

  const name = document.createElement('span');
  name.className = 'param-name';
  name.textContent = label;

  const badge = document.createElement('span');
  badge.className = `qwen-badge ${isNegative ? 'qwen-badge-neg' : 'qwen-badge-pos'}`;
  badge.textContent = isNegative ? 'Negative' : 'Positive';

  const nodeTag = document.createElement('span');
  nodeTag.className = 'param-node';
  nodeTag.textContent = `Node: ${nodeId}.prompt`;

  header.appendChild(name);
  header.appendChild(badge);
  header.appendChild(nodeTag);
  item.appendChild(header);

  // ── Textarea wrapper ─────────────────────────────────────────────────────
  const wrapper = document.createElement('div');
  wrapper.className = 'qwen-textarea-wrapper';

  const textarea = document.createElement('textarea');
  textarea.id = id;
  textarea.className = 'qwen-prompt-textarea';
  textarea.value = defaultValue;
  textarea.rows = isNegative ? 2 : 13;
  textarea.placeholder = isNegative
    ? 'Enter negative guidance (leave blank for none)…'
    : 'Describe the image edits in detail…';
  textarea.spellcheck = false;

  // ── Toolbar ──────────────────────────────────────────────────────────────
  const toolbar = document.createElement('div');
  toolbar.className = 'qwen-toolbar';

  const charCount = document.createElement('span');
  charCount.className = 'qwen-char-count';
  charCount.textContent = `${defaultValue.length} chars`;
  textarea.addEventListener('input', () => {
    charCount.textContent = `${textarea.value.length} chars`;
  });

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'btn btn-ghost btn-small qwen-clear-btn';
  clearBtn.textContent = 'Clear';
  clearBtn.addEventListener('click', () => {
    textarea.value = '';
    charCount.textContent = '0 chars';
    textarea.focus();
    // Dispatch input event so the auto-save listener persists the cleared value
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });

  toolbar.appendChild(charCount);
  toolbar.appendChild(clearBtn);

  wrapper.appendChild(textarea);
  wrapper.appendChild(toolbar);
  item.appendChild(wrapper);

  return item;
}

// Creates an image slot element for the Input Images panel
function createImageInputSlotElement(slotState, workflow) {
  const { slotIndex, nodeId, rotateNodeId, enabled, rotation, imageFilename } = slotState;
  const isActive = nodeId !== null;
  const slotNum = slotIndex + 1;

  const item = document.createElement('div');
  item.className = `param-item image-slot${!isActive || !enabled ? ' disabled-slot' : ''}`;
  item.dataset.slotIndex = slotIndex;

  // Header: checkbox + label + rotate button
  const header = document.createElement('div');
  header.className = 'param-header';

  const headerLeft = document.createElement('div');
  headerLeft.className = 'param-header-left';

  // Enable/Disable checkbox
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'slot-enable-checkbox';
  checkbox.id = `img-slot-${slotIndex}-enable`;
  checkbox.checked = isActive && enabled;
  checkbox.disabled = !isActive;
  checkbox.title = isActive ? 'Enable / Disable this image input' : 'Inactive — not present in workflow';

  const name = document.createElement('span');
  name.className = 'param-name';
  name.textContent = `Slot ${slotNum}${isActive ? '' : ' — Inactive'}` ;

  headerLeft.appendChild(checkbox);
  headerLeft.appendChild(name);

  // Rotate button (only when there is an ImageRotate node)
  const rotateBtn = document.createElement('button');
  rotateBtn.className = 'btn btn-secondary btn-small btn-rotate';
  rotateBtn.title = 'Cycle rotation: 0° → 90° → 180° → 270°';
  rotateBtn.disabled = !isActive || !rotateNodeId;

  const ROTATION_LABELS = { none: '0°', '90': '90°', '180': '180°', '270': '270°' };
  const ROTATION_CYCLE = ['none', '90', '180', '270'];
  rotateBtn.textContent = `↻ ${ROTATION_LABELS[rotation] || '0°'}`;

  header.appendChild(headerLeft);
  header.appendChild(rotateBtn);
  item.appendChild(header);

  // Image picker body (same style as existing createImagePickerElement)
  const pickerControl = document.createElement('div');
  pickerControl.className = 'image-picker-control';

  const preview = document.createElement('div');
  preview.className = 'image-picker-preview';
  preview.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;

  // Apply current rotation to preview img (will apply after img loads too)
  const CSS_ROTATION = { none: 0, '90': 90, '180': 180, '270': 270 };
  let currentCssRotation = CSS_ROTATION[slotState.rotation] || 0;

  const info = document.createElement('div');
  info.className = 'image-picker-info';

  const filenameSpan = document.createElement('span');
  filenameSpan.className = 'image-picker-filename';
  filenameSpan.textContent = imageFilename || (isActive ? 'No image selected' : 'Not in workflow');
  if (imageFilename) filenameSpan.classList.add('selected');

  const statusSpan = document.createElement('span');
  statusSpan.className = 'image-picker-status';
  statusSpan.textContent = isActive ? (imageFilename ? 'Server default' : 'Ready') : 'Inactive';

  info.appendChild(filenameSpan);
  info.appendChild(statusSpan);

  const actions = document.createElement('div');
  actions.className = 'image-picker-actions';

  const selectBtn = document.createElement('button');
  selectBtn.className = 'btn btn-secondary btn-small';
  selectBtn.textContent = 'Select...';
  selectBtn.disabled = !isActive;

  actions.appendChild(selectBtn);

  pickerControl.appendChild(preview);
  pickerControl.appendChild(info);
  pickerControl.appendChild(actions);
  item.appendChild(pickerControl);

  // Hidden value input for paramMappings reference
  const hiddenValue = document.createElement('input');
  hiddenValue.type = 'hidden';
  hiddenValue.id = `img-slot-${slotIndex}-hidden`;
  hiddenValue.value = imageFilename || '';
  item.appendChild(hiddenValue);

  // --- Node tag ---
  if (isActive) {
    const nodeTag = document.createElement('span');
    nodeTag.className = 'param-node';
    nodeTag.style.marginTop = '4px';
    nodeTag.style.display = 'block';
    nodeTag.textContent = `LoadImage: ${nodeId}${rotateNodeId ? ` · ImageRotate: ${rotateNodeId}` : ''}`;
    item.appendChild(nodeTag);
  }

  // --- Helper: apply visual rotation to preview image ---
  function applyRotationToPreviewImg() {
    const img = preview.querySelector('img');
    if (img) {
      img.style.transform = `rotate(${currentCssRotation}deg)`;
    }
  }

  // --- Enable/Disable checkbox handler ---
  checkbox.addEventListener('change', () => {
    slotState.enabled = checkbox.checked;
    // Persist the checkbox state so it survives app restarts and workflow reloads
    localStorage.setItem(`img_slot_${slotState.slotIndex}_enabled`, checkbox.checked);
    if (checkbox.checked) {
      item.classList.remove('disabled-slot');
      selectBtn.disabled = false;
      rotateBtn.disabled = !rotateNodeId;
    } else {
      item.classList.add('disabled-slot');
      selectBtn.disabled = true;
      rotateBtn.disabled = true;
    }
    saveWorkflowToLocalStorage();
    if (window.updateAutosavePreview) window.updateAutosavePreview();
    updateCompareButtonState();
  });

  // --- Rotate button handler ---
  rotateBtn.addEventListener('click', () => {
    const curIdx = ROTATION_CYCLE.indexOf(slotState.rotation);
    const nextIdx = (curIdx + 1) % ROTATION_CYCLE.length;
    slotState.rotation = ROTATION_CYCLE[nextIdx];
    currentCssRotation = CSS_ROTATION[slotState.rotation];
    rotateBtn.textContent = `↻ ${ROTATION_LABELS[slotState.rotation]}`;
    applyRotationToPreviewImg();
    saveWorkflowToLocalStorage();
  });

  // --- Select image button handler ---
  selectBtn.addEventListener('click', async () => {
    try {
      const fileData = await window.api.selectImageFile();
      if (!fileData) return;

      filenameSpan.textContent = fileData.fileName;
      filenameSpan.classList.add('selected');
      statusSpan.textContent = 'Uploading...';
      statusSpan.className = 'image-picker-status uploading';
      selectBtn.disabled = true;

      const localUrl = `file:///${fileData.filePath.replace(/\\/g, '/')}`;
      preview.innerHTML = `<img src="${localUrl}" alt="Preview" style="transform: rotate(${currentCssRotation}deg)">`;

      const uploadResult = await window.api.uploadImageToComfyUI({
        filePath: fileData.filePath,
        comfyUrl: comfyuiUrl
      });

      if (uploadResult.ok) {
        hiddenValue.value = uploadResult.name;
        slotState.imageFilename = uploadResult.name;
        filenameSpan.textContent = uploadResult.name;
        statusSpan.textContent = 'Uploaded';
        statusSpan.className = 'image-picker-status success';
        saveWorkflowToLocalStorage();
        if (window.updateAutosavePreview) window.updateAutosavePreview();
        updateCompareButtonState();
      } else {
        throw new Error(uploadResult.error || 'Upload failed');
      }
    } catch (err) {
      console.error('Image slot upload error:', err);
      statusSpan.textContent = `Error: ${err.message}`;
      statusSpan.className = 'image-picker-status error';
      preview.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
    } finally {
      selectBtn.disabled = false;
    }
  });

  // --- Auto-load existing preview from ComfyUI server ---
  if (isActive && imageFilename && document.getElementById('status-dot').classList.contains('connected')) {
    const previewUrl = `${comfyuiUrl}/view?filename=${encodeURIComponent(imageFilename)}&type=input`;
    window.api.comfyFetchImage({ url: previewUrl }).then(result => {
      if (result.ok) {
        preview.innerHTML = `<img src="${result.dataUrl}" alt="Preview" style="transform: rotate(${currentCssRotation}deg)">`;
      }
    }).catch(err => console.log('Failed to fetch slot image preview', err));
  }

  return item;
}

function createImagePickerElement(id, label, nodeId, defaultValue) {
  const item = document.createElement('div');
  item.className = 'param-item';
  
  const header = document.createElement('div');
  header.className = 'param-header';
  
  const name = document.createElement('span');
  name.className = 'param-name';
  name.textContent = label;
  
  const node = document.createElement('span');
  node.className = 'param-node';
  node.textContent = `Node: ${nodeId}.image`;
  
  header.appendChild(name);
  header.appendChild(node);
  item.appendChild(header);
  
  const pickerControl = document.createElement('div');
  pickerControl.className = 'image-picker-control';
  
  const preview = document.createElement('div');
  preview.className = 'image-picker-preview';
  preview.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
  
  const info = document.createElement('div');
  info.className = 'image-picker-info';
  
  const filename = document.createElement('span');
  filename.className = 'image-picker-filename';
  filename.textContent = defaultValue || 'No image selected';
  if (defaultValue) filename.classList.add('selected');
  
  const status = document.createElement('span');
  status.className = 'image-picker-status';
  status.textContent = defaultValue ? 'Server default' : 'Ready';
  
  info.appendChild(filename);
  info.appendChild(status);
  
  const actions = document.createElement('div');
  actions.className = 'image-picker-actions';
  
  const selectBtn = document.createElement('button');
  selectBtn.className = 'btn btn-secondary btn-small';
  selectBtn.textContent = 'Select...';
  
  actions.appendChild(selectBtn);
  
  pickerControl.appendChild(preview);
  pickerControl.appendChild(info);
  pickerControl.appendChild(actions);
  item.appendChild(pickerControl);
  
  const hiddenValue = document.createElement('input');
  hiddenValue.type = 'hidden';
  hiddenValue.id = id;
  hiddenValue.value = defaultValue;
  item.appendChild(hiddenValue);
  
  selectBtn.addEventListener('click', async () => {
    try {
      const fileData = await window.api.selectImageFile();
      if (!fileData) return;
      
      filename.textContent = fileData.fileName;
      filename.classList.add('selected');
      status.textContent = 'Uploading...';
      status.className = 'image-picker-status uploading';
      selectBtn.disabled = true;
      
      const localUrl = `file:///${fileData.filePath.replace(/\\/g, '/')}`;
      preview.innerHTML = `<img src="${localUrl}" alt="Preview">`;
      
      const uploadResult = await window.api.uploadImageToComfyUI({
        filePath: fileData.filePath,
        comfyUrl: comfyuiUrl
      });
      
      if (uploadResult.ok) {
        hiddenValue.value = uploadResult.name;
        filename.textContent = uploadResult.name;
        status.textContent = 'Uploaded';
        status.className = 'image-picker-status success';
        saveWorkflowToLocalStorage();
      } else {
        throw new Error(uploadResult.error || 'Upload failed');
      }
    } catch (err) {
      console.error('Image picker upload error:', err);
      status.textContent = `Error: ${err.message}`;
      status.className = 'image-picker-status error';
      preview.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
    } finally {
      selectBtn.disabled = false;
    }
  });
  
  if (defaultValue && document.getElementById('status-dot').classList.contains('connected')) {
    const previewUrl = `${comfyuiUrl}/view?filename=${encodeURIComponent(defaultValue)}&type=input`;
    window.api.comfyFetchImage({ url: previewUrl }).then(result => {
      if (result.ok) {
        preview.innerHTML = `<img src="${result.dataUrl}" alt="Preview">`;
      }
    }).catch(err => console.log('Failed to fetch default input preview', err));
  }
  
  return item;
}

// Refresh image previews for all LoadImage nodes after connection is established.
// On app restart the persisted workflow is loaded before the WebSocket connects,
// so image thumbnails are skipped during slot creation. This function
// retries the fetch for every image slot that has a filename but no preview.
function refreshImagePreviews() {
  // Refresh Input Images panel slots
  imageSlots.forEach(slotState => {
    if (!slotState.nodeId || !slotState.imageFilename) return;
    const item = document.querySelector(`[data-slot-index="${slotState.slotIndex}"]`);
    if (!item) return;
    const preview = item.querySelector('.image-picker-preview');
    if (!preview) return;
    // Skip if already has a preview
    if (preview.querySelector('img')) return;

    const CSS_ROTATION = { none: 0, '90': 90, '180': 180, '270': 270 };
    const currentCssRotation = CSS_ROTATION[slotState.rotation] || 0;
    const previewUrl = `${comfyuiUrl}/view?filename=${encodeURIComponent(slotState.imageFilename)}&type=input`;
    window.api.comfyFetchImage({ url: previewUrl }).then(result => {
      if (result.ok) {
        preview.innerHTML = `<img src="${result.dataUrl}" alt="Preview" style="transform: rotate(${currentCssRotation}deg)">`;
      }
    }).catch(err => console.log('Failed to refresh slot image preview:', err));
  });

  // Legacy: also refresh any image pickers still in the params container
  paramMappings.forEach(mapping => {
    if (mapping.key !== 'image' || mapping.isImageSlot) return;
    const hiddenInput = document.getElementById(mapping.elementId);
    if (!hiddenInput || !hiddenInput.value) return;

    const item = hiddenInput.closest('.param-item');
    if (!item) return;
    const preview = item.querySelector('.image-picker-preview');
    if (!preview) return;

    if (preview.querySelector('img')) return;

    const filename = hiddenInput.value;
    const previewUrl = `${comfyuiUrl}/view?filename=${encodeURIComponent(filename)}&type=input`;
    window.api.comfyFetchImage({ url: previewUrl }).then(result => {
      if (result.ok) {
        preview.innerHTML = `<img src="${result.dataUrl}" alt="Preview">`;
      }
    }).catch(err => console.log('Failed to refresh image preview:', err));
  });
}

function createSeedParamElement(id, label, nodeId, defaultValue) {
  const item = document.createElement('div');
  item.className = 'param-item';
  
  const header = document.createElement('div');
  header.className = 'param-header';
  
  const name = document.createElement('span');
  name.className = 'param-name';
  name.textContent = label;
  
  const node = document.createElement('span');
  node.className = 'param-node';
  node.textContent = `Node: ${nodeId}.seed`;
  
  header.appendChild(name);
  header.appendChild(node);
  item.appendChild(header);
  
  const paramRow = document.createElement('div');
  paramRow.className = 'param-row';
  
  const inputGroup = document.createElement('div');
  inputGroup.className = 'input-group';
  const input = document.createElement('input');
  input.type = 'number';
  input.id = id;
  input.value = defaultValue;
  inputGroup.appendChild(input);
  
  const seedBtn = document.createElement('button');
  seedBtn.className = 'btn btn-secondary';
  seedBtn.textContent = 'Random';
  seedBtn.style.padding = '8px';
  
  let randomMode = true;
  seedBtn.addEventListener('click', () => {
    randomMode = !randomMode;
    if (randomMode) {
      seedBtn.textContent = 'Random';
      seedBtn.classList.remove('btn-primary');
      seedBtn.classList.add('btn-secondary');
    } else {
      seedBtn.textContent = 'Fixed';
      seedBtn.classList.remove('btn-secondary');
      seedBtn.classList.add('btn-primary');
    }
  });
  
  paramRow.appendChild(inputGroup);
  paramRow.appendChild(seedBtn);
  item.appendChild(paramRow);
  
  // Attach custom property to easily query the randomization mode
  input.randomMode = () => randomMode;
  
  return item;
}

// Helper: Check if a node is downstream of any KSampler/Sampler node in the workflow JSON
function isDownstreamOfSampler(nodeId, workflow, visited = new Set()) {
  if (!workflow || !workflow[nodeId]) return false;
  if (visited.has(nodeId)) return false;
  visited.add(nodeId);

  const node = workflow[nodeId];
  const classType = node.class_type || '';
  const isSampler = classType.toLowerCase().includes('sampler');
  if (isSampler) {
    return true;
  }

  // If this node has inputs, trace backwards
  if (node.inputs) {
    for (const inputKey in node.inputs) {
      const inputVal = node.inputs[inputKey];
      if (Array.isArray(inputVal) && inputVal.length === 2) {
        const parentNodeId = String(inputVal[0]);
        if (isDownstreamOfSampler(parentNodeId, workflow, visited)) {
          return true;
        }
      }
    }
  }
  return false;
}

// Handle binary WebSocket message containing image previews from ComfyUI
//
// eventType=1 (PREVIEW_IMAGE) layout:
//   [0..3]  = event type (1)            — big-endian uint32
//   [4..7]  = image format (1=JPEG, 2=PNG, 3=WEBP)
//   [8..]   = raw image bytes
//
// eventType=4 (PREVIEW_IMAGE_WITH_METADATA) layout:
//   [0..3]  = event type (4)            — big-endian uint32
//   [4..7]  = metadata JSON byte-length — big-endian uint32
//   [8 .. 8+metaLen] = UTF-8 JSON metadata  { image_type, node_id, prompt_id, … }
//   [8+metaLen ..]   = raw image bytes
//
// IMPORTANT: for type 4 we MUST skip the metadata header before creating the Blob.
function handleBinaryMessage(arrayBuffer) {
  try {
    if (arrayBuffer.byteLength < 8) return;
    // ComfyUI uses big-endian integers — pass false (big-endian) to getUint32
    const view = new DataView(arrayBuffer);
    const eventType = view.getUint32(0, false);

    let imageData;
    let mimeType = 'image/jpeg'; // ComfyUI default

    if (eventType === 1 || eventType === 2) {
      // Classic preview: bytes [4..7] = image format enum
      const imageFormat = view.getUint32(4, false); // 1=JPEG, 2=PNG, 3=WEBP
      if (imageFormat === 2)      mimeType = 'image/png';
      else if (imageFormat === 3) mimeType = 'image/webp';
      imageData = arrayBuffer.slice(8);
      console.log(`[WS Binary] type=${eventType} fmt=${imageFormat} mime=${mimeType} bytes=${arrayBuffer.byteLength}`);

    } else if (eventType === 4) {
      // Modern preview WITH metadata:
      //   bytes [4..7] = length of the JSON metadata string
      //   bytes [8 .. 8+metaLen] = UTF-8 JSON
      //   bytes [8+metaLen ..] = raw image
      const metaLen = view.getUint32(4, false);
      const metaBytes = arrayBuffer.slice(8, 8 + metaLen);
      let metadata = {};
      try {
        metadata = JSON.parse(new TextDecoder().decode(metaBytes));
      } catch (e) {
        console.warn('[WS Binary] type=4 metadata parse failed', e);
      }
      // Use image_type from metadata if present, otherwise default to JPEG
      if (metadata.image_type) mimeType = metadata.image_type;
      imageData = arrayBuffer.slice(8 + metaLen);
      console.log(`[WS Binary] type=4 metaLen=${metaLen} mime=${mimeType} imgBytes=${imageData.byteLength}`, metadata);

    } else {
      console.log(`[WS Binary] Unrecognised eventType=${eventType} — ignored`);
      return;
    }

    if (!imageData || imageData.byteLength === 0) {
      console.warn('[WS Binary] Empty image payload — skipped');
      return;
    }

    // Revoke previous blob URL to prevent memory leaks
    if (currentPreviewUrl) {
      URL.revokeObjectURL(currentPreviewUrl);
    }

    const blob = new Blob([imageData], { type: mimeType });
    const objectUrl = URL.createObjectURL(blob);
    currentPreviewUrl = objectUrl;

    // Show the preview in the output panel
    document.getElementById('display-loading').classList.add('hidden');
    document.getElementById('display-empty').classList.add('hidden');
    document.getElementById('display-image-container').classList.remove('hidden');

    const imgEl = document.getElementById('result-img');
    imgEl.src = objectUrl;

    if (isCompareMode) {
      const imgBottom = document.getElementById('compare-img-bottom');
      if (imgBottom) imgBottom.src = objectUrl;
    }
    updateCompareButtonState();

    // Wire Open Original button — disallow during active generation
    const openBtn = document.getElementById('btn-open-image');
    openBtn.onclick = () => {
      showToast('Generation in Progress', 'Please wait for the final image before opening in the external viewer.', 'success');
    };
  } catch (e) {
    console.error('Error handling binary WS message:', e);
  }
}

// 4. WebSocket Event Handler (ComfyUI API Events)
function handleWebSocketMessage(data) {
  const type = data.type;
  window.api.logDebug({ message: `WS Event: type=${type} data.prompt_id=${data.data ? (data.data.prompt_id || 'none') : 'none'} activePromptId=${activePromptId}` });
  console.log(`WebSocket event: ${type}`, data.data);
  
  switch (type) {
    case 'status': {
      const running = data.data.status.exec_info.queue_remaining;
      document.getElementById('queue-status').textContent = `Running: ${running}`;
      break;
    }

    case 'execution_start': {
      const incomingId = data.data.prompt_id;
      // If POST already returned, activePromptId is set; otherwise fall back to pendingPromptId.
      if (incomingId === activePromptId ||
          (activePromptId === null && pendingPromptId === true)) {
        // Bind the real prompt_id as early as possible so subsequent events match
        activePromptId = incomingId;
        pendingPromptId = false;
        window.api.logDebug({ message: `execution_start: bound activePromptId=${activePromptId}` });
        
        // Reset all progress tracking variables for a fresh run
        currentExecutionSteps = 0;
        lastSamplerNodeId = null;
        lastSamplerStep = 0;
        totalWorkflowSteps = 0;
        samplerNodeMaxMap = {};
        
        // Reset save state for new generation
        savedForPromptId = null;
        promptSavedPath = null;

        updateProgress(0, 0, 'Executing workflow...');
        document.getElementById('display-empty').classList.add('hidden');
        document.getElementById('display-loading').classList.remove('hidden');
        document.getElementById('display-image-container').classList.add('hidden');
      }
      break;
    }

    case 'executing': {
      const incomingId = data.data.prompt_id;
      // Accept if it matches the active prompt
      if (incomingId && incomingId !== activePromptId) break;
      if (!activePromptId) break;

      const nodeId = data.data.node;
      if (nodeId) {
        let typeLabel = '';
        if (currentWorkflow && currentWorkflow[nodeId]) {
          typeLabel = currentWorkflow[nodeId].class_type;
        }
        document.getElementById('current-node').textContent = `${typeLabel} (Node ${nodeId})`;
      } else {
        // Node is null: Prompt execution finished completely!
        window.api.logDebug({ message: `Prompt execution finished completely for prompt_id=${activePromptId}` });
        document.getElementById('current-node').textContent = 'Execution Complete';
        document.getElementById('display-loading').classList.add('hidden');

        activePromptId = null;
        // Do NOT reset promptSavedPath and savedForPromptId here so that the "Open in Viewer" button continues to open the saved file path of the completed run
        
        // Reset all progress tracking variables
        currentExecutionSteps = 0;
        lastSamplerNodeId = null;
        lastSamplerStep = 0;
        totalWorkflowSteps = 0;
        samplerNodeMaxMap = {};

        updateProgress(0, 0, 'Ready');

        const btnGenerate = document.getElementById('btn-generate');
        btnGenerate.innerHTML = `
          <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          <span>Generate Image</span>
        `;
        btnGenerate.disabled = false;
        btnGenerate.classList.remove('btn-disabled');
        btnGenerate.classList.remove('btn-danger');
        btnGenerate.classList.add('btn-primary');
        checkQueueStatus();
      }
      break;
    }

    case 'progress': {
      // Only update progress if we are actively executing our prompt
      if (!activePromptId) break;
      if (data.data.prompt_id && data.data.prompt_id !== activePromptId) break;

      const nodeId = data.data.node;
      const val = data.data.value;
      const max = data.data.max;

      // ── Dynamic multi-sampler progress tracking ──────────────────────────
      // We discover each sampler node's step count from the first progress
      // event it emits (max field), rather than pre-parsing the workflow JSON
      // (which fails when steps is a link array, not a literal number).

      if (nodeId !== lastSamplerNodeId) {
        // First progress event from this sampler node
        if (lastSamplerNodeId !== null) {
          // Finish accumulating the previous node's steps using its known max
          const prevMax = samplerNodeMaxMap[lastSamplerNodeId] || lastSamplerStep;
          currentExecutionSteps += prevMax;
          window.api.logDebug({ message: `Sampler transition: finished ${lastSamplerNodeId} (max=${prevMax}), accumulated=${currentExecutionSteps}` });
        }
        lastSamplerNodeId = nodeId;

        if (!samplerNodeMaxMap[nodeId]) {
          // First time seeing this node — record its max and update total estimate.
          samplerNodeMaxMap[nodeId] = max;
          // Recompute total: sum of all known maxes + (remaining unknown samplers × max)
          const knownNodes = Object.keys(samplerNodeMaxMap).length;
          const knownTotal = Object.values(samplerNodeMaxMap).reduce((a, b) => a + b, 0);
          const remaining = Math.max(0, estimatedSamplerCount - knownNodes);
          totalWorkflowSteps = knownTotal + remaining * max;
          window.api.logDebug({ message: `New sampler node ${nodeId}: max=${max}, knownNodes=${knownNodes}, estimatedSamplerCount=${estimatedSamplerCount}, totalWorkflowSteps=${totalWorkflowSteps}` });
        }
      }
      lastSamplerStep = val;

      const totalVal = currentExecutionSteps + val;
      const displayVal = Math.min(totalVal, totalWorkflowSteps || max);
      const denominator = totalWorkflowSteps || max;
      const pct = Math.round((displayVal / denominator) * 100);
      window.api.logDebug({ message: `Progress update: node=${nodeId}, val=${val}/${max}, accumulated=${currentExecutionSteps}, totalVal=${totalVal}, pct=${pct}%` });
      updateProgress(displayVal, denominator, `${pct}% (${displayVal}/${denominator})`);
      break;
    }

    case 'executed': {
      // A node has produced output (e.g. an image).
      // Display it, but DO NOT clear activePromptId yet — wait for node:null in 'executing'.
      console.log(`[executed] prompt_id=${data.data.prompt_id}  activePromptId=${activePromptId}  match=${data.data.prompt_id === activePromptId}`);
      if (data.data.prompt_id === activePromptId) {
        const output = data.data.output;
        if (output && output.images && output.images.length > 0) {
          const imgData = output.images[0];
          const nodeId = data.data.node;

          if (imgData.type === 'temp') {
            // ── PreviewImage / temp preview ──────────────────────────────────
            // These are intermediate previews from PreviewImage nodes that run
            // during or after KSampler. Always display them for visual feedback,
            // regardless of graph topology (no isDownstreamOfSampler check needed).
            // If it is downstream of a sampler, we treat it as a final output and auto-save it.
            const isDownstream = isDownstreamOfSampler(nodeId, currentWorkflow);
            if (isDownstream) {
              window.api.logDebug({ message: `Node ${nodeId} executed (temp downstream output). Displaying & auto-saving, prompt_id=${activePromptId}` });
              displayGeneratedImage(imgData.filename, imgData.subfolder, imgData.type, activePromptId);
            } else {
              window.api.logDebug({ message: `Node ${nodeId} executed (temp preview). Fetching via /view…` });
              displayGeneratedImage(imgData.filename, imgData.subfolder, imgData.type, null);
            }

          } else if (imgData.type === 'output') {
            // ── SaveImage / permanent output ──────────────────────────────────
            // Only display permanent outputs that are downstream of a KSampler
            // to avoid showing unrelated input images from LoadImage nodes.
            const isDownstream = isDownstreamOfSampler(nodeId, currentWorkflow);
            if (!isDownstream) {
              window.api.logDebug({ message: `Node ${nodeId} executed (output) is not downstream of any Sampler — skipped.` });
              break;
            }
            window.api.logDebug({ message: `Node ${nodeId} executed (output). Displaying & auto-saving, prompt_id=${activePromptId}` });
            displayGeneratedImage(imgData.filename, imgData.subfolder, imgData.type, activePromptId);

          } else {
            window.api.logDebug({ message: `Node ${nodeId} executed (${imgData.type}) — unknown type, skipped` });
          }
        }
      } else {
        window.api.logDebug({ message: `Ignored executed event: prompt_id mismatch (${data.data.prompt_id} !== ${activePromptId})` });
      }
      break;
    }

    case 'execution_interrupted': {
      const incomingId = data.data.prompt_id;
      if (incomingId !== activePromptId && !pendingPromptId) break;
      
      window.api.logDebug({ message: `Execution interrupted for prompt_id=${incomingId || activePromptId}` });

      document.getElementById('current-node').textContent = 'Execution Interrupted';
      document.getElementById('display-loading').classList.add('hidden');

      showToast('Execution Stopped', 'The image generation was stopped.', 'warning');

      activePromptId = null;
      pendingPromptId = false;
      savedForPromptId = null; promptSavedPath = null;
      
      currentExecutionSteps = 0;
      lastSamplerNodeId = null;
      lastSamplerStep = 0;
      totalWorkflowSteps = 0;
      samplerNodeMaxMap = {};

      updateProgress(0, 0, 'Interrupted');

      const btnGenerate = document.getElementById('btn-generate');
      btnGenerate.innerHTML = `
        <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        <span>Generate Image</span>
      `;
      btnGenerate.disabled = false;
      btnGenerate.classList.remove('btn-disabled');
      btnGenerate.classList.remove('btn-danger');
      btnGenerate.classList.add('btn-primary');
      checkQueueStatus();
      break;
    }

    case 'execution_error': {
      if (data.data.prompt_id !== activePromptId) break;
      window.api.logDebug({ message: `Execution error for prompt_id=${activePromptId}: ${data.data.exception_message}` });

      document.getElementById('current-node').textContent = 'Execution Error';
      document.getElementById('display-loading').classList.add('hidden');

      showToast('Execution Error', data.data.exception_message || 'An error occurred during ComfyUI execution', 'error');

      activePromptId = null;
      pendingPromptId = false;
      savedForPromptId = null; promptSavedPath = null; // Reset so the next generation can auto-save
      
      // Reset all progress tracking variables
      currentExecutionSteps = 0;
      lastSamplerNodeId = null;
      lastSamplerStep = 0;
      totalWorkflowSteps = 0;
      samplerNodeMaxMap = {};

      updateProgress(0, 0, 'Error');

      const btnGenerate = document.getElementById('btn-generate');
      btnGenerate.innerHTML = `
        <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        <span>Generate Image</span>
      `;
      btnGenerate.disabled = false;
      btnGenerate.classList.remove('btn-disabled');
      btnGenerate.classList.remove('btn-danger');
      btnGenerate.classList.add('btn-primary');
      checkQueueStatus();
      break;
    }

    // progress_state is a newer ComfyUI event (React-based frontend).
    // In modern ComfyUI, KSampler live preview images may be embedded here
    // as base64 data URIs inside the nodes map, instead of binary WS frames.
    case 'progress_state': {
      if (!activePromptId) break;
      if (data.data.prompt_id && data.data.prompt_id !== activePromptId) break;

      const nodes = data.data.nodes;
      if (!nodes || typeof nodes !== 'object') break;

      // Scan all nodes in the progress_state payload for an embedded preview image.
      // ComfyUI encodes the preview as: node.preview = "data:image/jpeg;base64,..."
      // or node.images = [{ dataURL: "..." }].
      let previewDataUrl = null;
      for (const nodeId of Object.keys(nodes)) {
        const n = nodes[nodeId];
        if (!n) continue;
        // Format 1: node.preview is a data URI string
        if (typeof n.preview === 'string' && n.preview.startsWith('data:image')) {
          previewDataUrl = n.preview;
          break;
        }
        // Format 2: node.images array with dataURL field
        if (Array.isArray(n.images) && n.images.length > 0) {
          const first = n.images[0];
          if (first && typeof first.dataURL === 'string' && first.dataURL.startsWith('data:image')) {
            previewDataUrl = first.dataURL;
            break;
          }
        }
      }

      if (previewDataUrl) {
        console.log('[progress_state] Found embedded preview image, displaying...');
        // Revoke previous blob URL (no-op if it was a data URI)
        if (currentPreviewUrl && currentPreviewUrl.startsWith('blob:')) {
          URL.revokeObjectURL(currentPreviewUrl);
        }
        currentPreviewUrl = null; // data URIs don't need revocation

        document.getElementById('display-loading').classList.add('hidden');
        document.getElementById('display-empty').classList.add('hidden');
        document.getElementById('display-image-container').classList.remove('hidden');

        const imgEl = document.getElementById('result-img');
        imgEl.src = previewDataUrl;

        if (isCompareMode) {
          const imgBottom = document.getElementById('compare-img-bottom');
          if (imgBottom) imgBottom.src = previewDataUrl;
        }
        updateCompareButtonState();

        const openBtn = document.getElementById('btn-open-image');
        openBtn.onclick = () => {
          showToast('Generation in Progress', 'Please wait for the final image to complete.', 'success');
        };
      } else {
        // Log the full progress_state payload so we can inspect its structure
        console.log('[progress_state] No preview found. Payload:', JSON.stringify(data.data).substring(0, 500));
      }
      break;
    }

    default:
      break;
  }
}

function updateProgress(val, max, labelText) {
  const fill = document.getElementById('progress-fill');
  const text = document.getElementById('progress-text');
  
  text.textContent = labelText;
  if (max > 0) {
    const pct = (val / max) * 100;
    fill.style.width = `${pct}%`;
  } else {
    fill.style.width = '0%';
  }
}

// ─── Web-UI Workflow Loader (optional, for correct PNG metadata) ──────────────────
// Widget-value index schema per node class_type.
// Maps widget_values array index → the matching API input key.
// Only keys we expose in paramMappings need entries.
const WEB_UI_WIDGET_SCHEMA = {
  'KSampler':                      { 0: 'seed', 2: 'steps', 3: 'cfg', 6: 'denoise' },
  'KSamplerAdvanced':              { 0: 'add_noise', 1: 'noise_seed', 3: 'steps', 4: 'cfg', 7: 'denoise' },
  'RandomNoise':                   { 0: 'noise_seed' },
  'CLIPTextEncode':                { 0: 'text' },
  'TextEncodeQwenImageEditPlus':   { 0: 'prompt' },
  'LoadImage':                     { 0: 'image' },
  'ImageRotate':                   { 0: 'rotation' },
};

// Clone the web-UI format workflow and update widget_values from current UI / lastSubmittedWorkflow
function injectParamsIntoWebUiWorkflow(wuJson) {
  const clone = JSON.parse(JSON.stringify(wuJson));
  const wf = lastSubmittedWorkflow || currentWorkflow;
  if (!Array.isArray(clone.nodes)) return clone;

  // Build nodeId → current param values from UI (highest priority) and API workflow
  const uiValues = {}; // { nodeId: { key: value } }
  paramMappings.forEach(mapping => {
    const el = document.getElementById(mapping.elementId);
    if (!el) return;
    const val = mapping.type === 'number' ? Number(el.value) : el.value;
    if (!uiValues[mapping.nodeId]) uiValues[mapping.nodeId] = {};
    uiValues[mapping.nodeId][mapping.key] = val;
  });
  // Use imageSlots state directly (more reliable than DOM hidden inputs)
  imageSlots.forEach(slot => {
    if (slot.nodeId && slot.imageFilename) {
      if (!uiValues[slot.nodeId]) uiValues[slot.nodeId] = {};
      uiValues[slot.nodeId]['image'] = slot.imageFilename;
    }
    if (slot.rotateNodeId && slot.rotation) {
      if (!uiValues[slot.rotateNodeId]) uiValues[slot.rotateNodeId] = {};
      uiValues[slot.rotateNodeId]['rotation'] = slot.rotation;
    }
  });

  // Build a reverse-lookup: plain integer ID → matched API key
  // API format uses composite IDs like "128:126" for grouped/subgraph nodes,
  // while Web UI format always uses the plain integer (126).
  // Strategy: for each plain integer nodeId from Web UI, check:
  //   1. Direct match in uiValues / wf
  //   2. Any key in uiValues / wf that ENDS with ":<nodeId>" (e.g. "128:126" → 126)
  function resolveVals(nodeId) {
    if (uiValues[nodeId]) return uiValues[nodeId];
    if (wf && wf[nodeId]) return wf[nodeId].inputs;
    // Colon-suffix fallback
    const suffix = ':' + nodeId;
    for (const key of Object.keys(uiValues)) {
      if (key === nodeId || key.endsWith(suffix)) return uiValues[key];
    }
    if (wf) {
      for (const key of Object.keys(wf)) {
        if (key === nodeId || key.endsWith(suffix)) return wf[key].inputs;
      }
    }
    return null;
  }

  // Apply parameter values to a single node object
  function applyToNode(node) {
    const schema = WEB_UI_WIDGET_SCHEMA[node.type || ''];
    if (!schema || !Array.isArray(node.widgets_values)) return;
    const vals = resolveVals(String(node.id));
    if (!vals) return;
    for (const [idxStr, apiKey] of Object.entries(schema)) {
      const idx = parseInt(idxStr, 10);
      if (vals[apiKey] !== undefined && idx < node.widgets_values.length) {
        node.widgets_values[idx] = vals[apiKey];
      }
    }
  }

  // Process top-level nodes
  clone.nodes.forEach(applyToNode);

  // IMPORTANT: also process nodes inside subgraphs.
  // LoadImage nodes (126, 124, 125) live inside definitions.subgraphs[].nodes,
  // not in the top-level nodes array. The top-level node 128 is just the subgraph container.
  if (clone.definitions && Array.isArray(clone.definitions.subgraphs)) {
    clone.definitions.subgraphs.forEach(subgraph => {
      if (Array.isArray(subgraph.nodes)) subgraph.nodes.forEach(applyToNode);
    });
  }

  return clone;
}

function initWebUiWorkflowLoader() {
  const btnLoad  = document.getElementById('btn-load-webui-workflow');
  const btnClear = document.getElementById('btn-clear-webui-workflow'); // may be null (button removed)
  const nameEl   = document.getElementById('webui-workflow-filename');
  if (!btnLoad || !nameEl) return;

  // Helper: validate, store and display a Web UI format JSON
  function applyWebUiWorkflow(json, fileName) {
    if (!json.nodes || !Array.isArray(json.nodes)) {
      showToast('Wrong Format',
        'This is an API format file. Use the API Format row below to load it.',
        'error');
      return;
    }
    webUiWorkflow = json;
    localStorage.setItem('comfyui_webui_workflow_json', JSON.stringify(json));
    localStorage.setItem('comfyui_webui_workflow_filename', fileName);
    nameEl.value = fileName;
    nameEl.classList.add('loaded');
    if (btnClear) btnClear.disabled = false;
    showToast('Web UI Workflow Loaded', `${fileName} — layout will be embedded in saved PNGs`, 'success');
  }

  // Restore persisted Web UI workflow from localStorage
  const savedJson = localStorage.getItem('comfyui_webui_workflow_json');
  const savedName = localStorage.getItem('comfyui_webui_workflow_filename');
  if (savedJson && savedName) {
    try {
      webUiWorkflow = JSON.parse(savedJson);
      nameEl.value = savedName;
      nameEl.classList.add('loaded');
      if (btnClear) btnClear.disabled = false;
    } catch (e) {
      localStorage.removeItem('comfyui_webui_workflow_json');
      localStorage.removeItem('comfyui_webui_workflow_filename');
    }
  }

  // Load button — opens file picker for Web UI format
  btnLoad.addEventListener('click', async () => {
    try {
      const fileData = await window.api.selectWorkflowFile();
      if (fileData) applyWebUiWorkflow(fileData.content, fileData.fileName);
    } catch (err) {
      showToast('Load Error', err.message, 'error');
    }
  });

  // Clear button (optional — may not exist in HTML)
  if (btnClear) {
    btnClear.addEventListener('click', () => {
      webUiWorkflow = null;
      localStorage.removeItem('comfyui_webui_workflow_json');
      localStorage.removeItem('comfyui_webui_workflow_filename');
      nameEl.value = '';
      nameEl.classList.remove('loaded');
      btnClear.disabled = true;
      showToast('Workflow Cleared', 'PNG metadata will no longer include workflow layout.', 'warning');
    });
  }
}

// ─── Metadata Collection Helper ────────────────────────────────────────────────────
// Collects current workflow parameter values and formats them for PNG metadata embedding.
// Returns { parameters: string, workflow: string }
function collectImageMetadata() {
  const wf = lastSubmittedWorkflow || currentWorkflow;
  const positivePrompts = [];
  const negativePrompts = [];
  const otherLines = [];

  paramMappings.forEach(mapping => {
    const el = document.getElementById(mapping.elementId);
    if (!el || mapping.isImageSlot) return;

    const rawVal = el.value ? el.value.trim() : '';
    if (!rawVal) return;

    // Determine field role from label text
    const labelEl = el.closest('.param-item')?.querySelector('.param-name');
    const label   = labelEl ? labelEl.textContent : '';
    const isNeg   = label.toLowerCase().includes('negative') || label.includes('\uD83D\uDEAB');

    if (mapping.key === 'text' || mapping.key === 'prompt') {
      if (isNeg) negativePrompts.push(rawVal);
      else       positivePrompts.push(rawVal);
    } else {
      // Use a concise label: prefer meta title from the workflow JSON
      let paramLabel = mapping.key;
      if (wf && wf[mapping.nodeId] && wf[mapping.nodeId]._meta && wf[mapping.nodeId]._meta.title) {
        paramLabel = `${wf[mapping.nodeId]._meta.title} ${mapping.key}`;
      }
      otherLines.push(`${paramLabel}: ${rawVal}`);
    }
  });

  // Assemble SD-style parameters string
  let parametersStr = positivePrompts.join(', ');
  if (negativePrompts.length > 0) {
    parametersStr += `\nNegative prompt: ${negativePrompts.join(', ')}`;
  }
  if (otherLines.length > 0) {
    parametersStr += `\n${otherLines.join(', ')}`;
  }

  return {
    parameters: parametersStr,
    // 'prompt' is the ComfyUI convention for API-format JSON.
    // 'workflow' is reserved for web-UI format (written natively by SaveImage nodes)
    // and must NOT be overwritten here or ComfyUI cannot restore the visual graph.
    prompt: wf ? JSON.stringify(wf) : '',
    // If user provided a web-UI workflow, inject current params and embed as 'workflow'
    ...(webUiWorkflow
      ? { workflow: JSON.stringify(injectParamsIntoWebUiWorkflow(webUiWorkflow)) }
      : {})
  };
}

// 5. Image Display & History Gallery
// promptId is passed so we can guard against saving the same prompt's image twice
// (multiple SaveImage nodes in one workflow each fire 'executed' independently).
async function displayGeneratedImage(filename, subfolder, type, promptId) {
  // Determine synchronously if we should auto-save for this prompt to prevent race conditions
  let shouldAutoSave = false;
  if (outputFolderPath && promptId && savedForPromptId !== promptId) {
    savedForPromptId = promptId; // Mark as saved for this prompt immediately
    shouldAutoSave = true;
  }
  console.log(`[displayGeneratedImage] file=${filename} promptId=${promptId} savedForPromptId=${savedForPromptId} outputFolderPath=${!!outputFolderPath} shouldAutoSave=${shouldAutoSave}`);

  const rand = Math.random();
  // Build the canonical ComfyUI image URL
  const imageUrl = `${comfyuiUrl}/view?filename=${encodeURIComponent(filename)}&type=${type}&subfolder=${encodeURIComponent(subfolder)}&rand=${rand}`;

  // Clean up any blob preview URL to avoid memory leaks
  if (currentPreviewUrl) {
    URL.revokeObjectURL(currentPreviewUrl);
    currentPreviewUrl = null;
  }

  document.getElementById('display-loading').classList.add('hidden');
  document.getElementById('display-image-container').classList.remove('hidden');

  // Fetch image through main process to get a safe base64 data URL
  await loadImageToElement(document.getElementById('result-img'), imageUrl);

  if (isCompareMode) {
    const imgBottom = document.getElementById('compare-img-bottom');
    if (imgBottom) imgBottom.src = document.getElementById('result-img').src;
  }
  updateCompareButtonState();

  // Wire the Open button.
  const openBtn = document.getElementById('btn-open-image');
  
  openBtn.onclick = async () => {
    // If auto-save to custom folder is active, try to open the saved file in the user's custom output folder
    if (outputFolderPath && promptId) {
      if (promptSavedPath) {
        window.api.openPath({ path: promptSavedPath });
      } else {
        // The save is in progress! Show a toast and wait up to 3 seconds for it to complete.
        showToast('Saving Image', 'Image is being saved to your output folder, opening shortly...', 'success');
        let checks = 0;
        const interval = setInterval(() => {
          checks++;
          if (promptSavedPath) {
            clearInterval(interval);
            window.api.openPath({ path: promptSavedPath });
          } else if (checks > 30) { // 3 seconds timeout
            clearInterval(interval);
            // Fallback to ComfyUI temp viewer if save takes too long or fails
            window.api.openImageInViewer({ url: imageUrl, filename });
          }
        }, 100);
      }
    } else if (type === 'output' && comfyOutputDir) {
      // Normal output with ComfyUI native output folder
      const sep = comfyOutputDir.endsWith('\\') || comfyOutputDir.endsWith('/') ? '' : '\\';
      const subPart = subfolder ? subfolder + '\\' : '';
      const localPath = comfyOutputDir + sep + subPart + filename;
      window.api.openPath({ path: localPath });
    } else {
      // Temp / preview image without auto-save
      await window.api.openImageInViewer({ url: imageUrl, filename });
    }
  };

  // Auto Save to local output directory if configured.
  // Guard: only save ONCE per prompt — multiple SaveImage nodes each emit 'executed',
  // so without this guard every output node would trigger a duplicate save.
  if (shouldAutoSave) {
    const downloadUrl = `${comfyuiUrl}/view?filename=${encodeURIComponent(filename)}&type=${type}&subfolder=${encodeURIComponent(subfolder)}`;

    const prefixInput = document.getElementById('autosave-prefix');
    const insertOriginalCheckbox = document.getElementById('autosave-insert-original');
    const paddingInput = document.getElementById('autosave-padding');
    const startingNoInput = document.getElementById('autosave-starting-no');
    const sourceSelect = document.getElementById('autosave-original-source');
    const delimInput = document.getElementById('autosave-delimiter');

    const prefix = prefixInput ? prefixInput.value.trim() : 'autosave';
    const insertOriginal = insertOriginalCheckbox ? insertOriginalCheckbox.checked : true;
    const padding = paddingInput ? parseInt(paddingInput.value, 10) : 4;
    let startingNo = startingNoInput ? parseInt(startingNoInput.value, 10) : 1;
    if (isNaN(startingNo) || startingNo < 0) startingNo = 1;
    let source = sourceSelect ? sourceSelect.value : 'slot1';
    if (source === 'default') source = 'slot1';
    const delimiter = delimInput ? delimInput.value : '_';

    // Collect metadata to embed into the saved PNG
    const pngMetadata = collectImageMetadata();

    // Resolve source image URL for metadata extraction (slot reference image)
    let sourceImageUrl = null;
    if (insertOriginal) {
      const slotIdx = parseInt(source.replace('slot', ''), 10) - 1;
      const slot = imageSlots.find(s => s.slotIndex === slotIdx);
      if (slot && slot.imageFilename) {
        sourceImageUrl = `${comfyuiUrl}/view?filename=${encodeURIComponent(slot.imageFilename)}&type=input`;
      }
    }

    // Parse extension of ComfyUI output filename
    const ext = filename.substring(filename.lastIndexOf('.')) || '.png';

    // Parse basename based on source select
    let originalBasename = '';
    if (insertOriginal) {
      const slotIdx = parseInt(source.replace('slot', ''), 10) - 1;
      const slot = imageSlots.find(s => s.slotIndex === slotIdx);
      if (slot && slot.imageFilename) {
        const fn = slot.imageFilename;
        originalBasename = fn.substring(0, fn.lastIndexOf('.')) || fn;
      }
      // Fallback if slot is empty/not configured
      if (!originalBasename) {
        originalBasename = filename.substring(0, filename.lastIndexOf('.')) || filename;
      }
    }

    // Automatically check and increment starting number to prevent folder collisions
    let currentNo = startingNo;
    let checkIdx = 0;
    const maxChecks = 1000;
    while (checkIdx < maxChecks) {
      const formattedNo = padding > 0 ? String(currentNo).padStart(padding, '0') : String(currentNo);
      const parts = [];
      if (prefix) parts.push(prefix);
      if (insertOriginal && originalBasename) parts.push(originalBasename);
      parts.push(formattedNo);

      const testFilename = parts.filter(Boolean).join(delimiter) + ext;
      const exists = await window.api.checkFileExists({ folderPath: outputFolderPath, filename: testFilename });
      if (!exists) {
        break;
      }
      currentNo++;
      checkIdx++;
    }

    startingNo = currentNo;
    if (startingNoInput) {
      startingNoInput.value = startingNo;
      localStorage.setItem('autosave_starting_no', startingNo);
    }

    const formattedNo = padding > 0 ? String(startingNo).padStart(padding, '0') : String(startingNo);

    const parts = [];
    if (prefix) parts.push(prefix);
    if (insertOriginal && originalBasename) parts.push(originalBasename);
    parts.push(formattedNo);

    const customFilename = parts.filter(Boolean).join(delimiter) + ext;

    try {
      const result = await window.api.saveImageToFolder({
        url: downloadUrl,
        folderPath: outputFolderPath,
        filename: customFilename,
        metadata: pngMetadata,
        sourceImageUrl
      });

      if (result.ok) {
        // Save complete — record path and update the Open button for ALL subsequent output nodes
        promptSavedPath = result.savedPath;
        openBtn.onclick = () => window.api.openPath({ path: result.savedPath });
        console.log(`[AutoSave] Saved: ${result.savedPath}`);

        // Auto increment Starting No.
        const nextStartingNo = startingNo + 1;
        if (startingNoInput) {
          startingNoInput.value = nextStartingNo;
          startingNoInput.dispatchEvent(new Event('change'));
        } else {
          localStorage.setItem('autosave_starting_no', nextStartingNo);
        }
      } else {
        console.error(`[AutoSave Failed] ${result.error}`);
      }
    } catch (err) {
      console.error(`[AutoSave Error] ${err.message}`);
    }
  }
}

// Helper: fetch an image via IPC (main process) and set it as base64 on an <img> element
async function loadImageToElement(imgEl, url) {
  imgEl.src = ''; // Clear previous
  try {
    const result = await window.api.comfyFetchImage({ url });
    if (result.ok) {
      imgEl.src = result.dataUrl;
    } else {
      console.error('Image fetch failed:', result.error);
    }
  } catch (err) {
    console.error('loadImageToElement error:', err);
  }
}

// Helper: Send interrupt command to ComfyUI and queue to delete the prompt ID
async function interruptActiveGeneration() {
  const btnGenerate = document.getElementById('btn-generate');
  btnGenerate.disabled = true;
  btnGenerate.classList.add('btn-disabled');
  btnGenerate.innerHTML = `
    <div class="spinner" style="width: 14px; height: 14px; border-width: 2px;"></div>
    <span>Stopping...</span>
  `;
  
  try {
    window.api.logDebug({ message: `Interrupt requested. activePromptId=${activePromptId}` });
    
    // 1. Send interrupt command to ComfyUI to stop active executions
    await comfyFetch(`/interrupt`, {
      method: 'POST'
    });
    
    // 2. Also try to delete it from the queue if it was pending
    if (activePromptId) {
      await comfyFetch(`/queue`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          delete: [activePromptId]
        })
      });
    }
    
    activePromptId = null;
    pendingPromptId = false;
    
    document.getElementById('current-node').textContent = 'Interrupted';
    document.getElementById('display-loading').classList.add('hidden');
    updateProgress(0, 0, 'Ready');
    
    btnGenerate.disabled = false;
    btnGenerate.classList.remove('btn-disabled');
    btnGenerate.classList.remove('btn-danger');
    btnGenerate.classList.add('btn-primary');
    btnGenerate.innerHTML = `
      <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      <span>Generate Image</span>
    `;
    
    checkQueueStatus();
  } catch (err) {
    console.error('Failed to interrupt generation:', err);
    // Restore Stop button on failure
    btnGenerate.disabled = false;
    btnGenerate.classList.remove('btn-disabled');
    btnGenerate.classList.add('btn-danger');
    btnGenerate.innerHTML = `
      <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></svg>
      <span>Stop Generation</span>
    `;
  }
}

// 6. Queue Generation Prompt Submission
function initGeneration() {
  const btnGenerate = document.getElementById('btn-generate');

  btnGenerate.addEventListener('click', async () => {
    if (window.api && typeof window.api.logDebug === 'function') {
      window.api.logDebug({
        message: `btnGenerate clicked. wsState=${ws ? ws.readyState : 'null'}, hasWorkflow=${!!currentWorkflow}, activePrompt=${activePromptId}, pendingPrompt=${pendingPromptId}`
      });
    }

    try {
      if (activePromptId || pendingPromptId) {
        interruptActiveGeneration();
        return;
      }

      if (!currentWorkflow || !ws || ws.readyState !== WebSocket.OPEN) {
        const warningMsg = `Cannot start generation: currentWorkflow is ${!!currentWorkflow ? 'loaded' : 'null'}, ws is ${ws ? 'instantiated' : 'null'}, readyState is ${ws ? ws.readyState : 'n/a'}`;
        console.warn(warningMsg);
        if (window.api && typeof window.api.logDebug === 'function') {
          window.api.logDebug({ message: warningMsg });
        }
        return;
      }

      // 1. Compile variables from dynamic form into workflow JSON
      const workflowCopy = JSON.parse(JSON.stringify(currentWorkflow));

      paramMappings.forEach(mapping => {
        const inputEl = document.getElementById(mapping.elementId);
        if (inputEl) {
          let value = inputEl.value;

          // Handle seed generation mode
          if (mapping.isSeed && typeof inputEl.randomMode === 'function') {
            const isRandom = inputEl.randomMode();
            if (isRandom) {
              value = Math.floor(Math.random() * 9007199254740991); // ComfyUI Max Seed
              inputEl.value = value; // Update seed text box visually
            }
          }

          // Convert type
          if (mapping.type === 'number') {
            value = Number(value);
          }

          // Write back to workflow JSON clone
          if (workflowCopy[mapping.nodeId] && workflowCopy[mapping.nodeId].inputs) {
            workflowCopy[mapping.nodeId].inputs[mapping.key] = value;
          }
        }
      });

      // 1b. Apply image slot states: handle enabled/rotation, or prune disabled pipelines
      imageSlots.forEach(slotState => {
        const { nodeId, rotateNodeId, enabled, rotation } = slotState;
        if (!nodeId) return; // Inactive slot — nothing to do

        if (enabled) {
          // Update image filename in LoadImage node
          const hiddenInput = document.getElementById(`img-slot-${slotState.slotIndex}-hidden`);
          if (hiddenInput && hiddenInput.value && workflowCopy[nodeId]) {
            workflowCopy[nodeId].inputs.image = hiddenInput.value;
          }
          // Update rotation in ImageRotate node
          if (rotateNodeId && workflowCopy[rotateNodeId]) {
            workflowCopy[rotateNodeId].inputs.rotation = rotation;
          }
        } else {
          // Disabled slot: prune the LoadImage pipeline from the workflow copy
          // 1. Collect all nodes that are part of this image pipeline
          //    (directly or transitively downstream of LoadImage, EXCLUDING sampler/output nodes)
          const IMAGE_PIPELINE_TYPES = new Set([
            'LoadImage', 'ImageRotate', 'ImageFlip',
            'ImageScaleToTotalPixels', 'ImageScale', 'ImageResize',
            'PreviewImage'
          ]);

          // BFS: starting from LoadImage, collect all downstream image-pipeline nodes
          const pipelineNodes = new Set([nodeId]);
          let changed = true;
          while (changed) {
            changed = false;
            for (const wNodeId in workflowCopy) {
              if (pipelineNodes.has(wNodeId)) continue;
              const wNode = workflowCopy[wNodeId];
              if (!wNode || !wNode.inputs) continue;
              if (!IMAGE_PIPELINE_TYPES.has(wNode.class_type)) continue;
              // Check if any input links to a pipelineNode
              for (const inputKey in wNode.inputs) {
                const val = wNode.inputs[inputKey];
                if (Array.isArray(val) && val.length === 2 && pipelineNodes.has(String(val[0]))) {
                  pipelineNodes.add(wNodeId);
                  changed = true;
                  break;
                }
              }
            }
          }

          // Delete all pipeline nodes from the workflow copy
          pipelineNodes.forEach(pid => {
            delete workflowCopy[pid];
          });

          // 2. Remove image links from downstream multi-input nodes (e.g. TextEncodeQwenImageEditPlus)
          //    Any input that still references a deleted node should be removed
          for (const wNodeId in workflowCopy) {
            const wNode = workflowCopy[wNodeId];
            if (!wNode || !wNode.inputs) continue;
            for (const inputKey in wNode.inputs) {
              const val = wNode.inputs[inputKey];
              if (Array.isArray(val) && val.length === 2 && pipelineNodes.has(String(val[0]))) {
                delete wNode.inputs[inputKey];
              }
            }
          }

          window.api.logDebug({ message: `Image slot ${slotState.slotIndex + 1} disabled: pruned nodes [${[...pipelineNodes].join(', ')}]` });
        }
      });

      // Count sampler nodes for progress estimation.
      // We no longer try to read inputs.steps here because it may be a link array [nodeId, outputIdx]
      // rather than a literal number when the workflow uses Primitive/value nodes. Instead, we
      // discover the actual max from the first live 'progress' event each sampler emits.
      estimatedSamplerCount = 0;
      for (const nodeId in workflowCopy) {
        const node = workflowCopy[nodeId];
        if (node) {
          const classType = node.class_type || '';
          if (classType.includes('Sampler') || classType === 'KSampler' || classType === 'KSamplerAdvanced') {
            estimatedSamplerCount++;
          }
        }
      }
      // Reset dynamic tracking state — it will be rebuilt from live progress events
      totalWorkflowSteps = 0;
      samplerNodeMaxMap = {};
      window.api.logDebug({ message: `estimatedSamplerCount on click: ${estimatedSamplerCount}` });

      // Set pending flag BEFORE the POST so execution_start events that arrive
      // before the response can still be matched to this generation.
      activePromptId = null;
      pendingPromptId = true;
      
      // Reset save state for new generation
      savedForPromptId = null;
      promptSavedPath = null;

      // Snapshot the fully-resolved workflow (with randomised seeds) for metadata embedding later
      lastSubmittedWorkflow = workflowCopy;

      // Change generate button to Stop/Interrupt state
      btnGenerate.disabled = false;
      btnGenerate.classList.remove('btn-primary');
      btnGenerate.classList.add('btn-danger');
      btnGenerate.innerHTML = `
        <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></svg>
        <span>Stop Generation</span>
      `;

      // 2. Submit prompt JSON to ComfyUI
      //    Read the selected preview method from the UI dropdown (defaults to 'auto').
      //    Sending preview_method in extra_data overrides the server's --preview-method
      //    CLI flag for this specific prompt, ensuring previews arrive even when ComfyUI
      //    was started without any preview flag.
      const previewSelect = document.getElementById('preview-method-select');
      const previewMethod = (previewSelect && previewSelect.value) || localStorage.getItem('preview_method') || 'auto';

      const payload = {
        client_id: clientId,
        prompt: workflowCopy,
        extra_data: {
          preview_method: previewMethod
        }
      };

      const response = await comfyFetch(`/prompt`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const result = await response.json();
      // If execution_start already arrived and bound activePromptId, don't overwrite.
      // Otherwise set it now from the POST response.
      if (!activePromptId) {
        activePromptId = result.prompt_id;
      }
      pendingPromptId = false;
      window.api.logDebug({ message: `Prompt queued. prompt_id=${result.prompt_id} activePromptId=${activePromptId}` });
      console.log(`Prompt queued successfully! Prompt ID: ${activePromptId}`);

      // Update Queue info
      checkQueueStatus();
    } catch (err) {
      const errMsg = `Failed to submit workflow: ${err.message}`;
      console.error(errMsg, err);
      if (window.api && typeof window.api.logDebug === 'function') {
        window.api.logDebug({ message: `Click handler exception: ${err.stack || err.message}` });
      }
      alert(errMsg);
      // Re-enable and restore button style
      activePromptId = null;
      pendingPromptId = false;
      btnGenerate.disabled = false;
      btnGenerate.classList.remove('btn-disabled');
      btnGenerate.classList.remove('btn-danger');
      btnGenerate.classList.add('btn-primary');
      btnGenerate.innerHTML = `
        <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        <span>Generate Image</span>
      `;
    }
  });
}

// 7. Output Settings Folder Management
function initOutputSettings() {
  const btnSelect = document.getElementById('btn-select-output-folder');
  const btnClear = document.getElementById('btn-clear-output-folder');

  const prefixInput = document.getElementById('autosave-prefix');
  const insertOriginalCheckbox = document.getElementById('autosave-insert-original');
  const paddingInput = document.getElementById('autosave-padding');
  const startingNoInput = document.getElementById('autosave-starting-no');
  const sourceSelect = document.getElementById('autosave-original-source');
  const sourceContainer = document.getElementById('autosave-source-container');
  const delimInput = document.getElementById('autosave-delimiter');

  // Load saved output path
  const savedPath = localStorage.getItem('output_folder_path');
  if (savedPath) {
    outputFolderPath = savedPath;
    updateOutputFolderUI();
  }

  // Load saved naming configuration
  if (prefixInput) {
    prefixInput.value = localStorage.getItem('autosave_prefix') ?? 'autosave';
  }
  if (delimInput) {
    delimInput.value = localStorage.getItem('autosave_delimiter') ?? '_';
  }
  if (insertOriginalCheckbox) {
    insertOriginalCheckbox.checked = localStorage.getItem('autosave_insert_original') !== 'false';
  }
  if (paddingInput) {
    paddingInput.value = localStorage.getItem('autosave_padding') ?? '4';
  }
  if (startingNoInput) {
    startingNoInput.value = localStorage.getItem('autosave_starting_no') ?? '1';
  }
  if (sourceSelect) {
    let savedSource = localStorage.getItem('autosave_original_source');
    if (savedSource === 'default') savedSource = 'slot1';
    sourceSelect.value = savedSource ?? 'slot1';
  }

  // Helper function to toggle source select visibility
  function updateSourceVisibility() {
    if (sourceContainer && insertOriginalCheckbox) {
      sourceContainer.style.display = insertOriginalCheckbox.checked ? 'flex' : 'none';
    }
  }
 
  // Helper to check if file already exists in output folder and automatically increment starting number until available.
  // startFrom: scan begins from this number (pass 1 to reset; omit to continue from current input value).
  async function checkAndIncrementStartingNo(startFrom = null) {
    if (!outputFolderPath) return;

    const prefix = prefixInput ? prefixInput.value.trim() : 'autosave';
    const insertOriginal = insertOriginalCheckbox ? insertOriginalCheckbox.checked : true;
    const padding = paddingInput ? parseInt(paddingInput.value, 10) : 4;
    let startingNo = startFrom !== null ? startFrom
                   : (startingNoInput ? parseInt(startingNoInput.value, 10) : 1);
    if (isNaN(startingNo) || startingNo < 1) startingNo = 1;
    let source = sourceSelect ? sourceSelect.value : 'slot1';
    if (source === 'default') source = 'slot1';
    const delimiter = delimInput ? delimInput.value : '_';

    let originalBasename = 'example_original';
    if (insertOriginal) {
      const slotIdx = parseInt(source.replace('slot', ''), 10) - 1;
      const slot = imageSlots.find(s => s.slotIndex === slotIdx);
      if (slot && slot.imageFilename) {
        const fn = slot.imageFilename;
        originalBasename = fn.substring(0, fn.lastIndexOf('.')) || fn;
      } else {
        originalBasename = `slot${slotIdx + 1}_empty`;
      }
    }

    let currentNo = startingNo;
    let checkIdx = 0;
    const maxChecks = 1000;
    let hasChanged = false;

    while (checkIdx < maxChecks) {
      const formattedNo = padding > 0 ? String(currentNo).padStart(padding, '0') : String(currentNo);
      const parts = [];
      if (prefix) parts.push(prefix);
      if (insertOriginal && originalBasename) parts.push(originalBasename);
      parts.push(formattedNo);

      // Check common image extensions to prevent any extension collision
      let exists = false;
      const exts = ['.png', '.jpg', '.jpeg', '.webp'];
      for (const e of exts) {
        const testFilename = parts.filter(Boolean).join(delimiter) + e;
        const existsForExt = await window.api.checkFileExists({ folderPath: outputFolderPath, filename: testFilename });
        if (existsForExt) {
          exists = true;
          break;
        }
      }

      if (!exists) break;
      currentNo++;
      hasChanged = true;
      checkIdx++;
    }

    // Update input if value changed, or if we were asked to reset (startFrom was provided)
    if ((hasChanged || startFrom !== null) && startingNoInput) {
      startingNoInput.value = currentNo;
      localStorage.setItem('autosave_starting_no', currentNo);
      updatePreview();
    }
  }

  // Helper function to update filename preview
  function updatePreview() {
    const prefix = prefixInput ? prefixInput.value.trim() : 'autosave';
    const insertOriginal = insertOriginalCheckbox ? insertOriginalCheckbox.checked : true;
    const padding = paddingInput ? parseInt(paddingInput.value, 10) : 4;
    const startingNo = startingNoInput ? parseInt(startingNoInput.value, 10) : 1;
    let source = sourceSelect ? sourceSelect.value : 'slot1';
    if (source === 'default') source = 'slot1';
    const delimiter = delimInput ? delimInput.value : '_';

    // Update Slot option labels in the dropdown with actual filenames
    if (sourceSelect) {
      for (let i = 1; i <= 3; i++) {
        const option = sourceSelect.querySelector(`option[value="slot${i}"]`);
        if (option) {
          const slot = imageSlots.find(s => s.slotIndex === i - 1);
          if (slot && slot.nodeId) {
            if (slot.enabled && slot.imageFilename) {
              option.textContent = `Slot ${i}: ${slot.imageFilename}`;
            } else if (!slot.enabled && slot.imageFilename) {
              option.textContent = `Slot ${i}: ${slot.imageFilename} (disabled)`;
            } else {
              option.textContent = `Slot ${i}: (empty)`;
            }
          } else {
            option.textContent = `Slot ${i}: (inactive)`;
          }
        }
      }
    }

    let originalBasename = 'example_original';
    if (insertOriginal) {
      const slotIdx = parseInt(source.replace('slot', ''), 10) - 1;
      const slot = imageSlots.find(s => s.slotIndex === slotIdx);
      if (slot && slot.imageFilename) {
        const fn = slot.imageFilename;
        originalBasename = fn.substring(0, fn.lastIndexOf('.')) || fn;
      } else {
        originalBasename = `slot${slotIdx + 1}_empty`;
      }
    }

    const formattedNo = padding > 0 ? String(startingNo).padStart(padding, '0') : String(startingNo);

    const parts = [];
    if (prefix) parts.push(prefix);
    if (insertOriginal && originalBasename) parts.push(originalBasename);
    parts.push(formattedNo);

    const previewName = parts.filter(Boolean).join(delimiter) + '.png';
    const previewDiv = document.getElementById('autosave-preview-filename');
    if (previewDiv) {
      previewDiv.textContent = previewName;
    }
  }

  // Bind updateAutosavePreview globally so image slot changes can trigger a full recalc from 1
  window.updateAutosavePreview = () => {
    updatePreview();
    checkAndIncrementStartingNo(1); // Input image changed → reset scan to 1
  };

  // Event listeners for inputs to persist settings and update preview
  if (prefixInput) {
    prefixInput.addEventListener('input', () => {
      localStorage.setItem('autosave_prefix', prefixInput.value);
      updatePreview();
    });
    prefixInput.addEventListener('change', () => {
      checkAndIncrementStartingNo(1); // Prefix changed → reset to 1
    });
  }
  if (delimInput) {
    delimInput.addEventListener('input', () => {
      localStorage.setItem('autosave_delimiter', delimInput.value);
      updatePreview();
    });
    delimInput.addEventListener('change', () => {
      checkAndIncrementStartingNo(1); // Delimiter changed → reset to 1
    });
  }
  if (insertOriginalCheckbox) {
    insertOriginalCheckbox.addEventListener('change', () => {
      localStorage.setItem('autosave_insert_original', insertOriginalCheckbox.checked);
      updateSourceVisibility();
      updatePreview();
      checkAndIncrementStartingNo(1); // Toggle changed → reset to 1
    });
  }
  if (sourceSelect) {
    sourceSelect.addEventListener('change', () => {
      localStorage.setItem('autosave_original_source', sourceSelect.value);
      updatePreview();
      checkAndIncrementStartingNo(1); // Source slot changed → reset to 1
    });
  }
  if (paddingInput) {
    paddingInput.addEventListener('input', () => {
      localStorage.setItem('autosave_padding', paddingInput.value);
      updatePreview();
    });
    paddingInput.addEventListener('change', () => {
      localStorage.setItem('autosave_padding', paddingInput.value);
      checkAndIncrementStartingNo(1); // Padding changed → reset to 1
    });
  }
  if (startingNoInput) {
    startingNoInput.addEventListener('input', () => {
      localStorage.setItem('autosave_starting_no', startingNoInput.value);
      updatePreview();
    });
    startingNoInput.addEventListener('change', () => {
      localStorage.setItem('autosave_starting_no', startingNoInput.value);
      checkAndIncrementStartingNo();
    });
  }

  // Update preview and visibility initially
  updateSourceVisibility();
  updatePreview();
  checkAndIncrementStartingNo();

  btnSelect.addEventListener('click', async () => {
    try {
      const selectedDir = await window.api.selectOutputFolder();
      if (selectedDir) {
        outputFolderPath = selectedDir;
        localStorage.setItem('output_folder_path', selectedDir);
        updateOutputFolderUI();
        showToast('Output Folder Set', `Images will be auto-saved to:\n${selectedDir}`, 'success', {
          label: 'Open Folder',
          callback: () => window.api.openPath({ path: selectedDir })
        });
        await checkAndIncrementStartingNo();
      }
    } catch (err) {
      showToast('Selection Error', err.message, 'error');
    }
  });

  btnClear.addEventListener('click', () => {
    outputFolderPath = '';
    localStorage.removeItem('output_folder_path');
    updateOutputFolderUI();
    showToast('Auto-Save Disabled', 'Generated images will only be stored in ComfyUI temp folder.', 'error');
  });
}

function updateOutputFolderUI() {
  const display = document.getElementById('output-path-display');
  const btnClear = document.getElementById('btn-clear-output-folder');

  if (outputFolderPath) {
    display.textContent = outputFolderPath;
    display.title = outputFolderPath;
    display.classList.add('configured');
    btnClear.disabled = false;
  } else {
    display.textContent = 'Not configured';
    display.title = 'Not configured - images will only remain in ComfyUI temp/history';
    display.classList.remove('configured');
    btnClear.disabled = true;
  }
}

// 8. Notification — silent (console only, no popup)
function showToast(title, message, type = 'success', action = null) {
  if (type === 'error') {
    console.error(`[${title}] ${message}`);
  } else {
    console.log(`[${title}] ${message}`);
  }
  // action callbacks are dropped silently
}

function dismissToast() {}

// 9. Image Comparison Slider Features
function initCompareFeature() {
  const compareSourceSelect = document.getElementById('compare-source-select');
  const btnCompare = document.getElementById('btn-compare');
  const sliderContainer = document.getElementById('compare-slider-container');
  const imgTopWrapper = document.getElementById('compare-img-top-wrapper');
  const handle = document.getElementById('compare-handle');

  // Load saved compare source from localStorage (default: 'slot1')
  const savedSource = localStorage.getItem('compare_source') || 'slot1';
  if (compareSourceSelect) {
    compareSourceSelect.value = savedSource;
    selectedCompareSlot = parseInt(savedSource.replace('slot', '')) - 1;
    if (isNaN(selectedCompareSlot) || selectedCompareSlot < 0) {
      selectedCompareSlot = 0;
    }

    compareSourceSelect.addEventListener('change', () => {
      localStorage.setItem('compare_source', compareSourceSelect.value);
      selectedCompareSlot = parseInt(compareSourceSelect.value.replace('slot', '')) - 1;
      if (isNaN(selectedCompareSlot) || selectedCompareSlot < 0) {
        selectedCompareSlot = 0;
      }

      // If we are currently in compare mode and switch to a slot that doesn't have an image, exit compare mode
      const slot = imageSlots.find(s => s.slotIndex === selectedCompareSlot);
      if (isCompareMode && (!slot || !slot.imageFilename)) {
        toggleCompareMode(false);
      }
      updateCompareButtonState();
    });
  }

  if (btnCompare) {
    btnCompare.addEventListener('click', () => {
      toggleCompareMode(!isCompareMode);
    });
  }

  // Setup dragging handler for the slider
  let isDragging = false;

  function updateSlider(clientX) {
    if (!sliderContainer || !imgTopWrapper || !handle) return;
    const rect = sliderContainer.getBoundingClientRect();
    if (rect.width === 0) return;
    let percentage = ((clientX - rect.left) / rect.width) * 100;
    percentage = Math.max(0, Math.min(100, percentage));
    
    // Update clip-path on top image wrapper (vertical split)
    imgTopWrapper.style.clipPath = `polygon(0 0, ${percentage}% 0, ${percentage}% 100%, 0 100%)`;
    handle.style.left = `${percentage}%`;
  }

  if (handle && sliderContainer) {
    handle.addEventListener('mousedown', (e) => {
      isDragging = true;
      e.preventDefault();
    });

    window.addEventListener('mouseup', () => {
      isDragging = false;
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      updateSlider(e.clientX);
    });

    // Touchscreen/Mobile support
    handle.addEventListener('touchstart', (e) => {
      isDragging = true;
      // Do not call preventDefault on touchstart unless necessary, but it helps avoid scrolling/dragging behavior
      if (e.cancelable) e.preventDefault();
    });
    window.addEventListener('touchend', () => {
      isDragging = false;
    });
    window.addEventListener('touchmove', (e) => {
      if (!isDragging) return;
      updateSlider(e.touches[0].clientX);
    });
  }

  // Set initial button state on load
  updateCompareButtonState();
}

// Function to update the disabled state of the compare button based on slot image availability
function updateCompareButtonState() {
  const btnCompare = document.getElementById('btn-compare');
  if (!btnCompare) return;

  const resultImg = document.getElementById('result-img');
  // Check if resultImg actually has an active generated, preview, or blob image loaded
  const hasSrc = resultImg && resultImg.src && (
    resultImg.src.includes('view?filename=') || 
    resultImg.src.startsWith('data:image') || 
    resultImg.src.startsWith('blob:')
  );

  const slot = imageSlots.find(s => s.slotIndex === selectedCompareSlot);
  const hasInputImg = slot && slot.imageFilename;

  if (hasSrc && hasInputImg) {
    btnCompare.disabled = false;
  } else {
    btnCompare.disabled = true;
    if (isCompareMode) {
      toggleCompareMode(false);
    }
  }
}

// Helper to toggle compare mode visually
async function toggleCompareMode(forceState = null) {
  const resultImg = document.getElementById('result-img');
  const sliderContainer = document.getElementById('compare-slider-container');
  const btnCompare = document.getElementById('btn-compare');
  const imgBottom = document.getElementById('compare-img-bottom');
  const imgTop = document.getElementById('compare-img-top');
  const imgTopWrapper = document.getElementById('compare-img-top-wrapper');
  const handle = document.getElementById('compare-handle');

  const nextState = forceState !== null ? forceState : !isCompareMode;
  
  if (nextState === isCompareMode) return;
  isCompareMode = nextState;

  if (isCompareMode) {
    // Enter compare mode
    if (btnCompare) {
      btnCompare.classList.add('active-compare');
      btnCompare.textContent = 'Exit Compare';
    }
    if (resultImg) resultImg.classList.add('hidden');
    if (sliderContainer) sliderContainer.classList.remove('hidden');

    // Bottom image gets the output image
    if (imgBottom && resultImg) {
      imgBottom.src = resultImg.src;
    }

    // Top image gets the selected input image
    const slot = imageSlots.find(s => s.slotIndex === selectedCompareSlot);
    if (slot && slot.imageFilename && imgTop) {
      const inputUrl = `${comfyuiUrl}/view?filename=${encodeURIComponent(slot.imageFilename)}&type=input`;
      
      // Load input image and apply rotation if needed
      const ROTATION_DEGS = { none: 0, '90': 90, '180': 180, '270': 270 };
      const rotationAngle = ROTATION_DEGS[slot.rotation] || 0;
      imgTop.style.transform = `rotate(${rotationAngle}deg)`;

      // Fetch input image safely through Main Process proxy
      await loadImageToElement(imgTop, inputUrl);
    }

    // Reset slider to middle position (50%)
    if (imgTopWrapper) {
      imgTopWrapper.style.clipPath = 'polygon(0 0, 50% 0, 50% 100%, 0 100%)';
    }
    if (handle) {
      handle.style.left = '50%';
    }
  } else {
    // Exit compare mode
    if (btnCompare) {
      btnCompare.classList.remove('active-compare');
      btnCompare.textContent = 'Compare';
    }
    if (sliderContainer) sliderContainer.classList.add('hidden');
    if (resultImg) resultImg.classList.remove('hidden');
  }
}
