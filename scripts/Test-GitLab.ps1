[CmdletBinding()]
param(
    [switch]$Integration,
    [switch]$GitLabOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-CheckedStep {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][scriptblock]$Action
    )
    Write-Host ""
    Write-Host "== $Name =="
    & $Action
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $repoRoot
try {
    Invoke-CheckedStep 'Repository state' {
        git status --short --branch
        if ($LASTEXITCODE -ne 0) { throw 'git status failed.' }
    }

    Invoke-CheckedStep 'GitLab CLI authentication' {
        glab auth status
        if ($LASTEXITCODE -ne 0) { throw 'glab authentication failed.' }
    }

    $gitSsh = 'C:\Program Files\Git\usr\bin\ssh.exe'
    if (-not (Test-Path $gitSsh)) {
        $gitSsh = (Get-Command ssh.exe -ErrorAction Stop).Source
    }

    Invoke-CheckedStep 'GitLab SSH account authentication' {
        & $gitSsh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -T git@gitlab.com
        if ($LASTEXITCODE -ne 0) { throw "GitLab SSH authentication failed with exit code $LASTEXITCODE." }
    }

    $remoteUrl = git remote get-url gitlab 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $remoteUrl) {
        $remoteUrl = git remote get-url origin
    }
    if ($LASTEXITCODE -ne 0 -or -not $remoteUrl) {
        throw 'Could not resolve a Git remote.'
    }

    $projectPath = $null
    if ($remoteUrl -match '^https?://gitlab\.com/(.+?)(?:\.git)?$') {
        $projectPath = $Matches[1]
    } elseif ($remoteUrl -match '^git@gitlab\.com:(.+?)(?:\.git)?$') {
        $projectPath = $Matches[1]
    }
    if (-not $projectPath) {
        throw "Remote is not a supported gitlab.com URL: $remoteUrl"
    }

    Invoke-CheckedStep 'GitLab repository access' {
        $previousSshCommand = $env:GIT_SSH_COMMAND
        try {
            $env:GIT_SSH_COMMAND = '"' + $gitSsh.Replace('\', '/') + '" -o BatchMode=yes -o StrictHostKeyChecking=accept-new'
            git ls-remote "git@gitlab.com:$projectPath.git" HEAD
            if ($LASTEXITCODE -ne 0) { throw 'GitLab repository SSH access failed.' }
        } finally {
            $env:GIT_SSH_COMMAND = $previousSshCommand
        }
    }

    if (-not $GitLabOnly) {
        Invoke-CheckedStep 'Unit test suite' {
            npm test
            if ($LASTEXITCODE -ne 0) { throw 'Unit tests failed.' }
        }

        if ($Integration) {
            Invoke-CheckedStep 'Integration test suite' {
                npm run test:integration
                if ($LASTEXITCODE -ne 0) { throw 'Integration tests failed.' }
            }
        }
    }

    Write-Host ""
    Write-Host 'All requested GitLab checks passed.'
}
finally {
    Pop-Location
}
