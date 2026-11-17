# guard-query.ps1: is Windows' RedirectionGuard (ProcessRedirectionTrustPolicy) enforced on this shell and on each process id given. Read only.
#   powershell -File tools\guard-query.ps1 -Ids 1234,5678   (a process under the guard cannot follow a junction an ordinary user made)
param([int[]]$Ids)
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class GQ {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint a, bool i, int id);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessMitigationPolicy(IntPtr h, int policy, ref uint buf, UIntPtr len);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static string Q(int id) {
    IntPtr h = id == 0 ? (IntPtr)(-1) : OpenProcess(0x1000, false, id);
    if (h == IntPtr.Zero) return "open failed " + Marshal.GetLastWin32Error();
    uint b = 0; bool ok = GetProcessMitigationPolicy(h, 16, ref b, (UIntPtr)4);
    int err = Marshal.GetLastWin32Error();
    if (id != 0) CloseHandle(h);
    return ok ? ("flags=0x" + b.ToString("x") + ((b & 1) != 0 ? " ENFORCED" : "") + ((b & 2) != 0 ? " audit" : "")) : ("query failed " + err);
  }
}
"@
"self ($PID): " + [GQ]::Q(0)
foreach ($i in $Ids) { "$i : " + [GQ]::Q($i) }
