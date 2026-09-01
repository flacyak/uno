<#
.SYNOPSIS
    Registers .uno with Explorer, so double-clicking one opens uno.

.DESCRIPTION
    Everything is written under HKCU\Software\Classes, which is the per-user half
    of the class registry. It needs no administrator, it affects nobody else on
    the machine, and it takes precedence over a machine-wide association for this
    user. That mirrors what the Linux script does under ~/.local/share.

    Windows passes the file as an argument, which is what main.go already reads
    out of os.Args, so nothing in uno has to change for this to work.

.EXAMPLE
    .\associate.ps1 -Exe C:\Tools\uno.exe
    .\associate.ps1 -Action uninstall
#>
[CmdletBinding()]
param(
    [ValidateSet('install', 'uninstall')]
    [string] $Action = 'install',

    [string] $Exe
)

$ErrorActionPreference = 'Stop'

$ProgId  = 'uno.workspace'
$Ext     = '.uno'
$Mime    = 'application/vnd.uno.workspace+zip'
$Classes = 'HKCU:\Software\Classes'

# Refresh tells Explorer that the association table changed. Without it the new
# icon and the new verb only appear after a sign-out, which looks exactly like
# the registration having failed.
function Refresh {
    Add-Type -Namespace Shell -Name Notify -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("shell32.dll")]
public static extern void SHChangeNotify(int eventId, uint flags, System.IntPtr a, System.IntPtr b);
'@
    # SHCNE_ASSOCCHANGED, SHCNF_IDLIST
    [Shell.Notify]::SHChangeNotify(0x08000000, 0, [System.IntPtr]::Zero, [System.IntPtr]::Zero)
}

function Install {
    if (-not $Exe) {
        $Exe = Join-Path $env:LOCALAPPDATA 'Programs\uno\uno.exe'
        $root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
        New-Item -ItemType Directory -Force -Path (Split-Path $Exe) | Out-Null
        Write-Host "building $Exe"
        Push-Location $root
        try { & go build -o $Exe . } finally { Pop-Location }
    }

    $Exe = (Resolve-Path $Exe).Path
    if (-not (Test-Path $Exe)) { throw "$Exe does not exist" }

    New-Item -Force -Path "$Classes\$Ext" -Value $ProgId | Out-Null
    New-ItemProperty -Force -Path "$Classes\$Ext" -Name 'Content Type' -Value $Mime | Out-Null
    New-ItemProperty -Force -Path "$Classes\$Ext" -Name 'PerceivedType' -Value 'document' | Out-Null

    New-Item -Force -Path "$Classes\$ProgId" -Value 'uno workspace' | Out-Null

    # "%1" stays quoted: a path with a space in it is one argument, and a person
    # keeping their work in Documents will have one.
    New-Item -Force -Path "$Classes\$ProgId\shell\open\command" -Value """$Exe"" ""%1""" | Out-Null
    New-Item -Force -Path "$Classes\$ProgId\DefaultIcon" -Value """$Exe"",0" | Out-Null

    Refresh

    Write-Host ''
    Write-Host 'installed:'
    Write-Host "  $Exe"
    Write-Host "  $Classes\$Ext -> $ProgId"
    Verify
}

function Uninstall {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "$Classes\$ProgId"
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "$Classes\$Ext"
    Refresh
    Write-Host 'removed the .uno association; the binary was left alone'
}

# Verify reads the registry back rather than trusting the writes above.
function Verify {
    $progId  = (Get-Item "$Classes\$Ext" -ErrorAction SilentlyContinue).GetValue('')
    $command = (Get-Item "$Classes\$ProgId\shell\open\command" -ErrorAction SilentlyContinue).GetValue('')

    Write-Host "  .uno is:               $(if ($progId) { $progId } else { 'unregistered' })"
    Write-Host "  opened by:             $(if ($command) { $command } else { 'nothing' })"

    if ($progId -ne $ProgId) { throw ".uno is not registered to $ProgId" }
    if (-not $command)       { throw "$ProgId has no open command" }
}

switch ($Action) {
    'install'   { Install }
    'uninstall' { Uninstall }
}
