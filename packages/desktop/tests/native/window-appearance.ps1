param([int]$TargetProcess, [string]$Screenshot, [ValidateSet('Inspect', 'Restore', 'Resize', 'Escape', 'Drag', 'Menu')][string]$Action = 'Inspect', [double]$ProbeX = -1, [double]$ProbeY = -1)
$ErrorActionPreference = 'Stop'
$process = Get-Process -Id $TargetProcess
if ($process.ProcessName -ne 'harness-desktop') { throw 'Expected the native test application' }
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class NativeAppearanceSnapshot {
  public delegate bool Callback(IntPtr window, IntPtr param);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback, IntPtr param);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr child);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
  public static IntPtr MainWindow(uint process) {
    IntPtr result = IntPtr.Zero;
    EnumWindows((window, param) => {
      uint owner; GetWindowThreadProcessId(window, out owner);
      if (owner != process || GetWindow(window, 4) != IntPtr.Zero) return true;
      var title = new StringBuilder(32); GetWindowText(window, title, title.Capacity);
      if (title.ToString() == "Harness") {
        if (result != IntPtr.Zero) throw new Exception("Multiple owned Harness windows");
        result = window;
      }
      return true;
    }, IntPtr.Zero);
    if (result == IntPtr.Zero) throw new Exception("Missing owned Harness window");
    return result;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct GuiInfo { public int Size, Flags; public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret; public Rect CaretRect; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr window, int index);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window, ref Point point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint thread, ref GuiInfo info);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
  [DllImport("dwmapi.dll")] public static extern int DwmFlush();
}
'@
$window = [NativeAppearanceSnapshot]::MainWindow($TargetProcess)
if ($Action -eq 'Restore') { [void][NativeAppearanceSnapshot]::ShowWindow($window, 9) }
if ($Action -eq 'Escape') { [void][NativeAppearanceSnapshot]::PostMessage($window, 0x001F, [IntPtr]::Zero, [IntPtr]::Zero) }
$style = [NativeAppearanceSnapshot]::GetWindowLong($window, -16)
$dark = 0
if ([NativeAppearanceSnapshot]::DwmGetWindowAttribute($window, 20, [ref]$dark, 4) -ne 0) { throw 'Cannot read native window theme' }
$material = 0
$hasMica = [NativeAppearanceSnapshot]::DwmGetWindowAttribute($window, 38, [ref]$material, 4) -eq 0 -and $material -eq 2
if (-not $hasMica) {
  $hasMica = [NativeAppearanceSnapshot]::DwmGetWindowAttribute($window, 1029, [ref]$material, 4) -eq 0 -and $material -eq 1
}
$previousDpi = [NativeAppearanceSnapshot]::SetThreadDpiAwarenessContext([IntPtr](-4))
try {
if ([NativeAppearanceSnapshot]::GetForegroundWindow() -ne $window) { [void][NativeAppearanceSnapshot]::SetForegroundWindow($window) }
if ([NativeAppearanceSnapshot]::GetForegroundWindow() -ne $window) {
  # Background activation cannot reliably raise a window over the foreground app.
  # Temporarily expose only our owned window, click it, then restore its z-order.
  $wasTopmost = ([NativeAppearanceSnapshot]::GetWindowLong($window, -20) -band 8) -ne 0
  if (-not [NativeAppearanceSnapshot]::SetWindowPos($window, [IntPtr](-1), 0, 0, 0, 0, 0x0013)) { throw 'Cannot expose the owned test window' }
  try {
  $focusPoint = New-Object NativeAppearanceSnapshot+Point
  $focusScale = [NativeAppearanceSnapshot]::GetDpiForWindow($window) / 96
  $focusPoint.X = [int](350 * $focusScale); $focusPoint.Y = [int](16 * $focusScale)
  if (-not [NativeAppearanceSnapshot]::ClientToScreen($window, [ref]$focusPoint)) { throw 'Cannot locate the test header' }
  $exposure = [Diagnostics.Stopwatch]::StartNew()
  do {
    $focusTarget = [NativeAppearanceSnapshot]::WindowFromPoint($focusPoint)
    $owned = $focusTarget -eq $window -or [NativeAppearanceSnapshot]::IsChild($window, $focusTarget)
    if (-not $owned) { Start-Sleep -Milliseconds 10 }
  } while (-not $owned -and $exposure.ElapsedMilliseconds -lt 2000)
  if ($focusTarget -ne $window -and -not [NativeAppearanceSnapshot]::IsChild($window, $focusTarget)) {
    $focusBounds = New-Object NativeAppearanceSnapshot+Rect
    [void][NativeAppearanceSnapshot]::GetWindowRect($window, [ref]$focusBounds)
    $focusOwner = [uint32]0
    [void][NativeAppearanceSnapshot]::GetWindowThreadProcessId($focusTarget, [ref]$focusOwner)
    throw "Focus input would be outside the owned test window: visible=$([NativeAppearanceSnapshot]::IsWindowVisible($window)), point=$($focusPoint.X),$($focusPoint.Y), bounds=$($focusBounds.Left),$($focusBounds.Top),$($focusBounds.Right),$($focusBounds.Bottom), targetProcess=$((Get-Process -Id $focusOwner).ProcessName), targetTopmost=$([NativeAppearanceSnapshot]::GetWindowLong($focusTarget, -20) -band 8)"
  }
  if (-not [NativeAppearanceSnapshot]::SetCursorPos($focusPoint.X, $focusPoint.Y)) { throw 'Cannot position focus input' }
  [NativeAppearanceSnapshot]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  [NativeAppearanceSnapshot]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  $focusDeadline = [Diagnostics.Stopwatch]::StartNew()
  while ([NativeAppearanceSnapshot]::GetForegroundWindow() -ne $window) {
    if ($focusDeadline.ElapsedMilliseconds -gt 2000) { throw 'Harness did not obtain foreground focus; cannot capture its appearance' }
    Start-Sleep -Milliseconds 10
  }
  } finally {
    if (-not $wasTopmost -and -not [NativeAppearanceSnapshot]::SetWindowPos($window, [IntPtr](-2), 0, 0, 0, 0, 0x0013)) { throw 'Cannot restore test window z-order' }
  }
}
if ([NativeAppearanceSnapshot]::DwmFlush() -ne 0) { throw 'Cannot wait for the native frame' }
$snapHit = $null
if ($ProbeX -ge 0 -and $ProbeY -ge 0) {
  $point = New-Object NativeAppearanceSnapshot+Point
  $scale = [NativeAppearanceSnapshot]::GetDpiForWindow($window) / 96
  $point.X = [int]($ProbeX * $scale); $point.Y = [int]($ProbeY * $scale)
  if (-not [NativeAppearanceSnapshot]::ClientToScreen($window, [ref]$point)) { throw 'Cannot translate control coordinates' }
  $target = [NativeAppearanceSnapshot]::WindowFromPoint($point)
  $owner = [uint32]0
  [void][NativeAppearanceSnapshot]::GetWindowThreadProcessId($target, [ref]$owner)
  if ($owner -ne $TargetProcess) { throw 'Control probe is outside the owned test application' }
  $packed = [IntPtr](($point.X -band 0xffff) -bor (($point.Y -band 0xffff) -shl 16))
  $snapHit = [NativeAppearanceSnapshot]::SendMessage($target, 0x0084, [IntPtr]::Zero, $packed).ToInt32()
}
$owner = [uint32]0
$thread = [NativeAppearanceSnapshot]::GetWindowThreadProcessId($window, [ref]$owner)
$gui = New-Object NativeAppearanceSnapshot+GuiInfo
$gui.Size = [System.Runtime.InteropServices.Marshal]::SizeOf($gui)
if (-not [NativeAppearanceSnapshot]::GetGUIThreadInfo($thread, [ref]$gui)) { throw 'Cannot inspect the owned native window thread' }
function Invoke-WindowGesture($point, [int]$dx, [int]$dy) {
  $before = New-Object NativeAppearanceSnapshot+Rect
  if (-not [NativeAppearanceSnapshot]::GetWindowRect($window, [ref]$before)) { throw 'Cannot read gesture bounds' }
  try {
    if (-not [NativeAppearanceSnapshot]::SetCursorPos($point.X, $point.Y)) { throw 'Cannot position pointer' }
    [NativeAppearanceSnapshot]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    do {
      if (-not [NativeAppearanceSnapshot]::GetGUIThreadInfo($thread, [ref]$gui)) { throw 'Cannot observe drag start' }
      if ($deadline.ElapsedMilliseconds -gt 5000) { throw 'Header did not start the native move loop' }
      if (($gui.Flags -band 2) -eq 0) { Start-Sleep -Milliseconds 10 }
    } while (($gui.Flags -band 2) -eq 0)
    if (-not [NativeAppearanceSnapshot]::SetCursorPos($point.X + $dx, $point.Y + $dy)) { throw 'Cannot move pointer' }
    do {
      $changed = New-Object NativeAppearanceSnapshot+Rect
      if (-not [NativeAppearanceSnapshot]::GetWindowRect($window, [ref]$changed)) { throw 'Cannot observe gesture bounds' }
      $moved = $changed.Left -ne $before.Left -or $changed.Top -ne $before.Top -or $changed.Right -ne $before.Right -or $changed.Bottom -ne $before.Bottom
      if ($deadline.ElapsedMilliseconds -gt 5000) { throw 'Native gesture did not change bounds' }
      if (-not $moved) { Start-Sleep -Milliseconds 10 }
    } while (-not $moved)
  } finally {
    [NativeAppearanceSnapshot]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  }
  do {
    if (-not [NativeAppearanceSnapshot]::GetGUIThreadInfo($thread, [ref]$gui)) { throw 'Cannot observe gesture completion' }
    if ($deadline.ElapsedMilliseconds -gt 5000) { throw 'Native move/resize loop did not finish' }
    if (($gui.Flags -band 2) -ne 0) { Start-Sleep -Milliseconds 10 }
  } while (($gui.Flags -band 2) -ne 0)
}
if ($Action -eq 'Drag' -or $Action -eq 'Menu') {
  $point = New-Object NativeAppearanceSnapshot+Point
  $scale = [NativeAppearanceSnapshot]::GetDpiForWindow($window) / 96
  $point.X = [int](350 * $scale); $point.Y = [int](16 * $scale)
  if (-not [NativeAppearanceSnapshot]::ClientToScreen($window, [ref]$point)) { throw 'Cannot locate the draggable header' }
  if ($Action -eq 'Drag') { Invoke-WindowGesture $point 40 25 } else {
    if (-not [NativeAppearanceSnapshot]::SetCursorPos($point.X, $point.Y)) { throw 'Cannot locate title-bar menu input' }
    [NativeAppearanceSnapshot]::mouse_event(8, 0, 0, 0, [UIntPtr]::Zero)
    [NativeAppearanceSnapshot]::mouse_event(16, 0, 0, 0, [UIntPtr]::Zero)
    $menuDeadline = [Diagnostics.Stopwatch]::StartNew()
    do {
      if (-not [NativeAppearanceSnapshot]::GetGUIThreadInfo($thread, [ref]$gui)) { throw 'Cannot observe system menu' }
      if ($menuDeadline.ElapsedMilliseconds -gt 2000) { throw 'Title-bar right click did not open the native system menu' }
      if (($gui.Flags -band 4) -eq 0) { Start-Sleep -Milliseconds 10 }
    } while (($gui.Flags -band 4) -eq 0)
  }
}
if ($Action -eq 'Resize') {
  foreach ($hit in @(11, 15)) {
    $bounds = New-Object NativeAppearanceSnapshot+Rect
    if (-not [NativeAppearanceSnapshot]::GetWindowRect($window, [ref]$bounds)) { throw 'Cannot read resize bounds' }
    $point = New-Object NativeAppearanceSnapshot+Point
    $found = $false
    foreach ($offset in 1..20) {
      $point.X = if ($hit -eq 11) { $bounds.Right - $offset } else { [int](($bounds.Left + $bounds.Right) / 2) }
      $point.Y = if ($hit -eq 15) { $bounds.Bottom - $offset } else { [int](($bounds.Top + $bounds.Bottom) / 2) }
      $packed = [IntPtr](($point.X -band 0xffff) -bor (($point.Y -band 0xffff) -shl 16))
      $target = [NativeAppearanceSnapshot]::WindowFromPoint($point)
      $owner = [uint32]0
      [void][NativeAppearanceSnapshot]::GetWindowThreadProcessId($target, [ref]$owner)
      if ($owner -eq $TargetProcess -and [NativeAppearanceSnapshot]::SendMessage($target, 0x0084, [IntPtr]::Zero, $packed).ToInt32() -eq $hit) { $found = $true; break }
    }
    if (-not $found) { throw 'Expected a native resizable edge' }
    if ($hit -eq 11) { Invoke-WindowGesture $point 40 0 } else { Invoke-WindowGesture $point 0 20 }
  }
}
if ([NativeAppearanceSnapshot]::DwmFlush() -ne 0) { throw 'Cannot wait for the final native frame' }
$rect = New-Object NativeAppearanceSnapshot+Rect
if (-not [NativeAppearanceSnapshot]::GetWindowRect($window, [ref]$rect)) { throw 'Cannot read native window bounds' }
if ($Screenshot) {
$bitmap = New-Object System.Drawing.Bitmap(($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top))
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
  $bitmap.Save($Screenshot, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
}
@{ dark = [bool]$dark; material = $hasMica; nativeCaption = ($style -band 0x00C00000) -eq 0x00C00000; resize = ($style -band 0x00040000) -ne 0; systemMenu = ($style -band 0x00080000) -ne 0; snapHit = $snapHit; menuOpen = ($gui.Flags -band 4) -ne 0; left = $rect.Left; top = $rect.Top; width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top } | ConvertTo-Json -Compress
} finally {
  [void][NativeAppearanceSnapshot]::SetThreadDpiAwarenessContext($previousDpi)
}
