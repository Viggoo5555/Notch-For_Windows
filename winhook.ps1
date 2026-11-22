param([switch]$Test, [switch]$Overflow, [string]$Bar = '')

# Watches the Windows key at the lowest keyboard level.
#
# The C# lives in hook/JarvisWinHook.cs, not in this file: the same source is
# compiled into notchhook.exe at build time, which is how the hook runs on a
# machine where PowerShell's Add-Type refuses to build it — and a failed Add-Type
# is exactly what left the type missing (TypeNotFound) and the key with Windows.
# This script is the fallback for a checkout, where no build step has run.
$source = Join-Path $PSScriptRoot 'hook/JarvisWinHook.cs'
if (-not (Test-Path $source)) { Write-Error "missing $source"; exit 3 }
Add-Type -ReferencedAssemblies @('UIAutomationClient', 'UIAutomationTypes', 'WindowsBase', 'System.Drawing', 'System.Management', 'System') -TypeDefinition (Get-Content -Raw -Encoding UTF8 -LiteralPath $source)

[JarvisWinHook]::AllowInjected = $Test.IsPresent

# One press of the tray chevron, for a bar whose keyboard hook is not running:
# there is nothing to watch, so the process is over as soon as it has pressed.
if ($Overflow.IsPresent)
{
    [JarvisWinHook]::OpenOverflow()
    exit 0
}

# Windows' own taskbar, put away or brought back without a hook running: the
# same call the helper makes, in a process that ends as soon as it has made it.
if ($Bar -ne '')
{
    $hide = 0
    if ($Bar -eq 'hide') { $hide = 1 }
    Write-Output ([JarvisWinHook]::ShellBar($hide))
    exit 0
}

exit [JarvisWinHook]::Run()
