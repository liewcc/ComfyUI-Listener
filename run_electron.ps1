$workDir = Get-Location

# Configure PATH temporarily so portable Node and npm can be found
$nodeDir = Join-Path $workDir ".node_venv"
$npmPrefix = Join-Path $nodeDir "npm_global"

if (-not (Test-Path $nodeDir)) {
    Write-Error "Portable Node.js environment not found. Please double-click 'setup_node.bat' first to install Node.js and Electron."
    Read-Host "Press Enter to exit"
    exit 1
}

# Update PATH for this session
$env:PATH = "$nodeDir;$npmPrefix;" + $env:PATH

# Also add Python and Git paths if they exist, so the Electron app can spawn them if needed
$pythonDir = Join-Path $workDir ".venv"
$gitDir = Join-Path $workDir "git\cmd"

if (Test-Path $pythonDir) {
    $env:PATH = "$pythonDir;" + $env:PATH
}
if (Test-Path $gitDir) {
    $env:PATH = "$gitDir;" + $env:PATH
}

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "   Starting ComfyUI Listener Electron UI " -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "Press Ctrl+C in this terminal to terminate" -ForegroundColor Yellow

# Launch Electron using local npm start
& "$nodeDir\npm.cmd" start

if ($LASTEXITCODE -ne 0) {
    Write-Warning "`nApplication exited with code $LASTEXITCODE."
    Read-Host "Press Enter to close"
}
