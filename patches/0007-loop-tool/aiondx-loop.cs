// aiondx-loop.cs: AionDX patch 0007, the Loop as an agent tool.
//
// a request of 2026-09-24
//
// A stdio MCP server: JSON-RPC 2.0, one message per line on stdin and stdout. It is registered
// once as an ordinary MCP server row in AionUi (POST /api/mcp/servers), so every agent backend
// gets it the way it gets any MCP server the user adds. Tools: loop_status and loop_set.
//
// WHICH CHAT IT SERVES. aioncore puts AIONUI_BASE_URL, AIONUI_RUNTIME_TOKEN, AIONUI_USER_ID and
// AIONUI_CONVERSATION_ID into every agent process it starts, but gives an MCP server only its own
// row's environment, and agent CLIs differ in what they pass on to their MCP servers. So this
// reads its own environment first, then walks up its parent processes and reads theirs (the PEB
// environment block, the offsets a Python helper has used since September
// 23rd). A parent is trusted only if it started before its child, so a reused process id is never
// taken for a parent. The runtime token signs in as the user (aionui-auth middleware.rs,
// runtime_token_channel) and needs no CSRF token.
//
// WHERE THE LOOP LIVES. AionUi's per-user key-value store, GET/PUT /api/settings/client
// (aionui-system client_pref.rs: a flat map, per-key upsert, null deletes, no side effects):
//   aiondx.loop.conv.<conversationId>          settings: on, msg, compactAt, who changed it and why
//   aiondx.loop.team.<teamId>.<slotId>
//   aiondx.loopstatus.<same suffix>            what the Loop last decided, written by the renderer
//   aiondx.engine                              {at, build}: the renderer is running the Loop
// patches/0001-renderer-dx/aionui-dx.js runs the Loop from the same records and marks the button
// when an agent changes it.
//
// TWO BUILDS OF THIS ONE FILE (the .NET Framework compiler every Windows 10 and 11 has):
//   csc /nologo /optimize+ /target:winexe /platform:x64 /r:System.Web.Extensions.dll /out:aiondx-loop.exe aiondx-loop.cs
//   csc /nologo /optimize+ /target:exe    /platform:x64 /r:System.Web.Extensions.dll /out:aiondx.exe      aiondx-loop.cs
// aiondx-loop.exe is the MCP server. As a Windows program (winexe) it has no console of its own,
// so no window ever flashes whoever starts it; stdin and stdout are the pipes the agent hands it.
// aiondx.exe is the same code as a console program, for agents to run from a shell. It exists
// because a chat's MCP servers are frozen when the chat is created (aionui-conversation
// service.rs, build_runtime_mcp_snapshot) and an assistant's default is the servers the user last
// picked for it, so the MCP row reaches only chats started with it selected. Every agent with a
// shell can run a program, and the aiondx-loop skill (auto-injected into every chat) says how.
// PowerShell neither waits for nor captures a winexe, hence the console build.
//
//   aiondx-loop.exe                    serve MCP on stdin/stdout
//   aiondx.exe loop status [--member NAME|all]
//   aiondx.exe loop set [--on|--off] [--message TEXT] [--compact] [--note TEXT] [--member NAME|all]
//   aiondx.exe priority --member NAME --message TEXT   a team lead's message that goes ahead of a teammate's
//                                       queue without stopping its turn (MCP tool priority_send; 1.3.0)
//   either one --identity              which chat it would serve and where that came from (no secrets)
//   either one --version
//   aiondx.exe doctor [--check]         puts AionDX's bin folder first on PATH and reports what is installed
//   aiondx.exe activate [--payload DIR] [--quiet] [--from WHO]   the installer's per-user half (1.2.0)
//   aiondx.exe deactivate [--quiet]     takes the per-user half back out
//   aiondx.exe shortcuts [--common] [--reset]   AionUi's shortcuts get the AionDX icon (or their own back)
//   aiondx.exe mcp list|tools|call|add|update|remove|test|enable|disable|status|path|secret ...   the user's MCP servers:
//                                       the AionDX MCP file (%USERPROFILE%\.aiondx\mcp\servers.json) and AionUi's list, used
//                                       as needed, one command at a time (1.6.0; MCP tools mcp_tools and mcp_call)

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

namespace AionDx
{
    sealed class ToolError : Exception { public ToolError(string m) : base(m) { } }

    /** An MCP server's HTTP answer that was not a success: its status, body and WWW-Authenticate header. */
    sealed class McpHttpError : Exception
    {
        public readonly int Status;
        public readonly string Body, Auth;
        public McpHttpError(int status, string body, string auth) : base("HTTP " + status) { Status = status; Body = body; Auth = auth; }
    }

    sealed class Identity
    {
        public string BaseUrl, Token, UserId, ConvId, Source;
    }

    sealed class Target
    {
        public string Kind;          // "conv" or "team"
        public string ConvId, TeamId, SlotId, Role, Name, TeamName;
        public string Suffix { get { return Kind == "conv" ? "conv." + ConvId : "team." + TeamId + "." + SlotId; } }
        public string Key { get { return "aiondx.loop." + Suffix; } }
        public string StatusKey { get { return "aiondx.loopstatus." + Suffix; } }
        /** The user's own words asking for a Loop off, typed in this chat or member (the Loop engine writes it). */
        public string AskKey { get { return "aiondx.loopask." + Suffix; } }
    }

    sealed class Ctx
    {
        public Target Self;
        public List<Target> Members = new List<Target>();   // the whole team, Self included; empty for a solo chat
    }

    static class Program
    {
        const string Version = "1.12.0";
        const long HoldDefault = 45;   // minutes of short replies the Loop keeps the cache warm through (aionui-dx.js HOLD_MIN)
        const long HoldMax = 240;      // aionui-dx.js HOLD_MIN_MAX
        const long ResumeWarmMaxMs = 50 * 60000;   // aionui-dx.js RESUME_WARM_MAX_MS
        const long LoopAskMaxMs = 30 * 60000;      // how long the user's "turn the loop off" lets an agent end an until-stopped Loop
        const string UntilStoppedBuild = "2026-09-26.6";   // the first Loop engine that knows "until the user stops it"
        const string EngineKey = "aiondx.engine";
        const string DefaultMsg = "CONTINUE WORKING. Re-check the project plan and queue files, take the next unfinished item, and keep going until the user interrupts.";
        const long EngineStaleMs = 5 * 60000;
        static readonly string[] CompactCommands = { "compact", "compress" };   // Claude and Codex; Gemini CLI and Qwen

        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 64 };
        static readonly object OutLock = new object();
        static TextWriter Out;
        static Identity Ident;

        static int Main(string[] args)
        {
            if (args.Length > 0 && args[0] == "--version") { Console.Out.WriteLine("aiondx-loop " + Version); return 0; }
            if (args.Length > 0 && args[0] == "--identity") return PrintIdentity();
            if (args.Length > 0 && args[0] == "doctor") return Doctor(args);
            if (args.Length > 0 && args[0] == "activate") return Activate(args, false);
            if (args.Length > 0 && args[0] == "deactivate") return Activate(args, true);
            if (args.Length > 0 && args[0] == "shortcuts") return Shortcuts(args);
            if (args.Length > 0) return Cli(args);

            var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            Out = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
            ExitWithParent();
            string line;
            while ((line = input.ReadLine()) != null)
            {
                line = line.Trim();
                if (line.Length == 0) continue;
                object msg;
                try { msg = Json.DeserializeObject(line); }
                catch (Exception) { Send(Error(null, -32700, "Parse error")); continue; }
                var batch = msg as object[];
                if (batch != null) { foreach (var m in batch) Handle(m as Dictionary<string, object>); }
                else Handle(msg as Dictionary<string, object>);
            }
            return 0;   // stdin closed: the agent is gone
        }

        // ------------------------------------------------------------------ JSON-RPC

        static void Handle(Dictionary<string, object> m)
        {
            if (m == null) return;
            object id;
            bool hasId = m.TryGetValue("id", out id) && id != null;
            var method = Str(m, "method");
            if (method == null) return;   // a response; this server sends no requests
            var p = m.ContainsKey("params") ? m["params"] as Dictionary<string, object> : null;
            try
            {
                object result;
                switch (method)
                {
                    case "initialize": result = InitializeResult(p); break;
                    case "ping": result = new Dictionary<string, object>(); break;
                    case "tools/list": result = new Dictionary<string, object> { { "tools", ToolDefs() } }; break;
                    case "tools/call": result = CallTool(p); break;
                    // Some clients ask for these whatever the capabilities say; empty lists are the polite answer.
                    case "resources/list": result = new Dictionary<string, object> { { "resources", new object[0] } }; break;
                    case "resources/templates/list": result = new Dictionary<string, object> { { "resourceTemplates", new object[0] } }; break;
                    case "prompts/list": result = new Dictionary<string, object> { { "prompts", new object[0] } }; break;
                    default:
                        if (hasId && !method.StartsWith("notifications/")) Send(Error(id, -32601, "Method not found: " + method));
                        return;
                }
                if (hasId) Send(Result(id, result));
            }
            catch (Exception e)
            {
                Log("error in " + method + ": " + e.GetType().Name + ": " + e.Message);
                if (hasId) Send(Error(id, -32603, "Internal error: " + e.Message));
            }
        }

        static void Send(Dictionary<string, object> msg)
        {
            var text = Json.Serialize(msg);
            lock (OutLock) { Out.WriteLine(text); }
        }

        static Dictionary<string, object> Result(object id, object result)
        {
            return new Dictionary<string, object> { { "jsonrpc", "2.0" }, { "id", id }, { "result", result } };
        }

        static Dictionary<string, object> Error(object id, int code, string message)
        {
            return new Dictionary<string, object> {
                { "jsonrpc", "2.0" }, { "id", id },
                { "error", new Dictionary<string, object> { { "code", code }, { "message", message } } } };
        }

        const string Instructions =
            "AionDX Loop: the user's Loop button in AionUi, shared with you. While a Loop is on, AionUi sends " +
            "its continue message each time the agent stops with nothing queued. loop_status shows it; loop_set " +
            "switches it on or off, changes the continue message, sets how long it keeps a waiting agent's prompt " +
            "cache warm (hold), or asks for a context compaction. The Loop is the only keep-warm mechanism: after " +
            "short replies it nudges 2, then 4 minutes after the agent's last message, inside the 5-minute cache " +
            "window, rests after the hold, and never wakes an agent whose cache has run out. Switch your Loop off, " +
            "with a note, when your work is finished or you are waiting on the user, unless the user set it to run until " +
            "they stop it: then it never rests, and only the user ends it (an agent may only once the user asks for the " +
            "Loop off in that agent's own chat). When the user asks you for that mode, loop_set until_stopped: true. When told to hold or slow down " +
            "until a time, set resume_at to that time: the Loop keeps you warm while that is cheaper and sends one " +
            "nudge saying the time has come, since nothing else tells you. The user sees every change " +
            "you make on the button. A team lead also has priority_send: a message to a teammate that goes ahead of " +
            "everything queued for it without stopping its current turn, and agent_stop: the real way to stop a teammate (pause, Loop off, process restart); team_interrupt_agent and team_shutdown_agent are not stops. The user's MCP servers and their credentials " +
            "are in the AionDX MCP file and AionUi's list, loaded into no chat: when the user asks you to use one, " +
            "mcp_tools lists its tools and mcp_call calls one, connecting for that call only. The user's GitHub needs no MCP " +
            "server: git on this PC is signed in by itself; github_status says as whom and how to push, and github_create_repo " +
            "makes a repository. usage_status shows the Claude account's 5-hour and weekly usage and whether a limit is reached: " +
            "look at it before a long job, and when you are told a limit was hit; do not keep retrying into a limit. " +
            "To show the user a picture or point at a file or folder, write Markdown in your reply: ![what it shows](C:/path/in/your/working/folder/pic.png) " +
            "draws a picture (it must be inside your working folder; spaces go in angle brackets), and [label](file:///C:/path/to/folder/) makes " +
            "a chip that opens it, with a button for the file's own program (the skill has the details).";

        static Dictionary<string, object> InitializeResult(Dictionary<string, object> p)
        {
            // Answer in the client's own protocol version: this server uses nothing that differs between them.
            var version = (p != null ? Str(p, "protocolVersion") : null) ?? "2025-06-18";
            return new Dictionary<string, object> {
                { "protocolVersion", version },
                { "capabilities", new Dictionary<string, object> { { "tools", new Dictionary<string, object> { { "listChanged", false } } } } },
                { "serverInfo", new Dictionary<string, object> { { "name", "aiondx-loop" }, { "title", "AionDX Loop" }, { "version", Version } } },
                { "instructions", Instructions } };
        }

        static object[] ToolDefs()
        {
            // Plain schemas only (type, properties, description): Gemini's function declarations
            // have refused keywords such as additionalProperties, and every backend must take these.
            var member = Prop("string",
                "Team chats only: a teammate's name, slot id or conversation id, or \"all\" for the whole team. Leave it out for your own Loop.");
            return new object[] {
                new Dictionary<string, object> {
                    { "name", "loop_status" },
                    { "title", "Loop status" },
                    { "description",
                        "Shows the Loop for this chat: whether it is on, its continue message, who changed it last, and what it is doing now. " +
                        "The Loop is the round button beside the Permission shield in AionUi's message box, and the user controls the same one. " +
                        "While it is on, AionUi sends the continue message each time you stop with nothing queued. It never sends while you " +
                        "are working. After a short reply (nothing to do) the next nudge comes 2, then 4 minutes after your last message, so your " +
                        "prompt cache (5 minutes) stays warm; after the hold (45 minutes of short replies by default) it rests and lets the " +
                        "cache run out, and it never wakes an agent whose cache has already run out. It waits out provider limits, switches " +
                        "itself off after 3 nudges with no reply, and goes off when the user says stop. A Loop set to run until the user stops " +
                        "it never rests or switches itself off. The status shows how long your cache " +
                        "stays warm. On a team, pass member to see a teammate's Loop." },
                    { "inputSchema", new Dictionary<string, object> {
                        { "type", "object" },
                        { "properties", new Dictionary<string, object> { { "member", member } } } } },
                    { "annotations", new Dictionary<string, object> { { "readOnlyHint", true }, { "openWorldHint", false } } } },
                new Dictionary<string, object> {
                    { "name", "loop_set" },
                    { "title", "Change the Loop" },
                    { "description",
                        "Changes the Loop for this chat: switch it on or off, change its continue message, or ask AionUi to compact your " +
                        "context. The user sees every change on the Loop button, with your name and note. Switch your Loop off when your " +
                        "work is finished or you are waiting on the user, so AionUi stops nudging you; switch it on when you have a long " +
                        "list of work to get through. hold sets how many minutes of short replies it keeps the cache warm through before it " +
                        "rests (default 45; 0 rests after the first short reply): raise it while you wait on a long job whose result you " +
                        "need the moment it lands. compact: true makes AionUi send /compact (or the agent's own equivalent) the next " +
                        "time you stop. resume_at: when you are told to hold, wait or slow down until a time, set it to that time. " +
                        "Nothing else tells you the time has come. Until then the Loop's nudges say you are holding (reply in a " +
                        "word), and it keeps your cache warm while that costs less than one reload (up to about 50 minutes away); " +
                        "at the time it sends one nudge saying so, with resume_message or the continue message. It switches the " +
                        "Loop on; switching the Loop off clears it. until_stopped: true, only when the user asks for it, makes the " +
                        "Loop run until the user stops it: no hold, no rest, and it never gives up. No agent can switch such a Loop off " +
                        "or end that mode unless the user has asked for the Loop off, in their own words, in your chat in the last " +
                        "30 minutes; the user ends it with the Loop menu, the agent's Stop button, or by saying so. A team lead can " +
                        "pass member to change a teammate's Loop, or \"all\"." },
                    { "inputSchema", new Dictionary<string, object> {
                        { "type", "object" },
                        { "properties", new Dictionary<string, object> {
                            { "on", Prop("boolean", "true switches the Loop on, false switches it off. Leave it out to keep it as it is.") },
                            { "until_stopped", Prop("boolean", "true, only when the user asks for it: the Loop is on and runs until the user stops it (no hold, no rest). false ends that mode, which needs the user's own request, like switching such a Loop off.") },
                            { "message", Prop("string", "A new continue message: the text AionUi sends when you stop. An empty string restores the default.") },
                            { "compact", Prop("boolean", "true asks AionUi to compact the context the next time the agent stops. Only for agents that offer a compact command.") },
                            { "hold", Prop("integer", "Minutes of short replies (nothing to do) the Loop keeps the prompt cache warm through before it rests, 0 to 240. Default 45. 0 rests after the first short reply.") },
                            { "resume_at", Prop("string", "When to resume: a clock time in the user's time zone (\"12:10\", \"3:30 pm\"; the next time it comes round), minutes from now (\"+45\"), or \"off\" to clear it. Within 24 hours.") },
                            { "resume_message", Prop("string", "What the resume nudge says after \"It is 12:10, the resume time you set.\" Leave it out to use the continue message.") },
                            { "note", Prop("string", "Why, in a few words. Shown to the user on the Loop button.") },
                            { "member", member } } } } },
                    { "annotations", new Dictionary<string, object> { { "readOnlyHint", false }, { "destructiveHint", false }, { "idempotentHint", false }, { "openWorldHint", false } } } },
                new Dictionary<string, object> {
                    { "name", "priority_send" },
                    { "title", "Priority message to a teammate" },
                    { "description",
                        "Team lead only. Sends one teammate a message that goes ahead of everything queued for it (other agents' " +
                        "messages, team notices), without stopping the turn it is in: it is the next thing the teammate reads. Use it " +
                        "for messages that cannot wait behind a long queue: a stop instruction, a correction to something actively " +
                        "wrong. It does not interrupt; to stop the teammate's turn now, use team_interrupt_agent. The message arrives " +
                        "marked as a priority message from you, the user sees it in the teammate's chat, and the reply says how many " +
                        "messages the teammate still has waiting." },
                    { "inputSchema", new Dictionary<string, object> {
                        { "type", "object" },
                        { "properties", new Dictionary<string, object> {
                            { "member", Prop("string", "The teammate: its name, slot id or conversation id.") },
                            { "message", Prop("string", "What to tell it. Up to 8000 characters. Both member and message are needed.") } } } } },
                    { "annotations", new Dictionary<string, object> { { "readOnlyHint", false }, { "destructiveHint", false }, { "idempotentHint", false }, { "openWorldHint", false } } } },
                new Dictionary<string, object> {
                    { "name", "agent_stop" },
                    { "title", "Stop a teammate" },
                    { "description",
                        "Team lead only. Actually stops one teammate: it pauses the member (AionCore's pause: its running turn is cancelled and it takes " +
                        "no new work, queued or sent by other agents, until the user writes to it), switches its Loop off, and then restarts its agent " +
                        "process so nothing it started in the background (monitors, background shells, scheduled wake-ups) can carry on. Use it when a " +
                        "teammate must stop and stay stopped. team_interrupt_agent cancels the turn but sends the replacement message you give it, which " +
                        "starts the next turn, and team_shutdown_agent waits for the teammate to agree; neither is a stop. The user sees every step. " +
                        "keep_process: true skips the restart (the member keeps its process and its context loaded)." },
                    { "inputSchema", new Dictionary<string, object> {
                        { "type", "object" },
                        { "properties", new Dictionary<string, object> {
                            { "member", Prop("string", "The teammate: its name, slot id or conversation id.") },
                            { "reason", Prop("string", "Why, in a few words. Shown to the user.") },
                            { "keep_process", Prop("boolean", "true pauses and switches the Loop off but does not restart the agent process.") } } } } },
                    { "annotations", new Dictionary<string, object> { { "readOnlyHint", false }, { "destructiveHint", true }, { "idempotentHint", true }, { "openWorldHint", false } } } },
                new Dictionary<string, object> {
                    { "name", "mcp_status" },
                    { "title", "MCP servers" },
                    { "description",
                        "Shows the user's MCP servers: the AionDX MCP file (servers and their credentials, loaded into no chat, used when the " +
                        "user asks), the servers this chat was started with and how its agent reported them, and AionUi's whole MCP list " +
                        "(Settings > Tools): each server ON or OFF, how it runs, and its last check. A new chat gets the servers switched ON " +
                        "in AionUi's list, unless its assistant has a list of its own. Also lists recent changes made with mcp_set. " +
                        "Values of env and headers are never shown." },
                    { "inputSchema", new Dictionary<string, object> { { "type", "object" }, { "properties", new Dictionary<string, object>() } } },
                    { "annotations", new Dictionary<string, object> { { "readOnlyHint", true }, { "openWorldHint", false } } } },
                new Dictionary<string, object> {
                    { "name", "mcp_set" },
                    { "title", "Change the MCP servers" },
                    { "description",
                        "Changes the user's MCP servers. By default the AionDX MCP file: one file of servers and their credentials that " +
                        "nothing loads into a chat; an agent uses a server from it when the user asks, with mcp_tools and mcp_call. " +
                        "where: \"aionui\" changes AionUi's own list (Settings > Tools) instead, where a server added stays OFF unless on is " +
                        "true, because every new chat gets the ON ones. action: add (then a connection check), update (its transport or " +
                        "description), remove, test (connect and list its tools); enable and disable switch a server in AionUi's list. " +
                        "update, remove and test find the name in either place. The user sees each change as a notice with your name and " +
                        "note. Servers built into AionUi are left alone." },
                    { "inputSchema", new Dictionary<string, object> {
                        { "type", "object" },
                        { "properties", new Dictionary<string, object> {
                            { "action", Prop("string", "add, update, remove, test, enable or disable.") },
                            { "name", Prop("string", "The server's name; for add, the new name (letters, digits, dot, dash, underscore).") },
                            { "transport", Prop("object", "For add and update. A local server: {\"type\": \"stdio\", \"command\": \"...\", \"args\": [...], \"env\": {...}, \"cwd\": \"...\"}. A remote one: {\"type\": \"http\" or \"sse\", \"url\": \"...\", \"headers\": {...}}. In the AionDX MCP file any value can be ${NAME}, a secret from the file's secrets.") },
                            { "description", Prop("string", "For add and update: a short description.") },
                            { "test", Prop("boolean", "For add and update: false skips the connection check. Default true.") },
                            { "where", Prop("string", "\"file\" (the AionDX MCP file, the default for add) or \"aionui\" (AionUi's own list).") },
                            { "on", Prop("boolean", "With where \"aionui\" and add: true switches the new server on, so every new chat gets it. Default false.") },
                            { "note", Prop("string", "Why, in a few words. Shown to the user.") } } } } },
                    { "annotations", new Dictionary<string, object> { { "readOnlyHint", false }, { "destructiveHint", true }, { "idempotentHint", false }, { "openWorldHint", true } } } },
                new Dictionary<string, object> {
                    { "name", "mcp_tools" },
                    { "title", "An MCP server's tools" },
                    { "description",
                        "Connects to one of the user's MCP servers for this call only (the AionDX MCP file first, then AionUi's list) and " +
                        "lists its tools with their parameters; pass tool for one tool's whole description and input schema. The server's " +
                        "credentials go from the file to the server, never into your context. Use a server only when the user has asked " +
                        "you to use it." },
                    { "inputSchema", new Dictionary<string, object> {
                        { "type", "object" },
                        { "properties", new Dictionary<string, object> {
                            { "server", Prop("string", "The server's name, as mcp_status lists it.") },
                            { "tool", Prop("string", "One tool's name, for its whole description and input schema.") },
                            { "timeout", Prop("integer", "Seconds to wait for the server, 1 to 1800. Default 60.") } } } } },
                    { "annotations", new Dictionary<string, object> { { "readOnlyHint", true }, { "openWorldHint", true } } } },
                new Dictionary<string, object> {
                    { "name", "mcp_call" },
                    { "title", "Call a tool on an MCP server" },
                    { "description",
                        "Calls one tool on one of the user's MCP servers (the AionDX MCP file first, then AionUi's list), connecting for " +
                        "this call only, so the server is never loaded into the chat. Its credentials go from the file to the server, never " +
                        "into your context. The result comes back as the tool's own content, text and pictures. Every call is logged. " +
                        "Use a server only when the user has asked you to; mcp_tools shows a server's tools and their parameters." },
                    { "inputSchema", new Dictionary<string, object> {
                        { "type", "object" },
                        { "properties", new Dictionary<string, object> {
                            { "server", Prop("string", "The server's name, as mcp_status lists it.") },
                            { "tool", Prop("string", "The tool's name, as mcp_tools lists it.") },
                            { "arguments", Prop("object", "The tool's arguments, as its input schema describes them.") },
                            { "timeout", Prop("integer", "Seconds to wait for the answer, 1 to 1800. Default 120.") } } } } },
                    { "annotations", new Dictionary<string, object> { { "readOnlyHint", false }, { "destructiveHint", true }, { "idempotentHint", false }, { "openWorldHint", true } } } },
                new Dictionary<string, object> {
                    { "name", "github_status" },
                    { "title", "The user's GitHub" },
                    { "description",
                        "The user's GitHub: which account git on this PC is signed in as (git's own stored sign-in, so git push works with " +
                        "no token and no MCP server), who commits are signed as, and how to push a folder. Use it first whenever the user " +
                        "asks you to push to their GitHub, make a repository, or anything about \"my github\". repos: true lists the " +
                        "account's repositories too." },
                    { "inputSchema", new Dictionary<string, object> {
                        { "type", "object" },
                        { "properties", new Dictionary<string, object> {
                            { "repos", Prop("boolean", "true adds the account's repositories, the latest changed first.") } } } } },
                    { "annotations", new Dictionary<string, object> { { "readOnlyHint", true }, { "openWorldHint", true } } } },
                new Dictionary<string, object> {
                    { "name", "github_create_repo" },
                    { "title", "Make a GitHub repository" },
                    { "description",
                        "Makes a new repository on the user's GitHub account, with git's own stored sign-in, private unless public: true. " +
                        "Then push with git as github_status says. Only when the user asks for a repository, or asks you to push " +
                        "somewhere that does not exist yet. A name the account already has makes nothing and says so." },
                    { "inputSchema", new Dictionary<string, object> {
                        { "type", "object" },
                        { "properties", new Dictionary<string, object> {
                            { "name", Prop("string", "The repository's name: letters, digits, dot, dash, underscore.") },
                            { "public", Prop("boolean", "true makes it public; left out, it is private.") },
                            { "description", Prop("string", "A one-line description, shown on GitHub.") } } } } },
                    { "annotations", new Dictionary<string, object> { { "readOnlyHint", false }, { "destructiveHint", false }, { "idempotentHint", true }, { "openWorldHint", true } } } },
                new Dictionary<string, object> {
                    { "name", "usage_status" },
                    { "title", "Claude usage" },
                    { "description",
                        "Your Claude account's usage: the 5-hour and weekly windows, how much of each is used, when each resets, and whether a " +
                        "limit is reached (then the account cannot make requests until the reset: do not retry before it, and tell the user). " +
                        "The numbers come from Claude's own responses, read as they go past, so this costs nothing. Use it before a long job " +
                        "that would spend a lot, and whenever a message says a limit was hit. all: true adds every other account AionDX has a reading for." },
                    { "inputSchema", new Dictionary<string, object> {
                        { "type", "object" },
                        { "properties", new Dictionary<string, object> {
                            { "all", Prop("boolean", "true adds every other account AionDX has a usage reading for.") } } } } },
                    { "annotations", new Dictionary<string, object> { { "readOnlyHint", true }, { "openWorldHint", false } } } }
            };
        }

        static Dictionary<string, object> Prop(string type, string description)
        {
            return new Dictionary<string, object> { { "type", type }, { "description", description } };
        }

        static Dictionary<string, object> CallTool(Dictionary<string, object> p)
        {
            var name = p != null ? Str(p, "name") : null;
            var a = (p != null && p.ContainsKey("arguments") ? p["arguments"] as Dictionary<string, object> : null) ?? new Dictionary<string, object>();
            string text;
            bool isError = false;
            object[] content = null;
            try
            {
                if (name == "loop_status") text = LoopStatus(a);
                else if (name == "loop_set") text = LoopSet(a);
                else if (name == "priority_send") text = PrioritySend(a);
                else if (name == "agent_stop") text = AgentStop(a);
                else if (name == "mcp_status") text = McpStatus(a);
                else if (name == "mcp_set") text = McpSet(a);
                else if (name == "mcp_tools") text = McpToolsText(Str(a, "server"), Str(a, "tool"), false, TimeoutArg(a, 60) * 1000);
                else if (name == "usage_status") text = UsageText(Bool(a, "all") == true);
                else if (name == "github_status") text = GitHubStatusText(Bool(a, "repos") == true);
                else if (name == "github_create_repo") text = GitHubCreate(Str(a, "name"), Bool(a, "public") == true, Str(a, "description"));
                else if (name == "mcp_call")
                {
                    var r = McpCallTool(a);
                    content = r.Item1;
                    isError = r.Item2;
                    text = isError ? "tool error" : "ok";
                }
                else throw new ToolError("Unknown tool: " + name + ". This server has loop_status, loop_set, priority_send, agent_stop, mcp_status, mcp_set, mcp_tools, mcp_call, github_status, github_create_repo and usage_status.");
            }
            catch (ToolError e) { text = e.Message; isError = true; content = null; }
            catch (Exception e) { text = "The Loop tool failed: " + e.Message; isError = true; content = null; }
            Log((Ident != null ? "conv=" + Ident.ConvId + " " : "") + name + (isError ? " error: " + OneLine(text) : " ok") +
                (name == "loop_set" ? " args=" + OneLine(Json.Serialize(Redact(a))) : "") +
                (name == "agent_stop" ? " member=" + OneLine(Str(a, "member") ?? "") : "") +
                (name == "priority_send" ? " member=" + OneLine(Str(a, "member") ?? "") + " chars=" + (Str(a, "message") ?? "").Length : "") +
                (name == "mcp_set" ? " action=" + OneLine(Str(a, "action") ?? "") + " server=" + OneLine(Str(a, "name") ?? "") : "") +
                (name == "mcp_tools" || name == "mcp_call" ? " server=" + OneLine(Str(a, "server") ?? "") + " tool=" + OneLine(Str(a, "tool") ?? "") : ""));
            return new Dictionary<string, object> {
                { "content", content ?? new object[] { new Dictionary<string, object> { { "type", "text" }, { "text", text } } } },
                { "isError", isError } };
        }

        // ------------------------------------------------------------------ command line

        const string CliHelp =
            "Usage:\n" +
            "  aiondx doctor [--check]     put AionDX's bin folder first on PATH and report what is installed\n" +
            "  aiondx loop status [--member NAME|all]\n" +
            "  aiondx loop set [--on|--off] [--until-stopped] [--message TEXT] [--hold MINUTES] [--resume-at TIME] [--resume-message TEXT] [--compact] [--note TEXT] [--member NAME|all]\n" +
            "  aiondx priority --member NAME --message TEXT   (team lead) a message that goes ahead of the teammate's queue\n" +
            "  aiondx stop --member NAME [--reason TEXT] [--keep-process]   (team lead) really stop a teammate: pause it, Loop off, restart its process\n" +
            "  aiondx mcp list|tools|call|add|update|remove|test|enable|disable|status ...   the user's MCP servers (aiondx mcp help)\n" +
            "  aiondx setup scan | apply --all ...   bring the other AI apps' setup into AionDX (aiondx setup help)\n" +
            "  aiondx github [status | repos | create NAME [--public]]   the user's GitHub, through git's own sign-in (aiondx github help)\n" +
            "  aiondx usage [--all]        your Claude account's 5-hour and weekly usage, resets, and whether a limit is reached\n" +
            "  aiondx migrate detect|run|backup|verify ...   move from AionUi to AionDX: back up the chats, remove AionUi, check them (aiondx migrate help)\n" +
            "--on and --off switch the Loop; --until-stopped (only when the user asks for it) keeps it on until the user stops it, " +
            "with no hold and no rest, and only the user's own request ends it (--until-stopped=false ends that mode); " +
            "--message sets the continue message (\"\" restores the default); " +
            "--hold sets how many minutes of short replies it keeps the prompt cache warm through before it rests (0-240, default 45); " +
            "--resume-at sends one nudge at that time (\"12:10\", \"3:30 pm\", \"+45\" minutes; \"off\" clears it), holding until then; " +
            "--resume-message is what that nudge says (default: the continue message); " +
            "--compact asks AionUi to compact the context the next time the agent stops; --note says why, shown to the user; " +
            "--member names a teammate (team lead only for set) or all.";

        const string McpHelp =
            "Usage:\n" +
            "  aiondx mcp list                            the user's MCP servers: the AionDX MCP file and AionUi's list\n" +
            "  aiondx mcp tools SERVER [TOOL] [--full]    connect and list its tools and their parameters (* = required)\n" +
            "  aiondx mcp call SERVER TOOL [--param NAME=VALUE]... [--json JSON|- | --json-file FILE] [--out FILE] [--raw] [--timeout S]\n" +
            "  aiondx mcp add --name NAME (--command EXE [--arg A]... [--env K=V]... [--cwd DIR] | --url URL [--type http|sse] [--header K=V]...)\n" +
            "                 [--description TEXT] [--no-test] [--note TEXT] [--aionui [--on]]\n" +
            "  aiondx mcp update --name NAME [the same options]      aiondx mcp remove|test --name NAME\n" +
            "  aiondx mcp enable|disable --name NAME                 (AionUi's list)\n" +
            "  aiondx mcp status | path | init | secret NAME | secret NAME --set (typed, not shown, or piped in) | protect\n" +
            "Servers and their credentials go in the AionDX MCP file (aiondx mcp path), which no chat loads: use a server only when\n" +
            "the user asks, with tools and call, which connect for that one command and pass the credentials straight to the server.\n" +
            "--aionui adds to AionUi's own list (Settings > Tools) instead, switched OFF unless --on, since every new chat gets the ON\n" +
            "ones. The user sees each change with your name. --param values follow the tool's schema (numbers, true/false, JSON,\n" +
            "a,b,c for a list). In Windows PowerShell 5.1 double quotes inside an argument are lost: use --param, or --json-file.";

