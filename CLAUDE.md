# CLAUDE.md

## Build & Run Commands
- **Run the Electron Application**: `npm start`
- **Kill Running App**: `kill_app.bat` or `powershell ./kill_app.ps1`
- **Initial Setup**: Run `./setup.bat` or `./setup.ps1` to configure Python/Node virtual environments and dependencies.
- **Start Helper**: `./run.bat` or `./run.ps1` to launch the application.

## Key Codebase Findings & Guidelines

### 1. Electron Dialog Path Memory Isolation
In Electron, if `dialog.showOpenDialog` or `dialog.showSaveDialog` is not given a valid `defaultPath`, Electron falls back to the operating system's process-wide "last opened folder". This causes dialogs from different features (such as Prompt Editor's workflow import and Input Images' file select) to pollute each other's path memory.

To prevent directory cross-pollution:
- **Always resolve file paths to directory paths**: Use the helper `resolveDefaultPath` in [src/main.js](file:///d:/AI/ComfyUI%20Listener/src/main.js). If a saved file path is deleted or moved, check and open its parent directory (`path.dirname(defaultPath)`) instead of letting the dialog fail and fall back to the process-wide history.
- **Provide distinct default fallback paths**: For newly opened/cleared dialogs, provide a distinct system path (e.g. `app.getPath('pictures')`, `app.getPath('documents')`, etc.) using `safeGetPath` rather than letting them default to the same empty string (which defaults to Electron's shared process-wide directory).
- **Avoid `.asar` paths in file dialogs**: Do not pass paths located inside `app.getAppPath()` (which resolves to `app.asar` when packaged) as a default path to system dialogs, since native OS file managers cannot resolve virtual paths.
