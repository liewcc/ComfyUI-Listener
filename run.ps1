$workDir = Get-Location
$pythonDir = Join-Path $workDir ".venv"
$gitDir = Join-Path $workDir "git"

# Check if environment is set up
if (-not (Test-Path $pythonDir) -or -not (Test-Path $gitDir)) {
    Write-Warning "Portable environment not found. Running setup first..."
    & .\setup.ps1
    if ($LASTEXITCODE -ne 0) {
        Write-Error "[ERROR] Setup failed. Cannot run the script."
        Read-Host "Press Enter to exit"
        exit 1
    }
}

Write-Host "Configuring environment PATH..." -ForegroundColor Yellow
# Prepend local Git and Python paths to environment PATH
$localGitCmd = Join-Path $gitDir "cmd"
$localPythonScripts = Join-Path $pythonDir "Scripts"

# Save original path
$originalPath = $env:PATH
# Prepend our portable tools
$env:PATH = "$pythonDir;$localPythonScripts;$localGitCmd;" + $env:PATH

Write-Host "Running main.py inside portable environment..." -ForegroundColor Green
& (Join-Path $pythonDir "python.exe") main.py $args

$exitCode = $LASTEXITCODE

# Restore original path
$env:PATH = $originalPath

if ($exitCode -ne 0) {
    Write-Error "[ERROR] Script exited with errors."
    Read-Host "Press Enter to exit"
    exit $exitCode
}
