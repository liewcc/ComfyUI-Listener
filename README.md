# ComfyUI Listener (Portable & Independent Environment Version)

An Electron-based desktop application designed for ComfyUI API control and Face Fusion automation. This repository features a **completely portable and independent** python and node.js runtime environment. It **does not require** pre-installed Python, Node.js, or Git on the host system. All necessary environments are automatically downloaded, configured, and isolated within the project directory upon first setup.

---

## 📁 Directory Structure

```text
ComfyUI Listener/
├── .node_venv/           # Auto-downloaded portable Node.js runtime (v20.11.1)
├── .venv/                # Auto-downloaded portable Python runtime (v3.10.11)
├── git/                  # Auto-downloaded portable Git runtime (MinGit)
├── src/                  # Electron application source code (HTML, CSS, JS)
│   ├── main.js           # Electron main process
│   ├── preload.js        # Electron preload script
│   ├── renderer.js       # Electron renderer process (UI & automation logic)
│   ├── index.html        # Main user interface
│   └── style.css         # Modern, high-performance UI stylesheet
├── workflow/             # Tracked reference ComfyUI workflow JSON templates
├── requirements.txt      # Python dependencies list
├── package.json          # Node.js dependencies list (Electron, etc.)
├── setup.bat / .ps1      # One-click Python & Git setup scripts (CMD / PowerShell)
├── setup_node.bat / .ps1 # One-click Node.js & Electron setup scripts (CMD / PowerShell)
├── run.bat / .ps1        # Run script for Python CLI mode (CMD / PowerShell)
├── run_electron.bat / .ps1 # Run script for the Electron GUI desktop app (CMD / PowerShell)
└── .gitignore            # Git exclusion patterns
```

---

## 🚀 Quick Start

To set up and run the application, follow these two setup steps to configure the isolated runtimes:

### 1. Initialize Python & Git Environment
Double-click and run **`setup.bat`** (or execute `.\setup.ps1` in a PowerShell terminal).
This script automates:
* **Portable Python**: Downloads the Python 3.10.11 Windows portable package from python.org and extracts it into `.venv/`.
* **Path & Loader Config**: Modifies the Python path files so that local dependencies can be loaded properly.
* **Pip Installer**: Downloads and installs a local `pip` package manager inside the sandbox.
* **Portable Git**: Downloads the lightweight portable Git (`MinGit`) from GitHub and extracts it to the `git/` folder.
* **Python Dependencies**: Uses the local sandbox pip to install all packages specified in `requirements.txt`.

### 2. Initialize Node.js & Electron Environment
Double-click and run **`setup_node.bat`** (or execute `.\setup_node.ps1` in PowerShell).
This script automates:
* **Portable Node.js**: Downloads Node.js v20.11.1 Windows portable binary zip and extracts it to `.node_venv/`.
* **Sandbox Configuration**: Sets the local `npm` prefix and cache directories inside `.node_venv/npm_global` to avoid interfering with global system configurations.
* **App Dependencies**: Automatically installs Electron and all node modules declared in `package.json`.

---

## 💻 Running the Application

### Launching the Electron Desktop GUI
Double-click **`run_electron.bat`** (or execute `.\run_electron.ps1` in PowerShell).
* This injects the sandbox paths (`.node_venv`, `git`, and `.venv`) temporarily into the session's environment variable `PATH`.
* Even if your Windows host has no global Git, Node.js, or Python, the desktop GUI will launch and run seamlessly.
* This interface lets you control ComfyUI, configure workflow templates, load API/WebUI parameters, monitor outputs, and automate Face Fusion face-swapping steps.

### Running Python CLI Mode (Optional)
Double-click **`run.bat`** (or execute `.\run.ps1` in PowerShell).
* Runs the python entrypoint `main.py` using the isolated sandbox `.venv` environment.
* Supports arguments forwarding, e.g.: `.\run.bat --arg1 value1`.

---

## 🛠️ Advanced Operations

### Managing Python Dependencies
1. Open `requirements.txt`.
2. Add your required package names (with optional version tags), e.g.:
   ```text
   requests>=2.31.0
   websocket-client>=1.6.0
   ```
3. Re-run `setup.bat` to automatically install the new dependencies.

### Executing Commands in the Sandbox Terminal
If you need to manually invoke the isolated runtime command-line for testing or debugging:
* **Run commands using isolated Python**:
  ```cmd
  .venv\python.exe -m <Command>
  ```
* **Install a package directly using isolated Pip**:
  ```cmd
  .venv\python.exe -m pip install <PackageName>
  ```
