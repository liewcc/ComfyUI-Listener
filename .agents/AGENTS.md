# AGENTS.md

## Electron Dialog Path Memory Isolation Guidelines

When working with Electron native file/folder selection dialogs (e.g., `dialog.showOpenDialog` or `dialog.showSaveDialog` in [src/main.js](file:///d:/AI/ComfyUI%20Listener/src/main.js)), always adhere to the following rules to prevent cross-dialog path memory contamination:

1. **Never pass unvalidated file paths**: If a saved file path (like `comfyui_last_import_prompt_path`) is deleted, moved, or renamed, passing it directly to `options.defaultPath` will fail. Electron will then fall back to the OS process-wide last accessed folder, leading to path leakage across unrelated features (e.g., Prompt Editor and Input Images).
2. **Resolve to parent directory**: If a specific file path is used, check if the file exists using `fs.existsSync`. If it does not exist, resolve to its parent directory (`path.dirname(defaultPath)`) and use it if it exists.
3. **Use the `resolveDefaultPath` helper**: Always route path resolutions through the [resolveDefaultPath](file:///d:/AI/ComfyUI%20Listener/src/main.js#L375) helper.
4. **Define distinct fallback paths**: For newly opened or cleared dialogs, provide a distinct physical system folder (using the [safeGetPath](file:///d:/AI/ComfyUI%20Listener/src/main.js#L365) helper to query `Pictures`, `Documents`, `Videos`, or `Home` paths) rather than letting dialogs default to the same empty state (which triggers Electron's shared process-wide fallback).
5. **Avoid `.asar` virtual paths**: Never pass paths resolved via `app.getAppPath()` (which resolves to virtual `app.asar` when packaged) directly to native OS dialogs, as they cannot resolve virtual file packages and will treat them as invalid.
