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
let savedPromptIds = new Set();
let completedPromptIds = new Set();
let myQueuedPromptIds = new Set();
let outputFolderPath = '';
let watchFolderPath = '';
let currentPreviewUrl = null; // Stores object URL for active generation's in-progress preview
let lastSubmittedWorkflow = null; // Snapshot of the workflow actually sent (with randomized seeds)
let webUiWorkflow = null;         // Optional web-UI format workflow JSON for PNG metadata embedding
let isCompareMode = false;        // Active state of image comparison mode
let selectedCompareSlot = 0;      // Current compare slot selected (0: Slot 1, 1: Slot 2, 2: Slot 3)
let isStartupCheckActive = true;  // Flag to track the initial startup connection check
let isRetryingConnection = false; // Flag to track if we are currently retrying the connection from the modal

// Job Timer State
let jobTimerInterval = null;
let jobStartTime = null;

// Global progress state for multi-sampler workflow tracking (fully dynamic — discovered from live WS events)
let totalWorkflowSteps = 0;      // Running estimate of total steps (updated as new sampler nodes are seen)
let currentExecutionSteps = 0;   // Accumulated steps of completed sampler nodes in current run
let lastSamplerNodeId = null;    // The ID of the KSampler currently (or most recently) executing
let lastSamplerStep = 0;         // Last reported step of the current KSampler node
let samplerNodeMaxMap = {};       // Maps nodeId -> max steps, discovered from live progress events
let estimatedSamplerCount = 0;   // Number of sampler nodes in the workflow (used for early estimate)
let promptSamplerCountsMap = {}; // Maps prompt_id -> estimatedSamplerCount
let promptJobStates = new Map(); // Maps prompt_id -> { paramValues, imageSlots, workflow }


// Helper to map UI rotation ('none', '90', '180', '270') to ComfyUI ImageRotate input ('none', '90 degrees', '180 degrees', '270 degrees')
function mapUiRotationToComfy(val) {
  if (val === 'none') return 'none';
  if (val === '90' || val === '180' || val === '270') {
    return `${val} degrees`;
  }
  return val;
}

// Helper to map ComfyUI ImageRotate input to UI rotation
function mapComfyRotationToUi(val) {
  if (!val || val === 'none') return 'none';
  const match = val.match(/^(\d+)(?:\s*degrees)?$/i);
  if (match) {
    return match[1];
  }
  return 'none';
}

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

// Helper to clear history for a specific prompt ID when BOTH image save and workflow execution are completed.
async function checkAndClearComfyHistory(promptId) {
  if (!promptId) return;

  const hasAutoSave = !!outputFolderPath;
  const isSaved = !hasAutoSave || savedPromptIds.has(promptId);
  const isCompleted = completedPromptIds.has(promptId);

  if (window.api && typeof window.api.logDebug === 'function') {
    window.api.logDebug({ message: `checkAndClearComfyHistory called: promptId=${promptId}, hasAutoSave=${hasAutoSave}, isSaved=${isSaved}, isCompleted=${isCompleted}` });
  }

  if (isSaved && isCompleted) {
    promptJobStates.delete(promptId);
    savedPromptIds.delete(promptId);
    completedPromptIds.delete(promptId);

    const clearHistoryCheckbox = document.getElementById('autosave-clear-history');
    const shouldClear = clearHistoryCheckbox ? clearHistoryCheckbox.checked : false;
    if (!shouldClear) return;

    try {
      let foundInHistory = false;
      let retries = 10; // Max 10 retries (5 seconds total)
      
      // Phase 1: Wait for the prompt to appear in the server history database
      while (retries > 0) {
        const historyResp = await comfyFetch('/history');
        const historyData = await historyResp.json();
        
        if (historyData && historyData[promptId]) {
          foundInHistory = true;
          if (window.api && typeof window.api.logDebug === 'function') {
            window.api.logDebug({ message: `Prompt ${promptId} found in history after ${10 - retries} retries. Proceeding to delete.` });
          }
          break;
        }
        
        // Wait 500ms before checking again
        await new Promise(resolve => setTimeout(resolve, 500));
        retries--;
      }

      if (!foundInHistory) {
        if (window.api && typeof window.api.logDebug === 'function') {
          window.api.logDebug({ message: `Warning: Prompt ${promptId} did not appear in ComfyUI history after timeout. Will attempt delete anyway.` });
        }
      }

      // Phase 2: Send delete request and verify deletion (retry up to 5 times if needed)
      let deleteRetries = 5;
      let isDeleted = false;

      while (deleteRetries > 0 && !isDeleted) {
        if (window.api && typeof window.api.logDebug === 'function') {
          window.api.logDebug({ message: `Sending delete request for promptId=${promptId} (attempt ${6 - deleteRetries}/5)` });
        }
        
        await comfyFetch('/history', {
          method: 'POST',
          body: { delete: [promptId] }
        });

        // Wait 300ms for deletion to propagate, then check history again
        await new Promise(resolve => setTimeout(resolve, 300));
        
        const checkResp = await comfyFetch('/history');
        const checkData = await checkResp.json();
        
        if (!checkData || !checkData[promptId]) {
          isDeleted = true;
          if (window.api && typeof window.api.logDebug === 'function') {
            window.api.logDebug({ message: `Success: Prompt ${promptId} confirmed deleted from ComfyUI history.` });
          }
          break;
        }

        deleteRetries--;
        await new Promise(resolve => setTimeout(resolve, 500)); // wait a bit before retrying delete
      }

      if (!isDeleted) {
        if (window.api && typeof window.api.logDebug === 'function') {
          window.api.logDebug({ message: `Error: Prompt ${promptId} could not be confirmed deleted from ComfyUI history after retries.` });
        }
      }
      
    } catch (err) {
      if (window.api && typeof window.api.logDebug === 'function') {
        window.api.logDebug({ message: `Failed in checkAndClearComfyHistory: ${err.message}` });
      }
      console.error('[ComfyUI] Failed to clear history:', err);
    } finally {
      savedPromptIds.delete(promptId);
      completedPromptIds.delete(promptId);
    }
  }
}

// Initialize DOM elements
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initConnection();
  initWorkflowLoader();
  initImportPrompt();
  initClearSlots();
  initWebUiWorkflowLoader();
  initCombineWorkflowsDialog();
  initGeneration();
  initOutputSettings();
  initCompareFeature();
  initConnectionModal();
  initFacefusionTab();
  initAutomationSettings();
  initGeneralSettings();
  initJobsModal();
  initQwenAutoAspectControls();

  // Initialize mini status indicators in Execution Monitor
  if (typeof updateComfyWorkingStatus === 'function') updateComfyWorkingStatus(false);
  if (typeof updateFFWorkingStatus === 'function') updateFFWorkingStatus(false);
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
  
  const btnRun = document.getElementById('btn-run');
  const btnStop = document.getElementById('btn-stop');
  if (state === 'connected' && currentWorkflow) {
    if (btnRun) {
      btnRun.classList.remove('btn-disabled');
      btnRun.disabled = false;
    }
    // Refresh model loader options when connected
    refreshLoaderChoices();
  } else {
    if (btnRun) {
      btnRun.classList.add('btn-disabled');
      btnRun.disabled = true;
    }
    if (btnStop) {
      btnStop.classList.add('btn-disabled');
      btnStop.disabled = true;
    }
  }

  // Handle connection modal state
  const errorMsg = document.getElementById('modal-error-msg');
  if (state === 'connected') {
    if (isStartupCheckActive) {
      isStartupCheckActive = false;
    }
    if (isRetryingConnection) {
      isRetryingConnection = false;
      const btnConfigure = document.getElementById('btn-modal-configure');
      const btnRetry = document.getElementById('btn-modal-retry');
      if (btnRetry) {
        btnRetry.textContent = 'Retry Connection';
        btnRetry.disabled = false;
      }
      if (btnConfigure) btnConfigure.disabled = false;
    }
    if (errorMsg) {
      errorMsg.textContent = '';
      errorMsg.classList.add('hidden');
    }
    hideConnectionModal();
  } else if (state === 'disconnected') {
    if (isStartupCheckActive) {
      isStartupCheckActive = false;
      showConnectionModal();
      switchToTab('tab-service');
    }
    if (isRetryingConnection) {
      isRetryingConnection = false;
      const btnConfigure = document.getElementById('btn-modal-configure');
      const btnRetry = document.getElementById('btn-modal-retry');
      if (btnRetry) {
        btnRetry.textContent = 'Retry Connection';
        btnRetry.disabled = false;
      }
      if (btnConfigure) btnConfigure.disabled = false;
      
      if (errorMsg) {
        errorMsg.textContent = `Retry failed: ${label || 'Could not connect'}`;
        errorMsg.classList.remove('hidden');
      }
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
  const btnStop = document.getElementById('btn-stop');
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    if (btnStop) {
      btnStop.classList.add('btn-disabled');
      btnStop.disabled = true;
    }
    return;
  }
  
  try {
    const response = await comfyFetch(`/queue`);
    const data = await response.json();
    const running = data.queue_running.length;
    const pending = data.queue_pending.length;
    document.getElementById('queue-status').textContent = `Running: ${running} / Pending: ${pending}`;
    
    if (btnStop) {
      if (running > 0 || pending > 0 || activePromptId) {
        btnStop.classList.remove('btn-disabled');
        btnStop.disabled = false;
      } else {
        btnStop.classList.add('btn-disabled');
        btnStop.disabled = true;
      }
    }
  } catch (err) {
    document.getElementById('queue-status').textContent = 'Fetch Failed';
  }
}