        static int McpCli(string[] args, StreamWriter o)
        {
            string sub = args.Length > 1 ? args[1] : "help";
            if (sub == "help" || sub == "--help" || sub == "-h") { o.WriteLine(McpHelp); return args.Length > 1 ? 0 : 2; }
            var a = new Dictionary<string, object>();
            try
            {
                if (sub == "call") return McpCallCli(args, o);
                if (sub == "tools") return McpToolsCli(args, o);
                if (sub == "secret") return McpSecretCli(args, o);
                if (sub == "protect")
                {
                    if (args.Length > 2) throw new ToolError("aiondx mcp protect takes no options.\n" + McpHelp);
                    o.WriteLine(McpProtect());
                    return 0;
                }
                if (sub == "list" || sub == "path" || sub == "init")
                {
                    if (args.Length > 2) throw new ToolError("aiondx mcp " + sub + " takes no options.\n" + McpHelp);
                    o.WriteLine((sub == "list" ? McpListText() : sub == "path" ? McpFilePath() : McpFileInit()).TrimEnd());
                    return 0;
                }
                var t = new Dictionary<string, object>();
                var targs = new List<object>();
                var env = new Dictionary<string, object>();
                var headers = new Dictionary<string, object>();
                for (int i = 2; i < args.Length; i++)
                {
                    var x = args[i];
                    string inline = null;
                    int eq = x.IndexOf('=');
                    if (x.StartsWith("--") && eq > 0) { inline = x.Substring(eq + 1); x = x.Substring(0, eq); }
                    switch (x)
                    {
                        case "--name": a["name"] = inline ?? Next(args, ref i, x); break;
                        case "--note": a["note"] = inline ?? Next(args, ref i, x); break;
                        case "--description": a["description"] = inline ?? Next(args, ref i, x); break;
                        case "--no-test": a["test"] = false; break;
                        case "--aionui": a["where"] = "aionui"; break;
                        case "--on": a["on"] = true; break;
                        case "--command": t["command"] = inline ?? Next(args, ref i, x); if (!t.ContainsKey("type")) t["type"] = "stdio"; break;
                        case "--arg": targs.Add(inline ?? Next(args, ref i, x)); break;
                        case "--cwd": t["cwd"] = inline ?? Next(args, ref i, x); break;
                        case "--url": t["url"] = inline ?? Next(args, ref i, x); if (!t.ContainsKey("type")) t["type"] = "http"; break;
                        case "--type": t["type"] = inline ?? Next(args, ref i, x); break;
                        case "--env":
                        case "--header":
                            {
                                var kv = inline ?? Next(args, ref i, x);
                                int e2 = kv.IndexOf('=');
                                if (e2 <= 0) throw new ToolError(x + " takes NAME=VALUE.");
                                (x == "--env" ? env : headers)[kv.Substring(0, e2)] = kv.Substring(e2 + 1);
                                break;
                            }
                        default: throw new ToolError("Unknown option " + args[i] + ".\n" + McpHelp);
                    }
                }
                if (targs.Count > 0) t["args"] = targs.ToArray();
                if (env.Count > 0) t["env"] = env;
                if (headers.Count > 0) t["headers"] = headers;
                if (t.Count > 0) a["transport"] = t;
                string text;
                if (sub == "status") text = McpStatus(a);
                else { a["action"] = sub; text = McpSet(a); }
                o.WriteLine(text.TrimEnd());
                Log((Ident != null ? "conv=" + Ident.ConvId + " " : "") + "cli mcp " + sub + " ok server=" + OneLine(Str(a, "name") ?? ""));
                return 0;
            }
            catch (ToolError e) { o.WriteLine(e.Message); return 1; }
            catch (Exception e) { o.WriteLine("The MCP command failed: " + e.Message); return 1; }
        }

        static int McpCallCli(string[] args, StreamWriter o)
        {
            string server = null, tool = null, jsonText = null, jsonFile = null, outFile = null;
            bool raw = false;
            int timeout = 120;
            var pairs = new List<KeyValuePair<string, string>>();
            var pos = new List<string>();
            for (int i = 2; i < args.Length; i++)
            {
                var x = args[i];
                string inline = null;
                int eq = x.IndexOf('=');
                if (x.StartsWith("--") && eq > 0) { inline = x.Substring(eq + 1); x = x.Substring(0, eq); }
                switch (x)
                {
                    case "--name": case "--server": server = inline ?? Next(args, ref i, x); break;
                    case "--tool": tool = inline ?? Next(args, ref i, x); break;
                    case "--param": case "--arg": case "-p":
                        {
                            var kv = inline ?? Next(args, ref i, x);
                            int e2 = kv.IndexOf('=');
                            if (e2 <= 0) throw new ToolError(x + " takes NAME=VALUE, as in --param owner=octocat.");
                            pairs.Add(new KeyValuePair<string, string>(kv.Substring(0, e2).Trim(), kv.Substring(e2 + 1)));
                            break;
                        }
                    case "--json": jsonText = inline ?? Next(args, ref i, x); break;
                    case "--json-file": jsonFile = inline ?? Next(args, ref i, x); break;
                    case "--out": outFile = inline ?? Next(args, ref i, x); break;
                    case "--raw": raw = true; break;
                    case "--timeout": timeout = SecondsArg(inline ?? Next(args, ref i, x)); break;
                    default:
                        if (x.StartsWith("--")) throw new ToolError("Unknown option " + args[i] + ".\n" + McpHelp);
                        pos.Add(args[i]);
                        break;
                }
            }
            int k = 0;
            if (server == null && k < pos.Count) server = pos[k++];
            if (tool == null && k < pos.Count) tool = pos[k++];
            if (jsonText == null && jsonFile == null && k < pos.Count) jsonText = pos[k++];
            if (k < pos.Count) throw new ToolError("Too many values: " + string.Join(" ", pos.Skip(k)) + ". A value with spaces goes in quotes.\n" + McpHelp);
            if (string.IsNullOrWhiteSpace(server) || string.IsNullOrWhiteSpace(tool))
                throw new ToolError("Name the server and the tool: aiondx mcp call SERVER TOOL --param name=value. aiondx mcp list shows the servers, and aiondx mcp tools SERVER their tools.");
            var arguments = McpArgsFrom(jsonText, jsonFile);
            Watchdog(timeout + 60);
            var res = McpCall(server, tool, arguments, pairs, timeout * 1000);
            bool isError = Bool(res.Item2, "isError") == true;
            string text = raw ? PrettyJson(res.Item2) : McpResultText(res.Item1, tool, res.Item2);
            if (outFile != null)
            {
                File.WriteAllText(outFile, text, new UTF8Encoding(false));
                o.WriteLine((isError ? "The tool reported an error. " : "") + "Wrote " + text.Length + " characters to " + Path.GetFullPath(outFile) + ".");
            }
            else o.Write(text.EndsWith("\n") ? text : text + "\n");
            return isError ? 1 : 0;
        }

        static int McpToolsCli(string[] args, StreamWriter o)
        {
            string server = null, tool = null;
            bool full = false;
            int timeout = 60;
            var pos = new List<string>();
            for (int i = 2; i < args.Length; i++)
            {
                var x = args[i];
                string inline = null;
                int eq = x.IndexOf('=');
                if (x.StartsWith("--") && eq > 0) { inline = x.Substring(eq + 1); x = x.Substring(0, eq); }
                switch (x)
                {
                    case "--name": case "--server": server = inline ?? Next(args, ref i, x); break;
                    case "--tool": tool = inline ?? Next(args, ref i, x); break;
                    case "--full": full = true; break;
                    case "--timeout": timeout = SecondsArg(inline ?? Next(args, ref i, x)); break;
                    default:
                        if (x.StartsWith("--")) throw new ToolError("Unknown option " + args[i] + ".\n" + McpHelp);
                        pos.Add(args[i]);
                        break;
                }
            }
            int k = 0;
            if (server == null && k < pos.Count) server = pos[k++];
            if (tool == null && k < pos.Count) tool = pos[k++];
            if (k < pos.Count) throw new ToolError("Too many values: " + string.Join(" ", pos.Skip(k)) + ".\n" + McpHelp);
            Watchdog(timeout + 60);
            o.WriteLine(McpToolsText(server, tool, full, timeout * 1000).TrimEnd());
            return 0;
        }

        /** aiondx mcp secret NAME: one value from the file's "secrets", with no newline, for a shell variable. */
        static int McpSecretCli(string[] args, StreamWriter o)
        {
            if (args.Length == 4 && args[3] == "--set") return McpSecretSet(args[2], o);
            if (args.Length != 3)
                throw new ToolError("aiondx mcp secret NAME prints one value from the AionDX MCP file's \"secrets\", for a shell variable " +
                                    "($env:X = (& aiondx mcp secret X) in PowerShell, X=\"$(aiondx mcp secret X)\" in bash). Never print it, and never write it anywhere. " +
                                    "aiondx mcp secret NAME --set stores one, encrypted, from standard input.");
            var secrets = McpFileSecrets(McpFileRead());
            string key = secrets.Keys.FirstOrDefault(s => s == args[2]) ?? secrets.Keys.FirstOrDefault(s => string.Equals(s, args[2], StringComparison.OrdinalIgnoreCase));
            string value = key != null ? Unseal(Convert.ToString(secrets[key], Inv), "The secret " + key) : null;
            if (string.IsNullOrEmpty(value))
                throw new ToolError("The AionDX MCP file has no secret named " + args[2] + (secrets.Count > 0 ? "; it has " + string.Join(", ", secrets.Keys) : "") + ".");
            McpUseLog("secret " + key);
            o.Write(value);
            return 0;
        }

