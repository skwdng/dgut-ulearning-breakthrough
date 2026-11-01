<#
    clean-c-drive-2.ps1  --  remaining C: cleanup that needs Administrator.

    RUN ELEVATED:
      Start menu -> type "powershell" -> right-click -> Run as administrator
      then:  cd D:\skwdngapp ; .\clean-c-drive-2.ps1

    MEASURED STATE WHEN WRITTEN (2026-10-28)
    ----------------------------------------
    C: 22.88 GB free of 249.61 GB.
        C:\pagefile.sys        20.00 GB   <- recreated by Windows; moved before but reverted
        C:\Windows\WinSxS      20.75 GB   <- component store, shrinks with DISM
        C:\Windows\Installer    2.19 GB   <- DO NOT delete manually
        C:\ProgramData\Ubisoft  2.81 GB

    NOTE ON THE PAGEFILE
    --------------------
    The registry value is currently "?:\pagefile.sys", which means Windows is
    auto-managing the paging file on the system drive (C:). That is why the
    20 GB file came back. This script pins it to D: instead.

    WHY IT REVERTED LAST TIME: "automatically manage paging file size for all
    drives" was re-enabled (Windows update / PC Manager / restore). After this
    script runs, verify that checkbox is still unchecked, or it will come back.
#>

$ErrorActionPreference = 'Continue'

function FreeB {
    $l = (cmd /c "dir C:\ /-c" 2>&1 | Select-Object -Last 1)
    $n = [regex]::Matches([string]$l, '\d[\d,]*')
    if ($n.Count) { return [int64]($n[$n.Count - 1].Value -replace ',', '') }
    return 0
}

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$pr = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'ERROR: run this in an Administrator PowerShell.' -ForegroundColor Red
    Write-Host 'Start menu -> type powershell -> right-click -> Run as administrator.' -ForegroundColor Red
    exit 1
}

function Show {
    param([string]$T)
    $b = FreeB
    Write-Host ('{0,-22} C: free = {1:N2} GB' -f $T, ($b / 1GB))
    return $b
}

function Ask {
    param([string]$Title, [string]$Body)
    Write-Host ''
    Write-Host ('=' * 68) -ForegroundColor Cyan
    Write-Host $Title -ForegroundColor Cyan
    Write-Host ('=' * 68) -ForegroundColor Cyan
    Write-Host $Body
    return ((Read-Host 'Proceed? [Y/N]') -match '^[Yy]')
}

# ------------------------------------------------------------- 1. pagefile
if (Ask '1. Move the 20 GB paging file from C: to D:' @'
Windows is currently auto-managing the paging file on C: (20 GB file).
This pins it to D: (87 GB free) and removes it from C:.

Takes effect after REBOOT. D: should be a local disk (SSD or HDD both OK;
SSD preferred for performance).
'@) {

    $mm  = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management'
    $old = (Get-ItemProperty -Path $mm -Name PagingFiles -ErrorAction SilentlyContinue).PagingFiles
    Write-Host ('  before: ' + ($old -join ' | '))

    # Turn OFF "automatically manage paging file size for all drives" first.
    $cs = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management'
    try {
        Set-ItemProperty -Path $cs -Name 'PagingFiles' -Value @('D:\pagefile.sys 0 0') -Type MultiString -ErrorAction Stop
        Write-Host '  PagingFiles set to: D:\pagefile.sys 0 0  (system managed on D:)'
    } catch {
        Write-Host ('  FAILED: ' + $_.Exception.Message) -ForegroundColor Red
    }

    try {
        $sys = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager'
        $state = Get-ItemProperty -Path $sys -Name 'DisablePagingExecutive' -ErrorAction SilentlyContinue
        Write-Host ('  DisablePagingExecutive = ' + $state.DisablePagingExecutive)
    } catch { }

    Write-Host ''
    Write-Host '  IMPORTANT: also uncheck "Automatically manage paging file size' -ForegroundColor Yellow
    Write-Host '  for all drives" so Windows does not revert this:' -ForegroundColor Yellow
    Write-Host '    Win+R -> sysdm.cpl -> Advanced -> Performance Settings' -ForegroundColor Yellow
    Write-Host '    -> Advanced -> Virtual memory Change' -ForegroundColor Yellow
    Write-Host '    -> uncheck the box at the top -> OK -> REBOOT' -ForegroundColor Yellow
}

# --------------------------------------------------------- 2. WinSxS trim
if (Ask '2. Shrink the Windows component store (WinSxS, 20.75 GB)' @'
Runs: DISM /Online /Cleanup-Image /StartComponentCleanup /ResetBase
This removes superseded Windows updates. Typically frees 1-5 GB.
Side effect: installed updates can no longer be uninstalled. Windows still
updates normally. Can take 10-30 minutes.
'@) {
    Write-Host '  running DISM (this takes a while, do not close the window)...'
    & dism.exe /Online /Cleanup-Image /StartComponentCleanup /ResetBase
    Write-Host ('  DISM exit code: ' + $LASTEXITCODE)
}

# ------------------------------------------- 3. system temp + update cache
if (Ask '3. Clear Windows temp, update cache, delivery optimization' @'
Clears:
  C:\Windows\Temp
  C:\Windows\SoftwareDistribution\Download
  C:\Windows\ServiceProfiles\NetworkService\AppData\Local\Microsoft\Windows\DeliveryOptimization
  C:\Windows\Prefetch
Safe: all regenerable.
'@) {
    $before = Show 'before'
    foreach ($p in @(
        'C:\Windows\Temp',
        'C:\Windows\SoftwareDistribution\Download',
        'C:\Windows\ServiceProfiles\NetworkService\AppData\Local\Microsoft\Windows\DeliveryOptimization',
        'C:\Windows\Prefetch'
    )) {
        if (-not (Test-Path -LiteralPath $p)) { continue }
        $freed = 0
        Get-ChildItem -LiteralPath $p -Force -ErrorAction SilentlyContinue | ForEach-Object {
            $i = $_
            $s = if ($i.PSIsContainer) {
                $x = (Get-ChildItem -LiteralPath $i.FullName -Recurse -File -Force -ErrorAction SilentlyContinue |
                      Measure-Object -Property Length -Sum).Sum
                if ($null -eq $x) { 0 } else { $x }
            } else { $i.Length }
            try { Remove-Item -LiteralPath $i.FullName -Recurse -Force -ErrorAction Stop; $freed += $s } catch { }
        }
        Write-Host ('  {0,8:N0} MB  {1}' -f ($freed / 1MB), $p)
    }
    $after = Show 'after'
    Write-Host ('  freed ' + ('{0:N0} MB' -f (($after - $before) / 1MB))) -ForegroundColor Green
}

Write-Host ''
Write-Host ('=' * 68) -ForegroundColor Cyan
Show 'FINAL'
Write-Host 'Reboot to release the paging file space.' -ForegroundColor Yellow
