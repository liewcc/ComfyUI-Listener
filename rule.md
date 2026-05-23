# AI Agent Guidelines

As an AI agent working in this repository, you MUST strictly adhere to the following rules:

## 1. Version Control & GitHub Pushes
- **NEVER** stage, commit, or push any personal or temporary `.json` files, `.log` files, or portable environments (`.venv/`, `.node_venv/`, `node_modules/`, `git/`) to GitHub.
- **ALLOWED**: The `workflow/` directory containing the primary reference template `.json` files (e.g., `comfyUI workflow api.json`, `comfyUI workflow webui.json`) **MUST** be tracked and uploaded.
- **NEVER** stage, commit, or push any generated images (outputs), input images, local test datasets, or `.env` credential files to GitHub.
- **NEVER** stage, commit, or push the `kill_app` scripts (`kill_app.bat`, `kill_app.ps1`) or any local test scripts / scratch files to GitHub.
- **NEVER** stage, commit, or push the `browser_user_data/` or `browser_session_sandbox/` directories to GitHub, as they contain sensitive profile and session information.
- Always explicitly verify `git status` before committing. If untracked personal `.json`, `.log`, or sensitive directories are mistakenly staged or appear in changes, use `git restore --staged` or `.gitignore` mechanisms to exclude them.
- When tasked with pushing code updates, ONLY push the specific files that were purposefully modified for the current task. Do not execute a blanket `git commit -a` or `git add .` without reviewing the file list carefully.

 

## 2. Codebase & UI Language Rules
- **UI & Console Output Language:** All User Interface elements and console output logs (including CLI print statements, labels, buttons, toast messages, and placeholders) **MUST be written entirely in English**. No Chinese text should exist within the application's runtime UI/CLI outputs.
- **Code Comments & Docstrings:** All inline code comments, docstrings, and technical documentation within scripts MUST be in English to ensure universal maintainability.

## 3. Conversational Language (Agent-to-User)
- When talking and communicating with the user in the chat/chatbox interface, you must communicate primarily in **Chinese**. 
- It is highly encouraged to seamlessly **mix English terms within the Chinese conversation** when referencing technical terminology, variable names, file paths, or specific UI elements (e.g., "当你双击运行 `setup.bat` 时", "这个 `requirements.txt` 里的依赖版本有冲突"). This ensures technical clarity.

## 4. Code Writing & Structural Integrity
- **Structural Integrity & Atomic Edits:**
  - Before applying any `replace_file_content` or `multi_replace_file_content` calls, you MUST mentally parse the resulting AST (Abstract Syntax Tree).
  - **NEVER** leave unmatched parentheses `)`, brackets `]`, or braces `}`.
  - **NEVER** duplicate entire logic blocks or `elif` statements.
  - If a change is complex, prefer a single `write_to_file` of the entire function or file to guarantee structural correctness.
- **Aesthetics & Premium Design:**
  - Maintain the premium, state-of-the-art developer tools first aesthetic.
  - Avoid simple minimum viable products; build rich, robust, and beautifully structured code.
