// agy-shim.cs: AionDX patch 0008, Antigravity signs in from AionUi itself.
//
// K, 2026-09-24: "our users aren't going to know how to or want to open a terminal. find a fix
// here ... in the ui".
//
// AionUi runs Antigravity's CLI in print mode (`agy -p ... --output-format stream-json`, aionui-session
// antigravity/argv.rs). Signed out, print mode tries a silent sign-in, then opens Google's sign-in
// page and waits 60 seconds for the browser to come back to its local callback
// (http://localhost:<port>/auth/callback); past that it exits with "authentication failed or timed
// out" (agy log: "Print mode: auth timed out"). Finishing a Google sign-in often takes longer, and
// the page then offers a code to paste into a terminal that AionUi does not have. AionUi's own
// message says to run agy in a terminal (antigravity/translate.rs); AionUi supports no sign-in for
// this backend (answer_auth: false).
//
// This program stands in for agy.exe (AionUi's command override for the Antigravity agent points
// here). For a chat turn it first checks that agy is signed in (`agy models`, about 1.4 s; a
// success is remembered for an hour). If not, it runs agy's own interactive screen in a hidden
// pseudo-console (ConPTY: no window, nothing to type), which opens the same Google page but waits
// as long as the user needs, and it watches for the sign-in to land. Then it runs the turn exactly
// as AionUi asked, arguments passed through untouched. Everything else (`--version`, `models`, ...)
// goes straight to agy.
//
// While it waits it writes aiondx.agy.signin to AionUi's settings store (the agent's own runtime
// token), which the AionDX renderer shows as a notice.
//
// Build (the .NET Framework compiler every Windows 10 and 11 has):
//   csc /nologo /optimize+ /target:exe /platform:x64 /r:System.Web.Extensions.dll /out:agy.exe agy-shim.cs
//
//   agy.exe <anything>          what AionUi runs; sign-in first when a chat turn needs it
//   agy.exe --aiondx-probe N    show the interactive screen's text for N seconds, press nothing, close it
//   agy.exe --aiondx-signin     run the sign-in now and report
//   agy.exe --aiondx-status     signed in or not

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

// The version resource says what this program is, so another copy of it on PATH is never taken for the
// real agy (RealAgy), which would have the two call each other.
[assembly: System.Reflection.AssemblyTitle("AionDX agy shim")]
[assembly: System.Reflection.AssemblyProduct("AionDX")]

namespace AionDx
{
    static class AgyShim
    {
        const int SignInMinutes = 15;
        static readonly string LogDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AionDX", "logs");
        static readonly string Marker = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AionDX", "agy-signed-in.txt");

        static int Main(string[] args)
        {
            string real = RealAgy();
            if (real == null)
            {
                Console.Error.WriteLine("AionDX agy shim: the Antigravity CLI (agy.exe) is not installed at %LOCALAPPDATA%\\agy\\bin.");
                return 127;
            }
            if (args.Length > 0 && args[0] == "--aiondx-probe")
            {
                int secs = args.Length > 1 ? int.Parse(args[1]) : 8;
                bool enter = args.Length > 2 && args[2] == "enter";
                bool pressed = false;
                var screen = Pty.Run(real, "", Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), TimeSpan.FromSeconds(secs), (text, send) =>
                {
                    if (enter && !pressed && LoginMenu(text)) { send("\r"); pressed = true; }
                    return false;
                });
                Console.Out.WriteLine("[" + Pty.LastRun + "]");
                Console.Out.WriteLine(screen);
                return 0;
            }
            if (args.Length > 0 && args[0] == "--aiondx-status")
            {
                var st = Check(real, false);
                Console.Out.WriteLine(st == Auth.Signed ? "signed in" : st == Auth.SignedOut ? "signed out" : "unknown (agy models failed for another reason; see the log)");
                return 0;
            }
            if (args.Length > 0 && args[0] == "--aiondx-signin")
            {
                bool ok = EnsureSignedIn(real, true);
                Console.Out.WriteLine(ok ? "signed in" : "not signed in");
                return ok ? 0 : 1;
            }
            // One line per launch, so "is AionUi running the wrapper at all?" has an answer.
            Log("run: " + (IsTurn(args) ? "chat turn" : (args.Length > 0 ? args[0] : "(no arguments)")) +
                " conv=" + (Environment.GetEnvironmentVariable("AIONUI_CONVERSATION_ID") ?? "-"));
            if (IsTurn(args) && !EnsureSignedIn(real, false))
            {
                Log("sign-in did not complete; running the turn anyway so agy reports it");
            }
            return PassThrough(real);
        }