// 3. Workflow File Loading & Dynamic Input UI Generation
function initWorkflowLoader() {
  const btnLoad   = document.getElementById('btn-load-workflow');
  const btnReload = document.getElementById('btn-reload-workflow');

  // Load button — opens file picker with smart auto-detection (Combined, API, or WebUI)
  if (btnLoad) {
    btnLoad.addEventListener('click', async () => {
      try {
        const fileData = await window.api.selectWorkflowFile();
        if (fileData) {
          const content = fileData.content;
          const fileName = fileData.fileName;
          
          if (content && content.type === 'comfyui_listener_combined') {
            // 1. Combined format
            if (content.webui) {
              applyWebUiWorkflow(content.webui, fileName + ' (Web UI)');
            }
            if (content.api) {
              loadWorkflow(content.api, fileName, true);
            }
            showToast('Combined Workflow Loaded', `Successfully loaded combined data from ${fileName}`, 'success');
          } else {
            // 2. Single format - check structure
            const keys = Object.keys(content);
            const isApi = keys.some(k => !isNaN(parseInt(k)));
            
            if (isApi) {
              // Load API format workflow
              loadWorkflow(content, fileName, true);
              
              // Search for sister WebUI workflow
              if (fileData.sister && fileData.sister.content && Array.isArray(fileData.sister.content.nodes)) {
                applyWebUiWorkflow(fileData.sister.content, fileData.sister.fileName);
                showToast('Auto-linked Web UI Workflow', `System automatically found and loaded the related Web UI version: ${fileData.sister.fileName}`, 'success');
              } else {
                // Clear old WebUI workflow
                webUiWorkflow = null;
                localStorage.removeItem('comfyui_webui_workflow_json');
                localStorage.removeItem('comfyui_webui_workflow_filename');
                const nameEl = document.getElementById('webui-workflow-filename');
                if (nameEl) {
                  nameEl.value = '';
                  nameEl.classList.remove('loaded');
                }
              }
            } else if (content.nodes && Array.isArray(content.nodes)) {
              // Load WebUI format workflow
              applyWebUiWorkflow(content, fileName);
              
              // Search for sister API workflow
              if (fileData.sister && fileData.sister.content) {
                const sisterKeys = Object.keys(fileData.sister.content);
                const sisterIsApi = sisterKeys.some(k => !isNaN(parseInt(k)));
                if (sisterIsApi) {
                  loadWorkflow(fileData.sister.content, fileData.sister.fileName, true);
                  showToast('Auto-linked API Workflow', `System automatically found and loaded the related API version: ${fileData.sister.fileName}`, 'success');
                }
              } else {
                // Clear old API workflow
                currentWorkflow = null;
                localStorage.removeItem('comfyui_workflow_json');
                localStorage.removeItem('comfyui_workflow_filename');
                const filenameEl = document.getElementById('workflow-filename');
                if (filenameEl) {
                  filenameEl.value = '';
                  filenameEl.classList.remove('loaded');
                }
              }
            } else {
              showToast('Invalid Workflow', 'This file does not appear to be a valid ComfyUI JSON format.', 'error');
            }
          }
        }
      } catch (err) {
        showToast('Load Error', err.message, 'error');
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

      const btnRun = document.getElementById('btn-run');
      if (btnRun) {
        btnRun.classList.add('btn-disabled');
        btnRun.disabled = true;
      }
      const btnStop = document.getElementById('btn-stop');
      if (btnStop) {
        btnStop.classList.add('btn-disabled');
        btnStop.disabled = true;
      }

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

    // Also persist image slot rotation and flip values back into the workflow JSON
    imageSlots.forEach(slotState => {
      if (!slotState.nodeId) return;
      // Persist image filename
      const hiddenInput = document.getElementById(`img-slot-${slotState.slotIndex}-hidden`);
      if (hiddenInput && currentWorkflow[slotState.nodeId]) {
        currentWorkflow[slotState.nodeId].inputs.image = hiddenInput.value || '';
      }
      // Persist rotation value
      if (slotState.rotateNodeId && currentWorkflow[slotState.rotateNodeId]) {
        currentWorkflow[slotState.rotateNodeId].inputs.rotation = mapUiRotationToComfy(slotState.rotation);
      }
      // Persist flip value
      if (slotState.flipNodeId && currentWorkflow[slotState.flipNodeId]) {
        if (slotState.flip === 'horizontal') {
          currentWorkflow[slotState.flipNodeId].inputs.flip_method = "y-axis: horizontally";
        } else if (slotState.flip === 'vertical') {
          currentWorkflow[slotState.flipNodeId].inputs.flip_method = "x-axis: vertically";
        } else {
          currentWorkflow[slotState.flipNodeId].inputs.flip_method = "none";
        }
      }
    });

    localStorage.setItem('comfyui_workflow_json', JSON.stringify(currentWorkflow));
    localStorage.setItem('comfyui_workflow_filename', currentWorkflowFilename);
  }
}


function captureCurrentSettings() {
  const settings = {
    clipPositive: [],
    clipNegative: [],
    qwenPositive: [],
    qwenNegative: [],
    imageSlots: []
  };

  if (!currentWorkflow) return settings;

  // 1. Capture prompts from paramMappings and DOM
  paramMappings.forEach(mapping => {
    const inputEl = document.getElementById(mapping.elementId);
    if (!inputEl) return;

    const value = inputEl.value;
    const parentItem = inputEl.closest('.param-item');
    if (!parentItem) return;

    const nameEl = parentItem.querySelector('.param-name');
    const labelText = nameEl ? nameEl.textContent : '';

    const node = currentWorkflow[mapping.nodeId];
    if (!node) return;
    const isClip = mapping.key === 'text' && node.class_type === 'CLIPTextEncode';
    const isQwen = mapping.key === 'prompt' && node.class_type === 'TextEncodeQwenImageEditPlus';

    if (isClip) {
      if (labelText.toLowerCase().includes('negative')) {
        settings.clipNegative.push(value);
      } else {
        settings.clipPositive.push(value);
      }
    } else if (isQwen) {
      if (labelText.toLowerCase().includes('negative')) {
        settings.qwenNegative.push(value);
      } else {
        settings.qwenPositive.push(value);
      }
    }
  });

  // 2. Capture image slot settings
  imageSlots.forEach((slot) => {
    settings.imageSlots.push({
      imageFilename: slot.imageFilename,
      enabled: slot.enabled,
      rotation: slot.rotation,
      flip: slot.flip
    });
  });

  return settings;
}

function applyPreservedSettings(workflow, settings) {
  if (!settings) return;

  // 1. Pre-scan for positive/negative nodes (just like generateDynamicParamsUI)
  const knownPositiveNodes = new Set();
  const knownNegativeNodes = new Set();

  const traceConditioning = (startNodeId, visited = new Set()) => {
    if (!startNodeId || visited.has(startNodeId)) return [];
    visited.add(startNodeId);
    const node = workflow[startNodeId];
    if (!node) return [];
    const classType = node.class_type || '';
    if (classType === 'CLIPTextEncode' || classType === 'TextEncodeQwenImageEditPlus') {
      return [startNodeId];
    }
    let found = [];
    if (node.inputs) {
      for (const key in node.inputs) {
        const val = node.inputs[key];
        if (Array.isArray(val) && val.length === 2 && typeof val[0] === 'string') {
          const kLower = key.toLowerCase();
          if (kLower.includes('conditioning') || 
              kLower.includes('positive') || 
              kLower.includes('negative') ||
              kLower.includes('prompt')) {
            found = found.concat(traceConditioning(String(val[0]), visited));
          }
        }
      }
    }
    return found;
  };

  for (const nodeId in workflow) {
    const node = workflow[nodeId];
    if (!node || !node.inputs) continue;
    const classType = node.class_type || '';
    const isSampler = classType.includes('Sampler') || classType === 'KSampler' || classType === 'KSamplerAdvanced';
    if (isSampler) {
      if (node.inputs.positive && Array.isArray(node.inputs.positive) && node.inputs.positive.length === 2) {
        const posNodes = traceConditioning(String(node.inputs.positive[0]));
        posNodes.forEach(id => knownPositiveNodes.add(id));
      }
      if (node.inputs.negative && Array.isArray(node.inputs.negative) && node.inputs.negative.length === 2) {
        const negNodes = traceConditioning(String(node.inputs.negative[0]));
        negNodes.forEach(id => knownNegativeNodes.add(id));
      }
    }
  }

  // Count prompt slots encountered in the new workflow so we can map them index-by-index
  let clipPositiveIdx = 0;
  let clipNegativeIdx = 0;
  let qwenPositiveIdx = 0;
  let qwenNegativeIdx = 0;

  // 2. Iterate through all nodes in the workflow JSON and update prompt values
  for (const nodeId in workflow) {
    const node = workflow[nodeId];
    if (!node || !node.inputs) continue;
    
    const classType = node.class_type || '';
    const nodeTitle = (node._meta && node._meta.title) ? node._meta.title : `${classType} (#${nodeId})`;

    if (classType === 'CLIPTextEncode' && typeof node.inputs.text === 'string') {
      let isNegative = false;
      if (knownNegativeNodes.has(nodeId)) {
        isNegative = true;
      } else if (knownPositiveNodes.has(nodeId)) {
        isNegative = false;
      } else {
        const val = node.inputs.text;
        isNegative = val.toLowerCase().includes('bad') || 
                     val.toLowerCase().includes('ugly') || 
                     val.toLowerCase().includes('nsfw') || 
                     nodeTitle.toLowerCase().includes('negative');
      }

      if (isNegative) {
        if (clipNegativeIdx < settings.clipNegative.length) {
          node.inputs.text = settings.clipNegative[clipNegativeIdx];
        }
        clipNegativeIdx++;
      } else {
        if (clipPositiveIdx < settings.clipPositive.length) {
          node.inputs.text = settings.clipPositive[clipPositiveIdx];
        }
        clipPositiveIdx++;
      }
    } else if (classType === 'TextEncodeQwenImageEditPlus' && typeof node.inputs.prompt === 'string') {
      let isNegative = false;
      if (knownNegativeNodes.has(nodeId)) {
        isNegative = true;
      } else if (knownPositiveNodes.has(nodeId)) {
        isNegative = false;
      } else {
        const val = node.inputs.prompt;
        const lowerTitle = nodeTitle.toLowerCase();
        if (lowerTitle.includes('negative') || lowerTitle.includes('neg')) {
          isNegative = true;
        } else if (lowerTitle.includes('positive') || lowerTitle.includes('postive') || lowerTitle.includes('pos')) {
          isNegative = false;
        } else {
          isNegative = val.trim() === '';
        }
      }

      if (isNegative) {
        if (qwenNegativeIdx < settings.qwenNegative.length) {
          node.inputs.prompt = settings.qwenNegative[qwenNegativeIdx];
        }
        qwenNegativeIdx++;
      } else {
        if (qwenPositiveIdx < settings.qwenPositive.length) {
          node.inputs.prompt = settings.qwenPositive[qwenPositiveIdx];
        }
        qwenPositiveIdx++;
      }
    }
  }

  // 3. Update image slots in the new workflow
  const loadImageNodes = {};
  const rotateNodeForLoad = {};
  const flipNodeForLoad = {};

  for (const nodeId in workflow) {
    const node = workflow[nodeId];
    if (!node || !node.inputs) continue;
    if (node.class_type === 'LoadImage') {
      loadImageNodes[nodeId] = node;
    }
  }

  const loadIds = Object.keys(loadImageNodes);
  loadIds.sort((a, b) => parseInt(a) - parseInt(b));

  for (const loadId of loadIds) {
    for (const nodeId in workflow) {
      const node = workflow[nodeId];
      if (!node || !node.inputs) continue;
      const imgInput = node.inputs.image;
      if (Array.isArray(imgInput) && String(imgInput[0]) === loadId) {
        if (node.class_type === 'ImageRotate') {
          rotateNodeForLoad[loadId] = nodeId;
        } else if (node.class_type === 'ImageFlip') {
          flipNodeForLoad[loadId] = nodeId;
        }
      }
    }
    const rotateId = rotateNodeForLoad[loadId];
    if (rotateId) {
      for (const nodeId in workflow) {
        const node = workflow[nodeId];
        if (!node || !node.inputs) continue;
        const imgInput = node.inputs.image;
        if (Array.isArray(imgInput) && String(imgInput[0]) === rotateId && node.class_type === 'ImageFlip') {
          flipNodeForLoad[loadId] = nodeId;
        }
      }
    }
    const flipId = flipNodeForLoad[loadId];
    if (flipId) {
      for (const nodeId in workflow) {
        const node = workflow[nodeId];
        if (!node || !node.inputs) continue;
        const imgInput = node.inputs.image;
        if (Array.isArray(imgInput) && String(imgInput[0]) === flipId && node.class_type === 'ImageRotate') {
          rotateNodeForLoad[loadId] = nodeId;
        }
      }
    }
  }

  loadIds.forEach((loadId, slotIndex) => {
    if (slotIndex < settings.imageSlots.length) {
      const preservedSlot = settings.imageSlots[slotIndex];

      if (preservedSlot.imageFilename) {
        workflow[loadId].inputs.image = preservedSlot.imageFilename;
      }

      const rotateId = rotateNodeForLoad[loadId];
      if (rotateId && preservedSlot.rotation) {
        workflow[rotateId].inputs.rotation = mapUiRotationToComfy(preservedSlot.rotation);
      }

      const flipId = flipNodeForLoad[loadId];
      if (flipId && preservedSlot.flip) {
        if (preservedSlot.flip === 'horizontal') {
          workflow[flipId].inputs.flip_method = "y-axis: horizontally";
        } else if (preservedSlot.flip === 'vertical') {
          workflow[flipId].inputs.flip_method = "x-axis: vertically";
        } else {
          workflow[flipId].inputs.flip_method = "none";
        }
      }

      localStorage.setItem(`img_slot_${slotIndex}_enabled`, String(preservedSlot.enabled));
      localStorage.setItem(`img_slot_${slotIndex}_flip`, preservedSlot.flip);
    } else {
      // Clear this image slot and reset flip/rotation as it is not present in the imported prompt
      workflow[loadId].inputs.image = "";
      
      const rotateId = rotateNodeForLoad[loadId];
      if (rotateId) {
        workflow[rotateId].inputs.rotation = "none";
      }

      const flipId = flipNodeForLoad[loadId];
      if (flipId) {
        workflow[flipId].inputs.flip_method = "none";
      }

      localStorage.setItem(`img_slot_${slotIndex}_enabled`, "false");
      localStorage.setItem(`img_slot_${slotIndex}_flip`, "none");
    }
  });
}


function loadWorkflow(workflowJson, filename, preserveExisting = false) {
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

  if (preserveExisting) {
    const settings = captureCurrentSettings();
    applyPreservedSettings(workflowJson, settings);
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

  // Enable Run button if connected
  const statusDot = document.getElementById('status-dot');
  if (statusDot.classList.contains('connected')) {
    const btnRun = document.getElementById('btn-run');
    if (btnRun) {
      btnRun.classList.remove('btn-disabled');
      btnRun.disabled = false;
    }
  }
  updateCompareButtonState();
}

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

  const nameEl = document.getElementById('webui-workflow-filename');
  if (nameEl) {
    nameEl.value = fileName;
    nameEl.classList.add('loaded');
  }

  const btnClear = document.getElementById('btn-clear-webui-workflow');
  if (btnClear) {
    btnClear.disabled = false;
  }

  showToast('Web UI Workflow Loaded', `${fileName} — layout will be embedded in saved PNGs`, 'success');
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
  
  const loadersContainer = document.getElementById('loaders-params-container');
  if (loadersContainer) loadersContainer.innerHTML = '';
  const qwenCanvasContainer = document.getElementById('qwen-canvas-params-container');
  if (qwenCanvasContainer) qwenCanvasContainer.innerHTML = '';

  const loadersPanel = document.getElementById('loaders-panel');
  if (loadersPanel) loadersPanel.classList.add('hidden');
  const qwenCanvasPanel = document.getElementById('qwen-canvas-panel');
  if (qwenCanvasPanel) qwenCanvasPanel.classList.add('hidden');

  paramMappings = [];
  imageSlots = [];
  
  let paramCount = 0;
  let qwenCount = 0;

  // --- Pre-scan: Find Loader nodes ---
  const loaderNodes = [];
  for (const nodeId in workflow) {
    const node = workflow[nodeId];
    if (!node || !node.inputs) continue;
    const classType = node.class_type || '';
    if (classType === 'UnetLoaderGGUF' || classType === 'CLIPLoader' || classType === 'CLIPLoaderGGUF' || classType === 'VAELoader') {
      loaderNodes.push({ id: nodeId, node: node, classType });
    }
  }

  if (loaderNodes.length > 0) {
    if (loadersPanel) loadersPanel.classList.remove('hidden');

    const classOrder = {
      'UnetLoaderGGUF': 1,
      'CLIPLoaderGGUF': 2,
      'CLIPLoader': 3,
      'VAELoader': 4
    };
    loaderNodes.sort((a, b) => {
      return (classOrder[a.classType] || 99) - (classOrder[b.classType] || 99);
    });

    loaderNodes.forEach(item => {
      const nodeId = item.id;
      const node = item.node;
      const classType = item.classType;

      let key = null;
      let label = '';
      if (classType === 'UnetLoaderGGUF') {
        key = 'unet_name';
        label = 'UNET Model (GGUF)';
      } else if (classType === 'CLIPLoader' || classType === 'CLIPLoaderGGUF') {
        key = 'clip_name';
        label = 'CLIP Model';
      } else if (classType === 'VAELoader') {
        key = 'vae_name';
        label = 'VAE Model';
      }

      if (key && node.inputs[key] !== undefined) {
        paramCount++;
        const paramId = `param-${nodeId}-${key}`;
        const defaultValue = node.inputs[key];

        const paramEl = createParamElement(paramId, label, nodeId, key, 'select', defaultValue, 1, 3, [defaultValue]);
        if (loadersContainer) {
          loadersContainer.appendChild(paramEl);
        }

        paramMappings.push({
          nodeId: nodeId,
          key: key,
          elementId: paramId,
          type: 'string'
        });

        // Load dynamic choices from ComfyUI object info
        populateLoaderChoices(classType, key, paramId, defaultValue);
      }
    });
  }

  // --- Pre-scan: Find QwenCanvasPlus nodes ---
  let hasQwenCanvas = false;
  qwenCanvasNodeId = null;
  for (const nodeId in workflow) {
    const node = workflow[nodeId];
    if (!node || !node.inputs) continue;
    if (node.class_type === 'QwenCanvasPlus') {
      hasQwenCanvas = true;
      if (!qwenCanvasNodeId) {
        qwenCanvasNodeId = nodeId;
      }

      // We want to render its inputs: aspect_ratio, vae_encode, scaling_strategy, batch_size
      const inputsToRender = [
        { key: 'aspect_ratio', label: 'Aspect Ratio', type: 'select' },
        { key: 'vae_encode', label: 'VAE Encode', type: 'select' },
        { key: 'scaling_strategy', label: 'Scaling Strategy', type: 'select' },
        { key: 'batch_size', label: 'Batch Size', type: 'number', step: 1 }
      ];

      inputsToRender.forEach(inp => {
        const val = node.inputs[inp.key];
        if (val !== undefined) {
          paramCount++;
          const paramId = `param-${nodeId}-${inp.key}`;

          let paramEl;
          if (inp.type === 'select') {
            paramEl = createParamElement(paramId, inp.label, nodeId, inp.key, 'select', val, 1, 3, [val]);
            populateLoaderChoices('QwenCanvasPlus', inp.key, paramId, val);
          } else {
            paramEl = createParamElement(paramId, inp.label, nodeId, inp.key, 'number', val, inp.step || 1);
          }

          if (qwenCanvasContainer) {
            qwenCanvasContainer.appendChild(paramEl);
          }

          paramMappings.push({
            nodeId: nodeId,
            key: inp.key,
            elementId: paramId,
            type: inp.type === 'number' ? 'number' : 'string'
          });
        }
      });
    }
  }

  if (hasQwenCanvas && qwenCanvasPanel) {
    qwenCanvasPanel.classList.remove('hidden');
  }

  const sidebarQwenCard = document.getElementById('sidebar-qwen-canvas-card');
  const sidebarQwenSelect = document.getElementById('sidebar-qwen-aspect-ratio');
  if (sidebarQwenCard) {
    if (hasQwenCanvas && qwenCanvasNodeId && sidebarQwenSelect) {
      sidebarQwenCard.style.display = 'block';
      const mainSelectId = `param-${qwenCanvasNodeId}-aspect_ratio`;

      const autoCheckbox = document.getElementById('qwen-auto-aspect-ratio');
      const isAuto = autoCheckbox ? autoCheckbox.checked : (localStorage.getItem('qwen_auto_aspect_ratio') === 'true');

      const syncMainToSidebar = () => {
        const mainSelect = document.getElementById(mainSelectId);
        if (!mainSelect) return;
        
        sidebarQwenSelect.innerHTML = '';
        Array.from(mainSelect.options).forEach(opt => {
          const newOpt = document.createElement('option');
          newOpt.value = opt.value;
          newOpt.textContent = opt.textContent;
          newOpt.selected = opt.selected;
          sidebarQwenSelect.appendChild(newOpt);
        });
        sidebarQwenSelect.value = mainSelect.value;
        
        // Disable dropdowns if auto-detect is active
        sidebarQwenSelect.disabled = isAuto;
        mainSelect.disabled = isAuto;
      };

      // Initial sync (in case main is already created and populated)
      const mainSelect = document.getElementById(mainSelectId);
      if (mainSelect) {
        syncMainToSidebar();
        
        // Listen for changes on main select (especially when populated via populateLoaderChoices)
        mainSelect.addEventListener('change', () => {
          if (sidebarQwenSelect.value !== mainSelect.value || sidebarQwenSelect.options.length !== mainSelect.options.length) {
            syncMainToSidebar();
          }
        });
      }

      // Sync sidebar select to main select
      sidebarQwenSelect.onchange = () => {
        const targetMainSelect = document.getElementById(mainSelectId);
        if (targetMainSelect && targetMainSelect.value !== sidebarQwenSelect.value) {
          targetMainSelect.value = sidebarQwenSelect.value;
          targetMainSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
      };

      if (isAuto) {
        setTimeout(updateQwenAspectFromSlot, 100);
      }
    } else {
      sidebarQwenCard.style.display = 'none';
      if (sidebarQwenSelect) {
        sidebarQwenSelect.innerHTML = '';
        sidebarQwenSelect.onchange = null;
        sidebarQwenSelect.disabled = false;
      }
    }
  }

  // --- Pre-scan: Identify positive/negative prompt nodes from sampler inputs ---
  const knownPositiveNodes = new Set();
  const knownNegativeNodes = new Set();

  const traceConditioning = (startNodeId, visited = new Set()) => {
    if (!startNodeId || visited.has(startNodeId)) return [];
    visited.add(startNodeId);
    const node = workflow[startNodeId];
    if (!node) return [];
    const classType = node.class_type || '';
    if (classType === 'CLIPTextEncode' || classType === 'TextEncodeQwenImageEditPlus') {
      return [startNodeId];
    }
    let found = [];
    if (node.inputs) {
      for (const key in node.inputs) {
        const val = node.inputs[key];
        if (Array.isArray(val) && val.length === 2 && typeof val[0] === 'string') {
          const kLower = key.toLowerCase();
          if (kLower.includes('conditioning') || 
              kLower.includes('positive') || 
              kLower.includes('negative') ||
              kLower.includes('prompt')) {
            found = found.concat(traceConditioning(String(val[0]), visited));
          }
        }
      }
    }
    return found;
  };

  for (const nodeId in workflow) {
    const node = workflow[nodeId];
    if (!node || !node.inputs) continue;
    const classType = node.class_type || '';
    const isSampler = classType.includes('Sampler') || classType === 'KSampler' || classType === 'KSamplerAdvanced';
    if (isSampler) {
      if (node.inputs.positive && Array.isArray(node.inputs.positive) && node.inputs.positive.length === 2) {
        const posNodes = traceConditioning(String(node.inputs.positive[0]));
        posNodes.forEach(id => knownPositiveNodes.add(id));
      }
      if (node.inputs.negative && Array.isArray(node.inputs.negative) && node.inputs.negative.length === 2) {
        const negNodes = traceConditioning(String(node.inputs.negative[0]));
        negNodes.forEach(id => knownNegativeNodes.add(id));
      }
    }
  }

  // --- Pre-scan: build maps of LoadImage nodes and their associated ImageRotate and ImageFlip nodes ---
  const loadImageNodes = {}; // nodeId -> node
  const rotateNodeForLoad = {}; // loadImageNodeId -> rotateNodeId
  const flipNodeForLoad = {};   // loadImageNodeId -> flipNodeId

  for (const nodeId in workflow) {
    const node = workflow[nodeId];
    if (!node || !node.inputs) continue;
    if (node.class_type === 'LoadImage') {
      loadImageNodes[nodeId] = node;
    }
  }

  // Trace to find associated ImageRotate and ImageFlip nodes for each LoadImage (direct and chained)
  for (const loadId in loadImageNodes) {
    // 1. Direct connections from LoadImage
    for (const nodeId in workflow) {
      const node = workflow[nodeId];
      if (!node || !node.inputs) continue;
      const imgInput = node.inputs.image;
      if (Array.isArray(imgInput) && String(imgInput[0]) === loadId) {
        if (node.class_type === 'ImageRotate') {
          rotateNodeForLoad[loadId] = nodeId;
        } else if (node.class_type === 'ImageFlip') {
          flipNodeForLoad[loadId] = nodeId;
        }
      }
    }

    // 2. Indirect connections (chained)
    // If we found a rotate node, look for a flip node connected to it
    const rotateId = rotateNodeForLoad[loadId];
    if (rotateId) {
      for (const nodeId in workflow) {
        const node = workflow[nodeId];
        if (!node || !node.inputs) continue;
        const imgInput = node.inputs.image;
        if (Array.isArray(imgInput) && String(imgInput[0]) === rotateId && node.class_type === 'ImageFlip') {
          flipNodeForLoad[loadId] = nodeId;
        }
      }
    }

    // If we found a flip node, look for a rotate node connected to it
    const flipId = flipNodeForLoad[loadId];
    if (flipId) {
      for (const nodeId in workflow) {
        const node = workflow[nodeId];
        if (!node || !node.inputs) continue;
        const imgInput = node.inputs.image;
        if (Array.isArray(imgInput) && String(imgInput[0]) === flipId && node.class_type === 'ImageRotate') {
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
        let isNegative = false;
        if (knownNegativeNodes.has(nodeId)) {
          isNegative = true;
        } else if (knownPositiveNodes.has(nodeId)) {
          isNegative = false;
        } else {
          isNegative = val.toLowerCase().includes('bad') || 
                       val.toLowerCase().includes('ugly') || 
                       val.toLowerCase().includes('nsfw') || 
                       nodeTitle.toLowerCase().includes('negative');
        }
        
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

        // Identify Positive vs Negative based on tracing or node title / value content
        let isNegative = false;
        if (knownNegativeNodes.has(nodeId)) {
          isNegative = true;
        } else if (knownPositiveNodes.has(nodeId)) {
          isNegative = false;
        } else {
          const lowerTitle = nodeTitle.toLowerCase();
          if (lowerTitle.includes('negative') || lowerTitle.includes('neg')) {
            isNegative = true;
          } else if (lowerTitle.includes('positive') || lowerTitle.includes('postive') || lowerTitle.includes('pos')) {
            isNegative = false;
          } else {
            isNegative = val.trim() === '';
          }
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
      const flipId = loadId ? (flipNodeForLoad[loadId] || null) : null;
      const defaultImage = loadId ? (loadImageNodes[loadId].inputs.image || '') : '';
      const rawRotation = rotateId ? (workflow[rotateId].inputs.rotation || 'none') : 'none';
      const defaultRotation = mapComfyRotationToUi(rawRotation);

      // Restore persisted flip state from localStorage or default to workflow setting
      const savedFlip = localStorage.getItem(`img_slot_${slotIndex}_flip`);
      let defaultFlip = 'none';
      if (savedFlip !== null) {
        defaultFlip = savedFlip;
      } else if (flipId && workflow[flipId]) {
        const rawFlip = workflow[flipId].inputs.flip_method || 'none';
        if (rawFlip.includes('horizontally')) {
          defaultFlip = 'horizontal';
        } else if (rawFlip.includes('vertically')) {
          defaultFlip = 'vertical';
        }
      }

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
        flipNodeId: flipId,
        enabled: restoredEnabled,
        rotation: defaultRotation,
        flip: defaultFlip,
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

function createParamElement(id, label, nodeId, key, inputType, defaultValue, step = 1, rows = 3, choices = []) {
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
  } else if (inputType === 'select') {
    input = document.createElement('select');
    choices.forEach(choice => {
      const option = document.createElement('option');
      option.value = choice;
      option.textContent = choice;
      if (choice === defaultValue) {
        option.selected = true;
      }
      input.appendChild(option);
    });
    if (defaultValue && !choices.includes(defaultValue)) {
      const option = document.createElement('option');
      option.value = defaultValue;
      option.textContent = defaultValue;
      option.selected = true;
      input.appendChild(option);
    }
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

async function populateLoaderChoices(classType, key, selectElementId, defaultValue) {
  try {
    const response = await comfyFetch(`/object_info/${classType}`);
    const data = await response.json();
    if (data && data[classType] && data[classType].input) {
      let inputInfo = null;
      if (data[classType].input.required && data[classType].input.required[key]) {
        inputInfo = data[classType].input.required[key];
      } else if (data[classType].input.optional && data[classType].input.optional[key]) {
        inputInfo = data[classType].input.optional[key];
      }
      if (inputInfo && Array.isArray(inputInfo) && Array.isArray(inputInfo[0])) {
        const choices = inputInfo[0];
        const selectEl = document.getElementById(selectElementId);
        if (selectEl) {
          const currentValue = selectEl.value || defaultValue;
          selectEl.innerHTML = '';
          choices.forEach(choice => {
            const option = document.createElement('option');
            option.value = choice;
            option.textContent = choice;
            if (choice === currentValue) {
              option.selected = true;
            }
            selectEl.appendChild(option);
          });
          if (currentValue && !choices.includes(currentValue)) {
            const option = document.createElement('option');
            option.value = currentValue;
            option.textContent = currentValue;
            option.selected = true;
            selectEl.appendChild(option);
          }
          selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    }
  } catch (err) {
    console.warn(`Failed to fetch choices for ${classType}.${key}:`, err);
  }
}

function refreshLoaderChoices() {
  if (!currentWorkflow) return;
  const selectElements = document.querySelectorAll('#loaders-panel select, #qwen-canvas-panel select');
  selectElements.forEach(selectEl => {
    const match = selectEl.id.match(/^param-(\d+)-(.+)$/);
    if (match) {
      const nodeId = match[1];
      const key = match[2];
      const node = currentWorkflow[nodeId];
      if (node) {
        const classType = node.class_type;
        const defaultValue = selectEl.value;
        populateLoaderChoices(classType, key, selectEl.id, defaultValue);
      }
    }
  });
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
  const { slotIndex, nodeId, rotateNodeId, flipNodeId, enabled, rotation, flip, imageFilename } = slotState;
  const isActive = nodeId !== null;
  const slotNum = slotIndex + 1;

  const item = document.createElement('div');
  item.className = `param-item image-slot${!isActive || !enabled ? ' disabled-slot' : ''}`;
  item.dataset.slotIndex = slotIndex;

  // Header: checkbox + label + rotate/flip controls
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

  // Actions container (right side of the header)
  const headerRight = document.createElement('div');
  headerRight.className = 'param-header-right';
  headerRight.style.display = 'flex';
  headerRight.style.gap = '6px';
  headerRight.style.alignItems = 'center';

  // Flip select dropdown
  const flipSelect = document.createElement('select');
  flipSelect.className = 'select-flip';
  flipSelect.title = 'Select flip method';
  flipSelect.disabled = !isActive || !flipNodeId;

  const FLIP_OPTIONS = [
    { value: 'none', label: 'None' },
    { value: 'horizontal', label: '⇄ y-axis: horizontally' },
    { value: 'vertical', label: '⇅ x-axis: vertically' }
  ];

  FLIP_OPTIONS.forEach(opt => {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    if (opt.value === flip) {
      option.selected = true;
    }
    flipSelect.appendChild(option);
  });

  // Rotate button (only when there is an ImageRotate node)
  const rotateBtn = document.createElement('button');
  rotateBtn.className = 'btn btn-secondary btn-small btn-rotate';
  rotateBtn.title = 'Cycle rotation: 0° → 90° → 180° → 270°';
  rotateBtn.disabled = !isActive || !rotateNodeId;

  const ROTATION_LABELS = { none: '0°', '90': '90°', '180': '180°', '270': '270°' };
  const ROTATION_CYCLE = ['none', '90', '180', '270'];
  rotateBtn.textContent = `↻ ${ROTATION_LABELS[rotation] || '0°'}`;

  headerRight.appendChild(flipSelect);
  headerRight.appendChild(rotateBtn);

  header.appendChild(headerLeft);
  header.appendChild(headerRight);
  item.appendChild(header);

  // Image picker body (same style as existing createImagePickerElement)
  const pickerControl = document.createElement('div');
  pickerControl.className = 'image-picker-control';

  const preview = document.createElement('div');
  preview.className = 'image-picker-preview';
  preview.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;

  // Apply current rotation and flip to preview img (will apply after img loads too)
  const CSS_ROTATION = { none: 0, '90': 90, '180': 180, '270': 270 };
  const CSS_FLIP = { none: '', horizontal: 'scaleX(-1)', vertical: 'scaleY(-1)' };

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
    nodeTag.textContent = `LoadImage: ${nodeId}${rotateNodeId ? ` · ImageRotate: ${rotateNodeId}` : ''}${flipNodeId ? ` · ImageFlip: ${flipNodeId}` : ''}`;
    item.appendChild(nodeTag);
  }

  // --- Helper: apply visual rotation and flip to preview image ---
  function applyRotationToPreviewImg() {
    const img = preview.querySelector('img');
    if (img) {
      const rot = `rotate(${CSS_ROTATION[slotState.rotation] || 0}deg)`;
      const flipVal = CSS_FLIP[slotState.flip] || '';
      img.style.transform = `${rot} ${flipVal}`.trim();
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
      flipSelect.disabled = !flipNodeId;
    } else {
      item.classList.add('disabled-slot');
      selectBtn.disabled = true;
      rotateBtn.disabled = true;
      flipSelect.disabled = true;
    }
    saveWorkflowToLocalStorage();
    if (window.updateAutosavePreview) window.updateAutosavePreview();
    updateCompareButtonState();
  });

  // --- Flip dropdown change handler ---
  flipSelect.addEventListener('change', () => {
    slotState.flip = flipSelect.value;
    localStorage.setItem(`img_slot_${slotState.slotIndex}_flip`, slotState.flip);
    applyRotationToPreviewImg();
    saveWorkflowToLocalStorage();
    if (typeof updateQwenAspectFromSlot === 'function') {
      updateQwenAspectFromSlot();
    }
  });

  // --- Rotate button handler ---
  rotateBtn.addEventListener('click', () => {
    const curIdx = ROTATION_CYCLE.indexOf(slotState.rotation);
    const nextIdx = (curIdx + 1) % ROTATION_CYCLE.length;
    slotState.rotation = ROTATION_CYCLE[nextIdx];
    rotateBtn.textContent = `↻ ${ROTATION_LABELS[slotState.rotation]}`;
    applyRotationToPreviewImg();
    saveWorkflowToLocalStorage();
    if (typeof updateQwenAspectFromSlot === 'function') {
      updateQwenAspectFromSlot();
    }
  });

  // --- Select image button handler ---
  selectBtn.addEventListener('click', async () => {
    try {
      // 1. Get path for this specific slot, or fall back to global last folder
      const slotPath = localStorage.getItem(`last_image_path_slot_${slotIndex}`) || '';
      let defaultPath = '';
      if (slotPath) {
        const lastIndex = Math.max(slotPath.lastIndexOf('/'), slotPath.lastIndexOf('\\'));
        if (lastIndex !== -1) {
          defaultPath = slotPath.substring(0, lastIndex);
        }
      }
      if (!defaultPath) {
        defaultPath = localStorage.getItem('last_image_folder') || '';
      }

      const fileData = await window.api.selectImageFile(defaultPath);
      if (!fileData) return;

      // 2. Save paths to localStorage
      localStorage.setItem(`last_image_path_slot_${slotIndex}`, fileData.filePath);
      const lastIndex = Math.max(fileData.filePath.lastIndexOf('/'), fileData.filePath.lastIndexOf('\\'));
      if (lastIndex !== -1) {
        const folder = fileData.filePath.substring(0, lastIndex);
        localStorage.setItem('last_image_folder', folder);
      }

      filenameSpan.textContent = fileData.fileName;
      filenameSpan.classList.add('selected');
      statusSpan.textContent = 'Uploading...';
      statusSpan.className = 'image-picker-status uploading';
      selectBtn.disabled = true;

      const localUrl = `file:///${fileData.filePath.replace(/\\/g, '/')}`;
      preview.innerHTML = `<img src="${localUrl}" alt="Preview">`;
      applyRotationToPreviewImg();

      // Trigger aspect ratio update as soon as local preview image loads
      const localImg = preview.querySelector('img');
      if (localImg) {
        localImg.addEventListener('load', () => {
          if (typeof updateQwenAspectFromSlot === 'function') {
            updateQwenAspectFromSlot();
          }
        });
      }

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
        if (typeof updateQwenAspectFromSlot === 'function') {
          updateQwenAspectFromSlot();
        }
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
        preview.innerHTML = `<img src="${result.dataUrl}" alt="Preview">`;
        applyRotationToPreviewImg();
        const serverImg = preview.querySelector('img');
        if (serverImg) {
          serverImg.addEventListener('load', () => {
            if (typeof updateQwenAspectFromSlot === 'function') {
              updateQwenAspectFromSlot();
            }
          });
        }
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
      // 1. Get path for this specific picker ID, or fall back to global last folder
      const pickerPath = localStorage.getItem(`last_image_path_picker_${id}`) || '';
      let defaultPath = '';
      if (pickerPath) {
        const lastIndex = Math.max(pickerPath.lastIndexOf('/'), pickerPath.lastIndexOf('\\'));
        if (lastIndex !== -1) {
          defaultPath = pickerPath.substring(0, lastIndex);
        }
      }
      if (!defaultPath) {
        defaultPath = localStorage.getItem('last_image_folder') || '';
      }

      const fileData = await window.api.selectImageFile(defaultPath);
      if (!fileData) return;

      // 2. Save paths to localStorage
      localStorage.setItem(`last_image_path_picker_${id}`, fileData.filePath);
      const lastIndex = Math.max(fileData.filePath.lastIndexOf('/'), fileData.filePath.lastIndexOf('\\'));
      if (lastIndex !== -1) {
        const folder = fileData.filePath.substring(0, lastIndex);
        localStorage.setItem('last_image_folder', folder);
      }
      
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
    const CSS_FLIP = { none: '', horizontal: 'scaleX(-1)', vertical: 'scaleY(-1)' };
    const currentCssFlip = CSS_FLIP[slotState.flip] || '';
    const previewUrl = `${comfyuiUrl}/view?filename=${encodeURIComponent(slotState.imageFilename)}&type=input`;
    window.api.comfyFetchImage({ url: previewUrl }).then(result => {
      if (result.ok) {
        preview.innerHTML = `<img src="${result.dataUrl}" alt="Preview" style="transform: rotate(${currentCssRotation}deg) ${currentCssFlip}">`;
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

// Helper: Count sampler nodes in the workflow JSON
function countSamplerNodes(workflow) {
  let count = 0;
  if (!workflow) return count;
  for (const nodeId in workflow) {
    const node = workflow[nodeId];
    if (node) {
      const classType = node.class_type || '';
      if (classType.includes('Sampler') || classType === 'KSampler' || classType === 'KSamplerAdvanced') {
        count++;
      }
    }
  }
  return count;
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
      checkQueueStatus();
      break;
    }

    case 'execution_start': {
      const incomingId = data.data.prompt_id;
      // Bind if it's a prompt submitted by this client (via myQueuedPromptIds), 
      // or if it matches activePromptId, or is the immediately pending prompt.
      if (myQueuedPromptIds.has(incomingId) ||
          incomingId === activePromptId ||
          (activePromptId === null && pendingPromptId === true)) {
        // Bind the real prompt_id as early as possible so subsequent events match
        activePromptId = incomingId;
        const runningJob = jobHistoryList.find(j => j.promptId === incomingId);
        if (runningJob) {
          runningJob.status = 'running';
          refreshJobsListIfVisible();
        }
        myQueuedPromptIds.delete(incomingId);
        pendingPromptId = false;
        window.api.logDebug({ message: `execution_start: bound activePromptId=${activePromptId}` });
        
        // Reset all progress tracking variables for a fresh run
        currentExecutionSteps = 0;
        lastSamplerNodeId = null;
        lastSamplerStep = 0;
        totalWorkflowSteps = 0;
        samplerNodeMaxMap = {};
        estimatedSamplerCount = promptSamplerCountsMap[incomingId] || countSamplerNodes(currentWorkflow);
        
        // Reset save state for new generation
        savedForPromptId = null;
        promptSavedPath = null;

        updateProgress(0, 0, 'Executing workflow...');
        startJobTimer();
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

        const finishedPromptId = activePromptId;
        const completedJob = jobHistoryList.find(j => j.promptId === finishedPromptId);
        if (completedJob) {
          completedJob.status = 'completed';
          refreshJobsListIfVisible();
        }
        activePromptId = null;
        // Do NOT reset promptSavedPath and savedForPromptId here so that the "Open in Viewer" button continues to open the saved file path of the completed run

        // Mark execution as complete for this prompt and check if we can clear job history
        if (finishedPromptId) {
          completedPromptIds.add(finishedPromptId);
          checkAndClearComfyHistory(finishedPromptId);
          delete promptSamplerCountsMap[finishedPromptId];
        }
        
        // Reset all progress tracking variables
        currentExecutionSteps = 0;
        lastSamplerNodeId = null;
        lastSamplerStep = 0;
        totalWorkflowSteps = 0;
        samplerNodeMaxMap = {};

        updateProgress(0, 0, 'Ready');
        stopJobTimer();
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

      const finishedPromptId = incomingId || activePromptId;
      if (finishedPromptId) {
        const interruptedJob = jobHistoryList.find(j => j.promptId === finishedPromptId);
        if (interruptedJob) {
          interruptedJob.status = 'interrupted';
          refreshJobsListIfVisible();
        }
        delete promptSamplerCountsMap[finishedPromptId];
        promptJobStates.delete(finishedPromptId);
      }
      activePromptId = null;
      pendingPromptId = false;
      savedForPromptId = null; promptSavedPath = null;
      
      currentExecutionSteps = 0;
      lastSamplerNodeId = null;
      lastSamplerStep = 0;
      totalWorkflowSteps = 0;
      samplerNodeMaxMap = {};

      updateProgress(0, 0, 'Interrupted');
      stopJobTimer();
      checkQueueStatus();
      break;
    }

    case 'execution_error': {
      if (data.data.prompt_id !== activePromptId) break;
      window.api.logDebug({ message: `Execution error for prompt_id=${activePromptId}: ${data.data.exception_message}` });

      document.getElementById('current-node').textContent = 'Execution Error';
      document.getElementById('display-loading').classList.add('hidden');

      showToast('Execution Error', data.data.exception_message || 'An error occurred during ComfyUI execution', 'error');

      if (activePromptId) {
        const errorJob = jobHistoryList.find(j => j.promptId === activePromptId);
        if (errorJob) {
          errorJob.status = 'failed';
          refreshJobsListIfVisible();
        }
        delete promptSamplerCountsMap[activePromptId];
        promptJobStates.delete(activePromptId);
      }
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
      stopJobTimer();
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

// ─── Job Timer Helpers ─────────────────────────────────────────────────────────────
function startJobTimer() {
  stopJobTimer(); // Clear any existing timer first
  jobStartTime = Date.now();
  const jobTimeEl = document.getElementById('job-time');
  if (jobTimeEl) {
    jobTimeEl.textContent = '0s';
  }
  
  jobTimerInterval = setInterval(() => {
    if (!jobStartTime) return;
    const elapsedMs = Date.now() - jobStartTime;
    if (jobTimeEl) {
      jobTimeEl.textContent = formatJobTime(elapsedMs);
    }
  }, 500);
}

function stopJobTimer() {
  if (jobTimerInterval) {
    clearInterval(jobTimerInterval);
    jobTimerInterval = null;
  }
}

function formatJobTime(elapsedMs) {
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  } else {
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = elapsedSeconds % 60;
    return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
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
  
  if (typeof updateComfyWorkingStatus === 'function') {
    updateComfyWorkingStatus(activePromptId !== null);
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
  'UnetLoaderGGUF':                { 0: 'unet_name' },
  'CLIPLoader':                    { 0: 'clip_name' },
  'CLIPLoaderGGUF':                { 0: 'clip_name' },
  'VAELoader':                     { 0: 'vae_name' }
};

// Clone the web-UI format workflow and update widget_values from current UI / lastSubmittedWorkflow
function injectParamsIntoWebUiWorkflow(wuJson, promptId) {
  const clone = JSON.parse(JSON.stringify(wuJson));
  const state = promptId ? promptJobStates.get(promptId) : null;
  const wf = state ? state.workflow : (lastSubmittedWorkflow || currentWorkflow);
  if (!Array.isArray(clone.nodes)) return clone;

  // Build nodeId → current param values from UI (highest priority) and API workflow
  const uiValues = {}; // { nodeId: { key: value } }
  paramMappings.forEach(mapping => {
    let val;
    if (state && state.paramValues && state.paramValues[mapping.elementId] !== undefined) {
      val = state.paramValues[mapping.elementId];
      if (mapping.type === 'number') {
        val = Number(val);
      }
    } else {
      const el = document.getElementById(mapping.elementId);
      if (!el) return;
      val = mapping.type === 'number' ? Number(el.value) : el.value;
    }
    if (!uiValues[mapping.nodeId]) uiValues[mapping.nodeId] = {};
    uiValues[mapping.nodeId][mapping.key] = val;
  });
  // Use imageSlots state directly (more reliable than DOM hidden inputs)
  const slotsToUse = state && state.imageSlots ? state.imageSlots : imageSlots;
  slotsToUse.forEach(slot => {
    if (slot.nodeId && slot.imageFilename) {
      if (!uiValues[slot.nodeId]) uiValues[slot.nodeId] = {};
      uiValues[slot.nodeId]['image'] = slot.imageFilename;
    }
    if (slot.rotateNodeId && slot.rotation) {
      if (!uiValues[slot.rotateNodeId]) uiValues[slot.rotateNodeId] = {};
      uiValues[slot.rotateNodeId]['rotation'] = mapUiRotationToComfy(slot.rotation);
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
      if (fileData) {
        applyWebUiWorkflow(fileData.content, fileData.fileName);
        if (fileData.sister) {
          const keys = Object.keys(fileData.sister.content);
          const numericKeys = keys.filter(k => !isNaN(parseInt(k)));
          if (numericKeys.length > 0) {
            loadWorkflow(fileData.sister.content, fileData.sister.fileName, true);
            showToast('Auto-linked API Workflow', `System automatically found and loaded the related API version: ${fileData.sister.fileName}`, 'success');
          }
        }
      }
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

// ─── Workflow Combiner Dialog ────────────────────────────────────────────────
function initCombineWorkflowsDialog() {
  const btnDialog = document.getElementById('btn-combine-dialog');
  const modal = document.getElementById('combine-modal');
  const btnCancel = document.getElementById('btn-combine-cancel');
  const btnOk = document.getElementById('btn-combine-ok');
  
  const inputWebui = document.getElementById('combine-webui-path');
  const btnWebui = document.getElementById('btn-browse-combine-webui');
  
  const inputApi = document.getElementById('combine-api-path');
  const btnApi = document.getElementById('btn-browse-combine-api');
  
  const inputOutput = document.getElementById('combine-output-path');
  const btnOutput = document.getElementById('btn-browse-combine-output');

  if (!btnDialog || !modal) return;

  // Open Combine dialog modal
  btnDialog.addEventListener('click', () => {
    inputWebui.value = '';
    inputWebui.classList.remove('loaded');
    inputApi.value = '';
    inputApi.classList.remove('loaded');
    inputOutput.value = '';
    inputOutput.classList.remove('loaded');
    modal.classList.remove('hidden');
  });

  // Close modal on Cancel
  btnCancel.addEventListener('click', () => {
    modal.classList.add('hidden');
  });

  // Select WebUI file
  btnWebui.addEventListener('click', async () => {
    try {
      const fileData = await window.api.selectWorkflowFile();
      if (fileData) {
        inputWebui.value = fileData.filePath;
        inputWebui.classList.add('loaded');
        
        // Auto-suggest sister API file if available
        if (fileData.sister && !inputApi.value) {
          inputApi.value = fileData.sister.filePath;
          inputApi.classList.add('loaded');
        }
        
        // Auto-suggest output path
        updateDefaultOutputPath();
      }
    } catch (err) {
      showToast('Error', err.message, 'error');
    }
  });

  // Select API file
  btnApi.addEventListener('click', async () => {
    try {
      const fileData = await window.api.selectWorkflowFile();
      if (fileData) {
        inputApi.value = fileData.filePath;
        inputApi.classList.add('loaded');
        
        // Auto-suggest sister WebUI file if available
        if (fileData.sister && !inputWebui.value) {
          inputWebui.value = fileData.sister.filePath;
          inputWebui.classList.add('loaded');
        }
        
        // Auto-suggest output path
        updateDefaultOutputPath();
      }
    } catch (err) {
      showToast('Error', err.message, 'error');
    }
  });

  // Helper to suggest an output path in the same directory as selected inputs
  function updateDefaultOutputPath() {
    if (inputOutput.value) return; // User already chose one
    
    const sourcePath = inputWebui.value || inputApi.value;
    if (!sourcePath) return;

    // Use source directory and replace suffixes (like _webui or _api) with _combined
    const ext = sourcePath.substring(sourcePath.lastIndexOf('.'));
    const base = sourcePath.substring(0, sourcePath.lastIndexOf('.'));
    
    let suggestedBase = base;
    if (suggestedBase.toLowerCase().endsWith('_webui') || suggestedBase.toLowerCase().endsWith('-webui')) {
      suggestedBase = suggestedBase.substring(0, suggestedBase.length - 6);
    } else if (suggestedBase.toLowerCase().endsWith('_api') || suggestedBase.toLowerCase().endsWith('-api')) {
      suggestedBase = suggestedBase.substring(0, suggestedBase.length - 4);
    }
    
    inputOutput.value = suggestedBase + '_combined' + ext;
    inputOutput.classList.add('loaded');
  }

  // Select Output destination path
  btnOutput.addEventListener('click', async () => {
    try {
      const defaultPath = inputOutput.value || '';
      const destPath = await window.api.selectSaveWorkflowFile(defaultPath);
      if (destPath) {
        inputOutput.value = destPath;
        inputOutput.classList.add('loaded');
      }
    } catch (err) {
      showToast('Error', err.message, 'error');
    }
  });

  // Combine operation
  btnOk.addEventListener('click', async () => {
    const webuiPath = inputWebui.value.trim();
    const apiPath = inputApi.value.trim();
    const outputPath = inputOutput.value.trim();

    if (!webuiPath) {
      showToast('Missing WebUI file', 'Please select a WebUI format workflow JSON file.', 'error');
      return;
    }
    if (!apiPath) {
      showToast('Missing API file', 'Please select an API format workflow JSON file.', 'error');
      return;
    }
    if (!outputPath) {
      showToast('Missing output file', 'Please select a destination to save the combined file.', 'error');
      return;
    }

    btnOk.disabled = true;
    try {
      const result = await window.api.combineWorkflows({ webuiPath, apiPath, outputPath });
      if (result.ok) {
        modal.classList.add('hidden');
        showToast('Success', `Combined workflow saved to: ${result.fileName}`, 'success');
        
        // Auto-load the newly combined file into the application
        if (result.content) {
          const content = result.content;
          const fileName = result.fileName;
          if (content.webui) {
            applyWebUiWorkflow(content.webui, fileName + ' (Web UI)');
          }
          if (content.api) {
            loadWorkflow(content.api, fileName, true);
          }
        }
      } else {
        showToast('Combine Error', result.error, 'error');
      }
    } catch (err) {
      showToast('Exception', err.message, 'error');
    } finally {
      btnOk.disabled = false;
    }
  });
}


// ─── Metadata Collection Helper ────────────────────────────────────────────────────
// Collects current workflow parameter values and formats them for PNG metadata embedding.
// Returns { parameters: string, workflow: string }
function collectImageMetadata(promptId) {
  const state = promptId ? promptJobStates.get(promptId) : null;
  const wf = state ? state.workflow : (lastSubmittedWorkflow || currentWorkflow);
  const positivePrompts = [];
  const negativePrompts = [];
  const otherLines = [];

  paramMappings.forEach(mapping => {
    let rawVal = '';
    if (state && state.paramValues && state.paramValues[mapping.elementId] !== undefined) {
      rawVal = state.paramValues[mapping.elementId];
    } else {
      const el = document.getElementById(mapping.elementId);
      if (el) {
        rawVal = el.value ? el.value.trim() : '';
      }
    }

    if (mapping.isImageSlot) return;
    if (!rawVal) return;

    // Determine field role from label text
    const el = document.getElementById(mapping.elementId);
    const labelEl = el?.closest('.param-item')?.querySelector('.param-name');
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
      ? { workflow: JSON.stringify(injectParamsIntoWebUiWorkflow(webUiWorkflow, promptId)) }
      : {})
  };
}

// 5. Image Display & History Gallery
// promptId is passed so we can guard against saving the same prompt's image twice
// (multiple SaveImage nodes in one workflow each fire 'executed' independently).
async function displayGeneratedImage(filename, subfolder, type, promptId) {
  if (promptId) {
    const job = jobHistoryList.find(j => j.promptId === promptId);
    if (job) {
      job.filename = filename;
      refreshJobsListIfVisible();
    }
  }
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

    const state = promptId ? promptJobStates.get(promptId) : null;
    const autosaveSnap = state ? state.autosaveSettings : null;

    const prefixInput = document.getElementById('autosave-prefix');
    const insertOriginalCheckbox = document.getElementById('autosave-insert-original');
    const paddingInput = document.getElementById('autosave-padding');
    const startingNoInput = document.getElementById('autosave-starting-no');
    const sourceSelect = document.getElementById('autosave-original-source');
    const delimInput = document.getElementById('autosave-delimiter');

    const prefix = autosaveSnap ? autosaveSnap.prefix : (prefixInput ? prefixInput.value.trim() : 'autosave');
    const insertOriginal = autosaveSnap ? autosaveSnap.insertOriginal : (insertOriginalCheckbox ? insertOriginalCheckbox.checked : true);
    const padding = autosaveSnap ? autosaveSnap.padding : (paddingInput ? parseInt(paddingInput.value, 10) : 4);
    let startingNo = autosaveSnap ? autosaveSnap.startingNo : (startingNoInput ? parseInt(startingNoInput.value, 10) : 1);
    if (isNaN(startingNo) || startingNo < 0) startingNo = 1;
    let source = autosaveSnap ? autosaveSnap.source : (sourceSelect ? sourceSelect.value : 'slot1');
    if (source === 'default') source = 'slot1';
    const delimiter = autosaveSnap ? autosaveSnap.delimiter : (delimInput ? delimInput.value : '_');

    // Collect metadata to embed into the saved PNG
    const pngMetadata = collectImageMetadata(promptId);

    const slotsToUse = state && state.imageSlots ? state.imageSlots : imageSlots;

    // Resolve source image URL for metadata extraction (slot reference image)
    let sourceImageUrl = null;
    if (insertOriginal) {
      const slotIdx = parseInt(source.replace('slot', ''), 10) - 1;
      const slot = slotsToUse.find(s => s.slotIndex === slotIdx);
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
      const slot = slotsToUse.find(s => s.slotIndex === slotIdx);
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
        if (promptId) {
          const job = jobHistoryList.find(j => j.promptId === promptId);
          if (job) {
            job.filename = result.savedPath.split(/[\\/]/).pop();
            refreshJobsListIfVisible();
          }
        }
        openBtn.onclick = () => window.api.openPath({ path: result.savedPath });
        console.log(`[AutoSave] Saved: ${result.savedPath}`);

        // Mark image as saved for this prompt and check if we can clear job history
        if (promptId) {
          savedPromptIds.add(promptId);
          await checkAndClearComfyHistory(promptId);
        }

        // Auto increment Starting No.
        const nextStartingNo = startingNo + 1;
        if (startingNoInput) {
          startingNoInput.value = nextStartingNo;
          startingNoInput.dispatchEvent(new Event('change'));
        } else {
          localStorage.setItem('autosave_starting_no', nextStartingNo);
        }

        // Auto-run Face Fusion if checked
        const autoSendFf = document.getElementById('auto-send-ff');
        if (autoSendFf && autoSendFf.checked) {
          triggerAutoFaceFusion(result.savedPath, promptId);
        }
      } else {
        console.error(`[AutoSave Failed] ${result.error}`);
      }
    } catch (err) {
      console.error(`[AutoSave Error] ${err.message}`);
    }
  } else {
    // If output folder is not configured but auto-send-ff is checked, warn the user
    const autoSendFf = document.getElementById('auto-send-ff');
    if (autoSendFf && autoSendFf.checked && !outputFolderPath) {
      showToast('Face Fusion Trigger Failed', 'Please configure an Output Folder in Output Setting to enable auto Face Fusion processing.', 'warning');
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
  const btnStop = document.getElementById('btn-stop');
  if (btnStop) {
    btnStop.disabled = true;
    btnStop.classList.add('btn-disabled');
    btnStop.innerHTML = `
      <div class="spinner" style="width: 14px; height: 14px; border-width: 2px;"></div>
      <span>Stopping...</span>
    `;
  }
  
  try {
    window.api.logDebug({ message: `Interrupt requested. activePromptId=${activePromptId}` });
    
    // 1. Send interrupt command to ComfyUI to stop active executions
    await comfyFetch(`/interrupt`, {
      method: 'POST'
    });
    
    // 2. Also try to delete it from the queue if it was pending
    if (activePromptId) {
      const interruptedJob = jobHistoryList.find(j => j.promptId === activePromptId);
      if (interruptedJob) {
        interruptedJob.status = 'interrupted';
        refreshJobsListIfVisible();
      }
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
    stopJobTimer();
    
    if (btnStop) {
      btnStop.innerHTML = `
        <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></svg>
        <span>Stop</span>
      `;
    }
    
    checkQueueStatus();
  } catch (err) {
    console.error('Failed to interrupt generation:', err);
    // Restore Stop button on failure
    if (btnStop) {
      btnStop.disabled = false;
      btnStop.classList.remove('btn-disabled');
      btnStop.innerHTML = `
        <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></svg>
        <span>Stop</span>
      `;
    }
  }
}

// 6. Queue Generation Prompt Submission
function initGeneration() {
  const btnRun = document.getElementById('btn-run');
  const btnStop = document.getElementById('btn-stop');

  if (btnRun) {
    btnRun.addEventListener('click', async () => {
      if (window.api && typeof window.api.logDebug === 'function') {
        window.api.logDebug({
          message: `btnRun clicked. wsState=${ws ? ws.readyState : 'null'}, hasWorkflow=${!!currentWorkflow}, activePrompt=${activePromptId}`
        });
      }

      try {
        if (!currentWorkflow || !ws || ws.readyState !== WebSocket.OPEN) {
          const warningMsg = `Cannot start generation: currentWorkflow is ${!!currentWorkflow ? 'loaded' : 'null'}, ws is ${ws ? 'instantiated' : 'null'}, readyState is ${ws ? ws.readyState : 'n/a'}`;
          console.warn(warningMsg);
          if (window.api && typeof window.api.logDebug === 'function') {
            window.api.logDebug({ message: warningMsg });
          }
          return;
        }

        // Validate that all enabled active image slots have an image filename selected
        let validationFailed = false;
        imageSlots.forEach(slotState => {
          if (slotState.nodeId && slotState.enabled) {
            const hiddenInput = document.getElementById(`img-slot-${slotState.slotIndex}-hidden`);
            const imageVal = hiddenInput ? hiddenInput.value : slotState.imageFilename;
            if (!imageVal || imageVal.trim() === '') {
              showToast('Missing Image', `Please select an image for Slot ${slotState.slotIndex + 1} or disable it.`, 'warning');
              validationFailed = true;
            }
          }
        });
        if (validationFailed) {
          return;
        }

        // Disable run button temporarily to avoid double clicks during POST
        btnRun.disabled = true;
        btnRun.classList.add('btn-disabled');

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

        // 1b. Apply image slot states: handle enabled/rotation/flip, or prune disabled pipelines
        imageSlots.forEach(slotState => {
          const { nodeId, rotateNodeId, flipNodeId, enabled, rotation, flip } = slotState;
          if (!nodeId) return; // Inactive slot — nothing to do

          if (enabled) {
            // Update image filename in LoadImage node
            const hiddenInput = document.getElementById(`img-slot-${slotState.slotIndex}-hidden`);
            if (hiddenInput && hiddenInput.value && workflowCopy[nodeId]) {
              workflowCopy[nodeId].inputs.image = hiddenInput.value;
            }

            // Route the pipeline depending on whether flip is active
            if (flipNodeId && workflowCopy[flipNodeId] && flip !== 'none') {
              // 1. Flip is active.
              // Set LoadImage -> ImageFlip
              workflowCopy[flipNodeId].inputs.image = [nodeId, 0];
              // Set flip_method
              if (flip === 'horizontal') {
                workflowCopy[flipNodeId].inputs.flip_method = "y-axis: horizontally";
              } else if (flip === 'vertical') {
                workflowCopy[flipNodeId].inputs.flip_method = "x-axis: vertically";
              }

              // Set ImageFlip -> ImageRotate (if rotate exists)
              if (rotateNodeId && workflowCopy[rotateNodeId]) {
                workflowCopy[rotateNodeId].inputs.image = [flipNodeId, 0];
                workflowCopy[rotateNodeId].inputs.rotation = mapUiRotationToComfy(rotation);
              }
            } else {
              // 2. Flip is NOT active (or no flip node).
              // Delete Flip node from workflow copy so it doesn't run
              if (flipNodeId) {
                delete workflowCopy[flipNodeId];
              }

              // Set LoadImage -> ImageRotate (if rotate exists)
              if (rotateNodeId && workflowCopy[rotateNodeId]) {
                workflowCopy[rotateNodeId].inputs.image = [nodeId, 0];
                workflowCopy[rotateNodeId].inputs.rotation = mapUiRotationToComfy(rotation);
              }
            }

            // 3. Ensure downstream nodes connect to the correct endpoint of the pipeline
            // The active pipeline endpoint is:
            // - If Rotate node exists: Rotate node
            // - Else if Flip node exists & is active: Flip node
            // - Else: LoadImage node
            let pipelineEndpointId = nodeId;
            if (rotateNodeId && workflowCopy[rotateNodeId]) {
              pipelineEndpointId = rotateNodeId;
            } else if (flipNodeId && workflowCopy[flipNodeId] && flip !== 'none') {
              pipelineEndpointId = flipNodeId;
            }

            // Now trace all nodes in the workflow copy and if their input references
            // nodeId, rotateNodeId, or flipNodeId, redirect it to pipelineEndpointId
            // EXCLUDING the internal connections of the pipeline itself.
            const pipelineNodeIds = new Set([nodeId]);
            if (rotateNodeId) pipelineNodeIds.add(rotateNodeId);
            if (flipNodeId) pipelineNodeIds.add(flipNodeId);

            for (const wNodeId in workflowCopy) {
              // Skip modifying the pipeline nodes themselves
              if (pipelineNodeIds.has(wNodeId)) continue;

              const wNode = workflowCopy[wNodeId];
              if (!wNode || !wNode.inputs) continue;
              for (const inputKey in wNode.inputs) {
                const val = wNode.inputs[inputKey];
                if (Array.isArray(val) && val.length === 2) {
                  const sourceNodeId = String(val[0]);
                  if (pipelineNodeIds.has(sourceNodeId)) {
                    // Redirect to the final endpoint of this pipeline
                    wNode.inputs[inputKey] = [pipelineEndpointId, val[1]];
                  }
                }
              }
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

        // Count sampler nodes in workflowCopy for progress estimation of this specific job.
        const newSamplerCount = countSamplerNodes(workflowCopy);
        window.api.logDebug({ message: `newSamplerCount on click: ${newSamplerCount}` });

        // Set pending flag BEFORE the POST so execution_start events that arrive
        // before the response can still be matched to this generation.
        pendingPromptId = true;
        
        // Reset save state for new generation
        savedForPromptId = null;
        promptSavedPath = null;

        // Snapshot the fully-resolved workflow (with randomised seeds) for metadata embedding later
        lastSubmittedWorkflow = workflowCopy;

        // Snapshot parameter and image slots state for this run
        const capturedParamValues = {};
        paramMappings.forEach(mapping => {
          const el = document.getElementById(mapping.elementId);
          if (el) {
            capturedParamValues[mapping.elementId] = el.value;
          }
        });
        const capturedImageSlots = JSON.parse(JSON.stringify(imageSlots));

        // 2. Submit prompt JSON to ComfyUI
        //    Read the selected preview method from the UI dropdown (defaults to 'auto').
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
        
        // Add to our queued prompt IDs tracking set
        if (result && result.prompt_id) {
          myQueuedPromptIds.add(result.prompt_id);
          promptSamplerCountsMap[result.prompt_id] = newSamplerCount;
          const ffSettings = captureFacefusionSettings();
          const prefixEl = document.getElementById('autosave-prefix');
          const paddingEl = document.getElementById('autosave-padding');
          const startingNoEl = document.getElementById('autosave-starting-no');
          const sourceEl = document.getElementById('autosave-original-source');
          const delimEl = document.getElementById('autosave-delimiter');

          const autosaveSettings = {
            prefix: prefixEl ? prefixEl.value.trim() : 'autosave',
            insertOriginal: document.getElementById('autosave-insert-original')?.checked ?? true,
            padding: paddingEl ? (isNaN(parseInt(paddingEl.value, 10)) ? 4 : parseInt(paddingEl.value, 10)) : 4,
            startingNo: startingNoEl ? (isNaN(parseInt(startingNoEl.value, 10)) ? 1 : parseInt(startingNoEl.value, 10)) : 1,
            source: sourceEl ? sourceEl.value : 'slot1',
            delimiter: delimEl ? delimEl.value : '_'
          };
          
          promptJobStates.set(result.prompt_id, {
            paramValues: capturedParamValues,
            imageSlots: capturedImageSlots,
            workflow: workflowCopy,
            facefusionSettings: ffSettings,
            autosaveSettings: autosaveSettings
          });

          const autoSendFf = document.getElementById('auto-send-ff');
          const isLinked = autoSendFf ? autoSendFf.checked : false;

          let initialFilename = 'Pending...';
          if (outputFolderPath) {
            const prefix = autosaveSettings.prefix;
            const insertOriginal = autosaveSettings.insertOriginal;
            const padding = autosaveSettings.padding;
            const startingNo = autosaveSettings.startingNo;
            const delimiter = autosaveSettings.delimiter;
            const source = autosaveSettings.source;

            let originalBasename = '';
            if (insertOriginal) {
              const slotIdx = parseInt(source.replace('slot', ''), 10) - 1;
              const slot = capturedImageSlots.find(s => s.slotIndex === slotIdx);
              if (slot && slot.imageFilename) {
                const fn = slot.imageFilename;
                originalBasename = fn.substring(0, fn.lastIndexOf('.')) || fn;
              }
            }

            const formattedNo = padding > 0 ? String(startingNo).padStart(padding, '0') : String(startingNo);
            const parts = [];
            if (prefix) parts.push(prefix);
            if (insertOriginal && originalBasename) parts.push(originalBasename);
            parts.push(formattedNo);

            initialFilename = parts.filter(Boolean).join(delimiter) + '.png';
          }

          jobHistoryList.push({
            promptId: result.prompt_id,
            timestamp: new Date(),
            status: 'pending',
            filename: initialFilename,
            aspectRatio: getAspectRatioForPrompt(capturedParamValues),
            linkedToFF: isLinked,
            faceSelectorOrder: isLinked && ffSettings ? ffSettings.faceSelectorOrder : '-'
          });
          refreshJobsListIfVisible();

          window.api.logDebug({ message: `Prompt added to myQueuedPromptIds: ${result.prompt_id}, samplerCount: ${newSamplerCount}` });
          console.log(`Prompt queued successfully! Prompt ID: ${result.prompt_id}`);
        }

        pendingPromptId = false;

        // Re-enable Run button so they can click it again to queue more
        btnRun.disabled = false;
        btnRun.classList.remove('btn-disabled');

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
        pendingPromptId = false;
        if (btnRun) {
          btnRun.disabled = false;
          btnRun.classList.remove('btn-disabled');
        }
        checkQueueStatus();
      }
    });
  }

  if (btnStop) {
    btnStop.addEventListener('click', async () => {
      await interruptActiveGeneration();
    });
  }
}

// 7. Output Settings Folder Management
function initOutputSettings() {
  const btnSelect = document.getElementById('btn-select-output-folder');
  const btnClear = document.getElementById('btn-clear-output-folder');

  const prefixInput = document.getElementById('autosave-prefix');
  const insertOriginalCheckbox = document.getElementById('autosave-insert-original');
  const clearHistoryCheckbox = document.getElementById('autosave-clear-history');
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
  if (clearHistoryCheckbox) {
    clearHistoryCheckbox.checked = localStorage.getItem('autosave_clear_history') === 'true';
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
  if (clearHistoryCheckbox) {
    clearHistoryCheckbox.addEventListener('change', () => {
      localStorage.setItem('autosave_clear_history', clearHistoryCheckbox.checked);
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
      const selectedDir = await window.api.selectOutputFolder(outputFolderPath);
      if (selectedDir) {
        if (watchFolderPath && selectedDir.toLowerCase() === watchFolderPath.toLowerCase()) {
          showToast('Output Folder Error', 'Output Folder cannot be the same as Watch Folder.', 'error');
          return;
        }
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

// ─── Auto Automation Logic (Face Fusion and Watch Folder) ────────────────────
let facefusionQueue = [];

function checkAndProcessFacefusionQueue() {
  const btnRunFf = document.getElementById('btn-run-ff');
  if (!btnRunFf) return;

  // If already running or busy, wait in queue
  if (isFacefusionRunning) {
    console.log('[FaceFusion Queue] Process is currently busy. Waiting in queue. Remaining items:', facefusionQueue.length);
    return;
  }

  if (facefusionQueue.length === 0) {
    return;
  }

  const nextItem = facefusionQueue.shift();
  let nextPath = '';
  if (nextItem && typeof nextItem === 'object') {
    nextPath = nextItem.savedPath;
    currentFFSnapshot = nextItem.ffSettings;
    currentFFJobId = nextItem.jobId || null;
  } else {
    nextPath = nextItem;
    currentFFSnapshot = null;
    currentFFJobId = null;
  }

  console.log('[FaceFusion Queue] Processing next queued image:', nextPath);
  showToast('Queue Processing', `Processing next image in Face Fusion queue. Remaining: ${facefusionQueue.length}`, 'success');

  // Update Face Fusion target
  ffTargetPath = nextPath;
  localStorage.setItem('ff_target_path', nextPath);

  const targetPathDisplay = document.getElementById('ff-target-path-display');
  if (targetPathDisplay) {
    targetPathDisplay.value = nextPath;
  }

  const targetPreviewImg = document.getElementById('ff-target-preview-img');
  const targetPreviewVid = document.getElementById('ff-target-preview-vid');
  const targetPlaceholder = document.getElementById('ff-target-preview-placeholder');

  if (targetPreviewImg) {
    targetPreviewImg.src = 'file:///' + nextPath.replace(/\\/g, '/');
    targetPreviewImg.classList.remove('hidden');
  }
  if (targetPreviewVid) {
    targetPreviewVid.classList.add('hidden');
  }
  if (targetPlaceholder) {
    targetPlaceholder.classList.add('hidden');
  }

  // Trigger Face Fusion Run
  btnRunFf.click();
}

function triggerAutoFaceFusion(savedPath, promptId) {
  const state = promptId ? promptJobStates.get(promptId) : null;
  const ffSettings = state ? state.facefusionSettings : null;

  const targetFilename = savedPath.split(/[\\/]/).pop();
  const sourceFilename = ffSettings ? (ffSettings.sourcePath ? ffSettings.sourcePath.split(/[\\/]/).pop() : 'N/A') : (ffSourcePath ? ffSourcePath.split(/[\\/]/).pop() : 'N/A');
  const selectorOrder = ffSettings ? ffSettings.faceSelectorOrder : (document.getElementById('ff-selector-order')?.value || '-');
  
  const jobId = 'ff_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  
  ffJobHistoryList.push({
    id: jobId,
    promptId: promptId,
    timestamp: new Date(),
    status: 'pending',
    targetFilename: targetFilename,
    outputFilename: 'Pending...',
    sourceFilename: sourceFilename,
    selectorOrder: selectorOrder
  });

  facefusionQueue.push({ savedPath, ffSettings, jobId });
  console.log(`[FaceFusion Queue] Added image path to queue: ${savedPath}. Total items: ${facefusionQueue.length}`);
  showToast('Added to Queue', `Image added to Face Fusion queue (${facefusionQueue.length} pending)`, 'info');
  
  refreshJobsListIfVisible();
  checkAndProcessFacefusionQueue();
}

async function setSlotImage(slotIndex, filePath, fileName) {
  const slotState = imageSlots.find(s => s.slotIndex === slotIndex);
  if (!slotState || !slotState.nodeId) return false;

  const slotEl = document.querySelector(`.param-item.image-slot[data-slot-index="${slotIndex}"]`);
  if (!slotEl) return false;

  const hiddenValue = slotEl.querySelector('input[type="hidden"]');
  const filenameSpan = slotEl.querySelector('.image-picker-filename');
  const statusSpan = slotEl.querySelector('.image-picker-status');
  const preview = slotEl.querySelector('.image-picker-preview');
  const checkbox = slotEl.querySelector('.slot-enable-checkbox');

  if (filenameSpan) {
    filenameSpan.textContent = fileName;
    filenameSpan.classList.add('selected');
  }
  if (statusSpan) {
    statusSpan.textContent = 'Uploading...';
    statusSpan.className = 'image-picker-status uploading';
  }

  const localUrl = `file:///${filePath.replace(/\\/g, '/')}`;
  if (preview) {
    preview.innerHTML = `<img src="${localUrl}" alt="Preview">`;
    const CSS_ROTATION = { none: 0, '90': 90, '180': 180, '270': 270 };
    const CSS_FLIP = { none: '', horizontal: 'scaleX(-1)', vertical: 'scaleY(-1)' };
    const img = preview.querySelector('img');
    if (img) {
      const rot = `rotate(${CSS_ROTATION[slotState.rotation] || 0}deg)`;
      const flipVal = CSS_FLIP[slotState.flip] || '';
      img.style.transform = `${rot} ${flipVal}`.trim();
    }
  }

  try {
    const uploadResult = await window.api.uploadImageToComfyUI({
      filePath: filePath,
      comfyUrl: comfyuiUrl
    });

    if (uploadResult.ok) {
      if (hiddenValue) hiddenValue.value = uploadResult.name;
      slotState.imageFilename = uploadResult.name;
      if (filenameSpan) filenameSpan.textContent = uploadResult.name;
      if (statusSpan) {
        statusSpan.textContent = 'Uploaded';
        statusSpan.className = 'image-picker-status success';
      }
      
      // Auto enable checkbox if disabled
      if (checkbox && !checkbox.checked) {
        checkbox.checked = true;
        slotState.enabled = true;
        slotEl.classList.remove('disabled-slot');
        const selectBtn = slotEl.querySelector('.image-picker-actions button');
        if (selectBtn) selectBtn.disabled = false;
        const rotateBtn = slotEl.querySelector('.btn-rotate');
        if (rotateBtn) rotateBtn.disabled = !slotState.rotateNodeId;
        const flipSelect = slotEl.querySelector('.select-flip');
        if (flipSelect) flipSelect.disabled = !slotState.flipNodeId;
        localStorage.setItem(`img_slot_${slotIndex}_enabled`, 'true');
      }

      saveWorkflowToLocalStorage();
      if (window.updateAutosavePreview) window.updateAutosavePreview();
      updateCompareButtonState();
      return true;
    } else {
      throw new Error(uploadResult.error || 'Upload failed');
    }
  } catch (err) {
    console.error('Auto watch slot upload error:', err);
    if (statusSpan) {
      statusSpan.textContent = `Error: ${err.message}`;
      statusSpan.className = 'image-picker-status error';
    }
    if (preview) {
      preview.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
    }
    return false;
  }
}

function initAutomationSettings() {
  const autoSendFf = document.getElementById('auto-send-ff');
  const autoSendFfGroup = document.getElementById('auto-send-ff-settings-group');
  const autoSendFfSelectorOrder = document.getElementById('auto-send-ff-selector-order');

  const autoWatchFolder = document.getElementById('auto-watch-folder');
  const watchGroup = document.getElementById('watch-folder-settings-group');
  const watchPathDisplay = document.getElementById('watch-path-display');
  const btnSelectWatch = document.getElementById('btn-select-watch-folder');
  const btnClearWatch = document.getElementById('btn-clear-watch-folder');

  // 1. Load settings from localStorage
  const savedSendFf = localStorage.getItem('auto_send_ff') === 'true';
  const savedWatchFolder = localStorage.getItem('auto_watch_folder') === 'true';
  const savedWatchPath = localStorage.getItem('watch_folder_path') || '';
  const savedSelectorOrder = localStorage.getItem('ff_selector_order') || 'large-small';

  if (autoSendFf) autoSendFf.checked = savedSendFf;
  if (autoWatchFolder) autoWatchFolder.checked = savedWatchFolder;
  if (savedWatchPath) {
    watchFolderPath = savedWatchPath;
    updateWatchFolderUI();
  }

  // Toggle watch settings visibility initially
  if (watchGroup) {
    watchGroup.style.display = savedWatchFolder ? 'block' : 'none';
  }

  // Toggle auto face fusion settings visibility initially
  if (autoSendFfGroup) {
    autoSendFfGroup.style.display = savedSendFf ? 'block' : 'none';
  }

  // Initialize selector order value
  if (autoSendFfSelectorOrder) {
    autoSendFfSelectorOrder.value = savedSelectorOrder;
  }

  // 2. Setup event listeners
  if (autoSendFf) {
    autoSendFf.addEventListener('change', () => {
      localStorage.setItem('auto_send_ff', autoSendFf.checked);
      if (autoSendFfGroup) {
        autoSendFfGroup.style.display = autoSendFf.checked ? 'block' : 'none';
      }
    });
  }

  if (autoSendFfSelectorOrder) {
    autoSendFfSelectorOrder.addEventListener('change', () => {
      const val = autoSendFfSelectorOrder.value;
      localStorage.setItem('ff_selector_order', val);
      
      // Sync to the Face Fusion panel select element
      const ffSelectorOrder = document.getElementById('ff-selector-order');
      if (ffSelectorOrder) {
        ffSelectorOrder.value = val;
      }
    });
  }

  if (autoWatchFolder) {
    autoWatchFolder.addEventListener('change', async () => {
      localStorage.setItem('auto_watch_folder', autoWatchFolder.checked);
      if (watchGroup) {
        watchGroup.style.display = autoWatchFolder.checked ? 'block' : 'none';
      }

      if (autoWatchFolder.checked) {
        if (watchFolderPath) {
          // Validate watch folder path is not equal to output folder path
          if (outputFolderPath && watchFolderPath.toLowerCase() === outputFolderPath.toLowerCase()) {
            showToast('Watch Folder Error', 'Watch Folder cannot be the same as Output Folder to avoid infinite loops.', 'error');
            autoWatchFolder.checked = false;
            localStorage.setItem('auto_watch_folder', 'false');
            watchGroup.style.display = 'none';
            return;
          }
          
          const result = await window.api.startWatchingFolder(watchFolderPath);
          if (result.ok) {
            showToast('Watch Folder Active', `Monitoring folder:\n${watchFolderPath}`, 'success');
          } else {
            showToast('Watch Folder Error', result.error || 'Failed to start folder watcher', 'error');
          }
        } else {
          showToast('No Folder Configured', 'Please browse and select a watch folder.', 'warning');
        }
      } else {
        await window.api.stopWatchingFolder();
        showToast('Watch Folder Disabled', 'Folder monitoring has been stopped.', 'info');
      }
    });
  }

  if (btnSelectWatch) {
    btnSelectWatch.addEventListener('click', async () => {
      try {
        const selectedDir = await window.api.selectOutputFolder(watchFolderPath);
        if (selectedDir) {
          if (outputFolderPath && selectedDir.toLowerCase() === outputFolderPath.toLowerCase()) {
            showToast('Watch Folder Error', 'Watch Folder cannot be the same as Output Folder.', 'error');
            return;
          }

          watchFolderPath = selectedDir;
          localStorage.setItem('watch_folder_path', selectedDir);
          updateWatchFolderUI();

          if (autoWatchFolder && autoWatchFolder.checked) {
            const result = await window.api.startWatchingFolder(selectedDir);
            if (result.ok) {
              showToast('Watch Folder Set', `Monitoring folder:\n${selectedDir}`, 'success');
            } else {
              showToast('Watch Folder Error', result.error || 'Failed to start folder watcher', 'error');
            }
          } else {
            showToast('Watch Folder Set', `Folder set to:\n${selectedDir}`, 'success');
          }
        }
      } catch (err) {
        showToast('Selection Error', err.message, 'error');
      }
    });
  }

  if (btnClearWatch) {
    btnClearWatch.addEventListener('click', async () => {
      watchFolderPath = '';
      localStorage.removeItem('watch_folder_path');
      updateWatchFolderUI();
      if (autoWatchFolder && autoWatchFolder.checked) {
        await window.api.stopWatchingFolder();
      }
      showToast('Watch Folder Cleared', 'Folder monitoring path has been cleared.', 'info');
    });
  }

  function updateWatchFolderUI() {
    if (watchPathDisplay && btnClearWatch) {
      if (watchFolderPath) {
        watchPathDisplay.textContent = watchFolderPath;
        watchPathDisplay.title = watchFolderPath;
        watchPathDisplay.classList.add('configured');
        btnClearWatch.disabled = false;
      } else {
        watchPathDisplay.textContent = 'Not configured';
        watchPathDisplay.title = 'Not configured';
        watchPathDisplay.classList.remove('configured');
        btnClearWatch.disabled = true;
      }
    }
  }

  // 3. Register watch folder IPC listener
  if (window.api && typeof window.api.onWatchFolderNewImage === 'function') {
    window.api.onWatchFolderNewImage(async (data) => {
      if (!autoWatchFolder || !autoWatchFolder.checked) return;

      console.log(`[AutoWatch] New image detected in watch folder: ${data.filePath}`);

      // Find the first active slot
      const activeSlot = imageSlots.find(s => s.nodeId !== null);
      if (activeSlot) {
        showToast('Auto Watch Trigger', `Uploading ${data.fileName} to Slot ${activeSlot.slotIndex + 1}...`, 'success');
        const uploadOk = await setSlotImage(activeSlot.slotIndex, data.filePath, data.fileName);
        if (uploadOk) {
          triggerComfyRun();
        } else {
          showToast('Trigger Failed', 'Failed to upload new image to slot.', 'error');
        }
      } else {
        // No slots in active workflow, run directly
        triggerComfyRun();
      }
    });
  }

  function triggerComfyRun() {
    const btnRun = document.getElementById('btn-run');
    if (btnRun) {
      if (btnRun.disabled || btnRun.classList.contains('btn-disabled')) {
        console.warn('[AutoWatch] ComfyUI generator is currently busy. Queueing skipped.');
        showToast('Generator Busy', 'A ComfyUI run is in progress. The auto-trigger will not execute.', 'warning');
      } else {
        console.log('[AutoWatch] Automatically clicking ComfyUI Run...');
        showToast('Auto Run Triggered', 'Starting ComfyUI generation run...', 'success');
        btnRun.click();
      }
    }
  }

  // 4. Initial startup auto-start if checkbox was checked
  if (savedWatchFolder && savedWatchPath) {
    if (outputFolderPath && savedWatchPath.toLowerCase() === outputFolderPath.toLowerCase()) {
      console.warn('[AutoWatch] Watch path matches output path on startup. Watching disabled to prevent infinite loop.');
      if (autoWatchFolder) autoWatchFolder.checked = false;
      localStorage.setItem('auto_watch_folder', 'false');
      if (watchGroup) watchGroup.style.display = 'none';
      return;
    }

    setTimeout(() => {
      window.api.startWatchingFolder(savedWatchPath).then(result => {
        if (result.ok) {
          console.log(`[AutoWatch] Started watching folder on startup: ${savedWatchPath}`);
        } else {
          console.error(`[AutoWatch] Failed to start watching on startup: ${result.error}`);
        }
      });
    }, 1000);
  }
}

function initGeneralSettings() {
  const minimizeToTrayCheckbox = document.getElementById('minimize-to-tray');
  if (minimizeToTrayCheckbox) {
    const savedMinimizeToTray = localStorage.getItem('minimize_to_tray') === 'true';
    minimizeToTrayCheckbox.checked = savedMinimizeToTray;
    
    // Notify the main process about the initial setting value
    if (window.api && typeof window.api.updateMinimizeToTray === 'function') {
      window.api.updateMinimizeToTray(savedMinimizeToTray);
    }
    
    minimizeToTrayCheckbox.addEventListener('change', () => {
      const enabled = minimizeToTrayCheckbox.checked;
      localStorage.setItem('minimize_to_tray', enabled);
      if (window.api && typeof window.api.updateMinimizeToTray === 'function') {
        window.api.updateMinimizeToTray(enabled);
      }
    });
  }
}


// 8. Notification — silent (console only, no popup)
function showToast(title, message, type = 'success', action = null) {
  if (type === 'error') {
    console.error(`[${title}] ${message}`);
  } else {
    console.log(`[${title}] ${message}`);
  }
  if (window.api && typeof window.api.logDebug === 'function') {
    window.api.logDebug({ message: `Toast: [${title}] (${type}) - ${message}` });
  }
  // action callbacks are dropped silently
}

function dismissToast() {}

// 8b. Connection Modal Helpers & Initialization
function showConnectionModal() {
  const modal = document.getElementById('connection-modal');
  if (modal) modal.classList.remove('hidden');
}

function hideConnectionModal() {
  const modal = document.getElementById('connection-modal');
  if (modal) modal.classList.add('hidden');
}

function switchToTab(tabId) {
  const navItem = document.querySelector(`.nav-item[data-tab="${tabId}"]`);
  if (navItem) {
    navItem.click();
  }
}

function initConnectionModal() {
  const btnConfigure = document.getElementById('btn-modal-configure');
  const btnRetry = document.getElementById('btn-modal-retry');
  
  if (btnConfigure) {
    btnConfigure.addEventListener('click', () => {
      switchToTab('tab-service');
      hideConnectionModal();
    });
  }
  
  if (btnRetry) {
    btnRetry.addEventListener('click', () => {
      if (isConnecting || isRetryingConnection) return;
      isRetryingConnection = true;
      btnRetry.textContent = 'Connecting...';
      btnRetry.disabled = true;
      if (btnConfigure) btnConfigure.disabled = true;
      
      connectToComfyUI();
    });
  }
}

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
      
      // Load input image and apply rotation and flip if needed
      const ROTATION_DEGS = { none: 0, '90': 90, '180': 180, '270': 270 };
      const rotationAngle = ROTATION_DEGS[slot.rotation] || 0;
      const CSS_FLIP = { none: '', horizontal: 'scaleX(-1)', vertical: 'scaleY(-1)' };
      const flipVal = CSS_FLIP[slot.flip] || '';
      imgTop.style.transform = `rotate(${rotationAngle}deg) ${flipVal}`.trim();

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

// ─── Face Fusion Standalone Control Logic ────────────────────────────────────
let ffSourcePath = '';
let ffTargetPath = '';
let ffLastOutputPath = '';
let currentFFSnapshot = null;
let isFacefusionRunning = false;

function updateComfyWorkingStatus(isWorking) {
  const el = document.getElementById('indicator-comfy');
  if (el) {
    if (isWorking) {
      el.className = 'job-status-badge job-status-running';
      el.textContent = 'ComfyUI: Running';
      el.title = 'ComfyUI Status: Working';
    } else {
      el.className = 'job-status-badge job-status-pending';
      el.textContent = 'ComfyUI: Idle';
      el.title = 'ComfyUI Status: Waiting';
    }
  }
}

function updateFFWorkingStatus(isWorking) {
  const el = document.getElementById('indicator-ff');
  if (el) {
    if (isWorking) {
      el.className = 'job-status-badge job-status-running';
      el.textContent = 'Face Fusion: Running';
      el.title = 'Face Fusion Status: Working';
    } else {
      el.className = 'job-status-badge job-status-pending';
      el.textContent = 'Face Fusion: Idle';
      el.title = 'Face Fusion Status: Waiting';
    }
  }
}

let jobHistoryList = [];
let ffJobHistoryList = [];
let currentFFJobId = null;
let qwenCanvasNodeId = null;

function getAspectRatioForPrompt(capturedParamValues) {
  const mapping = paramMappings.find(m => m.key === 'aspect_ratio');
  if (!mapping) return 'N/A';
  if (capturedParamValues && capturedParamValues[mapping.elementId] !== undefined) {
    return capturedParamValues[mapping.elementId];
  }
  const el = document.getElementById(mapping.elementId);
  return el ? el.value : 'N/A';
}

function renderJobsList() {
  // 1. Render ComfyUI Jobs
  const tbody = document.getElementById('jobs-table-body');
  if (tbody) {
    tbody.innerHTML = '';
    if (jobHistoryList.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 20px;">No jobs recorded in this session.</td>
        </tr>
      `;
    } else {
      const sortedJobs = [...jobHistoryList].sort((a, b) => b.timestamp - a.timestamp);
      sortedJobs.forEach(job => {
        const tr = document.createElement('tr');
        let statusClass = 'job-status-pending';
        let statusLabel = 'Waiting';
        if (job.status === 'running') {
          statusClass = 'job-status-running';
          statusLabel = 'Running';
        } else if (job.status === 'completed') {
          statusClass = 'job-status-completed';
          statusLabel = 'Completed';
        } else if (job.status === 'failed') {
          statusClass = 'job-status-failed';
          statusLabel = 'Failed';
        } else if (job.status === 'interrupted') {
          statusClass = 'job-status-interrupted';
          statusLabel = 'Stopped';
        }
        
        tr.innerHTML = `
          <td class="job-filename-cell" title="${job.filename}">${job.filename}</td>
          <td>${job.aspectRatio}</td>
          <td>${job.linkedToFF ? 'Yes' : 'No'}</td>
          <td>${job.faceSelectorOrder}</td>
          <td><span class="job-status-badge ${statusClass}">${statusLabel}</span></td>
        `;
        tbody.appendChild(tr);
      });
    }
  }

  // 2. Render Face Fusion Jobs
  const ffTbody = document.getElementById('ff-jobs-table-body');
  if (ffTbody) {
    ffTbody.innerHTML = '';
    if (ffJobHistoryList.length === 0) {
      ffTbody.innerHTML = `
        <tr>
          <td colspan="4" style="text-align: center; color: var(--text-muted); padding: 20px;">No jobs recorded in this session.</td>
        </tr>
      `;
    } else {
      const sortedFFJobs = [...ffJobHistoryList].sort((a, b) => b.timestamp - a.timestamp);
      sortedFFJobs.forEach(job => {
        const tr = document.createElement('tr');
        let statusClass = 'job-status-pending';
        let statusLabel = 'Waiting';
        if (job.status === 'running') {
          statusClass = 'job-status-running';
          statusLabel = 'Running';
        } else if (job.status === 'completed') {
          statusClass = 'job-status-completed';
          statusLabel = 'Completed';
        } else if (job.status === 'failed') {
          statusClass = 'job-status-failed';
          statusLabel = 'Failed';
        } else if (job.status === 'interrupted') {
          statusClass = 'job-status-interrupted';
          statusLabel = 'Stopped';
        }

        tr.innerHTML = `
          <td class="job-filename-cell" title="${job.outputFilename}">${job.outputFilename}</td>
          <td class="job-filename-cell" title="${job.sourceFilename}">${job.sourceFilename}</td>
          <td>${job.selectorOrder}</td>
          <td><span class="job-status-badge ${statusClass}">${statusLabel}</span></td>
        `;
        ffTbody.appendChild(tr);
      });
    }
  }
}

function refreshJobsListIfVisible() {
  const modal = document.getElementById('jobs-modal');
  if (modal && !modal.classList.contains('hidden')) {
    renderJobsList();
  }
}

function initJobsModal() {
  const btnViewJobs = document.getElementById('btn-view-jobs');
  const btnCloseJobs = document.getElementById('btn-close-jobs-modal');
  const btnClearJobs = document.getElementById('btn-clear-jobs-modal');
  const jobsModal = document.getElementById('jobs-modal');
  
  if (btnViewJobs && jobsModal) {
    btnViewJobs.addEventListener('click', () => {
      renderJobsList();
      jobsModal.classList.remove('hidden');
    });
  }
  
  if (btnCloseJobs && jobsModal) {
    btnCloseJobs.addEventListener('click', () => {
      jobsModal.classList.add('hidden');
    });
  }

  if (btnClearJobs) {
    btnClearJobs.addEventListener('click', () => {
      // Retain only running and pending jobs
      jobHistoryList = jobHistoryList.filter(job => job.status === 'running' || job.status === 'pending');
      ffJobHistoryList = ffJobHistoryList.filter(job => job.status === 'running' || job.status === 'pending');
      
      // Re-render lists
      renderJobsList();
      
      // Notify the user
      showToast('History Cleared', 'Completed and stopped/failed jobs have been cleared.', 'info');
    });
  }
  
  // Close on modal overlay click
  if (jobsModal) {
    jobsModal.addEventListener('click', (e) => {
      if (e.target === jobsModal) {
        jobsModal.classList.add('hidden');
      }
    });
  }
}

function captureFacefusionSettings() {
  const envTypeSelect = document.getElementById('ff-env-type');
  const condaEnvInput = document.getElementById('ff-conda-env');
  const condaPathInput = document.getElementById('ff-conda-path');
  const folderInput = document.getElementById('ff-folder-path');
  const pythonInput = document.getElementById('ff-python-path');
  
  const cbSwapper = document.getElementById('ff-proc-swapper');
  const cbEnhancer = document.getElementById('ff-proc-enhancer');
  const cbLipSyncer = document.getElementById('ff-proc-lip-syncer');
  const selectProvider = document.getElementById('ff-execution-provider');
  
  const swapperModelSelect = document.getElementById('ff-swapper-model');
  const swapperPixelBoostSelect = document.getElementById('ff-swapper-pixel-boost');
  const swapperWeightNumber = document.getElementById('ff-swapper-weight-number');
  const selectorModeSelect = document.getElementById('ff-selector-mode');
  const selectorOrderSelect = document.getElementById('ff-selector-order');

  const processors = [];
  if (cbSwapper && cbSwapper.checked) processors.push('face_swapper');
  if (cbEnhancer && cbEnhancer.checked) processors.push('face_enhancer');
  if (cbLipSyncer && cbLipSyncer.checked) processors.push('lip_syncer');

  return {
    envType: envTypeSelect ? envTypeSelect.value : 'conda',
    condaEnvName: condaEnvInput ? condaEnvInput.value.trim() : 'facefusion',
    condaPath: condaPathInput ? condaPathInput.value.trim() : '',
    folderPath: folderInput ? folderInput.value.trim() : '',
    pythonPath: pythonInput ? pythonInput.value.trim() : '',
    processors: processors,
    executionProvider: selectProvider ? selectProvider.value : 'cuda',
    faceSwapperModel: swapperModelSelect ? swapperModelSelect.value : 'inswapper_128',
    faceSwapperPixelBoost: swapperPixelBoostSelect ? swapperPixelBoostSelect.value : '',
    faceSwapperWeight: swapperWeightNumber ? parseFloat(swapperWeightNumber.value) : 1.0,
    faceSelectorMode: selectorModeSelect ? selectorModeSelect.value : 'reference',
    faceSelectorOrder: selectorOrderSelect ? selectorOrderSelect.value : 'large-small',
    sourcePath: ffSourcePath
  };
}

function initFacefusionTab() {
  const ffFolderInput = document.getElementById('ff-folder-path');
  const ffPythonInput = document.getElementById('ff-python-path');
  const ffCondaPathInput = document.getElementById('ff-conda-path');
  const ffEnvTypeSelect = document.getElementById('ff-env-type');
  const condaGroup = document.getElementById('ff-conda-group');
  const venvGroup = document.getElementById('ff-venv-group');
  const condaEnvInput = document.getElementById('ff-conda-env');
  
  const btnSelectFFFolder = document.getElementById('btn-select-ff-folder');
  const btnSelectFFPython = document.getElementById('btn-select-ff-python');
  const btnSelectFFCondaPath = document.getElementById('btn-select-ff-conda-path');
  const btnSelectSource = document.getElementById('btn-select-ff-source');
  const btnSelectTarget = document.getElementById('btn-select-ff-target');
  const sourcePathDisplay = document.getElementById('ff-source-path-display');
  const targetPathDisplay = document.getElementById('ff-target-path-display');
  
  const sourcePreview = document.getElementById('ff-source-preview');
  const sourcePlaceholder = document.getElementById('ff-source-preview-placeholder');
  const targetPreviewImg = document.getElementById('ff-target-preview-img');
  const targetPreviewVid = document.getElementById('ff-target-preview-vid');
  const targetPlaceholder = document.getElementById('ff-target-preview-placeholder');
  
  const cbSwapper = document.getElementById('ff-proc-swapper');
  const cbEnhancer = document.getElementById('ff-proc-enhancer');
  const cbLipSyncer = document.getElementById('ff-proc-lip-syncer');
  const selectProvider = document.getElementById('ff-execution-provider');
  
  const swapperModelSelect = document.getElementById('ff-swapper-model');
  const swapperPixelBoostSelect = document.getElementById('ff-swapper-pixel-boost');
  const swapperWeightRange = document.getElementById('ff-swapper-weight-range');
  const swapperWeightNumber = document.getElementById('ff-swapper-weight-number');
  const selectorModeSelect = document.getElementById('ff-selector-mode');
  const selectorOrderSelect = document.getElementById('ff-selector-order');
  
  const btnRun = document.getElementById('btn-run-ff');
  const btnStop = document.getElementById('btn-stop-ff');
  const statusText = document.getElementById('ff-status-text');
  const progressText = document.getElementById('ff-progress-text');
  const progressFill = document.getElementById('ff-progress-fill');
  const consoleLogs = document.getElementById('ff-console-logs');
  const btnClearConsole = document.getElementById('btn-clear-ff-console');
  const timeText = document.getElementById('ff-time-text');
  
  const btnOpenFolder = document.getElementById('btn-ff-open-output-folder');
  const btnOpenViewer = document.getElementById('btn-ff-open-viewer');
  
  const outputEmpty = document.getElementById('ff-output-empty');
  const outputImgContainer = document.getElementById('ff-output-image-container');
  const outputVidContainer = document.getElementById('ff-output-video-container');
  const resultImg = document.getElementById('ff-result-img');
  const resultVid = document.getElementById('ff-result-vid');

  // Helper to convert path to local file URL
  function getLocalFileUrl(absolutePath) {
    if (!absolutePath) return '';
    return 'file:///' + absolutePath.replace(/\\/g, '/');
  }

  // Helper to extract directory path from file path
  function getDirectoryOfFile(filePath) {
    if (!filePath) return '';
    const lastIndex = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'));
    if (lastIndex !== -1) {
      return filePath.substring(0, lastIndex);
    }
    return filePath;
  }

  // Helper to toggle visible form fields based on env type
  function toggleEnvFields(type) {
    if (type === 'conda') {
      if (condaGroup) condaGroup.classList.remove('hidden');
      if (venvGroup) venvGroup.classList.add('hidden');
    } else {
      if (condaGroup) condaGroup.classList.add('hidden');
      if (venvGroup) venvGroup.classList.remove('hidden');
    }
  }

  // 1. Load persisted paths and settings
  const savedEnvType = localStorage.getItem('ff_env_type') || 'conda';
  if (ffEnvTypeSelect) ffEnvTypeSelect.value = savedEnvType;
  toggleEnvFields(savedEnvType);

  const savedCondaPath = localStorage.getItem('ff_conda_path') || 'C:\\ProgramData\\miniconda3\\Scripts\\conda.exe';
  if (ffCondaPathInput) ffCondaPathInput.value = savedCondaPath;

  const savedCondaEnv = localStorage.getItem('ff_conda_env') || 'facefusion';
  if (condaEnvInput) condaEnvInput.value = savedCondaEnv;

  const savedFolder = localStorage.getItem('ff_folder_path') || 'C:\\facefusion';
  if (ffFolderInput) ffFolderInput.value = savedFolder;

  const savedPython = localStorage.getItem('ff_python_path') || 'C:\\facefusion\\.venv\\Scripts\\python.exe';
  if (ffPythonInput) ffPythonInput.value = savedPython;

  const savedProvider = localStorage.getItem('ff_execution_provider') || 'cuda';
  if (selectProvider) selectProvider.value = savedProvider;

  // Processors checkboxes
  if (cbSwapper) cbSwapper.checked = localStorage.getItem('ff_proc_swapper') !== 'false';
  if (cbEnhancer) cbEnhancer.checked = localStorage.getItem('ff_proc_enhancer') === 'true';
  if (cbLipSyncer) cbLipSyncer.checked = localStorage.getItem('ff_proc_lip-syncer') === 'true';

  // Load new settings
  const savedSwapperModel = localStorage.getItem('ff_swapper_model') || 'inswapper_128';
  if (swapperModelSelect) swapperModelSelect.value = savedSwapperModel;

  const savedPixelBoost = localStorage.getItem('ff_swapper_pixel_boost') || '';
  if (swapperPixelBoostSelect) swapperPixelBoostSelect.value = savedPixelBoost;

  const savedWeight = localStorage.getItem('ff_swapper_weight') || '1.0';
  if (swapperWeightRange) swapperWeightRange.value = savedWeight;
  if (swapperWeightNumber) swapperWeightNumber.value = savedWeight;

  const savedSelectorMode = localStorage.getItem('ff_selector_mode') || 'reference';
  if (selectorModeSelect) selectorModeSelect.value = savedSelectorMode;

  const savedSelectorOrder = localStorage.getItem('ff_selector_order') || 'large-small';
  if (selectorOrderSelect) selectorOrderSelect.value = savedSelectorOrder;

  // Persist settings changes
  if (ffEnvTypeSelect) {
    ffEnvTypeSelect.addEventListener('change', () => {
      const val = ffEnvTypeSelect.value;
      localStorage.setItem('ff_env_type', val);
      toggleEnvFields(val);
    });
  }
  if (ffCondaPathInput) {
    ffCondaPathInput.addEventListener('change', () => {
      localStorage.setItem('ff_conda_path', ffCondaPathInput.value.trim());
    });
  }
  if (condaEnvInput) {
    condaEnvInput.addEventListener('change', () => {
      localStorage.setItem('ff_conda_env', condaEnvInput.value.trim());
    });
  }
  if (ffFolderInput) {
    ffFolderInput.addEventListener('change', () => {
      localStorage.setItem('ff_folder_path', ffFolderInput.value.trim());
    });
  }
  if (ffPythonInput) {
    ffPythonInput.addEventListener('change', () => {
      localStorage.setItem('ff_python_path', ffPythonInput.value.trim());
    });
  }
  if (selectProvider) {
    selectProvider.addEventListener('change', () => {
      localStorage.setItem('ff_execution_provider', selectProvider.value);
    });
  }
  if (cbSwapper) cbSwapper.addEventListener('change', () => localStorage.setItem('ff_proc_swapper', cbSwapper.checked));
  if (cbEnhancer) cbEnhancer.addEventListener('change', () => localStorage.setItem('ff_proc_enhancer', cbEnhancer.checked));
  if (cbLipSyncer) cbLipSyncer.addEventListener('change', () => localStorage.setItem('ff_proc_lip-syncer', cbLipSyncer.checked));

  // Add auto-save event listeners for new settings
  if (swapperModelSelect) {
    swapperModelSelect.addEventListener('change', () => {
      localStorage.setItem('ff_swapper_model', swapperModelSelect.value);
    });
  }
  if (swapperPixelBoostSelect) {
    swapperPixelBoostSelect.addEventListener('change', () => {
      localStorage.setItem('ff_swapper_pixel_boost', swapperPixelBoostSelect.value);
    });
  }
  if (selectorModeSelect) {
    selectorModeSelect.addEventListener('change', () => {
      localStorage.setItem('ff_selector_mode', selectorModeSelect.value);
    });
  }
  if (selectorOrderSelect) {
    selectorOrderSelect.addEventListener('change', () => {
      const val = selectorOrderSelect.value;
      localStorage.setItem('ff_selector_order', val);
      
      const autoSendFfSelectorOrder = document.getElementById('auto-send-ff-selector-order');
      if (autoSendFfSelectorOrder) {
        autoSendFfSelectorOrder.value = val;
      }
    });
  }

  // Weight synchronization and persistence
  if (swapperWeightRange && swapperWeightNumber) {
    swapperWeightRange.addEventListener('input', () => {
      swapperWeightNumber.value = swapperWeightRange.value;
      localStorage.setItem('ff_swapper_weight', swapperWeightRange.value);
    });
    swapperWeightNumber.addEventListener('input', () => {
      let val = parseFloat(swapperWeightNumber.value);
      if (isNaN(val)) val = 1.0;
      if (val < 0) val = 0;
      if (val > 1) val = 1;
      // Round to nearest 0.05
      val = Math.round(val / 0.05) * 0.05;
      val = parseFloat(val.toFixed(2));
      swapperWeightRange.value = val;
      localStorage.setItem('ff_swapper_weight', String(val));
    });
  }
  if (cbLipSyncer) cbLipSyncer.addEventListener('change', () => localStorage.setItem('ff_proc_lip-syncer', cbLipSyncer.checked));

  // Browse Directory / Executable Buttons
  if (btnSelectFFFolder && ffFolderInput) {
    btnSelectFFFolder.addEventListener('click', async () => {
      const result = await window.api.selectOutputFolder(ffFolderInput.value.trim());
      if (result) {
        ffFolderInput.value = result;
        localStorage.setItem('ff_folder_path', result);
      }
    });
  }

  if (btnSelectFFPython && ffPythonInput) {
    btnSelectFFPython.addEventListener('click', async () => {
      const result = await window.api.selectPythonExe(getDirectoryOfFile(ffPythonInput.value.trim()));
      if (result) {
        ffPythonInput.value = result;
        localStorage.setItem('ff_python_path', result);
      }
    });
  }

  if (btnSelectFFCondaPath && ffCondaPathInput) {
    btnSelectFFCondaPath.addEventListener('click', async () => {
      const result = await window.api.selectCondaExe(getDirectoryOfFile(ffCondaPathInput.value.trim()));
      if (result) {
        ffCondaPathInput.value = result;
        localStorage.setItem('ff_conda_path', result);
      }
    });
  }

  // Load last selected files from local storage if they still exist
  const savedSource = localStorage.getItem('ff_source_path') || '';
  if (savedSource) {
    window.api.checkFileExists({ folderPath: '', filename: savedSource }).then(exists => {
      if (exists) {
        ffSourcePath = savedSource;
        if (sourcePathDisplay) sourcePathDisplay.value = savedSource;
        if (sourcePreview) {
          sourcePreview.src = getLocalFileUrl(savedSource);
          sourcePreview.classList.remove('hidden');
        }
        if (sourcePlaceholder) sourcePlaceholder.classList.add('hidden');
      }
    });
  }

  const savedTarget = localStorage.getItem('ff_target_path') || '';
  if (savedTarget) {
    window.api.checkFileExists({ folderPath: '', filename: savedTarget }).then(exists => {
      if (exists) {
        ffTargetPath = savedTarget;
        if (targetPathDisplay) targetPathDisplay.value = savedTarget;
        
        const ext = savedTarget.split('.').pop().toLowerCase();
        const isVideo = ['mp4', 'avi', 'mkv', 'mov', 'webm'].includes(ext);
        
        if (isVideo) {
          if (targetPreviewVid) {
            targetPreviewVid.src = getLocalFileUrl(savedTarget);
            targetPreviewVid.classList.remove('hidden');
          }
          if (targetPreviewImg) targetPreviewImg.classList.add('hidden');
        } else {
          if (targetPreviewImg) {
            targetPreviewImg.src = getLocalFileUrl(savedTarget);
            targetPreviewImg.classList.remove('hidden');
          }
          if (targetPreviewVid) targetPreviewVid.classList.add('hidden');
        }
        if (targetPlaceholder) targetPlaceholder.classList.add('hidden');
      }
    });
  }

  // 2. Select Source File Dialog
  if (btnSelectSource) {
    btnSelectSource.addEventListener('click', async () => {
      try {
        const fileData = await window.api.selectImageFile(getDirectoryOfFile(ffSourcePath));
        if (fileData) {
          ffSourcePath = fileData.filePath;
          if (sourcePathDisplay) sourcePathDisplay.value = fileData.filePath;
          localStorage.setItem('ff_source_path', fileData.filePath);
          
          if (sourcePreview) {
            sourcePreview.src = getLocalFileUrl(fileData.filePath);
            sourcePreview.classList.remove('hidden');
          }
          if (sourcePlaceholder) sourcePlaceholder.classList.add('hidden');
        }
      } catch (err) {
        console.error('Failed to select Facefusion source:', err);
      }
    });
  }

  // 3. Select Target File Dialog
  if (btnSelectTarget) {
    btnSelectTarget.addEventListener('click', async () => {
      try {
        const fileData = await window.api.selectFFTargetFile(getDirectoryOfFile(ffTargetPath));
        if (fileData) {
          ffTargetPath = fileData.filePath;
          if (targetPathDisplay) targetPathDisplay.value = fileData.filePath;
          localStorage.setItem('ff_target_path', fileData.filePath);

          const ext = fileData.filePath.split('.').pop().toLowerCase();
          const isVideo = ['mp4', 'avi', 'mkv', 'mov', 'webm'].includes(ext);

          if (isVideo) {
            if (targetPreviewVid) {
              targetPreviewVid.src = getLocalFileUrl(fileData.filePath);
              targetPreviewVid.classList.remove('hidden');
            }
            if (targetPreviewImg) targetPreviewImg.classList.add('hidden');
          } else {
            if (targetPreviewImg) {
              targetPreviewImg.src = getLocalFileUrl(fileData.filePath);
              targetPreviewImg.classList.remove('hidden');
            }
            if (targetPreviewVid) targetPreviewVid.classList.add('hidden');
          }
          if (targetPlaceholder) targetPlaceholder.classList.add('hidden');
        }
      } catch (err) {
        console.error('Failed to select Facefusion target:', err);
      }
    });
  }

  // 4. Console log handlers
  if (btnClearConsole) {
    btnClearConsole.addEventListener('click', () => {
      if (consoleLogs) consoleLogs.textContent = '';
    });
  }

  // Register Electron IPC listeners for Facefusion
  if (window.api && typeof window.api.onFacefusionLog === 'function') {
    window.api.onFacefusionLog((log) => {
      if (consoleLogs) {
        consoleLogs.textContent += log.text;
        // Auto scroll to bottom
        const parent = consoleLogs.parentElement;
        if (parent) {
          parent.scrollTop = parent.scrollHeight;
        }
      }
    });
  }

  if (window.api && typeof window.api.onFacefusionProgress === 'function') {
    window.api.onFacefusionProgress(({ percent }) => {
      if (progressText) progressText.textContent = `${percent}%`;
      if (progressFill) progressFill.style.width = `${percent}%`;
    });
  }

  // 5. Run Facefusion Task
  if (btnRun) {
    btnRun.addEventListener('click', async () => {
      // If already running, queue this run!
      if (isFacefusionRunning) {
        const sourcePathVal = ffSourcePath;
        const targetPathVal = ffTargetPath;

        if (!sourcePathVal) {
          showWarning('Source Missing', 'Please select a source face image.');
          return;
        }
        if (!targetPathVal) {
          showWarning('Target Missing', 'Please select a target image or video.');
          return;
        }

        const targetFilename = targetPathVal.split(/[\\/]/).pop();
        const sourceFilename = sourcePathVal.split(/[\\/]/).pop() || 'N/A';
        const activeOrder = selectorOrderSelect ? selectorOrderSelect.value : 'large-small';
        
        const jobId = 'ff_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        const capturedSettings = captureFacefusionSettings();

        ffJobHistoryList.push({
          id: jobId,
          timestamp: new Date(),
          status: 'pending',
          targetFilename: targetFilename,
          outputFilename: 'Pending...',
          sourceFilename: sourceFilename,
          selectorOrder: activeOrder
        });

        facefusionQueue.push({ savedPath: targetPathVal, ffSettings: capturedSettings, jobId: jobId });
        console.log(`[FaceFusion Queue] Added manual run to queue: ${targetPathVal}. Total items: ${facefusionQueue.length}`);
        showToast('Added to Queue', `Manual run added to Face Fusion queue (${facefusionQueue.length} pending)`, 'info');
        
        refreshJobsListIfVisible();
        return;
      }

      let envType, condaEnvName, condaPath, folderPath, pythonPath;
      let processors, executionProvider, faceSwapperModel, faceSwapperPixelBoost;
      let faceSwapperWeight, faceSelectorMode, faceSelectorOrder;
      let sourcePath, targetPath;

      if (currentFFSnapshot) {
        envType = currentFFSnapshot.envType;
        condaEnvName = currentFFSnapshot.condaEnvName;
        condaPath = currentFFSnapshot.condaPath;
        folderPath = currentFFSnapshot.folderPath;
        pythonPath = currentFFSnapshot.pythonPath;
        processors = currentFFSnapshot.processors;
        executionProvider = currentFFSnapshot.executionProvider;
        faceSwapperModel = currentFFSnapshot.faceSwapperModel;
        faceSwapperPixelBoost = currentFFSnapshot.faceSwapperPixelBoost;
        faceSwapperWeight = currentFFSnapshot.faceSwapperWeight;
        faceSelectorMode = currentFFSnapshot.faceSelectorMode;
        faceSelectorOrder = currentFFSnapshot.faceSelectorOrder;
        sourcePath = currentFFSnapshot.sourcePath;
        targetPath = ffTargetPath;
        
        currentFFSnapshot = null; // Clear snapshot immediately
      } else {
        envType = ffEnvTypeSelect ? ffEnvTypeSelect.value : 'conda';
        condaEnvName = condaEnvInput ? condaEnvInput.value.trim() : 'facefusion';
        condaPath = ffCondaPathInput ? ffCondaPathInput.value.trim() : '';
        folderPath = ffFolderInput.value.trim();
        pythonPath = ffPythonInput.value.trim();
        
        processors = [];
        if (cbSwapper && cbSwapper.checked) processors.push('face_swapper');
        if (cbEnhancer && cbEnhancer.checked) processors.push('face_enhancer');
        if (cbLipSyncer && cbLipSyncer.checked) processors.push('lip_syncer');
        
        executionProvider = selectProvider ? selectProvider.value : 'cuda';
        faceSwapperModel = swapperModelSelect ? swapperModelSelect.value : 'inswapper_128';
        faceSwapperPixelBoost = swapperPixelBoostSelect ? swapperPixelBoostSelect.value : '';
        faceSwapperWeight = swapperWeightNumber ? parseFloat(swapperWeightNumber.value) : 1.0;
        faceSelectorMode = selectorModeSelect ? selectorModeSelect.value : 'reference';
        faceSelectorOrder = selectorOrderSelect ? selectorOrderSelect.value : 'large-small';
        
        sourcePath = ffSourcePath;
        targetPath = ffTargetPath;
      }

      if (window.api && typeof window.api.logDebug === 'function') {
        window.api.logDebug({ message: `ff-run-click (hasSnapshot: ${!currentFFSnapshot}): envType=${envType}, condaEnvName=${condaEnvName}, condaPath=${condaPath}, folderPath=${folderPath}, pythonPath=${pythonPath}` });
      }

      const showError = (title, msg) => {
        facefusionQueue = []; // Clear queue on error
        showToast(title, msg, 'error');
        if (consoleLogs) {
          consoleLogs.textContent = `[${title}] ${msg}\n`;
        }
      };

      const showWarning = (title, msg) => {
        facefusionQueue = []; // Clear queue on warning
        showToast(title, msg, 'warning');
        if (consoleLogs) {
          consoleLogs.textContent = `[${title}] ${msg}\n`;
        }
      };

      if (envType === 'conda') {
        if (!folderPath || !condaEnvName || !condaPath) {
          showError('Configuration Error', 'Please enter a valid Facefusion folder, Conda path, and environment name.');
          return;
        }
      } else {
        if (!folderPath || !pythonPath) {
          showError('Configuration Error', 'Please enter valid Facefusion folder and Python paths.');
          return;
        }
      }

      // Validate paths exist
      const folderExists = await window.api.checkFileExists({ folderPath: '', filename: folderPath });
      if (!folderExists) {
        showError('Directory Not Found', `Facefusion directory was not found at: ${folderPath}\n\nPlease configure or browse to a valid folder.`);
        return;
      }

      if (envType === 'conda') {
        if (condaPath !== 'conda') {
          const condaExists = await window.api.checkFileExists({ folderPath: '', filename: condaPath });
          if (!condaExists) {
            showError('Conda Executable Not Found', `Conda executable was not found at: ${condaPath}\n\nPlease click 'Browse' and select the correct conda.exe.`);
            return;
          }
        }
      } else {
        const pythonExists = await window.api.checkFileExists({ folderPath: '', filename: pythonPath });
        if (!pythonExists) {
          showError('Python Not Found', `Python executable was not found at: ${pythonPath}\n\nPlease click 'Browse' and select the correct python.exe.`);
          return;
        }
      }
      if (!sourcePath) {
        showWarning('Source Missing', 'Please select a source face image.');
        return;
      }
      if (!targetPath) {
        showWarning('Target Missing', 'Please select a target image or video.');
        return;
      }

      // Compute output file path:
      // If outputFolderPath (the main app output setting) is configured, save there.
      // Else, save in the same directory as the target media file.
      const targetExt = targetPath.split('.').pop();
      const targetName = targetPath.split(/[\\/]/).pop().replace(/\.[^/.]+$/, '');
      
      let outDir = outputFolderPath;
      if (!outDir) {
        // Fallback to target media directory
        outDir = targetPath.substring(0, targetPath.lastIndexOf('\\'));
        if (!outDir) {
          outDir = targetPath.substring(0, targetPath.lastIndexOf('/'));
        }
      }

      // Check / assign Face Fusion job history state
      let jobId = currentFFJobId;
      if (!jobId) {
        // This is a manual job!
        jobId = 'ff_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        const targetFilename = targetPath.split(/[\\/]/).pop();
        const sourceFilename = sourcePath.split(/[\\/]/).pop() || 'N/A';
        const selectorOrderVal = faceSelectorOrder || '-';
        
        ffJobHistoryList.push({
          id: jobId,
          timestamp: new Date(),
          status: 'running',
          targetFilename: targetFilename,
          outputFilename: 'Running...',
          sourceFilename: sourceFilename,
          selectorOrder: selectorOrderVal
        });
        refreshJobsListIfVisible();
      } else {
        // Queued job starts running now
        const job = ffJobHistoryList.find(j => j.id === jobId);
        if (job) {
          job.status = 'running';
          job.outputFilename = 'Running...';
          refreshJobsListIfVisible();
        }
      }
      currentFFJobId = jobId;

      let index = 1;
      let outputFilename = '';
      let outPath = '';
      let exists = true;

      while (exists) {
        const indexStr = String(index).padStart(2, '0');
        outputFilename = `${targetName}_facefusion_${indexStr}.${targetExt}`;
        outPath = `${outDir}\\${outputFilename}`;
        exists = await window.api.checkFileExists({ folderPath: '', filename: outPath });
        if (exists) {
          index++;
        }
      }
      
      ffLastOutputPath = outPath;

      const activeJob = ffJobHistoryList.find(j => j.id === currentFFJobId);
      if (activeJob) {
        activeJob.outputFilename = outputFilename;
        refreshJobsListIfVisible();
      }

      if (processors.length === 0) {
        showWarning('Processors Missing', 'Please select at least one frame processor (e.g. face_swapper).');
        return;
      }

      // Reset and prepare UI
      if (btnStop) {
        btnStop.disabled = false;
        btnStop.classList.remove('btn-disabled');
      }
      if (statusText) statusText.textContent = 'Running...';
      if (progressText) progressText.textContent = '0%';
      if (progressFill) progressFill.style.width = '0%';
      if (consoleLogs) consoleLogs.textContent = 'Initializing Facefusion headless process...\n';
      
      // Hide previous results
      if (outputEmpty) outputEmpty.classList.remove('hidden');
      if (outputImgContainer) outputImgContainer.classList.add('hidden');
      if (outputVidContainer) outputVidContainer.classList.add('hidden');
      if (btnOpenViewer) btnOpenViewer.disabled = true;

      let timerInterval = null;
      try {
        isFacefusionRunning = true;
        updateFFWorkingStatus(true);
        const startTime = Date.now();
        if (timeText) timeText.textContent = '0s';
        timerInterval = setInterval(() => {
          const elapsedMs = Date.now() - startTime;
          if (timeText) timeText.textContent = formatJobTime(elapsedMs);
        }, 100);

        const result = await window.api.runFacefusion({
          envType,
          condaEnvName,
          condaPath,
          facefusionPath: folderPath,
          pythonPath,
          sourcePath: sourcePath,
          targetPath: targetPath,
          outputPath: outPath,
          processors,
          executionProviders: [executionProvider],
          faceSwapperModel,
          faceSwapperPixelBoost,
          faceSwapperWeight,
          faceSelectorMode,
          faceSelectorOrder
        });

        isFacefusionRunning = false;
        updateFFWorkingStatus(false);

        if (timerInterval) clearInterval(timerInterval);
        const elapsedTotalMs = Date.now() - startTime;
        if (timeText) timeText.textContent = formatJobTime(elapsedTotalMs);

        // Restore UI actions
        if (btnRun) btnRun.disabled = false;
        if (btnStop) {
          btnStop.disabled = true;
          btnStop.classList.add('btn-disabled');
        }

        // Update current job status in history
        const job = ffJobHistoryList.find(j => j.id === currentFFJobId);
        if (job) {
          if (result.ok) {
            job.status = 'completed';
          } else if (job.status !== 'interrupted') {
            job.status = 'failed';
          }
          refreshJobsListIfVisible();
        }

        currentFFJobId = null;

        // Process next queue item
        checkAndProcessFacefusionQueue();

        if (result.ok) {
          if (statusText) statusText.textContent = 'Finished';
          if (progressText) progressText.textContent = '100%';
          if (progressFill) progressFill.style.width = '100%';
          showToast('Success', `Task completed! Output saved to: ${outputFilename}`, 'success');

          // Load preview
          if (outputEmpty) outputEmpty.classList.add('hidden');
          const isVideo = ['mp4', 'avi', 'mkv', 'mov', 'webm'].includes(targetExt.toLowerCase());
          
          if (isVideo) {
            if (resultVid) {
              resultVid.src = getLocalFileUrl(outPath);
              if (outputVidContainer) outputVidContainer.classList.remove('hidden');
              if (outputImgContainer) outputImgContainer.classList.add('hidden');
            }
          } else {
            if (resultImg) {
              resultImg.src = getLocalFileUrl(outPath);
              if (outputImgContainer) outputImgContainer.classList.remove('hidden');
              if (outputVidContainer) outputVidContainer.classList.add('hidden');
            }
          }
          if (btnOpenViewer) btnOpenViewer.disabled = false;
        } else {
          if (statusText) statusText.textContent = 'Failed';
          showToast('Facefusion Failed', result.error || 'Subprocess exited with an error code.', 'error');
        }
      } catch (err) {
        isFacefusionRunning = false;
        updateFFWorkingStatus(false);
        if (timerInterval) clearInterval(timerInterval);
        if (btnRun) btnRun.disabled = false;
        if (btnStop) {
          btnStop.disabled = true;
          btnStop.classList.add('btn-disabled');
        }
        if (statusText) statusText.textContent = 'Failed';
        showToast('Process Error', err.message, 'error');

        // Update current job status in history
        const job = ffJobHistoryList.find(j => j.id === currentFFJobId);
        if (job && job.status !== 'interrupted') {
          job.status = 'failed';
          refreshJobsListIfVisible();
        }
        
        currentFFJobId = null;

        checkAndProcessFacefusionQueue();
      }
    });
  }

  // 6. Stop Facefusion Task
  if (btnStop) {
    btnStop.addEventListener('click', async () => {
      try {
        const job = ffJobHistoryList.find(j => j.id === currentFFJobId);
        if (job) {
          job.status = 'interrupted';
          refreshJobsListIfVisible();
        }
        const result = await window.api.stopFacefusion();
        if (result.ok) {
          if (statusText) statusText.textContent = 'Stopped';
          showToast('Task Stopped', 'Facefusion process terminated by user.', 'info');
        }
      } catch (err) {
        showToast('Error stopping process', err.message, 'error');
      }
    });
  }

  // 7. Open Output Folder Action
  if (btnOpenFolder) {
    btnOpenFolder.addEventListener('click', async () => {
      let folderToOpen = outputFolderPath;
      if (ffLastOutputPath) {
        folderToOpen = ffLastOutputPath.substring(0, ffLastOutputPath.lastIndexOf('\\'));
        if (!folderToOpen) {
          folderToOpen = ffLastOutputPath.substring(0, ffLastOutputPath.lastIndexOf('/'));
        }
      }
      
      if (!folderToOpen) {
        // Fallback to facefusion directory
        folderToOpen = ffFolderInput.value.trim();
      }

      if (folderToOpen) {
        const res = await window.api.openPath({ path: folderToOpen });
        if (!res.ok) {
          showToast('Error', res.error || 'Could not open folder', 'error');
        }
      } else {
        showToast('Directory not found', 'No output folder available to open.', 'warning');
      }
    });
  }

  // 8. Open Output in System Viewer
  if (btnOpenViewer) {
    btnOpenViewer.addEventListener('click', async () => {
      if (ffLastOutputPath) {
        const res = await window.api.openPath({ path: ffLastOutputPath });
        if (!res.ok) {
          showToast('Error', res.error || 'Could not open file', 'error');
        }
      }
    });
  }
}

function extractSettingsFromImportedJson(importedJson) {
  const settings = {
    clipPositive: [],
    clipNegative: [],
    qwenPositive: [],
    qwenNegative: [],
    imageSlots: []
  };

  if (Array.isArray(importedJson.nodes)) {
    const nodes = importedJson.nodes;
    
    nodes.forEach(node => {
      const type = node.type || '';
      const title = node.title || node.properties?.NodeNameForFN || '';
      const widgets = node.widgets_values || [];

      if (type === 'CLIPTextEncode' && widgets.length > 0 && typeof widgets[0] === 'string') {
        const val = widgets[0];
        const lowerTitle = title.toLowerCase();
        const isNegative = val.toLowerCase().includes('bad') || 
                           val.toLowerCase().includes('ugly') || 
                           val.toLowerCase().includes('nsfw') || 
                           lowerTitle.includes('negative');
        if (isNegative) {
          settings.clipNegative.push(val);
        } else {
          settings.clipPositive.push(val);
        }
      } else if (type === 'TextEncodeQwenImageEditPlus' && widgets.length > 0 && typeof widgets[0] === 'string') {
        const val = widgets[0];
        const lowerTitle = title.toLowerCase();
        let isNegative = false;
        if (lowerTitle.includes('negative') || lowerTitle.includes('neg')) {
          isNegative = true;
        } else if (lowerTitle.includes('positive') || lowerTitle.includes('postive') || lowerTitle.includes('pos')) {
          isNegative = false;
        } else {
          isNegative = val.trim() === '';
        }
        if (isNegative) {
          settings.qwenNegative.push(val);
        } else {
          settings.qwenPositive.push(val);
        }
      } else if (type === 'LoadImage' && widgets.length > 0 && typeof widgets[0] === 'string') {
        settings.imageSlots.push({
          imageFilename: widgets[0],
          enabled: true,
          rotation: 'none',
          flip: 'none'
        });
      }
    });

    const rotateNodes = nodes.filter(n => n.type === 'ImageRotate');
    const flipNodes = nodes.filter(n => n.type === 'ImageFlip');

    settings.imageSlots.forEach((slot, idx) => {
      if (idx < rotateNodes.length) {
        const rNode = rotateNodes[idx];
        const widgets = rNode.widgets_values || [];
        if (widgets.length > 0) {
          slot.rotation = mapComfyRotationToUi(widgets[0]);
        }
      }
      if (idx < flipNodes.length) {
        const fNode = flipNodes[idx];
        const widgets = fNode.widgets_values || [];
        if (widgets.length > 0) {
          const rawFlip = widgets[0] || 'none';
          if (rawFlip.includes('horizontally')) {
            slot.flip = 'horizontal';
          } else if (rawFlip.includes('vertically')) {
            slot.flip = 'vertical';
          }
        }
      }
    });

  } else {
    const knownPositiveNodes = new Set();
    const knownNegativeNodes = new Set();

    const traceConditioning = (startNodeId, visited = new Set()) => {
      if (!startNodeId || visited.has(startNodeId)) return [];
      visited.add(startNodeId);
      const node = importedJson[startNodeId];
      if (!node) return [];
      const classType = node.class_type || '';
      if (classType === 'CLIPTextEncode' || classType === 'TextEncodeQwenImageEditPlus') {
        return [startNodeId];
      }
      let found = [];
      if (node.inputs) {
        for (const key in node.inputs) {
          const val = node.inputs[key];
          if (Array.isArray(val) && val.length === 2 && typeof val[0] === 'string') {
            const kLower = key.toLowerCase();
            if (kLower.includes('conditioning') || 
                kLower.includes('positive') || 
                kLower.includes('negative') ||
                kLower.includes('prompt')) {
              found = found.concat(traceConditioning(String(val[0]), visited));
            }
          }
        }
      }
      return found;
    };

    for (const nodeId in importedJson) {
      const node = importedJson[nodeId];
      if (!node || !node.inputs) continue;
      const classType = node.class_type || '';
      const isSampler = classType.includes('Sampler') || classType === 'KSampler' || classType === 'KSamplerAdvanced';
      if (isSampler) {
        if (node.inputs.positive && Array.isArray(node.inputs.positive) && node.inputs.positive.length === 2) {
          const posNodes = traceConditioning(String(node.inputs.positive[0]));
          posNodes.forEach(id => knownPositiveNodes.add(id));
        }
        if (node.inputs.negative && Array.isArray(node.inputs.negative) && node.inputs.negative.length === 2) {
          const negNodes = traceConditioning(String(node.inputs.negative[0]));
          negNodes.forEach(id => knownNegativeNodes.add(id));
        }
      }
    }

    for (const nodeId in importedJson) {
      const node = importedJson[nodeId];
      if (!node || !node.inputs) continue;

      const classType = node.class_type || '';
      const nodeTitle = (node._meta && node._meta.title) ? node._meta.title : `${classType} (#${nodeId})`;

      if (classType === 'CLIPTextEncode' && typeof node.inputs.text === 'string') {
        let isNegative = false;
        if (knownNegativeNodes.has(nodeId)) {
          isNegative = true;
        } else if (knownPositiveNodes.has(nodeId)) {
          isNegative = false;
        } else {
          const val = node.inputs.text;
          isNegative = val.toLowerCase().includes('bad') || 
                       val.toLowerCase().includes('ugly') || 
                       val.toLowerCase().includes('nsfw') || 
                       nodeTitle.toLowerCase().includes('negative');
        }
        if (isNegative) {
          settings.clipNegative.push(node.inputs.text);
        } else {
          settings.clipPositive.push(node.inputs.text);
        }
      } else if (classType === 'TextEncodeQwenImageEditPlus' && typeof node.inputs.prompt === 'string') {
        let isNegative = false;
        if (knownNegativeNodes.has(nodeId)) {
          isNegative = true;
        } else if (knownPositiveNodes.has(nodeId)) {
          isNegative = false;
        } else {
          const val = node.inputs.prompt;
          const lowerTitle = nodeTitle.toLowerCase();
          if (lowerTitle.includes('negative') || lowerTitle.includes('neg')) {
            isNegative = true;
          } else if (lowerTitle.includes('positive') || lowerTitle.includes('postive') || lowerTitle.includes('pos')) {
            isNegative = false;
          } else {
            isNegative = val.trim() === '';
          }
        }
        if (isNegative) {
          settings.qwenNegative.push(node.inputs.prompt);
        } else {
          settings.qwenPositive.push(node.inputs.prompt);
        }
      }
    }

    const loadImageNodes = {};
    const rotateNodeForLoad = {};
    const flipNodeForLoad = {};

    for (const nodeId in importedJson) {
      const node = importedJson[nodeId];
      if (!node || !node.inputs) continue;
      if (node.class_type === 'LoadImage') {
        loadImageNodes[nodeId] = node;
      }
    }

    const loadIds = Object.keys(loadImageNodes);
    loadIds.sort((a, b) => parseInt(a) - parseInt(b));

    for (const loadId of loadIds) {
      for (const nodeId in importedJson) {
        const node = importedJson[nodeId];
        if (!node || !node.inputs) continue;
        const imgInput = node.inputs.image;
        if (Array.isArray(imgInput) && String(imgInput[0]) === loadId) {
          if (node.class_type === 'ImageRotate') {
            rotateNodeForLoad[loadId] = nodeId;
          } else if (node.class_type === 'ImageFlip') {
            flipNodeForLoad[loadId] = nodeId;
          }
        }
      }
      const rotateId = rotateNodeForLoad[loadId];
      if (rotateId) {
        for (const nodeId in importedJson) {
          const node = importedJson[nodeId];
          if (!node || !node.inputs) continue;
          const imgInput = node.inputs.image;
          if (Array.isArray(imgInput) && String(imgInput[0]) === rotateId && node.class_type === 'ImageFlip') {
            flipNodeForLoad[loadId] = nodeId;
          }
        }
      }
      const flipId = flipNodeForLoad[loadId];
      if (flipId) {
        for (const nodeId in importedJson) {
          const node = importedJson[nodeId];
          if (!node || !node.inputs) continue;
          const imgInput = node.inputs.image;
          if (Array.isArray(imgInput) && String(imgInput[0]) === flipId && node.class_type === 'ImageRotate') {
            rotateNodeForLoad[loadId] = nodeId;
          }
        }
      }
    }

    loadIds.forEach((loadId) => {
      const defaultImage = loadImageNodes[loadId].inputs.image || '';
      
      const rotateId = rotateNodeForLoad[loadId];
      const rawRotation = rotateId ? (importedJson[rotateId].inputs.rotation || 'none') : 'none';
      const rotation = mapComfyRotationToUi(rawRotation);

      const flipId = flipNodeForLoad[loadId];
      let flip = 'none';
      if (flipId && importedJson[flipId]) {
        const rawFlip = importedJson[flipId].inputs.flip_method || 'none';
        if (rawFlip.includes('horizontally')) {
          flip = 'horizontal';
        } else if (rawFlip.includes('vertically')) {
          flip = 'vertical';
        }
      }

      settings.imageSlots.push({
        imageFilename: defaultImage,
        enabled: true,
        rotation: rotation,
        flip: flip
      });
    });
  }

  return settings;
}

function initImportPrompt() {
  const btnImport = document.getElementById('btn-import-prompt');
  if (btnImport) {
    btnImport.addEventListener('click', async () => {
      if (!currentWorkflow) {
        alert('Please load a workflow JSON first.');
        return;
      }
      try {
        const lastPath = localStorage.getItem('comfyui_last_import_prompt_path') || '';
        const result = await window.api.importPromptFile(lastPath);
        if (!result) return;

        if (!result.ok) {
          alert('This file does not contain the required data to be extracted.');
          return;
        }

        if (result.filePath) {
          localStorage.setItem('comfyui_last_import_prompt_path', result.filePath);
        }

        const settings = extractSettingsFromImportedJson(result.content);
        
        const hasPrompts = settings.clipPositive.length > 0 || settings.clipNegative.length > 0 ||
                           settings.qwenPositive.length > 0 || settings.qwenNegative.length > 0;
        const hasImages = settings.imageSlots.length > 0;
        
        if (!hasPrompts && !hasImages) {
          alert('This file does not contain the required data to be extracted.');
          return;
        }

        applyPreservedSettings(currentWorkflow, settings);
        
        localStorage.setItem('comfyui_workflow_json', JSON.stringify(currentWorkflow));
        
        generateDynamicParamsUI(currentWorkflow);
        
        showToast('Import Success', 'Prompts and image settings imported successfully.', 'success');
      } catch (err) {
        console.error('Import error:', err);
        alert('This file does not contain the required data to be extracted.');
      }
    });
  }
}

function initClearSlots() {
  const btnClearSlots = document.getElementById('btn-clear-slots');
  if (btnClearSlots) {
    btnClearSlots.addEventListener('click', () => {
      if (!currentWorkflow) {
        alert('Please load a workflow JSON first.');
        return;
      }

      // Loop through all currently active image slots and clear/reset their workflow node values
      imageSlots.forEach(slotState => {
        if (!slotState.nodeId) return;

        // Clear image filename in the workflow JSON
        if (currentWorkflow[slotState.nodeId] && currentWorkflow[slotState.nodeId].inputs) {
          currentWorkflow[slotState.nodeId].inputs.image = "";
        }

        // Reset rotation to 'none' in the workflow JSON
        if (slotState.rotateNodeId && currentWorkflow[slotState.rotateNodeId] && currentWorkflow[slotState.rotateNodeId].inputs) {
          currentWorkflow[slotState.rotateNodeId].inputs.rotation = "none";
        }

        // Reset flip to 'none' in the workflow JSON
        if (slotState.flipNodeId && currentWorkflow[slotState.flipNodeId] && currentWorkflow[slotState.flipNodeId].inputs) {
          currentWorkflow[slotState.flipNodeId].inputs.flip_method = "none";
        }

        // Reset state in localStorage
        localStorage.setItem(`img_slot_${slotState.slotIndex}_flip`, "none");
        localStorage.setItem(`img_slot_${slotState.slotIndex}_enabled`, "false");
        localStorage.removeItem(`last_image_path_slot_${slotState.slotIndex}`);
      });

      // Save the cleared workflow back to localStorage
      localStorage.setItem('comfyui_workflow_json', JSON.stringify(currentWorkflow));

      // Regenerate the dynamic params UI to fully refresh the DOM with empty states
      generateDynamicParamsUI(currentWorkflow);

      // Toast notification for user feedback
      showToast('Slots Cleared', 'All image slots cleared and states reset successfully.', 'info');
    });
  }
}

function initQwenAutoAspectControls() {
  const autoCheckbox = document.getElementById('qwen-auto-aspect-ratio');
  const slotSelect = document.getElementById('qwen-auto-aspect-ratio-slot');
  const settingsGroup = document.getElementById('qwen-auto-aspect-ratio-settings-group');

  if (!autoCheckbox || !slotSelect) return;

  // Restore states
  const savedAuto = localStorage.getItem('qwen_auto_aspect_ratio') === 'true';
  const savedSlot = localStorage.getItem('qwen_auto_aspect_ratio_slot') || '0';

  autoCheckbox.checked = savedAuto;
  slotSelect.value = savedSlot;

  const toggleGroup = () => {
    const sidebarSelect = document.getElementById('sidebar-qwen-aspect-ratio');
    if (autoCheckbox.checked) {
      if (settingsGroup) settingsGroup.style.display = 'block';
      if (sidebarSelect) sidebarSelect.disabled = true;
      if (currentWorkflow && qwenCanvasNodeId) {
        const mainSelect = document.getElementById(`param-${qwenCanvasNodeId}-aspect_ratio`);
        if (mainSelect) mainSelect.disabled = true;
      }
      updateQwenAspectFromSlot();
    } else {
      if (settingsGroup) settingsGroup.style.display = 'none';
      if (sidebarSelect) sidebarSelect.disabled = false;
      if (currentWorkflow && qwenCanvasNodeId) {
        const mainSelect = document.getElementById(`param-${qwenCanvasNodeId}-aspect_ratio`);
        if (mainSelect) mainSelect.disabled = false;
      }
    }
  };

  autoCheckbox.addEventListener('change', () => {
    localStorage.setItem('qwen_auto_aspect_ratio', autoCheckbox.checked);
    toggleGroup();
  });

  slotSelect.addEventListener('change', () => {
    localStorage.setItem('qwen_auto_aspect_ratio_slot', slotSelect.value);
    updateQwenAspectFromSlot();
  });

  // Call toggleGroup initially to set correct state
  toggleGroup();
}

function updateQwenAspectFromSlot() {
  const autoCheckbox = document.getElementById('qwen-auto-aspect-ratio');
  if (!autoCheckbox || !autoCheckbox.checked) return;

  const slotSelect = document.getElementById('qwen-auto-aspect-ratio-slot');
  if (!slotSelect) return;

  const slotIndex = parseInt(slotSelect.value);
  if (isNaN(slotIndex) || slotIndex < 0 || slotIndex >= imageSlots.length) return;

  const slotState = imageSlots[slotIndex];
  if (!slotState) return;

  const img = document.querySelector(`.image-slot[data-slot-index="${slotIndex}"] .image-picker-preview img`);
  if (!img) return;

  const performSync = () => {
    if (!img.naturalWidth || !img.naturalHeight) return;
    
    let ratio = img.naturalWidth / img.naturalHeight;
    if (slotState.rotation === '90' || slotState.rotation === '270') {
      ratio = img.naturalHeight / img.naturalWidth;
    }

    // Now find the closest matching option in the sidebar selector
    const sidebarSelect = document.getElementById('sidebar-qwen-aspect-ratio');
    if (!sidebarSelect || sidebarSelect.options.length === 0) return;

    let closestOptionValue = null;
    let minDiff = Infinity;

    Array.from(sidebarSelect.options).forEach(opt => {
      const optRatio = getRatioFromOptionText(opt.textContent || opt.value);
      if (optRatio !== null) {
        const diff = Math.abs(ratio - optRatio);
        if (diff < minDiff) {
          minDiff = diff;
          closestOptionValue = opt.value;
        }
      }
    });

    const mainSelect = qwenCanvasNodeId ? document.getElementById(`param-${qwenCanvasNodeId}-aspect_ratio`) : null;
    const needsUpdate = (closestOptionValue !== null) && 
                        ((sidebarSelect.value !== closestOptionValue) || 
                         (mainSelect && mainSelect.value !== closestOptionValue));

    if (needsUpdate) {
      sidebarSelect.value = closestOptionValue;
      
      // Update values and dispatch events
      if (currentWorkflow && qwenCanvasNodeId && mainSelect) {
        const originalDisabled = mainSelect.disabled;
        mainSelect.disabled = false;
        mainSelect.value = closestOptionValue;
        mainSelect.dispatchEvent(new Event('change', { bubbles: true }));
        mainSelect.disabled = originalDisabled;
      }
      
      // Also update sidebar Select
      const origSidebarDisabled = sidebarSelect.disabled;
      sidebarSelect.disabled = false;
      sidebarSelect.dispatchEvent(new Event('change', { bubbles: true }));
      sidebarSelect.disabled = origSidebarDisabled;
    }
  };

  if (img.complete) {
    performSync();
  } else {
    img.addEventListener('load', performSync, { once: true });
  }
}

function getRatioFromOptionText(text) {
  const match = text.match(/(\d+)\s*[:x*\/\\-]\s*(\d+)/i);
  if (match) {
    const w = parseFloat(match[1]);
    const h = parseFloat(match[2]);
    if (w > 0 && h > 0) {
      return w / h;
    }
  }
  const single = parseFloat(text);
  if (!isNaN(single) && single > 0) {
    return single;
  }
  return null;
}


