param([int]$TargetProcess, [string]$ExpectedCommand, [ValidateSet('suspend', 'resume', 'crash')][string]$Action)
$ErrorActionPreference = 'Stop'
$entry = Get-CimInstance Win32_Process -Filter "ProcessId = $TargetProcess"
if (-not $entry -or $entry.Name -ne 'node.exe' -or $entry.CommandLine -cne $ExpectedCommand -or -not $ExpectedCommand.Contains('--background')) { throw 'Target is not the authenticated test server' }
if ($Action -eq 'crash') { Stop-Process -Id $TargetProcess -Force; exit 0 }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TestProcessControl {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int id);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr handle);
  [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr handle);
}
'@
$handle = [TestProcessControl]::OpenProcess(0x0800, $false, $TargetProcess)
if ($handle -eq [IntPtr]::Zero) { throw 'Cannot open owned test server' }
try {
  $result = if ($Action -eq 'suspend') { [TestProcessControl]::NtSuspendProcess($handle) } else { [TestProcessControl]::NtResumeProcess($handle) }
  if ($result -ne 0) { throw "Process control failed: $result" }
} finally { [void][TestProcessControl]::CloseHandle($handle) }
