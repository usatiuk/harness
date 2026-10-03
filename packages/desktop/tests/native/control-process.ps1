param([int]$TargetProcess, [int]$OwnerProcess, [ValidateSet('suspend', 'resume')][string]$Action)
$ErrorActionPreference = 'Stop'
$entry = Get-CimInstance Win32_Process -Filter "ProcessId = $TargetProcess"
if (-not $entry -or $entry.ParentProcessId -ne $OwnerProcess -or $entry.Name -ne 'node.exe') { throw 'Target is not the owned test server' }
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
