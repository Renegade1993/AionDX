// aiondx-guard.exe: starts a program with Windows' RedirectionGuard on (November 16th, 2026). The user: the guard must not be on for
// agents in yolo mode; "otherwise, integrate it with one of the other safety levels". AionDX's Claude launcher starts a chat in a mode
// that asks before acting through this: it turns the guard on for itself (SetProcessMitigationPolicy, ProcessRedirectionTrustPolicy,
// EnforceRedirectionTrust), and the program it starts inherits it, so that agent cannot follow a folder link (a junction) an ordinary user
// made. The program is tied to this one by a job (it ends when this ends); its input, output and exit code pass straight through.
//   aiondx-guard.exe <program> [arguments...]
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

static class Guard
{
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetProcessMitigationPolicy(int policy, ref uint buffer, UIntPtr length);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }

    const int ProcessRedirectionTrustPolicy = 16;
    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    /** One argument as the C runtime reads it back (backslashes before a quote doubled, the whole quoted when it has a space or a quote). */
    static string Quote(string a)
    {
        if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return a;
        var sb = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in a)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { sb.Append('\\', slashes * 2 + 1); sb.Append('"'); slashes = 0; continue; }
            sb.Append('\\', slashes); slashes = 0; sb.Append(c);
        }
        sb.Append('\\', slashes * 2);
        return sb.Append('"').ToString();
    }

    static int Main(string[] args)
    {
        if (args.Length < 1) { Console.Error.WriteLine("aiondx-guard: name the program to start"); return 2; }
        uint enforce = 1;   // EnforceRedirectionTrust
        if (!SetProcessMitigationPolicy(ProcessRedirectionTrustPolicy, ref enforce, (UIntPtr)4))
            Console.Error.WriteLine("aiondx-guard: Windows did not take the guard (error " + Marshal.GetLastWin32Error() + "); starting without it");
        var sbArgs = new StringBuilder();
        for (int i = 1; i < args.Length; i++) { if (i > 1) sbArgs.Append(' '); sbArgs.Append(Quote(args[i])); }
        var psi = new ProcessStartInfo(args[0], sbArgs.ToString()) { UseShellExecute = false };
        psi.EnvironmentVariables["AIONDX_GUARDED"] = "1";   // the agent (and a test) can tell it runs guarded
        Process p;
        try { p = Process.Start(psi); }
        catch (Exception e) { Console.Error.WriteLine("aiondx-guard: could not start " + args[0] + ": " + e.Message); return 1; }
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job != IntPtr.Zero)
        {
            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
            AssignProcessToJobObject(job, p.Handle);
        }
        p.WaitForExit();
        return p.ExitCode;
    }
}
