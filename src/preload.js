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
  selectImageFile: () => ipcRenderer.invoke('select-image-file'),
  // Upload image to ComfyUI server
  uploadImageToComfyUI: (options) => ipcRenderer.invoke('upload-image-to-comfyui', options),
  // Select output folder on disk
  selectOutputFolder: () => ipcRenderer.invoke('select-output-folder'),
  // Save generated image to local output folder
  saveImageToFolder: (options) => ipcRenderer.invoke('save-image-to-folder', options),
  // Check if a file exists in the filesystem
  checkFileExists: (options) => ipcRenderer.invoke('check-file-exists', options),
  // Open path (file or directory) in explorer
  openPath: (options) => ipcRenderer.invoke('open-path', options),
  // Write debug log to disk
  logDebug: (options) => ipcRenderer.invoke('log-debug', options)
});
