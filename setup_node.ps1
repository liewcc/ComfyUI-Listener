# Enable TLS 1.2/1.3 for download connections
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13

$workDir = Get-Location

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "  Setting up Independent Portable Node.js & Electron" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

# 1. Download and Extract Node.js Portable
$nodeDir = Join-Path $workDir ".node_venv"
$nodeZip = Join-Path $workDir "node-portable.zip"
$nodeUrl = "https://nodejs.org/dist/v20.11.1/node-v20.11.1-win-x64.zip"

if (-not (Test-Path $nodeDir)) {
    Write-Host "1. Downloading Node.js v20.11.1 Portable..." -ForegroundColor Yellow
    try {
        Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeZip -UserAgent "Mozilla/5.0" -UseBasicParsing
        Write-Host "Extracting Node.js..." -ForegroundColor Yellow
        
        $tempExtractDir = Join-Path $workDir ".node_temp"
        New-Item -ItemType Directory -Path $tempExtractDir -Force | Out-Null
        Expand-Archive -Path $nodeZip -DestinationPath $tempExtractDir -Force
        
        # Move the inner folder to .node_venv
        $innerFolder = Get-ChildItem -Path $tempExtractDir -Directory | Select-Object -First 1
        if ($innerFolder) {
            Move-Item -Path $innerFolder.FullName -Destination $nodeDir -Force
        } else {
            throw "Could not find extracted node folder"
        }
        
        # Cleanup
        Remove-Item $nodeZip -Force
        Remove-Item $tempExtractDir -Recurse -Force
        
        Write-Host "Node.js downloaded and extracted successfully to .node_venv" -ForegroundColor Green
    } catch {
        Write-Error "[ERROR] Failed to download or extract Node.js. Detail: $_"
        # Cleanup zip and temp dir if they exist
        if (Test-Path $nodeZip) { Remove-Item $nodeZip -Force }
        if (Test-Path $tempExtractDir) { Remove-Item $tempExtractDir -Recurse -Force }
        Read-Host "Press Enter to exit"
        exit 1
    }
} else {
    Write-Host "1. Portable Node.js (.node_venv) folder already exists. Skipping download." -ForegroundColor Green
}

# 2. Add portable Node to PATH for this process, configure npm cache and environment
$env:PATH = "$nodeDir;" + $env:PATH

# Setup local npm cache and prefix inside .node_venv to keep user global setup clean
Write-Host "`n2. Configuring local npm settings..." -ForegroundColor Yellow
try {
    # Set prefix and cache relative to project to prevent cluttering standard appdata
    $npmPrefix = Join-Path $nodeDir "npm_global"
    $npmCache = Join-Path $nodeDir "npm_cache"
    New-Item -ItemType Directory -Path $npmPrefix -Force | Out-Null
    New-Item -ItemType Directory -Path $npmCache -Force | Out-Null
    
    # We execute npm with the temporary path
    & "$nodeDir\npm.cmd" config set prefix "$npmPrefix" --global
    & "$nodeDir\npm.cmd" config set cache "$npmCache" --global
    
    # Add npm prefix to path temporarily for dependency check
    $env:PATH = "$npmPrefix;" + $env:PATH
    
    $nodeVer = & node -v
    $npmVer = & npm -v
    Write-Host "Node Version : $nodeVer" -ForegroundColor Green
    Write-Host "NPM Version  : $npmVer" -ForegroundColor Green
} catch {
    Write-Error "[ERROR] Failed to configure npm. Detail: $_"
    Read-Host "Press Enter to exit"
    exit 1
}

# 3. Install NPM dependencies (including Electron)
if (Test-Path "package.json") {
    Write-Host "`n3. Installing dependencies from package.json..." -ForegroundColor Yellow
    
    # Configure PATH temporarily so python/git/node can be used if needed
    $localGitCmd = Join-Path $workDir "git\cmd"
    if (Test-Path $localGitCmd) {
        $env:PATH = "$localGitCmd;" + $env:PATH
    }
    
    # Run npm install
    & "$nodeDir\npm.cmd" install
    if ($LASTEXITCODE -ne 0) {
        Write-Error "[ERROR] npm installation failed."
        Read-Host "Press Enter to exit"
        exit 1
    }
    Write-Host "NPM dependencies installed successfully." -ForegroundColor Green
} else {
    Write-Warning "package.json not found. Skipping dependency installation."
}

Write-Host "`n====================================================" -ForegroundColor Cyan
Write-Host "  Setup Complete! Portable Electron env is ready." -ForegroundColor Cyan
Write-Host "  You can run your project using: .\run_electron.ps1" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan
Read-Host "Press Enter to exit"
