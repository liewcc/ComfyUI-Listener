# Enable TLS 1.2/1.3 for download connections
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13

$workDir = Get-Location

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "  Setting up Independent Portable Python & Git" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

# 1. Download and Extract Python Embeddable
$pythonDir = Join-Path $workDir ".venv"
$pythonZip = Join-Path $workDir "python-embed.zip"
$pythonUrl = "https://www.python.org/ftp/python/3.10.11/python-3.10.11-embed-amd64.zip"

if (-not (Test-Path $pythonDir)) {
    Write-Host "1. Downloading Python 3.10.11 Embeddable..." -ForegroundColor Yellow
    try {
        Invoke-WebRequest -Uri $pythonUrl -OutFile $pythonZip -UserAgent "Mozilla/5.0" -UseBasicParsing
        Write-Host "Extracting Python to '.venv'..." -ForegroundColor Yellow
        New-Item -ItemType Directory -Path $pythonDir -Force | Out-Null
        Expand-Archive -Path $pythonZip -DestinationPath $pythonDir -Force
        Remove-Item $pythonZip -Force
        Write-Host "Python downloaded and extracted successfully." -ForegroundColor Green
    } catch {
        Write-Error "[ERROR] Failed to download or extract Python. Detail: $_"
        Read-Host "Press Enter to exit"
        exit 1
    }
} else {
    Write-Host "1. Portable Python (.venv) folder already exists. Skipping download." -ForegroundColor Green
}

# 2. Configure Python path (uncomment 'import site')
Write-Host "`n2. Configuring Python path variables..." -ForegroundColor Yellow
$pthFiles = Get-ChildItem -Path $pythonDir -Filter "*._pth"
if ($pthFiles.Count -gt 0) {
    foreach ($pthFile in $pthFiles) {
        $content = Get-Content -Path $pthFile.FullName
        $newContent = @()
        $updated = $false
        foreach ($line in $content) {
            if ($line.Trim() -eq "#import site") {
                $newContent += "import site"
                $updated = $true
            } else {
                $newContent += $line
            }
        }
        # In case 'import site' wasn't there at all
        if (-not ($content -contains "import site") -and -not $updated) {
            $newContent += "import site"
        }
        Set-Content -Path $pthFile.FullName -Value $newContent
        Write-Host "Configured file: $($pthFile.Name)" -ForegroundColor Green
    }
} else {
    Write-Warning "Could not find any ._pth file in .venv directory."
}

# 3. Install Pip inside .venv
$pipTest = & (Join-Path $pythonDir "python.exe") -m pip --version 2>&1
if ($LASTEXITCODE -ne 0 -or $pipTest -match "No module named") {
    Write-Host "`n3. Installing Pip inside portable Python..." -ForegroundColor Yellow
    $getPipUrl = "https://bootstrap.pypa.io/get-pip.py"
    $getPipScript = Join-Path $workDir "get-pip.py"
    try {
        Invoke-WebRequest -Uri $getPipUrl -OutFile $getPipScript -UserAgent "Mozilla/5.0" -UseBasicParsing
        & (Join-Path $pythonDir "python.exe") $getPipScript --no-warn-script-location
        Remove-Item $getPipScript -Force
        Write-Host "Pip installed successfully." -ForegroundColor Green
    } catch {
        Write-Error "[ERROR] Failed to download or install Pip. Detail: $_"
        Read-Host "Press Enter to exit"
        exit 1
    }
} else {
    Write-Host "`n3. Pip is already installed inside portable Python." -ForegroundColor Green
}

# 4. Download and Extract MinGit (Portable Git)
$gitDir = Join-Path $workDir "git"
$gitZip = Join-Path $workDir "git.zip"
$gitUrl = "https://github.com/git-for-windows/git/releases/download/v2.44.0.windows.1/MinGit-2.44.0-64-bit.zip"

if (-not (Test-Path $gitDir)) {
    Write-Host "`n4. Downloading Portable Git (MinGit)..." -ForegroundColor Yellow
    try {
        Invoke-WebRequest -Uri $gitUrl -OutFile $gitZip -UserAgent "Mozilla/5.0" -UseBasicParsing
        Write-Host "Extracting Git to 'git'..." -ForegroundColor Yellow
        New-Item -ItemType Directory -Path $gitDir -Force | Out-Null
        Expand-Archive -Path $gitZip -DestinationPath $gitDir -Force
        Remove-Item $gitZip -Force
        Write-Host "Portable Git downloaded and extracted successfully." -ForegroundColor Green
    } catch {
        Write-Error "[ERROR] Failed to download or extract Portable Git. Detail: $_"
        Read-Host "Press Enter to exit"
        exit 1
    }
} else {
    Write-Host "`n4. Portable Git folder already exists. Skipping download." -ForegroundColor Green
}

# 5. Install Python dependencies
if (Test-Path "requirements.txt") {
    Write-Host "`n5. Installing dependencies from requirements.txt..." -ForegroundColor Yellow
    
    # Configure PATH temporarily so python build/pip tools can call our local Git if needed
    $localGitCmd = Join-Path $gitDir "cmd"
    $env:PATH = "$localGitCmd;" + $env:PATH
    
    & (Join-Path $pythonDir "python.exe") -m pip install -r requirements.txt
    if ($LASTEXITCODE -ne 0) {
        Write-Error "[ERROR] Dependency installation failed."
        Read-Host "Press Enter to exit"
        exit 1
    }
    Write-Host "Dependencies installed successfully." -ForegroundColor Green
} else {
    Write-Warning "requirements.txt not found. Skipping dependency installation."
}

Write-Host "`n====================================================" -ForegroundColor Cyan
Write-Host "  Setup Complete! Portable environment is ready." -ForegroundColor Cyan
Write-Host "  You can run your project using: .\run.ps1" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan
Read-Host "Press Enter to exit"
