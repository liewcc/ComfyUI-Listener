# ComfyUI Listener (便携独立环境版)

这是一个为 ComfyUI 监听器配置的**全便携、全独立**的 Python 与 Git 运行环境。该项目**不依赖**用户本地电脑上是否安装了 Python 或 Git，所有运行所需环境均会在首次运行时自动下载并配置在项目目录内的 `.venv` 文件夹中。

## 📁 目录结构

```text
ComfyUI Listener/
├── .venv/                # 自动下载的独立便携式 Python 运行环境 (Python 3.10.11)
├── git/                  # 自动下载的独立便携式 Git 运行环境 (MinGit)
├── requirements.txt      # 依赖包配置文件
├── main.py               # 项目入口 Python 脚本
├── setup.bat / .ps1      # 一键环境配置脚本 (CMD / PowerShell)
├── run.bat / .ps1        # 一键运行脚本 (CMD / PowerShell)
└── .gitignore            # Git 忽略配置
```

---

## 🚀 快速使用

### 1. 一键初始化环境
双击运行 **`setup.bat`**（或者在 PowerShell 中执行 `.\setup.ps1`）。
该脚本会自动执行以下步骤：
* **下载独立 Python**：从 python.org 官方下载 Python 3.10.11 的 Windows 便携式免安装包（Zip），并解压到 `.venv/` 文件夹下。
* **配置导入路径**：修改 `.venv` 的路径文件，使其可以加载第三方模块。
* **安装独立 Pip**：自动下载并安装独立版本的 Pip 包管理器。
* **下载独立 Git**：从 Github 官方下载轻量便携式 Git (`MinGit`)，并解压到 `git/` 文件夹下。
* **安装第三方依赖**：使用刚刚配置完毕的本地 Python 和 Pip，自动安装 `requirements.txt` 中配置的所有第三方包。

### 2. 运行脚本
双击运行 **`run.bat`**（或者在 PowerShell 中执行 `.\run.ps1`）。
* 该脚本运行后，会临时将本地的 `.venv` 以及 `git/cmd` 路径注入到环境变量 `PATH` 中。
* 这样即使您的电脑没装过 Git 或 Python，您的 Python 脚本或相关第三方库（如 GitPython 等）在运行期间依然可以完美调用本地的 `git` 命令和 `python` 可执行程序。
* 支持传参：在命令行中，您可以像这样传参：`.\run.bat --arg1 value1`。

---

## 🛠️ 进阶操作

### 添加/修改第三方依赖包
1. 打开 `requirements.txt`。
2. 在新行中输入您需要的库名称（可带版本号），例如：
   ```text
   requests>=2.31.0
   websocket-client>=1.6.0
   ```
3. 重新双击运行 `setup.bat` 即可自动补充安装新的依赖包。

### 手动在独立环境终端中执行命令
如果您需要使用本地安装的独立 pip、python 进行一些手动调试，可以手动在项目根目录下打开命令行/终端，执行以下操作：

* **使用独立 Python 执行命令**：
  ```cmd
  .venv\python.exe -m <Command>
  ```
* **使用独立 Pip 安装单个库**：
  ```cmd
  .venv\python.exe -m pip install <PackageName>
  ```