        /** The real Antigravity CLI: Google's default install folder first, then any other agy.exe on
         *  PATH that is not this wrapper. (AionCore runs whichever agy comes first on PATH and ignores
         *  the agent's command override for Antigravity turns, so AionDX's bin folder sits first on
         *  PATH and this wrapper must never find itself.) */
        static string RealAgy()
        {
            string p = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "agy", "bin", "agy.exe");
            if (File.Exists(p)) return p;
            string self = "";
            try { self = Path.GetFullPath(System.Reflection.Assembly.GetEntryAssembly().Location); } catch (Exception) { }
            string selfDir = self.Length > 0 ? Path.GetDirectoryName(self).TrimEnd('\\').ToLowerInvariant() : "";
            foreach (string dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
            {
                string d = dir.Trim().Trim('"');
                if (d.Length == 0) continue;
                try
                {
                    string full = Path.GetFullPath(d).TrimEnd('\\');
                    if (full.ToLowerInvariant() == selfDir) continue;
                    string cand = Path.Combine(full, "agy.exe");
                    if (File.Exists(cand) && !string.Equals(Path.GetFullPath(cand), self, StringComparison.OrdinalIgnoreCase) && !IsShim(cand)) return cand;
                }
                catch (Exception) { }
            }
            return null;
        }

        static bool IsShim(string exe)
        {
            try { return string.Equals(FileVersionInfo.GetVersionInfo(exe).FileDescription, "AionDX agy shim", StringComparison.OrdinalIgnoreCase); }
            catch (Exception) { return false; }
        }

        /** A chat turn is print mode with a prompt: -p / --print / --prompt. */
        static bool IsTurn(string[] args)
        {
            foreach (var a in args) if (a == "-p" || a == "--print" || a == "--prompt" || a.StartsWith("--print=") || a.StartsWith("--prompt=")) return true;
            return false;
        }

        // ------------------------------------------------------------------ signed in?

        enum Auth { Signed, SignedOut, Unknown }
        // agy's own words for a signed-out run ("authentication failed or timed out", AionCore
        // antigravity/translate.rs) and the like.
        static readonly Regex SignedOutWords = new Regex(@"sign(ed)?[\s-]*in\b|signed[\s-]*out|not\s+logged\s+in|log\s*in\s+required|authenticat", RegexOptions.IgnoreCase);
        // The chat's own settings a hidden agy must not act on: its folder (a folder-trust prompt there would
        // stand in front of the sign-in) and AionCore's permission hook for this turn.
        static readonly string[] HiddenAgyDrops = { "PWD", "AIONUI_ANTIGRAVITY_HOOK_BASE_URL", "AIONUI_ANTIGRAVITY_HOOK_TOKEN", "AIONUI_ANTIGRAVITY_HOOK_CONVERSATION_ID" };

