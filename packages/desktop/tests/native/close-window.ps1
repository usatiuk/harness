param([int]$AppProcess, [string]$Evidence)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class NativeWindow {
    public delegate bool Callback(IntPtr window, IntPtr param);
    [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback, IntPtr param);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    public class Entry {
        public long Handle, Owner;
        public string Class;
        public bool Harness, Visible, Enabled;
    }
    public static Entry[] Owned(uint process) {
        var result = new List<Entry>();
        EnumWindows((window, param) => {
            uint pid;
            GetWindowThreadProcessId(window, out pid);
            if (pid != process) return true;
            var title = new StringBuilder(256);
            var kind = new StringBuilder(256);
            GetWindowText(window, title, title.Capacity);
            GetClassName(window, kind, kind.Capacity);
            result.Add(new Entry { Handle = window.ToInt64(), Owner = GetWindow(window, 4).ToInt64(),
                Class = kind.ToString(), Harness = title.ToString() == "Harness",
                Visible = IsWindowVisible(window), Enabled = IsWindowEnabled(window) });
            return true;
        }, IntPtr.Zero);
        return result.ToArray();
    }
}
'@
# Record only process-owned window structure, never arbitrary window titles.
$windows = [NativeWindow]::Owned($AppProcess)
$windows | ConvertTo-Json | Set-Content -LiteralPath $Evidence -Encoding utf8
$main = @($windows | Where-Object { $_.Harness -and $_.Owner -eq 0 })
if ($main.Count -ne 1) { throw 'Expected exactly one owned Harness window; see window evidence' }
if (-not $main[0].Enabled) { throw 'Owned Harness window is disabled; see window evidence' }
if (-not [NativeWindow]::PostMessage([IntPtr]$main[0].Handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) {
    throw 'Could not deliver close to owned Harness window'
}
