param([Parameter(Mandatory)][long]$WindowHandle)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TeamPlayWindowProbe {
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr handle, int index);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr handle);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr handle, uint command);
}
'@
$taskHandle = [IntPtr]::new($WindowHandle)
$taskStyle = [TeamPlayWindowProbe]::GetWindowLongPtr($taskHandle, -16).ToInt64()
$taskExtended = [TeamPlayWindowProbe]::GetWindowLongPtr($taskHandle, -20).ToInt64()
[pscustomobject]@{
  minimized = [TeamPlayWindowProbe]::IsIconic($taskHandle)
  windowStyleVisible = ($taskStyle -band 0x10000000) -ne 0
  toolWindow = ($taskExtended -band 0x80) -ne 0
  appWindow = ($taskExtended -band 0x40000) -ne 0
  owned = [TeamPlayWindowProbe]::GetWindow($taskHandle, 4) -ne [IntPtr]::Zero
} | ConvertTo-Json -Compress
