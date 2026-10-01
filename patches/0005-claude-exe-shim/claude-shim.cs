// AionDX patch 0005-claude-exe-shim. Installed as %APPDATA%\npm\claude.exe.
//
// Starts `node claude-account-router.js <arguments>` without cmd.exe.
//
// WHY. AionUi's backend finds Claude by looking "claude" up on PATH. With only claude.cmd in the
// npm folder it ran `cmd /d /c claude.cmd <args>`, and cmd.exe ends a command at the first line
// break. AionUi passes a multi-line --append-system-prompt, so everything after its first line was
// lost, every launch: --permission-mode (so YOLO never applied and Bash prompted), the rest of the
// system prompt, --plugin-dir (skills) and --mcp-config (MCP servers, the team tools among them).
// Found 2026-09-24 from the live process tree: the cmd.exe command line held every argument, the
// router under it only the first line.
//
// Windows and AionUi both prefer an .exe over a .cmd in the same folder, so this file wins the
// lookup, and it hands its own command line to node exactly as received, line breaks included.
//
// Falls back like claude.cmd: with no router or no node it runs the native Claude build in the
// real profile's .local\bin with the same arguments.
//
// Build: patches\0005-claude-exe-shim\build.ps1. Tests: test-shim.js beside this file.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

static class ClaudeShim
{
    const uint STARTF_USESTDHANDLES = 0x100;
    const int STD_INPUT_HANDLE = -10;
    const int STD_OUTPUT_HANDLE = -11;
    const int STD_ERROR_HANDLE = -12;
    const uint HANDLE_FLAG_INHERIT = 1;
    const uint CREATE_NO_WINDOW = 0x08000000;
    const uint INFINITE = 0xFFFFFFFF;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX; public int dwY; public int dwXSize; public int dwYSize;
        public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
        public uint dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
        public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit,
        uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();

    static int Main()
    {
        string tail = Tail(Environment.CommandLine);
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string router = Path.Combine(dir, "claude-account-router.js");
        string node = FindNode(dir);
        string exe;
        string cmd;
        if (node != null && File.Exists(router))
        {
            exe = node;
            cmd = Quote(node) + " " + Quote(router);
        }
        else
        {
            exe = NativeClaude(dir);
            if (exe == null)
            {
                Console.Error.WriteLine("claude.exe (AionDX shim): no router, no node and no Claude Code build found. Run: claude install latest");
                return 1;
            }
            cmd = Quote(exe);
        }
        if (tail.Length > 0) cmd += " " + tail;
        return Run(exe, cmd);
    }

    // Everything after the program name, exactly as given. The program name ends at its closing
    // quote when it starts with one, otherwise at the first space or tab (CreateProcess rules).
    static string Tail(string cl)
    {
        int i = 0;
        if (cl.Length > 0 && cl[0] == '"')
        {
            int close = cl.IndexOf('"', 1);
            i = close < 0 ? cl.Length : close + 1;
        }
        else
        {
            while (i < cl.Length && cl[i] != ' ' && cl[i] != '\t') i++;
        }
        while (i < cl.Length && (cl[i] == ' ' || cl[i] == '\t')) i++;
        return cl.Substring(i);
    }

    static string Quote(string path) { return "\"" + path + "\""; }

    /** The router needs Node 22.13 or later: node:sqlite works without a flag from 22.13.0 (and 23.4.0), and
     *  without it moving a chat to another agent and Unsend stop working. The first candidate new enough
     *  wins; when none is, the first one found, so Claude still starts. Candidates, in order: a node.exe in a
     *  runtime folder beside this shim's folder; the Node.js install in Program Files; the Node that AionUi
     *  ships and unpacks (%APPDATA%\AionUi\aionui\runtime\node\node-v*); its copy inside the installed app,
     *  standalone AionDX (%LOCALAPPDATA%\Programs\AionDX) and then stock AionUi (Program Files\AionUi), so a
     *  PC with no Node of its own still works; then PATH. */
    static string FindNode(string dir)
    {
        string first = null;
        foreach (string p in NodeCandidates(dir))
        {
            if (first == null) first = p;
            if (NewEnough(p)) return p;
        }
        return first;
    }

    const string ManagedNode = @"resources\bundled-aioncore\win32-x64\managed-resources\node";

