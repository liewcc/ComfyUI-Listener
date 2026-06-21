const { contextBridge, ipcRenderer } = require('electron');

// Expose a safe bridge to the renderer process
contextBridge.exposeInMainWorld('api', {
  selectWorkflowFile: () => ipcRenderer.invoke('select-workflow-file'),
  comfyRequest: (options) => ipcRenderer.invoke('comfy-request', options),
  // Fetch image from ComfyUI and return as base64 data URL (bypasses renderer sandbox)
  comfyFetchImage: (options) => ipcRenderer.invoke('comfy-fetch-image', options),
  // Save image to a temp file and open with Windows default image viewer
  openImageInViewer: (options) => ipcRenderer.invoke('open-image-in-viewer', options),
  // Select local image file
  selectImageFile: (defaultPath) => ipcRenderer.invoke('select-image-file', defaultPath),
  // Select local target media file (image or video) for Facefusion
  selectFFTargetFile: (defaultPath) => ipcRenderer.invoke('select-ff-target-file', defaultPath),
  // Select Python executable file
  selectPythonExe: (defaultPath) => ipcRenderer.invoke('select-python-exe', defaultPath),
  // Select Conda executable file
  selectCondaExe: (defaultPath) => ipcRenderer.invoke('select-conda-exe', defaultPath),
  // Upload image to ComfyUI server
  uploadImageToComfyUI: (options) => ipcRenderer.invoke('upload-image-to-comfyui', options),
  // Select output folder on disk
  selectOutputFolder: (defaultPath) => ipcRenderer.invoke('select-output-folder', defaultPath),
  // Save generated image to local output folder
  saveImageToFolder: (options) => ipcRenderer.invoke('save-image-to-folder', options),
  // Check if a file exists in the filesystem
  checkFileExists: (options) => ipcRenderer.invoke('check-file-exists', options),
  // Open path (file or directory) in explorer
  openPath: (options) => ipcRenderer.invoke('open-path', options),
  // Write debug log to disk
  logDebug: (options) => ipcRenderer.invoke('log-debug', options),
  // Run Facefusion Python process
  runFacefusion: (options) => ipcRenderer.invoke('run-facefusion', options),
  // Stop Facefusion Python process
  stopFacefusion: () => ipcRenderer.invoke('stop-facefusion'),
  // Listen for Facefusion logs
  onFacefusionLog: (callback) => {
    ipcRenderer.removeAllListeners('facefusion-log');
    ipcRenderer.on('facefusion-log', (event, data) => callback(data));
  },
  // Listen for Facefusion progress percentage
  onFacefusionProgress: (callback) => {
    ipcRenderer.removeAllListeners('facefusion-progress');
    ipcRenderer.on('facefusion-progress', (event, data) => callback(data));
  },
  // Import prompt file
  importPromptFile: (defaultPath) => ipcRenderer.invoke('import-prompt-file', defaultPath),
  // Watch folder APIs
  startWatchingFolder: (folderPath) => ipcRenderer.invoke('start-watching-folder', folderPath),
  stopWatchingFolder: () => ipcRenderer.invoke('stop-watching-folder'),
  onWatchFolderNewImage: (callback) => {
    ipcRenderer.removeAllListeners('watch-folder-new-image');
    ipcRenderer.on('watch-folder-new-image', (event, data) => callback(data));
  },
  selectSaveWorkflowFile: (defaultPath) => ipcRenderer.invoke('select-save-workflow-file', defaultPath),
  combineWorkflows: (options) => ipcRenderer.invoke('combine-workflows', options),
  updateMinimizeToTray: (enabled) => ipcRenderer.send('update-minimize-to-tray', enabled),
  // Extract injected source path from a ComfyUI-hosted input PNG's metadata
  extractPngSourcePath: (options) => ipcRenderer.invoke('extract-png-source-path', options),
  injectMetadataToFile: (options) => ipcRenderer.invoke('inject-metadata-to-file', options),
  showImageNotification: (options) => ipcRenderer.invoke('show-image-notification', options),
  showNotification: (options) => ipcRenderer.invoke('show-notification', options),
  setHideCliFlag: (hide) => ipcRenderer.invoke('set-hide-cli', hide),
  getHideCliFlag: () => ipcRenderer.invoke('get-hide-cli'),
  saveJobHistory: (data) => ipcRenderer.invoke('save-job-history', data),
  loadJobHistory: () => ipcRenderer.invoke('load-job-history'),
  // Launch ComfyUI startup script
  startComfyUI: (startScriptPath) => ipcRenderer.invoke('start-comfyui', startScriptPath),
  // Select ComfyUI startup script file
  selectComfyUIStartScript: (defaultPath) => ipcRenderer.invoke('select-comfyui-start-script', defaultPath)
});