        /** Is agy signed in? `agy models` with its input closed, every wait bounded. Signed on a clean exit;
         *  SignedOut only when agy says so; Unknown for anything else (offline, a proxy, Google's own errors,
         *  agy updating itself), which must not start a sign-in. */
        static Auth Check(string real, bool useMarker)
        {
            if (useMarker)
            {
                try
                {
                    if (File.Exists(Marker) && (DateTime.UtcNow - File.GetLastWriteTimeUtc(Marker)) < TimeSpan.FromHours(1)) return Auth.Signed;
                }
                catch (Exception) { }
            }
            var psi = new ProcessStartInfo(real, "models")
            {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true,
                RedirectStandardError = true, WorkingDirectory = Path.GetTempPath()
            };
            foreach (var k in HiddenAgyDrops) psi.EnvironmentVariables.Remove(k);
            try
            {
                using (var p = Process.Start(psi))
                {
                    try { p.StandardInput.Close(); } catch (Exception) { }
                    var err = p.StandardError.ReadToEndAsync();
                    var outp = p.StandardOutput.ReadToEndAsync();
                    if (!p.WaitForExit(30000)) { try { p.Kill(); } catch (Exception) { } Log("models check: no answer in 30 s"); return Auth.Unknown; }
                    if (!System.Threading.Tasks.Task.WaitAll(new System.Threading.Tasks.Task[] { err, outp }, 5000)) { Log("models check: output did not close"); return Auth.Unknown; }
                    string all = (outp.Result ?? "") + (err.Result ?? "");
                    Auth a = SignedOutWords.IsMatch(all) ? Auth.SignedOut : p.ExitCode == 0 ? Auth.Signed : Auth.Unknown;
                    if (a == Auth.Signed) Touch(Marker);
                    else if (a == Auth.SignedOut) TryDelete(Marker);
                    if (a != Auth.Signed) Log("models check: " + a + ", exit " + p.ExitCode + ": " + Snapshot(all));
                    return a;
                }
            }
            catch (Exception e) { Log("models check failed: " + e.Message); return Auth.Unknown; }
        }
        static bool SignedIn(string real, bool useMarker) { return Check(real, useMarker) == Auth.Signed; }

        static bool EnsureSignedIn(string real, bool force)
        {
            var first = Check(real, !force);
            if (first == Auth.Signed) return true;
            // Not known to be signed out (offline, say): the turn goes through and agy says what is wrong.
            if (first == Auth.Unknown && !force) return true;
            // One sign-in at a time: a second chat turn waits for the first one's sign-in.
            using (var gate = new Mutex(false, @"Local\AionDX-agy-signin"))
            {
                bool owned;
                try { owned = gate.WaitOne(TimeSpan.FromMinutes(SignInMinutes + 1)); }
                catch (AbandonedMutexException) { owned = true; }
                try
                {
                    if (SignedIn(real, false)) return true;   // the other one finished it
                    return SignIn(real);
                }
                finally { if (owned) gate.ReleaseMutex(); }
            }
        }