    static IEnumerable<string> NodeCandidates(string dir)
    {
        string own = null;
        try { own = Path.GetFullPath(Path.Combine(dir, "..", "runtime", "node.exe")); }
        catch (ArgumentException) { }
        if (own != null && File.Exists(own)) yield return own;
        string pf = Environment.GetEnvironmentVariable("ProgramFiles");
        if (!string.IsNullOrEmpty(pf))
        {
            string p = Path.Combine(pf, "nodejs", "node.exe");
            if (File.Exists(p)) yield return p;
        }
        string appdata = Environment.GetEnvironmentVariable("APPDATA");
        if (!string.IsNullOrEmpty(appdata))
        {
            string n = NewestNode(Path.Combine(appdata, @"AionUi\aionui\runtime\node"));
            if (n != null) yield return n;
        }
        string local = Environment.GetEnvironmentVariable("LOCALAPPDATA");
        if (!string.IsNullOrEmpty(local))
        {
            string n = NewestNode(Path.Combine(local, @"Programs\AionDX", ManagedNode));
            if (n != null) yield return n;
        }
        if (!string.IsNullOrEmpty(pf))
        {
            string n = NewestNode(Path.Combine(pf, "AionUi", ManagedNode));
            if (n != null) yield return n;
        }
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string d in path.Split(';'))
        {
            if (d.Trim().Length == 0) continue;
            string p = null;
            try { p = Path.Combine(d.Trim().Trim('"'), "node.exe"); }
            catch (ArgumentException) { }
            if (p != null && File.Exists(p)) yield return p;
        }
    }

    /** Read from node.exe's version resource, so nothing is started. Unreadable counts as too old. */
    static bool NewEnough(string exe)
    {
        try
        {
            FileVersionInfo vi = FileVersionInfo.GetVersionInfo(exe);
            Version v = new Version(vi.FileMajorPart, vi.FileMinorPart, vi.FileBuildPart);
            if (v.Major == 23) return v >= new Version(23, 4, 0);
            return v >= new Version(22, 13, 0);
        }
        catch (Exception) { return false; }
    }

    /** node.exe in the node-v* folder under root with the highest version number (v24.11.0 above v24.9.0),
     *  or null. */
    static string NewestNode(string root)
    {
        try
        {
            if (!Directory.Exists(root)) return null;
            string best = null;
            Version bestV = null;
            foreach (string d in Directory.GetDirectories(root, "node-v*"))
            {
                string p = Path.Combine(d, "node.exe");
                if (!File.Exists(p)) continue;
                Version v = FolderVersion(Path.GetFileName(d));
                if (best == null || (v != null && (bestV == null || v > bestV))) { best = p; bestV = v; }
            }
            return best;
        }
        catch (Exception) { return null; }
    }

    /** "node-v22.13.1-win-x64" gives 22.13.1; anything else gives null. */
    static Version FolderVersion(string name)
    {
        Match m = Regex.Match(name, @"^node-v(\d+)\.(\d+)\.(\d+)");
        if (!m.Success) return null;
        try { return new Version(int.Parse(m.Groups[1].Value), int.Parse(m.Groups[2].Value), int.Parse(m.Groups[3].Value)); }
        catch (Exception) { return null; }
    }

    // The real profile comes from APPDATA, because AionUi runs the second account's agent with HOME and
    // USERPROFILE pointed at a sandbox profile.
    static string NativeClaude(string dir)
    {
        string appdata = Environment.GetEnvironmentVariable("APPDATA");
        if (!string.IsNullOrEmpty(appdata))
        {
            DirectoryInfo roaming = new DirectoryInfo(appdata);
            if (roaming.Parent != null && roaming.Parent.Parent != null)
            {
                string p = Path.Combine(roaming.Parent.Parent.FullName, ".local", "bin", "claude.exe");
                if (File.Exists(p)) return p;
            }
        }
        string npm = Path.Combine(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
        if (File.Exists(npm)) return npm;
        if (!string.IsNullOrEmpty(appdata))
        {
            string global = Path.Combine(appdata, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
            if (File.Exists(global)) return global;
        }
        // Any other claude.exe on PATH, skipping this folder and any folder holding an AionDX launcher.
        foreach (string d in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
            try
            {
                string t = d.Trim().Trim('"');
                if (t.Length == 0 || string.Equals(Path.GetFullPath(t).TrimEnd('\\'), Path.GetFullPath(dir).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) continue;
                if (File.Exists(Path.Combine(t, "claude-account-router.js"))) continue;
                string p = Path.Combine(t, "claude.exe");
                if (File.Exists(p)) return p;
            }
            catch (Exception) { }
        }
        return null;
    }

    static int Run(string exe, string cmd)
    {
        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
        si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
        si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
        foreach (IntPtr h in new IntPtr[] { si.hStdInput, si.hStdOutput, si.hStdError })
        {
            if (h != IntPtr.Zero && h != new IntPtr(-1)) SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        }
        // With no console window of our own (AionUi starts agents hidden), keep the child hidden
        // too; in a terminal, share the terminal.
        uint flags = GetConsoleWindow() == IntPtr.Zero ? CREATE_NO_WINDOW : 0;
        PROCESS_INFORMATION pi;
        if (!CreateProcessW(exe, new StringBuilder(cmd, cmd.Length + 1), IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero, null, ref si, out pi))
        {
            Console.Error.WriteLine("claude.exe (AionDX shim): could not start " + exe + " (Windows error " + Marshal.GetLastWin32Error() + ")");
            return 1;
        }
        CloseHandle(pi.hThread);
        WaitForSingleObject(pi.hProcess, INFINITE);
        uint code;
        GetExitCodeProcess(pi.hProcess, out code);
        CloseHandle(pi.hProcess);
        return unchecked((int)code);
    }
}