        /** aiondx mcp secret NAME --set: the value from standard input (never an argument, which other programs can see),
         *  stored encrypted for this Windows account. Servers use it as ${NAME}. */
        static int McpSecretSet(string name, StreamWriter o)
        {
            if (!Regex.IsMatch(name ?? "", @"^[A-Za-z_][A-Za-z0-9_]{0,63}$"))
                throw new ToolError("A secret's name is letters, digits and underscores, starting with a letter, as servers name it in ${NAME}.");
            string value;
            if (!Console.IsInputRedirected)
            {
                // Typed at a terminal: not shown, and never in the shell's history.
                Console.Error.Write("Value for " + name + " (not shown): ");
                var typed = new StringBuilder();
                for (;;)
                {
                    var k = Console.ReadKey(true);
                    if (k.Key == ConsoleKey.Enter) break;
                    if (k.Key == ConsoleKey.Backspace) { if (typed.Length > 0) typed.Length--; continue; }
                    if (k.KeyChar != '\0') typed.Append(k.KeyChar);
                }
                Console.Error.WriteLine();
                value = typed.ToString();
            }
            else
            {
                using (var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false))) value = input.ReadToEnd();
                value = value.TrimEnd('\r', '\n');
            }
            if (value.Length == 0)
                throw new ToolError("No value came. Run aiondx mcp secret " + name + " --set in a terminal and type it (it is not shown), or pipe it in.");
            string sealedValue = Seal(value);
            McpFileLocked(() =>
            {
                var file = McpFileRead() ?? McpFileTemplate();
                var s = file.ContainsKey("secrets") ? file["secrets"] as Dictionary<string, object> : null;
                if (s == null) { s = new Dictionary<string, object>(); file["secrets"] = s; }
                string have = s.Keys.FirstOrDefault(k => string.Equals(k, name, StringComparison.OrdinalIgnoreCase));
                if (have != null && have != name) s.Remove(have);
                s[name] = sealedValue;
                McpFileWrite(file);
                return true;
            });
            McpUseLog("secret " + name + " set");
            o.WriteLine("Stored " + name + " in the AionDX MCP file, encrypted for this Windows account. Servers use it as ${" + name + "}.");
            return 0;
        }

        // ------------------------------------------------------------------ Claude usage for the agents (1.10.0)
        //
        // a request of October 1st, 2026. The
        // numbers come from Claude's own traffic: AionDX's launcher (patch 0002) starts every Claude session behind a
        // loopback tap that reads the anthropic-ratelimit-unified-* headers of the answers and writes
        //   aiondx.usage.acct.<account key> = { label, at, status, five_hour: {u, reset, status}, seven_day: {...} }
        //   aiondx.usage.conv.<conversation id> = { acct, at }
        // into AionUi's settings store; the usage meter beside the account control shows them to K, and usage_status,
        // `aiondx usage` and one line of loop_status show them to the agent. u is the fraction of the window used
        // (above 1 past the cap); reset is epoch seconds.

        const string UsageHelp =
            "Usage:\n" +
            "  aiondx usage [--all]     your Claude account's usage: the 5-hour and weekly windows, how much is used, when each resets,\n" +
            "                           and whether a limit is reached. --all adds every account AionDX has a reading for.";

        static double Dbl(Dictionary<string, object> d, string k)
        {
            object v;
            if (d == null || !d.TryGetValue(k, out v) || v == null) return double.NaN;
            try { return Convert.ToDouble(v, System.Globalization.CultureInfo.InvariantCulture); } catch (Exception) { return double.NaN; }
        }

        static Dictionary<string, object> Sub(Dictionary<string, object> d, string k)
        {
            object v;
            return d != null && d.TryGetValue(k, out v) ? v as Dictionary<string, object> : null;
        }

        static string Until(long resetSec)
        {
            long left = resetSec * 1000 - NowMs();
            if (left <= 0) return "has reset";
            long mins = (left + 59999) / 60000;
            string span = mins >= 60 ? (mins / 60) + " h" + (mins % 60 > 0 ? " " + (mins % 60) + " min" : "") : mins + " min";
            var when = DateTimeOffset.FromUnixTimeSeconds(resetSec).ToLocalTime();
            bool today = when.Date == DateTimeOffset.Now.Date;
            return "resets " + (today ? when.ToString("HH:mm") : when.ToString("ddd HH:mm", System.Globalization.CultureInfo.InvariantCulture)) + ", in " + span;
        }

        /** One window as a line: "5-hour window: 63% used, resets 12:30, in 2 h 14 min." */
        static string WindowLine(string name, Dictionary<string, object> w)
        {
            double u = Dbl(w, "u");
            if (double.IsNaN(u)) return null;
            long reset = Long(w, "reset");
            bool over = reset > 0 && reset * 1000 < NowMs();
            string st = Str(w, "status");
            return name + ": " + (over ? "reset since the last reading (usage is back to 0% until the next request)" : Math.Round(u * 100) + "% used" +
                   (reset > 0 ? ", " + Until(reset) : "")) + (st == "rejected" && !over ? ". LIMIT REACHED" : st == "allowed_warning" && !over ? ". Close to the limit" : "") + ".";
        }

        static string UsageRecordText(Dictionary<string, object> rec, string who)
        {
            var sb = new StringBuilder();
            long at = Long(rec, "at");
            var five = Sub(rec, "five_hour"); var week = Sub(rec, "seven_day");
            string label = Str(rec, "label");
            sb.Append("Claude usage for ").Append(who).Append(!string.IsNullOrEmpty(label) ? " (" + label + ")" : "").Append(", read ").Append(at > 0 ? Ago(NowMs() - at) + " ago" : "at an unknown time")
              .Append(", from Claude's own traffic:\n");
            foreach (var line in new[] { WindowLine("  5-hour window", five), WindowLine("  Weekly window", week) }) if (line != null) sb.Append(line).Append('\n');
            bool limit = Str(rec, "status") == "rejected" || (five != null && Str(five, "status") == "rejected") || (week != null && Str(week, "status") == "rejected");
            if (limit)
            {
                long r = Math.Max(five != null && Str(five, "status") == "rejected" ? Long(five, "reset") : 0, week != null && Str(week, "status") == "rejected" ? Long(week, "reset") : 0);
                if (r == 0) r = Math.Max(Long(five, "reset"), Long(week, "reset"));
                if (r * 1000 > NowMs())
                    sb.Append("  This account cannot make requests until ").Append(Hhmm(r * 1000)).Append(" (").Append(Until(r)).Append("). Do not retry before then; tell the user.\n");
            }
            return sb.ToString();
        }

        /** usage_status and aiondx usage. */
        static string UsageText(bool all)
        {
            var ctx = LoadContext();
            string convKey = "aiondx.usage.conv." + ctx.Self.ConvId;
            var d = Api("GET", all ? "/api/settings/client" : "/api/settings/client?keys=" + Uri.EscapeDataString(convKey), null) as Dictionary<string, object>;
            var conv = Sub(d, convKey);
            string acct = conv != null ? Str(conv, "acct") : null;
            var sb = new StringBuilder();
            Dictionary<string, object> mine = null;
            if (acct != null)
            {
                string key = "aiondx.usage.acct." + acct;
                if (d == null || !d.ContainsKey(key)) d = Api("GET", "/api/settings/client?keys=" + Uri.EscapeDataString(key), null) as Dictionary<string, object>;
                mine = Sub(d, key);
            }
            if (mine != null) sb.Append(UsageRecordText(mine, ctx.Self.ConvId == null ? "this chat" : "you"));
            else
                sb.Append("No usage reading for this chat yet. It appears after this chat's Claude makes its next request (a chat on another kind of agent has none). ")
                  .Append("AionDX's launcher reads it from Claude's own responses, so nothing is called to get it.\n");
            if (all && d != null)
            {
                int others = 0;
                foreach (var kv in d.Where(x => x.Key.StartsWith("aiondx.usage.acct.", StringComparison.Ordinal)).OrderBy(x => x.Key))
                {
                    if (acct != null && kv.Key == "aiondx.usage.acct." + acct) continue;
                    var rec = kv.Value as Dictionary<string, object>;
                    if (rec == null) continue;
                    if (others++ == 0) sb.Append('\n');
                    sb.Append(UsageRecordText(rec, "another account"));
                }
            }
            return sb.ToString();
        }

        /** One line for loop_status: "Usage: 5-hour 63% (resets 12:30), week 41%." or "", for this chat's own account. */
        static string UsageLine(Ctx ctx)
        {
            try
            {
                string convKey = "aiondx.usage.conv." + ctx.Self.ConvId;
                var d = Api("GET", "/api/settings/client?keys=" + Uri.EscapeDataString(convKey), null) as Dictionary<string, object>;
                var conv = Sub(d, convKey);
                string acct = conv != null ? Str(conv, "acct") : null;
                if (acct == null) return "";
                string key = "aiondx.usage.acct." + acct;
                var rec = Sub(Api("GET", "/api/settings/client?keys=" + Uri.EscapeDataString(key), null) as Dictionary<string, object>, key);
                if (rec == null) return "";
                var five = Sub(rec, "five_hour"); var week = Sub(rec, "seven_day");
                double u5 = Dbl(five, "u"), u7 = Dbl(week, "u");
                bool over5 = Long(five, "reset") * 1000 < NowMs() && Long(five, "reset") > 0;
                var parts = new List<string>();
                if (!double.IsNaN(u5)) parts.Add("5-hour " + (over5 ? "reset" : Math.Round(u5 * 100) + "%" + (Long(five, "reset") > 0 ? " (resets " + Hhmm(Long(five, "reset") * 1000) + ")" : "")));
                if (!double.IsNaN(u7)) parts.Add("week " + Math.Round(u7 * 100) + "%");
                bool limit = Str(rec, "status") == "rejected";
                return "Usage: " + string.Join(", ", parts) + (limit ? ". LIMIT REACHED: do not retry before the window resets" : "") + " (usage_status has the detail).\n";
            }
            catch (Exception) { return ""; }
        }

        static int UsageCli(string[] args, StreamWriter o)
        {
            if (args.Length > 1 && (args[1] == "help" || args[1] == "--help" || args[1] == "-h")) { o.WriteLine(UsageHelp); return 0; }
            try
            {
                bool all = false;
                for (int i = 1; i < args.Length; i++)
                {
                    if (args[i] == "--all") all = true;
                    else throw new ToolError("Unknown option " + args[i] + ".\n" + UsageHelp);
                }
                o.WriteLine(UsageText(all).TrimEnd());
                Log("cli usage ok");
                return 0;
            }
            catch (ToolError e) { o.WriteLine(e.Message); return 1; }
            catch (Exception e) { o.WriteLine("The usage command failed: " + e.Message); return 1; }
        }

        // ------------------------------------------------------------------ GitHub, through git's own sign-in (1.9.0)
        //
        // a request of 2026-09-26. This PC's git signs in to GitHub through Git Credential Manager (the system git
        // config's credential.helper is manager): the sign-in the user's other repositories already push with, so a push
        // needs no token and no MCP server. What an agent could not do on its own was find that out, list the user's
        // repositories, or make a new one. `aiondx github` and the github_status and github_create_repo tools do those
        // with that same sign-in: the token goes from Git Credential Manager to GitHub's API and nowhere else, and is
        // never printed, logged or kept. No sign-in window ever opens (GCM_INTERACTIVE=never).

        const string GitHubHelp =
            "Usage:\n" +
            "  aiondx github [status]                     the GitHub account git on this PC is signed in as, and how to push\n" +
            "  aiondx github repos                        that account's repositories, the latest changed first\n" +
            "  aiondx github create NAME [--public] [--description TEXT]   a new repository, private unless --public\n" +
            "Pushing needs nothing but git: this PC's git signs in to GitHub by itself (Git Credential Manager).";

        sealed class GitHubAuth { public string Login, Token; }

        /** Runs git hidden, never prompting, 30 s at most: exit code, standard output, standard error; null without git. */
        static Tuple<int, string, string> RunGit(string args, string input)
        {
            var env = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (System.Collections.DictionaryEntry e in Environment.GetEnvironmentVariables()) env[Convert.ToString(e.Key, Inv)] = Convert.ToString(e.Value, Inv);
            var git = FindCommand(Environment.GetEnvironmentVariable("AIONDX_GIT") ?? "git", env, null);   // AIONDX_GIT: the tests' stand-in
            if (git == null) return null;
            var psi = new System.Diagnostics.ProcessStartInfo(git, args) {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true,
                RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 };
            psi.EnvironmentVariables["GCM_INTERACTIVE"] = "never";
            psi.EnvironmentVariables["GIT_TERMINAL_PROMPT"] = "0";
            // .NET puts a writer on git's input in the console's input encoding and writes that encoding's byte-order mark
            // into the pipe at once; with a UTF-8 console git then refuses the first line ("credential missing protocol
            // field", measured 2026-09-27). The same code page without the mark while git starts, then as it was.
            Encoding consoleIn = null;
            try { var e = Console.InputEncoding; if (e.GetPreamble().Length > 0) { consoleIn = e; Console.InputEncoding = new UTF8Encoding(false); } }
            catch (Exception) { consoleIn = null; }
            System.Diagnostics.Process p;
            try { p = System.Diagnostics.Process.Start(psi); }
            finally { if (consoleIn != null) { try { Console.InputEncoding = consoleIn; } catch (Exception) { } } }
            try
            {
                var outTask = p.StandardOutput.ReadToEndAsync();
                var errTask = p.StandardError.ReadToEndAsync();
                try
                {
                    var bytes = new UTF8Encoding(false).GetBytes(input ?? "");
                    p.StandardInput.BaseStream.Write(bytes, 0, bytes.Length);
                    p.StandardInput.BaseStream.Flush();
                    p.StandardInput.BaseStream.Close();
                }
                catch (IOException) { }
                if (!p.WaitForExit(30000)) { try { p.Kill(); } catch (Exception) { } return Tuple.Create(-1, "", "git did not answer within 30 s"); }
                return Tuple.Create(p.ExitCode, outTask.Result, errTask.Result);
            }
            finally { try { p.Dispose(); } catch (Exception) { } }   // disposing the writer flushes its mark into the closed pipe
        }

        static string GitValue(string key)
        {
            var r = RunGit("config --get " + key, null);
            return r != null && r.Item1 == 0 ? r.Item2.Trim() : "";
        }

        static string gitHubFillError = "";

        /** The GitHub sign-in git has stored for github.com, or null (gitHubFillError says what git said). */
        static GitHubAuth GitHubSignIn()
        {
            var r = RunGit("credential fill", "protocol=https\nhost=github.com\n\n");
            gitHubFillError = r == null ? "git is not on PATH" : r.Item1 != 0 ? OneLine(r.Item3) : "";
            if (r == null || r.Item1 != 0) return null;
            string login = null, token = null;
            foreach (var raw in r.Item2.Split('\n'))
            {
                var l = raw.TrimEnd('\r');
                if (l.StartsWith("username=", StringComparison.Ordinal)) login = l.Substring(9);
                else if (l.StartsWith("password=", StringComparison.Ordinal)) token = l.Substring(9);
            }
            return string.IsNullOrEmpty(token) ? null : new GitHubAuth { Login = login, Token = token };
        }

        static GitHubAuth RequireGitHub()
        {
            var auth = GitHubSignIn();
            if (auth == null)
                throw new ToolError("git on this PC has no stored GitHub sign-in (credential helper: " + (GitValue("credential.helper").Length > 0 ? GitValue("credential.helper") : "none") +
                                    (gitHubFillError.Length > 0 ? "; git said: " + gitHubFillError : "") +
                                    "). The user signs in once, in a terminal: git credential-manager github login. Nothing else is needed after that.");
            return auth;
        }

        /** One call to GitHub's REST API with the stored sign-in: the status code and the JSON answer (or null). */
        static Tuple<int, object> GitHubApi(GitHubAuth auth, string method, string path, object body)
        {
            try { ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072 | (SecurityProtocolType)12288; }   // TLS 1.2 and 1.3
            catch (NotSupportedException) { try { ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072; } catch (NotSupportedException) { } }
            var api = (Environment.GetEnvironmentVariable("AIONDX_GITHUB_API") ?? "https://api.github.com").TrimEnd('/');   // the tests' stand-in
            var req = (HttpWebRequest)WebRequest.Create(api + path);
            req.Method = method;
            req.UserAgent = "aiondx/" + Version;
            req.Accept = "application/vnd.github+json";
            req.Headers["Authorization"] = "Bearer " + auth.Token;
            req.Timeout = 30000;
            if (body != null)
            {
                var bytes = new UTF8Encoding(false).GetBytes(Json.Serialize(body));
                req.ContentType = "application/json";
                req.ContentLength = bytes.Length;
                using (var s = req.GetRequestStream()) s.Write(bytes, 0, bytes.Length);
            }
            HttpWebResponse resp;
            try { resp = (HttpWebResponse)req.GetResponse(); }
            catch (WebException e)
            {
                resp = e.Response as HttpWebResponse;
                if (resp == null) throw new ToolError("GitHub did not answer: " + OneLine(e.Message));
            }
            using (resp)
            using (var rd = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
            {
                var text = rd.ReadToEnd();
                object json = null;
                try { if (text.Length > 0) json = Json.DeserializeObject(text); } catch (Exception) { }
                return Tuple.Create((int)resp.StatusCode, json);
            }
        }

        static string GitHubMessage(object json)
        {
            var d = json as Dictionary<string, object>;
            var m = d != null ? Str(d, "message") : null;
            return string.IsNullOrEmpty(m) ? "" : ": " + OneLine(m);
        }

        static string PushRecipe(string login, string repo)
        {
            return "To push a folder: git init (when it is not a repository yet); git add -A; git commit -m \"...\"; git branch -M main; " +
                   "git remote add origin https://github.com/" + login + "/" + repo + ".git; git push -u origin main.";
        }

        /** github_status and aiondx github: the account, the commit identity, how to push; with repos, the repositories too. */
        static string GitHubStatusText(bool withRepos)
        {
            var auth = RequireGitHub();
            var me = GitHubApi(auth, "GET", "/user", null);
            if (me.Item1 == 401)
                throw new ToolError("git's stored GitHub sign-in (" + (auth.Login ?? "GitHub") + ") was refused: it has expired or was revoked. The user signs in " +
                                    "again, in a terminal: git credential-manager github login.");
            var user = me.Item2 as Dictionary<string, object>;
            string login = (user != null ? Str(user, "login") : null) ?? auth.Login ?? "?";
            var sb = new StringBuilder();
            sb.Append("GitHub: git on this PC is signed in as ").Append(login).Append(" (Git Credential Manager), so git push to ").Append(login)
              .Append("'s repositories works with nothing else: no token, no MCP server.\n");
            string name = GitValue("user.name"), email = GitValue("user.email");
            sb.Append("Commits are signed ").Append(name.Length > 0 ? name : "(no name)").Append(" <").Append(email.Length > 0 ? email : "no email").Append(">");
            if (name.Length == 0 || email.Length == 0 || Regex.IsMatch(email, @"unconfigured|@null.|.invalid$|.local$", RegexOptions.IgnoreCase))
                sb.Append(", which looks like a placeholder, not the user's. Ask the user which name and email to sign with, then set them in the ")
                  .Append("repository: git config user.name ...; git config user.email ...");
            sb.Append(".\n").Append(PushRecipe(login, "NAME")).Append(" A repository that does not exist yet: aiondx github create NAME (private unless --public).\n");
            if (withRepos) sb.Append('\n').Append(GitHubReposText(auth, login));
            else sb.Append("aiondx github repos lists ").Append(login).Append("'s repositories.\n");
            return sb.ToString();
        }

        static string GitHubReposText(GitHubAuth auth, string login)
        {
            var r = GitHubApi(auth, "GET", "/user/repos?per_page=100&sort=updated&affiliation=owner", null);
            if (r.Item1 != 200) throw new ToolError("GitHub answered " + r.Item1 + " to the list of repositories" + GitHubMessage(r.Item2) + ".");
            var list = (r.Item2 as object[] ?? new object[0]).OfType<Dictionary<string, object>>().ToList();
            var sb = new StringBuilder();
            sb.Append(login).Append("'s repositories, the latest changed first (").Append(list.Count).Append(list.Count == 100 ? ", the first 100" : "").Append("):\n");
            foreach (var x in list)
            {
                string pushed = Str(x, "pushed_at") ?? Str(x, "updated_at") ?? "";
                sb.Append("  - ").Append(Str(x, "name")).Append(Bool(x, "private") == true ? " (private) " : " (public) ").Append(Str(x, "html_url"))
                  .Append(pushed.Length >= 10 ? ", last push " + pushed.Substring(0, 10) : "").Append('\n');
            }
            if (list.Count == 0) sb.Append("  (none)\n");
            return sb.ToString();
        }

        static string GitHubCreate(string name, bool isPublic, string description)
        {
            name = (name ?? "").Trim();
            if (!Regex.IsMatch(name, @"^[A-Za-z0-9._-]{1,100}$"))
                throw new ToolError("A repository name is letters, digits, dot, dash and underscore, up to 100: not \"" + name + "\".");
            var auth = RequireGitHub();
            var body = new Dictionary<string, object> { { "name", name }, { "private", !isPublic } };
            if (!string.IsNullOrWhiteSpace(description)) body["description"] = description.Trim();
            var r = GitHubApi(auth, "POST", "/user/repos", body);
            var d = r.Item2 as Dictionary<string, object>;
            string login = d != null && d.ContainsKey("owner") ? Str(d["owner"] as Dictionary<string, object>, "login") : null;
            login = login ?? auth.Login ?? "?";
            if (r.Item1 == 201)
            {
                // Read back, and put right, what GitHub made: on September 27th, 2026 a repository asked for as private
                // answered private and was public from its first second (its events say PublicEvent at creation).
                bool wantPrivate = !isPublic;
                var check = GitHubApi(auth, "GET", "/repos/" + login + "/" + name, null);
                var cd = check.Item2 as Dictionary<string, object>;
                bool isPrivate = cd != null ? Bool(cd, "private") == true : Bool(d, "private") == true;
                string fixNote = "";
                if (cd != null && isPrivate != wantPrivate)
                {
                    var fix = GitHubApi(auth, "PATCH", "/repos/" + login + "/" + name, new Dictionary<string, object> { { "private", wantPrivate } });
                    var fd = fix.Item2 as Dictionary<string, object>;
                    isPrivate = fd != null && Bool(fd, "private") == true;
                    fixNote = isPrivate == wantPrivate
                        ? " GitHub made it " + (wantPrivate ? "public" : "private") + " at first; it is set right now."
                        : " GitHub made it " + (isPrivate ? "private" : "PUBLIC") + " and would not change it (" + fix.Item1 + "): tell the user.";
                }
                return "Made " + Str(d, "html_url") + (isPrivate ? " (private)" : " (public)") + "." + fixNote + " " + PushRecipe(login, name) + "\n";
            }
            if (r.Item1 == 422 && Json.Serialize(r.Item2 ?? "").IndexOf("already exists", StringComparison.OrdinalIgnoreCase) >= 0)
                return login + " already has a repository named " + name + ": https://github.com/" + login + "/" + name + ". Nothing was made. " + PushRecipe(login, name) + "\n";
            throw new ToolError("GitHub refused the new repository (" + r.Item1 + ")" + GitHubMessage(r.Item2) + ". Nothing was made.");
        }

        static int GitHubCli(string[] args, StreamWriter o)
        {
            string sub = args.Length > 1 ? args[1] : "status";
            if (sub == "help" || sub == "--help" || sub == "-h") { o.WriteLine(GitHubHelp); return 0; }
            try
            {
                if (sub == "status") { if (args.Length > 2) throw new ToolError(GitHubHelp); o.WriteLine(GitHubStatusText(false).TrimEnd()); }
                else if (sub == "repos")
                {
                    if (args.Length > 2) throw new ToolError(GitHubHelp);
                    var auth = RequireGitHub();
                    o.WriteLine(GitHubReposText(auth, auth.Login ?? "?").TrimEnd());
                }
                else if (sub == "create")
                {
                    string name = null, description = null;
                    bool isPublic = false;
                    for (int i = 2; i < args.Length; i++)
                    {
                        var x = args[i];
                        if (x == "--public") isPublic = true;
                        else if (x == "--private") isPublic = false;
                        else if (x == "--description") { if (i + 1 >= args.Length) throw new ToolError("--description needs a value.\n" + GitHubHelp); description = args[++i]; }
                        else if (x.StartsWith("--description=", StringComparison.Ordinal)) description = x.Substring(14);
                        else if (x.StartsWith("-")) throw new ToolError("Unknown option " + x + ".\n" + GitHubHelp);
                        else if (name == null) name = x;
                        else throw new ToolError("One repository at a time: " + x + " is one name too many.\n" + GitHubHelp);
                    }
                    if (name == null) throw new ToolError("Name the repository: aiondx github create NAME.\n" + GitHubHelp);
                    o.WriteLine(GitHubCreate(name, isPublic, description).TrimEnd());
                }
                else throw new ToolError("Unknown command \"github " + sub + "\".\n" + GitHubHelp);
                Log("cli github " + sub + " ok");
                return 0;
            }
            catch (ToolError e) { o.WriteLine(e.Message); Log("cli github " + sub + " error: " + OneLine(e.Message)); return 1; }
            catch (Exception e) { o.WriteLine("The GitHub command failed: " + e.Message); return 1; }
        }

        // ------------------------------------------------------------------ the setup, for an agent (1.7.0)
        //
        // A request of 2026-09-26: a streamlined one-click setup, with Antigravity as the backup, which needs clear instructions
        // (it had handed a tester scripts to run).
        // The Welcome screen's Import runs the setup skill's survey.js and apply.js in AionDX's main process; these two
        // commands run the same scripts for an agent, so the backup follows the same steps with nothing to improvise.
        // They need no Node.js: without it the scripts run on AionDX's (or AionUi's) own Electron as Node.

        const string SetupHelp =
            "Usage:\n" +
            "  aiondx setup scan      what the other AI apps on this PC have: instructions, custom agents, commands, skills and\n" +
            "                         MCP servers (read-only: names, sizes and dates, never a key)\n" +
            "  aiondx setup apply --all [--skip KIND]... [--prefs TEXT | --prefs-file FILE]\n" +
            "  aiondx setup apply --plan FILE\n" +
            "apply copies what the last scan found into ~/.aiondx, writes one set of instructions for every agent into each agent's\n" +
            "own file (backed up first, between AionDX markers), and puts MCP servers in the AionDX MCP file with ${NAME}\n" +
            "placeholders for keys. KIND: agents, commands, prompts, skills, rules, instructions, mcp, wire. The same scan and\n" +
            "import as the Welcome screen's Import button. No Node.js needed.";

        static int SetupCli(string[] args, StreamWriter o)
        {
            string sub = args.Length > 1 ? args[1] : "help";
            if (sub != "scan" && sub != "apply") { o.WriteLine(SetupHelp); return sub == "help" || sub == "--help" || sub == "-h" ? 0 : 2; }
            try
            {
                string scripts = SetupScripts();
                if (scripts == null) throw new ToolError("AionDX's setup files (the aiondx-setup skill's scripts) are not installed; run aiondx doctor.");
                string state = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AionDX", "setup");
                string o2 = Environment.GetEnvironmentVariable("AIONDX_SETUP_STATE");   // the tests' own folder
                if (!string.IsNullOrEmpty(o2)) state = o2;
                Directory.CreateDirectory(state);
                string survey = Path.Combine(state, "survey.json");
                var argv = new List<string>();
                if (sub == "scan")
                {
                    argv.Add(Path.Combine(scripts, "survey.js"));
                    argv.Add("--out");
                    argv.Add(survey);
                }
                else
                {
                    if (!File.Exists(survey)) throw new ToolError("Run aiondx setup scan first: the import uses what the last scan found.");
                    argv.Add(Path.Combine(scripts, "apply.js"));
                    argv.Add("--survey");
                    argv.Add(survey);
                    argv.Add("--text");
                }
                for (int i = 2; i < args.Length; i++) argv.Add(args[i]);
                Watchdog(210);
                var r = RunJs(argv, 150);
                o.Write(r.Item2.EndsWith("\n") ? r.Item2 : r.Item2 + "\n");
                Log((Ident != null ? "conv=" + Ident.ConvId + " " : "") + "cli setup " + sub + " exit " + r.Item1);
                return r.Item1;
            }
            catch (ToolError e) { o.WriteLine(e.Message); return 1; }
            catch (Exception e) { o.WriteLine("The setup command failed: " + e.Message); return 1; }
        }

        /** The setup skill's scripts: beside this program in the installer's payload, the installed app's, or AionUi's skill folder. */
        static string SetupScripts()
        {
            var cands = new List<string>();
            var own = Environment.GetEnvironmentVariable("AIONDX_SETUP_SCRIPTS");   // the tests' own copy
            if (!string.IsNullOrEmpty(own)) cands.Add(own);
            try { cands.Add(Path.Combine(Path.GetDirectoryName(System.Reflection.Assembly.GetEntryAssembly().Location), "..", "skills", "aiondx-setup", "scripts")); } catch (Exception) { }
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), app = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            cands.Add(Path.Combine(local, "Programs", "AionDX", "resources", "aiondx", "skills", "aiondx-setup", "scripts"));
            cands.Add(Path.Combine(app, "AionUi", "aionui", "builtin-skills", "auto-inject", "aiondx-setup", "scripts"));
            foreach (var c in cands)
            {
                try
                {
                    var f = Path.GetFullPath(c);
                    if (File.Exists(Path.Combine(f, "survey.js")) && File.Exists(Path.Combine(f, "apply.js"))) return f;
                }
                catch (Exception) { }
            }
            return null;
        }

        /** Runs a script with Node.js, or with AionDX's or AionUi's own Electron as Node when Node.js is not installed. */
        static Tuple<int, string> RunJs(List<string> argv, int seconds)
        {
            var env = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (System.Collections.DictionaryEntry e in Environment.GetEnvironmentVariables()) env[Convert.ToString(e.Key, Inv)] = Convert.ToString(e.Value, Inv);
            string exe = Environment.GetEnvironmentVariable("AIONDX_SETUP_NO_NODE") == "1" ? null : FindCommand("node", env, null);
            if (exe == null)
            {
                string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                string pf = Environment.GetEnvironmentVariable("ProgramW6432") ?? Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
                var electrons = new List<string>();
                var forced = Environment.GetEnvironmentVariable("AIONDX_SETUP_ELECTRON");   // the tests' stand-in
                if (!string.IsNullOrEmpty(forced)) electrons.Add(forced);
                electrons.Add(Path.Combine(local, "Programs", "AionDX", "AionDX.exe"));
                electrons.Add(Path.Combine(pf, "AionUi", "AionUi.exe"));
                foreach (var c in electrons) if (File.Exists(c)) { exe = c; env["ELECTRON_RUN_AS_NODE"] = "1"; break; }
            }
            if (exe == null) throw new ToolError("Neither Node.js nor AionDX's own app was found to run the setup with.");
            var psi = new System.Diagnostics.ProcessStartInfo(exe, string.Join(" ", argv.Select(a => QuoteArg(a))));
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = new UTF8Encoding(false);
            psi.StandardErrorEncoding = new UTF8Encoding(false);
            psi.EnvironmentVariables.Clear();
            foreach (var kv in env) psi.EnvironmentVariables[kv.Key] = kv.Value;
            Native.KillChildrenWithMe();
            using (var p = System.Diagnostics.Process.Start(psi))
            {
                var outTask = p.StandardOutput.ReadToEndAsync();
                var errTask = p.StandardError.ReadToEndAsync();
                if (!p.WaitForExit(seconds * 1000))
                {
                    try { p.Kill(); } catch (Exception) { }
                    return Tuple.Create(1, "The setup did not finish within " + seconds + " s.");
                }
                p.WaitForExit();
                string text = outTask.Result;
                if (p.ExitCode != 0 && errTask.Result.Trim().Length > 0) text += (text.EndsWith("\n") ? "" : "\n") + errTask.Result.Trim();
                return Tuple.Create(p.ExitCode, text);
            }
        }

        static int Cli(string[] args)
        {
            var o = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
            if (args[0] == "mcp") return McpCli(args, o);
            if (args[0] == "setup") return SetupCli(args, o);
            if (args[0] == "github") return GitHubCli(args, o);
            if (args[0] == "usage") return UsageCli(args, o);
            if (args[0] == "migrate") return MigrateCli(args, o);
            if (args[0] == "stop")
            {
                var sa = new Dictionary<string, object>();
                try
                {
                    for (int i = 1; i < args.Length; i++)
                    {
                        var x = args[i];
                        string inline = null;
                        int eq = x.IndexOf('=');
                        if (x.StartsWith("--") && eq > 0) { inline = x.Substring(eq + 1); x = x.Substring(0, eq); }
                        if (x == "--member") sa["member"] = inline ?? Next(args, ref i, x);
                        else if (x == "--reason") sa["reason"] = inline ?? Next(args, ref i, x);
                        else if (x == "--keep-process") sa["keep_process"] = inline == null || inline != "false";
                        else throw new ToolError("Unknown option " + args[i] + ".\n" + CliHelp);
                    }
                    string text = AgentStop(sa);
                    o.WriteLine(text.TrimEnd());
                    Log((Ident != null ? "conv=" + Ident.ConvId + " " : "") + "cli stop ok member=" + OneLine(Str(sa, "member") ?? ""));
                    return 0;
                }
                catch (ToolError e) { o.WriteLine(e.Message); return 1; }
                catch (Exception e) { o.WriteLine("The stop failed: " + e.Message); return 1; }
            }
            if (args[0] == "priority")
            {
                var pa = new Dictionary<string, object>();
                try
                {
                    for (int i = 1; i < args.Length; i++)
                    {
                        var x = args[i];
                        string inline = null;
                        int eq = x.IndexOf('=');
                        if (x.StartsWith("--") && eq > 0) { inline = x.Substring(eq + 1); x = x.Substring(0, eq); }
                        if (x == "--member") pa["member"] = inline ?? Next(args, ref i, x);
                        else if (x == "--message") pa["message"] = inline ?? Next(args, ref i, x);
                        else throw new ToolError("Unknown option " + args[i] + ".\n" + CliHelp);
                    }
                    string text = PrioritySend(pa);
                    o.WriteLine(text.TrimEnd());
                    Log((Ident != null ? "conv=" + Ident.ConvId + " " : "") + "cli priority ok member=" + OneLine(Str(pa, "member") ?? ""));
                    return 0;
                }
                catch (ToolError e) { o.WriteLine(e.Message); return 1; }
                catch (Exception e) { o.WriteLine("The priority message failed: " + e.Message); return 1; }
            }
            if (args[0] != "loop" || args.Length < 2 || args[1] == "help" || args[1] == "--help" || args[1] == "-h")
            {
                o.WriteLine(CliHelp);
                return args[0] == "loop" && args.Length >= 2 ? 0 : 2;
            }
            var a = new Dictionary<string, object>();
            string sub = args[1];
            try
            {
                for (int i = 2; i < args.Length; i++)
                {
                    var x = args[i];
                    string inline = null;
                    int eq = x.IndexOf('=');
                    if (x.StartsWith("--") && eq > 0) { inline = x.Substring(eq + 1); x = x.Substring(0, eq); }
                    switch (x)
                    {
                        case "--on":
                            if (inline != null) a["on"] = BoolWord(inline, x);
                            else if (i + 1 < args.Length && (args[i + 1] == "true" || args[i + 1] == "false")) a["on"] = args[++i] == "true";
                            else a["on"] = true;
                            break;
                        case "--off": a["on"] = false; break;
                        case "--until-stopped":
                            if (inline != null) a["until_stopped"] = BoolWord(inline, x);
                            else if (i + 1 < args.Length && (args[i + 1] == "true" || args[i + 1] == "false")) a["until_stopped"] = args[++i] == "true";
                            else a["until_stopped"] = true;
                            break;
                        case "--compact": a["compact"] = inline == null || BoolWord(inline, x); break;
                        case "--message": a["message"] = inline ?? Next(args, ref i, x); break;
                        case "--note": a["note"] = inline ?? Next(args, ref i, x); break;
                        case "--hold":
                            {
                                var v = inline ?? Next(args, ref i, x);
                                long h;
                                if (!long.TryParse(v, out h)) throw new ToolError("--hold takes a number of minutes, not \"" + v + "\".");
                                a["hold"] = h;
                                break;
                            }
                        case "--member": a["member"] = inline ?? Next(args, ref i, x); break;
                        case "--resume-at": a["resume_at"] = inline ?? Next(args, ref i, x); break;
                        case "--resume-message": a["resume_message"] = inline ?? Next(args, ref i, x); break;
                        default: throw new ToolError("Unknown option " + args[i] + ".\n" + CliHelp);
                    }
                }
                string text;
                if (sub == "status") text = LoopStatus(a);
                else if (sub == "set") text = LoopSet(a);
                else throw new ToolError("Unknown command \"loop " + sub + "\".\n" + CliHelp);
                o.WriteLine(text.TrimEnd());
                Log((Ident != null ? "conv=" + Ident.ConvId + " " : "") + "cli loop " + sub + " ok" + (sub == "set" ? " args=" + OneLine(Json.Serialize(Redact(a))) : ""));
                return 0;
            }
            catch (ToolError e)
            {
                o.WriteLine(e.Message);
                Log((Ident != null ? "conv=" + Ident.ConvId + " " : "") + "cli loop " + sub + " error: " + OneLine(e.Message));
                return 1;
            }
            catch (Exception e)
            {
                o.WriteLine("The Loop tool failed: " + e.Message);
                return 1;
            }
        }

        static string Next(string[] args, ref int i, string flag)
        {
            if (i + 1 >= args.Length) throw new ToolError(flag + " needs a value.\n" + CliHelp);
            return args[++i];
        }

        static bool BoolWord(string v, string flag)
        {
            if (v == "true") return true;
            if (v == "false") return false;
            throw new ToolError(flag + " takes true or false, not \"" + v + "\".");
        }


        // ------------------------------------------------------------------ doctor (2026-09-26)

        // `aiondx doctor`: puts %LOCALAPPDATA%\AionDX\bin back at the front of the user PATH and reports what
        // AionDX needs. The front matters: AionCore runs whichever `agy` comes first on PATH for Antigravity
        // turns (it ignores the agent's command override there), and Google's `agy install` puts its own
        // folder first. The Welcome screen's Antigravity install line ends with this command. Nothing else
        // is changed. `aiondx doctor --check` only reports.
        [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
        static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);

        static int Doctor(string[] args)
        {
            bool fix = Array.IndexOf(args, "--check") < 0;
            var o = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string bin = Path.Combine(local, "AionDX", "bin");
            int problems = 0;
            o.WriteLine("AionDX doctor " + Version + (fix ? "" : " (check only)"));

            // 1. PATH order.
            try
            {
                string state = PathFirst(bin, fix ? 1 : 0);
                if (state == "first") o.WriteLine("PATH: ok, " + bin + " is first.");
                else if (state == "fixed") o.WriteLine("PATH: fixed, " + bin + " is first now. Restart AionUi so it sees the change.");
                else { o.WriteLine("PATH: " + bin + " is not first (run `aiondx doctor` to fix)."); problems++; }
            }
            catch (Exception e) { o.WriteLine("PATH: could not read or change it: " + e.Message); problems++; }

            // 2. What is installed.
            Action<string, string> have = (label, file) =>
            {
                bool ok = File.Exists(file);
                if (!ok) problems++;
                o.WriteLine(label + ": " + (ok ? file : "missing (" + file + ")"));
            };
            have("Loop tool", Path.Combine(bin, "aiondx-loop.exe"));
            have("Antigravity sign-in wrapper", Path.Combine(bin, "agy.exe"));
            string realAgy = Path.Combine(local, "agy", "bin", "agy.exe");
            o.WriteLine("Antigravity CLI: " + (File.Exists(realAgy) ? realAgy : "not installed (irm https://antigravity.google/cli/install.ps1 | iex)"));
            string manifest = Path.Combine(local, "AionDX", "manifest.user.json");
            if (File.Exists(manifest))
            {
                try
                {
                    var m = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(manifest));
                    var prod = m.ContainsKey("product") ? m["product"] as Dictionary<string, object> : null;
                    o.WriteLine("AionDX installed: " + (prod != null ? Str(prod, "version") + " (build " + Str(prod, "build") + ")" : "?") +
                        ", state " + Str(m, "state") + ", updated " + Str(m, "updatedAtUtc") + " (" + manifest + ")");
                    var comps = m.ContainsKey("components") ? m["components"] as System.Collections.ArrayList : null;
                    int drift = 0;
                    if (comps != null)
                        foreach (var c in comps)
                        {
                            var d = c as Dictionary<string, object>;
                            if (d == null || Str(d, "kind") != "file" || Str(d, "action") == "skipped") continue;
                            string f = Str(d, "path");
                            if (f == null || !File.Exists(f)) { drift++; o.WriteLine("  missing: " + f); }
                            else if (Sha256File(f) != Str(d, "sha256")) { drift++; o.WriteLine("  changed since install: " + f); }
                        }
                    if (drift > 0) { problems++; o.WriteLine("  " + drift + " file(s) differ from the install; `aiondx activate` puts them back."); }
                }
                catch (Exception e) { o.WriteLine("AionDX manifest unreadable: " + e.Message); problems++; }
            }
            else o.WriteLine("AionDX manifest: none (installed by hand, or before the installer existed)");
            string aionui = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "AionUi", "AionUi.exe");
            if (File.Exists(aionui))
            {
                var vi = System.Diagnostics.FileVersionInfo.GetVersionInfo(aionui);
                o.WriteLine("AionUi: " + (vi.ProductVersion ?? vi.FileVersion ?? "?") + " (" + aionui + ")");
            }
            else
            {
                string standaloneExe = null;
                try { using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\AionDX\AionDX")) standaloneExe = k == null ? null : k.GetValue("Exe") as string; } catch (Exception) { }
                if (standaloneExe != null && File.Exists(standaloneExe)) o.WriteLine("AionDX app: " + standaloneExe + " (standalone; no separate AionUi needed)");
                else o.WriteLine("AionUi: not found in Program Files (fine with the standalone AionDX)");
            }
            o.WriteLine(problems == 0 ? "All good." : problems + " thing(s) to look at, listed above.");
            return problems == 0 ? 0 : 1;
        }


        /** Puts bin first on the user PATH. mode 0 only reports. Returns "first", "fixed" or "not first".
         *  The raw value is read without expanding %VARIABLES% and written back in the same kind, so
         *  nothing else in it changes (setx would cut it at 1024 characters and expand every variable). */
        static string PathFirst(string bin, int mode)
        {
            using (var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey("Environment"))
            {
                var names = key.GetValueNames();
                bool has = Array.Exists(names, n => string.Equals(n, "Path", StringComparison.OrdinalIgnoreCase));
                var kind = has ? key.GetValueKind("Path") : Microsoft.Win32.RegistryValueKind.ExpandString;
                string raw = has ? (string)key.GetValue("Path", "", Microsoft.Win32.RegistryValueOptions.DoNotExpandEnvironmentNames) : "";
                var parts = new List<string>();
                foreach (var p in raw.Split(';'))
                {
                    string t = p.Trim();
                    if (t.Length == 0) continue;
                    if (SameDir(Environment.ExpandEnvironmentVariables(t), bin)) continue;
                    parts.Add(t);
                }
                string head = raw.Split(';')[0].Trim();
                if (head.Length > 0 && SameDir(Environment.ExpandEnvironmentVariables(head), bin)) return "first";
                if (mode == 0) return "not first";
                parts.Insert(0, bin);
                key.SetValue("Path", string.Join(";", parts), kind == Microsoft.Win32.RegistryValueKind.ExpandString || raw.Contains("%")
                    ? Microsoft.Win32.RegistryValueKind.ExpandString : Microsoft.Win32.RegistryValueKind.String);
                BroadcastEnvironment();
                return "fixed";
            }
        }
        /** Takes bin out of the user PATH. Returns true when it was there. */
        static bool PathRemove(string bin)
        {
            using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey("Environment", true))
            {
                if (key == null || key.GetValue("Path") == null) return false;
                var kind = key.GetValueKind("Path");
                string raw = (string)key.GetValue("Path", "", Microsoft.Win32.RegistryValueOptions.DoNotExpandEnvironmentNames);
                var keep = new List<string>();
                bool found = false;
                foreach (var p in raw.Split(';'))
                {
                    string t = p.Trim();
                    if (t.Length == 0) continue;
                    if (SameDir(Environment.ExpandEnvironmentVariables(t), bin)) { found = true; continue; }
                    keep.Add(t);
                }
                if (!found) return false;
                key.SetValue("Path", string.Join(";", keep), kind);
                BroadcastEnvironment();
                return true;
            }
        }
        static bool SameDir(string a, string b)
        {
            return string.Equals(a.Trim().Trim('"').TrimEnd('\\'), b.Trim().TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
        }
        static void BroadcastEnvironment()
        {
            UIntPtr res;
            SendMessageTimeout((IntPtr)0xffff, 0x001A, UIntPtr.Zero, "Environment", 0x0002, 1000, out res);
        }


        // ------------------------------------------------------------------ shortcut icons (2026-09-26)

        // Every AionUi*.lnk on the desktop, in the Start menu and pinned to the taskbar gets the AionDX mark
        // (patch 0009's install.js did this on K's machine). Only the icon changes: the shortcut is loaded and
        // saved through WScript.Shell, which keeps its other properties, among them the AppUserModelID that
        // Windows notifications depend on. --common does the all-users desktop and Start menu (Setup runs that
        // part elevated); --reset gives the shortcuts AionUi's own icon back.
        static List<string> ShortcutDirs(bool common)
        {
            var dirs = new List<string>();
            if (common)
            {
                dirs.Add(Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory));
                dirs.Add(Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms));
            }
            else
            {
                dirs.Add(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory));
                dirs.Add(Path.Combine(RealProfile(), "OneDrive", "Desktop"));
                dirs.Add(Environment.GetFolderPath(Environment.SpecialFolder.Programs));
                dirs.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar"));
            }
            return dirs;
        }
        /** Sets (icon) or resets (icon null) the icon of every AionUi shortcut in dirs. Returns how many changed. */
        static int SetShortcutIcons(List<string> dirs, string icon)
        {
            int changed = 0;
            Type wsh = Type.GetTypeFromProgID("WScript.Shell");
            if (wsh == null) { Say("shortcuts: WScript.Shell is not available"); return 0; }
            object shell;
            try { shell = System.Activator.CreateInstance(wsh); }
            catch (Exception e) { Say("shortcuts: WScript.Shell could not start (" + e.Message + ")"); return 0; }
            try
            {
                foreach (var dir in dirs)
                {
                    if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) continue;
                    string[] lnks;
                    try { lnks = Directory.GetFiles(dir, "AionUi*.lnk"); } catch (Exception) { continue; }
                    foreach (var lnk in lnks)
                    {
                        try
                        {
                            object sc = wsh.InvokeMember("CreateShortcut", System.Reflection.BindingFlags.InvokeMethod, null, shell, new object[] { lnk });
                            Type st = sc.GetType();
                            string target = Convert.ToString(st.InvokeMember("TargetPath", System.Reflection.BindingFlags.GetProperty, null, sc, null));
                            if (!target.EndsWith("AionUi.exe", StringComparison.OrdinalIgnoreCase)) { Say("shortcut " + lnk + ": skipped (it opens " + target + ")"); continue; }
                            string want = (icon ?? target) + ",0";
                            string cur = Convert.ToString(st.InvokeMember("IconLocation", System.Reflection.BindingFlags.GetProperty, null, sc, null));
                            if (icon == null && cur.IndexOf("aiondx", StringComparison.OrdinalIgnoreCase) < 0) { Say("shortcut " + lnk + ": not AionDX's icon, left alone"); continue; }
                            if (string.Equals(cur, want, StringComparison.OrdinalIgnoreCase)) { Say("shortcut " + lnk + ": same"); continue; }
                            st.InvokeMember("IconLocation", System.Reflection.BindingFlags.SetProperty, null, sc, new object[] { want });
                            st.InvokeMember("Save", System.Reflection.BindingFlags.InvokeMethod, null, sc, null);
                            Marshal.FinalReleaseComObject(sc);
                            changed++;
                            Say("shortcut " + lnk + ": icon " + want);
                        }
                        catch (Exception e) { Say("shortcut " + lnk + ": not changed (" + (e.InnerException ?? e).Message + ")"); }
                    }
                }
            }
            finally { Marshal.FinalReleaseComObject(shell); }
            if (changed > 0)
            {
                // Explorer caches shortcut icons; this asks it to refresh them.
                try
                {
                    var psi = new System.Diagnostics.ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "ie4uinit.exe"), "-show") { CreateNoWindow = true, UseShellExecute = false };
                    using (var pr = System.Diagnostics.Process.Start(psi)) { pr.WaitForExit(10000); }
                }
                catch (Exception) { }
            }
            return changed;
        }
        static int Shortcuts(string[] args)
        {
            ActQuiet = Array.IndexOf(args, "--quiet") >= 0;
            bool common = Array.IndexOf(args, "--common") >= 0;
            bool reset = Array.IndexOf(args, "--reset") >= 0;
            string icon = null;
            if (!reset)
            {
                icon = ArgValue(args, "--icon");
                if (icon == null)
                {
                    string payload = FindPayload(args);
                    string own = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AionDX", "icons", "aiondx.ico");
                    icon = payload != null && File.Exists(Path.Combine(payload, "icons", "aiondx.ico")) && common
                        ? Path.Combine(payload, "icons", "aiondx.ico") : own;
                }
                if (!File.Exists(icon)) { Say("shortcuts: no icon at " + icon); return 1; }
            }
            int n = SetShortcutIcons(ShortcutDirs(common), icon);
            Say("shortcuts: " + n + " changed");
            return 0;
        }

        // ------------------------------------------------------------------ activate (2026-09-26)

        // `aiondx activate`: the per-user half of the AionDX installer. Research: ! LLM Files\Research\
        // 2026-09-26_installer-and-breadcrumbs.md. Setup (elevated) swaps AionUi's app.asar and then runs this
        // as the signed-in user; the patched AionUi runs it again at every start (patch 0009), which covers a
        // second Windows account, a standard user who elevated with someone else's admin account, an AionCore
        // update that rebuilt its skills folder, and a deleted file. Safe to run any number of times: it
        // changes only what differs from the payload.
        //   payload\bin\*        -> %LOCALAPPDATA%\AionDX\bin. claude.exe and its two scripts only when Claude
        //                          Code is installed, and not when AionDX's launcher already sits in
        //                          %APPDATA%\npm (the developer's own layout, left alone).
        //   payload\skills\<n>\  -> %APPDATA%\AionUi\aionui\builtin-skills\auto-inject\<n>, once AionCore has
        //                          set that folder up (its .version file), so AionCore does not replace it.
        //   the bin folder first on the user PATH.
        // Breadcrumbs for later installers, all rewritten on every run:
        //   HKCU\Software\AionDX\AionDX   SchemaVersion, Version, Build, AionUiTarget, BinDir, PayloadDir,
        //                                 ManifestPath, LogDir, LastLog, PathEntryAdded, State, UpdatedUtc
        //   %LOCALAPPDATA%\AionDX\manifest.user.json   every file with its SHA-256 and size, each skill's tree
        //                                 hash, the PATH entry, and an append-only history of runs
        //   %LOCALAPPDATA%\AionDX\logs\<utc>_user-apply_v<version>.log   one line per action; newest 20 kept
        // `aiondx deactivate` takes it all back out and leaves the manifest, marked removed, as the record.
        // Each run stops at 60 s (a deadline checked between steps; AionUi's start call also kills it at 90).
        const string ManifestSchema = "aiondx.manifest/1";
        static readonly string[] ClaudeParts = { "claude.exe", "claude-account-router.js", "claude-stream-proxy.js" };
        static readonly string[] OwnPrograms = { "aiondx.exe", "aiondx-loop.exe", "agy.exe", "claude.exe", "claude-account-router.js", "claude-stream-proxy.js",
            "claude-account-router.log", "claude-account-router.exe-cache.json" };
        static StreamWriter ActLog;
        static bool ActQuiet;
        static DateTime ActDeadline;

        static void Say(string line)
        {
            if (ActLog != null) { try { ActLog.WriteLine(Utc("yyyy-MM-ddTHH:mm:ss.fffZ") + " " + line); } catch (Exception) { } }
            if (!ActQuiet) Console.Out.WriteLine(line);
        }
        static string Utc(string format) { return DateTime.UtcNow.ToString(format, System.Globalization.CultureInfo.InvariantCulture); }
        static void Deadline(string step)
        {
            if (DateTime.UtcNow > ActDeadline) throw new ToolError("stopped at " + step + ": past the 60 s deadline");
        }
        static string Sha256File(string f)
        {
            using (var sha = System.Security.Cryptography.SHA256.Create())
            using (var st = File.OpenRead(f))
                return BitConverter.ToString(sha.ComputeHash(st)).Replace("-", "").ToLowerInvariant();
        }
        static string Sha256Text(string text)
        {
            using (var sha = System.Security.Cryptography.SHA256.Create())
                return BitConverter.ToString(sha.ComputeHash(new UTF8Encoding(false).GetBytes(text))).Replace("-", "").ToLowerInvariant();
        }
        /** A folder's hash: SHA-256 of its sorted "relative/path<TAB>sha256<LF>" lines. */
        static string TreeSha(string dir)
        {
            var lines = new List<string>();
            foreach (var f in Directory.GetFiles(dir, "*", SearchOption.AllDirectories))
                lines.Add(f.Substring(dir.Length).TrimStart('\\').Replace('\\', '/') + "\t" + Sha256File(f));
            lines.Sort(StringComparer.Ordinal);
            var sb = new StringBuilder();
            foreach (var l in lines) sb.Append(l).Append('\n');
            return Sha256Text(sb.ToString());
        }
        /** TreeSha's format over files held in memory (relative path -> bytes). */
        static string TreeShaOf(SortedDictionary<string, byte[]> files)
        {
            var sb = new StringBuilder();
            using (var sha = System.Security.Cryptography.SHA256.Create())
                foreach (var kv in files)
                    sb.Append(kv.Key).Append('\t').Append(BitConverter.ToString(sha.ComputeHash(kv.Value)).Replace("-", "").ToLowerInvariant()).Append('\n');
            return Sha256Text(sb.ToString());
        }
        /** A skill folder as it belongs on disk: its .md files with {{AIONDX}} replaced by this user's aiondx.exe
         *  (patch 0007 install.js does the same), everything else as it is. */
        static SortedDictionary<string, byte[]> SkillFiles(string dir, string aiondxExe)
        {
            var files = new SortedDictionary<string, byte[]>(StringComparer.Ordinal);
            var utf8 = new UTF8Encoding(false);
            foreach (var f in Directory.GetFiles(dir, "*", SearchOption.AllDirectories))
            {
                string rel = f.Substring(dir.Length).TrimStart('\\').Replace('\\', '/');
                byte[] bytes = File.ReadAllBytes(f);
                if (f.EndsWith(".md", StringComparison.OrdinalIgnoreCase))
                {
                    string text = File.ReadAllText(f, utf8);
                    if (text.IndexOf("{{AIONDX}}", StringComparison.Ordinal) >= 0) bytes = utf8.GetBytes(text.Replace("{{AIONDX}}", aiondxExe));
                }
                files[rel] = bytes;
            }
            return files;
        }
        static void WriteTree(SortedDictionary<string, byte[]> files, string dst)
        {
            if (Directory.Exists(dst)) Directory.Delete(dst, true);
            Directory.CreateDirectory(dst);
            foreach (var kv in files)
            {
                string f = Path.Combine(dst, kv.Key.Replace('/', '\\'));
                Directory.CreateDirectory(Path.GetDirectoryName(f));
                File.WriteAllBytes(f, kv.Value);
            }
        }
        static string ArgValue(string[] args, string name)
        {
            for (int i = 0; i < args.Length - 1; i++) if (args[i] == name) return args[i + 1];
            return null;
        }
        /** The real Windows version. .NET Framework reports "NT 6.2" to a program without a manifest, and
         *  ProductName still says Windows 10 on Windows 11, so the build number decides. */
        static string WindowsVersion()
        {
            try
            {
                using (var k = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion"))
                {
                    string name = (k.GetValue("ProductName") as string) ?? "Windows";
                    string disp = (k.GetValue("DisplayVersion") as string) ?? "";
                    string build = (k.GetValue("CurrentBuild") as string) ?? "?";
                    object ubr = k.GetValue("UBR");
                    int b;
                    if (int.TryParse(build, out b) && b >= 22000 && name.StartsWith("Windows 10")) name = "Windows 11" + name.Substring(10);
                    return name + (disp.Length > 0 ? " " + disp : "") + ", build " + build + (ubr != null ? "." + ubr : "");
                }
            }
            catch (Exception) { return Environment.OSVersion.VersionString; }
        }
        static bool IsElevated()
        {
            try { return new System.Security.Principal.WindowsPrincipal(System.Security.Principal.WindowsIdentity.GetCurrent()).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator); }
            catch (Exception) { return false; }
        }
        /** The real profile folder: AionUi runs some agents with HOME and USERPROFILE pointed elsewhere. */
        static string RealProfile()
        {
            string roaming = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var d = new DirectoryInfo(roaming);
            return d.Parent != null && d.Parent.Parent != null ? d.Parent.Parent.FullName : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        }
        /** Claude Code itself: the native build, the npm one, or a claude on PATH that is not an AionDX launcher. */
        static string RealClaude(string ownBin)
        {
            string roaming = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var fixedOnes = new[] {
                Path.Combine(RealProfile(), ".local", "bin", "claude.exe"),
                Path.Combine(roaming, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")
            };
            foreach (var f in fixedOnes) if (File.Exists(f)) return f;
            foreach (var d in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
            {
                string dir = d.Trim().Trim('"');
                if (dir.Length == 0 || SameDir(dir, ownBin)) continue;
                try
                {
                    if (File.Exists(Path.Combine(dir, "claude-account-router.js"))) continue;
                    foreach (var n in new[] { "claude.exe", "claude.cmd" })
                        if (File.Exists(Path.Combine(dir, n))) return Path.Combine(dir, n);
                }
                catch (ArgumentException) { }
            }
            return null;
        }
        /** payload\user: --payload, or the folder above this program's (Setup runs the payload's own copy), or
         *  the one the last run used. It holds release.json. */
        static string FindPayload(string[] args)
        {
            string p = ArgValue(args, "--payload");
            if (p != null) return Path.GetFullPath(p);
            string up = Path.GetDirectoryName(AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\'));
            if (up != null && File.Exists(Path.Combine(up, "release.json"))) return up;
            using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\AionDX\AionDX"))
            {
                string last = k == null ? null : k.GetValue("PayloadDir") as string;
                if (last != null && File.Exists(Path.Combine(last, "release.json"))) return last;
            }
            return null;
        }
        /** Copies src over dst when they differ. A file in use (a running Loop tool) is renamed out of the
         *  way first: Windows lets a running program's file be renamed, not deleted. */
        static string Place(string src, string dst)
        {
            string want = Sha256File(src);
            if (File.Exists(dst) && Sha256File(dst) == want) return "same";
            string tmp = dst + ".new";
            File.Copy(src, tmp, true);
            if (File.Exists(dst))
            {
                try { File.Delete(dst); }
                catch (Exception) { File.Move(dst, dst + ".old-" + DateTime.UtcNow.Ticks); }
            }
            File.Move(tmp, dst);
            return File.Exists(dst) ? "copied" : "failed";
        }
        static void RemoveFile(string f)
        {
            if (!File.Exists(f)) return;
            try { File.Delete(f); }
            catch (Exception) { File.Move(f, f + ".old-" + DateTime.UtcNow.Ticks); }
        }
        static void CleanOld(string dir)
        {
            if (!Directory.Exists(dir)) return;
            foreach (var f in Directory.GetFiles(dir, "*.old-*")) { try { File.Delete(f); } catch (Exception) { } }
            foreach (var f in Directory.GetFiles(dir, "*.new")) { try { File.Delete(f); } catch (Exception) { } }
        }
        static void CopyTree(string src, string dst)
        {
            if (Directory.Exists(dst)) Directory.Delete(dst, true);
            Directory.CreateDirectory(dst);
            foreach (var d in Directory.GetDirectories(src, "*", SearchOption.AllDirectories))
                Directory.CreateDirectory(Path.Combine(dst, d.Substring(src.Length).TrimStart('\\')));
            foreach (var f in Directory.GetFiles(src, "*", SearchOption.AllDirectories))
                File.Copy(f, Path.Combine(dst, f.Substring(src.Length).TrimStart('\\')), true);
        }
        /** AionCore builds builtin-skills itself (from its own copy, staged in builtin-skills.tmp) whenever its
         *  .version marker is missing or old, replacing the folder. Wait for it to finish, up to 40 s. */
        static bool SkillsReady(string root)
        {
            bool staging0 = Directory.Exists(root + ".tmp") || Directory.Exists(root + ".old");
            if (File.Exists(Path.Combine(root, ".version")) && !staging0) return true;
            bool coreRunning = false;
            try { coreRunning = System.Diagnostics.Process.GetProcessesByName("aioncore").Length > 0; } catch (Exception) { }
            if (!staging0 && !coreRunning) return false;   // nothing is building it (Setup runs before AionDX does)
            var until = DateTime.UtcNow.AddSeconds(40);
            while (true)
            {
                bool staging = Directory.Exists(root + ".tmp") || Directory.Exists(root + ".old");
                if (File.Exists(Path.Combine(root, ".version")) && !staging) return true;
                if (DateTime.UtcNow > until || DateTime.UtcNow > ActDeadline.AddSeconds(-10)) return false;
                Thread.Sleep(1000);
            }
        }
        static Dictionary<string, object> FileComponent(string id, string path, string action)
        {
            var c = new Dictionary<string, object>();
            c["id"] = id; c["scope"] = "user"; c["kind"] = "file"; c["path"] = path; c["action"] = action;
            if (File.Exists(path)) { c["sha256"] = Sha256File(path); c["size"] = new FileInfo(path).Length; }
            return c;
        }

        static int Activate(string[] args, bool remove)
        {
            ActQuiet = Array.IndexOf(args, "--quiet") >= 0;
            using (var gate = new Mutex(false, @"Local\AionDX-activate"))
            {
                bool owned;
                try { owned = gate.WaitOne(remove ? 30000 : 0); }
                catch (AbandonedMutexException) { owned = true; }
                if (!owned)
                {
                    if (!ActQuiet) Console.Out.WriteLine("Another AionDX setup run is in progress; this one has nothing to add.");
                    return 0;
                }
                try { return ActivateOnce(args, remove); }
                finally { gate.ReleaseMutex(); }
            }
        }

        static int ActivateOnce(string[] args, bool remove)
        {
            ActDeadline = DateTime.UtcNow.AddSeconds(60);
            string from = ArgValue(args, "--from") ?? "command line";
            string dx = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AionDX");
            string bin = Path.Combine(dx, "bin");
            string logs = Path.Combine(dx, "logs");
            string manifestPath = Path.Combine(dx, "manifest.user.json");
            string roaming = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            string skillsRoot = Path.Combine(roaming, "AionUi", "aionui", "builtin-skills");
            string payload = FindPayload(args);
            Dictionary<string, object> release = null;
            try { if (payload != null) release = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(payload, "release.json"))); }
            catch (Exception) { release = null; }
            string version = (release != null ? Str(release, "version") : null) ?? "unknown";
            string build = (release != null ? Str(release, "build") : null) ?? "unknown";
            string target = (release != null ? Str(release, "aionui") : null) ?? "unknown";

            Directory.CreateDirectory(logs);
            string logFile = Path.Combine(logs, Utc("yyyy-MM-ddTHHmmss.fffZ") + "_p" + System.Diagnostics.Process.GetCurrentProcess().Id +
                (remove ? "_user-remove_v" : "_user-apply_v") + version + ".log");
            bool standalone = release != null && Str(release, "kind") == "standalone";
            Dictionary<string, object> manifest = null;
            try { if (File.Exists(manifestPath)) manifest = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(manifestPath)); }
            catch (Exception) { manifest = null; }
            var components = new List<object>();
            int changed = 0, failed = 0;
            string result = "ok";
            try
            {
                ActLog = new StreamWriter(logFile, false, new UTF8Encoding(false)) { AutoFlush = true };
                Say("AionDX " + (remove ? "per-user removal" : "per-user setup") + ": aiondx " + Version + ", release " + version + " (build " + build + ") for AionUi " + target + ", started by " + from);
                Say("user " + Environment.UserDomainName + "\\" + Environment.UserName + ", elevated " + IsElevated() + ", " + WindowsVersion() +
                    (Environment.Is64BitOperatingSystem ? ", 64-bit" : ", 32-bit") + ", machine " + Environment.MachineName);
                Say("program " + System.Reflection.Assembly.GetExecutingAssembly().Location);
                Say("payload " + (payload ?? "(none found)") + "; bin " + bin + "; skills " + skillsRoot);

                if (remove)
                {
                    // Programs: everything the last run recorded, then anything else of AionDX's in bin.
                    CleanOld(bin);
                    foreach (var name in OwnPrograms)
                    {
                        string f = Path.Combine(bin, name);
                        if (!File.Exists(f)) continue;
                        try { RemoveFile(f); Say("removed " + f); changed++; }
                        catch (Exception e) { failed++; Say("could not remove " + f + ": " + e.Message); }
                    }
                    try { if (Directory.Exists(bin) && Directory.GetFileSystemEntries(bin).Length == 0) Directory.Delete(bin); } catch (Exception) { }
                    foreach (var name in new[] { "aiondx-loop", "aiondx-setup" })
                    {
                        string d = Path.Combine(skillsRoot, "auto-inject", name);
                        try { if (Directory.Exists(d)) { Directory.Delete(d, true); Say("removed skill " + d); changed++; } }
                        catch (Exception e) { failed++; Say("could not remove skill " + d + ": " + e.Message); }
                    }
                    try { Say(PathRemove(bin) ? "PATH: took " + bin + " out" : "PATH: " + bin + " was not on it"); }
                    catch (Exception e) { failed++; Say("PATH: FAILED " + e.Message); }
                    try { SetShortcutIcons(ShortcutDirs(false), null); } catch (Exception e) { Say("shortcuts: " + e.Message); }
                    string icons = Path.Combine(dx, "icons");
                    if (Directory.Exists(icons)) { try { Directory.Delete(icons, true); Say("removed " + icons); } catch (Exception e) { Say("could not remove " + icons + ": " + e.Message); } }
                    try
                    {
                        using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\AionDX\AionDX", true))
                        {
                            if (k != null)
                            {
                                foreach (var v in new[] { "AionUiTarget", "ActivatorVersion", "BinDir", "ManifestPath", "LastLog", "PathEntryAdded" }) k.DeleteValue(v, false);
                                k.SetValue("State", "user-part-removed");
                                k.SetValue("UpdatedUtc", Utc("yyyy-MM-ddTHH:mm:ssZ"));
                            }
                        }
                        Say("registry: the per-user values in HKCU\\Software\\AionDX\\AionDX removed (the installer's stay until uninstall)");
                    }
                    catch (Exception e) { failed++; Say("registry: FAILED " + e.Message); }
                }
                else
                {
                    if (payload == null || release == null) throw new ToolError("no payload with a release.json (pass --payload DIR)");
                    // 1. Programs.
                    Directory.CreateDirectory(bin);
                    CleanOld(bin);
                    bool devLayout = File.Exists(Path.Combine(roaming, "npm", "claude-account-router.js"));
                    string claude = RealClaude(bin);
                    Say("Claude Code: " + (claude ?? "not installed") + (devLayout ? "; AionDX's Claude launcher already in %APPDATA%\\npm" : ""));
                    foreach (var src in Directory.GetFiles(Path.Combine(payload, "bin")))
                    {
                        Deadline("copying programs");
                        string name = Path.GetFileName(src);
                        string dst = Path.Combine(bin, name);
                        if (Array.IndexOf(ClaudeParts, name.ToLowerInvariant()) >= 0 && (devLayout || claude == null))
                        {
                            Say("skipped " + name + ": " + (devLayout ? "the developer layout has its own" : "Claude Code is not installed; the next start adds it once it is"));
                            components.Add(FileComponent("bin/" + name, dst, "skipped"));
                            continue;
                        }
                        try
                        {
                            string r = Place(src, dst);
                            if (r == "copied") changed++;
                            Say(name + ": " + r);
                            components.Add(FileComponent("bin/" + name, dst, r == "same" ? "unchanged" : "copied"));
                        }
                        catch (Exception e) { failed++; Say(name + ": FAILED " + e.Message); components.Add(FileComponent("bin/" + name, dst, "failed")); }
                    }
                    // 2. Skills, once AionCore has built its folder.
                    Deadline("skills");
                    try
                    {
                    if (SkillsReady(skillsRoot))
                    {
                        Say("AionCore skills folder ready: " + File.ReadAllText(Path.Combine(skillsRoot, ".version")).Trim());
                        string aiondxExe = Path.Combine(bin, "aiondx.exe").Replace('\\', '/');
                        foreach (var dir in Directory.GetDirectories(Path.Combine(payload, "skills")))
                        {
                            Deadline("copying skills");
                            string name = Path.GetFileName(dir);
                            string dst = Path.Combine(skillsRoot, "auto-inject", name);
                            var files = SkillFiles(dir, aiondxExe);
                            string want = TreeShaOf(files);
                            string have = Directory.Exists(dst) ? TreeSha(dst) : null;
                            var c = new Dictionary<string, object>();
                            c["id"] = "skill/" + name; c["scope"] = "user"; c["kind"] = "tree"; c["path"] = dst; c["treeSha256"] = want;
                            try
                            {
                                if (want != have) { WriteTree(files, dst); changed++; Say("skill " + name + ": copied"); c["action"] = "copied"; }
                                else { Say("skill " + name + ": same"); c["action"] = "unchanged"; }
                            }
                            catch (Exception e) { failed++; Say("skill " + name + ": FAILED " + e.Message); c["action"] = "failed"; }
                            components.Add(c);
                        }
                    }
                    else Say("skills: AionCore has not built " + skillsRoot + " yet (AionDX not started since it was installed); its next start adds them");
                    }
                    catch (Exception e) { failed++; Say("skills: FAILED " + e.Message); }
                    // 3. The AionDX mark, and (over an installed AionUi, not in the standalone app, whose own
                    //    AionDX.exe carries it) AionUi's shortcuts in this account wearing it.
                    string iconSrc = Path.Combine(payload, "icons", "aiondx.ico");
                    Deadline("icon");
                    if (File.Exists(iconSrc))
                    try
                    {
                        string iconDir = Path.Combine(dx, "icons");
                        Directory.CreateDirectory(iconDir);
                        string iconDst = Path.Combine(iconDir, "aiondx.ico");
                        string ir = Place(iconSrc, iconDst);
                        if (ir == "copied") changed++;
                        Say("aiondx.ico: " + ir);
                        components.Add(FileComponent("icons/aiondx.ico", iconDst, ir == "same" ? "unchanged" : "copied"));
                        if (!standalone) changed += SetShortcutIcons(ShortcutDirs(false), iconDst);
                    }
                    catch (Exception e) { failed++; Say("icon: FAILED " + e.Message); }
                    // 4. PATH.
                    Deadline("PATH");
                    try
                    {
                        string ps = PathFirst(bin, 1);
                        Say("PATH: " + (ps == "first" ? bin + " already first" : bin + " put first"));
                        if (ps == "fixed") changed++;
                        var pe = new Dictionary<string, object>();
                        pe["id"] = "path-entry"; pe["scope"] = "user"; pe["kind"] = "env-path"; pe["value"] = bin; pe["position"] = "prepend";
                        pe["action"] = ps == "fixed" ? "added" : "unchanged";
                        components.Add(pe);
                    }
                    catch (Exception e) { failed++; Say("PATH: FAILED " + e.Message); }
                    // 5. Registry.
                    try
                    {
                    using (var k = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(@"Software\AionDX\AionDX"))
                    {
                        k.SetValue("SchemaVersion", 1, Microsoft.Win32.RegistryValueKind.DWord);
                        k.SetValue("Version", version);
                        k.SetValue("Build", build);
                        k.SetValue("AionUiTarget", target);
                        k.SetValue("ActivatorVersion", Version);
                        k.SetValue("BinDir", bin);
                        k.SetValue("PayloadDir", payload);
                        k.SetValue("ManifestPath", manifestPath);
                        k.SetValue("LogDir", logs);
                        k.SetValue("LastLog", logFile);
                        k.SetValue("PathEntryAdded", 1, Microsoft.Win32.RegistryValueKind.DWord);
                        k.SetValue("State", failed == 0 ? "applied" : "applied-with-errors");
                        k.SetValue("UpdatedUtc", Utc("yyyy-MM-ddTHH:mm:ssZ"));
                    }
                    Say("registry: HKCU\\Software\\AionDX\\AionDX written");
                    }
                    catch (Exception e) { failed++; Say("registry: FAILED " + e.Message); }
                }
            }
            catch (ToolError e) { result = "error: " + e.Message; failed++; Say("STOPPED: " + e.Message); }
            catch (Exception e) { result = "error: " + e.Message; failed++; Say("FAILED: " + e); }

            // 6. The manifest, whatever happened: the record later installers read.
            try
            {
                string now = Utc("yyyy-MM-ddTHH:mm:ssZ");
                var m = new Dictionary<string, object>();
                m["schema"] = ManifestSchema;
                m["scope"] = "user";
                m["registryView"] = 64;
                var prod = new Dictionary<string, object>();
                prod["name"] = "AionDX"; prod["version"] = version; prod["build"] = build; prod["aionuiTarget"] = target;
                m["product"] = prod;
                var act = new Dictionary<string, object>();
                act["version"] = Version; act["path"] = System.Reflection.Assembly.GetExecutingAssembly().Location;
                m["activator"] = act;
                m["payloadDir"] = payload;
                m["user"] = Environment.UserDomainName + "\\" + Environment.UserName;
                m["installedAtUtc"] = manifest != null && Str(manifest, "installedAtUtc") != null ? Str(manifest, "installedAtUtc") : now;
                m["updatedAtUtc"] = now;
                m["state"] = remove ? "removed" : (failed == 0 ? "applied" : "applied-with-errors");
                m["components"] = remove ? (manifest != null && manifest.ContainsKey("components") ? manifest["components"] : new object[0]) : components.ToArray();
                var history = new List<object>();
                if (manifest != null && manifest.ContainsKey("history") && manifest["history"] is System.Collections.ArrayList)
                    foreach (var h in (System.Collections.ArrayList)manifest["history"]) history.Add(h);
                var entry = new Dictionary<string, object>();
                entry["atUtc"] = now; entry["action"] = remove ? "user-remove" : "user-apply"; entry["from"] = from;
                entry["version"] = version; entry["build"] = build; entry["changed"] = changed; entry["failed"] = failed; entry["result"] = result; entry["log"] = logFile;
                history.Add(entry);
                if (history.Count > 200) history.RemoveRange(0, history.Count - 200);
                m["history"] = history.ToArray();
                string tmp = manifestPath + ".tmp";
                File.WriteAllText(tmp, Json.Serialize(m), new UTF8Encoding(false));
                if (File.Exists(manifestPath)) File.Replace(tmp, manifestPath, null);
                else File.Move(tmp, manifestPath);
                Say("manifest: " + manifestPath);
            }
            catch (Exception e) { failed++; Say("manifest: FAILED " + e.Message); }

            Say((failed == 0 ? "done" : "done with " + failed + " problem(s)") + ": " + changed + " change(s). Log: " + logFile);
            if (ActLog != null) { try { ActLog.Dispose(); } catch (Exception) { } ActLog = null; }
            // The newest 20 logs stay.
            try
            {
                var own = new List<string>(Directory.GetFiles(logs, "*_user-apply_v*.log"));
                own.AddRange(Directory.GetFiles(logs, "*_user-remove_v*.log"));
                var all = own.ToArray();
                Array.Sort(all, StringComparer.Ordinal);
                for (int i = 0; i < all.Length - 20; i++) { try { File.Delete(all[i]); } catch (Exception) { } }
            }
            catch (Exception) { }
            return failed == 0 ? 0 : 1;
        }


        // ------------------------------------------------------------------ priority messages (2026-09-26, 1.3.0)

        // A team lead, in its team's log (September 26th): "is there value in a lighter-weight 'priority'
        // flag on team_send_message itself for messages that genuinely cannot wait (a stop instruction, a
        // correction to something actively wrong), so the lead does not need to reach for a full
        // turn-interrupt just to avoid the queue-order problem?" a request.
        // AionCore's coordinator serves a teammate's queue by lane: foreground (the user's messages) first,
        // then control, directed (agents' team_send_message) and background (aionui-team work_coordinator,
        // tests.rs priority_lanes_claim_foreground_then_control_then_directed_then_background). The user's route
        // to a member, POST /api/teams/{id}/agents/{slot}/messages, enqueues foreground work and does not touch
        // the running turn (session.rs enqueue_user_message). The runtime token signs this program in as the
        // user, so a lead's priority message goes through that route, marked as the lead's.
        const string PriorityTag = "[Priority message from {0}, the team lead, sent with AionDX ahead of your queued work] ";
        const int QueueWarn = 20;   // aionui-dx.js QUEUE_WARN

        static string PrioritySend(Dictionary<string, object> a)
        {
            string member = (Str(a, "member") ?? "").Trim();
            string message = Str(a, "message") ?? "";
            if (member.Length == 0) throw new ToolError("member is required: the teammate's name, slot id or conversation id.");
            if (member.Equals("all", StringComparison.OrdinalIgnoreCase)) throw new ToolError("A priority message goes to one teammate at a time: name one.");
            if (message.Trim().Length == 0) throw new ToolError("message is required: what to tell the teammate.");
            if (message.Length > 8000) throw new ToolError("A priority message is limited to 8000 characters; this one has " + message.Length + ".");
            var ctx = LoadContext();
            if (ctx.Self.Kind != "team") throw new ToolError("Priority messages are for teams, and this chat is not on one.");
            if (ctx.Self.Role != "lead") throw new ToolError("Only the team lead can send a priority message. Use team_send_message.");
            var t = Resolve(ctx, member, true)[0];
            if (t.ConvId == ctx.Self.ConvId) throw new ToolError("That is you. A priority message goes to a teammate.");
            var body = new Dictionary<string, object> { { "content", string.Format(PriorityTag, ctx.Self.Name ?? "the lead") + message } };
            Api("POST", "/api/teams/" + Uri.EscapeDataString(t.TeamId) + "/agents/" + Uri.EscapeDataString(t.SlotId) + "/messages", Json.Serialize(body));
            var w = SlotWork(t);
            bool busy = w != null && (Str(w, "state") == "running" || Str(w, "state") == "starting" || Str(w, "active_turn_id") != null);
            var sb = new StringBuilder();
            sb.Append("Sent to ").Append(t.Name ?? t.SlotId).Append(" as a priority message. It goes ahead of everything queued for it and is the next thing it reads")
              .Append(busy ? " when the turn it is in ends (to stop that turn now, use team_interrupt_agent)" : "").Append(".\n");
            if (w != null) sb.Append(QueueLine(t, w));
            return sb.ToString();
        }

        // ------------------------------------------------------------------ moving from AionUi to AionDX (2026-10-01, 1.12.0)

        // a request of 2026-10-01. AionDX is AionUi's own app with patches, and it keeps its chats, settings and
        // agents in the same folder, %APPDATA%\AionUi. Moving therefore means taking the AionUi program off the PC and leaving that
        // folder where it is. The one risk is the removal touching the folder, so the parts that matter (the chats database, the
        // settings, the custom assistants) are copied first and checked, AionUi's own uninstaller is run silently (it keeps app data
        // unless it was built to delete it; AionUi's electron-builder config does not), and the database is checked again afterwards.
        // The installer (installer\aiondx.iss) asks first and runs `aiondx migrate run`; the same command works from a shell.
        //
        //   aiondx migrate detect                       is AionUi here, where, which version, what is in its data folder
        //   aiondx migrate run [--no-backup]            back up, remove AionUi, check the chats are intact
        //   aiondx migrate backup --to DIR              only the backup
        //   aiondx migrate verify --backup DIR          compare the data folder with a backup
        // A machine-wide AionUi (C:\Program Files) needs an administrator: the removal step runs once more as an elevated copy of this
        // program (one Windows prompt); declining it leaves AionUi where it was and nothing else changed.

        sealed class AionUiInstall { public string Dir, Version, Scope, Uninstaller, UninstallArgs, Source; }

        static System.IO.StreamWriter MOut;
        static string MLogFile;

        static void MSay(string line)
        {
            try { if (MOut != null) MOut.WriteLine(line); } catch (Exception) { }
            if (MLogFile != null)
            {
                try { File.AppendAllText(MLogFile, DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ") + " [migrate] " + line + "\n", new UTF8Encoding(false)); } catch (Exception) { }
            }
            Log("migrate: " + line);
        }

        static string MOpt(Dictionary<string, string> o, string key) { string v; return o.TryGetValue(key, out v) ? v : null; }

        static Dictionary<string, string> MParse(string[] args, int from)
        {
            var o = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (int i = from; i < args.Length; i++)
            {
                string a = args[i];
                if (!a.StartsWith("--")) throw new ToolError("Unexpected \"" + a + "\".\n" + MigrateHelp);
                string k = a.Substring(2);
                int eq = k.IndexOf('=');
                if (eq > 0) { o[k.Substring(0, eq)] = k.Substring(eq + 1); continue; }
                if (i + 1 < args.Length && !args[i + 1].StartsWith("--")) { o[k] = args[++i]; }
                else o[k] = "true";
            }
            return o;
        }

        const string MigrateHelp =
            "Usage:\n" +
            "  aiondx migrate detect [--dir DIR] [--data DIR]       find AionUi and say what is in its data folder\n" +
            "  aiondx migrate run [--no-backup] [--backup-dir DIR] [--no-elevate] [--log FILE] [--result FILE]\n" +
            "                                                       back up the chats and settings, remove AionUi, check they are intact\n" +
            "  aiondx migrate backup --to DIR [--data DIR]          copy the chats database, settings and custom assistants\n" +
            "  aiondx migrate verify --backup DIR [--data DIR]      compare the data folder with a backup\n" +
            "The data folder is %APPDATA%\\AionUi (--data or AIONDX_AIONUI_DATA to point elsewhere). Exit codes for run: 0 moved, 2 AionUi not found, " +
            "3 the administrator prompt was declined, 4 AionUi is running, 5 the backup failed (nothing was removed), 6 the removal failed, " +
            "7 the chats database changed during the removal (the backup, if one was taken, is named).";

        static string AionUiData(string given)
        {
            if (!string.IsNullOrEmpty(given)) return given;
            string env = Environment.GetEnvironmentVariable("AIONDX_AIONUI_DATA");
            if (!string.IsNullOrEmpty(env)) return env;
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "AionUi");
        }

        static string MigrateDb(string data) { return Path.Combine(data, @"aionui\aionui-backend.db"); }

        static void ParseUninstallString(string us, out string exe, out string args)
        {
            exe = null; args = "";
            if (string.IsNullOrEmpty(us)) return;
            us = us.Trim();
            if (us.StartsWith("\""))
            {
                int q = us.IndexOf('"', 1);
                if (q > 0) { exe = us.Substring(1, q - 1); args = us.Substring(q + 1).Trim(); }
                return;
            }
            int e = us.ToLowerInvariant().IndexOf(".exe", StringComparison.Ordinal);
            if (e > 0) { exe = us.Substring(0, e + 4); args = us.Substring(e + 4).Trim(); }
        }

        static AionUiInstall InstallFrom(string exe, string args, string loc, string version, string hiveScope, string source)
        {
            string dir = !string.IsNullOrEmpty(loc) && Directory.Exists(loc) ? loc : (exe != null ? Path.GetDirectoryName(exe) : null);
            // A registry entry for a program that is gone is not an install.
            if (dir == null || !File.Exists(Path.Combine(dir, "AionUi.exe"))) return null;
            var i = new AionUiInstall { Dir = dir, Source = source };
            string u = exe != null && File.Exists(exe) ? exe : Path.Combine(dir, "Uninstall AionUi.exe");
            i.Uninstaller = File.Exists(u) ? u : null;
            string a = (args ?? "").ToLowerInvariant();
            i.Scope = a.Contains("/allusers") ? "machine" : a.Contains("/currentuser") ? "user" : hiveScope;
            i.UninstallArgs = i.Scope == "machine" ? "/allusers" : "/currentuser";
            i.Version = version;
            if (string.IsNullOrEmpty(i.Version))
            {
                try { i.Version = System.Diagnostics.FileVersionInfo.GetVersionInfo(Path.Combine(dir, "AionUi.exe")).ProductVersion; } catch (Exception) { i.Version = ""; }
            }
            return i;
        }

        /** AionUi's install: the one named (--dir), else the Windows uninstall list (all users, then this user), else the usual folders. */
        static AionUiInstall FindAionUi(string dirGiven, string uninstallerGiven)
        {
            if (!string.IsNullOrEmpty(dirGiven))
                return InstallFrom(uninstallerGiven, "", dirGiven, null, dirGiven.IndexOf("Program Files", StringComparison.OrdinalIgnoreCase) >= 0 ? "machine" : "user", "given");
            var hives = new[] { Microsoft.Win32.RegistryHive.LocalMachine, Microsoft.Win32.RegistryHive.CurrentUser };
            var views = new[] { Microsoft.Win32.RegistryView.Registry64, Microsoft.Win32.RegistryView.Registry32 };
            foreach (var hive in hives)
            {
                foreach (var view in views)
                {
                    try
                    {
                        using (var b = Microsoft.Win32.RegistryKey.OpenBaseKey(hive, view))
                        using (var k = b.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"))
                        {
                            if (k == null) continue;
                            foreach (var name in k.GetSubKeyNames())
                            {
                                using (var s = k.OpenSubKey(name))
                                {
                                    if (s == null) continue;
                                    var dn = s.GetValue("DisplayName") as string;
                                    if (dn == null || !dn.Equals("AionUi", StringComparison.OrdinalIgnoreCase)) continue;
                                    string exe, args;
                                    ParseUninstallString(s.GetValue("UninstallString") as string, out exe, out args);
                                    var found = InstallFrom(exe, args, s.GetValue("InstallLocation") as string, s.GetValue("DisplayVersion") as string,
                                        hive == Microsoft.Win32.RegistryHive.LocalMachine ? "machine" : "user", "the Windows uninstall list");
                                    if (found != null) return found;
                                }
                            }
                        }
                    }
                    catch (Exception) { }
                }
            }
            var folders = new[] {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "AionUi"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\AionUi") };
            foreach (var f in folders)
            {
                var found = InstallFrom(null, "", f, null, f.StartsWith(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), StringComparison.OrdinalIgnoreCase) ? "machine" : "user", "its usual folder");
                if (found != null) return found;
            }
            return null;
        }

        /** AionUi is running when AionUi.exe is, or a program from its folder (its AionCore, its agents). */
        static int AionUiRunning(string dir)
        {
            int n = 0;
            string d = dir == null ? null : dir.TrimEnd('\\') + "\\";
            foreach (var p in System.Diagnostics.Process.GetProcesses())
            {
                try
                {
                    bool named = p.ProcessName.Equals("AionUi", StringComparison.OrdinalIgnoreCase);
                    string path = null;
                    try { path = p.MainModule.FileName; } catch (Exception) { path = null; }
                    // A program from this install's folder, or an AionUi whose folder cannot be read (counted: better to ask to close it).
                    if (path != null ? (d != null && path.StartsWith(d, StringComparison.OrdinalIgnoreCase)) : named) n++;
                }
                catch (Exception) { }
                finally { p.Dispose(); }
            }
            return n;
        }

        static bool IsAdmin()
        {
            try { return new System.Security.Principal.WindowsPrincipal(System.Security.Principal.WindowsIdentity.GetCurrent()).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator); }
            catch (Exception) { return false; }
        }

        static string Hex(byte[] b) { var sb = new StringBuilder(); foreach (var x in b) sb.Append(x.ToString("x2")); return sb.ToString(); }

        static string HashFile(string path)
        {
            using (var sha = System.Security.Cryptography.SHA256.Create())
            using (var f = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                return Hex(sha.ComputeHash(f));
        }

        /** Copy a file, returning the SHA-256 of what was read. Shared read, so a database a stopped program left open is still readable. */
        static string CopyHashed(string src, string dst)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(dst));
            using (var sha = System.Security.Cryptography.SHA256.Create())
            using (var fi = new FileStream(src, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var fo = new FileStream(dst, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                var buf = new byte[4 * 1024 * 1024];
                int n;
                while ((n = fi.Read(buf, 0, buf.Length)) > 0) { sha.TransformBlock(buf, 0, n, null, 0); fo.Write(buf, 0, n); }
                sha.TransformFinalBlock(new byte[0], 0, 0);
                return Hex(sha.Hash);
            }
        }

        // What a move must not lose: the chats database (and its journal files), the settings, the custom assistants and the app's own
        // preferences. Caches, logs and the older copies AionUi's own tools left beside the database are not copied.
        static readonly string[] MigratePaths = {
            @"aionui\aionui-backend.db", @"aionui\aionui-backend.db-wal", @"aionui\aionui-backend.db-shm", @"aionui\assistant-rules",
            "config", "Local Storage", "Session Storage", "Preferences", "Local State", "auth.enc", "device-id.json" };

        static void WalkFiles(string dir, List<string> into)
        {
            try
            {
                foreach (var f in Directory.GetFiles(dir)) into.Add(f);
                foreach (var d in Directory.GetDirectories(dir)) WalkFiles(d, into);
            }
            catch (Exception) { }
        }

        /** The files a backup would copy, as paths relative to the data folder. */
        static List<string> MigrateFiles(string data)
        {
            var rel = new List<string>();
            foreach (var p in MigratePaths)
            {
                string full = Path.Combine(data, p);
                if (File.Exists(full)) rel.Add(p);
                else if (Directory.Exists(full))
                {
                    var all = new List<string>();
                    WalkFiles(full, all);
                    foreach (var f in all) rel.Add(f.Substring(data.TrimEnd('\\').Length + 1));
                }
            }
            return rel;
        }

        static string Mb(long bytes) { return bytes >= 1024L * 1024 * 1024 ? (bytes / 1073741824.0).ToString("0.0") + " GB" : Math.Max(1, bytes / 1048576).ToString() + " MB"; }

        /** Copy the parts that matter to `dest`, check them, and write backup.json. Throws ToolError with the reason when it cannot. */
        static Dictionary<string, object> MigrateBackup(string data, string dest, string aionuiVersion)
        {
            if (!Directory.Exists(data)) throw new ToolError("AionUi's data folder " + data + " does not exist.");
            var rel = MigrateFiles(data);
            long total = 0;
            foreach (var r in rel) { try { total += new FileInfo(Path.Combine(data, r)).Length; } catch (Exception) { } }
            string root = Path.GetPathRoot(Path.GetFullPath(dest));
            long free;
            try { free = new DriveInfo(root).AvailableFreeSpace; } catch (Exception) { free = long.MaxValue; }
            long need = total + total / 20 + 64L * 1048576;
            if (free < need)
                throw new ToolError("There is not enough room for a backup: it needs " + Mb(need) + " on " + root + " and " + Mb(free) + " is free. Free some space, or move without a backup.");
            Directory.CreateDirectory(dest);
            MSay("backing up " + rel.Count + " file(s), " + Mb(total) + ", to " + dest);
            var files = new List<object>();
            foreach (var r in rel)
            {
                string src = Path.Combine(data, r), dst = Path.Combine(dest, r);
                bool db = r.Equals(@"aionui\aionui-backend.db", StringComparison.OrdinalIgnoreCase);
                long len = new FileInfo(src).Length;
                string h = null;
                if (db) MSay("copying the chats database (" + Mb(len) + ")");
                try
                {
                    h = CopyHashed(src, dst);
                    if (new FileInfo(dst).Length != len) throw new ToolError("the copy of " + r + " has a different size from the original");
                    if (db && HashFile(dst) != h) throw new ToolError("the copy of the chats database does not match the original");
                }
                catch (ToolError) { throw; }
                catch (Exception e) { throw new ToolError("could not copy " + r + " (" + e.Message + ")"); }
                files.Add(new Dictionary<string, object> { { "path", r }, { "bytes", len }, { "sha256", h } });
            }
            var m = new Dictionary<string, object> {
                { "schema", "aiondx.migration-backup/1" }, { "createdUtc", DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ") }, { "from", data },
                { "aionuiVersion", aionuiVersion ?? "" }, { "bytes", total }, { "files", files } };
            File.WriteAllText(Path.Combine(dest, "backup.json"), Json.Serialize(m), new UTF8Encoding(false));
            MSay("backup done and checked: " + files.Count + " file(s)");
            return m;
        }

        /** Compare the data folder with a backup manifest: every file still there with the same size, and the database with the same hash. */
        static List<string> MigrateCompare(string data, Dictionary<string, object> manifest)
        {
            var problems = new List<string>();
            // A manifest just built is a List<object>; one read back from backup.json is an object[]. Both are enumerable.
            var files = manifest["files"] as System.Collections.IEnumerable;
            if (files == null) { problems.Add("the backup lists no files"); return problems; }
            foreach (object item in files)
            {
                var f = item as Dictionary<string, object>;
                if (f == null) continue;
                string r = Convert.ToString(f["path"]);
                long bytes = Convert.ToInt64(f["bytes"]);
                string full = Path.Combine(data, r);
                if (!File.Exists(full)) { problems.Add(r + " is missing"); continue; }
                if (new FileInfo(full).Length != bytes) { problems.Add(r + " has a different size"); continue; }
                if (r.Equals(@"aionui\aionui-backend.db", StringComparison.OrdinalIgnoreCase) && HashFile(full) != Convert.ToString(f["sha256"])) problems.Add("the chats database has changed");
            }
            return problems;
        }

        static void MResult(string resultFile, string status, string message, string backup)
        {
            MSay("result: " + status + (message.Length > 0 ? ": " + message : ""));
            if (string.IsNullOrEmpty(resultFile)) return;
            try { File.WriteAllText(resultFile, "status=" + status + "\nmessage=" + message.Replace("\r", " ").Replace("\n", " ") + "\nbackup=" + (backup ?? "") + "\n", new UTF8Encoding(false)); } catch (Exception) { }
        }

        /** Run AionUi's own uninstaller silently and wait for it. `_?=` makes an NSIS uninstaller run in place, so this can wait for it; it
         *  also leaves the uninstaller and its folder, which are removed here. Runs elevated for a machine-wide install. */
        static int UninstallStep(AionUiInstall inst, string resultFile)
        {
            string args = "/S " + inst.UninstallArgs + " _?=" + inst.Dir;
            MSay("running " + inst.Uninstaller + " " + args);
            var psi = new System.Diagnostics.ProcessStartInfo(inst.Uninstaller, args) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Path.GetTempPath() };
            using (var p = System.Diagnostics.Process.Start(psi))
            {
                if (!p.WaitForExit(10 * 60 * 1000))
                {
                    try { p.Kill(); } catch (Exception) { }
                    MResult(resultFile, "uninstall-failed", "AionUi's uninstaller did not finish in 10 minutes.", null);
                    return 6;
                }
                if (p.ExitCode != 0)
                {
                    MResult(resultFile, "uninstall-failed", "AionUi's uninstaller stopped with exit code " + p.ExitCode + ".", null);
                    return 6;
                }
            }
            try { File.Delete(inst.Uninstaller); } catch (Exception) { }
            try { if (Directory.Exists(inst.Dir) && Directory.GetFileSystemEntries(inst.Dir).Length == 0) Directory.Delete(inst.Dir); } catch (Exception) { }
            if (File.Exists(Path.Combine(inst.Dir, "AionUi.exe")))
            {
                MResult(resultFile, "uninstall-failed", "AionUi's uninstaller finished but AionUi.exe is still there.", null);
                return 6;
            }
            MResult(resultFile, "removed", "AionUi was removed from " + inst.Dir + ".", null);
            return 0;
        }

        /** The removal as an elevated copy of this program (one Windows prompt). 3 when the prompt was declined. */
        static int ElevatedUninstall(AionUiInstall inst, out string status, out string message)
        {
            status = ""; message = "";
            string self = System.Reflection.Assembly.GetExecutingAssembly().Location;
            string rf = Path.Combine(Path.GetTempPath(), "aiondx-migrate-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".result");
            string a = "migrate uninstall-step --dir " + QuoteArg(inst.Dir) + " --uninstaller " + QuoteArg(inst.Uninstaller) + " --scope " + inst.Scope +
                       " --uninstall-args " + QuoteArg(inst.UninstallArgs) + " --result " + QuoteArg(rf);
            var psi = new System.Diagnostics.ProcessStartInfo(self, a) { UseShellExecute = true, Verb = "runas", WindowStyle = System.Diagnostics.ProcessWindowStyle.Hidden };
            try
            {
                MSay("asking Windows for administrator rights to remove the machine-wide AionUi");
                using (var p = System.Diagnostics.Process.Start(psi)) { p.WaitForExit(11 * 60 * 1000); }
            }
            catch (System.ComponentModel.Win32Exception e)
            {
                if (e.NativeErrorCode == 1223) { status = "declined"; message = "The administrator prompt was declined, so AionUi was not removed."; return 3; }
                throw;
            }
            if (!File.Exists(rf)) { status = "uninstall-failed"; message = "The removal did not report back."; return 6; }
            foreach (var line in File.ReadAllLines(rf))
            {
                if (line.StartsWith("status=")) status = line.Substring(7);
                else if (line.StartsWith("message=")) message = line.Substring(8);
            }
            try { File.Delete(rf); } catch (Exception) { }
            return status == "removed" ? 0 : 6;
        }

        static int MigrateRun(Dictionary<string, string> o)
        {
            string resultFile = MOpt(o, "result");
            string data = AionUiData(MOpt(o, "data"));
            var inst = FindAionUi(MOpt(o, "dir"), MOpt(o, "uninstaller"));
            if (inst == null) { MResult(resultFile, "not-found", "AionUi is not installed on this PC, so there is nothing to remove. Your chats in " + data + " stay where they are.", null); return 2; }
            MSay("AionUi " + inst.Version + " at " + inst.Dir + " (" + inst.Scope + ", from " + inst.Source + ")");
            if (inst.Uninstaller == null) { MResult(resultFile, "uninstall-failed", "AionUi's uninstaller (Uninstall AionUi.exe) is missing from " + inst.Dir + ".", null); return 6; }
            int running = AionUiRunning(inst.Dir);
            if (running > 0) { MResult(resultFile, "running", "AionUi is running (" + running + " process" + (running == 1 ? "" : "es") + "). Close it, then run this again.", null); return 4; }

            string db = MigrateDb(data);
            bool haveDb = File.Exists(db);
            long dbLen = haveDb ? new FileInfo(db).Length : 0;
            string backupDir = null;
            Dictionary<string, object> manifest = null;
            if (MOpt(o, "no-backup") != null) MSay("no backup, as asked");
            else if (!haveDb) MSay("there is no chats database in " + data + ", so there is nothing to back up");
            else
            {
                backupDir = MOpt(o, "backup-dir");
                if (string.IsNullOrEmpty(backupDir))
                    backupDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"AionDX\migration", DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + "-from-AionUi");
                try { manifest = MigrateBackup(data, backupDir, inst.Version); }
                catch (ToolError e) { MResult(resultFile, "backup-failed", "The backup failed: " + e.Message + " AionUi was not touched.", null); return 5; }
                catch (Exception e) { MResult(resultFile, "backup-failed", "The backup failed: " + e.Message + " AionUi was not touched.", null); return 5; }
            }
            string dbHash = haveDb && manifest == null ? HashFile(db) : null;

            int rc;
            string status, message;
            if (inst.Scope == "machine" && !IsAdmin() && MOpt(o, "no-elevate") == null) rc = ElevatedUninstall(inst, out status, out message);
            else
            {
                string tmp = Path.Combine(Path.GetTempPath(), "aiondx-migrate-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".result");
                rc = UninstallStep(inst, tmp);
                status = ""; message = "";
                try { foreach (var line in File.ReadAllLines(tmp)) { if (line.StartsWith("status=")) status = line.Substring(7); else if (line.StartsWith("message=")) message = line.Substring(8); } File.Delete(tmp); } catch (Exception) { }
            }
            if (rc != 0)
            {
                MResult(resultFile, status, message + " Your chats and settings were not touched" + (backupDir != null ? "; the backup is in " + backupDir : "") + ".", backupDir);
                return rc;
            }

            // The chats must be exactly as they were.
            if (haveDb)
            {
                var problems = new List<string>();
                if (manifest != null) problems = MigrateCompare(data, manifest);
                else
                {
                    if (!File.Exists(db)) problems.Add("the chats database is missing");
                    else if (new FileInfo(db).Length != dbLen || HashFile(db) != dbHash) problems.Add("the chats database has changed");
                }
                if (problems.Count > 0)
                {
                    MResult(resultFile, "data-changed", "AionUi was removed, but its data folder is not as it was: " + string.Join("; ", problems.ToArray()) + "." +
                        (backupDir != null ? " The backup is in " + backupDir + "." : ""), backupDir);
                    return 7;
                }
                MSay("the chats database is intact (" + Mb(dbLen) + ")");
            }
            MResult(resultFile, "migrated", "AionUi " + inst.Version + " was removed. Your chats and settings in " + data + " stay, and AionDX opens them." +
                (backupDir != null ? " A copy of the chats database and settings is in " + backupDir + "." : ""), backupDir);
            return 0;
        }

        static int MigrateCli(string[] args, StreamWriter o)
        {
            MOut = o;
            if (args.Length < 2 || args[1] == "help" || args[1] == "--help" || args[1] == "-h") { o.WriteLine(MigrateHelp); return args.Length < 2 ? 2 : 0; }
            try
            {
                string sub = args[1];
                var opt = MParse(args, 2);
                MLogFile = MOpt(opt, "log");
                string data = AionUiData(MOpt(opt, "data"));
                if (sub == "detect")
                {
                    var inst = FindAionUi(MOpt(opt, "dir"), MOpt(opt, "uninstaller"));
                    if (inst == null) o.WriteLine("found=0");
                    else
                    {
                        o.WriteLine("found=1");
                        o.WriteLine("dir=" + inst.Dir);
                        o.WriteLine("version=" + inst.Version);
                        o.WriteLine("scope=" + inst.Scope);
                        o.WriteLine("uninstaller=" + (inst.Uninstaller ?? ""));
                        o.WriteLine("running=" + AionUiRunning(inst.Dir));
                    }
                    o.WriteLine("data=" + data);
                    o.WriteLine("dataExists=" + (Directory.Exists(data) ? "1" : "0"));
                    string db = MigrateDb(data);
                    o.WriteLine("dbBytes=" + (File.Exists(db) ? new FileInfo(db).Length : 0));
                    long total = 0;
                    foreach (var r in MigrateFiles(data)) { try { total += new FileInfo(Path.Combine(data, r)).Length; } catch (Exception) { } }
                    o.WriteLine("backupBytes=" + total);
                    return 0;
                }
                if (sub == "run") return MigrateRun(opt);
                if (sub == "uninstall-step")
                {
                    string dir = MOpt(opt, "dir"), un = MOpt(opt, "uninstaller");
                    if (dir == null || un == null) throw new ToolError("uninstall-step needs --dir and --uninstaller.");
                    var inst = new AionUiInstall { Dir = dir, Uninstaller = un, Scope = MOpt(opt, "scope") ?? "user", UninstallArgs = MOpt(opt, "uninstall-args") ?? "/currentuser" };
                    return UninstallStep(inst, MOpt(opt, "result"));
                }
                if (sub == "backup")
                {
                    string to = MOpt(opt, "to");
                    if (string.IsNullOrEmpty(to)) throw new ToolError("backup needs --to DIR.");
                    MigrateBackup(data, to, MOpt(opt, "aionui-version"));
                    return 0;
                }
                if (sub == "verify")
                {
                    string b = MOpt(opt, "backup");
                    if (string.IsNullOrEmpty(b) || !File.Exists(Path.Combine(b, "backup.json"))) throw new ToolError("verify needs --backup DIR with a backup.json in it.");
                    var m = Json.DeserializeObject(File.ReadAllText(Path.Combine(b, "backup.json"))) as Dictionary<string, object>;
                    var problems = MigrateCompare(data, m);
                    if (problems.Count == 0) { o.WriteLine("The data folder matches the backup."); return 0; }
                    o.WriteLine("The data folder differs from the backup: " + string.Join("; ", problems.ToArray()) + ".");
                    return 7;
                }
                throw new ToolError("Unknown command \"migrate " + sub + "\".\n" + MigrateHelp);
            }
            catch (ToolError e) { o.WriteLine(e.Message); return 1; }
            catch (Exception e) { o.WriteLine("The migrate command failed: " + e.Message); return 1; }
        }

        // ------------------------------------------------------------------ a real stop (2026-10-01, 1.11.0)

        // a request of 2026-10-01. A lead's
        // tools had no stop: team_interrupt_agent cancels the turn and then delivers the lead's replacement message, which starts the
        // next turn (session.rs interrupt_agent_message), and team_shutdown_agent is a handshake the agent has to agree to. AionCore does
        // have a stop: POST /api/teams/{id}/runs/{run}/agents/{slot}/pause cancels the member's batch and leaves the slot paused, so it
        // claims nothing from its queue until the user writes to it (the UI's Stop button for a member calls it). Cancel and pause end the
        // turn but not what the agent's process started in the background, so the member's runtime is restarted too, which ends the
        // process and everything under it.
        static string AgentStop(Dictionary<string, object> a)
        {
            string member = (Str(a, "member") ?? "").Trim();
            string reason = (Str(a, "reason") ?? "").Trim();
            bool keepProcess = Bool(a, "keep_process") == true;
            if (member.Length == 0) throw new ToolError("member is required: the teammate's name, slot id or conversation id.");
            if (member.Equals("all", StringComparison.OrdinalIgnoreCase)) throw new ToolError("Stop one teammate at a time: name one.");
            if (reason.Length > 300) reason = reason.Substring(0, 300);
            var ctx = LoadContext();
            if (ctx.Self.Kind != "team") throw new ToolError("Stopping a teammate is for teams, and this chat is not on one.");
            if (ctx.Self.Role != "lead") throw new ToolError("Only the team lead can stop a teammate.");
            var t = Resolve(ctx, member, true)[0];
            if (t.ConvId == ctx.Self.ConvId) throw new ToolError("That is you. Stop a teammate; the user stops you.");
            string who = t.Name ?? t.SlotId;
            var sb = new StringBuilder();
            string team = Uri.EscapeDataString(t.TeamId), slot = Uri.EscapeDataString(t.SlotId);

            // 1. The Loop first, so nothing nudges the member awake again.
            string loopNote = "";
            try
            {
                LoopSet(new Dictionary<string, object> { { "on", false }, { "member", member }, { "note", "stopped by " + (ctx.Self.Name ?? "the lead") + (reason.Length > 0 ? ": " + reason : "") } });
                loopNote = "Its Loop is off.";
            }
            catch (ToolError e)
            {
                loopNote = e.Message.IndexOf("until the user stops it", StringComparison.Ordinal) >= 0
                    ? "Its Loop runs until the user stops it, so no agent can switch it off: its next nudge wakes it again. The user switches it off from the Loop button, or the member's Stop button."
                    : "Its Loop was left as it was (" + OneLine(e.Message) + ").";
            }

            // 2. Pause: the turn is cancelled and the slot takes no new work.
            var w = SlotWork(t);
            string run = w != null ? Str(w, "team_run_id") : null;
            bool paused = false;
            string pauseNote;
            if (w == null) pauseNote = "The run state did not list it, so nothing could be paused.";
            else if (string.IsNullOrEmpty(run)) pauseNote = "It has no run in progress (state " + (Str(w, "state") ?? "unknown") + "), so there was no turn to cancel.";
            else
            {
                try
                {
                    Api("POST", "/api/teams/" + team + "/runs/" + Uri.EscapeDataString(run) + "/agents/" + slot + "/pause",
                        Json.Serialize(new Dictionary<string, object> { { "reason", reason.Length > 0 ? reason : "stopped by the team lead" } }));
                    paused = true;
                    pauseNote = "Paused: its turn was cancelled and it takes no new work until the user writes to it.";
                }
                catch (ToolError e) { pauseNote = "The pause was refused: " + OneLine(e.Message); }
            }

            // 3. Wait for the turn to end, then restart the process.
            string restartNote = "";
            if (!keepProcess)
            {
                string last = null;
                for (int i = 0; i < 12; i++)
                {
                    var now = SlotWork(t);
                    last = now != null ? Str(now, "state") : null;
                    bool running = now != null && (last == "running" || last == "starting" || Str(now, "active_turn_id") != null);
                    if (!running) break;
                    System.Threading.Thread.Sleep(500);
                }
                try
                {
                    Api("POST", "/api/teams/" + team + "/agents/" + slot + "/runtime/restart", "{}");
                    restartNote = "Its agent process was restarted, which ends everything it had started in the background.";
                }
                catch (ToolError e) { restartNote = "The process restart was refused (" + OneLine(e.Message) + "); it is " + (paused ? "paused" : "not paused") + " but its process is still running."; }
            }
            else restartNote = "Its process was left running (keep_process).";

            var after = SlotWork(t);
            sb.Append("Stopping ").Append(who).Append(": ").Append(paused ? "done." : "not complete.").Append('\n');
            sb.Append("  ").Append(pauseNote).Append('\n');
            sb.Append("  ").Append(loopNote).Append('\n');
            sb.Append("  ").Append(restartNote).Append('\n');
            if (after != null) sb.Append("  Now: ").Append(Str(after, "state") ?? "unknown").Append(", ").Append(Long(after, "queued_foreground_count") + Long(after, "queued_background_count")).Append(" queued.\n");
            sb.Append("  To start it again, the user writes to it, or you send it a message with team_send_message after the user says to.\n");
            return sb.ToString();
        }

        /** The teammate's entry in the team's run state, or null. */
        static Dictionary<string, object> SlotWork(Target t)
        {
            try
            {
                var rs = Api("GET", "/api/teams/" + Uri.EscapeDataString(t.TeamId) + "/run-state", null) as Dictionary<string, object>;
                var ws = rs != null && rs.ContainsKey("slot_work") ? rs["slot_work"] as object[] : null;
                if (ws == null) return null;
                foreach (var o in ws)
                {
                    var d = o as Dictionary<string, object>;
                    if (d != null && Str(d, "slot_id") == t.SlotId) return d;
                }
            }
            catch (ToolError) { }
            return null;
        }

        /** "Worker has 23 messages waiting: 1 from the user and priority messages, 22 from agents and team notices." */
        static string QueueLine(Target t, Dictionary<string, object> w)
        {
            long fg = Long(w, "queued_foreground_count"), bg = Long(w, "queued_background_count");
            long all = fg + bg;
            var sb = new StringBuilder();
            sb.Append("  Queue: ").Append(t.Name ?? t.SlotId).Append(" has ").Append(all).Append(all == 1 ? " message" : " messages").Append(" waiting");
            if (all > 0) sb.Append(": ").Append(fg).Append(" from the user and priority messages, ").Append(bg).Append(" from agents and team notices");
            sb.Append(".");
            if (all >= QueueWarn)
                sb.Append(" That is a long queue: on September 25th a teammate stopped taking work at 33 (\"could not process 33 queued " +
                          "message(s) after 3 delivery attempts\"). Hold back further messages, or use team_interrupt_agent to clear the way.");
            return sb.Append('\n').ToString();
        }

        // ------------------------------------------------------------------ the two tools

        static string LoopStatus(Dictionary<string, object> a)
        {
            var ctx = LoadContext();
            var targets = Resolve(ctx, Str(a, "member"), false);
            var prefs = ReadPrefs(targets);
            var sb = new StringBuilder();
            foreach (var t in targets)
            {
                Describe(sb, ctx, t, prefs);
                if (t.Kind == "team") { var w = SlotWork(t); if (w != null) sb.Append(QueueLine(t, w)); }
            }
            sb.Append(EngineLine(prefs));
            var usageLine = UsageLine(ctx);
            if (usageLine.Length > 0) { if (sb.Length > 0 && sb[sb.Length - 1] != '\n') sb.Append('\n'); sb.Append(usageLine); }
            return sb.ToString();
        }

        static string LoopSet(Dictionary<string, object> a)
        {
            bool? on = Bool(a, "on");
            bool? untilStopped = Bool(a, "until_stopped");
            if (untilStopped == true && on == false)
                throw new ToolError("until_stopped keeps the Loop on: leave on out, or pass on: true.");
            string message = a.ContainsKey("message") && a["message"] != null ? Convert.ToString(a["message"]) : null;
            bool compact = Bool(a, "compact") == true;
            string note = (Str(a, "note") ?? "").Trim();
            long? hold = null;
            if (a.ContainsKey("hold") && a["hold"] != null)
            {
                long h;
                if (!long.TryParse(Convert.ToString(a["hold"], System.Globalization.CultureInfo.InvariantCulture), out h))
                {
                    double d;
                    if (!double.TryParse(Convert.ToString(a["hold"], System.Globalization.CultureInfo.InvariantCulture),
                            System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out d))
                        throw new ToolError("hold is a number of minutes, 0 to 240.");
                    h = (long)Math.Round(d);
                }
                if (h < 0 || h > HoldMax) throw new ToolError("hold is a number of minutes, 0 to " + HoldMax + "; not " + h + ".");
                hold = h;
            }
            long? resumeAt = null;
            if (a.ContainsKey("resume_at") && a["resume_at"] != null)
                resumeAt = ParseResumeAt(Convert.ToString(a["resume_at"], System.Globalization.CultureInfo.InvariantCulture), NowMs());
            string resumeMsg = a.ContainsKey("resume_message") && a["resume_message"] != null ? Convert.ToString(a["resume_message"]).Trim() : null;
            if (resumeMsg != null && resumeAt == null)
                throw new ToolError("resume_message goes with resume_at: pass the time too.");
            if (resumeMsg != null && resumeMsg.Length > 4000)
                throw new ToolError("The resume message is limited to 4000 characters; this one has " + resumeMsg.Length + ".");
            if (resumeAt > 0 && on == false)
                throw new ToolError("A resume time needs the Loop on; switching it off clears the resume time.");
            if (on == null && untilStopped == null && message == null && !compact && hold == null && resumeAt == null)
                throw new ToolError("Nothing to change: pass on, until_stopped, message, hold, resume_at or compact: true.");
            if (message != null && message.Length > 4000)
                throw new ToolError("The continue message is limited to 4000 characters; this one has " + message.Length + ".");
            if (note.Length > 300) note = note.Substring(0, 300);

            var ctx = LoadContext();
            var targets = Resolve(ctx, Str(a, "member"), true);
            var commands = new Dictionary<string, string>();
            if (compact)
            {
                foreach (var t in targets)
                {
                    var cmd = CompactCommand(t.ConvId);
                    if (cmd == null)
                        throw new ToolError((t.ConvId == ctx.Self.ConvId ? "This agent" : t.Name) +
                            " offers no compact command, so AionUi cannot compact it. Nothing was changed.");
                    commands[t.Key] = cmd;
                }
            }
            var prefs = ReadPrefs(targets);
            long now = NowMs();
            // A Loop the user set to run until they stop it (a request of 2026-09-26). No agent switches it off or ends that mode on its own: only
            // after the user asked for a Loop off in their own words, in the chat this call comes from, since the mode was
            // set and in the last 30 minutes. The Loop engine writes that request (AskKey) from what the user typed.
            long askedAt = 0;
            string askedText = null;
            var locked = targets.Where(t => IsUntilStopped(prefs.ContainsKey(t.Key) ? prefs[t.Key] as Dictionary<string, object> : null)).ToList();
            if (locked.Count > 0 && (on == false || untilStopped == false))
            {
                var ar = Api("GET", "/api/settings/client?keys=" + Uri.EscapeDataString(ctx.Self.AskKey), null) as Dictionary<string, object>;
                var ask = ar != null && ar.ContainsKey(ctx.Self.AskKey) ? ar[ctx.Self.AskKey] as Dictionary<string, object> : null;
                long at = ask != null ? Long(ask, "at") : 0;
                var refused = locked.Where(t => at <= 0 || at <= Long(prefs[t.Key] as Dictionary<string, object>, "foreverAt") ||
                                                now - at > LoopAskMaxMs).ToList();
                if (refused.Count > 0)
                    throw new ToolError(string.Join(", ", refused.Select(t => t.ConvId == ctx.Self.ConvId ? "Your Loop" : (t.Name ?? t.Suffix) + "'s Loop")) +
                        (refused.Count == 1 ? " runs" : " run") + " until the user stops it, so no agent can switch it off or end that on its own. " +
                        "The user ends it with Off in the Loop button's menu, the agent's Stop button, or by saying so. Once the user asks " +
                        "you to switch it off, in this chat, this call works for 30 minutes. Nothing was changed.");
                askedAt = at;
                askedText = Str(ask, "text");
            }
            var put = new Dictionary<string, object>();
            foreach (var t in targets)
            {
                var cur = prefs.ContainsKey(t.Key) ? prefs[t.Key] as Dictionary<string, object> : null;
                string curMsg = cur != null ? Str(cur, "msg") : null;
                bool curForever = IsUntilStopped(cur);
                var rec = new Dictionary<string, object>();
                rec["v"] = 1;
                rec["on"] = on ?? (untilStopped == true || resumeAt > 0 ? true : cur != null && Bool(cur, "on") == true);
                bool forever = (bool)rec["on"] && (untilStopped ?? curForever);
                rec["forever"] = forever;
                rec["foreverAt"] = forever ? (curForever && Long(cur, "foreverAt") > 0 ? Long(cur, "foreverAt") : now) : 0L;
                if (curForever && !forever && askedAt > 0) rec["askedAt"] = askedAt;
                rec["msg"] = message != null ? (message.Trim().Length == 0 ? DefaultMsg : message)
                                             : (string.IsNullOrWhiteSpace(curMsg) ? DefaultMsg : curMsg);
                rec["compactAt"] = compact ? now : (cur != null ? Long(cur, "compactAt") : 0L);
                rec["holdMin"] = hold ?? (cur != null && cur.ContainsKey("holdMin") && cur["holdMin"] != null ? Long(cur, "holdMin") : HoldDefault);
                // The resume time: a new one, cleared ("off", or the Loop switched off), or the one it had.
                if (resumeAt != null || (bool)rec["on"] == false)
                {
                    long w = (bool)rec["on"] ? resumeAt ?? 0L : 0L;
                    rec["wakeAt"] = w;
                    rec["wakeMsg"] = w > 0 ? resumeMsg ?? "" : "";
                    rec["wakeBy"] = w > 0 ? ctx.Self.Name ?? "An agent" : "";
                    rec["wakeSelf"] = w > 0 && t.ConvId == ctx.Self.ConvId;
                }
                else if (cur != null)
                {
                    rec["wakeAt"] = Long(cur, "wakeAt");
                    rec["wakeMsg"] = Str(cur, "wakeMsg") ?? "";
                    rec["wakeBy"] = Str(cur, "wakeBy") ?? "";
                    rec["wakeSelf"] = Bool(cur, "wakeSelf") == true;
                }
                rec["rev"] = (cur != null ? Long(cur, "rev") : 0L) + 1;
                rec["by"] = "agent";
                rec["who"] = ctx.Self.Name ?? "An agent";
                rec["for"] = t.Name ?? "";
                rec["at"] = now;
                rec["note"] = rec.ContainsKey("askedAt") && note.Length == 0 && !string.IsNullOrEmpty(askedText) ? "the user asked: \"" + askedText + "\"" : note;
                put[t.Key] = rec;
            }
            Api("PUT", "/api/settings/client", Json.Serialize(put));
            foreach (var kv in put) prefs[kv.Key] = kv.Value;

            var sb = new StringBuilder();
            sb.Append("Saved. The user sees this on the Loop button, marked with your name")
              .Append(note.Length > 0 ? " and note" : "")
              .Append(".\n");
            if (untilStopped == true)
            {
                var eng = prefs.ContainsKey(EngineKey) ? prefs[EngineKey] as Dictionary<string, object> : null;
                string build = eng != null ? Str(eng, "build") : null;
                if (build != null && BuildBefore(build, UntilStoppedBuild))
                    sb.Append("Note: AionUi's Loop engine (build ").Append(build).Append(") predates \"until the user stops it\", so it ")
                      .Append("treats this as an ordinary Loop (it rests after the hold) until the user installs a newer build with ")
                      .Append("AionDX Apply Update.\n");
            }
            if (compact)
                foreach (var t in targets)
                    sb.Append("AionUi sends /").Append(commands[t.Key]).Append(" when ")
                      .Append(t.ConvId == ctx.Self.ConvId ? "you next stop (after this turn)" : t.Name + " next stops").Append(".\n");
            if (resumeAt > 0)
            {
                var eng = prefs.ContainsKey(EngineKey) ? prefs[EngineKey] as Dictionary<string, object> : null;
                string build = eng != null ? Str(eng, "build") : null;
                if (build != null && BuildBefore(build, "2026-09-26.2"))
                    sb.Append("Note: AionUi's Loop engine (build ").Append(build).Append(") predates resume times, so nothing sends the ")
                      .Append("resume nudge until the user installs a newer build with AionDX Apply Update. Until then, check the time ")
                      .Append("yourself each time you are nudged.\n");
            }
            sb.Append('\n');
            foreach (var t in targets) Describe(sb, ctx, t, prefs);
            sb.Append(EngineLine(prefs));
            return sb.ToString();
        }

        /** On, and set to run until the user stops it. */
        static bool IsUntilStopped(Dictionary<string, object> rec)
        {
            return rec != null && Bool(rec, "on") == true && Bool(rec, "forever") == true;
        }

        /** Renderer builds read "2026-09-26.2": a date, then a number. False when either cannot be read. */
        static bool BuildBefore(string build, string than)
        {
            Func<string, long[]> parse = b =>
            {
                var m = System.Text.RegularExpressions.Regex.Match(b ?? "", @"^(\d{4})-(\d{2})-(\d{2})\.(\d+)");
                if (!m.Success) return null;
                return new[] { long.Parse(m.Groups[1].Value), long.Parse(m.Groups[2].Value), long.Parse(m.Groups[3].Value), long.Parse(m.Groups[4].Value) };
            };
            var x = parse(build);
            var y = parse(than);
            if (x == null || y == null) return false;
            for (int i = 0; i < 4; i++) if (x[i] != y[i]) return x[i] < y[i];
            return false;
        }

        /** resume_at: a clock time ("12:10", "3:30 pm", "3pm"; the next time it comes round, today or tomorrow),
         *  minutes from now ("+45", "45 min"), an ISO time within 24 hours, or "off" / "" to clear it (0). */
        static long ParseResumeAt(string v, long now)
        {
            string raw = (v ?? "").Trim();
            string s = raw.ToLowerInvariant();
            if (s.Length == 0 || s == "off" || s == "none" || s == "clear" || s == "cancel") return 0;
            var inv = System.Globalization.CultureInfo.InvariantCulture;
            var m = System.Text.RegularExpressions.Regex.Match(s, @"^\+?\s*(\d{1,4})\s*(?:m|min|mins|minute|minutes)$");
            if (!m.Success) m = System.Text.RegularExpressions.Regex.Match(s, @"^\+\s*(\d{1,4})$");
            if (m.Success)
            {
                long mins = long.Parse(m.Groups[1].Value, inv);
                if (mins < 1 || mins > 1440) throw new ToolError("resume_at in minutes is 1 to 1440; not " + mins + ".");
                return now + mins * 60000;
            }
            m = System.Text.RegularExpressions.Regex.Match(s, @"^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$");
            if (m.Success && (m.Groups[2].Success || m.Groups[3].Success))
            {
                int h = int.Parse(m.Groups[1].Value, inv);
                int mi = m.Groups[2].Success ? int.Parse(m.Groups[2].Value, inv) : 0;
                string ap = m.Groups[3].Value;
                if (ap.Length > 0)
                {
                    if (h < 1 || h > 12) throw new ToolError("\"" + raw + "\" is not a clock time.");
                    if (ap[0] == 'p' && h < 12) h += 12;
                    if (ap[0] == 'a' && h == 12) h = 0;
                }
                if (h > 23 || mi > 59) throw new ToolError("\"" + raw + "\" is not a clock time.");
                DateTime local = DateTimeOffset.FromUnixTimeMilliseconds(now).ToLocalTime().DateTime;
                DateTime at = new DateTime(local.Year, local.Month, local.Day, h, mi, 0, DateTimeKind.Local);
                if (at <= local.AddSeconds(30)) at = at.AddDays(1);
                return new DateTimeOffset(at).ToUnixTimeMilliseconds();
            }
            DateTimeOffset dto;
            if (DateTimeOffset.TryParse(raw, inv, System.Globalization.DateTimeStyles.AssumeLocal, out dto))
            {
                long ms = dto.ToUnixTimeMilliseconds();
                if (ms <= now + 30000 || ms > now + 24 * 3600000L) throw new ToolError("resume_at must be within the next 24 hours.");
                return ms;
            }
            throw new ToolError("resume_at takes a clock time (\"12:10\", \"3:30 pm\"), minutes from now (\"+45\"), or \"off\"; not \"" + raw + "\".");
        }

        // ------------------------------------------------------------------ MCP (1.5.0)

        // a request of 2026-09-26; agents change servers freely and he sees each change. Research:
        // ! LLM Files\Research\2026-09-26_mcp-configurable-and-transparent.md. These use AionCore's own routes (the
        // ones Settings > Tools uses) and log every change to aiondx.mcp.log, which AionDX's window announces with the
        // agent's name. Values of env and headers are never printed: they often hold keys.
        const string McpLogKey = "aiondx.mcp.log";

        static List<Dictionary<string, object>> McpServers()
        {
            var list = Api("GET", "/api/mcp/servers", null) as object[];
            return list == null ? new List<Dictionary<string, object>>() : list.OfType<Dictionary<string, object>>().ToList();
        }

        static Dictionary<string, object> McpFind(List<Dictionary<string, object>> list, string name)
        {
            return list.FirstOrDefault(s => string.Equals(Str(s, "name"), name, StringComparison.OrdinalIgnoreCase));
        }

        /** "stdio C:\x\server.exe --port 3 (env: API_KEY)" or "http https://host/mcp (headers: Authorization)". */
        static string McpTransportText(Dictionary<string, object> s)
        {
            var t = s.ContainsKey("transport") ? s["transport"] as Dictionary<string, object> : null;
            return t == null ? "no transport" : TransportText(t);
        }

        /** How a server runs, fit to show: the names of env and headers but never their values, no URL query, and no
         *  value after a flag named like a key or token. */
        static string TransportText(Dictionary<string, object> t)
        {
            var type = (Str(t, "type") ?? (t.ContainsKey("url") ? "http" : "stdio")).ToLowerInvariant();
            var keys = new Func<string, string>(k =>
            {
                var d = t.ContainsKey(k) ? t[k] as Dictionary<string, object> : null;
                return d != null && d.Count > 0 ? " (" + k + ": " + string.Join(", ", d.Keys) + ")" : "";
            });
            if (type == "stdio")
            {
                var args = t.ContainsKey("args") ? t["args"] as object[] : null;
                return "stdio " + (Str(t, "command") ?? "?") +
                       (args != null && args.Length > 0 ? " " + string.Join(" ", MaskArgs(args.Select(x => Convert.ToString(x, Inv)).ToList())) : "") + keys("env");
            }
            return type + " " + SafeUrl(Str(t, "url") ?? "?") + keys("headers");
        }

        static readonly Regex SecretFlag = new Regex(@"(?:^|[-_])(?:api[-_]?key|access[-_]?key|key|token|secret|password|passwd|pat|auth|credentials?)(?:$|[-_])", RegexOptions.IgnoreCase);

        static List<string> MaskArgs(List<string> args)
        {
            var o = new List<string>();
            for (int i = 0; i < args.Count; i++)
            {
                var x = args[i];
                int eq = x.IndexOf('=');
                string flag = (eq > 0 ? x.Substring(0, eq) : x).TrimStart('-');
                bool isFlag = x.StartsWith("-") && SecretFlag.IsMatch(flag);
                if (isFlag && eq > 0 && x.IndexOf("${", StringComparison.Ordinal) < 0) { o.Add(x.Substring(0, eq + 1) + "***"); continue; }
                o.Add(x);
                if (isFlag && eq < 0 && i + 1 < args.Count && !args[i + 1].StartsWith("-") && args[i + 1].IndexOf("${", StringComparison.Ordinal) < 0) { o.Add("***"); i++; }
            }
            return o;
        }

        /** A URL fit to show: scheme, host and path; a query (where keys often travel) and any user name are left out. */
        static string SafeUrl(string url)
        {
            Uri u;
            if (!Uri.TryCreate(url, UriKind.Absolute, out u)) return url;
            return u.Scheme + "://" + u.Authority + u.AbsolutePath + (u.Query.Length > 1 ? "?..." : "");
        }

        static string McpLine(Dictionary<string, object> s)
        {
            var tools = s.ContainsKey("tools") ? s["tools"] as object[] : null;
            var status = Str(s, "last_test_status") ?? "not tested";
            var check = status == "connected" ? "connected" + (tools != null ? ", " + tools.Length + " tool" + (tools.Length == 1 ? "" : "s") : "")
                      : status == "error" ? "failed" : status == "disconnected" ? "not tested" : status;
            return "  - " + Str(s, "name") + ": " + (Bool(s, "enabled") == true ? "ON" : "OFF") + (Bool(s, "builtin") == true ? " (built in)" : "") +
                   ", " + McpTransportText(s) + "; last check: " + check + "\n";
        }

        static string McpStatus(Dictionary<string, object> a)
        {
            var ctx = LoadContext();
            var sb = new StringBuilder();
            // This chat's own list, as AionCore stored it when the chat was created.
            var conv = Api("GET", "/api/conversations/" + Uri.EscapeDataString(ctx.Self.ConvId), null) as Dictionary<string, object>;
            var extra = conv != null && conv.ContainsKey("extra") ? conv["extra"] as Dictionary<string, object> : null;
            var mine = new List<string>();
            var snap = extra != null && extra.ContainsKey("mcp_servers") ? extra["mcp_servers"] as object[] : null;
            if (snap != null) foreach (var o in snap.OfType<Dictionary<string, object>>()) { var n = Str(o, "name"); if (n != null) mine.Add(n); }
            var list = McpServers();
            var ids = extra != null && extra.ContainsKey("mcp_server_ids") ? extra["mcp_server_ids"] as object[] : null;
            if (mine.Count == 0 && ids != null)
                foreach (var id in ids.Select(x => Convert.ToString(x)))
                {
                    var s = list.FirstOrDefault(x => Str(x, "id") == id);
                    mine.Add(s != null ? Str(s, "name") : id);
                }
            sb.Append("This chat's MCP servers, set when it was created: ").Append(mine.Count > 0 ? string.Join(", ", mine) : "none").Append(".\n");
            // Live status, where the backend reports it (AionDX's AionCore build keeps what the agent CLI reported).
            var rt = conv != null && conv.ContainsKey("runtime") ? conv["runtime"] as Dictionary<string, object> : null;
            var live = rt != null && rt.ContainsKey("mcp_servers") ? rt["mcp_servers"] as object[] : null;
            if (live != null && live.Length > 0)
                sb.Append("As this chat's agent reported them: ").Append(string.Join("; ", live.OfType<Dictionary<string, object>>()
                    .Select(x => Str(x, "name") + " " + (Str(x, "status") ?? "?") + (Str(x, "error") != null ? " (" + OneLine(Str(x, "error")) + ")" : "")))).Append(".\n");
            sb.Append('\n');
            McpFileSection(sb);
            sb.Append('\n').Append("AionUi's MCP list (Settings > Tools), ").Append(list.Count).Append(list.Count == 1 ? " server" : " servers")
              .Append(". A new chat gets the ones switched ON, unless its assistant has a list of its own:\n");
            foreach (var s in list.OrderBy(x => Str(x, "name"), StringComparer.OrdinalIgnoreCase)) sb.Append(McpLine(s));
            if (list.Count == 0) sb.Append("  (none yet)\n");
            // Recent changes, by anyone who used these tools.
            var logRec = Api("GET", "/api/settings/client?keys=" + McpLogKey, null) as Dictionary<string, object>;
            var log = logRec != null && logRec.ContainsKey(McpLogKey) ? logRec[McpLogKey] as object[] : null;
            if (log != null && log.Length > 0)
            {
                sb.Append("\nRecent changes through the AionDX MCP tools:\n");
                foreach (var e in log.OfType<Dictionary<string, object>>().Reverse().Take(5))
                    sb.Append("  - ").Append(Hhmm(Long(e, "at"))).Append(" ").Append(Str(e, "who") ?? "an agent").Append(": ").Append(Str(e, "action") ?? "?")
                      .Append(" ").Append(Str(e, "name") ?? "").Append(string.IsNullOrEmpty(Str(e, "note")) ? "" : " (" + Str(e, "note") + ")").Append('\n');
            }
            sb.Append("\nWhen the user asks you to use a server: mcp_tools lists its tools, mcp_call calls one (aiondx mcp tools, aiondx mcp call). " +
                      "Change the servers with mcp_set: add, update, remove, test, enable or disable. The user sees each change with your name.\n");
            sb.Append(GitHubPointer());
            return sb.ToString();
        }

        /** The transport object for add and update: {type: stdio, command, args, env} or {type: http|sse, url, headers}. */
        static Dictionary<string, object> McpTransportArg(Dictionary<string, object> a)
        {
            var t = a.ContainsKey("transport") ? a["transport"] as Dictionary<string, object> : null;
            if (t == null) return null;
            var type = (Str(t, "type") ?? (t.ContainsKey("url") ? "http" : "stdio")).ToLowerInvariant();
            if (type == "streamable_http" || type == "streamable-http") type = "http";
            var o = new Dictionary<string, object> { { "type", type } };
            if (type == "stdio")
            {
                var cmd = Str(t, "command");
                if (string.IsNullOrWhiteSpace(cmd)) throw new ToolError("A stdio server needs transport.command.");
                o["command"] = cmd;
                if (t.ContainsKey("args") && t["args"] is object[]) o["args"] = ((object[])t["args"]).Select(x => Convert.ToString(x)).ToArray();
                if (t.ContainsKey("env") && t["env"] is Dictionary<string, object>) o["env"] = ((Dictionary<string, object>)t["env"]).ToDictionary(kv => kv.Key, kv => Convert.ToString(kv.Value));
                if (!string.IsNullOrWhiteSpace(Str(t, "cwd"))) o["cwd"] = Str(t, "cwd");   // the AionDX MCP file only
            }
            else if (type == "http" || type == "sse")
            {
                var url = Str(t, "url");
                if (string.IsNullOrWhiteSpace(url)) throw new ToolError("An " + type + " server needs transport.url.");
                o["url"] = url;
                if (t.ContainsKey("headers") && t["headers"] is Dictionary<string, object>) o["headers"] = ((Dictionary<string, object>)t["headers"]).ToDictionary(kv => kv.Key, kv => Convert.ToString(kv.Value));
            }
            else throw new ToolError("transport.type is stdio, http or sse; not \"" + type + "\".");
            return o;
        }

        static string McpTest(Dictionary<string, object> s)
        {
            var body = new Dictionary<string, object> { { "id", Str(s, "id") }, { "name", Str(s, "name") }, { "transport", s["transport"] } };
            var r = Api("POST", "/api/mcp/test-connection", Json.Serialize(body)) as Dictionary<string, object>;
            if (r == null) return "The check gave no answer.";
            if (Bool(r, "success") == true)
            {
                var tools = r.ContainsKey("tools") ? r["tools"] as object[] : null;
                return "The check connected" + (tools != null ? " and found " + tools.Length + " tool" + (tools.Length == 1 ? "" : "s") +
                       (tools.Length > 0 ? ": " + string.Join(", ", tools.OfType<Dictionary<string, object>>().Select(x => Str(x, "name")).Take(12)) + (tools.Length > 12 ? ", ..." : "") : "") : "") + ".";
            }
            return "The check failed" + (Str(r, "code") != null ? " (" + Str(r, "code") + ")" : "") + ": " + OneLine(Str(r, "error") ?? "no reason given") +
                   (Bool(r, "needs_auth") == true ? " It needs a sign-in, which the user does from Settings > Tools." : "");
        }

        /** Logs a change for the user's notice. False when there is no AionUi to log it in. */
        static bool McpRecord(Ctx ctx, string action, string name, string note)
        {
            try
            {
                var rec = Api("GET", "/api/settings/client?keys=" + McpLogKey, null) as Dictionary<string, object>;
                var old = rec != null && rec.ContainsKey(McpLogKey) ? rec[McpLogKey] as object[] : null;
                var log = old != null ? old.ToList() : new List<object>();
                log.Add(new Dictionary<string, object> { { "at", NowMs() }, { "who", ctx.Self.Name ?? "An agent" }, { "conv", ctx.Self.ConvId },
                    { "action", action }, { "name", name }, { "note", note ?? "" } });
                if (log.Count > 30) log = log.Skip(log.Count - 30).ToList();
                Api("PUT", "/api/settings/client", Json.Serialize(new Dictionary<string, object> { { McpLogKey, log } }));
                return true;
            }
            catch (Exception e) { Log("mcp log not written: " + OneLine(e.Message)); return false; }
        }

        static string McpSet(Dictionary<string, object> a)
        {
            string action = (Str(a, "action") ?? "").Trim().ToLowerInvariant();
            string name = (Str(a, "name") ?? "").Trim();
            string note = (Str(a, "note") ?? "").Trim();
            if (note.Length > 300) note = note.Substring(0, 300);
            var actions = new[] { "add", "update", "enable", "disable", "remove", "test" };
            if (Array.IndexOf(actions, action) < 0) throw new ToolError("action is one of add, update, remove, test, enable, disable (and on the command line list, tools, call, status, path, secret).");
            if (name.Length == 0) throw new ToolError("name is the server's name, as the MCP list shows it.");
            string where = (Str(a, "where") ?? "").Trim().ToLowerInvariant();
            if (where.Length > 0 && where != "file" && where != "aionui") throw new ToolError("where is \"file\" (the AionDX MCP file) or \"aionui\" (AionUi's own list).");
            // The AionDX MCP file unless told otherwise; update, remove and test go where the name is; on and off are AionUi's.
            if (where.Length == 0) where = action == "enable" || action == "disable" ? "aionui" : action == "add" || McpFileHas(name) ? "file" : "aionui";
            if (where == "file") return McpFileSet(a, action, name, note);
            var ctx = LoadContext();
            var list = McpServers();
            var s = McpFind(list, name);
            var sb = new StringBuilder();
            if (action == "add")
            {
                if (s != null) throw new ToolError("A server named \"" + Str(s, "name") + "\" is already in the list; use update to change it. (AionUi's create would quietly take over that row and switch it off.)");
                var transport = McpTransportArg(a);
                if (transport == null) throw new ToolError("add needs transport: {type: stdio, command, args, env} or {type: http or sse, url, headers}.");
                transport.Remove("cwd");
                var body = new Dictionary<string, object> { { "name", name }, { "transport", transport } };
                if (!string.IsNullOrEmpty(Str(a, "description"))) body["description"] = Str(a, "description");
                s = Api("POST", "/api/mcp/servers", Json.Serialize(body)) as Dictionary<string, object>;
                if (s == null) throw new ToolError("AionUi did not return the new server.");
                // Create leaves a server OFF. It stays OFF unless asked (the user, September 26th: no chat gets his MCP servers
                // unless he says so), since every new chat gets the ON ones; mcp_call reaches it either way.
                bool on = Bool(a, "on") == true;
                if (on && Bool(s, "enabled") != true) s = Api("POST", "/api/mcp/servers/" + Uri.EscapeDataString(Str(s, "id")) + "/toggle", null) as Dictionary<string, object> ?? s;
                sb.Append("Added ").Append(name).Append(on ? " to AionUi's MCP list and switched it on: new chats get it."
                                                          : " to AionUi's MCP list, switched OFF: no chat gets it, and mcp_call reaches it when the user asks.");
                if (Bool(a, "test") != false) sb.Append(' ').Append(McpTest(s));
            }
            else
            {
                if (s == null) throw new ToolError("No server named \"" + name + "\". The list: " + (list.Count > 0 ? string.Join(", ", list.Select(x => Str(x, "name"))) : "empty") + ".");
                name = Str(s, "name");
                string id = Str(s, "id");
                bool builtin = Bool(s, "builtin") == true;
                if (builtin && action != "test") throw new ToolError(name + " is built into AionUi; its Settings page does not let it be changed here either.");
                if (action == "update")
                {
                    var body = new Dictionary<string, object>();
                    var transport = McpTransportArg(a);
                    if (transport != null) { transport.Remove("cwd"); body["transport"] = transport; }
                    if (a.ContainsKey("description")) body["description"] = Str(a, "description");
                    if (body.Count == 0) throw new ToolError("update needs transport or description.");
                    s = Api("PUT", "/api/mcp/servers/" + Uri.EscapeDataString(id), Json.Serialize(body)) as Dictionary<string, object> ?? s;
                    sb.Append("Updated ").Append(name).Append(". Chats that already have it use the new settings from their next start.");
                    if (Bool(a, "test") != false) sb.Append(' ').Append(McpTest(s));
                }
                else if (action == "enable" || action == "disable")
                {
                    bool want = action == "enable";
                    // Toggle flips; it is sent only when the state differs, so asking twice is safe.
                    if ((Bool(s, "enabled") == true) != want) s = Api("POST", "/api/mcp/servers/" + Uri.EscapeDataString(id) + "/toggle", null) as Dictionary<string, object> ?? s;
                    sb.Append(name).Append(" is ").Append(want ? "ON: new chats get it." : "OFF: new chats do not get it; chats that already have it keep it.");
                }
                else if (action == "remove")
                {
                    Api("DELETE", "/api/mcp/servers/" + Uri.EscapeDataString(id), null);
                    sb.Append("Removed ").Append(name).Append(" from the list.");
                }
                else
                {
                    sb.Append(name).Append(": ").Append(McpTest(s));
                }
            }
            if (action != "test") McpRecord(ctx, action, name, note);
            sb.Append(action == "test" ? "\n" : " The user sees this change with your name" + (note.Length > 0 ? " and note" : "") + ".\n");
            return sb.ToString();
        }

        // ------------------------------------------------------------------ the AionDX MCP file, and servers used as needed (1.6.0)
        //
        // a request of 2026-09-26; then, needing it that day, "a global
        // AionDX directory or file or something that every agent knows carries the MCP access credentials". So the user's
        // servers and their credentials live in one file, %USERPROFILE%\.aiondx\mcp\servers.json, which nothing loads into a
        // chat, and the aiondx-loop skill (offered in every chat) says where it is. An agent the user asks connects for one
        // command (aiondx mcp tools and call, or the mcp_tools and mcp_call tools): McpClient below starts the server (stdio)
        // or reaches it (streamable HTTP, or the older SSE transport), asks, hands back the answer and closes, taking the
        // server's processes with it. Credentials go from the file to the server, never through the agent's transcript.
        // AionUi's own list is reachable the same way, so a server switched OFF there still works when asked. Every use is
        // logged beside the file (use.log): when, which chat, which server and tool; never arguments or values.

        static readonly System.Globalization.CultureInfo Inv = System.Globalization.CultureInfo.InvariantCulture;
        const string McpProtocol = "2025-06-18";
        static readonly Regex McpNameOk = new Regex(@"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
        static readonly string[] McpFileAbout = {
            "The AionDX MCP file: the user's MCP servers and their access credentials, in one place every AionDX agent knows (the aiondx-loop skill).",
            "Nothing here is loaded into any chat. An agent uses a server only when the user asks, for one command at a time:",
            "  aiondx mcp list  |  aiondx mcp tools NAME  |  aiondx mcp call NAME TOOL --param key=value",
            "Add a server with aiondx mcp add, or by hand in the mcpServers form Claude Desktop and Claude Code use:",
            "  local:  \"name\": {\"command\": \"npx\", \"args\": [\"-y\", \"some-mcp-server\"], \"env\": {\"API_KEY\": \"...\"}}",
            "  remote: \"name\": {\"type\": \"http\", \"url\": \"https://host/mcp\", \"headers\": {\"Authorization\": \"Bearer ...\"}}  (\"sse\" for the older transport)",
            "Any value can name a secret as ${NAME}: it comes from \"secrets\" below, or else from the environment.",
            "Credentials are encrypted for this Windows account (values that start dpapi:v1:), readable only by it on this PC:",
            "  aiondx mcp secret NAME --set stores a new one from standard input; aiondx mcp protect encrypts any typed in here by hand." };

        // a request of 2026-09-26. The file's credentials are sealed with Windows' data
        // protection (DPAPI) for the signed-in account: "dpapi:v1:<base64>", readable only by that account on this PC,
        // which is the account every AionDX agent runs as. Its folder is closed to every other account. add and update
        // seal a credential as they write it (an env or header value whose name says key, token, secret, password and
        // the like), aiondx mcp secret NAME --set takes a new one from standard input, and aiondx mcp protect seals
        // what is still plain. Plain values still work.
        const string SealPrefix = "dpapi:v1:";
        static readonly Regex SecretNameRe = new Regex(@"key|token|secret|passw|pwd|auth|credential|cookie|session|bearer|private", RegexOptions.IgnoreCase);

        static bool IsSealed(string v) { return v != null && v.StartsWith(SealPrefix, StringComparison.Ordinal); }

        static string Seal(string plain)
        {
            if (plain == null || IsSealed(plain)) return plain;
            var b = Native.Dpapi(Encoding.UTF8.GetBytes(plain), true);
            if (b == null) throw new ToolError("Windows would not encrypt the value (data protection error " + Marshal.GetLastWin32Error() + ").");
            return SealPrefix + Convert.ToBase64String(b);
        }

        static string Unseal(string v, string what)
        {
            if (!IsSealed(v)) return v;
            byte[] raw;
            try { raw = Convert.FromBase64String(v.Substring(SealPrefix.Length)); }
            catch (FormatException) { throw new ToolError(what + " in the AionDX MCP file is damaged. The user stores it again: aiondx mcp secret NAME --set."); }
            var b = Native.Dpapi(raw, false);
            if (b == null)
                throw new ToolError(what + " in the AionDX MCP file was encrypted by another Windows account or on another PC, so it cannot be read here. " +
                                    "The user stores it again: aiondx mcp secret NAME --set.");
            return Encoding.UTF8.GetString(b);
        }

        /** A value to seal: a credential by its name, not sealed yet, and holding no ${NAME} placeholder (a value that
         *  names a secret, "Bearer ${GITHUB_TOKEN}" say, keeps the credential in "secrets", sealed there). */
        static bool WantsSeal(string name, string v)
        {
            if (string.IsNullOrEmpty(v) || IsSealed(v)) return false;
            if (Placeholder.IsMatch(v)) return false;
            return SecretNameRe.IsMatch(name ?? "");
        }

        /** One server entry's env and header credentials, sealed in place; how many. */
        static int SealEntry(Dictionary<string, object> e)
        {
            int n = 0;
            foreach (var part in new[] { "env", "headers" })
            {
                if (e == null || !e.ContainsKey(part)) continue;
                // A transport from the command line or mcp_set carries its env and headers as strings.
                var ds = e[part] as Dictionary<string, string>;
                if (ds != null) e[part] = ds.ToDictionary(kv => kv.Key, kv => (object)kv.Value);
                var d = e[part] as Dictionary<string, object>;
                if (d == null) continue;
                foreach (var k in d.Keys.ToList())
                {
                    var v = d[k] as string;
                    if (WantsSeal(k, v)) { d[k] = Seal(v); n++; }
                }
            }
            return n;
        }

        /** Plain credentials left in the file: secrets, and env or header values named like credentials. */
        static int McpPlainCount(Dictionary<string, object> file)
        {
            int n = McpFileSecrets(file).Values.Count(v => v is string && ((string)v).Length > 0 && !IsSealed((string)v));
            foreach (var e in McpFileServers(file).Values.OfType<Dictionary<string, object>>())
                foreach (var part in new[] { "env", "headers" })
                {
                    var d = e.ContainsKey(part) ? e[part] as Dictionary<string, object> : null;
                    if (d != null) n += d.Count(kv => WantsSeal(kv.Key, kv.Value as string));
                }
            return n;
        }

        /** The file's folder, closed to every account but this one and Windows itself (SYSTEM): no inherited access, and
         *  full control for those two, which the files in it inherit. null when done, else why not. */
        static string McpLockFolder()
        {
            try
            {
                var dir = Path.GetDirectoryName(McpFilePath());
                Directory.CreateDirectory(dir);
                var me = System.Security.Principal.WindowsIdentity.GetCurrent().User;
                var system = new System.Security.Principal.SecurityIdentifier(System.Security.Principal.WellKnownSidType.LocalSystemSid, null);
                var inherit = System.Security.AccessControl.InheritanceFlags.ContainerInherit | System.Security.AccessControl.InheritanceFlags.ObjectInherit;
                var ds = new System.Security.AccessControl.DirectorySecurity();
                ds.SetAccessRuleProtection(true, false);
                foreach (var who in new System.Security.Principal.IdentityReference[] { me, system })
                    ds.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(who, System.Security.AccessControl.FileSystemRights.FullControl,
                        inherit, System.Security.AccessControl.PropagationFlags.None, System.Security.AccessControl.AccessControlType.Allow));
                Directory.SetAccessControl(dir, ds);
                foreach (var f in Directory.GetFiles(dir))
                {
                    var fs = new System.Security.AccessControl.FileSecurity();
                    fs.SetAccessRuleProtection(false, false);
                    File.SetAccessControl(f, fs);
                }
                return null;
            }
            catch (Exception e) { return OneLine(e.Message); }
        }

        /** aiondx mcp protect: seal what is still plain, and close the folder. */
        static string McpProtect()
        {
            int secrets = 0, creds = 0;
            bool had = McpFileLocked(() =>
            {
                var file = McpFileRead();
                if (file == null) return false;
                var s = file.ContainsKey("secrets") ? file["secrets"] as Dictionary<string, object> : null;
                if (s != null)
                    foreach (var k in s.Keys.ToList())
                    {
                        var v = s[k] as string;
                        if (!string.IsNullOrEmpty(v) && !IsSealed(v)) { s[k] = Seal(v); secrets++; }
                    }
                foreach (var e in McpFileServers(file).Values.OfType<Dictionary<string, object>>()) creds += SealEntry(e);
                file["_about"] = McpFileAbout.Cast<object>().ToArray();
                McpFileWrite(file);
                return true;
            });
            var locked = McpLockFolder();
            var sb = new StringBuilder();
            if (!had) sb.Append("There is no AionDX MCP file yet (").Append(McpFilePath()).Append("). ");
            else
                sb.Append(secrets + creds == 0 ? "Nothing was left in plain text. "
                    : "Encrypted " + secrets + (secrets == 1 ? " secret" : " secrets") + " and " + creds + (creds == 1 ? " credential" : " credentials") +
                      " in server entries, for this Windows account: only it can read them, on this PC. ");
            sb.Append(locked == null ? "The folder " + Path.GetDirectoryName(McpFilePath()) + " is closed to other accounts."
                                     : "The folder could not be closed to other accounts: " + locked);
            return sb.ToString();
        }

        static string McpFilePath()
        {
            var o = Environment.GetEnvironmentVariable("AIONDX_MCP_FILE");   // the tests' own file
            if (!string.IsNullOrEmpty(o)) return Path.GetFullPath(o);
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".aiondx", "mcp", "servers.json");
        }

        /** The file as a JSON object, or null when there is none yet. */
        static Dictionary<string, object> McpFileRead()
        {
            var f = McpFilePath();
            if (!File.Exists(f)) return null;
            string text = File.ReadAllText(f);
            if (text.Trim().Length == 0) return null;
            object o;
            try { o = Json.DeserializeObject(text); }
            catch (Exception e)
            {
                throw new ToolError(f + " is not valid JSON (" + OneLine(e.Message) + "). Fix it in a text editor: names and text in double quotes, " +
                                    "a comma between entries but none after the last, no comments.");
            }
            var d = o as Dictionary<string, object>;
            if (d == null) throw new ToolError(f + " should hold one JSON object, with \"mcpServers\" and \"secrets\" in it.");
            return d;
        }

        static Dictionary<string, object> McpFileServers(Dictionary<string, object> file)
        {
            var s = file != null && file.ContainsKey("mcpServers") ? file["mcpServers"] as Dictionary<string, object> : null;
            return s ?? new Dictionary<string, object>();
        }

        static Dictionary<string, object> McpFileSecrets(Dictionary<string, object> file)
        {
            var s = file != null && file.ContainsKey("secrets") ? file["secrets"] as Dictionary<string, object> : null;
            return s ?? new Dictionary<string, object>();
        }

        static bool McpFileHas(string name)
        {
            try { return McpFileServers(McpFileRead()).Keys.Any(k => string.Equals(k, name, StringComparison.OrdinalIgnoreCase)); }
            catch (ToolError) { return false; }
        }

        static Dictionary<string, object> McpFileTemplate()
        {
            return new Dictionary<string, object> {
                { "_about", McpFileAbout.Cast<object>().ToArray() },
                { "mcpServers", new Dictionary<string, object>() },
                { "secrets", new Dictionary<string, object>() } };
        }

        static bool McpFolderLocked;

        /** Written whole beside the file, then swapped in, so a reader never sees half of it. */
        static void McpFileWrite(Dictionary<string, object> file)
        {
            var f = McpFilePath();
            Directory.CreateDirectory(Path.GetDirectoryName(f));
            var tmp = f + ".new-" + Native.GetCurrentProcessId();
            if (!McpFolderLocked) { McpFolderLocked = true; McpLockFolder(); }
            File.WriteAllText(tmp, PrettyJson(file), new UTF8Encoding(false));
            for (int i = 0; ; i++)
            {
                try
                {
                    if (File.Exists(f)) File.Replace(tmp, f, null);
                    else File.Move(tmp, f);
                    return;
                }
                catch (Exception e)
                {
                    if (!(e is IOException || e is UnauthorizedAccessException) || i >= 20)
                    {
                        try { File.Delete(tmp); } catch (Exception) { }
                        throw new ToolError("Could not write " + f + ": " + OneLine(e.Message));
                    }
                    Thread.Sleep(50);
                }
            }
        }

        /** One writer at a time: two agents adding servers at once would otherwise lose one of them. */
        static T McpFileLocked<T>(Func<T> work)
        {
            var f = McpFilePath();
            Directory.CreateDirectory(Path.GetDirectoryName(f));
            FileStream held = null;
            var until = DateTime.UtcNow.AddSeconds(10);
            while (held == null)
            {
                try { held = new FileStream(f + ".lock", FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None, 1, FileOptions.DeleteOnClose); }
                catch (IOException)
                {
                    if (DateTime.UtcNow > until) throw new ToolError("Another agent has been changing the AionDX MCP file for 10 s; try again in a moment.");
                    Thread.Sleep(100);
                }
            }
            using (held) return work();
        }

        static string McpFileInit()
        {
            var f = McpFilePath();
            var file = McpFileRead();
            if (file != null) return f + " is there, with " + McpFileServers(file).Count + " server(s).";
            McpFileLocked(() => { if (McpFileRead() == null) McpFileWrite(McpFileTemplate()); return true; });
            return "Made " + f + ". Add servers with aiondx mcp add, or in the file itself.";
        }

        /** The file's part of mcp_status and aiondx mcp list: names, how each runs and what it is for; never a value. */
        static void McpFileSection(StringBuilder sb)
        {
            var f = McpFilePath();
            Dictionary<string, object> file;
            try { file = McpFileRead(); }
            catch (ToolError e) { sb.Append("The AionDX MCP file: ").Append(e.Message).Append('\n'); return; }
            var servers = McpFileServers(file);
            sb.Append("The AionDX MCP file, ").Append(f).Append(file == null ? " (not made yet)" : "").Append(": ").Append(servers.Count)
              .Append(servers.Count == 1 ? " server" : " servers").Append(", loaded into no chat. Use one when the user asks:\n");
            foreach (var kv in servers.OrderBy(x => x.Key, StringComparer.OrdinalIgnoreCase))
            {
                var e = kv.Value as Dictionary<string, object>;
                sb.Append("  - ").Append(kv.Key).Append(": ");
                if (e == null) { sb.Append("not an object; fix it in the file\n"); continue; }
                sb.Append(TransportText(e));
                var desc = Str(e, "description");
                if (!string.IsNullOrWhiteSpace(desc)) sb.Append(". ").Append(OneLine(desc.Trim()).TrimEnd('.'));
                sb.Append('\n');
            }
            if (servers.Count == 0) sb.Append("  (none yet: aiondx mcp add puts one there, or the user writes it into the file)\n");
            var secrets = McpFileSecrets(file);
            if (secrets.Count > 0) sb.Append("  Secrets it holds, named here without their values: ").Append(string.Join(", ", secrets.Keys)).Append(".\n");
            int plain = file != null ? McpPlainCount(file) : 0;
            if (plain > 0) sb.Append("  ").Append(plain).Append(plain == 1 ? " credential is" : " credentials are")
                             .Append(" still plain text: aiondx mcp protect encrypts them for this Windows account.\n");
        }

        static string McpListText()
        {
            var sb = new StringBuilder();
            McpFileSection(sb);
            List<Dictionary<string, object>> list = null;
            try { list = McpServers(); } catch (ToolError) { }
            if (list == null) sb.Append("\nAionUi's MCP list: out of reach from here (this is not an AionUi chat, or AionUi is closed).\n");
            else
            {
                sb.Append("\nAionUi's MCP list (Settings > Tools); a new chat gets the ones switched ON:\n");
                foreach (var s in list.OrderBy(x => Str(x, "name"), StringComparer.OrdinalIgnoreCase)) sb.Append(McpLine(s));
                if (list.Count == 0) sb.Append("  (none)\n");
            }
            sb.Append("\nUse a server only when the user asks. Its tools: aiondx mcp tools NAME. A call: aiondx mcp call NAME TOOL --param name=value.\n");
            sb.Append(GitHubPointer());
            return sb.ToString();
        }

        /** Where an agent that looks for "the GitHub MCP" is sent: git's own sign-in, and aiondx github. No credential is read here. */
        static string GitHubPointer()
        {
            return "\nGitHub: no MCP server is needed. git on this PC signs in to GitHub by itself (credential helper: " +
                   (GitValue("credential.helper").Length > 0 ? GitValue("credential.helper") : "none") + "), so git push just works; " +
                   "aiondx github (the github_status tool) shows the account and how to push, and aiondx github create NAME makes a repository.\n";
        }

        static readonly string[] TransportKeys = { "type", "command", "args", "env", "cwd", "url", "headers" };

        /** A file entry: its description first, then how it runs, then anything else the user had put there. */
        static Dictionary<string, object> McpFileEntry(Dictionary<string, object> old, Dictionary<string, object> transport, string description)
        {
            var e = new Dictionary<string, object>();
            string desc = description ?? (old != null ? Str(old, "description") : null);
            if (!string.IsNullOrEmpty(desc)) e["description"] = desc;
            var from = transport ?? old;
            if (from != null) foreach (var k in TransportKeys) if (from.ContainsKey(k)) e[k] = from[k];
            if (old != null)
                foreach (var kv in old)
                    if (!e.ContainsKey(kv.Key) && kv.Key != "description" && Array.IndexOf(TransportKeys, kv.Key) < 0) e[kv.Key] = kv.Value;
            return e;
        }

        /** mcp_set and aiondx mcp add, update, remove and test, on the AionDX MCP file. */
        static string McpFileSet(Dictionary<string, object> a, string action, string name, string note)
        {
            if (action == "enable" || action == "disable")
                throw new ToolError("On and off belong to AionUi's list; nothing in the AionDX MCP file is loaded into a chat. Use update or remove.");
            if (action == "add" && !McpNameOk.IsMatch(name))
                throw new ToolError("A server name is letters, digits, dot, dash or underscore, up to 64, starting with a letter or digit.");
            var transport = McpTransportArg(a);
            string key = name;
            if (action == "test")
            {
                if (!McpFileHas(name)) throw new ToolError("The AionDX MCP file has no server named " + name + ".");
            }
            else
            {
                key = McpFileLocked(() =>
                {
                    var file = McpFileRead() ?? McpFileTemplate();
                    var servers = file.ContainsKey("mcpServers") ? file["mcpServers"] as Dictionary<string, object> : null;
                    if (servers == null) { servers = new Dictionary<string, object>(); file["mcpServers"] = servers; }
                    string have = servers.Keys.FirstOrDefault(k => string.Equals(k, name, StringComparison.OrdinalIgnoreCase));
                    if (action == "add")
                    {
                        if (have != null) throw new ToolError("The AionDX MCP file already has " + have + "; use update to change it.");
                        if (transport == null) throw new ToolError("add needs a server: --command for a local one or --url for a remote one (transport, in mcp_set).");
                        servers[name] = McpFileEntry(null, transport, Str(a, "description"));
                        SealEntry(servers[name] as Dictionary<string, object>);
                        have = name;
                    }
                    else if (have == null) throw new ToolError("The AionDX MCP file has no server named " + name + ".");
                    else if (action == "update")
                    {
                        if (transport == null && !a.ContainsKey("description")) throw new ToolError("update needs a new transport (--command or --url) or a description.");
                        servers[have] = McpFileEntry(servers[have] as Dictionary<string, object>, transport, a.ContainsKey("description") ? (Str(a, "description") ?? "") : null);
                        SealEntry(servers[have] as Dictionary<string, object>);
                    }
                    else servers.Remove(have);
                    McpFileWrite(file);
                    return have;
                });
            }
            var sb = new StringBuilder();
            if (action == "add") sb.Append("Added ").Append(key).Append(" to the AionDX MCP file, ").Append(McpFilePath()).Append(". No chat loads it: use it when the user asks.");
            else if (action == "update") sb.Append("Updated ").Append(key).Append(" in the AionDX MCP file.");
            else if (action == "remove") sb.Append("Removed ").Append(key).Append(" from the AionDX MCP file.");
            if (action == "test" || ((action == "add" || action == "update") && Bool(a, "test") != false))
            {
                if (sb.Length > 0) sb.Append(' ');
                if (action == "test") sb.Append(key).Append(": ");
                sb.Append(McpCheck(key, 60000));
            }
            if (action != "test")
            {
                string where = action == "add" ? " to the AionDX MCP file" : action == "remove" ? " from the AionDX MCP file" : " in the AionDX MCP file";
                bool told = false;
                try { told = McpRecord(LoadContext(), action, key + where, note); } catch (ToolError) { }
                if (told) sb.Append(" The user sees this change with your name").Append(note.Length > 0 ? " and note" : "").Append('.');
            }
            return sb.Append('\n').ToString();
        }

        /** Connects, lists the tools, and says how that went. */
        static string McpCheck(string name, int ms)
        {
            McpDef d;
            try { d = McpResolve(name, true); }
            catch (ToolError e) { return "The check could not start: " + e.Message; }
            try
            {
                var r = McpUse(d, ms, c => Tuple.Create(c.Init, McpListTools(c, ms)));
                var names = r.Item2.Select(x => Str(x, "name")).Where(x => x != null).ToList();
                var info = r.Item1.ContainsKey("serverInfo") ? r.Item1["serverInfo"] as Dictionary<string, object> : null;
                McpUseLog("test " + d.Name + " ok, " + names.Count + " tools");
                return "The check connected" + (info != null && Str(info, "name") != null ? " to " + (Str(info, "name") + " " + (Str(info, "version") ?? "")).Trim() : "") +
                       " and found " + names.Count + (names.Count == 1 ? " tool" : " tools") +
                       (names.Count > 0 ? ": " + string.Join(", ", names.Take(12)) + (names.Count > 12 ? ", ..." : "") : "") + ".";
            }
            catch (ToolError e)
            {
                McpUseLog("test " + d.Name + " failed: " + Short(e.Message, 120));
                return "The check failed: " + e.Message;
            }
        }

        sealed class McpDef
        {
            public string Name, Source, Type, Command, Url, Cwd;
            public List<string> Args = new List<string>();
            public Dictionary<string, string> Env = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            public Dictionary<string, string> Headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            public string Where { get { return Source == "file" ? "the AionDX MCP file" : "AionUi's MCP list"; } }
        }

        static McpDef McpDefOf(string name, string source, Dictionary<string, object> t, Dictionary<string, object> secrets)
        {
            var d = new McpDef { Name = name, Source = source };
            var type = (Str(t, "type") ?? (t.ContainsKey("url") ? "http" : "stdio")).Trim().ToLowerInvariant();
            if (type == "streamable_http" || type == "streamable-http" || type == "streamablehttp") type = "http";
            d.Type = type;
            d.Command = McpExpand(Str(t, "command"), secrets, name);
            d.Url = McpExpand(Str(t, "url"), secrets, name);
            d.Cwd = McpExpand(Str(t, "cwd"), secrets, name);
            var args = t.ContainsKey("args") ? t["args"] as object[] : null;
            if (args != null) foreach (var x in args) d.Args.Add(McpExpand(Convert.ToString(x, Inv), secrets, name));
            var env = t.ContainsKey("env") ? t["env"] as Dictionary<string, object> : null;
            if (env != null) foreach (var kv in env) d.Env[kv.Key] = McpExpand(Convert.ToString(kv.Value, Inv), secrets, name);
            var hd = t.ContainsKey("headers") ? t["headers"] as Dictionary<string, object> : null;
            if (hd != null) foreach (var kv in hd) d.Headers[kv.Key] = McpExpand(Convert.ToString(kv.Value, Inv), secrets, name);
            return d;
        }

        static readonly Regex Placeholder = new Regex(@"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}");

        /** ${NAME} from the file's secrets, else the environment; ${NAME:-default} falls back to its default. */
        static string McpExpand(string v, Dictionary<string, object> secrets, string server)
        {
            if (IsSealed(v)) v = Unseal(v, "A credential of " + server);
            if (v == null || v.IndexOf("${", StringComparison.Ordinal) < 0) return v;
            return Placeholder.Replace(v, m =>
            {
                string k = m.Groups[1].Value;
                string key = secrets.Keys.FirstOrDefault(s => s == k) ?? secrets.Keys.FirstOrDefault(s => string.Equals(s, k, StringComparison.OrdinalIgnoreCase));
                string sv = key != null ? Unseal(Convert.ToString(secrets[key], Inv), "The secret " + key) : null;
                if (!string.IsNullOrEmpty(sv)) return sv;
                string ev = Environment.GetEnvironmentVariable(k);
                if (!string.IsNullOrEmpty(ev)) return ev;
                if (m.Groups[2].Success) return m.Groups[2].Value;
                throw new ToolError(server + " needs the secret " + k + ", which is neither in the AionDX MCP file's \"secrets\" nor in the environment. " +
                                    "The user adds it to the file (aiondx mcp path shows where).");
            });
        }

        /** A server by name: the AionDX MCP file first, then AionUi's list when this runs in an AionUi chat. */
        static McpDef McpResolve(string name, bool fileOnly)
        {
            if (string.IsNullOrWhiteSpace(name)) throw new ToolError("Name the server; mcp_status (aiondx mcp list) shows them.");
            name = name.Trim();
            var file = McpFileRead();
            var secrets = McpFileSecrets(file);
            foreach (var kv in McpFileServers(file))
            {
                if (!string.Equals(kv.Key, name, StringComparison.OrdinalIgnoreCase)) continue;
                var e = kv.Value as Dictionary<string, object>;
                if (e == null) throw new ToolError(kv.Key + " in the AionDX MCP file is not an object; fix it in the file.");
                return McpDefOf(kv.Key, "file", e, secrets);
            }
            List<Dictionary<string, object>> list = null;
            if (!fileOnly) { try { list = McpServers(); } catch (ToolError) { } }
            var s = list != null ? McpFind(list, name) : null;
            if (s != null)
            {
                var t = s.ContainsKey("transport") ? s["transport"] as Dictionary<string, object> : null;
                if (t == null) throw new ToolError(Str(s, "name") + " in AionUi's MCP list has no transport.");
                return McpDefOf(Str(s, "name"), "aionui", t, secrets);
            }
            var known = McpFileServers(file).Keys.ToList();
            if (list != null) known.AddRange(list.Select(x => Str(x, "name")).Where(x => x != null));
            throw new ToolError("No MCP server named \"" + name + "\"" +
                                (known.Count > 0 ? ". There are: " + string.Join(", ", known.Distinct(StringComparer.OrdinalIgnoreCase)) : " in the AionDX MCP file") +
                                (list == null && !fileOnly ? " (AionUi's list is out of reach from here)" : "") + ".");
        }

        static T McpUse<T>(McpDef d, int ms, Func<McpClient, T> work)
        {
            using (var c = new McpClient(d, ms))
            {
                try { c.Open(); return work(c); }
                catch (McpHttpError e) { throw new ToolError(McpHttpText(d, e)); }
            }
        }

        static string McpHttpText(McpDef d, McpHttpError e)
        {
            var s = d.Name + " answered HTTP " + e.Status;
            if (e.Status == 401 || e.Status == 403)
            {
                s += ": it did not accept the credentials. Check them in " + d.Where + (d.Source == "file" ? " (aiondx mcp path)" : " (Settings > Tools)");
                var auth = e.Auth ?? "";
                if (auth.IndexOf("resource_metadata", StringComparison.OrdinalIgnoreCase) >= 0 || (d.Headers.Count == 0 && auth.IndexOf("Bearer", StringComparison.OrdinalIgnoreCase) >= 0))
                    s += ". It asks for an OAuth sign-in, which a one-command client cannot do: give it a token it takes in a header (Authorization: Bearer ...)";
                return s + ".";
            }
            var body = (e.Body ?? "").Trim();
            return s + (body.Length > 0 ? ": " + OneLine(body) : "") + ".";
        }

        static List<Dictionary<string, object>> McpListTools(McpClient c, int ms)
        {
            var all = new List<Dictionary<string, object>>();
            string cursor = null;
            for (int page = 0; page < 50; page++)
            {
                var r = c.Request("tools/list", cursor != null ? new Dictionary<string, object> { { "cursor", cursor } } : null, ms);
                var tools = r.ContainsKey("tools") ? r["tools"] as object[] : null;
                if (tools != null) all.AddRange(tools.OfType<Dictionary<string, object>>());
                cursor = Str(r, "nextCursor");
                if (string.IsNullOrEmpty(cursor)) break;
            }
            return all;
        }

        static string McpToolsText(string server, string tool, bool full, int ms)
        {
            var d = McpResolve(server, false);
            var sw = System.Diagnostics.Stopwatch.StartNew();
            Tuple<Dictionary<string, object>, List<Dictionary<string, object>>> r;
            try { r = McpUse(d, ms, c => Tuple.Create(c.Init, McpListTools(c, ms))); }
            catch (ToolError e) { McpUseLog("tools " + d.Name + " failed: " + Short(e.Message, 120)); throw; }
            McpUseLog("tools " + d.Name + " ok, " + r.Item2.Count + " tools, " + sw.ElapsedMilliseconds + " ms");
            var info = r.Item1.ContainsKey("serverInfo") ? r.Item1["serverInfo"] as Dictionary<string, object> : null;
            string who = d.Name + (info != null && Str(info, "name") != null ? " (" + (Str(info, "name") + " " + (Str(info, "version") ?? "")).Trim() + ")" : "");
            var sb = new StringBuilder();
            if (!string.IsNullOrWhiteSpace(tool))
            {
                var t = r.Item2.FirstOrDefault(x => Str(x, "name") == tool) ?? r.Item2.FirstOrDefault(x => string.Equals(Str(x, "name"), tool, StringComparison.OrdinalIgnoreCase));
                if (t == null) throw new ToolError(d.Name + " has no tool named \"" + tool + "\". Its tools: " + string.Join(", ", r.Item2.Select(x => Str(x, "name"))) + ".");
                var schema = t.ContainsKey("inputSchema") ? t["inputSchema"] as Dictionary<string, object> : null;
                sb.Append(who).Append(", tool ").Append(Str(t, "name")).Append(":\n");
                if (!string.IsNullOrWhiteSpace(Str(t, "description"))) sb.Append(Str(t, "description").Trim()).Append('\n');
                sb.Append("Parameters (* = required):\n");
                foreach (var line in McpParamLines(schema, true)) sb.Append("  ").Append(line).Append('\n');
                if (schema != null) sb.Append("Input schema:\n").Append(PrettyJson(schema));
                sb.Append("Call it: aiondx mcp call ").Append(d.Name).Append(' ').Append(Str(t, "name")).Append(" --param name=value (or mcp_call).\n");
                return sb.ToString();
            }
            sb.Append(who).Append(", from ").Append(d.Where).Append(": ").Append(r.Item2.Count).Append(r.Item2.Count == 1 ? " tool.\n" : " tools.\n");
            foreach (var t in r.Item2)
            {
                var desc = (Str(t, "description") ?? "").Trim();
                sb.Append("- ").Append(Str(t, "name")).Append(desc.Length > 0 ? ": " + (full ? desc : Short(FirstLine(desc), 200)) : "").Append('\n');
                var schema = t.ContainsKey("inputSchema") ? t["inputSchema"] as Dictionary<string, object> : null;
                if (full) foreach (var line in McpParamLines(schema, true)) sb.Append("    ").Append(line).Append('\n');
                else sb.Append("    ").Append(string.Join(", ", McpParamLines(schema, false))).Append('\n');
            }
            sb.Append("* marks a required parameter. One tool in full: aiondx mcp tools ").Append(d.Name).Append(" TOOL. A call: aiondx mcp call ")
              .Append(d.Name).Append(" TOOL --param name=value (or mcp_call).\n");
            return sb.ToString();
        }

        static List<string> McpParamLines(Dictionary<string, object> schema, bool detail)
        {
            var o = new List<string>();
            var props = schema != null && schema.ContainsKey("properties") ? schema["properties"] as Dictionary<string, object> : null;
            var reqList = schema != null && schema.ContainsKey("required") ? schema["required"] as object[] : null;
            var req = new HashSet<string>(reqList != null ? reqList.Select(x => Convert.ToString(x, Inv)) : new string[0]);
            if (props == null || props.Count == 0) { o.Add("(no parameters)"); return o; }
            foreach (var kv in props)
            {
                var p = kv.Value as Dictionary<string, object>;
                var desc = Str(p, "description");
                o.Add(kv.Key + (req.Contains(kv.Key) ? "*" : "") + ": " + McpTypeText(p) + (detail && !string.IsNullOrWhiteSpace(desc) ? ". " + Short(desc, 300) : ""));
            }
            return o;
        }

        static List<string> McpTypes(Dictionary<string, object> p)
        {
            var o = new List<string>();
            if (p == null) return o;
            object t;
            if (p.TryGetValue("type", out t))
            {
                var arr = t as object[];
                if (arr != null) o.AddRange(arr.Select(x => Convert.ToString(x, Inv)));
                else if (t != null) o.Add(Convert.ToString(t, Inv));
            }
            foreach (var k in new[] { "anyOf", "oneOf" })
            {
                var alts = p.ContainsKey(k) ? p[k] as object[] : null;
                if (alts != null) foreach (var alt in alts.OfType<Dictionary<string, object>>()) o.AddRange(McpTypes(alt));
            }
            return o.Distinct().ToList();
        }

        static string McpTypeText(Dictionary<string, object> p)
        {
            var types = McpTypes(p);
            string s = types.Count > 0 ? string.Join("|", types) : "any";
            if (types.Contains("array") && p.ContainsKey("items"))
            {
                var itemTypes = McpTypes(p["items"] as Dictionary<string, object>);
                if (itemTypes.Count > 0) s = s.Replace("array", string.Join("|", itemTypes) + "[]");
            }
            var en = p != null && p.ContainsKey("enum") ? p["enum"] as object[] : null;
            if (en != null && en.Length > 0) s += " (one of " + string.Join(", ", en.Take(12).Select(x => Convert.ToString(x, Inv))) + (en.Length > 12 ? ", ..." : "") + ")";
            return s;
        }

        /** A --param value as the tool's schema wants it: a number, true or false, JSON, a list from a,b,c, or the text. */
        static object McpCoerce(string key, string raw, Dictionary<string, object> schema)
        {
            var props = schema != null && schema.ContainsKey("properties") ? schema["properties"] as Dictionary<string, object> : null;
            var p = props != null && props.ContainsKey(key) ? props[key] as Dictionary<string, object> : null;
            var types = McpTypes(p);
            if (types.Count == 0)
            {
                // Nothing to go by: JSON when it reads as JSON (a number, true, an object), else the text.
                try { return Json.DeserializeObject(raw); } catch (Exception) { return raw; }
            }
            if (raw == "null" && types.Contains("null")) return null;
            if (types.Contains("string") && types.All(x => x == "string" || x == "null")) return raw;
            if (types.Contains("integer") || types.Contains("number"))
            {
                long whole;
                decimal part;
                if (long.TryParse(raw.Trim(), System.Globalization.NumberStyles.Integer, Inv, out whole)) return whole;
                if (types.Contains("number") && decimal.TryParse(raw.Trim(), System.Globalization.NumberStyles.Float, Inv, out part)) return part;
            }
            if (types.Contains("boolean"))
            {
                var b = raw.Trim().ToLowerInvariant();
                if (b == "true" || b == "yes" || b == "on" || b == "1") return true;
                if (b == "false" || b == "no" || b == "off" || b == "0") return false;
            }
            if (types.Contains("array") || types.Contains("object"))
            {
                object o = null;
                try { o = Json.DeserializeObject(raw); } catch (Exception) { }
                if ((o is object[] && types.Contains("array")) || (o is Dictionary<string, object> && types.Contains("object"))) return o;
                if (types.Contains("array"))
                {
                    var items = p.ContainsKey("items") ? p["items"] as Dictionary<string, object> : null;
                    var itemSchema = new Dictionary<string, object> { { "properties", new Dictionary<string, object> { { "x", items } } } };
                    return raw.Split(',').Select(x => x.Trim()).Where(x => x.Length > 0).Select(x => McpCoerce("x", x, itemSchema)).ToArray();
                }
            }
            if (types.Contains("string")) return raw;
            throw new ToolError(key + " takes " + McpTypeText(p) + ", and \"" + Short(raw, 60) + "\" is not one. A JSON value can go in --json-file instead.");
        }

        static Dictionary<string, object> McpArgsFrom(string jsonText, string jsonFile)
        {
            string src = null, what = null;
            if (jsonFile != null) { src = File.ReadAllText(jsonFile); what = jsonFile; }
            else if (jsonText == "-") { src = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)).ReadToEnd(); what = "What came on standard input"; }
            else if (jsonText != null) { src = jsonText; what = "The JSON given"; }
            if (src == null || src.Trim().Length == 0) return new Dictionary<string, object>();
            object o = null;
            try { o = Json.DeserializeObject(src); } catch (Exception) { }
            var d = o as Dictionary<string, object>;
            if (d == null)
                throw new ToolError(what + " is not a JSON object: " + Short(OneLine(src), 120) + ". Windows PowerShell 5.1 drops the double quotes inside an argument, " +
                                    "so pass each value with --param name=value, or write the JSON to a file and use --json-file FILE.");
            return d;
        }

        /** Connects to the server for this one call. The server and the call's result. */
        static Tuple<McpDef, Dictionary<string, object>> McpCall(string server, string tool, Dictionary<string, object> arguments, List<KeyValuePair<string, string>> pairs, int ms)
        {
            var d = McpResolve(server, false);
            var sw = System.Diagnostics.Stopwatch.StartNew();
            try
            {
                var r = McpUse(d, ms, c =>
                {
                    List<Dictionary<string, object>> tools = null;
                    try { tools = McpListTools(c, ms); } catch (ToolError) { }
                    Dictionary<string, object> t = null;
                    if (tools != null)
                    {
                        t = tools.FirstOrDefault(x => Str(x, "name") == tool) ?? tools.FirstOrDefault(x => string.Equals(Str(x, "name"), tool, StringComparison.OrdinalIgnoreCase));
                        if (t == null) throw new ToolError(d.Name + " has no tool named \"" + tool + "\". Its tools: " + string.Join(", ", tools.Select(x => Str(x, "name"))) + ".");
                    }
                    var schema = t != null && t.ContainsKey("inputSchema") ? t["inputSchema"] as Dictionary<string, object> : null;
                    var args2 = new Dictionary<string, object>(arguments);
                    if (pairs != null) foreach (var kv in pairs) args2[kv.Key] = McpCoerce(kv.Key, kv.Value, schema);
                    return c.Request("tools/call", new Dictionary<string, object> { { "name", t != null ? Str(t, "name") : tool }, { "arguments", args2 } }, ms);
                });
                McpUseLog("call " + d.Name + " " + tool + (Bool(r, "isError") == true ? " answered with an error" : " ok") + ", " + sw.ElapsedMilliseconds + " ms");
                return Tuple.Create(d, r);
            }
            catch (ToolError e)
            {
                McpUseLog("call " + d.Name + " " + tool + " failed, " + sw.ElapsedMilliseconds + " ms: " + Short(e.Message, 120));
                throw;
            }
        }

        /** mcp_call: the server's own content comes back as it came (text, pictures the agent can see); anything else as text. */
        static Tuple<object[], bool> McpCallTool(Dictionary<string, object> a)
        {
            string server = Str(a, "server"), tool = Str(a, "tool");
            if (string.IsNullOrWhiteSpace(server) || string.IsNullOrWhiteSpace(tool))
                throw new ToolError("server and tool are both needed: mcp_status lists the servers, and mcp_tools a server's tools.");
            object ao;
            a.TryGetValue("arguments", out ao);
            var arguments = ao as Dictionary<string, object>;
            if (arguments == null && ao is string && ((string)ao).Trim().Length > 0)
            {
                try { arguments = Json.DeserializeObject((string)ao) as Dictionary<string, object>; } catch (Exception) { }
                if (arguments == null) throw new ToolError("arguments is an object of the tool's parameters.");
            }
            var res = McpCall(server, tool, arguments ?? new Dictionary<string, object>(), null, TimeoutArg(a, 120) * 1000);
            var r = res.Item2;
            var content = r.ContainsKey("content") ? r["content"] as object[] : null;
            var items = new List<object>();
            int n = 0;
            if (content != null)
                foreach (var item in content.OfType<Dictionary<string, object>>())
                {
                    n++;
                    var type = Str(item, "type");
                    if (type == "text" || type == "image") items.Add(item);
                    else items.Add(TextItem(McpItemText(res.Item1, tool, item, n)));
                }
            if (items.Count == 0) items.Add(TextItem(r.ContainsKey("structuredContent") ? PrettyJson(r["structuredContent"]) : "(the tool returned nothing)"));
            return Tuple.Create(items.ToArray(), Bool(r, "isError") == true);
        }

        static Dictionary<string, object> TextItem(string text) { return new Dictionary<string, object> { { "type", "text" }, { "text", text } }; }

        static string McpResultText(McpDef d, string tool, Dictionary<string, object> r)
        {
            var sb = new StringBuilder();
            var content = r.ContainsKey("content") ? r["content"] as object[] : null;
            int n = 0;
            if (content != null)
                foreach (var item in content.OfType<Dictionary<string, object>>())
                {
                    n++;
                    var text = McpItemText(d, tool, item, n);
                    sb.Append(text);
                    if (!text.EndsWith("\n")) sb.Append('\n');
                }
            if (n == 0) sb.Append(r.ContainsKey("structuredContent") ? PrettyJson(r["structuredContent"]) : "(the tool returned nothing)\n");
            return sb.ToString();
        }

        /** One content item as text; a picture, sound or file is saved under %TEMP%\aiondx-mcp and named by its path. */
        static string McpItemText(McpDef d, string tool, Dictionary<string, object> item, int n)
        {
            var type = Str(item, "type");
            if (type == "text") return Str(item, "text") ?? "";
            if (type == "image" || type == "audio") return "[" + type + " saved to " + McpSave(d.Name, tool, n, Str(item, "mimeType"), Str(item, "data")) + "]";
            if (type == "resource")
            {
                var res = item.ContainsKey("resource") ? item["resource"] as Dictionary<string, object> : null;
                var uri = Str(res, "uri") ?? "";
                if (res != null && res.ContainsKey("text")) return "[resource " + uri + "]\n" + (Str(res, "text") ?? "");
                if (res != null && res.ContainsKey("blob")) return "[resource " + uri + " saved to " + McpSave(d.Name, tool, n, Str(res, "mimeType"), Str(res, "blob")) + "]";
                return "[resource " + uri + "]";
            }
            if (type == "resource_link") return "[link " + (Str(item, "name") ?? "") + ": " + (Str(item, "uri") ?? "") + "]";
            return PrettyJson(item);
        }

        static string McpSave(string server, string tool, int n, string mime, string b64)
        {
            byte[] bytes;
            try { bytes = Convert.FromBase64String(b64 ?? ""); }
            catch (FormatException) { return "nowhere: its data was not base64"; }
            var dir = Path.Combine(Path.GetTempPath(), "aiondx-mcp");
            Directory.CreateDirectory(dir);
            var f = Path.Combine(dir, SafeName(server) + "-" + SafeName(tool) + "-" + DateTime.Now.ToString("yyyyMMdd-HHmmss-fff", Inv) + "-" + n + MimeExt(mime));
            File.WriteAllBytes(f, bytes);
            return f + " (" + (mime ?? "no type") + ", " + bytes.Length + " bytes)";
        }

        static string MimeExt(string mime)
        {
            switch ((mime ?? "").ToLowerInvariant())
            {
                case "image/png": return ".png";
                case "image/jpeg": case "image/jpg": return ".jpg";
                case "image/gif": return ".gif";
                case "image/webp": return ".webp";
                case "image/svg+xml": return ".svg";
                case "audio/wav": case "audio/x-wav": return ".wav";
                case "audio/mpeg": return ".mp3";
                case "application/pdf": return ".pdf";
                case "text/plain": return ".txt";
                default: return ".bin";
            }
        }

        static string SafeName(string s)
        {
            var sb = new StringBuilder();
            foreach (var ch in s ?? "") sb.Append(char.IsLetterOrDigit(ch) || ch == '-' || ch == '_' ? ch : '_');
            return sb.Length > 0 ? sb.ToString() : "x";
        }

        /** use.log beside the AionDX MCP file: when, which chat, which server and tool. Never arguments or values. Under 1 MB. */
        static void McpUseLog(string what)
        {
            try
            {
                var f = Path.Combine(Path.GetDirectoryName(McpFilePath()), "use.log");
                Directory.CreateDirectory(Path.GetDirectoryName(f));
                var fi = new FileInfo(f);
                if (fi.Exists && fi.Length > 1024 * 1024) { File.Copy(f, f + ".1", true); File.WriteAllText(f, ""); }
                string conv = null;
                try { conv = Id(false).ConvId; } catch (Exception) { }
                File.AppendAllText(f, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", Inv) + " " + (conv != null ? "conv=" + conv : "outside AionUi") + " " + OneLine(what) + Environment.NewLine);
            }
            catch (Exception) { }
        }

        static int TimeoutArg(Dictionary<string, object> a, int dflt)
        {
            if (a == null || !a.ContainsKey("timeout") || a["timeout"] == null) return dflt;
            long v = Long(a, "timeout");
            if (v < 1 || v > 1800) throw new ToolError("timeout is seconds, 1 to 1800.");
            return (int)v;
        }

        static int SecondsArg(string v)
        {
            int s;
            if (!int.TryParse(v, out s) || s < 1 || s > 1800) throw new ToolError("--timeout takes seconds, 1 to 1800, not \"" + v + "\".");
            return s;
        }

        /** The command line's kill switch: whatever a server does, the program ends, and its job takes the server with it. */
        static void Watchdog(int seconds)
        {
            var t = new Thread(() =>
            {
                Thread.Sleep(TimeSpan.FromSeconds(seconds));
                try { Console.Out.WriteLine("aiondx: stopped after " + seconds + " s."); Console.Out.Flush(); } catch (Exception) { }
                Environment.Exit(3);
            });
            t.IsBackground = true;
            t.Start();
        }

        static string Short(string s, int max)
        {
            s = (s ?? "").Trim();
            return s.Length > max ? s.Substring(0, max - 3).TrimEnd() + "..." : s;
        }

        static string FirstLine(string s)
        {
            s = (s ?? "").Trim();
            int i = s.IndexOf('\n');
            return (i >= 0 ? s.Substring(0, i) : s).Trim();
        }

        /** JSON a person can read and edit: two-space indents, short lists on one line, text left as it is. */
        static string PrettyJson(object v)
        {
            var sb = new StringBuilder();
            PrettyJson(sb, v, 0);
            return sb.Append('\n').ToString();
        }

        static void PrettyJson(StringBuilder sb, object v, int depth)
        {
            string pad = new string(' ', (depth + 1) * 2), end = new string(' ', depth * 2);
            var d = v as System.Collections.IDictionary;
            if (d != null)
            {
                if (d.Count == 0) { sb.Append("{}"); return; }
                sb.Append("{\n");
                int i = 0;
                foreach (System.Collections.DictionaryEntry kv in d)
                {
                    sb.Append(pad).Append(JsonText(Convert.ToString(kv.Key, Inv))).Append(": ");
                    PrettyJson(sb, kv.Value, depth + 1);
                    sb.Append(++i < d.Count ? ",\n" : "\n");
                }
                sb.Append(end).Append('}');
                return;
            }
            var s = v as string;
            if (s != null) { sb.Append(JsonText(s)); return; }
            var list = v as System.Collections.IEnumerable;
            if (list != null)
            {
                var items = list.Cast<object>().ToList();
                if (items.Count == 0) { sb.Append("[]"); return; }
                bool flat = items.All(x => x == null || x is string || x is bool || x is ValueType) && items.Sum(x => Convert.ToString(x, Inv).Length + 4) < 90;
                if (flat)
                {
                    sb.Append('[');
                    for (int i = 0; i < items.Count; i++) { if (i > 0) sb.Append(", "); PrettyJson(sb, items[i], depth + 1); }
                    sb.Append(']');
                    return;
                }
                sb.Append("[\n");
                for (int i = 0; i < items.Count; i++)
                {
                    sb.Append(pad);
                    PrettyJson(sb, items[i], depth + 1);
                    sb.Append(i + 1 < items.Count ? ",\n" : "\n");
                }
                sb.Append(end).Append(']');
                return;
            }
            sb.Append(Json.Serialize(v));   // numbers, true, false, null
        }

        static string JsonText(string s)
        {
            var sb = new StringBuilder("\"");
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4", Inv));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.Append('"').ToString();
        }

        /** Windows' quoting for one argument (CommandLineToArgvW's rules). */
        static string QuoteArg(string a)
        {
            if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return a;
            var sb = new StringBuilder("\"");
            int slashes = 0;
            foreach (char c in a)
            {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') { sb.Append('\\', slashes * 2 + 1).Append('"'); slashes = 0; continue; }
                sb.Append('\\', slashes).Append(c);
                slashes = 0;
            }
            return sb.Append('\\', slashes * 2).Append('"').ToString();
        }

        static bool IsNodeTool(string cmd)
        {
            var b = Path.GetFileNameWithoutExtension(cmd.Trim().Trim('"')).ToLowerInvariant();
            return b == "node" || b == "npx" || b == "npm";
        }

        /** Where Node.js is when it is not on the PATH: its installer's folder, and AionUi's and AionDX's own copies. */
        static IEnumerable<string> NodeDirs()
        {
            string pf = Environment.GetEnvironmentVariable("ProgramW6432") ?? Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string app = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return new[] {
                Path.Combine(pf, "nodejs"),
                Path.Combine(app, "AionUi", "aionui", "runtime", "node"),
                Path.Combine(local, "Programs", "AionDX", "resources", "bundled-aioncore", "win32-x64", "managed-resources", "node"),
                Path.Combine(pf, "AionUi", "resources", "bundled-aioncore", "win32-x64", "managed-resources", "node") };
        }

        /** The program a command names, found the way a shell would: a path as given, else each PATH folder with each PATHEXT ending. */
        static string FindCommand(string cmd, Dictionary<string, string> env, string cwd)
        {
            cmd = cmd.Trim().Trim('"');
            string v;
            var exts = ((env.TryGetValue("PATHEXT", out v) ? v : null) ?? ".COM;.EXE;.BAT;.CMD").Split(';').Where(x => x.StartsWith(".")).ToList();
            var names = new List<string>();
            if (Path.HasExtension(cmd)) names.Add(cmd);
            foreach (var x in exts) names.Add(cmd + x.ToLowerInvariant());
            var dirs = new List<string>();
            if (cmd.IndexOfAny(new[] { '\\', '/' }) >= 0) dirs.Add(Path.IsPathRooted(cmd) ? "" : (string.IsNullOrWhiteSpace(cwd) ? Environment.CurrentDirectory : cwd));
            else
            {
                dirs.AddRange(((env.TryGetValue("PATH", out v) ? v : null) ?? "").Split(';').Select(x => x.Trim().Trim('"')).Where(x => x.Length > 0));
                if (IsNodeTool(cmd)) dirs.AddRange(NodeDirs());
            }
            foreach (var dir in dirs)
                foreach (var n in names)
                {
                    string f;
                    try { f = dir.Length == 0 ? n : Path.Combine(dir, n); } catch (ArgumentException) { continue; }
                    if (File.Exists(f)) return Path.GetFullPath(f);
                }
            return null;
        }

        /** One connection to one MCP server, for one command: open, a request or two, close. */
        sealed class McpClient : IDisposable
        {
            static readonly HashSet<string> Withheld = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY" };
            readonly McpDef def;
            readonly int waitMs;
            int seq;
            string transport, protocol, sessionId, postUrl;
            public Dictionary<string, object> Init = new Dictionary<string, object>();
            System.Diagnostics.Process proc;
            StreamWriter input;
            readonly System.Collections.Concurrent.BlockingCollection<string> inbox = new System.Collections.Concurrent.BlockingCollection<string>();
            readonly StringBuilder errors = new StringBuilder();
            readonly List<string> stray = new List<string>();
            HttpWebRequest stream;
            readonly ManualResetEvent endpointKnown = new ManualResetEvent(false);

            public McpClient(McpDef d, int waitMs) { def = d; this.waitMs = Math.Max(1000, waitMs); }

            public void Open()
            {
                if (def.Type == "stdio")
                {
                    if (string.IsNullOrWhiteSpace(def.Command)) throw new ToolError(def.Name + " has no command to start.");
                    Start();
                }
                else if (def.Type == "http" || def.Type == "sse")
                {
                    Uri u;
                    if (!Uri.TryCreate(def.Url ?? "", UriKind.Absolute, out u) || (u.Scheme != "http" && u.Scheme != "https"))
                        throw new ToolError(def.Name + "'s url is not an http or https address.");
                    PrepareNet();
                    if (def.Type == "sse") OpenStream(def.Url); else transport = "http";
                }
                else throw new ToolError(def.Name + " has the transport \"" + def.Type + "\"; the ones there are: stdio, http and sse.");
                var p = new Dictionary<string, object> {
                    { "protocolVersion", McpProtocol },
                    { "capabilities", new Dictionary<string, object>() },
                    { "clientInfo", new Dictionary<string, object> { { "name", "aiondx" }, { "title", "AionDX" }, { "version", Version } } } };
                int initMs = Math.Min(waitMs, 60000);
                try { Init = Request("initialize", p, initMs); }
                catch (McpHttpError e)
                {
                    // A server that speaks only the older SSE transport refuses the POST; the spec's fallback is a GET at the same address.
                    if (transport != "http" || e.Status < 400 || e.Status >= 500 || e.Status == 401 || e.Status == 403 || e.Status == 407 || e.Status == 429) throw;
                    string why = null;
                    try { OpenStream(def.Url); }
                    catch (McpHttpError e2) { why = "HTTP " + e2.Status; }
                    catch (ToolError e2) { why = e2.Message; }
                    if (why != null) throw new ToolError(McpHttpText(def, e) + " A GET for the older SSE transport did not work either (" + OneLine(why) + ").");
                    Init = Request("initialize", p, initMs);
                }
                protocol = Str(Init, "protocolVersion") ?? McpProtocol;
                string note = Json.Serialize(new Dictionary<string, object> { { "jsonrpc", "2.0" }, { "method", "notifications/initialized" } });
                if (transport == "stdio") Write(note);
                else
                {
                    try { Post(transport == "sse" ? postUrl : def.Url, note, 0, Math.Min(waitMs, 15000), "notifications/initialized"); }
                    catch (McpHttpError) { }   // a server that minds is heard from at the next request
                }
            }

            public Dictionary<string, object> Request(string method, Dictionary<string, object> prms, int ms)
            {
                int id = ++seq;
                var msg = new Dictionary<string, object> { { "jsonrpc", "2.0" }, { "id", id }, { "method", method } };
                if (prms != null) msg["params"] = prms;
                string body = Json.Serialize(msg);
                Dictionary<string, object> answer;
                if (transport == "stdio") { Write(body); answer = Await(id, ms, method); }
                else if (transport == "sse") { Post(postUrl, body, 0, ms, method); answer = Await(id, ms, method); }
                else answer = Post(def.Url, body, id, ms, method);
                var err = answer.ContainsKey("error") ? answer["error"] as Dictionary<string, object> : null;
                if (err != null)
                    throw new ToolError(def.Name + " refused " + method + ": " + OneLine(Str(err, "message") ?? "no reason given") +
                                        (Str(err, "code") != null ? " (" + Str(err, "code") + ")" : "") + ".");
                return (answer.ContainsKey("result") ? answer["result"] as Dictionary<string, object> : null) ?? new Dictionary<string, object>();
            }

            Dictionary<string, object> Await(int id, int ms, string method)
            {
                var until = DateTime.UtcNow.AddMilliseconds(ms);
                while (true)
                {
                    int left = (int)Math.Max(0, (until - DateTime.UtcNow).TotalMilliseconds);
                    string raw;
                    if (!inbox.TryTake(out raw, left))
                    {
                        if (inbox.IsCompleted) throw new ToolError(Ended(method));
                        throw new ToolError(def.Name + " did not answer " + method + " within " + (ms / 1000) + " s." + Tail());
                    }
                    var found = Consider(raw, id);
                    if (found != null) return found;
                }
            }

            /** One incoming message: the answer to id (returned), a request from the server (answered), or anything else (skipped). */
            Dictionary<string, object> Consider(string raw, int id)
            {
                object o = null;
                try { o = Json.DeserializeObject(raw); } catch (Exception) { }
                var batch = o as object[];
                var list = batch != null ? batch.OfType<Dictionary<string, object>>().ToList() : new List<Dictionary<string, object>>();
                var one = o as Dictionary<string, object>;
                if (one != null) list.Add(one);
                if (list.Count == 0) { if (stray.Count < 10) stray.Add(Short(OneLine(raw), 160)); return null; }
                Dictionary<string, object> answer = null;
                foreach (var m in list)
                {
                    if (m.ContainsKey("method")) { if (m.ContainsKey("id") && m["id"] != null) Serve(m); continue; }
                    if (m.ContainsKey("id") && Convert.ToString(m["id"], Inv) == id.ToString(Inv)) answer = m;
                }
                return answer;
            }

            /** A server's own request: ping and roots/list get their plain answers, anything else a polite refusal. */
            void Serve(Dictionary<string, object> m)
            {
                var method = Str(m, "method");
                var reply = method == "ping" ? Result(m["id"], new Dictionary<string, object>())
                          : method == "roots/list" ? Result(m["id"], new Dictionary<string, object> { { "roots", new object[0] } })
                          : Error(m["id"], -32601, "AionDX's one-command client does not offer " + method + ".");
                string body = Json.Serialize(reply);
                try
                {
                    if (transport == "stdio") Write(body);
                    else Post(transport == "sse" ? postUrl : def.Url, body, 0, Math.Min(waitMs, 15000), method);
                }
                catch (Exception) { }
            }

            void Write(string line)
            {
                try { input.WriteLine(line); }
                catch (IOException) { throw new ToolError(Ended("its next message")); }
                catch (ObjectDisposedException) { throw new ToolError(Ended("its next message")); }
            }

            string Ended(string what)
            {
                string code = "";
                try { if (proc != null && proc.WaitForExit(500)) code = " with exit code " + proc.ExitCode; } catch (Exception) { }
                return def.Name + (transport == "stdio" ? " stopped" + code : " closed its event stream") + " before answering " + what + "." + Tail();
            }

            string Tail()
            {
                string e;
                lock (errors) e = errors.ToString().Trim();
                if (e.Length > 600) e = "..." + e.Substring(e.Length - 600);
                var s = e.Length > 0 ? " Its error output: " + e.Replace("\r", "").Replace("\n", " | ") : "";
                if (stray.Count > 0) s += " It also printed: " + string.Join(" | ", stray.Take(3));
                return s;
            }

            Dictionary<string, string> ChildEnv()
            {
                var env = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (System.Collections.DictionaryEntry e in Environment.GetEnvironmentVariables())
                {
                    var k = Convert.ToString(e.Key, Inv);
                    // The agent's AionUi token and Claude sign-in stay with the agent: a server gets neither.
                    if (k.StartsWith("AIONUI_", StringComparison.OrdinalIgnoreCase) || Withheld.Contains(k)) continue;
                    env[k] = Convert.ToString(e.Value, Inv);
                }
                foreach (var kv in def.Env) env[kv.Key] = kv.Value;
                return env;
            }

            void Start()
            {
                transport = "stdio";
                var env = ChildEnv();
                string exe = FindCommand(def.Command, env, def.Cwd);
                if (exe == null)
                    throw new ToolError("Cannot find " + def.Command + ", which starts " + def.Name + (IsNodeTool(def.Command)
                        ? ": Node.js is neither on the PATH nor where AionDX looks for it (Program Files\\nodejs, AionUi's runtime)." : ", on the PATH."));
                if (IsNodeTool(def.Command))
                {
                    string path;
                    env.TryGetValue("PATH", out path);
                    env["PATH"] = Path.GetDirectoryName(exe) + ";" + (path ?? "");   // npx.cmd looks for node beside it on the PATH
                }
                if (!string.IsNullOrWhiteSpace(def.Cwd) && !Directory.Exists(def.Cwd)) throw new ToolError(def.Name + "'s cwd, " + def.Cwd + ", is not a folder.");
                var psi = new System.Diagnostics.ProcessStartInfo();
                string argLine = string.Join(" ", def.Args.Select(x => QuoteArg(x)));
                string ext = Path.GetExtension(exe).ToLowerInvariant();
                if (ext == ".cmd" || ext == ".bat")
                {
                    // A batch file needs cmd.exe; /s /c runs the quoted line as it stands.
                    psi.FileName = Environment.GetEnvironmentVariable("ComSpec") ?? Path.Combine(Environment.SystemDirectory, "cmd.exe");
                    psi.Arguments = "/d /s /c \"" + QuoteArg(exe) + (argLine.Length > 0 ? " " + argLine : "") + "\"";
                }
                else { psi.FileName = exe; psi.Arguments = argLine; }
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardInput = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.StandardOutputEncoding = new UTF8Encoding(false);
                psi.StandardErrorEncoding = new UTF8Encoding(false);
                if (!string.IsNullOrWhiteSpace(def.Cwd)) psi.WorkingDirectory = def.Cwd;
                psi.EnvironmentVariables.Clear();
                foreach (var kv in env) psi.EnvironmentVariables[kv.Key] = kv.Value;
                Native.KillChildrenWithMe();
                try { proc = System.Diagnostics.Process.Start(psi); }
                catch (Exception e) { throw new ToolError("Could not start " + def.Name + " (" + exe + "): " + OneLine(e.Message)); }
                input = new StreamWriter(proc.StandardInput.BaseStream, new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
                var p = proc;
                var outThread = new Thread(() =>
                {
                    try { string line; while ((line = p.StandardOutput.ReadLine()) != null) if (line.Trim().Length > 0) inbox.Add(line); }
                    catch (Exception) { }
                    finally { inbox.CompleteAdding(); }
                });
                outThread.IsBackground = true;
                outThread.Start();
                var errThread = new Thread(() =>
                {
                    try
                    {
                        var buf = new char[2048];
                        int n;
                        while ((n = p.StandardError.Read(buf, 0, buf.Length)) > 0)
                            lock (errors) { errors.Append(buf, 0, n); if (errors.Length > 16000) errors.Remove(0, errors.Length - 8000); }
                    }
                    catch (Exception) { }
                });
                errThread.IsBackground = true;
                errThread.Start();
            }

            static void PrepareNet()
            {
                try { ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072 | (SecurityProtocolType)12288; }   // TLS 1.2 and 1.3
                catch (NotSupportedException) { try { ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072; } catch (NotSupportedException) { } }
                ServicePointManager.Expect100Continue = false;
                if (ServicePointManager.DefaultConnectionLimit < 8) ServicePointManager.DefaultConnectionLimit = 8;
            }

            HttpWebRequest NewRequest(string url, string method, int ms)
            {
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = method;
                req.Timeout = ms;
                req.ReadWriteTimeout = ms;
                req.UserAgent = "aiondx/" + Version;
                if (req.RequestUri.IsLoopback) req.Proxy = null;   // a proxy lookup can cost seconds, and this is this PC
                foreach (var kv in def.Headers)
                {
                    switch (kv.Key.ToLowerInvariant())
                    {
                        case "user-agent": req.UserAgent = kv.Value; break;
                        case "referer": req.Referer = kv.Value; break;
                        case "accept": case "content-type": case "content-length": case "host": case "connection": case "expect": break;   // the client's own
                        default: if (!WebHeaderCollection.IsRestricted(kv.Key)) req.Headers[kv.Key] = kv.Value; break;
                    }
                }
                return req;
            }

            /** Feeds one line of an event stream; true at the blank line that ends an event, whose type and data are then in ev and data. */
            static bool SseLine(string line, ref string ev, StringBuilder data)
            {
                if (line.Length == 0) return true;
                if (line[0] == ':') return false;
                int c = line.IndexOf(':');
                string field = c < 0 ? line : line.Substring(0, c), value = c < 0 ? "" : line.Substring(c + 1);
                if (value.StartsWith(" ")) value = value.Substring(1);
                if (field == "event") ev = value;
                else if (field == "data") { if (data.Length > 0) data.Append('\n'); data.Append(value); }
                return false;
            }

            /** Sends one message by POST. id 0 (a notification, or a reply to the server): the answer is only drained. */
            Dictionary<string, object> Post(string url, string body, int id, int ms, string what)
            {
                var req = NewRequest(url, "POST", ms);
                req.ContentType = "application/json";
                req.Accept = "application/json, text/event-stream";
                if (transport == "http")
                {
                    if (sessionId != null) req.Headers["Mcp-Session-Id"] = sessionId;
                    if (protocol != null && string.CompareOrdinal(protocol, "2025-06-18") >= 0) req.Headers["MCP-Protocol-Version"] = protocol;
                }
                var bytes = new UTF8Encoding(false).GetBytes(body);
                req.ContentLength = bytes.Length;
                try { using (var s = req.GetRequestStream()) s.Write(bytes, 0, bytes.Length); }
                catch (WebException e) { throw Unreachable(req, e, what); }
                var resp = Respond(req, what);
                try
                {
                    if (transport == "http") { var sid = resp.Headers["Mcp-Session-Id"]; if (!string.IsNullOrEmpty(sid)) sessionId = sid; }
                    var ct = (resp.ContentType ?? "").ToLowerInvariant();
                    bool events = ct.StartsWith("text/event-stream");
                    if (id == 0)
                    {
                        if (events) req.Abort();
                        else using (var rd0 = new StreamReader(resp.GetResponseStream(), new UTF8Encoding(false))) rd0.ReadToEnd();
                        return null;
                    }
                    var rd = new StreamReader(resp.GetResponseStream(), new UTF8Encoding(false));
                    if (events)
                    {
                        string ev = null, line;
                        var data = new StringBuilder();
                        while ((line = rd.ReadLine()) != null)
                        {
                            if (!SseLine(line, ref ev, data)) continue;
                            if (data.Length > 0 && (ev == null || ev == "message"))
                            {
                                var found = Consider(data.ToString(), id);
                                if (found != null) { req.Abort(); return found; }
                            }
                            ev = null;
                            data.Length = 0;
                        }
                        if (data.Length > 0 && (ev == null || ev == "message")) { var last = Consider(data.ToString(), id); if (last != null) return last; }
                        throw new ToolError(def.Name + "'s event stream ended without an answer to " + what + ".");
                    }
                    var text = rd.ReadToEnd();
                    if (text.Trim().Length == 0) throw new ToolError(def.Name + " sent an empty answer to " + what + ".");
                    var answer = Consider(text, id);
                    if (answer == null) throw new ToolError(def.Name + " answered " + what + " with something else: " + OneLine(text));
                    return answer;
                }
                finally { try { resp.Close(); } catch (Exception) { } }
            }

            HttpWebResponse Respond(HttpWebRequest req, string what)
            {
                try { return (HttpWebResponse)req.GetResponse(); }
                catch (WebException e)
                {
                    var r = e.Response as HttpWebResponse;
                    if (r == null) throw Unreachable(req, e, what);
                    int status = (int)r.StatusCode;
                    string auth = r.Headers["WWW-Authenticate"], body = "";
                    try { using (var rd = new StreamReader(r.GetResponseStream(), Encoding.UTF8)) body = rd.ReadToEnd(); } catch (Exception) { }
                    try { r.Close(); } catch (Exception) { }
                    throw new McpHttpError(status, body, auth);
                }
            }

            ToolError Unreachable(HttpWebRequest req, WebException e, string what)
            {
                if (e.Status == WebExceptionStatus.Timeout) return new ToolError(def.Name + " did not answer " + what + " in time.");
                return new ToolError("Could not reach " + def.Name + " at " + SafeUrl(req.RequestUri.AbsoluteUri) + " (" + OneLine(e.Message) + ").");
            }

            /** The older SSE transport (2024-11-05): a GET that stays open for the answers, and the address its first event names for the POSTs. */
            void OpenStream(string url)
            {
                transport = "sse";
                var req = NewRequest(url, "GET", Math.Min(waitMs, 30000));
                req.Accept = "text/event-stream";
                req.ReadWriteTimeout = Timeout.Infinite;   // events come when they come; Dispose aborts the read
                var resp = Respond(req, "the event stream");
                var ct = (resp.ContentType ?? "").ToLowerInvariant();
                if (!ct.StartsWith("text/event-stream"))
                {
                    try { resp.Close(); } catch (Exception) { }
                    throw new ToolError(def.Name + " did not open an event stream at " + SafeUrl(url) + " (it sent " + (ct.Length > 0 ? ct : "no content type") + ").");
                }
                stream = req;
                var baseUri = resp.ResponseUri;
                var reader = new Thread(() =>
                {
                    try
                    {
                        using (var rd = new StreamReader(resp.GetResponseStream(), new UTF8Encoding(false)))
                        {
                            string ev = null, line;
                            var data = new StringBuilder();
                            while ((line = rd.ReadLine()) != null)
                            {
                                if (!SseLine(line, ref ev, data)) continue;
                                if (data.Length > 0)
                                {
                                    if (ev == "endpoint") { postUrl = new Uri(baseUri, data.ToString().Trim()).AbsoluteUri; endpointKnown.Set(); }
                                    else if (ev == null || ev == "message") inbox.Add(data.ToString());
                                }
                                ev = null;
                                data.Length = 0;
                            }
                        }
                    }
                    catch (Exception) { }
                    finally
                    {
                        try { resp.Close(); } catch (Exception) { }
                        inbox.CompleteAdding();
                        endpointKnown.Set();
                    }
                });
                reader.IsBackground = true;
                reader.Start();
                if (!endpointKnown.WaitOne(Math.Min(waitMs, 30000)) || postUrl == null)
                    throw new ToolError(def.Name + "'s event stream did not say where to send messages (no endpoint event)." + Tail());
            }

            public void Dispose()
            {
                if (transport == "http" && sessionId != null)
                {
                    try
                    {
                        var req = NewRequest(def.Url, "DELETE", 3000);
                        req.Headers["Mcp-Session-Id"] = sessionId;
                        using (req.GetResponse()) { }
                    }
                    catch (Exception) { }
                }
                if (stream != null) { try { stream.Abort(); } catch (Exception) { } }
                if (proc != null)
                {
                    // The server's own children (npx starts node, cmd.exe starts npx) go with it.
                    List<Tuple<uint, long>> kids = null;
                    try { kids = Native.Descendants((uint)proc.Id); } catch (Exception) { }
                    try { input.Close(); } catch (Exception) { }
                    try { if (!proc.WaitForExit(1500)) proc.Kill(); } catch (Exception) { }
                    if (kids != null) foreach (var k in kids) Native.KillIfSame(k.Item1, k.Item2);
                    try { proc.Dispose(); } catch (Exception) { }
                }
            }
        }

        static void Describe(StringBuilder sb, Ctx ctx, Target t, Dictionary<string, object> prefs)
        {
            var rec = prefs.ContainsKey(t.Key) ? prefs[t.Key] as Dictionary<string, object> : null;
            var st = prefs.ContainsKey(t.StatusKey) ? prefs[t.StatusKey] as Dictionary<string, object> : null;
            bool self = t.ConvId == ctx.Self.ConvId;
            bool on = rec != null && Bool(rec, "on") == true;
            bool forever = IsUntilStopped(rec);

            sb.Append("Loop for ").Append(self ? "you" : t.Name ?? t.Suffix);
            if (t.Kind == "team")
                sb.Append(" (").Append(self ? (t.Name ?? "") + ", " : "").Append(t.Role ?? "member")
                  .Append(" on team \"").Append(t.TeamName ?? t.TeamId).Append("\")");
            else if (self && !string.IsNullOrEmpty(t.Name)) sb.Append(" (chat \"").Append(t.Name).Append("\")");
            sb.Append(": ").Append(on ? (forever ? "ON until the user stops it" : "ON") : "OFF");
            if (rec == null) sb.Append(" (never switched on)");
            sb.Append('\n');

            var msg = rec != null ? Str(rec, "msg") : null;
            sb.Append("  Continue message: ").Append(string.IsNullOrWhiteSpace(msg) || msg == DefaultMsg ? "the default, \"" + DefaultMsg + "\"" : "\"" + msg + "\"").Append('\n');

            if (rec != null)
            {
                var by = Str(rec, "by");
                var who = by == "agent" ? (Str(rec, "who") ?? "an agent") : by == "loop" ? "the Loop itself" : "the user";
                var noteText = Str(rec, "note");
                sb.Append("  Last change: by ").Append(who).Append(" at ").Append(Hhmm(Long(rec, "at")));
                if (!string.IsNullOrEmpty(noteText)) sb.Append(" (").Append(noteText).Append(")");
                sb.Append(".\n");
            }
            if (st != null)
            {
                var why = Str(st, "why");
                var offReason = Str(st, "offReason");
                long fires = Long(st, "fires"), lastFired = Long(st, "lastFired");
                if (on && !string.IsNullOrEmpty(why)) sb.Append("  Now: ").Append(why).Append('\n');
                if (!on && !string.IsNullOrEmpty(offReason) && offReason != "turned off") sb.Append("  Switched off: ").Append(offReason).Append(".\n");
                if (fires > 0) sb.Append("  Nudges since it was last switched on: ").Append(fires)
                                 .Append(lastFired > 0 ? ", the last at " + Hhmm(lastFired) : "").Append(".\n");
                // The prompt cache (build 2026-09-25.4 and later): 5 minutes from the agent's last message.
                long lastAt = Long(st, "lastAt"), warmUntil = Long(st, "warmUntil"), resting = Long(st, "restingSince");
                long nextNudge = Long(st, "nextNudgeAt");
                if (on && warmUntil > 0)
                {
                    long left = warmUntil - NowMs();
                    sb.Append("  Cache: ").Append(left > 0 ? "warm until " + Hhmm(warmUntil) + " (" + Ago(left) + " left)"
                                                           : "ran out at " + Hhmm(warmUntil))
                      .Append(", ").Append(self ? "your" : "its").Append(" last message at ").Append(Hhmm(lastAt)).Append(".");
                    if (resting == 0 && nextNudge > NowMs()) sb.Append(" Next nudge at ").Append(Hhmm(nextNudge)).Append(".");
                    sb.Append('\n');
                }
                if (on && resting > 0)
                    sb.Append("  Resting since ").Append(Hhmm(resting)).Append(": ")
                      .Append(Str(st, "restKind") == "hold" ? "the hold ran out, so it stopped keeping the cache warm"
                                                            : "the cache had run out, and the Loop does not wake a cold agent")
                      .Append(". It carries on when ").Append(self ? "you next work" : "the agent next works").Append(".\n");
            }
            if (forever)
            {
                long since = Long(rec, "foreverAt");
                sb.Append("  Runs until the user stops it").Append(since > 0 ? " (since " + Hhmm(since) + ")" : "")
                  .Append(": no hold and no rest, and it keeps trying through errors and silence. The user ends it with the Loop ")
                  .Append("menu, the agent's Stop button, or by saying so; an agent can only after the user asks for it in that agent's own chat.\n");
            }
            else if (on)
            {
                long holdMin = rec != null && rec.ContainsKey("holdMin") && rec["holdMin"] != null ? Long(rec, "holdMin") : HoldDefault;
                sb.Append("  Keeps the cache warm through ").Append(holdMin > 0 ? holdMin + " min of short replies, then rests" : "no short replies: it rests after the first")
                  .Append(" (hold ").Append(holdMin).Append(").\n");
            }
            long wakeAt = rec != null ? Long(rec, "wakeAt") : 0;
            if (on && wakeAt > 0)
            {
                long ahead = wakeAt - NowMs();
                string wakeBy = Str(rec, "wakeBy"), wakeMsg = Str(rec, "wakeMsg");
                sb.Append("  Resumes at ").Append(Hhmm(wakeAt));
                if (ahead > 0) sb.Append(" (in ").Append(Ago(ahead)).Append(")");
                if (!string.IsNullOrEmpty(wakeBy)) sb.Append(", set by ").Append(Bool(rec, "wakeSelf") == true && self ? "you" : wakeBy);
                sb.Append(": one nudge saying the time has come, with ")
                  .Append(string.IsNullOrEmpty(wakeMsg) ? "the continue message" : "\"" + wakeMsg + "\"").Append(". Until then its nudges say ")
                  .Append(self ? "you are" : "it is").Append(" holding; ")
                  .Append(ahead > ResumeWarmMaxMs ? "the cache is left to run out, which costs less than keeping it warm that long"
                                                  : "the cache is kept warm, past the hold if need be").Append(".\n");
            }
            long wokeAt = st != null ? Long(st, "wokeAt") : 0;
            if (wokeAt > 0 && NowMs() - wokeAt < 6 * 3600000L)
                sb.Append("  Resumed ").Append(self ? "you" : "it").Append(" at ").Append(Hhmm(wokeAt)).Append(", the resume time set.\n");
            long compactAt = rec != null ? Long(rec, "compactAt") : 0, compactSent = st != null ? Long(st, "compactSentAt") : 0;
            if (compactAt > 0)
            {
                if (compactSent >= compactAt) sb.Append("  Compaction: ").Append(Str(st, "compactNote") ?? "sent").Append('\n');
                else sb.Append("  Compaction: requested at ").Append(Hhmm(compactAt)).Append(", goes out when ").Append(self ? "you stop" : "it stops").Append(".\n");
            }
            sb.Append('\n');
        }

        static string EngineLine(Dictionary<string, object> prefs)
        {
            var e = prefs.ContainsKey(EngineKey) ? prefs[EngineKey] as Dictionary<string, object> : null;
            long at = e != null ? Long(e, "at") : 0;
            long age = NowMs() - at;
            if (at > 0 && age < EngineStaleMs)
                return "AionUi is running the Loop (last seen " + Ago(age) + " ago" +
                       (Str(e, "build") != null ? ", build " + Str(e, "build") : "") + ").";
            return "AionUi's Loop engine has not reported in the last 5 minutes" + (at > 0 ? " (last seen " + Ago(age) + " ago)" : "") +
                   ". The change is saved and takes effect once it runs: AionUi's window must be open, and the installed AionDX " +
                   "build must include the shared Loop (the user installs it with AionDX Apply Update).";
        }

        // ------------------------------------------------------------------ who is asking, and about whom

        static Ctx LoadContext()
        {
            var id = Id(false);
            var ctx = new Ctx();
            var teams = Api("GET", "/api/teams", null) as object[];
            if (teams != null)
            {
                foreach (var to in teams)
                {
                    var team = to as Dictionary<string, object>;
                    var members = team != null && team.ContainsKey("assistants") ? team["assistants"] as object[] : null;
                    if (members == null) continue;
                    var list = new List<Target>();
                    Target self = null;
                    foreach (var mo in members)
                    {
                        var mm = mo as Dictionary<string, object>;
                        if (mm == null) continue;
                        var t = new Target {
                            Kind = "team", TeamId = Str(team, "id"), TeamName = Str(team, "name"), SlotId = Str(mm, "slot_id"),
                            ConvId = Str(mm, "conversation_id"), Role = Str(mm, "role"), Name = Str(mm, "name") };
                        list.Add(t);
                        if (t.ConvId == id.ConvId) self = t;
                    }
                    if (self != null) { ctx.Self = self; ctx.Members = list; return ctx; }
                }
            }
            string name = null;
            try
            {
                var c = Api("GET", "/api/conversations/" + Uri.EscapeDataString(id.ConvId), null) as Dictionary<string, object>;
                if (c != null) name = Str(c, "name");
            }
            catch (ToolError) { }
            ctx.Self = new Target { Kind = "conv", ConvId = id.ConvId, Name = name };
            return ctx;
        }

        static List<Target> Resolve(Ctx ctx, string member, bool forWrite)
        {
            if (string.IsNullOrWhiteSpace(member)) return new List<Target> { ctx.Self };
            member = member.Trim();
            if (ctx.Self.Kind != "team")
                throw new ToolError("member is for team chats, and this chat is not on a team. Leave it out to use your own Loop.");
            List<Target> picked;
            if (member.Equals("all", StringComparison.OrdinalIgnoreCase)) picked = ctx.Members;
            else
            {
                picked = ctx.Members.Where(m => Same(m.SlotId, member) || Same(m.ConvId, member) || Same(m.Name, member)).ToList();
                if (picked.Count == 0)
                    picked = ctx.Members.Where(m => m.Name != null && m.Name.IndexOf(member, StringComparison.OrdinalIgnoreCase) >= 0).ToList();
                if (picked.Count == 0)
                    throw new ToolError("No teammate matches \"" + member + "\". The team: " + TeamList(ctx) + ".");
                if (picked.Count > 1)
                    throw new ToolError("\"" + member + "\" matches more than one teammate (" + string.Join(", ", picked.Select(m => m.Name)) +
                                        "). Use the full name or the slot id.");
            }
            if (forWrite && ctx.Self.Role != "lead" && picked.Any(m => m.ConvId != ctx.Self.ConvId))
                throw new ToolError("Only the team lead can change a teammate's Loop. Leave member out to change your own.");
            return picked;
        }

        static string TeamList(Ctx ctx)
        {
            return string.Join(", ", ctx.Members.Select(m => (m.Name ?? m.SlotId) + " (" + (m.Role ?? "member") + ")"));
        }

        static bool Same(string a, string b) { return a != null && string.Equals(a.Trim(), b, StringComparison.OrdinalIgnoreCase); }

        static Dictionary<string, object> ReadPrefs(List<Target> targets)
        {
            var keys = new List<string> { EngineKey };
            foreach (var t in targets) { keys.Add(t.Key); keys.Add(t.StatusKey); }
            var d = Api("GET", "/api/settings/client?keys=" + Uri.EscapeDataString(string.Join(",", keys.Distinct())), null) as Dictionary<string, object>;
            return d ?? new Dictionary<string, object>();
        }

        static string CompactCommand(string convId)
        {
            var list = Api("GET", "/api/conversations/" + Uri.EscapeDataString(convId) + "/slash-commands", null) as object[];
            if (list == null) return null;
            var names = new HashSet<string>(list.OfType<Dictionary<string, object>>().Select(c => Str(c, "command") ?? Str(c, "name")).Where(n => n != null));
            return CompactCommands.FirstOrDefault(names.Contains);
        }

        // ------------------------------------------------------------------ AionUi's API

        static object Api(string method, string path, string body)
        {
            var r = Http(method, path, body);
            if (r.Item1 == 401)
            {
                // A token belongs to the agent process that was started with it. Look again once.
                Id(true);
                r = Http(method, path, body);
            }
            if (r.Item1 < 200 || r.Item1 >= 300)
            {
                string detail = r.Item2;
                try
                {
                    var j = Json.DeserializeObject(r.Item2) as Dictionary<string, object>;
                    var err = j != null ? (Str(j, "message") ?? Str(j, "error") ?? (j.ContainsKey("error") ? Json.Serialize(j["error"]) : null)) : null;
                    if (err != null) detail = err;
                }
                catch (Exception) { }
                throw new ToolError("AionUi's API answered " + r.Item1 + " to " + method + " " + path.Split('?')[0] + ": " + OneLine(detail));
            }
            object parsed;
            try { parsed = Json.DeserializeObject(r.Item2); }
            catch (Exception) { throw new ToolError("AionUi's API sent something that is not JSON for " + path.Split('?')[0] + "."); }
            var wrapper = parsed as Dictionary<string, object>;
            return wrapper != null && wrapper.ContainsKey("data") ? wrapper["data"] : parsed;
        }

        static Tuple<int, string> Http(string method, string path, string body)
        {
            var id = Id(false);
            var req = (HttpWebRequest)WebRequest.Create(id.BaseUrl.TrimEnd('/') + path);
            req.Method = method;
            req.Proxy = null;             // a system proxy lookup can cost seconds, and this is 127.0.0.1
            req.Timeout = 10000;
            req.ReadWriteTimeout = 10000;
            req.Accept = "application/json";
            req.Headers["x-aionui-runtime-token"] = id.Token;
            req.Headers["x-aionui-user-id"] = id.UserId;
            req.Headers["x-aionui-conversation-id"] = id.ConvId;
            try
            {
                if (body != null)
                {
                    var bytes = Encoding.UTF8.GetBytes(body);
                    req.ContentType = "application/json";
                    req.ContentLength = bytes.Length;
                    using (var s = req.GetRequestStream()) s.Write(bytes, 0, bytes.Length);
                }
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var rd = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                    return Tuple.Create((int)resp.StatusCode, rd.ReadToEnd());
            }
            catch (WebException e)
            {
                var resp = e.Response as HttpWebResponse;
                if (resp == null)
                    throw new ToolError("AionUi's API at " + id.BaseUrl + " did not answer (" + e.Status + "). AionUi may be closed or restarting.");
                using (resp)
                using (var rd = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                    return Tuple.Create((int)resp.StatusCode, rd.ReadToEnd());
            }
        }

        // ------------------------------------------------------------------ identity

        static readonly string[] Needed = { "AIONUI_BASE_URL", "AIONUI_RUNTIME_TOKEN", "AIONUI_USER_ID", "AIONUI_CONVERSATION_ID" };

        static Identity Id(bool force)
        {
            if (Ident != null && !force) return Ident;
            var own = new Dictionary<string, string>();
            foreach (var k in Needed) own[k] = Environment.GetEnvironmentVariable(k);
            // AIONDX_LOOP_NO_ANCESTORS=1 is for the tests: run inside an AionUi chat, the walk would
            // otherwise reach that chat's real agent and its real API.
            var found = FromEnv(own, "own environment") ??
                        (Environment.GetEnvironmentVariable("AIONDX_LOOP_NO_ANCESTORS") == "1" ? null : FromAncestors());
            if (found == null)
                throw new ToolError("The Loop tool cannot tell which AionUi chat it belongs to: neither its own environment nor its " +
                                    "parent processes carry AIONUI_CONVERSATION_ID. It works in chats that AionUi starts.");
            Ident = found;
            return found;
        }

        static Identity FromEnv(IDictionary<string, string> env, string source)
        {
            string v;
            foreach (var k in Needed) if (!env.TryGetValue(k, out v) || string.IsNullOrEmpty(v)) return null;
            return new Identity {
                BaseUrl = env["AIONUI_BASE_URL"], Token = env["AIONUI_RUNTIME_TOKEN"], UserId = env["AIONUI_USER_ID"],
                ConvId = env["AIONUI_CONVERSATION_ID"], Source = source };
        }

        static Identity FromAncestors()
        {
            var procs = Native.Snapshot();
            uint pid = Native.GetCurrentProcessId();
            long childStarted = Native.StartTime(pid);
            var seen = new HashSet<uint> { pid };
            for (int depth = 0; depth < 12; depth++)
            {
                Tuple<uint, string> me;
                if (!procs.TryGetValue(pid, out me)) return null;
                uint ppid = me.Item1;
                Tuple<uint, string> parent;
                if (ppid == 0 || !seen.Add(ppid) || !procs.TryGetValue(ppid, out parent)) return null;
                long parentStarted = Native.StartTime(ppid);
                // A parent that started after its child is a stranger holding a reused process id.
                if (parentStarted == 0 || (childStarted != 0 && parentStarted > childStarted)) return null;
                var env = Native.ReadEnvironment(ppid);
                if (env != null)
                {
                    var id = FromEnv(env, "process " + parent.Item2 + " " + ppid);
                    if (id != null) return id;
                }
                pid = ppid;
                childStarted = parentStarted;
            }
            return null;
        }

        static int PrintIdentity()
        {
            try
            {
                var id = Id(false);
                Console.Out.WriteLine(Json.Serialize(new Dictionary<string, object> {
                    { "source", id.Source }, { "conversation_id", id.ConvId }, { "base_url", id.BaseUrl },
                    { "has_token", !string.IsNullOrEmpty(id.Token) }, { "has_user", !string.IsNullOrEmpty(id.UserId) } }));
                return 0;
            }
            catch (ToolError e)
            {
                Console.Out.WriteLine(Json.Serialize(new Dictionary<string, object> { { "error", e.Message } }));
                return 1;
            }
        }

        /** Exit when the process that started this one ends, even if nobody closes stdin. */
        static void ExitWithParent()
        {
            try
            {
                Tuple<uint, string> me;
                if (!Native.Snapshot().TryGetValue(Native.GetCurrentProcessId(), out me) || me.Item1 == 0) return;
                var h = Native.OpenProcess(Native.SYNCHRONIZE, false, me.Item1);
                if (h == IntPtr.Zero) return;
                var t = new Thread(() => { Native.WaitForSingleObject(h, Native.INFINITE); Environment.Exit(0); }) { IsBackground = true };
                t.Start();
            }
            catch (Exception) { }
        }

        // ------------------------------------------------------------------ small helpers

        static string Str(Dictionary<string, object> d, string k)
        {
            object v;
            return d != null && d.TryGetValue(k, out v) && v != null ? (v as string ?? Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture)) : null;
        }

        static bool? Bool(Dictionary<string, object> d, string k)
        {
            object v;
            if (d == null || !d.TryGetValue(k, out v) || v == null) return null;
            if (v is bool) return (bool)v;
            var s = Convert.ToString(v).Trim().ToLowerInvariant();
            if (s == "true") return true;
            if (s == "false") return false;
            return null;
        }

        static long Long(Dictionary<string, object> d, string k)
        {
            object v;
            if (d == null || !d.TryGetValue(k, out v) || v == null) return 0;
            try { return Convert.ToInt64(v, System.Globalization.CultureInfo.InvariantCulture); } catch (Exception) { return 0; }
        }

        static long NowMs() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds; }

        static string Hhmm(long ms)
        {
            if (ms <= 0) return "an unknown time";
            return DateTimeOffset.FromUnixTimeMilliseconds(ms).ToLocalTime().ToString("HH:mm");
        }

        static string Ago(long ms)
        {
            long s = Math.Max(0, ms / 1000);
            if (s < 60) return s + " s";
            if (s < 3600) return (s / 60) + " min";
            return (s / 3600) + " h";
        }

        static string OneLine(string s)
        {
            s = (s ?? "").Replace("\r", " ").Replace("\n", " ");
            return s.Length > 300 ? s.Substring(0, 300) + "..." : s;
        }

        static Dictionary<string, object> Redact(Dictionary<string, object> a)
        {
            var r = new Dictionary<string, object>(a);
            if (r.ContainsKey("message") && r["message"] is string && ((string)r["message"]).Length > 80) r["message"] = ((string)r["message"]).Substring(0, 80) + "...";
            return r;
        }

        /** One line per tool call in %LOCALAPPDATA%\AionDX\logs\loop-tool.log, never a token. Kept under 512 KB. */
        static void Log(string line)
        {
            try
            {
                var dir = Environment.GetEnvironmentVariable("AIONDX_LOOP_LOG_DIR");   // the tests' own folder
                if (string.IsNullOrEmpty(dir)) dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AionDX", "logs");
                Directory.CreateDirectory(dir);
                var file = Path.Combine(dir, "loop-tool.log");
                var fi = new FileInfo(file);
                if (fi.Exists && fi.Length > 512 * 1024) File.Copy(file, file + ".1", true);
                if (fi.Exists && fi.Length > 512 * 1024) File.WriteAllText(file, "");
                File.AppendAllText(file, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " pid=" + Native.GetCurrentProcessId() + " " + line + Environment.NewLine);
            }
            catch (Exception) { }
        }
    }

    static class Native
    {
        public const uint SYNCHRONIZE = 0x00100000;
        public const uint INFINITE = 0xFFFFFFFF;
        const uint PROCESS_QUERY_INFORMATION = 0x0400, PROCESS_VM_READ = 0x0010, PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        const uint TH32CS_SNAPPROCESS = 0x00000002;

        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32W pe);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32W pe);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
        [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
        [DllImport("kernel32.dll")] public static extern uint GetCurrentProcessId();
        [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PROCESS_BASIC_INFORMATION pbi, int len, out int retLen);

        // Windows' data protection (DPAPI), for the AionDX MCP file's credentials: sealed with the signed-in Windows
        // account's own key, so only that account on this PC can read them back.
        [StructLayout(LayoutKind.Sequential)]
        struct DATA_BLOB { public int cbData; public IntPtr pbData; }
        [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool CryptProtectData(ref DATA_BLOB dataIn, string description, ref DATA_BLOB entropy, IntPtr reserved, IntPtr prompt, int flags, ref DATA_BLOB dataOut);
        [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool CryptUnprotectData(ref DATA_BLOB dataIn, IntPtr description, ref DATA_BLOB entropy, IntPtr reserved, IntPtr prompt, int flags, ref DATA_BLOB dataOut);
        [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr mem);
        const int CRYPTPROTECT_UI_FORBIDDEN = 0x1;
        static readonly byte[] SealEntropy = Encoding.UTF8.GetBytes("AionDX MCP file");

        /** bytes sealed for this Windows account (protect) or opened again (unprotect); null when Windows refuses. */
        public static byte[] Dpapi(byte[] data, bool protect)
        {
            var inH = GCHandle.Alloc(data, GCHandleType.Pinned);
            var enH = GCHandle.Alloc(SealEntropy, GCHandleType.Pinned);
            var outB = new DATA_BLOB();
            try
            {
                var inB = new DATA_BLOB { cbData = data.Length, pbData = inH.AddrOfPinnedObject() };
                var enB = new DATA_BLOB { cbData = SealEntropy.Length, pbData = enH.AddrOfPinnedObject() };
                bool ok = protect ? CryptProtectData(ref inB, "AionDX MCP secret", ref enB, IntPtr.Zero, IntPtr.Zero, CRYPTPROTECT_UI_FORBIDDEN, ref outB)
                                  : CryptUnprotectData(ref inB, IntPtr.Zero, ref enB, IntPtr.Zero, IntPtr.Zero, CRYPTPROTECT_UI_FORBIDDEN, ref outB);
                if (!ok) return null;
                var result = new byte[outB.cbData];
                Marshal.Copy(outB.pbData, result, 0, outB.cbData);
                return result;
            }
            finally
            {
                inH.Free();
                enH.Free();
                if (outB.pbData != IntPtr.Zero) LocalFree(outB.pbData);
            }
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct PROCESSENTRY32W
        {
            public uint dwSize, cntUsage, th32ProcessID;
            public IntPtr th32DefaultHeapID;
            public uint th32ModuleID, cntThreads, th32ParentProcessID;
            public int pcPriClassBase;
            public uint dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct PROCESS_BASIC_INFORMATION
        {
            public IntPtr ExitStatus, PebBaseAddress, AffinityMask, BasePriority, UniqueProcessId, InheritedFromUniqueProcessId;
        }

        /** pid -> (parent pid, exe name) for every process. */
        public static Dictionary<uint, Tuple<uint, string>> Snapshot()
        {
            var map = new Dictionary<uint, Tuple<uint, string>>();
            var snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return map;
            try
            {
                var pe = new PROCESSENTRY32W { dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W)) };
                if (!Process32FirstW(snap, ref pe)) return map;
                do { map[pe.th32ProcessID] = Tuple.Create(pe.th32ParentProcessID, pe.szExeFile); } while (Process32NextW(snap, ref pe));
            }
            finally { CloseHandle(snap); }
            return map;
        }

        /** Process creation time as a FILETIME value, 0 if it cannot be read. */
        public static long StartTime(uint pid)
        {
            var h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (h == IntPtr.Zero) return 0;
            try { long c, e, k, u; return GetProcessTimes(h, out c, out e, out k, out u) ? c : 0; }
            finally { CloseHandle(h); }
        }

        /** Another process's environment, read from its PEB (x64 offsets: PEB+0x20 ProcessParameters,
         *  +0x80 Environment, +0x3F0 EnvironmentSize). Null when it cannot be read. */
        public static Dictionary<string, string> ReadEnvironment(uint pid)
        {
            var h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
            if (h == IntPtr.Zero) return null;
            try
            {
                var pbi = new PROCESS_BASIC_INFORMATION();
                int ret;
                if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)), out ret) != 0) return null;
                long pp = ReadPtr(h, pbi.PebBaseAddress.ToInt64() + 0x20);
                if (pp == 0) return null;
                long envPtr = ReadPtr(h, pp + 0x80);
                long envSize = ReadPtr(h, pp + 0x3F0);
                if (envPtr == 0) return null;
                if (envSize <= 0 || envSize > 4 * 1024 * 1024) envSize = 64 * 1024;
                var raw = Read(h, envPtr, (int)envSize);
                if (raw == null) return null;
                var text = Encoding.Unicode.GetString(raw);
                int end = text.IndexOf("\0\0", StringComparison.Ordinal);
                if (end >= 0) text = text.Substring(0, end);
                var env = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (var entry in text.Split('\0'))
                {
                    int eq = entry.IndexOf('=', 1);
                    if (entry.Length == 0 || entry[0] == '=' || eq <= 0) continue;
                    env[entry.Substring(0, eq)] = entry.Substring(eq + 1);
                }
                return env;
            }
            catch (Exception) { return null; }
            finally { CloseHandle(h); }
        }

        static long ReadPtr(IntPtr h, long addr)
        {
            var b = Read(h, addr, 8);
            return b == null ? 0 : BitConverter.ToInt64(b, 0);
        }

        static byte[] Read(IntPtr h, long addr, int size)
        {
            var buf = new byte[size];
            IntPtr got;
            if (!ReadProcessMemory(h, new IntPtr(addr), buf, new IntPtr(size), out got) || got.ToInt64() <= 0) return null;
            if (got.ToInt64() < size) Array.Resize(ref buf, (int)got.ToInt64());
            return buf;
        }

        // ---- what an MCP server started for one command leaves behind: nothing (1.6.0)

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        static IntPtr ownJob = IntPtr.Zero;

        /** Puts this process in a job that Windows ends when this process ends, killed or not, and every process it
         *  started with it: an MCP server, and the cmd, npx and node under it. Best effort; the handle stays open. */
        public static void KillChildrenWithMe()
        {
            if (ownJob != IntPtr.Zero) return;
            var job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero) return;
            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = 0x2000;   // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if (SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))) &&
                AssignProcessToJobObject(job, GetCurrentProcess()))
                ownJob = job;
            else CloseHandle(job);
        }

        /** Every process root started, and theirs: (id, start time). A process older than its supposed parent holds a reused id and is left out. */
        public static List<Tuple<uint, long>> Descendants(uint root)
        {
            var map = Snapshot();
            var found = new List<Tuple<uint, long>>();
            var queue = new Queue<uint>();
            var seen = new HashSet<uint> { root };
            queue.Enqueue(root);
            while (queue.Count > 0)
            {
                uint p = queue.Dequeue();
                long pStart = StartTime(p);
                foreach (var kv in map)
                {
                    if (kv.Value.Item1 != p || seen.Contains(kv.Key)) continue;
                    long cStart = StartTime(kv.Key);
                    if (pStart != 0 && cStart != 0 && cStart < pStart) continue;
                    seen.Add(kv.Key);
                    found.Add(Tuple.Create(kv.Key, cStart));
                    queue.Enqueue(kv.Key);
                }
            }
            return found;
        }

        /** Kills pid if it is still the process that started at that time. */
        public static void KillIfSame(uint pid, long started)
        {
            try
            {
                if (started != 0 && StartTime(pid) != started) return;
                using (var p = System.Diagnostics.Process.GetProcessById((int)pid)) if (!p.HasExited) p.Kill();
            }
            catch (Exception) { }
        }
    }
}