        static bool SignIn(string real)
        {
            Log("signed out: starting the hidden sign-in");
            long started = NowMs();
            DateTime deadline = DateTime.UtcNow.AddMinutes(SignInMinutes);
            DateTime unknownBy = DateTime.UtcNow.AddSeconds(25);
            bool ok = false;
            bool chose = false;
            bool told = false;
            bool unknownScreen = false;
            DateTime lastSnap = DateTime.MinValue;
            var saved = new Dictionary<string, string>();
            foreach (var k in HiddenAgyDrops) { saved[k] = Environment.GetEnvironmentVariable(k); Environment.SetEnvironmentVariable(k, null); }
            try
            {
            Pty.Run(real, "", Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), TimeSpan.FromMinutes(SignInMinutes), (screen, send) =>
            {
                // About once a second, with the latest screen text. Returns true to stop.
                if (!chose && LoginMenu(screen))
                {
                    send("\r");   // "> 1. Google OAuth" is the highlighted choice
                    chose = true;
                    Log("login menu: chose Google OAuth");
                }
                if ((DateTime.UtcNow - lastSnap).TotalSeconds >= 30)
                {
                    lastSnap = DateTime.UtcNow;
                    Log("sign-in screen: " + Snapshot(screen));
                }
                // The fallback: when antigravity.google cannot hand the sign-in back to agy, it shows a
                // code. The AionDX panel (or an agent, for the user) puts it in aiondx.agy.signin.code;
                // it is typed into agy's own "paste the authorization code" field here.
                if (chose && (DateTime.UtcNow - lastCodeCheck).TotalSeconds >= 2)
                {
                    lastCodeCheck = DateTime.UtcNow;
                    string code = TakeCode(started);
                    if (code != null)
                    {
                        send(code + "\r");
                        Log("authorization code received from the UI and entered (" + code.Length + " characters)");
                        Status("waiting", "Code received; finishing the sign-in.");
                    }
                }
                if (!told && (chose || screen.IndexOf("accounts.google.com", StringComparison.OrdinalIgnoreCase) >= 0))
                {
                    told = true;
                    Status("waiting", "Antigravity needs you to sign in with Google. A sign-in page opened in your browser; finish it there and the chat continues.");
                }
                if (DateTime.UtcNow > deadline) return true;
                if (SignedInSoon(real)) { ok = true; return true; }
                if (!told && DateTime.UtcNow > unknownBy)
                {
                    unknownScreen = true;
                    Log("sign-in screen not recognised: " + Snapshot(screen));
                    return true;
                }
                return false;
            });
            }
            finally { foreach (var kv in saved) Environment.SetEnvironmentVariable(kv.Key, kv.Value); }
            if (!ok) ok = SignedIn(real, false);
            if (!ok && unknownScreen)
                Status("failed", "Antigravity showed a screen AionDX does not recognise, so it could not sign in from here. Open PowerShell, run agy once, and sign in there.");
            else
                Status(ok ? "done" : "failed", ok ? "Antigravity is signed in." : "Antigravity sign-in did not finish within " + SignInMinutes + " minutes.");
            Log(ok ? "signed in" : "sign-in did not finish");
            return ok;
        }

        /** agy's first screen when signed out: "Select login method: > 1. Google OAuth  2. Use a Google Cloud project". */
        static bool LoginMenu(string screen)
        {
            int at = screen.LastIndexOf("Select login method", StringComparison.OrdinalIgnoreCase);
            return at >= 0 && screen.IndexOf("Google OAuth", at, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        /** The tail of the screen for the log, whitespace squeezed, sign-in parameters masked. */
        static string Snapshot(string screen)
        {
            string t = Regex.Replace(screen, @"\s+", " ");
            t = Regex.Replace(t, @"(state|code_challenge|code)=[A-Za-z0-9._%-]+", "$1=<masked>");
            return t.Length > 600 ? t.Substring(t.Length - 600) : t;
        }

        static DateTime lastCodeCheck = DateTime.MinValue;

        /** A code the UI left in aiondx.agy.signin.code after this sign-in started, removed once read. */
        static string TakeCode(long since)
        {
            try
            {
                string json = Store("GET", "/api/settings/client?keys=aiondx.agy.signin.code", null);
                if (json == null) return null;
                var root = new System.Web.Script.Serialization.JavaScriptSerializer().DeserializeObject(json) as Dictionary<string, object>;
                var data = root != null && root.ContainsKey("data") ? root["data"] as Dictionary<string, object> : null;
                var rec = data != null && data.ContainsKey("aiondx.agy.signin.code") ? data["aiondx.agy.signin.code"] as Dictionary<string, object> : null;
                if (rec == null) return null;
                long at = rec.ContainsKey("at") ? Convert.ToInt64(rec["at"]) : 0;
                string code = rec.ContainsKey("code") ? Convert.ToString(rec["code"]).Trim() : "";
                Store("PUT", "/api/settings/client", "{\"aiondx.agy.signin.code\":null}");
                if (at < since - 60000 || code.Length < 10 || code.Length > 400 || code.IndexOfAny(new[] { '\r', '\n', ' ' }) >= 0) return null;
                return code;
            }
            catch (Exception e) { Log("code check failed: " + e.Message); return null; }
        }

        static long NowMs() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds; }

        /** AionUi's API with this agent's runtime token (aioncore puts it in every agent process). */
        static string Store(string method, string path, string body)
        {
            string b = Environment.GetEnvironmentVariable("AIONUI_BASE_URL"), t = Environment.GetEnvironmentVariable("AIONUI_RUNTIME_TOKEN"),
                   u = Environment.GetEnvironmentVariable("AIONUI_USER_ID"), c = Environment.GetEnvironmentVariable("AIONUI_CONVERSATION_ID");
            if (string.IsNullOrEmpty(b) || string.IsNullOrEmpty(t) || string.IsNullOrEmpty(u) || string.IsNullOrEmpty(c)) return null;
            var req = (HttpWebRequest)WebRequest.Create(b.TrimEnd('/') + path);
            req.Method = method; req.Proxy = null; req.Timeout = 5000; req.ReadWriteTimeout = 5000;
            req.Headers["x-aionui-runtime-token"] = t; req.Headers["x-aionui-user-id"] = u; req.Headers["x-aionui-conversation-id"] = c;
            if (body != null)
            {
                var bytes = Encoding.UTF8.GetBytes(body);
                req.ContentType = "application/json"; req.ContentLength = bytes.Length;
                using (var s = req.GetRequestStream()) s.Write(bytes, 0, bytes.Length);
            }
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var rd = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                return rd.ReadToEnd();
        }

        static DateTime lastCheck = DateTime.MinValue;
        /** `agy models` every 5 seconds while the sign-in screen runs. */
        static bool SignedInSoon(string real)
        {
            if ((DateTime.UtcNow - lastCheck).TotalSeconds < 5) return false;
            lastCheck = DateTime.UtcNow;
            return SignedIn(real, false);
        }

        // ------------------------------------------------------------------ pass-through

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct STARTUPINFO
        {
            public int cb; public string lpReserved, lpDesktop, lpTitle;
            public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
            public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetCommandLineW();
        [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
        [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
        [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();

        /** Run the real agy with this process's own command-line tail, byte for byte, sharing stdio. */
        static int PassThrough(string real)
        {
            string tail = Tail(Marshal.PtrToStringUni(GetCommandLineW()));
            var cmd = new StringBuilder("\"" + real + "\"" + (tail.Length > 0 ? " " + tail : ""));
            var si = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFO)), dwFlags = 0x100 };
            si.hStdInput = GetStdHandle(-10); si.hStdOutput = GetStdHandle(-11); si.hStdError = GetStdHandle(-12);
            uint flags = GetConsoleWindow() == IntPtr.Zero ? 0x08000000u : 0u;   // CREATE_NO_WINDOW when hidden
            PROCESS_INFORMATION pi;
            if (!CreateProcessW(real, cmd, IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero, null, ref si, out pi))
            {
                Console.Error.WriteLine("AionDX agy shim: could not start " + real + " (error " + Marshal.GetLastWin32Error() + ")");
                return 126;
            }
            WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
            uint code; GetExitCodeProcess(pi.hProcess, out code);
            CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
            return (int)code;
        }

        /** The command line without the program name (quoted or not), as the OS gave it. */
        static string Tail(string cl)
        {
            int i = 0;
            if (cl.Length > 0 && cl[0] == '"') { i = cl.IndexOf('"', 1); i = i < 0 ? cl.Length : i + 1; }
            else { while (i < cl.Length && cl[i] != ' ' && cl[i] != '\t') i++; }
            while (i < cl.Length && (cl[i] == ' ' || cl[i] == '\t')) i++;
            return cl.Substring(i);
        }

        // ------------------------------------------------------------------ status for the UI

        static void Status(string state, string message)
        {
            try
            {
                string b = Environment.GetEnvironmentVariable("AIONUI_BASE_URL"), t = Environment.GetEnvironmentVariable("AIONUI_RUNTIME_TOKEN"),
                       u = Environment.GetEnvironmentVariable("AIONUI_USER_ID"), c = Environment.GetEnvironmentVariable("AIONUI_CONVERSATION_ID");
                if (string.IsNullOrEmpty(b) || string.IsNullOrEmpty(t) || string.IsNullOrEmpty(u) || string.IsNullOrEmpty(c)) return;
                long now = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                string body = "{\"aiondx.agy.signin\":{\"state\":\"" + state + "\",\"message\":" + JsonStr(message) + ",\"conversation\":" + JsonStr(c) + ",\"at\":" + now + "}}";
                var req = (HttpWebRequest)WebRequest.Create(b.TrimEnd('/') + "/api/settings/client");
                req.Method = "PUT"; req.Proxy = null; req.Timeout = 5000; req.ContentType = "application/json";
                req.Headers["x-aionui-runtime-token"] = t; req.Headers["x-aionui-user-id"] = u; req.Headers["x-aionui-conversation-id"] = c;
                var bytes = Encoding.UTF8.GetBytes(body);
                req.ContentLength = bytes.Length;
                using (var s = req.GetRequestStream()) s.Write(bytes, 0, bytes.Length);
                using (req.GetResponse()) { }
            }
            catch (Exception e) { Log("status write failed: " + e.Message); }
        }

        static string JsonStr(string s)
        {
            var sb = new StringBuilder("\"");
            foreach (char ch in s ?? "")
            {
                if (ch == '"' || ch == '\\') sb.Append('\\').Append(ch);
                else if (ch < 32) sb.AppendFormat("\\u{0:x4}", (int)ch);
                else sb.Append(ch);
            }
            return sb.Append('"').ToString();
        }

        // ------------------------------------------------------------------ small helpers

        static void Touch(string f) { try { Directory.CreateDirectory(Path.GetDirectoryName(f)); File.WriteAllText(f, DateTime.Now.ToString("s")); } catch (Exception) { } }
        static void TryDelete(string f) { try { if (File.Exists(f)) File.Delete(f); } catch (Exception) { } }

        internal static void Log(string line)
        {
            try
            {
                Directory.CreateDirectory(LogDir);
                string f = Path.Combine(LogDir, "agy-shim.log");
                var fi = new FileInfo(f);
                if (fi.Exists && fi.Length > 512 * 1024) { try { File.WriteAllText(f, ""); } catch (Exception) { } }
                byte[] bytes = Encoding.UTF8.GetBytes(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " pid=" + Process.GetCurrentProcess().Id + " " + line + Environment.NewLine);
                // A chat's first message starts several wrappers at once (version check, model list, the turn), and
                // File.AppendAllText refuses a file another one has open: the smoke test of September 26th lost its
                // turn's line that way. A shared append, retried briefly, records every launch.
                for (int i = 0; i < 20; i++)
                {
                    try
                    {
                        using (var s = new FileStream(f, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete)) s.Write(bytes, 0, bytes.Length);
                        return;
                    }
                    catch (IOException) { Thread.Sleep(25); }
                }
            }
            catch (Exception) { }
        }
    }

    /** A hidden pseudo-console (ConPTY): runs a program that wants a terminal, with no window, and
     *  hands its screen text to a callback about once a second. */
    static class Pty
    {
        [StructLayout(LayoutKind.Sequential)] struct COORD { public short X, Y; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct STARTUPINFOEX
        {
            public int cb; public string lpReserved, lpDesktop, lpTitle;
            public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
            public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
            public IntPtr lpAttributeList;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

        [DllImport("kernel32.dll", SetLastError = true)] static extern int CreatePseudoConsole(COORD size, SafeFileHandle hInput, SafeFileHandle hOutput, uint flags, out IntPtr hPC);
        [DllImport("kernel32.dll", SetLastError = true)] static extern void ClosePseudoConsole(IntPtr hPC);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out SafeFileHandle r, out SafeFileHandle w, IntPtr sa, int size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr retSize);
        [DllImport("kernel32.dll", SetLastError = true)] static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
        [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
        [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint code);
        [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

        /** How the last run ended, for the probe and the log. */
        public static string LastRun = "";
        static long RawBytes;
        static Action<string> Send = keys => { };

        const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        static readonly IntPtr PSEUDOCONSOLE = (IntPtr)0x00020016;
        static readonly Regex Vt = new Regex(@"\x1B\[[0-9;?]*[ -/]*[@-~]|\x1B\][^\x07\x1B]*(\x07|\x1B\\)|\x1B[@-Z\\-_]|[\x00-\x08\x0B-\x1F\x7F]", RegexOptions.Compiled);

        /** Runs `exe args` in a hidden pseudo-console until `tick` returns true, the program exits,
         *  or `limit` passes, then ends it. Returns the screen text seen (escape sequences removed). */
        public static string Run(string exe, string args, string cwd, TimeSpan limit, Func<string, Action<string>, bool> tick)
        {
            SafeFileHandle inRead, inWrite, outRead, outWrite;
            CreatePipe(out inRead, out inWrite, IntPtr.Zero, 0);
            CreatePipe(out outRead, out outWrite, IntPtr.Zero, 0);
            IntPtr hpc;
            int hr = CreatePseudoConsole(new COORD { X = 120, Y = 40 }, inRead, outWrite, 0, out hpc);
            if (hr != 0) { AgyShim.Log("CreatePseudoConsole failed: 0x" + hr.ToString("x")); return ""; }

            var size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            var list = Marshal.AllocHGlobal(size);
            InitializeProcThreadAttributeList(list, 1, 0, ref size);
            UpdateProcThreadAttribute(list, 0, PSEUDOCONSOLE, hpc, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero);
            // STARTF_USESTDHANDLES with null handles: without it a child of a process whose own stdio
            // is redirected (AionUi's pipes) gets those instead of the pseudo-console.
            var si = new STARTUPINFOEX { cb = Marshal.SizeOf(typeof(STARTUPINFOEX)), lpAttributeList = list, dwFlags = 0x100 };
            PROCESS_INFORMATION pi;
            var cmd = new StringBuilder("\"" + exe + "\"" + (string.IsNullOrEmpty(args) ? "" : " " + args));
            bool started = CreateProcessW(exe, cmd, IntPtr.Zero, IntPtr.Zero, false, EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, cwd, ref si, out pi);
            var screen = new StringBuilder();
            if (!started)
            {
                AgyShim.Log("CreateProcess in the pseudo-console failed: " + Marshal.GetLastWin32Error());
            }
            else
            {
                // The pseudo-console's own ends belong to it now.
                inRead.Dispose(); outWrite.Dispose();
                var input = new FileStream(inWrite, FileAccess.Write, 256, false);
                Send = keys =>
                {
                    try { var b = Encoding.UTF8.GetBytes(keys); input.Write(b, 0, b.Length); input.Flush(); }
                    catch (Exception e) { AgyShim.Log("pseudo-console write failed: " + e.Message); }
                };
                var reader = new Thread(() =>
                {
                    var buf = new byte[4096];
                    try
                    {
                        using (var s = new FileStream(outRead, FileAccess.Read, 4096, false))
                        {
                            int n;
                            while ((n = s.Read(buf, 0, buf.Length)) > 0)
                            {
                                RawBytes += n;
                                lock (screen) screen.Append(Vt.Replace(Encoding.UTF8.GetString(buf, 0, n), ""));
                            }
                        }
                    }
                    catch (Exception e) { AgyShim.Log("pseudo-console read ended: " + e.GetType().Name + ": " + e.Message); }
                }) { IsBackground = true };
                reader.Start();
                DateTime end = DateTime.UtcNow + limit;
                bool exited = false;
                while (DateTime.UtcNow < end)
                {
                    if (WaitForSingleObject(pi.hProcess, 1000) == 0) { exited = true; break; }
                    string text;
                    lock (screen) text = screen.Length > 16000 ? screen.ToString(screen.Length - 16000, 16000) : screen.ToString();
                    if (tick != null && tick(text, Send)) break;
                }
                uint code = 0;
                if (!exited) TerminateProcess(pi.hProcess, 0);
                WaitForSingleObject(pi.hProcess, 3000);
                GetExitCodeProcess(pi.hProcess, out code);
                CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
                // Closing the pseudo-console flushes its last frames into the output pipe; let the
                // reader drain them before reporting.
                ClosePseudoConsole(hpc); hpc = IntPtr.Zero;
                reader.Join(3000);
                lock (screen) LastRun = (exited ? "exited on its own, code " + code : "ended by the shim") + ", " + RawBytes + " bytes read, " + screen.Length + " characters of screen text";
            }
            if (hpc != IntPtr.Zero) ClosePseudoConsole(hpc);
            DeleteProcThreadAttributeList(list);
            Marshal.FreeHGlobal(list);
            inWrite.Dispose();
            lock (screen) return screen.ToString();
        }
    }
}
