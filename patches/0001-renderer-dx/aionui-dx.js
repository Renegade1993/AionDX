/* aionui-dx.js - injected into the AionUi renderer via a <script> tag in
 * out/renderer/index.html inside app.asar. AionDX patch 0001.
 *
 * LOOP: keeps a chat working after each turn. It works in two places:
 *
 *   Solo chat, #/conversation/<id>. While on, it polls the conversation and,
 *   once a turn has finished and gone quiet, POSTs the continue message to
 *   /api/conversations/{id}/messages, the same call the send box makes.
 *
 *   Team, #/team/<id>. The team page shows every member in its own column,
 *   div[data-slot-id][data-role], each with its own composer, so each column gets
 *   its own pill bound to that member. A team member's input does not go to its
 *   conversation directly: the team runtime enqueues it (aionui-team
 *   session.rs, enqueue_user_message), and the lead writes to that same queue. So
 *   in a team the loop:
 *     - reads GET /api/teams/{id}/run-state and fires only when that member's
 *       slot_work.state is "idle" with nothing queued, so it never talks over work
 *       the lead has lined up;
 *     - sends through POST /api/teams/{id}/agents/{slot}/messages, the team's own
 *       path, so the runtime tracks the turn;
 *     - finds the member's conversation from GET /api/teams/{id} (assistants[])
 *       for the quiet-time and no-reply checks.
 *   All checked against AionCore v0.2.2 source.
 *
 * YOUR OWN MESSAGES DO NOT SWITCH IT OFF (since 2026-09-24). Until then, pressing send in a
 * loop's box switched that loop off. K talks to his agents all the time, so every team loop he
 * switched on was off again before it ever fired: each saved team loop read "Off: you sent a
 * message", 0 sends, which he read as "the loop only works for claude agents". Now a send of
 * yours resets the loop's backoff, it holds back while you have a draft in that box, and after
 * you speak it gives the reply a minute of quiet before its next nudge. A team member's history
 * cannot tell your messages from the lead's, so on a team page your send button is the signal;
 * a solo chat's history shows your messages as well. Off is the menu's choice, or 3 sends with
 * no reply.
 *
 * WHY IT DID NOT SEND. Every check records its decision ("Not sending: it is working.",
 * "Waiting a minute after your message.", "Paused ... Retry 1 of 10 at 10:31.") and the hover
 * card and menu show it.
 *
 * IT NEVER SENDS TO AN AGENT THAT IS WORKING. A solo chat must have finished its turn; a team
 * member must be idle with nothing queued. Then: 20 s of quiet, at least 60 s since its last
 * nudge, and at most one send per team every 2 minutes (a spacing rule between members, not a
 * timer).
 *
 * IT KEEPS A WAITING AGENT'S CACHE WARM, AND NEVER WAKES A COLD ONE (since 2026-09-25). Anthropic
 * keeps a prompt cached for 5 minutes and refreshes that free each time it is read. A nudge inside
 * the window reads the cache (0.1x the input price; 0.05x on Opus 5.5); a nudge after it writes the
 * whole context again (1.25x). Until build 2026-09-25.4 a short reply ("nothing to do yet") pushed
 * the next nudge to 5, 10, 20 and 30 minutes after the last one, so almost every nudge after the
 * second paid a full reload. A team lead logged it (AionDX dev log, September 25th) and K:
 * "THE LOOP HAS FAILED IT'S JOB MULTIPLE TIMES THIS AFTERNOON AND CAUSED LOADS OF USAGE BURNED ON
 * DUMB-CACHING/UNCACHING". Now, counted from the agent's own last message:
 *   - after real work the next nudge goes once the chat is quiet (20 s);
 *   - after a short reply (under 3 minutes, fewer than 6 tool-call records) it goes at 2 minutes,
 *     and after two or more at 4 minutes, always inside the window;
 *   - after 45 minutes of short replies (the hold; 12 warm reads cost about one reload) it RESTS:
 *     no more nudges, and the cache is allowed to expire;
 *   - an agent whose cache has already expired is never nudged. It rests until someone else gives
 *     it work; the Loop carries on after that turn. Switching a Loop on for a cold agent sends one
 *     nudge, because someone asked for exactly that.
 * So a Loop left on overnight, or on after AionUi was closed, does nothing to a cold agent.
 *
 * YOUR STOP SWITCHES IT OFF. A message you send that says stop ("stop", "time to stop work", "stand
 * down", "we're done", "good night" and the rest of STOP_RES) switches off the Loop of that chat,
 * or every Loop of that team. A team lead found the Loop nudging at 06:58 after K had ended
 * the session the night before.
 *
 * A loop runs whenever AionUi is open, on any page: every chat and team member whose loop is
 * on is ticked from its saved state, not only the one on screen. (Until 2026-09-23 a loop ran
 * only while its page was open, so a team left in the background was never looked after.)
 *
 * PAUSED MEMBERS AND FAILED TURNS. A team slot that fails three deliveries is paused, and the
 * three tries take about two seconds, so any provider limit pauses it; a Devin free-model limit
 * lasts about 20 minutes. A paused slot drops ordinary team messages, but a user message
 * resumes it (aionui-team work_source.rs, resumes_paused_slot), which is exactly what the loop
 * sends. So a paused member with its loop on is resumed on a schedule. When the error states
 * its reset ("Your limit will reset in 19 minutes", which a Devin proxy script passes
 * through from Devin's log since 2026-09-23), the loop waits exactly that long plus 30 s;
 * Devin has a burst limit that clears in under a minute as well as a budget that takes 20.
 * Otherwise: first try 20 minutes after an error that reads as a provider limit (2 minutes
 * after any other), then 10, 15, 15 and 30 minutes apart, 10 tries at most. Resumes go
 * teammates before the lead, so the lead wakes to members that are already running.
 *
 * ONE SEND PER TEAM EVERY 2 MINUTES, resumes and continue messages alike. Firing several
 * members at once, as happens after an AionUi restart when all of them come back idle, is the
 * burst that tripped Devin's one-minute limit at 09:20 on 2026-09-23. A solo
 * chat whose last turn failed waits on the same schedule instead of re-sending every minute.
 *
 * UI. A round icon button with the class list of the composer's own circle buttons (arco-btn
 * arco-btn-secondary arco-btn-size-small arco-btn-shape-circle, 28 x 28), at the front of
 * .sendbox-actions next to the Permission pill, so it inherits size, hover and theme. Grey when
 * off; tinted and ringed in the theme's primary colour when on; amber while it holds back (a
 * paused member sitting out a limit, or a backoff). Hovering (or keyboard focus) shows an
 * explainer: what the loop does, its rules, what the colours mean, and the current status. It
 * uses Arco's tooltip classes, which AionUi restyles, so it matches the app's own tooltips. A
 * click opens the menu, which reuses the Arco dropdown classes. Until 2026-09-23 it was a labelled pill,
 * "Loop · On", which K found too wide for team columns.
 *
 * SHARED WITH AGENTS (since 2026-09-24, P-010). K: "we should both be using the same buttons and
 * tools (and if it's using a tool i want to see visual feedback of it)". Each Loop's settings (on
 * or off, the continue message, a compaction request) are kept in AionUi's per-user settings
 * store, GET/PUT /api/settings/client, where the AionDX Loop tool (patches\0007-loop-tool, an MCP
 * server every agent gets) reads and writes the same record: aiondx.loop.conv.<id> and
 * aiondx.loop.team.<teamId>.<slotId>. This script reads them on every check (every 3 s), so a
 * change an agent makes shows within seconds: a notice at the top of the window with the agent's
 * name and note, and a purple mark on the button for 10 minutes. What the Loop last decided goes
 * to aiondx.loopstatus.<same> for the tool's loop_status, and aiondx.engine says this script is
 * running. Counters and timers stay in localStorage. Conversation extra was the first plan, but a
 * PATCH there stamps updated_at and the sidebar sorts by it, so every toggle would have moved the
 * chat to the top of K's list.
 *
 * UNSEND, THE ACCOUNT PILL, NOTICES THAT SAY WHERE (since 2026-09-25). A message a Claude chat has not
 * read yet ("Unread" under it) gets an Unsend button (see "unsend" below). A Claude chat gets an
 * account pill beside AionUi's model picker (see "the chat's Claude account"). Every notice names its
 * team and member, or its chat, and a click opens it. (Build 2026-09-25.4 held messages to a working
 * agent in an outbox above the box first. K: "why is there this extra message queue step? i never
 * asked for that". Removed in 2026-09-25.5.)
 *
 * COMPACT (since 2026-09-24). The menu offers "Compact its context" when the agent lists a compact
 * command: /compact for Claude and Codex, /compress for Gemini CLI and Qwen. It goes out the next
 * time the agent stops, through the same path as a nudge, whether the Loop is on or off. An agent
 * can ask for the same through the tool.
 *
 * THE MENU IS BUILT ONCE PER OPENING AND UPDATED IN PLACE. An earlier build
 * re-rendered it on every DOM mutation, including its own, so it rebuilt itself
 * every frame and real clicks never landed (a click needs mouse-down and mouse-up
 * on the same element). The page watcher ignores mutations inside our own nodes.
 * tools\dx-harness\click-test.js drives it with real mouse input.
 *
 * Kill switch: localStorage['aionui.dx.disabled'] = '1' hides every pill and stops
 * all polling. Or remove the <script> tag / restore the stock asar.
 */
(function () {
  'use strict';
  if (window.__aionDxLoaded) return;
  window.__aionDxLoaded = true;

  var POLL_MS = 15000;
  var MIN_FIRE_GAP_MS = 60000;   // never fire twice within 60s
  var QUIET_MS = 20000;          // require 20s since the last message before firing
  var QUIET_AFTER_USER_MS = 60000; // after your own message, a minute of quiet after the reply
  var PULSE_MS = 3000;           // live working / idle check for the chats on screen
  var STALL_LIMIT = 3;           // turn off after N sends that drew no reply
  var TEAM_CACHE_MS = 60000;     // how long a team's slot-to-conversation map is trusted
  var KEY_PREFIX = 'aionui.dx.';
  var LOOP_TAG = '[AionDX Loop: sent automatically, not typed by the user] ';
  var DEFAULT_MSG = 'CONTINUE WORKING. Re-check the project plan and queue files, take the next unfinished item, and keep going until the user interrupts.';

  // The cache window; see the header.
  var CACHE_TTL_MS = 5 * 60000;           // Anthropic's prompt cache: 5 minutes, refreshed on each read
  var WARM_LATEST_MS = CACHE_TTL_MS - 20000; // a nudge later than this after the agent's last message would miss it
  var SHORT_TURN_MS = 3 * 60000;          // a turn after a nudge shorter than this ...
  var SHORT_TURN_TOOL_RECORDS = 6;        // ... with fewer tool-call records than this is "nothing to do"
  var NUDGE_WAITS_MS = [2, 4].map(function (m) { return m * 60000; });  // after 1, then 2+ short replies, from its last message
  var HOLD_MIN = 45;                      // minutes of short replies kept warm before the Loop rests
  var HOLD_CHOICES = [0, 45, 90, 180];    // the menu's choices; 0 rests after the first short reply
  var HOLD_MIN_MAX = 240;
  // Resume at a set time (build 2026-09-26.2). A team lead, asked to slow down until 12:10 for a new
  // usage window, answered each keep-warm nudge "Holding" and never resumed: nothing told it the time had
  // come (team log, 2026-09-26). A Loop can carry one resume time and message (the Loop tool's resume_at, or
  // the menu). Until then its keep-warm nudges say it is holding, and the hold does not end them while the
  // time is under RESUME_WARM_MAX_MS away (keeping the cache warm that long costs less than one reload);
  // further out it lets the cache run out. At the time, one nudge says so, with the message. Off clears it.
  var RESUME_WARM_MAX_MS = 50 * 60000;
  var CLAUDE_SEND_GAP_MS = 20000;         // spacing between nudges to a team's Claude members
  // Your messages that switch a Loop off: the stop phrases of a Claude Code stop hook,
  // narrowed where K also says them to agents about their work ("stop the tournament", "that's
  // enough data", "pause the spread", "shut it down" about a process), plus "time to stop" and
  // "good night". A phrase that negates stop ("don't stop", "until I tell you to stop") never counts.
  // Each is tested clause by clause (split at . ! ? ; , and line breaks), and a phrase in a clause
  // that begins with when, once, after, until, before, if and the like (STOP_SUBORD_RE) does not
  // count: build 2026-09-25.5 read "...and then swap it when we are done testing", said to the
  // team lead about a game install, as K's stop and switched off both members' Loops; their
  // caches went cold (team log, 2026-09-25). "we're done" now also has to end its clause, or be
  // followed only by "for now", "for today", "for tonight", "for the day" or "here".
  var STOP_RES = [
    /^\s*(?:ok(?:ay)?[,.]?\s+)?(?:please\s+)?stop(?:\s+(?:now|here|there|everything|please|for\s+now|for\s+today|working|work))?\s*[.!]*\s*$/i,
    /^\s*(?:(?:ok(?:ay)?|alright|so|then|now|please|and)\s+)*(?:let'?s\s+)?stop\s+(?:all\s+)?work(?:ing)?\b(?:\s+(?:for\s+(?:now|today|tonight|the\s+day)|now|here))?(?:\s+and\s+(?:write|save|commit|update|report|summari[sz]e|log|note|document|hand\s+off)\b.*)?\s*$/i,
    /^\s*(?:(?:ok(?:ay)?|alright|so|then|please|and)\s+)*(?:let'?s\s+)?stop\s+(?:right\s+)?now\s*$/i,
    /^\s*(?:(?:ok(?:ay)?|alright|so|and)\s+)*(?:it'?s\s+)?time\s+to\s+stop(?:\s+(?:work(?:ing)?|now|here))?(?:\s+for\s+(?:now|today|tonight|the\s+day))?\s*$/i,
    /^\s*(?:(?:ok(?:ay)?|alright|so|then|please|and)\s+)*(?:let'?s\s+)?stop\s+(?:for\s+now|for\s+today|for\s+tonight|for\s+the\s+day|here|there)\s*$/i,
    /\bthat'?s\s+enough(?:\s+for\s+(?:now|today|tonight))?\s*[.!]*\s*$/i, /\bthat'?s\s+enough\s+for\s+(?:now|today|tonight)\b/i,
    /\bstand\s+down\b/i, /\busage\s+is\s+cooked\b/i,
    /\bwe(?:'re|\s+are)\s+done(?:\s+(?:for\s+(?:now|today|tonight|the\s+day|the\s+night)|here))?\s*$/i,
    /^\s*were\s+done(?:\s+(?:for\s+(?:now|today|tonight|the\s+day|the\s+night)|here))?\s*$/i,
    /\bcome\s+to\s+a\s+stop\s*$/i, /^\s*(?:(?:ok(?:ay)?|alright|so|then)\s+)*let'?s\s+stop\s*$/i,
    /^\s*(?:(?:ok(?:ay)?|alright|so|then|please)\s+)*(?:let'?s\s+)?wrap\s+it\s+up(?:\s+(?:for\s+(?:now|today|tonight|the\s+day)|here|now))?\s*$/i,
    /\bwrap\s+up\s+(?:when|for\s+(?:now|today|the\s+day)|here|now)\b/i,
    /^\s*(?:(?:ok(?:ay)?|alright|so|then|let'?s)\s+)*call\s+it\s+(?:a\s+day|a\s+night|here|quits)\b/i, /^\s*(?:(?:ok(?:ay)?|please)\s+)*knock\s+it\s+off\s*$/i,
    /^\s*(?:ok(?:ay)?\s+|alright\s+|thanks\s+|thank\s+you\s+)?good\s*night\b/i];
  // A stop that is not the Loop's. September 28th, K told a team lead: "have them stand down once everything is produced...
  // We can let one teammate continue working, that lane has top priority", and every Loop in the team went off, that
  // teammate's too. So a message that carves someone out ("let Builder continue working", "except Worker") stops nothing, a stop told to be relayed to
  // others ("have them stand down", "tell Worker to stand down") is the lead's to carry out, and a stop followed by its
  // condition ("stand down once it is produced") waits for the condition. K can say it plainly to stop everyone.
  var STOP_CARVE_RES = [
    /\b(?:let|keep|leave)\s+(?!(?:me|us|you|it\s+be)\b)[\w'-]+(?:\s+[\w'-]+){0,3}?\s+(?:continue|carry\s+on|keep\s+(?:going|working|running)|go\s+on|going|running|working)\b/i,
    /\b(?:except|excluding|other\s+than|apart\s+from|aside\s+from)\s+\S/i,
    /\b(?:but|though)\s+(?:keep|let|leave)\b/i];
  var STOP_RELAY_RE = /\b(?:have|tell|ask|get|make|order|instruct|want)\s+(?:the\s+)?(?!(?:everyone|everybody|all|the\s+team|us|you|y'?all|to)\b)[\w'-]+(?:\s+[\w'-]+){0,2}?\s+(?:to\s+)?$/i;
  var STOP_THEN_COND_RE = /^\s*(?:and\s+|then\s+)?(?:once|when|whenever|after|until|till|if|unless|as\s+soon\s+as)\b/i;
  var STOP_SUBORD_RE = /\b(?:when|whenever|once|after|until|till|before|if|unless|as\s+soon\s+as|by\s+the\s+time|so\s+that|in\s+case)\b/i;
  // Turning the Loop itself off, said to one chat or member (K, 2026-09-26: "or ask it to turn it off specifically").
  // Only that chat's or member's Loop goes off, whatever its mode.
  var LOOP_OFF_RES = [
    /\b(?:turn|switch|shut|put)\s+(?:the\s+|your\s+|this\s+|that\s+|my\s+|its\s+)?loop\s+off\b/i,
    /\b(?:turn|switch|shut)\s+off\s+(?:the\s+|your\s+|this\s+|that\s+|my\s+|its\s+)?loop\b/i,
    /\b(?:stop|end|kill|cancel|disable|quit)\s+(?:the\s+|your\s+|this\s+|that\s+|my\s+|its\s+)?loop(?:ing)?\b/i,
    /^\s*(?:ok(?:ay)?[,\s]+)?(?:please\s+)?(?:loop\s+off|no\s+more\s+loop(?:ing)?|stop\s+looping)\s*[.!]*\s*$/i];
  var LOOP_OFF_NOT_RES = [
    /\b(?:don'?t|do\s+not|never|no\s+need\s+to|can'?t|cannot|won'?t|shouldn'?t|wouldn'?t)\s+(?:\w+\s+){0,3}?(?:turn|switch|shut|put|stop|end|kill|cancel|disable|quit)\b/i,
    /\bkeep\s+(?:the\s+|your\s+|this\s+|that\s+|my\s+|its\s+)?loop\b/i];
  var LOOP_OFF_ASK_RE = /^\s*(?:ok(?:ay)?[,\s]+)?(?:please\s+)?(?:can|could|would|will)\s+you\s+/i;
  // "Turn off the loop for Worker", "the loop on the worker": someone else's Loop, so the chat it was said in keeps its own.
  var LOOP_OTHER_RE = /\bloop\s+(?:for|on|of)\s+(?!(?:you|yourself|now|today|tonight|the\s+(?:day|night)|good|here|this\s+chat|a\s+(?:bit|while|minute|moment|second))\b)\S/i;
  // Any request to switch a Loop off, this chat's or a teammate's ("turn off Worker's loop", "stop all the loops"). The
  // chat it was said in gets aiondx.loopask.<chat or member> in the store: the Loop tool lets an agent switch off a Loop
  // that runs until you stop it only after that, from that chat (K's words, which no agent writes).
  // Up to 30 characters between the verb and "loop", within one clause ("turn off the lights and fix the loop" is not one).
  var ASK_GAP = '(?:(?!\\b(?:and|then|but|so|or)\\b)[^.!?;\\n]){0,30}';
  var LOOP_ASK_RES = [
    new RegExp('\\b(?:turn|switch|shut|put)\\b' + ASK_GAP + '\\bloops?\\b[^.!?;\\n]{0,12}\\boff\\b', 'i'),
    new RegExp('\\b(?:turn|switch|shut)\\s+off\\b' + ASK_GAP + '\\bloop(?:s|ing)?\\b', 'i'),
    // stop, end and the like only as an instruction: opening the sentence or after a name and comma, "please", "can you" ...
    // ("at the end of the loop" is not one).
    new RegExp('(?:^|[,:]\\s*|\\b(?:please|and|then|also|now|so|ok(?:ay)?|you\\s+can|can\\s+you|could\\s+you|would\\s+you|go\\s+ahead\\s+and)\\s+)' +
      '(?:stop|end|kill|cancel|disable|quit)\\b' + ASK_GAP + '\\bloop(?:s|ing)?\\b', 'i'),
    /\bloops?\s+off\b/i, /\bno\s+more\s+loop(?:s|ing)?\b/i];
  var ASK_PREFIX = 'aiondx.loopask.';
  var STOP_NOT_RES = [/\b(?:don'?t|do\s+not|never|not|no\s+need\s+to|can'?t|cannot|won'?t|doesn'?t|didn'?t|shouldn'?t|wouldn'?t|isn'?t|aren'?t)\s+(?:\w+\s+){0,2}stop/i,
    /\buntil\s+(?:i|you|we)\b[^.!?]*\bstop\b/i];

  // Paused members and failed turns; see the header.
  var WAIT_LIMIT_MS = 20 * 60000;   // first retry after an error that reads as a provider limit
  var WAIT_OTHER_MS = 2 * 60000;    // first retry after any other error
  var RETRY_GAPS_MS = [10, 15, 15, 30].map(function (m) { return m * 60000; }); // then 30 min each
  var RETRY_MAX = 10;               // tries per pause or failure streak before the loop gives up
  var TEAM_SEND_GAP_MS = 120000;    // at most one loop send per team every 2 minutes
  var LIMIT_RE = /rate.?limit|resource_exhausted|usage limit|quota|429|too many requests/i;
  // What Claude says in a plain assistant message when the account is out of usage ("You've hit your limit \u00b7 resets
  // 3pm"): no error record stands behind it, so the Loop used to read it as a reply and nudge again. A short message
  // only; a long one is the agent talking about limits.
  var LIMIT_TEXT_RE = /(?:you['\u2019]?ve|you have|you)\s+(?:hit|reached)\s+(?:your|the)\s+(?:[\w-]+\s+){0,2}limit|(?:usage|rate|5-hour|five-hour|weekly|session)\s+limit\s+reached|limit\s+reached\b.{0,40}\bresets?\b|out of (?:extra )?usage\b/i;
  var LIMIT_TEXT_MAX = 600;
  var LIMIT_MARGIN_MS = 30000;      // after a stated or recorded reset, wait this much longer
  var RESUME_NOTE_MEMBER = '[Loop] Resuming you after a pause. A provider limit or a failed turn stopped you, ' +
    'and the Loop waited before retrying. Your last turn may have been cut off: check your queue file and last notes first.';
  var RESUME_NOTE_LEAD = '[Loop] Resuming you after a pause. A provider limit or a failed turn stopped the team, ' +
    'and the Loop resumed the members it watches first. Check run-state before acting on any ' +
    '"Delivery retry limit reached" notice; those can be stale.';

  // Shared with agents; see the header.
  var BUILD = '2026-10-01.1';
  var SHARED_PREFIX = 'aiondx.loop.';
  var STATUS_PREFIX = 'aiondx.loopstatus.';
  var ENGINE_KEY = 'aiondx.engine';
  var ENGINE_BEAT_MS = 120000;       // how often this script says it is running (the tool calls it stale at 5 min)
  var STATUS_WORDING_MS = 120000;    // a change of wording alone is published at most this often; aioncore logs each write
  var MSG_PUSH_DELAY_MS = 800;       // an edited continue message is written once typing pauses
  var AGENT_MARK_MS = 10 * 60000;    // how long the button keeps its "changed by an agent" mark
  var ANNOUNCE_MS = 2 * 60000;       // older changes (read after a restart, say) mark the button without a notice
  var TOAST_MS = 9000;
  var COMPACT_CMDS = ['compact', 'compress'];   // Claude and Codex; Gemini CLI and Qwen

  // ---------------------------------------------------------------- state

  function disabled() { try { return localStorage.getItem(KEY_PREFIX + 'disabled') === '1'; } catch (e) { return false; } }

  function route() {
    var h = location.hash;
    var m = h.match(/^#\/conversation\/([^/?#]+)/);
    if (m) return { kind: 'conv', id: m[1] };
    m = h.match(/^#\/team\/([^/?#]+)/);
    if (m) return { kind: 'team', id: m[1] };
    return null;
  }

  function csrf() {
    if (window.__coreCsrfToken) return window.__coreCsrfToken;
    var m = document.cookie.match(/(?:^|;\s*)aionui-csrf-token=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  // Solo keys stay aionui.dx.<conversationId> so state saved by earlier builds carries over.
  function storageKey(t) {
    return t.kind === 'conv' ? KEY_PREFIX + t.convId : KEY_PREFIX + 'team.' + t.teamId + '.' + t.slotId;
  }
  function state(t) {
    var s;
    try { s = JSON.parse(localStorage.getItem(storageKey(t))); } catch (e) { s = null; }
    s = s || {};
    if (typeof s.msg !== 'string' || !s.msg.trim()) s.msg = DEFAULT_MSG;
    if (!Array.isArray(s.queue)) s.queue = [];
    s.on = !!s.on;
    return s;
  }
  function save(t, s) { try { localStorage.setItem(storageKey(t), JSON.stringify(s)); } catch (e) {} }
  /** A Loop switched on starts clean: no counts, no backoff, no rest. onAt lets the first nudge
   *  reach an agent that was already cold (someone asked for it). */
  function freshOn(s, at) {
    s.lastFired = 0; s.lastFiredText = ''; s.stalls = 0; s.fires = 0; s.offReason = '';
    s.nudgeLevel = 0; s.shortSince = 0; s.nextNudgeAt = 0; s.restingSince = 0; s.restKind = ''; s.onAt = at;
  }
  /** forever: on until the user stops it (K, 2026-09-26: "that loop needs an option for infinite/until i stop it or
   *  stop the agent (the stop button) or ask it to turn it off specifically"). No hold, no rest, no giving up. */
  function setOn(t, on, why, byUser, forever) {
    var s = state(t);
    var was = s.on;
    s.on = !!on;
    if (s.on) { freshOn(s, Date.now()); s.forever = !!forever; s.foreverAt = forever ? Date.now() : 0; }
    else {
      s.wakeAt = 0;   // off, by anyone, cancels a resume time
      s.forever = false;
      s.foreverAt = 0;
      if (why) s.offReason = why;
    }
    save(t, s);
    if (why) console.log('[dx] loop ' + (on ? 'on' : 'off') + ' (' + t.key + '): ' + why);
    // The menu, the console and your stop phrases are K; anything else is the Loop switching itself off.
    var mine = byUser || why === 'turned on' || why === 'turned off' || why === 'console';
    pushShared(t, mine ? 'user' : 'loop', why === 'turned on' || why === 'turned off' || why === 'console' ? '' : (why || ''));
    publishStatus(t);
    // The Loop switching itself off is told, with where it happened.
    if (was && !s.on && !mine) notify(t, 'Loop off for ' + '{who}' + ': ' + why + '.', '');
    render();
  }
  function holdMinutes(s) {
    var h = Number(s.holdMin);
    return isFinite(h) && h >= 0 ? Math.min(h, HOLD_MIN_MAX) : HOLD_MIN;
  }

  /** Every loop target on the current page, each with the .sendbox-actions row its
   *  pill belongs in. One on a solo chat; one per member column on a team page. */
  function targets() {
    var r = route();
    if (!r || disabled()) return [];
    if (r.kind === 'conv') {
      var a = document.querySelector('.sendbox-actions');
      return a ? [{ kind: 'conv', key: 'conv:' + r.id, convId: r.id, actions: a }] : [];
    }
    var out = [];
    var cols = document.querySelectorAll('[data-slot-id]');
    for (var i = 0; i < cols.length; i++) {
      var col = cols[i];
      var slot = col.getAttribute('data-slot-id');
      var acts = col.querySelector('.sendbox-actions');
      if (!slot || !acts || acts.closest('[data-slot-id]') !== col) continue;
      out.push({ kind: 'team', key: 'team:' + r.id + ':' + slot, teamId: r.id, slotId: slot,
        role: col.getAttribute('data-role') || '', actions: acts });
    }
    if (!out.length) {
      var single = singleViewTarget(r.id);
      if (single && single.actions) out.push(single);
    }
    return out;
  }

  // AionUi's single view of a team: one member at a time, tabs above, and one message box with no member column around
  // it. A team's "Loop buttons gone" (K, 2026-09-26) was this view: the Loop looked only for member
  // columns (aiondx.diag.loop: slots 0, one box). The box belongs to the tab in front, which AionUi keeps in
  // localStorage team-active-slot-<team id>, else the lead's; the tabs are [data-team-tab-role] with
  // data-testid team-tab-<slot id>.
  function singleViewTabs() {
    var out = {};
    var tabs = document.querySelectorAll('[data-team-tab-role]');
    for (var i = 0; i < tabs.length; i++) {
      var id = String(tabs[i].getAttribute('data-testid') || '');
      if (id.indexOf('team-tab-') === 0) out[id.slice('team-tab-'.length)] = tabs[i].getAttribute('data-team-tab-role') === 'leader' ? 'leader' : 'member';
    }
    return out;
  }
  function singleViewTarget(teamId) {
    var acts = null;
    var all = document.querySelectorAll('.sendbox-actions');
    for (var i = 0; i < all.length; i++) if (!all[i].closest('[data-slot-id]')) { acts = all[i]; break; }
    if (!acts) return null;
    var tabs = singleViewTabs();
    var slot = null;
    try { slot = localStorage.getItem('team-active-slot-' + teamId); } catch (e) {}
    if (!slot || !tabs[slot]) {
      slot = null;
      Object.keys(tabs).forEach(function (s) { if (!slot && tabs[s] === 'leader') slot = s; });
    }
    if (!slot) return null;
    return { kind: 'team', key: 'team:' + teamId + ':' + slot, teamId: teamId, slotId: slot, role: tabs[slot] || '', actions: acts };
  }

  /** Every target with saved state, on screen or not, so a loop keeps running while its page is
   *  closed: this window's own (localStorage) and every Loop in the shared store, which includes
   *  one an agent switched on in a chat K has never opened. */
  function storedTargets() {
    var out = localTargets();
    var seen = {};
    out.forEach(function (t) { seen[t.key] = true; });
    Object.keys(shared).forEach(function (k) {
      var t = targetOfKey(k);
      if (t && !seen[t.key]) { seen[t.key] = true; out.push(t); }
    });
    return out;
  }

  /** Targets saved in this window. Keys: aionui.dx.<conversationId> and aionui.dx.team.<teamId>.<slotId>. */
  function localTargets() {
    var out = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || k.indexOf(KEY_PREFIX) !== 0) continue;
        var rest = k.slice(KEY_PREFIX.length);
        var m = rest.match(/^team\.([^.]+)\.([^.]+)$/);
        if (m) { out.push({ kind: 'team', key: 'team:' + m[1] + ':' + m[2], teamId: m[1], slotId: m[2] }); continue; }
        if (!rest || rest === 'disabled' || rest.indexOf('.') >= 0 || !/^[0-9a-z-]{6,64}$/i.test(rest) || rest === 'theme') continue;
        out.push({ kind: 'conv', key: 'conv:' + rest, convId: rest });
      }
    } catch (e) {}
    return out;
  }

  /** The target a composer element belongs to, for the send-button interrupt. */
  function targetOf(node) {
    var r = route();
    if (!r || !node || !node.closest) return null;
    if (r.kind === 'conv') return { kind: 'conv', key: 'conv:' + r.id, convId: r.id };
    var col = node.closest('[data-slot-id]');
    if (!col) {
      // The single view's one message box (see singleViewTarget).
      var single = document.querySelectorAll('[data-slot-id]').length ? null : singleViewTarget(r.id);
      if (!single) return null;
      delete single.actions;
      return single;
    }
    var slot = col.getAttribute('data-slot-id');
    return { kind: 'team', key: 'team:' + r.id + ':' + slot, teamId: r.id, slotId: slot, role: col.getAttribute('data-role') || '' };
  }

  function msgText(m) {
    var c = m && m.content;
    if (typeof c === 'string') { try { c = JSON.parse(c); } catch (e) { return c; } }
    return (c && (c.content || c.text)) || '';
  }
  function unwrap(j) { return (j && j.data !== undefined) ? j.data : j; }

  /** An agent error as the app stores it in the chat: type "tips", content {type:"error", error}. */
  function errorTip(m) {
    if (!m || m.type !== 'tips') return null;
    var c = m.content;
    if (typeof c === 'string') { try { c = JSON.parse(c); } catch (e) { return null; } }
    if (!c || !(c.type === 'error' || c.error)) return null;
    var e = c.error || {};
    return { text: [c.content, c.details, c.detail, e.message, e.detail, e.code].filter(Boolean).join(' '), at: m.created_at || 0 };
  }
  /** The newest agent error, unless a real reply came after it. */
  function lastError(msgs) {
    for (var i = msgs.length - 1; i >= 0; i--) {
      var m = msgs[i];
      if (m.position !== 'left') continue;
      var tip = errorTip(m);
      if (tip) return tip;
      if (m.type === 'text' || m.type === undefined) {
        var said = msgText(m);
        if (said && said.length <= LIMIT_TEXT_MAX && LIMIT_TEXT_RE.test(said)) return { text: said, at: m.created_at || 0, limit: true };
        return null;
      }
    }
    return null;
  }
  /** The provider's own reset time, when the error states one: "Your limit will reset in 19
   *  minutes" (Devin's text, which a Devin proxy script passes through since 2026-09-23).
   *  Returned in ms, or 0 when the text gives none. */
  function statedResetMs(text, at) {
    text = text || '';
    var m = /reset in (\d+)\s*(second|minute|hour)s?/i.exec(text);
    if (m) {
      var unit = m[2].toLowerCase();
      return Number(m[1]) * (unit === 'second' ? 1000 : unit === 'minute' ? 60000 : 3600000);
    }
    // A clock time, as Claude words it: "resets 3pm", "resets at 3:30 pm (America/Denver)", "resets Oct 5, 9am".
    var c = /resets?\s+(?:at\s+)?(?:(?:on\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?(?![a-z])(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z_+\-0-9]+)+|UTC|GMT)\))?/i.exec(text) ||
            /resets?\s+(?:at\s+)?(?:(?:on\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2}):(\d{2})()(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z_+\-0-9]+)+|UTC|GMT)\))?/i.exec(text);
    if (!c) return 0;
    var h = Number(c[3]), mi = c[4] ? Number(c[4]) : 0, ap = (c[5] || '').toLowerCase();
    if (ap) { if (h < 1 || h > 12) return 0; if (ap === 'p' && h < 12) h += 12; else if (ap === 'a' && h === 12) h = 0; }
    if (h > 23 || mi > 59) return 0;
    var now = at || Date.now();
    var mon = c[1] ? MONTHS.indexOf(c[1].toLowerCase()) : -1;
    var target = clockAfter(h, mi, c[6] || '', now, mon, c[2] ? Number(c[2]) : 0);
    var ms = target - now;
    return ms > 0 && ms <= 8 * 86400000 ? ms : 0;
  }
  var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  /** The next time the wall clock in `tz` (an IANA name; the local zone when empty) reads h:mi after `at`, in epoch ms.
   *  With a month (0-based) and day it is that date instead. 0 when the zone is not known. */
  function clockAfter(h, mi, tz, at, mon, day) {
    if (!tz) {
      var b = new Date(at);
      var d = mon >= 0 ? new Date(b.getFullYear(), mon, day, h, mi, 0, 0) : new Date(b.getFullYear(), b.getMonth(), b.getDate(), h, mi, 0, 0);
      if (d.getTime() <= at) { if (mon >= 0) d.setFullYear(d.getFullYear() + 1); else d.setDate(d.getDate() + 1); }
      return d.getTime();
    }
    try {
      var f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric' });
      var o = {};
      f.formatToParts(new Date(at)).forEach(function (p) { o[p.type] = Number(p.value); });
      var offset = Date.UTC(o.year, o.month - 1, o.day, o.hour % 24, o.minute, o.second) - Math.floor(at / 1000) * 1000;
      var mo = mon >= 0 ? mon : o.month - 1, dd = mon >= 0 ? day : o.day;
      var t = Date.UTC(o.year, mo, dd, h, mi, 0, 0) - offset;
      if (t <= at) t = mon >= 0 ? Date.UTC(o.year + 1, mo, dd, h, mi, 0, 0) - offset : t + 86400000;
      return t;
    } catch (e) { return 0; }
  }
  /** How long to wait, after the error, before retry number n (0-based) of a pause or failure
   *  streak. A stated reset time wins, plus 30 s of margin: Devin's limits range from a burst
   *  limit that clears in under a minute to a budget that takes 20. */
  function retryWaitMs(n, err) {
    var stated = err ? statedResetMs(err.text, err.at) : 0;
    if (stated) return stated + LIMIT_MARGIN_MS;
    if (n === 0) return err && (err.limit || LIMIT_RE.test(err.text)) ? WAIT_LIMIT_MS : WAIT_OTHER_MS;
    return RETRY_GAPS_MS[n - 1] || 30 * 60000;
  }
  function teamSendKey(teamId) { return KEY_PREFIX + 'teamsend.' + teamId; }
  function lastTeamSend(teamId) { try { return Number(localStorage.getItem(teamSendKey(teamId))) || 0; } catch (e) { return 0; } }
  function markTeamSend(teamId, at) { try { localStorage.setItem(teamSendKey(teamId), String(at)); } catch (e) {} }

  // ---------------------------------------------------------------- backend

  /** The backend's address for an API path. AionUi's desktop window is loaded from the app bundle,
   *  not from the backend: the preload script puts the backend's port in window.__backendPort and
   *  the app's own requests go to http://127.0.0.1:<port> (httpBridge getBaseUrl, credentials
   *  "include"). In WebUI the backend's host serves the page, so a same-origin path is right there.
   *  Until build 2026-09-24.4 this script used same-origin paths everywhere, so in the desktop app
   *  not one Loop request ever reached the backend: no nudge, no resume, no store read, no agent
   *  dot. The test page stubs fetch, which is why its checks passed. Found 2026-09-24 when the
   *  team lead switched Loops on and K saw nothing change; aioncore's request log showed no
   *  Loop traffic at all. */
  function apiUrl(path) {
    var port = window.__backendPort;
    return (port ? 'http://127.0.0.1:' + port : '') + path;
  }

  async function getJson(url) {
    var r = await fetch(apiUrl(url), { credentials: 'include' });
    if (!r.ok) return { err: r.status };
    return { data: unwrap(await r.json()) };
  }
  async function postJson(url, body) {
    return fetch(apiUrl(url), {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf() },
      body: JSON.stringify(body)
    });
  }
  async function getMessages(convId, limit) {
    var g = await getJson('/api/conversations/' + convId + '/messages?limit=' + (limit || 40));
    if (g.err || !g.data) return null;
    var j = g.data;
    var list = Array.isArray(j) ? j : (j.messages || j.items || []);
    return list.slice().sort(function (a, b) { return (a.created_at || 0) - (b.created_at || 0); });
  }
  function isFinished(status) { return status === 'finished' || status === 'idle'; }
  var convMidturn = {};      // conversation id -> it reads messages mid-turn (claude, codex)
  var convTurn = {};         // conversation id -> the turn its runtime last reported running
  /** A solo chat's own state. GET /api/conversations/{id} can say status "finished" while its runtime
   *  is mid-turn (seen live, 2026-09-25: status finished, runtime.state running, is_processing true),
   *  so the runtime wins when it reports. */
  function convBusy(d) {
    if (!d) return true;
    var rt = d.runtime;
    if (rt && typeof rt.is_processing === 'boolean') return rt.is_processing || rt.state === 'running';
    return !isFinished(d.status || (d.state && d.state.status));
  }


  // teamId -> { at, ok, name, map: slotId -> conversationId, backend: slotId -> backend, names: slotId -> name,
  //            assistants: slotId -> assistant id }
  var teamCache = {};
  function readTeam(teamId, data) {
    var c = { at: Date.now(), ok: false, name: '', map: {}, backend: {}, names: {}, assistants: {} };
    var members = data && (data.assistants || data.agents);
    if (Array.isArray(members)) {
      c.ok = true;
      c.name = String(data.name || '');
      for (var i = 0; i < members.length; i++) {
        var m = members[i];
        if (!m || !m.slot_id) continue;
        c.map[m.slot_id] = m.conversation_id || null;
        c.backend[m.slot_id] = String(m.backend || m.assistant_backend || '');
        c.names[m.slot_id] = String(m.name || m.assistant_name || '');
        c.assistants[m.slot_id] = String(m.assistant_id || '');
      }
    }
    teamCache[teamId] = c;
    return c;
  }
  var teamReads = {};        // team id -> the read in flight
  var teamFailed = {};       // team id -> when its last read failed
  async function memberConversation(t) {
    var c = teamCache[t.teamId];
    if (!c || Date.now() - c.at > TEAM_CACHE_MS || !c.map[t.slotId]) {
      if (teamFailed[t.teamId] && Date.now() - teamFailed[t.teamId] < 30000) return { err: 'retry later' };
      if (!teamReads[t.teamId]) {
        teamReads[t.teamId] = getJson('/api/teams/' + t.teamId).then(function (g) {
          if (g.err || !g.data) { teamFailed[t.teamId] = Date.now(); return null; }
          delete teamFailed[t.teamId];
          return readTeam(t.teamId, g.data);
        }, function () { teamFailed[t.teamId] = Date.now(); return null; }).then(function (r) { delete teamReads[t.teamId]; return r; });
      }
      var read = await teamReads[t.teamId];
      if (!read) return { err: 'read failed' };
      c = read;
    }
    // A member the lead shut down is removed from the team once it approves (aionui-team
    // mcp/server.rs, "agent fully removed after shutdown_approved"). Its Loop has nothing to keep.
    if (c.ok && !(t.slotId in c.map)) return { convId: null, gone: true };
    return { convId: c.map[t.slotId] || null, backend: c.backend[t.slotId] || '', name: c.names[t.slotId] || '' };
  }

  function hhmm(ms) {
    var d = new Date(ms);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  /** The next time a clock time ("12:10") comes round: today, or tomorrow once it has passed. 0 otherwise. */
  function nextClock(v) {
    var m = /^(\d{1,2}):(\d{2})/.exec(String(v || '').trim());
    if (!m || +m[1] > 23 || +m[2] > 59) return 0;
    var d = new Date();
    d.setHours(+m[1], +m[2], 0, 0);
    if (d.getTime() <= Date.now() + 30000) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  // ---------------------------------------------------------------- shared with agents (P-010)

  // The store is aioncore's per-user key-value table (aionui-system client_pref.rs): a flat map,
  // per-key upsert, null deletes, and no side effects on any conversation. See the header.
  var shared = {};          // aiondx.loop.* key -> record, as last read from the store
  var sharedReady = false;  // the store has answered at least once
  var sharedGone = false;   // no store here (an older backend, or the test page's stub): localStorage only
  var published = {};       // aiondx.loopstatus.* key -> { core, why, at } last written
  var lastBeat = 0;
  var msgTimers = {};       // shared key -> pending write of an edited continue message

  function sharedKey(t) { return SHARED_PREFIX + (t.kind === 'conv' ? 'conv.' + t.convId : 'team.' + t.teamId + '.' + t.slotId); }
  function statusKey(t) { return STATUS_PREFIX + sharedKey(t).slice(SHARED_PREFIX.length); }
  function targetOfKey(k) {
    var m = /^aiondx\.loop\.conv\.([^.]+)$/.exec(k);
    if (m) return { kind: 'conv', key: 'conv:' + m[1], convId: m[1] };
    m = /^aiondx\.loop\.team\.([^.]+)\.([^.]+)$/.exec(k);
    return m ? { kind: 'team', key: 'team:' + m[1] + ':' + m[2], teamId: m[1], slotId: m[2] } : null;
  }

  function putPrefs(map) {
    if (sharedGone) return Promise.resolve(null);
    return fetch(apiUrl('/api/settings/client'), {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf() },
      body: JSON.stringify(map)
    }).catch(function () { return null; });
  }

  /** Read every Loop record, take what changed, and announce what an agent did. */
  async function pullShared() {
    if (sharedGone) return;
    var g;
    try { g = await getJson('/api/settings/client'); } catch (e) { return; }
    if (g.err === 404) { sharedGone = true; return; }
    if (g.err || !g.data || typeof g.data !== 'object') return;
    var next = {};
    Object.keys(g.data).forEach(function (k) { if (k.indexOf(SHARED_PREFIX) === 0) next[k] = g.data[k]; });
    shared = next;
    showSignin(g.data['aiondx.agy.signin']);
    takeThemePrefs(g.data['aiondx.theme']);
    takeAccounts(g.data);
    takeUsage(g.data);
    takeMcpLog(g.data);
    takeUnsend(g.data);
    takeDrafts(g.data);
    takeSched(g.data);
    provision(g.data).catch(function () {});
    takeWelcome(g.data);
    if (!sharedReady) { sharedReady = true; migrate(); }
    Object.keys(shared).forEach(function (k) { var t = targetOfKey(k); if (t) applyShared(t, shared[k]); });
    announce();
  }

  /** A newer record from the store (an agent's Loop tool, or this app in another window) wins over
   *  what this window holds. Newer by the record's timestamp: both sides stamp with this machine's
   *  clock, and a revision counter cannot tell a write that failed here from one that landed. */
  function applyShared(t, rec) {
    if (!rec || typeof rec !== 'object') return;
    var at = Number(rec.at) || 0;
    var s = state(t);
    if (!at || at <= (s.sharedAt || 0)) return;
    // A Loop set to run until the user stops it: an agent cannot switch it off or take that away (the Loop tool
    // refuses; this covers an older copy of the tool) unless the user asked for it in their own words, which the
    // tool marks with askedAt. Otherwise the user's record goes back into the store.
    if (s.on && s.forever && rec.by === 'agent' && (rec.on === false || rec.forever === false) && !(Number(rec.askedAt) > 0)) {
      s.sharedAt = at;
      save(t, s);
      console.log('[dx] loop (' + t.key + '): ' + (rec.who || 'an agent') + ' tried to switch off a Loop that runs until you stop it; kept on');
      pushShared(t, 'user', 'kept on: it runs until the user stops it');
      return;
    }
    var was = { on: s.on, msg: s.msg, compactAt: s.compactAt || 0, holdMin: holdMinutes(s), wakeAt: s.wakeAt || 0, forever: !!s.forever };
    s.sharedAt = at;
    if (typeof rec.msg === 'string' && rec.msg.trim()) s.msg = rec.msg;
    if (rec.holdMin !== undefined && rec.holdMin !== null && isFinite(Number(rec.holdMin))) s.holdMin = Number(rec.holdMin);
    if (typeof rec.on === 'boolean' && rec.on !== s.on) {
      s.on = rec.on;
      if (s.on) freshOn(s, at);
      else if (rec.by === 'agent') s.offReason = 'by ' + (rec.who || 'an agent') + (rec.note ? ' (' + rec.note + ')' : '');
      else s.offReason = rec.note || 'turned off';
    }
    if (typeof rec.forever === 'boolean') {
      // Newly until-stopped: whatever rest it was in is over.
      if (s.on && rec.forever && !s.forever) { s.foreverAt = Number(rec.foreverAt) || at; s.restingSince = 0; s.restKind = ''; }
      s.forever = s.on && rec.forever;
    }
    if (!s.on || !s.forever) { s.forever = false; s.foreverAt = 0; }
    if (rec.wakeAt !== undefined) {
      var w = s.on ? Number(rec.wakeAt) || 0 : 0;
      // A new resume time: whatever rest the Loop was in is over; the next check decides afresh.
      if (w !== (s.wakeAt || 0) && w) { s.restingSince = 0; s.restKind = ''; }
      s.wakeAt = w;
      s.wakeMsg = typeof rec.wakeMsg === 'string' ? rec.wakeMsg : '';
      s.wakeBy = typeof rec.wakeBy === 'string' ? rec.wakeBy : '';
      s.wakeSelf = rec.wakeSelf === true;
    }
    var ca = Number(rec.compactAt) || 0;
    if (ca > (s.compactAt || 0)) s.compactAt = ca;
    if (rec.by === 'agent') {
      s.agentMark = {
        at: at, who: String(rec.who || 'An agent').slice(0, 80), target: String(rec['for'] || ''),
        note: String(rec.note || '').slice(0, 300),
        on: s.on !== was.on ? s.on : null, msg: s.msg !== was.msg, compact: (s.compactAt || 0) > was.compactAt,
        hold: holdMinutes(s) !== was.holdMin ? holdMinutes(s) : null,
        wake: (s.wakeAt || 0) !== was.wakeAt ? (s.wakeAt || 0) : null,
        forever: !!s.forever !== was.forever ? !!s.forever : null,
        shown: false
      };
    }
    save(t, s);
  }

  /** Write this Loop's settings to the store, so the agent's tool sees what K set. */
  function pushShared(t, by, note) {
    if (sharedGone) return;
    var s = state(t);
    var k = sharedKey(t);
    var cur = shared[k] || {};
    var at = Math.max(Date.now(), (Number(cur.at) || 0) + 1, (s.sharedAt || 0) + 1);
    var rec = { v: 1, on: !!s.on, forever: !!(s.on && s.forever), foreverAt: s.on && s.forever ? s.foreverAt || 0 : 0, msg: s.msg, compactAt: s.compactAt || 0, holdMin: holdMinutes(s), rev: (Number(cur.rev) || 0) + 1,
      wakeAt: s.on ? s.wakeAt || 0 : 0, wakeMsg: s.wakeMsg || '', wakeBy: s.wakeBy || '', wakeSelf: !!s.wakeSelf,
      by: by, who: by === 'user' ? 'the user' : 'the Loop', 'for': '', at: at, note: note || '' };
    s.sharedAt = at;
    save(t, s);
    shared[k] = rec;
    var body = {};
    body[k] = rec;
    putPrefs(body);
  }

  /** What this Loop last decided, for the tool's loop_status. Written when it changes; a change of
   *  wording alone at most every 2 minutes, because aioncore logs every write. */
  function publishStatus(t) {
    if (sharedGone || !sharedReady) return;
    var s = state(t);
    var core = { on: !!s.on, forever: !!(s.on && s.forever), fires: s.fires || 0, lastFired: s.lastFired || 0, offReason: s.offReason || '',
      nextNudgeAt: s.nextNudgeAt || 0, nextRetryAt: s.nextRetryAt || 0,
      compactAt: s.compactAt || 0, compactSentAt: s.compactSentAt || 0, compactNote: s.compactNote || '',
      // The cache window (build 2026-09-25.4): the agent's last message, when the cache runs out,
      // and whether the Loop is resting.
      lastAt: s.lastAt || 0, warmUntil: s.lastAt ? s.lastAt + CACHE_TTL_MS : 0, holdMin: holdMinutes(s),
      shortSince: s.shortSince || 0, restingSince: s.restingSince || 0, restKind: s.restKind || '',
      wakeAt: s.on ? s.wakeAt || 0 : 0, wokeAt: s.wokeAt || 0 };
    var k = statusKey(t);
    var coreJson = JSON.stringify(core);
    var last = published[k];
    var now = Date.now();
    if (last && last.core === coreJson && (last.why === (s.why || '') || now - last.at < STATUS_WORDING_MS)) return;
    published[k] = { core: coreJson, why: s.why || '', at: now };
    core.why = s.why || '';
    core.whyAt = s.whyAt || 0;
    core.at = now;
    var body = {};
    body[k] = core;
    putPrefs(body);
  }

  /** "This script is running the Loop", for the tool, which calls it stale after 5 minutes. */
  function beat() {
    if (sharedGone || !sharedReady || Date.now() - lastBeat < ENGINE_BEAT_MS) return;
    lastBeat = Date.now();
    var body = {};
    body[ENGINE_KEY] = { at: lastBeat, build: BUILD };
    putPrefs(body);
  }

  /** First contact with the store: Loops saved before agents could see them are written to it,
   *  unless it already holds a record for them. */
  function migrate() {
    localTargets().forEach(function (t) {
      if (shared[sharedKey(t)]) return;
      var s = state(t);
      if (!s.on && s.msg === DEFAULT_MSG) return;
      pushShared(t, 'user', '');
    });
  }

  /** "Worker switched the Loop off." / "Lead switched the Loop on for Worker." */
  function changeSentence(m) {
    var did = [];
    if (m.on === true) did.push('switched the Loop on');
    if (m.on === false) did.push('switched the Loop off');
    if (m.msg) did.push('changed the continue message');
    if (m.compact) did.push('asked for a compaction');
    if (m.hold !== null && m.hold !== undefined) {
      did.push(m.hold ? 'set it to keep the cache warm for up to ' + m.hold + ' min of short replies' : 'set it to rest after the first short reply');
    }
    if (m.wake !== null && m.wake !== undefined) did.push(m.wake ? 'set it to resume at ' + hhmm(m.wake) : 'cleared its resume time');
    if (m.forever === true) did.push('set it to run until you stop it');
    if (m.forever === false && m.on !== false) did.push('ended "until you stop it"');
    if (!did.length) did.push('updated the Loop');
    return m.who + ' ' + did.join(' and ') + (m.target && m.target !== m.who ? ' for ' + m.target : '') + '.';
  }

  /** An agent's change, told once: a notice at the top of the window. */
  function announce() {
    storedTargets().forEach(function (t) {
      var s = state(t);
      var m = s.agentMark;
      if (!m || m.shown) return;
      m.shown = true;
      save(t, s);
      if (Date.now() - m.at < ANNOUNCE_MS) notify(t, changeSentence(m), m.note);
      render();
    });
  }

  function agentMarked(s) { return !!(s.agentMark && Date.now() - s.agentMark.at < AGENT_MARK_MS); }
  /** "Last changed by Worker at 13:21: done for now." for the menu and the hover card, a day long. */
  function agentChangeLine(s) {
    var m = s.agentMark;
    if (!m || Date.now() - m.at > 24 * 3600000) return '';
    return 'Last changed by ' + m.who + ' at ' + hhmm(m.at) + (m.note ? ': ' + m.note.replace(/[.\s]+$/, '') : '') + '.';
  }

  // Notices at the top of the window. K, 2026-09-25: "the notifications to the user that pop up at
  // the top of the ui should tell the user which chat/team that occurred in. clicking the popup
  // should take you to the conversation". Each notice about a Loop names its team and member, or
  // its chat, on its first line, and a click opens that page (and brings the member's column into
  // view). AionUi's own notices are replies to what you just did on the page you are on; the one
  // background notice it has (cross-conversation messages looping) already names both chats.
  var toastBox = null;
  function toast(text, sub, place) {
    if (!toastBox || !document.body.contains(toastBox)) {
      toastBox = document.createElement('div');
      toastBox.className = 'aiondx-toasts';
      document.body.appendChild(toastBox);
    }
    var el = document.createElement('div');
    el.className = 'arco-message arco-message-info aiondx-toast';
    el.setAttribute('role', 'status');
    el.innerHTML = '<span class="aiondx-toast-icon" aria-hidden="true">' + ICON_LOOP + '</span>' +
      '<span class="aiondx-toast-body"><span class="aiondx-toast-where"></span><span class="aiondx-toast-text"></span>' +
      '<span class="aiondx-toast-sub"></span></span>';
    el.querySelector('.aiondx-toast-text').textContent = text;
    var subEl = el.querySelector('.aiondx-toast-sub');
    if (sub) subEl.textContent = sub; else subEl.parentNode.removeChild(subEl);
    var whereEl = el.querySelector('.aiondx-toast-where');
    if (place && place.where) whereEl.textContent = place.where; else whereEl.parentNode.removeChild(whereEl);
    var remove = function () { if (el.parentNode) el.parentNode.removeChild(el); };
    if (place && place.href) {
      el.classList.add('aiondx-toast--link');
      el.setAttribute('role', 'link');
      el.tabIndex = 0;
      el.setAttribute('data-href', place.href);
      el.setAttribute('aria-label', (place.where ? place.where + ': ' : '') + text + ' Open it.');
      var go = function (ev) {
        if (ev) { ev.preventDefault(); ev.stopPropagation(); }
        remove();
        openPlace(place);
      };
      el.addEventListener('click', go);
      el.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') go(ev); });
    }
    toastBox.appendChild(el);
    setTimeout(remove, TOAST_MS);
    return el;
  }

  var places = {};   // 'team:<id>' or 'conv:<id>' -> { at, name, names: slotId -> member name }
  async function placeOf(t) {
    var key = t.kind === 'team' ? 'team:' + t.teamId : 'conv:' + t.convId;
    var p = places[key];
    if (p && Date.now() - p.at < 10 * 60000) return p;
    p = { at: Date.now(), name: '', names: {} };
    if (t.kind === 'team') {
      var c = teamCache[t.teamId];
      if (!c || !c.ok || Date.now() - c.at > TEAM_CACHE_MS) {
        var g = await getJson('/api/teams/' + t.teamId);
        if (!g.err) c = readTeam(t.teamId, g.data);
      }
      if (c && c.ok) { p.name = c.name; p.names = c.names; }
    } else {
      var cv = await getJson('/api/conversations/' + t.convId);
      if (!cv.err && cv.data) p.name = String(cv.data.name || '');
    }
    places[key] = p;
    return p;
  }
  /** A notice about target t: "{who}" in the text becomes the member's name, or "this chat". */
  function notify(t, text, sub) {
    var show = function (p) {
      var member = t.kind === 'team' ? ((p && p.names[t.slotId]) || 'this member') : 'this chat';
      var where = t.kind === 'team'
        ? ((p && p.name) || 'A team') + ' · ' + ((p && p.names[t.slotId]) || 'a member')
        : 'Chat: ' + ((p && p.name) || 'untitled');
      toast(text.replace(/\{who\}/g, member), sub, {
        where: where,
        href: t.kind === 'team' ? '#/team/' + t.teamId : '#/conversation/' + t.convId,
        slot: t.kind === 'team' ? t.slotId : null
      });
    };
    placeOf(t).then(show, function () { show(null); });
  }
  /** Open a notice's page; for a team member, bring its column into view once the page is up. */
  function openPlace(place) {
    if (location.hash !== place.href) location.hash = place.href;
    if (!place.slot) return;
    var tries = 0;
    var timer = setInterval(function () {
      var col = document.querySelector('[data-slot-id="' + String(place.slot).replace(/"/g, '') + '"]');
      if (col || ++tries > 30) {
        clearInterval(timer);
        if (col && col.scrollIntoView) col.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
      }
    }, 100);
  }

  // ---------------------------------------------------------------- Antigravity sign-in (patch 0008)

  // K, 2026-09-24: "our users aren't going to know how to or want to open a terminal ... in the ui".
  // AionDX's agy wrapper (patches\0008-agy-signin) signs Antigravity in from a chat turn: it opens
  // Google's sign-in in the browser and writes aiondx.agy.signin = {state, message, at} to the
  // store. While that says "waiting", this panel says so, and takes the code the sign-in page shows
  // when it cannot hand the sign-in back by itself; the code goes to aiondx.agy.signin.code, where
  // the wrapper picks it up and enters it.
  var SIGNIN_WAIT_MS = 16 * 60000;
  var signinBox = null;
  var signinShownAt = 0;
  // The panel's close button hides the sign-in it shows (a Stop in the chat kills the wrapper before it can
  // write "failed", which would otherwise leave the panel up for 16 minutes); a newer record shows it again,
  // and its end still raises the notice.
  var signinAt = 0, signinHiddenAt = 0;
  function showSignin(rec) {
    var now = Date.now();
    var at = rec ? Number(rec.at) || 0 : 0;
    var waiting = rec && rec.state === 'waiting' && now - at < SIGNIN_WAIT_MS;
    if (waiting && at === signinHiddenAt) return;
    if (waiting) {
      if (!signinBox || !document.body.contains(signinBox)) buildSignin();
      var msg = signinBox.querySelector('.aiondx-signin-msg');
      var text = String(rec.message || 'Finish signing in with Google in your browser.');
      if (msg.textContent !== text) msg.textContent = text;
      signinShownAt = signinShownAt || now;
      signinAt = at;
      return;
    }
    if ((signinBox && signinBox.parentNode) || signinHiddenAt) {
      if (signinBox && signinBox.parentNode) signinBox.parentNode.removeChild(signinBox);
      signinBox = null;
      signinHiddenAt = 0;
      if (rec && rec.state === 'done') signinToast(rec, 'Antigravity is signed in.', 'Your message is being answered.');
      else if (rec && rec.state === 'failed') signinToast(rec, 'Antigravity sign-in did not finish.', String(rec.message || ''));
    }
    signinShownAt = 0;
  }
  /** The wrapper records the chat the sign-in started from (AIONUI_CONVERSATION_ID). */
  function signinToast(rec, text, sub) {
    var conv = rec && typeof rec.conversation === 'string' && /^[\w-]{4,64}$/.test(rec.conversation) ? rec.conversation : '';
    if (conv) notify({ kind: 'conv', key: 'conv:' + conv, convId: conv }, text, sub);
    else toast(text, sub);
  }
  function buildSignin() {
    signinBox = document.createElement('div');
    signinBox.className = 'aiondx-signin arco-message arco-message-info';
    signinBox.setAttribute('role', 'dialog');
    signinBox.setAttribute('aria-label', 'Sign in to Antigravity');
    signinBox.innerHTML =
      '<span class="aiondx-toast-icon" aria-hidden="true">' + ICON_LOOP + '</span>' +
      '<div class="aiondx-signin-body">' +
        '<div class="aiondx-signin-title">Sign in to Antigravity</div>' +
        '<div class="aiondx-signin-msg"></div>' +
        '<div class="aiondx-signin-hint">If the sign-in page shows a code instead of finishing, paste it here.</div>' +
        '<div class="aiondx-signin-row"><input class="arco-input aiondx-signin-code" type="text" spellcheck="false" autocomplete="off" placeholder="Authorization code">' +
        '<button type="button" class="arco-btn arco-btn-primary arco-btn-size-small aiondx-signin-send">Submit</button></div>' +
        '<div class="aiondx-signin-note"></div>' +
      '</div>' +
      '<button type="button" class="aiondx-signin-close" aria-label="Hide the sign-in panel" title="Hide this panel. It comes back if Antigravity asks again.">×</button>';
    signinBox.querySelector('.aiondx-signin-close').addEventListener('click', function (ev) {
      ev.preventDefault();
      signinHiddenAt = signinAt;
      if (signinBox && signinBox.parentNode) signinBox.parentNode.removeChild(signinBox);
      signinBox = null;
    });
    var input = signinBox.querySelector('.aiondx-signin-code');
    var note = signinBox.querySelector('.aiondx-signin-note');
    function submit() {
      var code = input.value.trim();
      if (code.length < 10 || /\s/.test(code)) { note.textContent = 'That does not look like a sign-in code.'; return; }
      putPrefs({ 'aiondx.agy.signin.code': { code: code, at: Date.now() } });
      input.value = '';
      note.textContent = 'Sent. Finishing the sign-in...';
    }
    signinBox.querySelector('.aiondx-signin-send').addEventListener('click', function (ev) { ev.preventDefault(); submit(); });
    input.addEventListener('keydown', function (ev) { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); submit(); } });
    document.body.appendChild(signinBox);
  }

  // ---------------------------------------------------------------- AionDX accent (patch 0009)

  // K, 2026-09-25: "make the dividing lines accent colors (and configurable in settings)". The
  // AionDX Dark and Light themes (patches\0009-identity\themes.js, in AionUi's own Settings >
  // Appearance gallery) read --aiondx-accent. This adds an "AionDX accent" row under that gallery:
  // swatches, a custom colour, and "accent dividing lines". The choice is kept in the settings
  // store (aiondx.theme) and in localStorage, so it applies before the store answers at startup.
  // The overrides use html:root, one step more specific than the theme's :root, so they win
  // whichever stylesheet AionUi appends last.
  var ACCENTS = [['Teal', '#2dd4bf'], ['Cyan', '#22d3ee'], ['Blue', '#60a5fa'], ['Violet', '#a78bfa'],
    ['Rose', '#fb7185'], ['Amber', '#f59e0b'], ['Lime', '#a3e635']];
  var DEFAULT_ACCENT = '#2dd4bf';
  var THEME_LS = KEY_PREFIX + 'theme';
  var themePrefs = null;    // { accent, dividers, at }
  var pickerEl = null;
  var pickerTimer = null;
  function loadThemePrefs() { try { return JSON.parse(localStorage.getItem(THEME_LS)) || null; } catch (e) { return null; } }
  function hexRgb(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return null;
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  // Background colours (K, 2026-09-26: "I want to give the user the ability to change the background
  // color for both light and dark modes"). The colour you pick is the app's backdrop (--bg-base); the
  // other surfaces step away from it the way AionDX Dark and Light step from theirs: toward white in dark
  // mode, toward black in light mode, by the percentages below. They override whichever theme is active
  // in that mode, stock or AionDX, through the tokens every AionUi theme shares plus Arco's own.
  var BG_DEFAULTS = { dark: '#090909', light: '#eef1f5' };
  var BG_STEPS = {
    dark: {
      tokens: [['--bg-base', 0], ['--bg-1', 3], ['--bg-2', 6], ['--bg-hover', 7], ['--bg-active', 10], ['--bg-4', 10], ['--bg-5', 13],
        ['--fill', 3], ['--dialog-fill-0', 6], ['--workspace-btn-bg', 6], ['--message-tips-bg', 5]],
      arco: [['--color-bg-1', 3], ['--color-bg-2', 6], ['--color-bg-3', 8], ['--color-bg-4', 10], ['--color-bg-5', 12],
        ['--color-bg-white', 6], ['--color-bg-popup', 6], ['--color-fill-1', 5], ['--color-fill-2', 8], ['--color-fill-3', 11]],
      toward: '#ffffff', divider: 3
    },
    light: {
      tokens: [['--bg-base', 0], ['--bg-1', 3], ['--bg-2', 6], ['--bg-hover', 5], ['--bg-active', 9],
        ['--fill', 3], ['--dialog-fill-0', 0], ['--workspace-btn-bg', 3], ['--message-tips-bg', 5]],
      arco: [['--color-bg-1', 0], ['--color-bg-2', 3], ['--color-bg-3', 6], ['--color-bg-4', 8], ['--color-bg-5', 10],
        ['--color-bg-white', 0], ['--color-bg-popup', 0], ['--color-fill-1', 3], ['--color-fill-2', 6], ['--color-fill-3', 9]],
      toward: '#000000', divider: 6
    }
  };
  function bgMix(hex, toward, pct) { return pct ? 'color-mix(in srgb, ' + hex + ' ' + (100 - pct) + '%, ' + toward + ')' : hex; }
  function bgCss(mode, hex) {
    var st = BG_STEPS[mode];
    var decl = function (list) { return list.map(function (v) { return v[0] + ':' + bgMix(hex, st.toward, v[1]) + ' !important'; }).join(';'); };
    var base1 = bgMix(hex, st.toward, 3);
    return "html:root[data-theme='" + mode + "']{" + decl(st.tokens) + ';--aiondx-bg-1:' + base1 + ' !important' +
      ";--thought-gradient:linear-gradient(180deg, " + bgMix(hex, st.toward, 4) + ' 0%, ' + base1 + ' 100%) !important}' +
      "html body[arco-theme='" + mode + "']{" + decl(st.arco) + '}';
  }
  function applyThemePrefs(p) {
    var el = document.getElementById('aiondx-accent-vars');
    var css = '';
    var rgb = p && hexRgb(p.accent);
    if (rgb) {
      var strong = rgb.map(function (c) { return Math.round(c * 0.7); });
      css += 'html:root{--aiondx-accent:' + p.accent.toLowerCase() + ' !important;--aiondx-accent-rgb:' + rgb.join(', ') +
        ' !important;--aiondx-accent-strong-rgb:' + strong.join(', ') + ' !important}';
    }
    ['dark', 'light'].forEach(function (mode) {
      var hex = p && p[mode === 'dark' ? 'bgDark' : 'bgLight'];
      if (!hexRgb(hex)) return;
      css += bgCss(mode, hex.toLowerCase());
      // AionDX's accent dividers mix into the page colour; with a new backdrop they mix into it.
      if (!(p && p.dividers === false)) {
        css += "html:root[data-theme='" + mode + "']{--aiondx-divider:color-mix(in srgb, var(--aiondx-accent) 50%, var(--aiondx-bg-1)) !important;" +
          '--aiondx-divider-soft:color-mix(in srgb, var(--aiondx-accent) 26%, var(--aiondx-bg-1)) !important}';
      }
    });
    if (p && p.dividers === false) {
      css += "html:root[data-theme='dark']{--aiondx-divider:#252525 !important;--aiondx-divider-soft:#1d1d1d !important}" +
        "html:root[data-theme='light']{--aiondx-divider:#d3d9e2 !important;--aiondx-divider-soft:#dfe4eb !important}";
    }
    css += bubbleCss(p);
    if (!css) { if (el) el.parentNode.removeChild(el); return; }
    if (!el) { el = document.createElement('style'); el.id = 'aiondx-accent-vars'; }
    if (el.textContent !== css) el.textContent = css;
    if (el.parentNode !== document.head) document.head.appendChild(el);
  }
  /** Change some of the colour choices, keeping the rest. */
  function changeThemePrefs(changes) { setThemePrefs(Object.assign({ dividers: true }, themePrefs || {}, changes)); }
  function setThemePrefs(p) {
    p.at = Date.now();
    themePrefs = p;
    try { localStorage.setItem(THEME_LS, JSON.stringify(p)); } catch (e) {}
    applyThemePrefs(p);
    paintContextRings();
    putPrefs({ 'aiondx.theme': p });
    refreshAccentPicker();
  }
  /** A newer choice from the store (another window, or WebUI) wins. */
  function takeThemePrefs(p) {
    if (!p || typeof p !== 'object' || !(hexRgb(p.accent) || hexRgb(p.bgDark) || hexRgb(p.bgLight) ||
        (p.bubbles && typeof p.bubbles === 'object') || (p.ctx && typeof p.ctx === 'object'))) return;
    if (themePrefs && (Number(p.at) || 0) <= (Number(themePrefs.at) || 0)) return;
    themePrefs = p;
    try { localStorage.setItem(THEME_LS, JSON.stringify(p)); } catch (e) {}
    applyThemePrefs(p);
    paintContextRings();
    refreshAccentPicker();
  }
  function currentAccent() { return ((themePrefs && themePrefs.accent) || DEFAULT_ACCENT).toLowerCase(); }

  /** Under the theme gallery on Settings > Appearance, whose cards are data-testid="theme-card-<id>". */
  function ensureAccentPicker() {
    var card = document.querySelector('[data-testid^="theme-card-"]');
    if (!card || !card.parentElement || !card.parentElement.parentNode) {
      if (pickerEl && pickerEl.parentNode) pickerEl.parentNode.removeChild(pickerEl);
      return;
    }
    var gallery = card.parentElement;
    if (!pickerEl) pickerEl = buildAccentPicker();
    if (pickerEl.parentNode !== gallery.parentNode || pickerEl.previousElementSibling !== gallery) {
      gallery.parentNode.insertBefore(pickerEl, gallery.nextSibling);
    }
    refreshAccentPicker();
  }
  function buildAccentPicker() {
    var el = document.createElement('div');
    el.className = 'aiondx-accent';
    el.setAttribute('data-testid', 'aiondx-accent');
    el.innerHTML =
      '<div class="aiondx-accent-title">AionDX colours</div>' +
      '<div class="aiondx-accent-desc">Accent: dividing lines and highlights in the AionDX Dark and AionDX Light themes.</div>' +
      '<div class="aiondx-accent-row" role="radiogroup" aria-label="AionDX accent colour"></div>' +
      '<label class="aiondx-accent-toggle"><input type="checkbox" class="aiondx-accent-dividers"> Accent dividing lines</label>' +
      '<div class="aiondx-accent-desc aiondx-bg-desc">Background: the app\'s backdrop in dark and light mode, whichever theme is on.</div>' +
      '<div class="aiondx-accent-row aiondx-bg-row">' +
        '<label class="aiondx-swatch-custom aiondx-bg-pick" data-mode="dark"><input type="color" class="aiondx-bg-input" aria-label="Dark mode background"><span>Dark</span></label>' +
        '<button type="button" class="aiondx-bg-reset" data-mode="dark">Reset</button>' +
        '<label class="aiondx-swatch-custom aiondx-bg-pick" data-mode="light"><input type="color" class="aiondx-bg-input" aria-label="Light mode background"><span>Light</span></label>' +
        '<button type="button" class="aiondx-bg-reset" data-mode="light">Reset</button>' +
      '</div>' +
      '<div class="aiondx-accent-title aiondx-setup-title">AionDX setup</div>' +
      '<div class="aiondx-accent-desc">Bring your agents, instructions and tools over from the other AI apps on this PC, with Antigravity or an agent of your choice.</div>' +
      '<button type="button" class="arco-btn arco-btn-secondary arco-btn-size-small aiondx-setup-open" data-testid="aiondx-setup-open">Open AionDX setup</button>' +
      '<div class="aiondx-accent-title aiondx-ctx-title">Context ring</div>' +
      '<div class="aiondx-accent-desc">The ring beside the message box fills as the context window does, and changes colour as it goes. ' +
        'Each colour starts at the percentage in its box.</div>' +
      '<div class="aiondx-ctx-rows" data-testid="aiondx-ctx-rows"></div>' +
      '<div class="aiondx-accent-row"><button type="button" class="aiondx-bg-reset aiondx-ctx-reset">Reset the ring colours</button></div>' +
      '<div class="aiondx-accent-title aiondx-bubbles-title">Chat colours</div>' +
      '<div class="aiondx-accent-desc">Message bubbles, separately for dark and light mode. Right-click any message to come straight here.</div>' +
      '<div class="aiondx-bubbles" data-testid="aiondx-bubbles"></div>';
    el.querySelector('.aiondx-setup-open').addEventListener('click', function (ev) {
      ev.preventDefault();
      welcome.opened = true;
      showWelcome(1);
    });
    var row = el.querySelector('.aiondx-accent-row');
    ACCENTS.forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'aiondx-swatch';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', a[0]);
      b.setAttribute('data-color', a[1]);
      b.style.background = a[1];
      b.addEventListener('click', function (ev) {
        ev.preventDefault();
        changeThemePrefs({ accent: a[1] });
      });
      row.appendChild(b);
    });
    var custom = document.createElement('label');
    custom.className = 'aiondx-swatch-custom';
    custom.innerHTML = '<input type="color" class="aiondx-accent-color" aria-label="Custom accent colour"><span>Custom</span>';
    row.appendChild(custom);
    custom.querySelector('input').addEventListener('input', function (ev) {
      var v = ev.target.value;
      if (pickerTimer) clearTimeout(pickerTimer);
      pickerTimer = setTimeout(function () {
        pickerTimer = null;
        changeThemePrefs({ accent: v });
      }, 250);
    });
    el.querySelector('.aiondx-accent-dividers').addEventListener('change', function (ev) {
      changeThemePrefs({ accent: currentAccent(), dividers: ev.target.checked });
    });
    Array.prototype.forEach.call(el.querySelectorAll('.aiondx-bg-pick'), function (lab) {
      var mode = lab.getAttribute('data-mode');
      var timer = null;
      lab.querySelector('input').addEventListener('input', function (ev) {
        var v = ev.target.value;
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () {
          timer = null;
          var c = {};
          c[mode === 'dark' ? 'bgDark' : 'bgLight'] = v;
          changeThemePrefs(c);
        }, 200);
      });
    });
    Array.prototype.forEach.call(el.querySelectorAll('.aiondx-bg-reset[data-mode]'), function (b) {
      b.addEventListener('click', function (ev) {
        ev.preventDefault();
        var c = {};
        c[b.getAttribute('data-mode') === 'dark' ? 'bgDark' : 'bgLight'] = null;
        changeThemePrefs(c);
      });
    });
    buildCtxRows(el.querySelector('.aiondx-ctx-rows'));
    el.querySelector('.aiondx-ctx-reset').addEventListener('click', function (ev) {
      ev.preventDefault();
      changeThemePrefs({ ctx: null });
    });
    return el;
  }
  function refreshAccentPicker() {
    if (!pickerEl) return;
    var accent = currentAccent();
    var known = false;
    Array.prototype.forEach.call(pickerEl.querySelectorAll('.aiondx-swatch'), function (b) {
      var on = b.getAttribute('data-color') === accent;
      known = known || on;
      b.classList.toggle('aiondx-swatch--on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    var custom = pickerEl.querySelector('.aiondx-swatch-custom');
    custom.classList.toggle('aiondx-swatch--on', !known);
    var input = pickerEl.querySelector('.aiondx-accent-color');
    if (document.activeElement !== input && input.value !== accent) input.value = accent;
    var box = pickerEl.querySelector('.aiondx-accent-dividers');
    var want = !(themePrefs && themePrefs.dividers === false);
    if (box.checked !== want) box.checked = want;
    Array.prototype.forEach.call(pickerEl.querySelectorAll('.aiondx-bg-pick'), function (lab) {
      var mode = lab.getAttribute('data-mode');
      var set = themePrefs && hexRgb(themePrefs[mode === 'dark' ? 'bgDark' : 'bgLight']) ? themePrefs[mode === 'dark' ? 'bgDark' : 'bgLight'].toLowerCase() : '';
      var inp = lab.querySelector('input');
      var val = set || BG_DEFAULTS[mode];
      if (document.activeElement !== inp && inp.value !== val) inp.value = val;
      lab.classList.toggle('aiondx-swatch--on', !!set);
      var reset = pickerEl.querySelector('.aiondx-bg-reset[data-mode="' + mode + '"]');
      reset.disabled = !set;
    });
    refreshCtxRows();
    refreshBubbleRows();
  }

  // ---------------------------------------------------------------- the context ring's colours (2026-10-01)

  // K, 2026-10-01: "context meter seems to be based on my color, but the wheel should 1. be configurable 2. have multiple
  // color zones, defaulting to blue for low context usage, green, yellow, orange, then red". AionUi's ring
  // (components/agent/ContextUsageIndicator.tsx) is the accent colour until 70%, then amber, then red above 90%. AionDX
  // reads how far the ring is filled from its stroke-dashoffset and paints its progress circle with the zone colour
  // (an inline style beats the stroke attribute React writes). Five zones, each starting at a percentage of the context
  // window; the colours and the percentages are set in Settings > Appearance, in the theme record as ctx = { zones: [{ from, color }] }.
  var CTX_ZONES = [{ from: 0, color: '#3b82f6' }, { from: 40, color: '#22c55e' }, { from: 60, color: '#eab308' },
    { from: 75, color: '#f97316' }, { from: 90, color: '#ef4444' }];
  var CTX_NAMES = ['Low', 'Moderate', 'Filling', 'High', 'Nearly full'];
  /** The zones in force: the saved ones where valid (each start above the one before, the first at 0), else the defaults. */
  function ctxZones() {
    var z = themePrefs && themePrefs.ctx && Array.isArray(themePrefs.ctx.zones) ? themePrefs.ctx.zones : null;
    var out = [], prev = 0;
    for (var i = 0; i < CTX_ZONES.length; i++) {
      var w = z && z[i] && typeof z[i] === 'object' ? z[i] : {};
      var from = i === 0 ? 0 : Number(w.from);
      if (!(from >= 0)) from = CTX_ZONES[i].from;
      from = i === 0 ? 0 : Math.min(100 - (CTX_ZONES.length - 1 - i), Math.max(prev + 1, Math.round(from)));
      out.push({ from: from, color: hexRgb(w.color) ? String(w.color).toLowerCase() : CTX_ZONES[i].color });
      prev = from;
    }
    return out;
  }
  function ctxColour(pct) {
    var zones = ctxZones(), color = zones[0].color;
    for (var i = 0; i < zones.length; i++) if (pct >= zones[i].from) color = zones[i].color;
    return color;
  }
  /** Colour every context ring on screen by how full it is. */
  function paintContextRings() {
    var rings = document.querySelectorAll('.context-usage-indicator svg circle:nth-of-type(2)');
    for (var i = 0; i < rings.length; i++) {
      var c = rings[i];
      var circ = parseFloat(c.getAttribute('stroke-dasharray'));
      var off = parseFloat(c.getAttribute('stroke-dashoffset'));
      if (!(circ > 0) || !(off >= 0)) continue;
      var pct = Math.max(0, Math.min(100, (1 - off / circ) * 100));
      var col = ctxColour(pct);
      if (c.style.stroke !== col && c.style.stroke.replace(/\s/g, '') !== hexToRgbText(col)) c.style.stroke = col;
    }
  }
  function hexToRgbText(hex) { var r = hexRgb(hex); return r ? 'rgb(' + r.join(',') + ')' : ''; }
  function buildCtxRows(box) {
    CTX_ZONES.forEach(function (z, i) {
      var row = document.createElement('div');
      row.className = 'aiondx-ctx-row';
      row.setAttribute('data-i', String(i));
      row.innerHTML = '<label class="aiondx-swatch-custom"><input type="color" class="aiondx-ctx-color" aria-label=""><span></span></label>' +
        '<span class="aiondx-ctx-from-lab">starts at</span><input type="number" class="aiondx-ctx-from" min="0" max="100" step="1" aria-label=""><span>%</span>';
      row.querySelector('.aiondx-swatch-custom span').textContent = CTX_NAMES[i];
      row.querySelector('.aiondx-ctx-color').setAttribute('aria-label', CTX_NAMES[i] + ' colour');
      row.querySelector('.aiondx-ctx-from').setAttribute('aria-label', CTX_NAMES[i] + ' starts at, percent of the context window');
      if (i === 0) row.querySelector('.aiondx-ctx-from').disabled = true;
      var timer = null;
      var commit = function () {
        timer = null;
        var zones = Array.prototype.map.call(box.querySelectorAll('.aiondx-ctx-row'), function (r) {
          return { from: Number(r.querySelector('.aiondx-ctx-from').value) || 0, color: r.querySelector('.aiondx-ctx-color').value };
        });
        changeThemePrefs({ ctx: { zones: zones } });
      };
      var later = function () { if (timer) clearTimeout(timer); timer = setTimeout(commit, 250); };
      row.querySelector('.aiondx-ctx-color').addEventListener('input', later);
      row.querySelector('.aiondx-ctx-from').addEventListener('input', later);
      row.querySelector('.aiondx-ctx-from').addEventListener('change', commit);
      box.appendChild(row);
    });
  }
  function refreshCtxRows() {
    if (!pickerEl) return;
    var zones = ctxZones();
    var saved = !!(themePrefs && themePrefs.ctx && themePrefs.ctx.zones);
    Array.prototype.forEach.call(pickerEl.querySelectorAll('.aiondx-ctx-row'), function (row, i) {
      var col = row.querySelector('.aiondx-ctx-color'), from = row.querySelector('.aiondx-ctx-from');
      if (document.activeElement !== col && col.value !== zones[i].color) col.value = zones[i].color;
      if (document.activeElement !== from && from.value !== String(zones[i].from)) from.value = String(zones[i].from);
    });
    var reset = pickerEl.querySelector('.aiondx-ctx-reset');
    if (reset) reset.disabled = !saved;
  }

  // ---------------------------------------------------------------- chat colours (build 2026-09-26.3)

  // K, 2026-09-26: "want the ability to change the color of each chat bubble, and all chat types should be
  // seperated. i want the ability to make my chat bubbles different colors from any agent", and "color changes
  // should be accessible by right-clicking any item and getting sent directly to it's color control panel
  // section of the settings". His answers: a colour per agent and per team member ("be able to set team agent
  // colors and their chat color helps establish the identity"); controls of their own for his typed messages,
  // Loop nudges and agent-to-agent messages; separate dark and light colours; a small right-click menu.
  // Research: ! LLM Files\Research\2026-09-26_chat-bubble-dom-and-colours.md.
  //
  // Kept in the theme record (aiondx.theme) as bubbles = { mine, loop, a2a, agents: {<agent id>: ...},
  // members: {<team id>/<slot id>: ...} }, each {dark, light}. Rows are tagged as they render:
  // data-aiondx-kind (mine, loop, a2a, agent), data-aiondx-agent and data-aiondx-member on an agent's replies,
  // data-aiondx-from on a teammate message (its sender). A member's colour is its bubbles', its column's and,
  // mixed toward the text colour, its name's; AionUi's own member colours are indices into a fixed palette read
  // once per page, so AionDX overrides them in CSS instead.
  var BUBBLE_KINDS = [
    ['mine', 'Your messages', 'What you type, in every chat and team column.'],
    ['loop', 'Loop nudges', 'The Loop\'s automatic messages, which otherwise look like yours.'],
    ['a2a', 'Agent-to-agent messages', 'What an agent sends into another chat: team messages and cross-chat sends.']
  ];
  var BUBBLE_START = { dark: '#3d4150', light: '#e5e7f0' };   // AionUi's own bubble colour, a starting point
  var bubbleTeams = { at: 0, tried: 0, list: [], loading: null };   // [{id, name, members: [{slot, name, role}]}]
  var bubbleTeamPick = '';     // the team whose members the settings rows show
  var bubbleSig = '';          // what the rows were last built from
  var colourFocus = null;      // { key, at }: a right-click asked for this control
  var colourFlash = { key: '', until: 0 };   // the control marked for it, kept through a rebuild of the rows
  var colourMenu = null;

  function bubblePrefs() { return themePrefs && themePrefs.bubbles && typeof themePrefs.bubbles === 'object' ? themePrefs.bubbles : {}; }
  function bubbleEntry(key) {
    var b = bubblePrefs();
    if (key.indexOf('agent:') === 0) return (b.agents || {})[key.slice(6)] || null;
    if (key.indexOf('member:') === 0) return (b.members || {})[key.slice(7)] || null;
    return b[key] || null;
  }
  /** One colour of one control; mode null clears both. */
  function setBubble(key, mode, hex) {
    var b = JSON.parse(JSON.stringify(bubblePrefs()));
    var box = b, k = key;
    if (key.indexOf('agent:') === 0) { b.agents = b.agents || {}; box = b.agents; k = key.slice(6); }
    else if (key.indexOf('member:') === 0) { b.members = b.members || {}; box = b.members; k = key.slice(7); }
    var e = Object.assign({}, box[k] || {});
    if (mode) e[mode] = hexRgb(hex) ? hex.toLowerCase() : null;
    else { e.dark = null; e.light = null; }
    if (!e.dark && !e.light) delete box[k]; else box[k] = e;
    changeThemePrefs({ bubbles: b });
  }
  function cssId(s) { return String(s).replace(/["\\\n]/g, ''); }
  function softOn(hex) { return onColour(hex) === '#ffffff' ? 'rgba(255,255,255,.72)' : 'rgba(17,17,17,.68)'; }
  function bubbleDecl(hex) {
    var t = onColour(hex), s = softOn(hex);
    return 'background-color:' + hex + ' !important;color:' + t + ' !important;--text-primary:' + t + ' !important;--text-secondary:' + s +
      ' !important;--color-text-1:' + t + ' !important;--color-text-2:' + s + ' !important;--color-text-3:' + s + ' !important';
  }
  /** For the Markdown shadow host inside a bubble: a declaration from the page beats the shadow's own :host. */
  function hostDecl(hex) {
    var t = onColour(hex), s = softOn(hex);
    return '--text-primary:' + t + ';--text-secondary:' + s + ';--color-text-1:' + t + ';--color-text-2:' + s + ';--color-text-3:' + s;
  }
  function bubbleCss(p) {
    var b = (p && p.bubbles && typeof p.bubbles === 'object') ? p.bubbles : {};
    var css = '';
    var REPLY = ' [data-testid="message-text-content"]';
    var SHAPE = ';padding:8px 12px !important;border-radius:4px 12px 12px 12px !important';
    ['dark', 'light'].forEach(function (mode) {
      var root = "html:root[data-theme='" + mode + "'] ";
      var paint = function (sel, hex, extra) {
        if (!hexRgb(hex)) return;
        css += root + sel + '{' + bubbleDecl(hex) + (extra || '') + '}' + root + sel + ' .markdown-shadow{' + hostDecl(hex) + '}';
      };
      var of = function (e) { return e && e[mode]; };
      paint('[data-aiondx-kind="mine"] .bg-aou-2', of(b.mine));
      paint('[data-aiondx-kind="loop"] .bg-aou-2', of(b.loop));
      paint('[data-aiondx-kind="a2a"] .bg-aou-2', of(b.a2a));
      paint('[data-aiondx-kind="a2a"] .bg-3', of(b.a2a));
      Object.keys(b.agents || {}).forEach(function (id) {
        paint('[data-aiondx-kind="agent"][data-aiondx-agent="' + cssId(id) + '"]' + REPLY, of(b.agents[id]), SHAPE);
      });
      // Members after agents, so a member's colour wins over its agent's.
      Object.keys(b.members || {}).forEach(function (k) {
        var hex = of(b.members[k]);
        if (!hexRgb(hex)) return;
        var mk = cssId(k), parts = k.split('/');
        paint('[data-aiondx-kind="agent"][data-aiondx-member="' + mk + '"]' + REPLY, hex, SHAPE);
        var from = '[data-aiondx-kind="a2a"][data-aiondx-from="' + mk + '"]';
        paint(from + ' .bg-3', hex, ';border-left-color:' + hex + ' !important');
        var name = 'color:color-mix(in srgb, ' + hex + ' 70%, var(--text-primary)) !important';
        css += root + from + ' span.text-12px{' + name + '}';
        var col = 'body[data-aiondx-team="' + cssId(parts[0]) + '"] [data-slot-id="' + cssId(parts[1] || '') + '"]';
        css += root + col + ' > .h-full{background:color-mix(in srgb, ' + hex + ' 6%, var(--bg-base)) !important}' +
          root + col + ' > .h-full > div:first-child .truncate{' + name + '}';
      });
    });
    return css;
  }

  /** An assistant's agent: the list's own record, or the id inside a generated assistant's "bare:<agent id>". */
  function agentOfAssistant(aid) {
    if (!aid) return '';
    for (var i = 0; i < agentList.all.length; i++) if (agentList.all[i].id === aid) return agentList.all[i].agentId;
    return /^bare:/.test(aid) ? aid.slice(5) : '';
  }
  function setAttr(el, name, value) {
    if (value) { if (el.getAttribute(name) !== value) el.setAttribute(name, value); }
    else if (el.hasAttribute(name)) el.removeAttribute(name);
  }
  function rowKind(row, content) {
    var pos = row.getAttribute('data-message-position');
    if (pos === 'left') return row.querySelector('.bg-3') ? 'a2a' : 'agent';
    if (pos !== 'right') return null;
    var text = (content.textContent || '').replace(/^\s+/, '');
    if (!text) return null;   // not rendered yet: look again next time
    if (text.indexOf('[AionDX Loop') === 0 || /^\[Loop\] Resuming you after a pause/.test(text)) return 'loop';
    // A cross-chat delivery: the "From conversation" badge above the bubble.
    if (row.querySelector('[aria-label^="Mention conversation"], .mb-4px.self-end.text-t-secondary')) return 'a2a';
    return 'mine';
  }
  /** Tags each text row with its kind and whose it is, for the colours above. */
  function tagBubbles() {
    var r = route();
    var teamId = r && r.kind === 'team' ? r.id : '';
    setAttr(document.body, 'data-aiondx-team', teamId);
    var rows = document.querySelectorAll('[id^="message-"][data-message-type="text"]');
    if (!rows.length) return;
    var soloAgent = '';
    if (r && r.kind === 'conv') {
      var info = convInfo[r.id];
      if (!info || Date.now() - info.at > CONV_INFO_MS) loadConvInfo(r.id);
      if (info) soloAgent = chatAgent(r.id, info).id || '';
    }
    var single = '', tc = null;
    if (teamId) {
      var tab = document.querySelector('[data-testid^="team-tab-"][data-active="true"]');
      if (tab) single = tab.getAttribute('data-testid').slice('team-tab-'.length);
      tc = teamCache[teamId];
      if (!tc || Date.now() - tc.at > TEAM_CACHE_MS) memberConversation({ teamId: teamId, slotId: single || '' }).catch(function () {});
    }
    if (!agentList.at) loadAgents();
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var content = row.querySelector('[data-testid="message-text-content"]');
      if (!content) continue;
      var kind = row.getAttribute('data-aiondx-kind');
      if (!kind) {
        kind = rowKind(row, content);
        if (!kind) continue;
        row.setAttribute('data-aiondx-kind', kind);
      }
      if (kind === 'agent') {
        var col = teamId ? row.closest('[data-slot-id]') : null;
        var slot = col ? col.getAttribute('data-slot-id') : single;
        setAttr(row, 'data-aiondx-member', teamId && slot ? teamId + '/' + slot : '');
        setAttr(row, 'data-aiondx-agent', teamId ? (tc && tc.assistants ? agentOfAssistant(tc.assistants[slot] || '') : '') : soloAgent);
      } else if (kind === 'a2a' && tc && !row.hasAttribute('data-aiondx-from')) {
        var nm = row.querySelector('span.text-12px');   // the sender's name above a teammate message
        var who = nm ? (nm.textContent || '').trim() : '';
        if (!who) continue;
        var from = '';
        for (var s in tc.names) if (Object.prototype.hasOwnProperty.call(tc.names, s) && tc.names[s] === who) { from = teamId + '/' + s; break; }
        row.setAttribute('data-aiondx-from', from);
      }
    }
  }

  // The settings rows, under AionDX colours on Settings > Appearance.
  function loadBubbleTeams() {
    if (bubbleTeams.loading || (bubbleTeams.tried && Date.now() - bubbleTeams.tried < 60000)) return;
    bubbleTeams.tried = Date.now();
    bubbleTeams.loading = getJson('/api/teams').then(function (g) {
      var raw = Array.isArray(g.data) ? g.data : (g.data && (g.data.teams || g.data.items)) || null;
      if (raw) {
        bubbleTeams.list = raw.filter(function (t) { return t && t.id; }).map(function (t) {
          var ms = Array.isArray(t.assistants) ? t.assistants : (Array.isArray(t.agents) ? t.agents : []);
          return { id: String(t.id), name: String(t.name || t.id), members: ms.filter(function (m) { return m && m.slot_id; }).map(function (m) {
            return { slot: String(m.slot_id), name: String(m.name || m.assistant_name || m.slot_id), role: String(m.role || '') };
          }) };
        });
        bubbleTeams.at = Date.now();
      }
    }, function () {}).then(function () { bubbleTeams.loading = null; schedule(); });
  }
  function bubbleRow(key, label, desc) {
    var row = document.createElement('div');
    row.className = 'aiondx-bubble-row';
    row.setAttribute('data-bubble', key);
    row.innerHTML = '<div class="aiondx-bubble-text"><div class="aiondx-bubble-name"></div>' + (desc ? '<div class="aiondx-bubble-desc"></div>' : '') + '</div>' +
      '<label class="aiondx-bubble-pick" data-mode="dark"><input type="color"><span>Dark</span></label>' +
      '<label class="aiondx-bubble-pick" data-mode="light"><input type="color"><span>Light</span></label>' +
      '<button type="button" class="aiondx-bg-reset aiondx-bubble-reset">Reset</button>';
    row.querySelector('.aiondx-bubble-name').textContent = label;
    if (desc) row.querySelector('.aiondx-bubble-desc').textContent = desc;
    Array.prototype.forEach.call(row.querySelectorAll('.aiondx-bubble-pick'), function (lab) {
      var mode = lab.getAttribute('data-mode');
      var input = lab.querySelector('input');
      input.setAttribute('aria-label', label + ', ' + mode + ' mode');
      var timer = null;
      input.addEventListener('input', function () {
        var v = input.value;
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () { timer = null; setBubble(key, mode, v); }, 200);
      });
    });
    row.querySelector('.aiondx-bubble-reset').addEventListener('click', function (ev) { ev.preventDefault(); setBubble(key, null); });
    return row;
  }
  function paintBubbleRow(row) {
    var e = bubbleEntry(row.getAttribute('data-bubble')) || {};
    ['dark', 'light'].forEach(function (mode) {
      var lab = row.querySelector('.aiondx-bubble-pick[data-mode="' + mode + '"]');
      var input = lab.querySelector('input'), chip = lab.querySelector('span');
      var hex = hexRgb(e[mode]) ? e[mode] : '';
      chip.style.background = hex;
      chip.style.color = hex ? onColour(hex) : '';
      lab.classList.toggle('aiondx-bubble-pick--set', !!hex);
      var val = hex || BUBBLE_START[mode];
      if (document.activeElement !== input && input.value !== val) input.value = val;
    });
    row.querySelector('.aiondx-bubble-reset').disabled = !(e.dark || e.light);
  }
  function bubbleSub(text) {
    var d = document.createElement('div');
    d.className = 'aiondx-bubble-sub';
    d.textContent = text;
    return d;
  }
  /** Rebuilt when the agent or team lists change; otherwise only repainted. */
  function refreshBubbleRows(force) {
    if (!pickerEl) return;
    var box = pickerEl.querySelector('.aiondx-bubbles');
    if (!box) return;
    loadAgents();
    loadBubbleTeams();
    var seen = {}, agents = [];
    enabledAgents().forEach(function (a) {
      if (!a.agentId || seen[a.agentId]) return;
      seen[a.agentId] = true;
      agents.push({ id: a.agentId, name: agentName(a.agentId) });
    });
    if (!bubbleTeamPick && bubbleTeams.list.length) bubbleTeamPick = bubbleTeams.list[0].id;
    var team = null;
    bubbleTeams.list.forEach(function (t) { if (t.id === bubbleTeamPick) team = t; });
    if (!team && bubbleTeams.at && bubbleTeams.list.length) { team = bubbleTeams.list[0]; bubbleTeamPick = team.id; }   // that team is gone
    var sig = JSON.stringify([agents, bubbleTeams.list.map(function (t) { return [t.id, t.name, t.members.length]; }), bubbleTeamPick]);
    if (force || sig !== bubbleSig) {
      bubbleSig = sig;
      box.textContent = '';
      BUBBLE_KINDS.forEach(function (k) { box.appendChild(bubbleRow(k[0], k[1], k[2])); });
      box.appendChild(bubbleSub('Agents: their replies'));
      if (!agents.length) box.appendChild(bubbleSub('Loading your agents...'));
      agents.forEach(function (a) { box.appendChild(bubbleRow('agent:' + a.id, a.name, '')); });
      box.appendChild(bubbleSub('Team members: their replies, their messages to teammates, their column and their name'));
      if (bubbleTeams.list.length) {
        var sel = document.createElement('select');
        sel.className = 'aiondx-bubble-team';
        sel.setAttribute('aria-label', 'Team');
        bubbleTeams.list.forEach(function (t) {
          var o = document.createElement('option');
          o.value = t.id;
          o.textContent = t.name;
          sel.appendChild(o);
        });
        sel.value = bubbleTeamPick;
        sel.addEventListener('change', function () { bubbleTeamPick = sel.value; refreshBubbleRows(true); });
        box.appendChild(sel);
        if (team) team.members.forEach(function (m) {
          box.appendChild(bubbleRow('member:' + team.id + '/' + m.slot, m.name, m.role === 'lead' || m.role === 'leader' ? 'Lead' : ''));
        });
      } else {
        box.appendChild(bubbleSub(bubbleTeams.at ? 'No teams yet.' : 'Loading your teams...'));
      }
    }
    Array.prototype.forEach.call(box.querySelectorAll('.aiondx-bubble-row'), paintBubbleRow);
    // A rebuild (the team list arriving, say) replaces the marked row: mark its successor.
    if (Date.now() < colourFlash.until) {
      var fr = box.querySelector('.aiondx-bubble-row[data-bubble="' + cssId(colourFlash.key) + '"]');
      if (fr && !fr.classList.contains('aiondx-colour-focus')) {
        fr.classList.add('aiondx-colour-focus');
        try { fr.scrollIntoView({ block: 'center' }); } catch (e) {}
      }
    }
  }

  // Right-click: a small menu with the colours of what was clicked (and Copy, with text selected), each
  // opening Settings > Appearance at that control. Everything else keeps its own menu: AionUi's (the file tree,
  // the sidebar, preview tabs), and the Cut/Copy/Paste one in text boxes, which Electron shows only when the
  // page has not taken the right-click.
  function selectedText(path) {
    for (var i = 0; i < path.length; i++) {
      var n = path[i];
      if (n && n.shadowRoot && typeof n.shadowRoot.getSelection === 'function') {
        var ss = n.shadowRoot.getSelection();
        var st = ss ? String(ss) : '';
        if (st.trim()) return st;
      }
    }
    var s = window.getSelection ? String(window.getSelection()) : '';
    return s.trim() ? s : '';
  }
  function memberName(teamId, slot) {
    var c = teamCache[teamId];
    return (c && c.names && c.names[slot]) || 'this member';
  }
  function colourItemsFor(path) {
    var items = [], row = null, col = null;
    for (var i = 0; i < path.length; i++) {
      var n = path[i];
      if (!n || n.nodeType !== 1) continue;
      if (!row && n.id && n.id.indexOf('message-') === 0 && n.hasAttribute('data-aiondx-kind')) row = n;
      if (!col && n.hasAttribute && n.hasAttribute('data-slot-id')) col = n;
    }
    var r = route();
    var teamId = r && r.kind === 'team' ? r.id : '';
    if (row) {
      var kind = row.getAttribute('data-aiondx-kind');
      var label = { mine: 'your messages', loop: 'Loop nudges', a2a: 'agent-to-agent messages' }[kind];
      if (kind === 'agent') {
        var mem = row.getAttribute('data-aiondx-member');
        if (mem) items.push({ key: 'member:' + mem, label: 'Colour of ' + memberName(mem.split('/')[0], mem.split('/')[1]) + '...' });
        var ag = row.getAttribute('data-aiondx-agent');
        if (ag) items.push({ key: 'agent:' + ag, label: 'Colour of ' + agentName(ag) + '\'s replies...' });
      } else if (label) {
        var fr = row.getAttribute('data-aiondx-from');
        if (fr) items.push({ key: 'member:' + fr, label: 'Colour of ' + memberName(fr.split('/')[0], fr.split('/')[1]) + '...' });
        items.push({ key: kind, label: 'Colour of ' + label + '...' });
      }
    } else if (col && teamId) {
      var sl = col.getAttribute('data-slot-id');
      items.push({ key: 'member:' + teamId + '/' + sl, label: 'Colour of ' + memberName(teamId, sl) + '...' });
    } else if (r && (r.kind === 'conv' || r.kind === 'team')) {
      // An empty part of a chat: its backdrop.
      for (var j = 0; j < Math.min(path.length, 10); j++) {
        var el = path[j];
        if (el && el.nodeType === 1 && el.querySelector && el.querySelector('[id^="message-"]')) {
          items.push({ key: 'bg', label: 'Background colour...' });
          break;
        }
      }
    }
    return items;
  }
  function onContextMenu(ev) {
    if (ev.defaultPrevented || disabled()) return;
    var path = ev.composedPath ? ev.composedPath() : [ev.target];
    for (var i = 0; i < path.length; i++) {
      var n = path[i];
      if (!n || n.nodeType !== 1) continue;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName) || n.isContentEditable) return;
      if (n.classList && (n.classList.contains('arco-dropdown') || n.classList.contains('arco-trigger-popup') ||
          n.classList.contains('arco-menu') || n.classList.contains('arco-modal'))) return;
      if (ours(n)) return;
    }
    var items = colourItemsFor(path);
    if (!items.length) return;
    ev.preventDefault();
    var sel = selectedText(path);
    if (sel) items.unshift({ copy: sel, label: 'Copy' });
    openColourMenu(ev.clientX, ev.clientY, items);
  }
  function closeColourMenu() {
    if (!colourMenu) return;
    if (colourMenu.parentNode) colourMenu.parentNode.removeChild(colourMenu);
    colourMenu = null;
    document.removeEventListener('mousedown', colourMenuOutside, true);
    document.removeEventListener('keydown', colourMenuKey, true);
    window.removeEventListener('blur', closeColourMenu);
  }
  function colourMenuOutside(ev) { if (colourMenu && !colourMenu.contains(ev.target)) closeColourMenu(); }
  function colourMenuKey(ev) { if (ev.key === 'Escape') { ev.stopPropagation(); closeColourMenu(); } }
  function openColourMenu(x, y, items) {
    closeColourMenu();
    colourMenu = document.createElement('div');
    colourMenu.className = 'aiondx-colour-menu arco-dropdown-menu';
    colourMenu.setAttribute('role', 'menu');
    colourMenu.setAttribute('data-testid', 'aiondx-colour-menu');
    items.forEach(function (it) {
      var el = document.createElement('div');
      el.className = 'arco-dropdown-menu-item';
      el.setAttribute('role', 'menuitem');
      if (it.key) el.setAttribute('data-colour-key', it.key);
      el.textContent = it.label;
      el.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        closeColourMenu();
        if (it.copy) {
          var done = function () {};
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(it.copy).then(done, function () { try { document.execCommand('copy'); } catch (e) {} });
          else { try { document.execCommand('copy'); } catch (e) {} }
          return;
        }
        openColourControl(it.key);
      });
      colourMenu.appendChild(el);
    });
    document.body.appendChild(colourMenu);
    var w = colourMenu.offsetWidth || 220, h = colourMenu.offsetHeight || 80;
    colourMenu.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 4)) + 'px';
    colourMenu.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 4)) + 'px';
    setTimeout(function () {
      document.addEventListener('mousedown', colourMenuOutside, true);
      document.addEventListener('keydown', colourMenuKey, true);
      window.addEventListener('blur', closeColourMenu);
    }, 0);
  }
  /** Settings > Appearance, scrolled to that control and marked for a moment. */
  function openColourControl(key) {
    colourFocus = { key: key, at: Date.now() };
    if (key.indexOf('member:') === 0) bubbleTeamPick = key.slice(7).split('/')[0];
    if (!/^#\/settings\/appearance/.test(location.hash)) location.hash = '#/settings/appearance';
    schedule();
  }
  function focusColour() {
    if (!colourFocus) return;
    if (Date.now() - colourFocus.at > 15000) { colourFocus = null; return; }
    if (!pickerEl || !pickerEl.parentNode) return;   // the page is not on screen yet
    var key = colourFocus.key;
    if (key.indexOf('member:') === 0) refreshBubbleRows();
    var el = key === 'bg' ? pickerEl.querySelector('.aiondx-bg-row')
      : pickerEl.querySelector('.aiondx-bubble-row[data-bubble="' + cssId(key) + '"]');
    if (!el) return;   // its list is still loading: the next pass tries again
    colourFocus = null;
    colourFlash = { key: key, until: Date.now() + 2600 };
    try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
    el.classList.remove('aiondx-colour-focus');
    void el.offsetWidth;
    el.classList.add('aiondx-colour-focus');
    setTimeout(function () {
      Array.prototype.forEach.call(document.querySelectorAll('.aiondx-colour-focus'), function (x) { x.classList.remove('aiondx-colour-focus'); });
    }, 2700);
  }

  // ---------------------------------------------------------------- MCP, seen and switched (build 2026-09-26.3)

  // K, 2026-09-26: "is MCP fully configurable and transparent to agents working in AIonDX? If not, we need to make
  // it so"; agents change servers freely and he sees each change. Research:
  // ! LLM Files\Research\2026-09-26_mcp-configurable-and-transparent.md. Agents change AionUi's MCP list with the
  // Loop tool's mcp_set (patch 0007 1.5.0), which logs each change to aiondx.mcp.log; this window announces each one
  // with the agent's name, linked to its chat. Settings > Tools gets an On/Off switch per server: AionUi 2.2.2 shows
  // none, though that state decides which servers a new chat gets.
  var MCP_LOG_KEY = 'aiondx.mcp.log';
  var mcpSeenAt = 0;
  var mcpList = { at: 0, byName: {}, loading: null };
  var MCP_VERBS = { add: 'added', update: 'changed', enable: 'switched on', disable: 'switched off', remove: 'removed' };

  function takeMcpLog(data) {
    var log = Array.isArray(data[MCP_LOG_KEY]) ? data[MCP_LOG_KEY] : [];
    var since = mcpSeenAt || (Date.now() - ANNOUNCE_MS);   // the first read announces only what just happened
    var newest = since;
    log.forEach(function (e) {
      var at = Number(e && e.at) || 0;
      if (at <= since) return;
      newest = Math.max(newest, at);
      var text = String(e.who || 'An agent') + ' ' + (MCP_VERBS[e.action] || String(e.action || 'changed')) + ' the MCP server ' + String(e.name || '') + '.';
      var conv = typeof e.conv === 'string' && /^[\w-]{4,64}$/.test(e.conv) ? e.conv : '';
      if (conv) notify({ kind: 'conv', key: 'conv:' + conv, convId: conv }, text, String(e.note || ''));
      else toast(text, String(e.note || ''));
      mcpList.at = 0;   // the switches read the list again
    });
    mcpSeenAt = newest;
  }
  function loadMcpList(force) {
    if (mcpList.loading || (!force && mcpList.at && Date.now() - mcpList.at < 30000)) return;
    mcpList.loading = getJson('/api/mcp/servers').then(function (g) {
      var raw = Array.isArray(g.data) ? g.data : null;
      if (raw) {
        var by = {};
        raw.forEach(function (s) { if (s && s.name) by[String(s.name)] = s; });
        mcpList.byName = by;
        mcpList.at = Date.now();
      }
    }, function () {}).then(function () { mcpList.loading = null; schedule(); });
  }
  /** Settings > Tools: each server row's header (McpServerHeader.tsx) is a .group row whose first span is the name. */
  function renderMcpSwitches() {
    if (!/^#\/settings\/tools/.test(location.hash)) return;
    var names = document.querySelectorAll('div.flex.items-center.justify-between.group > div.flex.items-center.gap-2 > span:first-child');
    if (!names.length) return;
    loadMcpList();
    for (var i = 0; i < names.length; i++) {
      var span = names[i];
      var s = mcpList.byName[(span.textContent || '').trim()];
      var group = span.parentNode;
      var sw = group.querySelector('.aiondx-mcp-switch');
      if (!s || s.builtin) { if (sw) sw.parentNode.removeChild(sw); continue; }
      if (!sw) {
        sw = document.createElement('button');
        sw.type = 'button';
        sw.setAttribute('role', 'switch');
        sw.className = 'arco-switch arco-switch-type-circle arco-switch-size-small aiondx-mcp-switch';
        sw.innerHTML = '<div class="arco-switch-dot"></div>';
        sw.addEventListener('click', onMcpSwitch);
        group.insertBefore(sw, span.nextSibling);
      }
      var on = !!s.enabled;
      if (sw.getAttribute('data-mcp-id') !== String(s.id)) sw.setAttribute('data-mcp-id', String(s.id));
      if (sw.getAttribute('aria-checked') !== String(on)) {
        sw.setAttribute('aria-checked', String(on));
        sw.classList.toggle('arco-switch-checked', on);
        sw.title = on ? 'On: new chats get ' + s.name + '. Click to switch it off.' : 'Off: new chats do not get ' + s.name + '. Click to switch it on.';
      }
    }
  }
  function onMcpSwitch(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    var sw = ev.currentTarget;
    var id = sw.getAttribute('data-mcp-id');
    if (!id || sw.disabled) return;
    var want = sw.getAttribute('aria-checked') !== 'true';
    sw.disabled = true;
    // AionCore's toggle flips the state, so read it first: a page that has fallen behind cannot flip it the wrong way.
    getJson('/api/mcp/servers').then(function (g) {
      var cur = Array.isArray(g.data) ? g.data.filter(function (x) { return x && String(x.id) === id; })[0] : null;
      if (!cur || !!cur.enabled === want) return null;
      return postJson('/api/mcp/servers/' + encodeURIComponent(id) + '/toggle', {});
    }).then(function () { loadMcpList(true); }, function () { loadMcpList(true); }).then(function () { sw.disabled = false; });
  }

  // ---------------------------------------------------------------- compaction

  var slashCache = {};   // conversation id -> { at, cmd }
  var compacting = {};   // target key -> true while a compaction is being sent
  /** The agent's own compaction command, if it lists one: 'compact' or 'compress'; '' when it lists
   *  neither; null when the list could not be read. */
  async function compactCommand(convId) {
    var c = slashCache[convId];
    if (c && Date.now() - c.at < 10 * 60000) return c.cmd;
    var g = await getJson('/api/conversations/' + convId + '/slash-commands');
    if (g.err) return null;
    var names = (Array.isArray(g.data) ? g.data : []).map(function (x) { return x && (x.command || x.name); });
    var cmd = '';
    for (var i = 0; i < COMPACT_CMDS.length; i++) if (names.indexOf(COMPACT_CMDS[i]) >= 0) { cmd = COMPACT_CMDS[i]; break; }
    slashCache[convId] = { at: Date.now(), cmd: cmd };
    return cmd;
  }
  function compactPending(s) { return (s.compactAt || 0) > (s.compactSentAt || 0); }

  /** Send a requested compaction, now that the agent has stopped. `send` posts the text the way a
   *  nudge goes to this kind of chat; a team member's recognized command reaches it bare
   *  (aionui-team recognized_command_is_sent_bare_to_member). */
  async function sendCompact(t, convId, send) {
    if (compacting[t.key]) return;
    compacting[t.key] = true;
    try {
      var cmd = await compactCommand(convId);
      if (cmd === null) return;
      var s = state(t);
      if (!compactPending(s)) return;
      if (!cmd) {
        s.compactSentAt = s.compactAt;
        s.compactNote = 'Not sent: this agent offers no compact command.';
        save(t, s); publishStatus(t); render();
        return;
      }
      if (hasDraft(t)) { why(t, s, 'Holding the compaction: you have an unsent draft in this box.'); return; }
      var r = await send('/' + cmd);
      if (!r || !r.ok) return;   // the next check tries again
      s = state(t);
      var now = Date.now();
      s.compactSentAt = now;
      s.compactNote = 'Sent /' + cmd + ' at ' + hhmm(now) + '.';
      s.why = s.compactNote;
      s.whyAt = now;
      s.userSentAt = now;   // the next nudge waits for the compaction like any reply
      save(t, s); publishStatus(t); render();
    } finally {
      delete compacting[t.key];
    }
  }

  /** Record why the loop did or did not send on this check. Shown in the hover card and the
   *  menu, so "why isn't it firing?" has an answer on screen. Saved only when it changes. */
  function why(t, s, text) {
    if (s.why !== text) { s.why = text; s.whyAt = Date.now(); save(t, s); }
  }

  /** Stop nudging and let the cache run out: after a whole hold of short replies ('hold'), or
   *  because it already ran out ('cold'). The Loop stays on and carries on once the agent works
   *  again. Told once, with where it happened; a Loop found cold after a restart is not told. */
  function rest(t, s, kind, coldAt) {
    if (!s.restingSince) {
      s.restingSince = Date.now();
      s.restKind = kind;
      s.nextNudgeAt = 0;
      save(t, s);
      if (kind === 'hold' || kind === 'resume' || Date.now() - coldAt < ANNOUNCE_MS) {
        notify(t, 'Loop resting for {who}.', restText(s));
      }
      publishStatus(t);
      render();
    }
    why(t, s, restText(s));
  }
  function restText(s) {
    var warmTo = s.lastAt ? s.lastAt + CACHE_TTL_MS : 0;
    if (s.restKind === 'resume' && s.wakeAt) {
      return 'Resting until ' + hhmm(s.wakeAt) + ', the resume time: keeping the cache warm that long would cost more than ' +
        'one reload, so it runs out' + (warmTo > Date.now() ? ' at ' + hhmm(warmTo) : '') + '. The resume nudge goes at ' + hhmm(s.wakeAt) + '.';
    }
    var after = ' It carries on when the agent next works; a message from you starts it.' +
      (s.wakeAt ? ' The resume nudge goes at ' + hhmm(s.wakeAt) + '.' : '');
    if (s.restKind === 'hold') {
      var h = holdMinutes(s);
      return (h ? 'Resting: ' + h + ' min of short replies, so it stopped keeping the cache warm'
                : 'Resting: a short reply, and keeping the cache warm is switched off for this Loop') +
        (warmTo > Date.now() ? ' (warm until ' + hhmm(warmTo) + ').' : '.') + after;
    }
    return 'Resting: its cache ran out' + (warmTo ? ' at ' + hhmm(warmTo) : '') +
      ', and the Loop does not wake a cold agent.' + after;
  }

  // ---------------------------------------------------------------- your stop

  function saysStop(text) {
    var raw = String(text || '').replace(/^\s*\[AionDX Loop[^\]]*\]\s*/, '');
    var s = raw.replace(/\s+/g, ' ').trim();
    if (!s) return false;
    for (var i = 0; i < STOP_NOT_RES.length; i++) if (STOP_NOT_RES[i].test(s)) return false;
    for (var k = 0; k < STOP_CARVE_RES.length; k++) if (STOP_CARVE_RES[k].test(s)) return false;
    // Sentence by sentence: a question is never a stop, and a sentence that opens with if/when/once/after
    // (except "if that's all/it") is a condition, not an instruction. Then clause by clause within it.
    var sentences = raw.split(/(?<=[.!?;\n])/);
    for (var q = 0; q < sentences.length; q++) {
      var sen = sentences[q].replace(/\s+/g, ' ').trim();
      if (!sen || /\?\s*$/.test(sen)) continue;
      if (STOP_SUBORD_RE.test(sen.split(',')[0]) && !/^\s*(?:ok(?:ay)?[,\s]+)?if\s+(?:that'?s|that\s+is|this\s+is)\s+(?:all|it|everything)\b/i.test(sen)) continue;
      var clauses = sen.split(/[.!;,\n]+/);
      for (var c = 0; c < clauses.length; c++) {
        var cl = clauses[c].replace(/\s+/g, ' ').trim();
        if (!cl) continue;
        for (var j = 0; j < STOP_RES.length; j++) {
          var m = STOP_RES[j].exec(cl);
          if (m && !STOP_SUBORD_RE.test(cl.slice(0, m.index)) && !STOP_RELAY_RE.test(cl.slice(0, m.index)) &&
              !STOP_THEN_COND_RE.test(cl.slice(m.index + m[0].length))) return true;
        }
      }
    }
    return false;
  }

  /** "Turn off your loop", "stop the loop", "loop off", "can you turn the loop off?": an instruction to switch this
   *  chat's Loop off. Not a condition ("when you're done, stop the loop"), not a negation ("don't turn the loop off"),
   *  and a question only when it asks for it ("can you ..."), never "did you turn off the loop?". */
  function saysLoopOff(text) { return loopOffIn(text, false); }
  /** The same, or about another's Loop ("turn off Worker's loop", "stop all the loops"): see LOOP_ASK_RES. */
  function asksLoopOff(text) { return loopOffIn(text, true); }
  function loopOffIn(text, anyLoop) {
    var raw = String(text || '').replace(/^\s*\[AionDX Loop[^\]]*\]\s*/, '');
    var sentences = raw.split(/(?<=[.!?;\n])/);
    var hit = function (re) { return re.test(sen); };
    for (var q = 0; q < sentences.length; q++) {
      var sen = sentences[q].replace(/\s+/g, ' ').trim();
      if (!sen) continue;
      if (/\?\s*$/.test(sen) && !LOOP_OFF_ASK_RE.test(sen)) continue;
      if (STOP_SUBORD_RE.test(sen.split(',')[0])) continue;
      if (LOOP_OFF_NOT_RES.some(hit)) continue;
      if (anyLoop ? LOOP_OFF_RES.some(hit) || LOOP_ASK_RES.some(hit) : !LOOP_OTHER_RE.test(sen) && LOOP_OFF_RES.some(hit)) return true;
    }
    return false;
  }
  /** Your words asking for a Loop off, for the Loop tool (LOOP_ASK_RES): from this chat or member, just now. */
  function putLoopAsk(t, text) {
    if (sharedGone) return;
    var body = {};
    body[ASK_PREFIX + sharedKey(t).slice(SHARED_PREFIX.length)] = { v: 1, at: Date.now(), text: quoteOf(text) };
    putPrefs(body);
  }

  function quoteOf(text) {
    var q = String(text || '').replace(/\s+/g, ' ').trim();
    return q.length > 60 ? q.slice(0, 57) + '...' : q;
  }
  /** You said stop: that chat's Loop goes off, or every Loop of that team. */
  function stopLoopsFor(t, text) {
    var list = t.kind === 'team'
      ? storedTargets().filter(function (x) { return x.kind === 'team' && x.teamId === t.teamId; })
      : [t];
    var n = 0;
    list.forEach(function (x) {
      if (!state(x).on) return;
      setOn(x, false, 'you said "' + quoteOf(text) + '"', true);
      n++;
    });
    if (n) {
      notify(t, t.kind === 'team'
        ? 'Loop off for ' + (n === 1 ? '1 member' : n + ' members') + ' of this team: you said stop.'
        : 'Loop off: you said stop.', '"' + quoteOf(text) + '"');
    }
    return n;
  }
  /** A solo chat's newest message from you, since the Loop was switched on, says stop. */
  function stopInHistory(t, s, msgs) {
    if (!s.on) return false;
    for (var i = msgs.length - 1; i >= 0; i--) {
      var m = msgs[i];
      if (m.position !== 'right' || m.hidden) continue;
      if ((m.created_at || 0) <= (s.onAt || 0) || (m.created_at || 0) <= (s.stopSeenAt || 0)) return false;
      var text = msgText(m);
      if (text.indexOf(LOOP_TAG) === 0 || text === s.lastFiredText) return false;
      s.stopSeenAt = m.created_at || 0;
      save(t, s);
      if (saysLoopOff(text)) {
        setOn(t, false, 'you said "' + quoteOf(text) + '"', true);
        notify(t, 'Loop off for {who}: you asked.', '"' + quoteOf(text) + '"');
        return true;
      }
      if (!saysStop(text)) return false;
      stopLoopsFor(t, text);
      return true;
    }
    return false;
  }

  /** Unsent text in this target's own message box, when that box is on screen. */
  function hasDraft(t) {
    if (!t.actions) return false;
    var root = t.actions.closest('[data-slot-id]') || t.actions.closest('.sendbox-panel') || t.actions.parentNode;
    var box = root && root.querySelector('[data-testid="sendbox-input"]');
    if (!box) return false;
    var input = /^(TEXTAREA|INPUT)$/.test(box.tagName) ? box : box.querySelector('textarea, input');
    var text = input ? input.value : (box.isContentEditable ? box.textContent : '');
    return !!(text && text.trim());
  }

  /** Shared by both kinds once the chat is known to be idle: quiet time, no-reply
   *  count, fire, record. `send` performs the actual POST. */
  async function fireIfDue(t, s, convId, send, historyInterrupt) {
    var msgs = await getMessages(convId, 40);
    if (!msgs) return;
    var lastAny = msgs[msgs.length - 1];
    // The agent's last message dates its prompt cache: the cache was read for it, so it runs out
    // CACHE_TTL_MS later. Kept for the button's warmth ring and the tool's loop_status.
    var lastAt = lastAny ? (lastAny.created_at || 0) : 0;
    if (lastAt !== (s.lastAt || 0)) { s.lastAt = lastAt; save(t, s); }
    // Resting, and something happened since (you or its lead wrote, or it worked on its own): the
    // agent is warm again, so the Loop carries on after this turn.
    if (s.restingSince && lastAt > s.restingSince) {
      s.restingSince = 0; s.restKind = ''; s.nudgeLevel = 0; s.shortSince = 0; s.nextNudgeAt = 0;
      save(t, s);
    }
    // Solo chats show your messages in their history, including ones sent from another window.
    if (historyInterrupt && stopInHistory(t, s, msgs)) return;
    if (Date.now() - (s.lastFired || 0) < MIN_FIRE_GAP_MS) return;
    if (hasDraft(t)) { why(t, s, 'Holding: you have an unsent draft in this box.'); return; }
    if (lastAny && Date.now() - lastAt < QUIET_MS) { why(t, s, 'Waiting for the chat to go quiet.'); return; }

    // Your own messages keep the loop on (until 2026-09-24 they switched it off, so no team
    // loop ever got to fire). If you spoke since its last nudge, it gives the reply a minute of
    // quiet first. Team pages see your sends through the send button (userSentAt); a solo
    // chat's history shows them too. Hidden messages are app-injected, not typed.
    var userAt = s.userSentAt || 0;
    if (historyInterrupt) {
      var rights = msgs.filter(function (m) { return m.position === 'right' && !m.hidden; });
      var lastUser = rights[rights.length - 1];
      if (lastUser && msgText(lastUser) !== (s.lastFiredText || s.msg)) userAt = Math.max(userAt, lastUser.created_at || 0);
    }
    if (userAt > (s.lastFired || 0)) {
      var quietFrom = Math.max(userAt, lastAny ? (lastAny.created_at || 0) : 0);
      if (Date.now() - quietFrom < QUIET_AFTER_USER_MS) { why(t, s, 'Waiting a minute after your message.'); return; }
    }

    var lefts = msgs.filter(function (m) { return m.position === 'left'; });
    // The account is out of usage: nothing sent now can be answered, and each nudge only draws another "limit reached".
    // The usage tap records which window is rejected and when it resets; wait for that, then resume the agent once.
    // K, 2026-10-01: "the loops don't seem to recognize limits being hit, so it just sits there and prompts the
    // 'limit reached' messages".
    var lim = accountLimit(convId);
    if (lim) {
      if (s.limitUntil !== lim.until) { s.limitUntil = lim.until; s.limitDone = 0; save(t, s); }
      why(t, s, 'Paused: your Claude account is at its ' + lim.name + ' limit. The Loop carries on at ' + hhmm(lim.until + LIMIT_MARGIN_MS) + ', when it resets.');
      return;
    }
    if (s.limitUntil) { s.limitDone = s.limitUntil; s.limitUntil = 0; save(t, s); }
    var limitResume = !!s.limitDone && (s.lastFired || 0) < s.limitDone;
    // A resume time (see RESUME_WARM_MAX_MS): due now, or still ahead.
    var wake = s.wakeAt || 0;
    var wakeDue = !!wake && Date.now() >= wake;
    var holding = !!wake && !wakeDue;
    // Solo only: the last turn failed. Wait on the retry schedule instead of re-sending every
    // minute into a provider limit; each failed retry adds an error, so it never reads as a stall.
    var err = historyInterrupt ? lastError(msgs) : null;
    // An error that reported the limit which has since reset is over; the resume nudge below answers it.
    if (err && s.limitDone && err.at <= s.limitDone + LIMIT_MARGIN_MS) err = null;
    if (err) {
      var n = s.errAttempts || 0;
      if (n >= RETRY_MAX) {
        if (!s.forever) { save(t, s); setOn(t, false, 'still failing after ' + RETRY_MAX + ' tries'); return; }
        n = RETRY_MAX - 1;   // until the user stops it: it keeps trying, at the longest wait
      }
      // A stated reset counts from the newest failure; otherwise from the last retry.
      s.nextRetryAt = ((n === 0 || statedResetMs(err.text, err.at)) ? err.at : (s.lastFired || err.at)) + retryWaitMs(n, err);
      save(t, s);
      if (Date.now() < s.nextRetryAt) {
        why(t, s, 'The last turn failed. Retry ' + (n + 1) + ' of ' + RETRY_MAX + ' at ' + hhmm(s.nextRetryAt) + '.');
        return;
      }
      s.errAttempts = n + 1;
      s.stalls = 0;
    } else {
      s.errAttempts = 0;
      s.nextRetryAt = 0;
      // What the agent did after the last nudge, by timestamp. (This used to compare left-side
      // message counts, which saturate in a 40-message window and can misread a busy agent as
      // one that never replied.)
      var since = s.lastFired ? lefts.filter(function (m) { return (m.created_at || 0) > s.lastFired; }) : [];
      // Score each nudge once. A short turn with next to no tool calls means the agent had
      // nothing to do (waiting on a long job, say). A real stretch of work resets it.
      if (s.lastFired && since.length && s.nudgeScored !== s.fires) {
        var turnMs = (since[since.length - 1].created_at || 0) - s.lastFired;
        var tools = since.filter(function (m) { return m.type === 'acp_tool_call'; }).length;
        if (turnMs < SHORT_TURN_MS && tools < SHORT_TURN_TOOL_RECORDS) {
          s.nudgeLevel = Math.min((s.nudgeLevel || 0) + 1, NUDGE_WAITS_MS.length);
          if (!s.shortSince) s.shortSince = s.lastFired;
        } else {
          s.nudgeLevel = 0;
          s.shortSince = 0;
        }
        s.nudgeScored = s.fires;
      }
      var now = Date.now();
      if (wakeDue || limitResume) {
        // The resume time, or the limit that paused the Loop has reset: this nudge goes whatever the rest, the
        // backoff or the cache say. An agent a limit stopped has to be told to carry on.
        s.stalls = 0;
      } else {
        if (s.restingSince) { save(t, s); why(t, s, restText(s)); return; }
        // Never wake a cold agent: that nudge would pay to write its whole context again. Unless the
        // Loop was switched on after the cache had already run out and has not nudged since: then
        // someone asked for exactly that.
        var coldAt = lastAt + CACHE_TTL_MS;
        var wakeAsked = s.onAt && s.onAt >= lastAt + WARM_LATEST_MS && !((s.lastFired || 0) > s.onAt);
        // Until the user stops it: never rests, so a cold agent is woken too.
        if (lastAt && now > lastAt + WARM_LATEST_MS && !wakeAsked && !s.forever) { rest(t, s, 'cold', coldAt); return; }
        // A resume time far off: one reload then costs less than keeping the cache warm until it.
        if (holding && wake - now > RESUME_WARM_MAX_MS) { rest(t, s, 'resume', coldAt); return; }
        // Nothing to do for the whole hold: stop keeping the cache warm. A near resume time keeps it warm
        // to the end instead.
        if (!holding && !s.forever && s.nudgeLevel && s.shortSince && now - s.shortSince >= holdMinutes(s) * 60000) { rest(t, s, 'hold', coldAt); return; }
        // Short replies: the next nudge 2, then 4 minutes after the agent's last message, inside the window.
        // Holding for a resume time: 4 minutes each time.
        s.nextNudgeAt = holding ? lastAt + NUDGE_WAITS_MS[NUDGE_WAITS_MS.length - 1]
                                : s.nudgeLevel ? lastAt + NUDGE_WAITS_MS[s.nudgeLevel - 1] : 0;
        if (now < s.nextNudgeAt) {
          save(t, s);
          why(t, s, (holding ? 'Holding until ' + hhmm(wake) + ', the resume time. The next keep-warm nudge goes at '
                             : 'Nothing to do after the last nudge. The next goes at ') + hhmm(s.nextNudgeAt) +
            ', while its cache is still warm (until ' + hhmm(coldAt) + ').');
          return;
        }
        if (s.lastFired && !since.length) {
          s.stalls = (s.stalls || 0) + 1;
          if (s.stalls >= STALL_LIMIT) {
            save(t, s);
            if (s.forever) {
              why(t, s, 'Paused: no reply to the last ' + STALL_LIMIT + ' nudges. It carries on when the agent answers, and stays on until you stop it.');
              return;
            }
            setOn(t, false, 'no reply after ' + STALL_LIMIT + ' sends');
            return;
          }
        } else {
          s.stalls = 0;
        }
      }
    }
    // Persist the count now. State is re-read after the send below (to pick up a message
    // edited in the menu meanwhile), and an unsaved count would be lost there, which is
    // how the previous build's "3 sends with no reply" safety could never trip.
    save(t, s);

    // Marked as the Loop's (2026-09-25): an unmarked nudge reads exactly like the user's own message.
    // A team's agent logged the 07:00 nudge as K's instruction while K was asleep, and its
    // lead switched the Loop off over it. Resume notes already carry "[Loop]".
    var text = LOOP_TAG + (wakeDue ? resumeText(s, wake) : limitResume ? limitResumeText(s) : holding ? holdingText(s, wake) : s.msg) + usageNote(convId);
    var fr = await send(text);
    if (fr.status === 401 || fr.status === 403 || fr.status === 404) { setOn(t, false, 'send failed (' + fr.status + ')'); return; }
    if (!fr.ok) return; // transient; the next tick retries

    s = state(t); // re-read: the menu may have changed the message meanwhile
    s.lastFired = Date.now();
    s.lastFiredText = text;
    s.leftCountAtFire = lefts.length;
    s.fires = (s.fires || 0) + 1;
    if (limitResume) { s.limitDone = 0; s.nudgeLevel = 0; s.shortSince = 0; s.restingSince = 0; s.restKind = ''; }
    var woke = wakeDue && (s.wakeAt || 0) === wake;
    if (woke) {
      // Once only; the Loop carries on as it was, from a clean slate.
      s.wokeAt = s.lastFired; s.wakeAt = 0; s.wakeMsg = ''; s.wakeBy = ''; s.wakeSelf = false;
      s.restingSince = 0; s.restKind = ''; s.nudgeLevel = 0; s.shortSince = 0;
      s.why = 'Sent the resume nudge at ' + hhmm(s.lastFired) + ', the time set.';
    } else {
      s.why = 'Sent a nudge at ' + hhmm(s.lastFired) + '.';
    }
    s.whyAt = s.lastFired;
    save(t, s);
    if (woke) { pushShared(t, 'loop', 'resumed at ' + hhmm(s.lastFired) + ', the time set'); publishStatus(t); }
    render();
  }

  /** "the resume time you set" (the agent set its own), "the resume time Team Lead set", "... the user set". */
  function resumeWho(s) {
    return s.wakeSelf ? 'you set' : s.wakeBy === 'the user' ? 'the user set' : s.wakeBy ? s.wakeBy + ' set' : 'set';
  }
  function resumeText(s, wake) {
    var now = Date.now();
    var late = now - wake > 2 * 60000;
    return 'It is ' + hhmm(now) + (late ? '; the resume time ' + resumeWho(s) + ' was ' + hhmm(wake) + '. '
                                        : ', the resume time ' + resumeWho(s) + '. ') + (s.wakeMsg || s.msg);
  }
  function limitResumeText(s) {
    return "Your Claude account's usage limit has reset (it is " + hhmm(Date.now()) + '). The limit may have cut your last turn off: ' +
      'check your queue file and last notes, then carry on. ' + s.msg;
  }
  function holdingText(s, wake) {
    return 'Holding until ' + hhmm(wake) + ', the resume time ' + resumeWho(s) + '. Nothing to do before then: ' +
      'reply in a word. This message only keeps your prompt cache warm.';
  }

  async function tickConv(t, s) {
    var g = await getJson('/api/conversations/' + t.convId);
    if (g.err === 401 || g.err === 403 || g.err === 404) {
      if (s.on) setOn(t, false, 'status check failed (' + g.err + ')');
      return;
    }
    if (g.data && g.data.runtime) convMidturn[t.convId] = !!g.data.runtime.supports_midturn_delivery;
    if (convBusy(g.data)) { if (s.on) why(t, s, 'Not sending: it is working.'); return; }

    if (compactPending(s)) {
      await sendCompact(t, t.convId, function (text) {
        return postJson('/api/conversations/' + t.convId + '/messages', { content: text });
      });
      return;
    }

    // Legacy queue from the first version of this patch. Drain it, one per tick.
    if (s.queue.length) {
      var q = s.queue.shift(); save(t, s);
      var qr = await postJson('/api/conversations/' + t.convId + '/messages', { content: q });
      if (!qr.ok) { s.queue.unshift(q); save(t, s); }
      render();
      return;
    }
    if (!s.on) return;
    await fireIfDue(t, s, t.convId, function (text) {
      return postJson('/api/conversations/' + t.convId + '/messages', { content: text }).then(async function (r) {
        if (!r.ok && r.status !== 401 && r.status !== 403 && r.status !== 404) {
          // runtime may be suspended; wake it so the next tick can send. Straight to the backend: the page's
          // own calls to this route are held while a chat's agent is not running (see holdStart).
          try {
            await nativeFetch.call(window, apiUrl('/api/conversations/' + t.convId + '/runtime/ensure'), {
              method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf() }, body: '{}' });
          } catch (e) {}
        }
        return r;
      });
    }, true);
  }

  async function tickTeam(t, s) {
    var compact = compactPending(s);
    if (!s.on && !compact) return;
    var rs = await getJson('/api/teams/' + t.teamId + '/run-state');
    if (rs.err === 401 || rs.err === 403 || rs.err === 404) { if (s.on) setOn(t, false, 'team status check failed (' + rs.err + ')'); return; }
    if (rs.err || !rs.data) return;
    // A team with no session (every team after an AionUi restart) is not started by the Loop.
    // K, 2026-09-25: "opening a team chat still immediately starts the team": the Loop's nudge
    // was the send that started it (any send runs ensure_session_inner, which also drains the
    // lead's mailbox; see P-011). The team starts when someone sends it a message, and the Loop
    // carries on from there.
    if (rs.data.session_generation == null) {
      why(t, s, 'Waiting: the team is not started. It starts when you send it a message.');
      return;
    }
    var work = null;
    var list = rs.data.slot_work || [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].slot_id === t.slotId) { work = list[i]; break; }

    var mc = await memberConversation(t);
    if (mc.err === 401 || mc.err === 403 || mc.err === 404) { if (s.on) setOn(t, false, 'team lookup failed (' + mc.err + ')'); return; }
    if (mc.gone) { if (s.on) setOn(t, false, 'this member is no longer in the team'); return; }
    if (!mc.convId) return;

    if (work && work.state === 'paused') {
      if (s.on) await resumeIfDue(t, s, work, list, mc.convId, mc.backend);
      return;
    }
    // Out of the pause: forget it once the member has stayed unpaused for 3 minutes after the
    // last resume. A resume into a live limit re-pauses within seconds, and the schedule must
    // keep backing off through that rather than restart at 20 minutes.
    if (s.pausedSeen && Date.now() - (s.lastResumeAt || 0) > 180000) {
      s.pausedSeen = 0; s.resumeAttempts = 0; s.nextRetryAt = 0; save(t, s);
    }

    if (work) {
      if (work.state === 'running' || work.state === 'starting') { why(t, s, 'Not sending: it is working.'); return; }
      if (work.blocked_reason) { why(t, s, 'Not sending: blocked (' + work.blocked_reason + ').'); return; }
      var queued = (work.queued_foreground_count || 0) + (work.queued_background_count || 0);
      if (queued > 0) { why(t, s, 'Not sending: it has ' + queued + ' queued item' + (queued === 1 ? '' : 's') + '.'); return; }
      if (work.state !== 'idle') { why(t, s, 'Not sending: it is ' + work.state + '.'); return; }
    } else {
      // No work record yet for this member: fall back to its conversation status.
      var g = await getJson('/api/conversations/' + mc.convId);
      if (g.err || !g.data || convBusy(g.data)) { why(t, s, 'Not sending: it is working.'); return; }
    }
    // A compaction asked for from the menu or by an agent goes first, and is not held to the
    // 2-minute team spacing: someone asked for it, and it is one short turn.
    var lane = sendLane(t, mc.backend);
    if (compact) {
      await sendCompact(t, mc.convId, function (text) {
        markTeamSend(lane, Date.now());
        return postJson('/api/teams/' + t.teamId + '/agents/' + encodeURIComponent(t.slotId) + '/messages', { content: text });
      });
      return;
    }
    if (!s.on) return;
    // Spacing between nudges within a team. After an AionUi restart every member comes back idle at
    // once, and firing Devin members together is the burst that trips Devin's one-minute limit, so
    // they go 2 minutes apart. Claude members have no such limit, and 2 minutes behind two others
    // is past their cache window, so they go 20 s apart.
    var gap = sendGap(mc.backend);
    if (Date.now() - lastTeamSend(lane) < gap) {
      why(t, s, 'Waiting: another member of this team was nudged under ' + (gap >= 60000 ? gap / 60000 + ' minutes' : gap / 1000 + ' s') + ' ago.');
      return;
    }

    await fireIfDue(t, s, mc.convId, function (text) {
      markTeamSend(lane, Date.now());
      return postJson('/api/teams/' + t.teamId + '/agents/' + encodeURIComponent(t.slotId) + '/messages', { content: text });
    }, false);
  }
  /** The team page marks the lead's column data-role="leader"; run-state says "lead". */
  function isLeadRole(r) { return r === 'lead' || r === 'leader'; }
  function sendLane(t, backend) { return t.teamId + (backend === 'claude' ? '.claude' : ''); }
  function sendGap(backend) { return backend === 'claude' ? CLAUDE_SEND_GAP_MS : TEAM_SEND_GAP_MS; }

  /** A paused team member: resume it on the retry schedule (see the header). */
  async function resumeIfDue(t, s, work, slotList, convId, backend) {
    var lane = sendLane(t, backend);
    var now = Date.now();
    if (!s.pausedSeen) { s.pausedSeen = now; s.resumeAttempts = 0; }
    var n = s.resumeAttempts || 0;
    if (n >= RETRY_MAX) {
      if (!s.forever) { save(t, s); setOn(t, false, 'still paused after ' + RETRY_MAX + ' resume tries'); return; }
      n = RETRY_MAX - 1;   // until the user stops it: it keeps trying, at the longest wait
    }
    var msgs = await getMessages(convId, 20);
    var err = msgs ? lastError(msgs) : null;
    // A stated reset counts from the newest failure (a failed resume leaves a fresh one);
    // otherwise from the pause, then from the last resume.
    var since = (err && statedResetMs(err.text))
      ? Math.max(err.at, n > 0 ? (s.lastResumeAt || 0) : 0)
      : (n === 0 ? (err ? err.at : s.pausedSeen) : (s.lastResumeAt || s.pausedSeen));
    s.nextRetryAt = since + retryWaitMs(n, err);
    save(t, s);
    if (now < s.nextRetryAt) {
      why(t, s, 'Paused by the team runtime, usually a provider limit. Retry ' + (n + 1) + ' of ' + RETRY_MAX + ' at ' + hhmm(s.nextRetryAt) + '.');
      return;
    }
    if (now - lastTeamSend(lane) < sendGap(backend)) {
      why(t, s, 'Paused. Waiting: another member of this team was nudged moments ago.');
      return;
    }
    if (hasDraft(t)) { why(t, s, 'Paused. Holding: you have an unsent draft in this box.'); return; }
    // The lead goes last, so it wakes to teammates that are already running.
    if (work.role === 'lead') {
      for (var i = 0; i < slotList.length; i++) {
        var w = slotList[i];
        if (w && w.slot_id !== t.slotId && w.role !== 'lead' && w.state === 'paused' &&
            state({ kind: 'team', teamId: t.teamId, slotId: w.slot_id }).on) {
          why(t, s, 'Paused. Waiting for its teammates to be resumed first.');
          return;
        }
      }
    }
    markTeamSend(lane, now);
    var text = (work.role === 'lead' ? RESUME_NOTE_LEAD : RESUME_NOTE_MEMBER) + '\n\n' + s.msg;
    var r = await postJson('/api/teams/' + t.teamId + '/agents/' + encodeURIComponent(t.slotId) + '/messages', { content: text });
    if (r.status === 401 || r.status === 403 || r.status === 404) { setOn(t, false, 'resume failed (' + r.status + ')'); return; }
    if (!r.ok) return;
    s = state(t);
    s.resumeAttempts = n + 1;
    s.lastResumeAt = now;
    s.resumes = (s.resumes || 0) + 1;
    s.why = 'Sent a resume at ' + hhmm(now) + '.';
    s.whyAt = now;
    save(t, s);
    render();
  }

  var ticking = false;
  async function tick() {
    if (disabled() || ticking) return;
    ticking = true;
    try { await tickAll(); } finally { ticking = false; }
  }
  async function tickAll() {
    await pullShared();
    // On-screen targets first (they carry a pill), then every saved one not already listed.
    var list = targets();
    var seen = {};
    for (var j = 0; j < list.length; j++) seen[list[j].key] = true;
    var stored = storedTargets();
    for (var k = 0; k < stored.length; k++) if (!seen[stored[k].key]) { seen[stored[k].key] = true; list.push(stored[k]); }
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      var s = state(t);
      if (!s.on && !(t.kind === 'conv' && s.queue.length) && !compactPending(s)) continue;
      try {
        await tickOne(t, s);
      } catch (e) {
        console.log('[dx] tick error ' + t.key, e);
      }
    }
    beat();
  }

  async function tickOne(t, s) {
    if (t.kind === 'conv') await tickConv(t, s || state(t)); else await tickTeam(t, s || state(t));
    publishStatus(t);
  }

  // ---------------------------------------------------------------- the user sending

  /** You pressed send in a box that has a loop. The loop stays on: it forgets any backoff and
   *  gives the reply a minute of quiet before its next nudge. Until 2026-09-24 this switched the
   *  loop off, and since K talks to his agents all the time, no team loop ever got to fire
   *  (every saved team loop read "Off: you sent a message", 0 sends). Off is now only the
   *  menu's choice, or 3 sends with no reply. */
  function userSent(node, text) {
    var t = targetOf(node);
    if (!t) return;
    // AionUi empties the box through React, which fires no input event: forget the saved copies of the
    // sent text once the box is empty, so it is not offered back after a restart.
    var scope = draftScope(t);
    setTimeout(function () {
      try {
        var box = draftBox(t) || (node.closest && node.closest('.sendbox-panel') && node.closest('.sendbox-panel').querySelector('textarea'));
        if (!box || !(box.value || '').trim()) saveDraft(scope, '', true);
      } catch (e) {}
    }, 1200);
    applyUserSent(t, text);
  }
  /** What a message from you does to the Loops, whether you pressed send or a scheduled send went out. */
  function applyUserSent(t, text) {
    // Any request for a Loop off, this one's or a teammate's: the Loop tool may act on it for a Loop that runs until you stop it.
    if (text && asksLoopOff(text)) putLoopAsk(t, text);
    // "Turn off your loop" (2026-09-26): that chat's or member's Loop only, whatever its mode.
    if (text && saysLoopOff(text)) {
      if (state(t).on) {
        setOn(t, false, 'you said "' + quoteOf(text) + '"', true);
        notify(t, 'Loop off for {who}: you asked.', '"' + quoteOf(text) + '"');
      }
      return;
    }
    // You said stop. In a team, to the lead: every Loop of the team; to a member: that member's.
    if (text && saysStop(text)) {
      if (t.kind === 'team' && !isLeadRole(t.role)) {
        if (state(t).on) {
          setOn(t, false, 'you said "' + quoteOf(text) + '"', true);
          notify(t, 'Loop off for {who}: you said stop.', '"' + quoteOf(text) + '"');
        }
      } else {
        stopLoopsFor(t, text);
      }
      return;
    }
    var s = state(t);
    if (!s.on) return;
    s.userSentAt = Date.now();
    s.nudgeLevel = 0; s.nextNudgeAt = 0; s.stalls = 0; s.shortSince = 0;
    s.restingSince = 0; s.restKind = '';
    s.why = 'Waiting a minute after your message.';
    s.whyAt = s.userSentAt;
    save(t, s);
    render();
  }
  /** The text in the message box a send button or key press belongs to. */
  function composerText(node) {
    var el = node;
    for (var i = 0; el && i < 10; i++, el = el.parentElement) {
      var box = el.querySelector && el.querySelector('[data-testid="sendbox-input"]');
      if (!box) continue;
      var input = /^(TEXTAREA|INPUT)$/.test(box.tagName) ? box : box.querySelector('textarea, input');
      return input ? input.value : (box.isContentEditable ? box.textContent : '');
    }
    return '';
  }
  /** The message box a send button or key press belongs to (the textarea), for /plugin. */
  function composerInput(node) {
    var el = node;
    for (var i = 0; el && i < 10; i++, el = el.parentElement) {
      var box = el.querySelector && el.querySelector('[data-testid="sendbox-input"]');
      if (!box) continue;
      return /^(TEXTAREA|INPUT)$/.test(box.tagName) ? box : box.querySelector('textarea, input');
    }
    return null;
  }
  /** "/plugin" or "/plugins" (with or without a command after it) opens the Plugins panel instead of going to the agent. */
  function takePluginCommand(ev, input, text) {
    if (!isPluginCommand(text)) return false;
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
    if (input) setComposerValue(input, '');
    openPlugins(pluginArgs(text));
    return true;
  }
  var composingNow = false;
  function watchSends() {
    document.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('[data-testid="sendbox-send-btn"]') : null;
      if (b && !b.disabled && takePluginCommand(ev, composerInput(b), composerText(b))) return;
      if (b && !b.disabled) userSent(b, composerText(b));
    }, true);
    // AionUi's draft-queue button (and Ctrl+Enter, below) keep a message to send later: "/plugin" opens the panel instead.
    document.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('[data-testid="sendbox-add-to-draft-btn"]') : null;
      if (b && !b.disabled) takePluginCommand(ev, composerInput(b), composerText(b));
    }, true);
    // A composition under way (an input method's Enter commits it and sends nothing), tracked the way AionUi's own
    // message box tracks it. Windows text input can report a plain Enter as keyCode 229 with no composition, and
    // AionUi sends on it, so keyCode 229 alone no longer stops these checks.
    document.addEventListener('compositionstart', function () { composingNow = true; }, true);
    document.addEventListener('compositionend', function () { composingNow = false; }, true);
    // The agent's Stop button (K, 2026-09-26: "until i stop it or stop the agent (the stop button)"): that chat's or
    // member's Loop goes off, whatever its mode, so it does not start the agent again straight after.
    document.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('.sendbox-stop-button') : null;
      if (!b || b.disabled || disabled()) return;
      var t = targetOf(b);
      if (!t || !state(t).on) return;
      setOn(t, false, 'you pressed Stop', true);
      notify(t, 'Loop off for {who}: you pressed Stop.', '');
    }, true);
    document.addEventListener('keydown', function (ev) {
      var enter = ev.key === 'Enter' || ev.code === 'Enter' || ev.code === 'NumpadEnter' || ev.keyCode === 13;
      if (!enter || ev.shiftKey || ev.altKey || ev.isComposing || composingNow) return;
      var el = ev.target;
      var box = el && el.closest ? el.closest('[data-testid="sendbox-input"]') : null;
      if (!box) return;
      var val = (el.value !== undefined ? el.value : (el.isContentEditable ? el.textContent : '')) || '';
      // Before the slash menu's own Enter (it would pick /reload-plugins, the nearest match AionUi offers), and on
      // Ctrl+Enter, which AionUi puts in its draft queue instead of sending.
      if (takePluginCommand(ev, /^(TEXTAREA|INPUT)$/.test(el.tagName) ? el : null, val)) return;
      if (ev.ctrlKey || ev.metaKey) return;
      var panel = box.closest('.sendbox-panel');
      if (panel && panel.classList.contains('overflow-visible')) return;   // a slash or @ menu is open
      if (val.trim()) userSent(el, val);
    }, true);
  }


  // ---------------------------------------------------------------- Claude Code plugins, /plugin (build 2026-09-26.6)

  // A tester, through K, 2026-09-26: "we don't have plugin access here and we need it", then "it seems we should
  // definitely implement /plugins". AionUi's Claude chats offer /reload-plugins but not Claude Code's /plugin browser.
  // "/plugin" or "/plugins" typed in any message box opens this panel instead: the plugins installed and the ones the
  // marketplaces offer, with Install, Enable or Disable, Update and Uninstall, and a marketplace to add. It runs Claude
  // Code's own "claude plugin ..." commands through the main process (window.aiondxPlugins, patch 0009), so what it
  // changes is the user's Claude Code setup, the same as the terminal's /plugin. "/plugin install x@y" and the like
  // run straight away.
  var plugins = { el: null, tab: 'installed', installed: [], available: [], markets: '', query: '', busy: false, pending: null };
  var PLUGIN_ROWS_MAX = 60;
  function isPluginCommand(text) { return /^\s*\/plugins?(?:\s|$)/i.test(String(text || '')); }
  function pluginArgs(text) { return String(text || '').trim().replace(/^\/plugins?\s*/i, '').split(/\s+/).filter(Boolean); }
  function pluginsBridge() { return window.aiondxPlugins && typeof window.aiondxPlugins.run === 'function' ? window.aiondxPlugins : null; }
  async function pluginRun(args) {
    var b = pluginsBridge();
    if (!b) return { ok: false, error: 'This needs the AionDX app.' };
    try { return (await b.run(args)) || { ok: false, error: 'no answer' }; } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }
  /** A command's result in a sentence: the --json line's message, else what it printed. */
  function pluginResult(r) {
    var out = String((r && r.out) || '').trim();
    var last = out.split(/\r?\n/).filter(Boolean).pop() || '';
    var j = null;
    try { j = JSON.parse(last); } catch (e) {}
    if (j && typeof j === 'object' && !Array.isArray(j)) return { ok: j.outcome === 'ok', text: String(j.message || j.error || j.outcome || ''), json: j };
    if (r && r.error) return { ok: false, text: r.error };
    var err = String((r && r.err) || '').trim();
    return { ok: !!(r && r.ok), text: (r && r.ok ? out || 'Done.' : err || out || 'It failed (exit ' + (r && r.code) + ').').slice(-700) };
  }
  function pluginName(id) { return String(id || '').split('@')[0]; }
  function pluginMarket(id) { var s = String(id || ''); var i = s.indexOf('@'); return i >= 0 ? s.slice(i + 1) : ''; }
  function pluginCount(n) { n = Number(n) || 0; return n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k installs' : n ? n + (n === 1 ? ' install' : ' installs') : ''; }

  async function loadPlugins() {
    var r = await pluginRun(['list', '--json', '--available']);
    var j = null;
    try { j = JSON.parse(String(r.out || '')); } catch (e) {}
    if (!j || !Array.isArray(j.installed)) return pluginResult(r).text || 'Claude Code did not list its plugins.';
    plugins.installed = j.installed;
    plugins.available = Array.isArray(j.available) ? j.available : [];
    var m = await pluginRun(['marketplace', 'list']);
    plugins.markets = m.ok ? String(m.out || '').replace(/[❯✔✖]/g, '').replace(/^\s*Configured marketplaces:\s*/i, '').trim() : '';
    return '';
  }

  function openPlugins(args) {
    if (!plugins.el) {
      plugins.el = document.createElement('div');
      plugins.el.className = 'aiondx-welcome-backdrop aiondx-plugins-backdrop';
      plugins.el.innerHTML =
        '<div class="aiondx-welcome aiondx-plugins" role="dialog" aria-modal="true" aria-labelledby="aiondx-plugins-title">' +
          '<button type="button" class="aiondx-plugins-close" aria-label="Close">×</button>' +
          '<h2 id="aiondx-plugins-title" class="aiondx-welcome-title">Claude Code plugins</h2>' +
          '<p class="aiondx-welcome-text">Plugins add skills, agents, commands, hooks and MCP servers to Claude Code. These are ' +
            'Claude Code’s own, kept in your Claude settings like the terminal’s /plugin. A new Claude chat loads ' +
            'what you install here; in a chat already open, type /reload-plugins.</p>' +
          '<div class="aiondx-plugins-bar">' +
            '<div class="aiondx-plugins-tabs" role="tablist">' +
              '<button type="button" role="tab" class="aiondx-plugins-tab" data-tab="installed"></button>' +
              '<button type="button" role="tab" class="aiondx-plugins-tab" data-tab="available"></button>' +
            '</div>' +
            '<input type="search" class="aiondx-plugins-search" placeholder="Search plugins" aria-label="Search plugins">' +
          '</div>' +
          '<div class="aiondx-welcome-status aiondx-plugins-status" aria-live="polite"></div>' +
          '<div class="aiondx-plugins-list" role="list"></div>' +
          '<div class="aiondx-welcome-label">Add a marketplace</div>' +
          '<div class="aiondx-plugins-add">' +
            '<input type="text" class="aiondx-plugins-source" placeholder="owner/repo, a git URL, or a folder" aria-label="Marketplace to add">' +
            '<button type="button" class="arco-btn arco-btn-secondary arco-btn-size-small aiondx-plugins-add-btn">Add</button>' +
          '</div>' +
          '<p class="aiondx-welcome-foot aiondx-plugins-markets"></p>' +
        '</div>';
      var box = plugins.el.firstChild;
      plugins.el.addEventListener('keydown', function (ev) { ev.stopPropagation(); if (ev.key === 'Escape') closePlugins(); });
      plugins.el.addEventListener('mousedown', function (ev) { if (ev.target === plugins.el) closePlugins(); });
      box.querySelector('.aiondx-plugins-close').addEventListener('click', closePlugins);
      [].forEach.call(box.querySelectorAll('.aiondx-plugins-tab'), function (b) {
        b.addEventListener('click', function () { plugins.tab = b.getAttribute('data-tab'); paintPlugins(); });
      });
      box.querySelector('.aiondx-plugins-search').addEventListener('input', function (ev) { plugins.query = ev.target.value; paintPlugins(); });
      var add = function () {
        var src = box.querySelector('.aiondx-plugins-source').value.trim();
        if (src) pluginAction(['marketplace', 'add', src], 'Adding the marketplace ' + src + '...', function () { box.querySelector('.aiondx-plugins-source').value = ''; });
      };
      box.querySelector('.aiondx-plugins-add-btn').addEventListener('click', add);
      box.querySelector('.aiondx-plugins-source').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') add(); });
      // Escape wherever the focus is: a button disabled while a command runs drops it to the page.
      document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && plugins.el && !plugins.el.hidden) closePlugins(); });
      document.body.appendChild(plugins.el);
    }
    plugins.el.hidden = false;
    paintPlugins();
    try { plugins.el.querySelector('.aiondx-plugins-search').focus(); } catch (e) {}
    if (!pluginsBridge()) {
      pluginStatus('This works in the AionDX app. In the browser (WebUI), ask a Claude agent to run "claude plugin install NAME@MARKETPLACE" for you.', true);
      return;
    }
    var cmd = pluginCommandFor(args || []);
    if (cmd) { pluginAction(cmd.args, cmd.doing); return; }
    if (args && args.length) pluginStatus('"/plugin ' + args.join(' ') + '" is not something this panel runs. It takes install, uninstall, enable, disable, update and marketplace add.', true);
    refreshPlugins(args && args.length ? null : 'Loading the plugins...');
  }
  function closePlugins() { if (plugins.el) plugins.el.hidden = true; }
  /** "/plugin install x@y", "/plugin marketplace add owner/repo" and the like, as a command to run. */
  function pluginCommandFor(args) {
    var verb = String(args[0] || '').toLowerCase();
    if (verb === 'i') verb = 'install';
    if (verb === 'remove') verb = 'uninstall';
    if (/^(install|uninstall|enable|disable|update)$/.test(verb) && args[1]) {
      return { args: [verb, args[1], '--json'], doing: verb.charAt(0).toUpperCase() + verb.slice(1).replace(/e$/, '') + 'ing ' + args[1] + '...' };
    }
    if (verb === 'marketplace' && String(args[1] || '').toLowerCase() === 'add' && args[2]) return { args: ['marketplace', 'add', args[2]], doing: 'Adding the marketplace ' + args[2] + '...' };
    if (verb === 'marketplace' && String(args[1] || '').toLowerCase() === 'update') return { args: ['marketplace', 'update'].concat(args[2] ? [args[2]] : []), doing: 'Updating the marketplaces...' };
    return null;
  }
  function pluginStatus(text, bad) {
    var el = plugins.el && plugins.el.querySelector('.aiondx-plugins-status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('aiondx-plugins-status--bad', !!bad);
  }
  async function refreshPlugins(saying) {
    if (saying) pluginStatus(saying);
    var problem = await loadPlugins();
    paintPlugins();
    if (problem) pluginStatus(problem, true);
    else if (saying) pluginStatus('');
  }
  /** Run one change, say how it went, and list again. A marketplace that installs by running its own command shows
   *  that command first; it runs only when you accept it (claude's --accept-command, with the hash it gave). */
  async function pluginAction(args, doing, after) {
    if (plugins.busy) return;
    plugins.busy = true;
    paintPlugins();
    pluginStatus(doing);
    var res = pluginResult(await pluginRun(args));
    var shown = res.json && res.json.shownCommand;
    plugins.busy = false;
    if (shown && shown.sha256 && !res.ok) {
      plugins.pending = { args: args.filter(function (a) { return a !== '--json'; }).concat(['--accept-command', String(shown.sha256), '--json']),
        command: String(shown.command || shown.text || shown.display || JSON.stringify(shown)), text: res.text };
      paintPlugins();
      pluginStatus('');
      return;
    }
    await loadPlugins();
    paintPlugins();
    var tail = res.ok && /^(install|enable|update)$/.test(args[0]) ? ' New Claude chats load it; in an open chat, type /reload-plugins.' : '';
    pluginStatus((res.text || (res.ok ? 'Done.' : 'It failed.')) + tail, !res.ok);
    if (res.ok && after) after();
  }

  function paintPlugins() {
    if (!plugins.el) return;
    var box = plugins.el.firstChild;
    var inst = plugins.installed || [];
    var have = {};
    inst.forEach(function (p) { have[p.id] = p; });
    var avail = (plugins.available || []).filter(function (p) { return !have[p.pluginId]; })
      .sort(function (a, b) { return (Number(b.installCount) || 0) - (Number(a.installCount) || 0); });
    [].forEach.call(box.querySelectorAll('.aiondx-plugins-tab'), function (b) {
      var tab = b.getAttribute('data-tab');
      b.textContent = tab === 'installed' ? 'Installed (' + inst.length + ')' : 'Available (' + avail.length + ')';
      b.setAttribute('aria-selected', tab === plugins.tab ? 'true' : 'false');
      b.classList.toggle('aiondx-plugins-tab--on', tab === plugins.tab);
    });
    var q = String(plugins.query || '').trim().toLowerCase();
    var descOf = {};
    (plugins.available || []).forEach(function (p) { descOf[p.pluginId] = p; });
    var rows = plugins.tab === 'installed'
      ? inst.map(function (p) { var a = descOf[p.id] || {}; return { id: p.id, name: pluginName(p.id), market: pluginMarket(p.id), desc: a.description || '', count: a.installCount, installed: p }; })
      : avail.map(function (p) { return { id: p.pluginId, name: p.name || pluginName(p.pluginId), market: p.marketplaceName || pluginMarket(p.pluginId), desc: p.description || '', count: p.installCount }; });
    if (q) rows = rows.filter(function (r) { return (r.name + ' ' + r.market + ' ' + r.desc).toLowerCase().indexOf(q) >= 0; });
    var list = box.querySelector('.aiondx-plugins-list');
    list.innerHTML = '';
    if (plugins.pending) {
      var pend = document.createElement('div');
      pend.className = 'aiondx-plugins-pending';
      pend.innerHTML = '<div class="aiondx-welcome-fact-title">This marketplace installs it by running a command</div>' +
        '<div class="aiondx-welcome-fact-desc"></div><code class="aiondx-welcome-code"></code>' +
        '<div class="aiondx-welcome-actions"><button type="button" class="arco-btn arco-btn-primary arco-btn-size-small aiondx-plugins-accept">Run it and install</button>' +
        '<button type="button" class="arco-btn arco-btn-text arco-btn-size-small aiondx-plugins-cancel">Cancel</button></div>';
      pend.querySelector('.aiondx-welcome-fact-desc').textContent = plugins.pending.text || 'Only accept a command you trust: it runs on this PC as you.';
      pend.querySelector('code').textContent = plugins.pending.command;
      pend.querySelector('.aiondx-plugins-accept').addEventListener('click', function () {
        var p = plugins.pending; plugins.pending = null; pluginAction(p.args, 'Installing...');
      });
      pend.querySelector('.aiondx-plugins-cancel').addEventListener('click', function () { plugins.pending = null; paintPlugins(); pluginStatus('Not installed.'); });
      list.appendChild(pend);
    }
    if (!rows.length) {
      var none = document.createElement('div');
      none.className = 'aiondx-plugins-empty';
      none.textContent = q ? 'No plugin matches "' + plugins.query.trim() + '".'
        : plugins.tab === 'installed' ? 'No plugins installed yet. The Available tab lists what the marketplaces offer.' : 'The marketplaces offer nothing more.';
      list.appendChild(none);
    }
    rows.slice(0, PLUGIN_ROWS_MAX).forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'aiondx-plugins-row';
      row.setAttribute('role', 'listitem');
      row.setAttribute('data-plugin', r.id);
      row.innerHTML = '<div class="aiondx-plugins-main"><div class="aiondx-plugins-name"></div><div class="aiondx-plugins-meta"></div>' +
        '<div class="aiondx-plugins-desc"></div></div><div class="aiondx-plugins-btns"></div>';
      row.querySelector('.aiondx-plugins-name').textContent = r.name;
      var meta = [r.market, pluginCount(r.count)];
      if (r.installed) meta.push(r.installed.enabled === false ? 'disabled' : 'enabled', r.installed.version ? 'version ' + String(r.installed.version).slice(0, 12) : '', r.installed.scope && r.installed.scope !== 'user' ? r.installed.scope + ' scope' : '');
      row.querySelector('.aiondx-plugins-meta').textContent = meta.filter(Boolean).join(' · ');
      row.querySelector('.aiondx-plugins-desc').textContent = r.desc;
      var btns = row.querySelector('.aiondx-plugins-btns');
      var btn = function (label, cls, args, doing) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'arco-btn arco-btn-size-mini ' + cls;
        b.textContent = label;
        b.disabled = plugins.busy;
        b.setAttribute('data-act', args[0]);
        b.addEventListener('click', function () { pluginAction(args, doing); });
        btns.appendChild(b);
      };
      if (!r.installed) btn('Install', 'arco-btn-primary', ['install', r.id, '--json'], 'Installing ' + r.name + '...');
      else {
        if (r.installed.enabled === false) btn('Enable', 'arco-btn-secondary', ['enable', r.id, '--json'], 'Enabling ' + r.name + '...');
        else btn('Disable', 'arco-btn-secondary', ['disable', r.id, '--json'], 'Disabling ' + r.name + '...');
        btn('Update', 'arco-btn-secondary', ['update', r.id, '--json'], 'Updating ' + r.name + '...');
        btn('Uninstall', 'arco-btn-text', ['uninstall', r.id, '--json'], 'Uninstalling ' + r.name + '...');
      }
      list.appendChild(row);
    });
    if (rows.length > PLUGIN_ROWS_MAX) {
      var more = document.createElement('div');
      more.className = 'aiondx-plugins-empty';
      more.textContent = (rows.length - PLUGIN_ROWS_MAX) + ' more. Search to narrow the list.';
      list.appendChild(more);
    }
    box.querySelector('.aiondx-plugins-markets').textContent = plugins.markets ? 'Marketplaces: ' + plugins.markets.replace(/\s*\n\s*/g, ' · ') : '';
    box.querySelector('.aiondx-plugins-add-btn').disabled = plugins.busy;
  }

  // ---------------------------------------------------------------- the chat's agent (build 2026-09-26.1)

  // K, 2026-09-25: "if possible, would like the ability to swap models and accounts in a given chat". Then,
  // 2026-09-26: "it seems you built it around my use case specifically. it needs to be omni-compatible. it
  // needs to draw on the same list of available agents (dynamically) as is shown on the 'new chat' screen",
  // and "the account box needs to be put to the left of the model type in the teams multi-lane view ...
  // reduce the account to the profile icon if necessary".
  // The list is the new-chat screen's own: GET /api/assistants, the enabled ones, in the order the user
  // gave them (assistants.enabledOrder). Research: ! LLM Files\Research\
  // 2026-09-26_agent-list-new-chat-and-global-instructions.md. What a pick does depends on the two agents:
  //   - a Claude chat to another Claude agent: switched in place. The choice goes in the settings store as
  //     aiondx.agent.conv.<conversation id> = {agent: <agent id>}. AionDX's Claude launcher (patch 0002)
  //     reads it and starts Claude with that agent's environment, which is what gives each Claude agent its
  //     own account, and carries the session's transcript over. The agent restarts between turns. Team
  //     columns too.
  //   - anything else: AionUi cannot move a chat to another kind of agent, so the pick opens a new chat with
  //     that agent in the same folder, this chat's messages in its message box to check and send. Solo
  //     chats only.
  // The control is a profile icon just left of AionUi's model picker, outside the picker's own narrow box;
  // a solo chat's carries a short name as well. The first version (build 2026-09-25.4) kept a list of two
  // accounts in aiondx.accounts and wrote aiondx.account.conv.<id>; the launcher still honours those, and
  // a pick here replaces one.
  var AGENT_PREFIX = 'aiondx.agent.conv.';
  var ACCOUNTS_KEY = 'aiondx.accounts';
  var ACCOUNT_PREFIX = 'aiondx.account.conv.';
  var CONV_INFO_MS = 5 * 60000;
  var AGENTS_MS = 5 * 60000;
  var agentList = { at: 0, tried: 0, all: [], loading: null };   // the new-chat screen's assistants, disabled ones too
  var agentOrder = [];       // assistants.enabledOrder
  var agentPrefs = {};       // conversation id -> agent id chosen for it
  var accountsRec = null;    // the first version's account list, to read its choices
  var accountPrefs = {};     // conversation id -> the first version's account name
  var convInfo = {};         // conversation id -> { at, backend, agentId, workspace, name }
  var convInfoLoading = {};
  var acctEls = {};          // target key -> control
  var acctMenu = null;       // the open menu

  function takeAccounts(data) {
    var rec = data[ACCOUNTS_KEY];
    accountsRec = rec && Array.isArray(rec.accounts) ? rec : null;
    var prefs = {}, legacy = {};
    Object.keys(data).forEach(function (k) {
      var v = data[k];
      if (k.indexOf(AGENT_PREFIX) === 0) {
        var a = typeof v === 'string' ? v : (v && v.agent);
        if (a) prefs[k.slice(AGENT_PREFIX.length)] = String(a);
      } else if (k.indexOf(ACCOUNT_PREFIX) === 0) {
        var n = typeof v === 'string' ? v : (v && v.account);
        if (n) legacy[k.slice(ACCOUNT_PREFIX.length)] = String(n);
      }
    });
    agentPrefs = prefs;
    accountPrefs = legacy;
    var ord = data['assistants.enabledOrder'];
    agentOrder = Array.isArray(ord) ? ord.map(String) : [];
  }

  function normAgent(a) {
    var ag = a.agent || {};
    return { id: String(a.id), name: String(a.name || a.id), avatar: String(a.avatar || ''), agentId: String(a.agent_id || ''),
      backend: String(ag.acp_backend || ag.type || a.backend || ''), type: String(ag.type || ''), source: String(a.source || ''),
      agentSource: String(ag.source || ''), status: String(a.agent_status || ''), enabled: a.enabled !== false,
      sort: Number(a.sort_order) || 0 };
  }
  /** The new-chat screen's list, sorted as it sorts it: your order first, then generated, user and
   *  built-in assistants, then sort_order. */
  function loadAgents(force) {
    if (agentList.loading) return agentList.loading;
    // Read at most every 5 minutes, or every 30 s while it has never answered (an older backend).
    if (!force && agentList.tried && Date.now() - agentList.tried < (agentList.at ? AGENTS_MS : 30000)) return Promise.resolve(agentList.all);
    agentList.tried = Date.now();
    agentList.loading = getJson('/api/assistants').then(function (g) {
      var raw = Array.isArray(g.data) ? g.data : (g.data && (g.data.assistants || g.data.items)) || null;
      if (raw) {
        var SRC = { generated: 0, user: 1, builtin: 2 };
        var rank = function (x) { var i = agentOrder.indexOf(x.id); return i < 0 ? 1e9 : i; };
        var src = function (x) { return SRC[x.source] != null ? SRC[x.source] : 3; };
        var list = raw.filter(function (a) { return a && a.id; }).map(normAgent);
        list.sort(function (x, y) {
          return (rank(x) - rank(y)) || (src(x) - src(y)) || (x.sort - y.sort) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
        });
        agentList.all = list;
        agentList.at = Date.now();
      }
      return agentList.all;
    }, function () { return agentList.all; }).then(function (l) { agentList.loading = null; schedule(); return l; });
    return agentList.loading;
  }
  function enabledAgents() { return agentList.all.filter(function (a) { return a.enabled; }); }
  /** An agent's name as the new-chat screen shows it: its generated assistant's, else any assistant on it. */
  function agentName(agentId) {
    var any = null;
    for (var i = 0; i < agentList.all.length; i++) {
      var a = agentList.all[i];
      if (a.agentId !== agentId) continue;
      if (a.source === 'generated') return a.name;
      any = any || a;
    }
    return any ? any.name : (agentId || 'its agent');
  }
  /** "Claude Code (Second)" -> "Work"; anything else as it is. */
  function shortAgentName(name) { var m = /\(([^()]+)\)\s*$/.exec(name || ''); return m ? m[1] : (name || '?'); }
  /** Claude agents a Claude chat can switch to in place: one entry per agent, its generated assistant's name. */
  function claudeAgents() {
    var seen = {}, out = [];
    enabledAgents().forEach(function (a) {
      if (a.backend !== 'claude' || !a.agentId || seen[a.agentId]) return;
      seen[a.agentId] = true;
      out.push({ agentId: a.agentId, name: agentName(a.agentId) });
    });
    return out;
  }
  /** The first version's pick, as an agent: the agent whose account it named. */
  function legacyAgent(convId) {
    var name = accountPrefs[convId];
    var map = accountsRec && accountsRec.agents;
    if (!name || !map) return null;
    for (var id in map) if (Object.prototype.hasOwnProperty.call(map, id) && map[id] === name) return id;
    return null;
  }
  /** The agent this chat runs on: {id, chosen} where chosen means picked here, not its own. */
  function chatAgent(convId, info) {
    var pick = agentPrefs[convId] || legacyAgent(convId);
    if (pick && info.backend === 'claude' && pick !== info.agentId) return { id: pick, chosen: true };
    return { id: info.agentId, chosen: false };
  }
  function uiLocale() {
    var l = String(navigator.language || '');
    return /^[a-z]{2}-[A-Z]{2}$/.test(l) ? l : 'en-US';
  }

  var convInfoFailed = {};   // conversation id -> when its last read failed
  function loadConvInfo(convId) {
    if (convInfoLoading[convId]) return;
    if (convInfoFailed[convId] && Date.now() - convInfoFailed[convId] < 30000) return;
    convInfoLoading[convId] = true;
    getJson('/api/conversations/' + convId).then(function (g) {
      if (g.err || !g.data) { convInfoFailed[convId] = Date.now(); return; }
      delete convInfoFailed[convId];
      if (!g.err && g.data) {
        var x = g.data.extra || {};
        convInfo[convId] = { at: Date.now(), backend: String(x.backend || (g.data.assistant && g.data.assistant.backend) || ''),
          agentId: String(x.agent_id || ''), workspace: String(x.workspace || ''), name: String(g.data.name || '') };
      }
    }, function () { convInfoFailed[convId] = Date.now(); }).then(function () {
      delete convInfoLoading[convId];
      if (!convInfoFailed[convId]) schedule();
    });
  }

  /** The box AionUi's model picker sits in: the picker, or the plain wrapper around it, so the control
   *  lands beside it in the header row. A team column wraps the picker in a 140 px box; inside that the
   *  control and the picker stacked (K, 2026-09-26: "it's cramming vertically and doesn't fit"). */
  var slotCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  function pickerSlot(sel) {
    var hit = slotCache && slotCache.get(sel);
    if (hit && hit.isConnected && (hit === sel || hit.contains(sel))) return hit;
    var found = pickerSlotOf(sel);
    if (slotCache) slotCache.set(sel, found);
    return found;
  }
  function pickerSlotOf(sel) {
    var el = sel;
    for (var i = 0; i < 3 && el.parentElement; i++) {
      var p = el.parentElement;
      if (p.children.length !== 1) break;
      var d = getComputedStyle(p).display;
      if (d.indexOf('flex') >= 0 || d.indexOf('grid') >= 0) break;
      el = p;
    }
    return el;
  }
  /** Each AionUi model picker on the page, with the chat it belongs to. */
  function acctTargets() {
    var r = route();
    if (!r || disabled()) return [];
    var out = [];
    var sels = document.querySelectorAll('[data-testid^="acp-model-selector"]');
    for (var i = 0; i < sels.length; i++) {
      var sel = sels[i];
      var col = sel.closest('[data-slot-id]');
      var t = null;
      if (r.kind === 'team' && col) {
        var slot = col.getAttribute('data-slot-id');
        t = { kind: 'team', key: 'team:' + r.id + ':' + slot, teamId: r.id, slotId: slot, role: col.getAttribute('data-role') || '' };
      } else if (r.kind === 'conv' && !col) {
        t = { kind: 'conv', key: 'conv:' + r.id, convId: r.id };
      }
      if (t) { t.anchor = pickerSlot(sel); out.push(t); }
    }
    return out;
  }

  function renderAccounts() {
    var live = {};
    var list = acctTargets();
    if (list.length) loadAgents(false);
    list.forEach(function (t) {
      var convId = t.kind === 'conv' ? t.convId : (teamCache[t.teamId] && teamCache[t.teamId].map[t.slotId]);
      if (!convId) { if (t.kind === 'team') memberConversation(t).then(function (r) { if (r && r.convId) schedule(); }, function () {}); return; }
      var info = convInfo[convId];
      if (!info || Date.now() - info.at > CONV_INFO_MS) loadConvInfo(convId);
      if (!info || !info.agentId || !agentList.at) return;
      // A team column offers only Claude-to-Claude switches; a solo chat always has new-chat picks.
      if (t.kind === 'team' && (info.backend !== 'claude' || claudeAgents().length < 2)) return;
      live[t.key] = true;
      var el = acctEls[t.key] || (acctEls[t.key] = buildAcctPill(t.key));
      el._t = t;
      el._convId = convId;
      el.classList.toggle('aiondx-acct--compact', t.kind === 'team');
      if (el.parentNode !== t.anchor.parentNode || el.nextSibling !== t.anchor) t.anchor.parentNode.insertBefore(el, t.anchor);
      paintAcct(el, t, convId, info);
      placeUsage(t, el, convId);
    });
    Object.keys(acctEls).forEach(function (k) {
      if (live[k]) return;
      var el = acctEls[k];
      if (el.parentNode) el.parentNode.removeChild(el);
      delete acctEls[k];
      dropUsage(k);
      if (acctMenu && acctMenu._key === k) closeAcctMenu();
    });
  }

  var ICON_USER = '<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><circle cx="24" cy="15" r="8" stroke="currentColor" stroke-width="4"/>' +
    '<path d="M8 42c0-8.8 7.2-15 16-15s16 6.2 16 15" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>';
  function buildAcctPill(key) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'arco-btn arco-btn-secondary arco-btn-size-small arco-btn-shape-round aiondx-acct';
    b.setAttribute('data-testid', 'aiondx-account');
    b.setAttribute('aria-haspopup', 'menu');
    b.innerHTML = '<span class="aiondx-acct-icon">' + ICON_USER + '</span><span class="aiondx-acct-label"></span>';
    b.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (acctMenu && acctMenu._key === key) closeAcctMenu(); else openAcctMenu(b);
    });
    return b;
  }
  function paintAcct(el, t, convId, info) {
    var cur = chatAgent(convId, info);
    var name = agentName(cur.id);
    var label = t.kind === 'team' ? '' : shortAgentName(name);
    var lab = el.querySelector('.aiondx-acct-label');
    if (lab.textContent !== label) lab.textContent = label;
    el.classList.toggle('aiondx-acct--chosen', cur.chosen);
    el.setAttribute('data-agent', cur.id);
    var aria = 'Agent: ' + name + (cur.chosen ? ', chosen for this chat (its own is ' + agentName(info.agentId) + ')' : '') +
      '. Click to switch this chat to another agent.';
    if (el.getAttribute('aria-label') !== aria) el.setAttribute('aria-label', aria);
  }

  function closeAcctMenu() {
    if (!acctMenu) return;
    document.removeEventListener('mousedown', onAcctOutside, true);
    if (acctMenu.parentNode) acctMenu.parentNode.removeChild(acctMenu);
    acctMenu = null;
  }
  function onAcctOutside(ev) {
    if (!acctMenu) return;
    var pill = acctEls[acctMenu._key];
    if (acctMenu.contains(ev.target) || (pill && pill.contains(ev.target))) return;
    closeAcctMenu();
  }
  /** Below the control (the model picker lives in headers), or above it when there is no room below. */
  function placeAcctMenu(pill) {
    if (!acctMenu || !pill) return;
    var r = pill.getBoundingClientRect();
    var w = acctMenu.offsetWidth || 300;
    var h = acctMenu.offsetHeight || 0;
    acctMenu.style.left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8) + 'px';
    var top = r.bottom + 6;
    if (top + h > window.innerHeight - 8 && r.top - 6 - h >= 8) top = r.top - 6 - h;
    acctMenu.style.top = Math.max(8, top) + 'px';
    acctMenu.style.bottom = 'auto';
  }
  function menuItem(title, desc, attr, value) {
    var it = document.createElement('div');
    it.className = 'arco-dropdown-menu-item';
    it.setAttribute('role', 'menuitemradio');
    it.setAttribute(attr, value);
    it.innerHTML = '<span class="aiondx-check" aria-hidden="true"></span><span><span class="aiondx-item-title"></span><span class="aiondx-item-desc"></span></span>';
    it.querySelector('.aiondx-item-title').textContent = title;
    it.querySelector('.aiondx-item-desc').textContent = desc;
    return it;
  }
  function openAcctMenu(pill) {
    closeAcctMenu();
    closeMenu();
    hideTip();
    closeSchedMenu();
    var t = pill._t, convId = pill._convId, info = convInfo[convId];
    if (!t || !convId || !info) return;
    loadAgents(true).then(function () { if (acctMenu && acctMenu._key === t.key && !acctMenu._confirming) fillAcctMenu(acctMenu, pill); });
    var m = document.createElement('div');
    m.className = 'aiondx-menu aiondx-acct-menu';
    m.setAttribute('role', 'menu');
    m._key = t.key;
    m.addEventListener('keydown', function (ev) { ev.stopPropagation(); if (ev.key === 'Escape') closeAcctMenu(); });
    document.body.appendChild(m);
    acctMenu = m;
    fillAcctMenu(m, pill);
    setTimeout(function () { document.addEventListener('mousedown', onAcctOutside, true); }, 0);
  }
  function fillAcctMenu(m, pill) {
    var t = pill._t, convId = pill._convId, info = convInfo[convId];
    var cur = chatAgent(convId, info);
    m.innerHTML = '<div class="arco-dropdown-menu"><div class="arco-dropdown-menu-group-title">Agent for this chat</div>' +
      '<div class="aiondx-acct-items" data-group="here"></div><div class="aiondx-acct-more"></div><div class="aiondx-note aiondx-acct-note"></div></div>';
    var here = m.querySelector('[data-group="here"]');
    var inPlace = info.backend === 'claude' ? claudeAgents() : [];
    if (!inPlace.some(function (a) { return a.agentId === cur.id; })) inPlace.unshift({ agentId: cur.id, name: agentName(cur.id) });
    inPlace.forEach(function (a) {
      var own = a.agentId === info.agentId;
      var it = menuItem(a.name, own ? "This chat's own agent" : 'Switches here; the chat carries on with its memory', 'data-agent', a.agentId);
      markCurrent(it, a.agentId === cur.id);
      it.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (a.agentId === cur.id) { closeAcctMenu(); return; }
        confirmAgent(m, t, convId, info, a);
      });
      here.appendChild(it);
    });
    var note = m.querySelector('.aiondx-acct-note');
    if (t.kind === 'conv') {
      var inPlaceIds = {};
      inPlace.forEach(function (a) { inPlaceIds[a.agentId] = true; });
      var others = enabledAgents().filter(function (a) {
        return !(a.source === 'generated' && inPlaceIds[a.agentId]) && !(a.agentId === info.agentId && a.source === 'generated');
      });
      if (others.length) {
        var more = m.querySelector('.aiondx-acct-more');
        more.innerHTML = '<div class="arco-dropdown-menu-group-title">Continue in a new chat with</div><div class="aiondx-acct-items" data-group="new"></div>';
        var box = more.querySelector('[data-group="new"]');
        others.forEach(function (a) {
          var it = menuItem(a.name, a.status === 'offline' || a.status === 'missing' ? 'Not available on this PC right now' : 'Same folder; this chat goes in its message box', 'data-assistant', a.id);
          it.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            confirmHandoff(m, t, convId, info, a);
          });
          box.appendChild(it);
        });
      }
      note.textContent = info.backend === 'claude'
        ? 'A switch here restarts the agent between turns on the other account. A new chat starts fresh with the conversation so far.'
        : 'A new chat starts fresh with the conversation so far; this chat stays as it is.';
    } else {
      note.textContent = 'The member restarts between turns and carries on with its memory of this chat, on the other account from its next turn.';
    }
    placeAcctMenu(pill);
  }
  /** The second step for a switch in place: what it means, then Move or Cancel. */
  function confirmAgent(m, t, convId, info, a) {
    m._confirming = true;
    var box = m.querySelector('.arco-dropdown-menu');
    box.innerHTML = '<div class="arco-dropdown-menu-group-title"></div><div class="aiondx-acct-confirm"><div class="aiondx-acct-warn"></div>' +
      '<div class="aiondx-acct-btns"><button type="button" class="arco-btn arco-btn-secondary arco-btn-size-small aiondx-acct-cancel">Cancel</button>' +
      '<button type="button" class="arco-btn arco-btn-primary arco-btn-size-small aiondx-acct-move">Move it</button></div></div>';
    box.querySelector('.arco-dropdown-menu-group-title').textContent = 'Move this chat to ' + a.name + '?';
    box.querySelector('.aiondx-acct-warn').textContent = 'Everything in this chat so far goes to that agent\'s account and its organization, ' +
      'and its next turn re-reads the whole chat there, uncached. The agent restarts now if it has stopped.';
    placeAcctMenu(acctEls[t.key]);   // taller now
    box.querySelector('.aiondx-acct-cancel').addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); closeAcctMenu(); });
    box.querySelector('.aiondx-acct-move').addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      closeAcctMenu();
      switchAgent(t, convId, info, a).catch(function (e) { console.log('[dx] agent switch error', e); });
    });
  }
  var pendingMoves = {};     // target key -> { t, convId, name, at }: restart once the agent is idle
  async function switchAgent(t, convId, info, a) {
    var live = agentLive[t.key];
    if (live && (live.state === 'working' || live.state === 'queued')) {
      notify(t, 'Not moved: {who} is working. Move it once it stops.', '');
      return;
    }
    var body = {};
    body[AGENT_PREFIX + convId] = a.agentId === info.agentId ? null : { agent: a.agentId, at: Date.now(), by: 'user' };
    body[ACCOUNT_PREFIX + convId] = null;   // the first version's pick gives way
    // Which account's usage the chat reads is the one it last ran on. A rejected window of the old account must not hold the
    // Loop back from a chat that has moved: a Loop paused for a limit sends nothing, and nothing else would write the new one.
    body[USAGE_CONV + convId] = null;
    delete usageConv[convId];
    var w = await putPrefs(body);
    if (!w || !w.ok) { notify(t, 'Not moved: the choice could not be saved.', ''); return; }
    if (body[AGENT_PREFIX + convId]) agentPrefs[convId] = a.agentId; else delete agentPrefs[convId];
    delete accountPrefs[convId];
    render();
    await restartForMove(t, convId, a.name);
  }
  /** The restart that makes a move take effect, only while the agent is between turns: a restart cancels
   *  whatever turn is running (a Loop nudge or a queued message may have started one since the menu opened). */
  async function restartForMove(t, convId, name) {
    if (await agentBusyNow(t, convId)) {
      pendingMoves[t.key] = { t: t, convId: convId, name: name, at: Date.now() };
      notify(t, 'Saved: ' + name + '. {who} is working; it moves as soon as this turn ends.', '');
      return;
    }
    delete pendingMoves[t.key];
    var r = t.kind === 'conv'
      ? await postJson('/api/conversations/' + convId + '/runtime/restart', {})
      : await postJson('/api/teams/' + t.teamId + '/agents/' + encodeURIComponent(t.slotId) + '/runtime/restart', {});
    if (r && r.ok) notify(t, 'Moved to ' + name + '. The agent restarted and carries on there.', '');
    else if (r && r.status === 409) {
      pendingMoves[t.key] = { t: t, convId: convId, name: name, at: Date.now() };
      notify(t, 'Saved: ' + name + '. {who} is busy; it moves as soon as it is free.', '');
    }
    else notify(t, 'Saved: ' + name + ' from its next start. The restart did not go through' + (r ? ' (' + r.status + ')' : '') + '; Reconnect agent restarts it.', '');
  }
  async function agentBusyNow(t, convId) {
    if (t.kind === 'conv') {
      var g = await getJson('/api/conversations/' + convId);
      return !g.data || convBusy(g.data);
    }
    var rs = await getJson('/api/teams/' + t.teamId + '/run-state');
    var ws = (rs.data && rs.data.slot_work) || [];
    for (var i = 0; i < ws.length; i++) {
      var w = ws[i];
      if (w && w.slot_id === t.slotId) return w.state === 'running' || w.state === 'starting' || !!w.active_turn_id;
    }
    return false;
  }
  /** Each pulse: a move waiting for its agent to finish is applied once it has (for up to an hour). */
  function applyPendingMoves() {
    Object.keys(pendingMoves).forEach(function (k) {
      var m = pendingMoves[k];
      if (Date.now() - m.at > 3600000) { delete pendingMoves[k]; return; }
      var live = agentLive[k];
      if (!live || live.state !== 'idle' || m.running) return;
      m.running = true;
      restartForMove(m.t, m.convId, m.name).catch(function () {}).then(function () { if (pendingMoves[k]) pendingMoves[k].running = false; });
    });
  }

  /** The second step for a new chat with another agent. */
  function confirmHandoff(m, t, convId, info, a) {
    m._confirming = true;
    var box = m.querySelector('.arco-dropdown-menu');
    box.innerHTML = '<div class="arco-dropdown-menu-group-title"></div><div class="aiondx-acct-confirm"><div class="aiondx-acct-warn"></div>' +
      '<div class="aiondx-acct-btns"><button type="button" class="arco-btn arco-btn-secondary arco-btn-size-small aiondx-acct-cancel">Cancel</button>' +
      '<button type="button" class="arco-btn arco-btn-primary arco-btn-size-small aiondx-acct-move">Start it</button></div></div>';
    box.querySelector('.arco-dropdown-menu-group-title').textContent = 'Continue with ' + a.name + '?';
    box.querySelector('.aiondx-acct-warn').textContent = 'A new chat with ' + a.name + ' opens in this chat\'s folder, with this conversation in its message box ' +
      'for you to check and send. This chat stays as it is.';
    placeAcctMenu(acctEls[t.key]);
    box.querySelector('.aiondx-acct-cancel').addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); closeAcctMenu(); });
    box.querySelector('.aiondx-acct-move').addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      closeAcctMenu();
      continueWith(t, convId, info, a).catch(function (e) { console.log('[dx] handoff error', e); notify(t, 'Could not start the new chat.', ''); });
    });
  }
  var HANDOFF_MAX_CHARS = 30000;
  /** This conversation as text for another agent: oldest first, the newest kept when it is long. */
  function handoffText(fromName, msgs, older) {
    var parts = [];
    (msgs || []).forEach(function (m) {
      if (!m || m.hidden || (m.type && m.type !== 'text')) return;
      var text = String(msgText(m) || '').trim();
      if (!text) return;
      parts.push((m.position === 'right' ? '[Me]' : '[' + fromName + ']') + '\n' + text);
    });
    var kept = [], size = 0, dropped = 0;
    for (var i = parts.length - 1; i >= 0; i--) {
      if (size + parts[i].length > HANDOFF_MAX_CHARS && kept.length) { dropped = i + 1; break; }
      kept.unshift(parts[i]);
      size += parts[i].length + 2;
    }
    return 'I am moving this conversation to you from ' + fromName + '. Here it is so far, oldest first' +
      (older ? ' (the chat is longer; its earliest part is left out)' : dropped ? ' (' + dropped + ' earlier messages left out)' : '') +
      '. Carry on from where it stops.\n\n' +
      '<conversation>\n' + kept.join('\n\n') + '\n</conversation>\n';
  }
  async function continueWith(t, convId, info, a) {
    var page = await getJson('/api/conversations/' + convId + '/messages?limit=200');
    var list = page.data ? (Array.isArray(page.data) ? page.data : (page.data.items || page.data.messages || [])) : [];
    var msgs = list.slice().sort(function (x, y) { return (x.created_at || 0) - (y.created_at || 0); });
    var older = !!(page.data && page.data.has_more_before);
    var fromName = agentName(chatAgent(convId, info).id);
    var text = handoffText(fromName, msgs, older);
    var id = await createChat(a, '', (info.name || 'Chat') + ' (' + a.name + ')', info.workspace);
    if (!id) { notify(t, 'Could not start a chat with ' + a.name + '.', ''); return; }
    // Its message box opens holding the conversation: the drafts' own restore fills it.
    try { localStorage.setItem(DRAFT_LS + 'conv.' + id, JSON.stringify({ text: text, at: Date.now() })); } catch (e) {}
    location.hash = '#/conversation/' + id;
  }

  /** The first assistant, enabled or not, that pred accepts. */
  async function findAgent(pred) {
    var list = await loadAgents(true);
    for (var i = 0; i < list.length; i++) if (pred(list[i])) return list[i];
    return null;
  }
  /** AionUi's own health check: installed and answering, or not checked yet. */
  function agentOnline(a) { return !!a && (a.status === 'online' || a.status === 'unchecked' || a.status === ''); }
  /** A new chat with an assistant, as the new-chat screen makes one: POST /api/conversations with the
   *  assistant, then the first message, if any. An empty folder gets AionUi's own temporary one. Returns
   *  the conversation id, or null. */
  async function createChat(a, firstMessage, name, workspace) {
    if (!a.enabled) await sendJson('PATCH', '/api/assistants/' + encodeURIComponent(a.id) + '/state', { enabled: true });
    var r = await sendJson('POST', '/api/conversations', {
      name: name || String(firstMessage || 'New chat').slice(0, 60),
      assistant: { id: a.id, locale: uiLocale() },
      extra: { workspace: workspace || '', custom_workspace: !!workspace }
    });
    if (!r.ok) { console.log('[dx] new chat refused', r.status); return null; }
    var c = unwrap(await r.json());
    var id = c && (c.id || c.conversation_id);
    if (!id) return null;
    if (firstMessage) {
      var mr = await postJson('/api/conversations/' + id + '/messages', { content: firstMessage, files: [] });
      if (!mr.ok) console.log('[dx] first message not sent', mr.status);
    }
    return id;
  }


  // ---------------------------------------------------------------- Claude usage meter (2026-09-26)

  // K: "i would like to see a usage meter, you can build this infrastructure to only show for claude ... We
  // should put the usage meter in a skinny bar at the top of the chat window, between the chat name and the
  // account + the model". AionDX's Claude launcher reads the chat's account windows from Anthropic's rate-limit
  // headers (patches\0002 claude-stream-proxy.js, startUsage) into aiondx.usage.acct.<key>, and which account a
  // chat runs on into aiondx.usage.conv.<conversation id>. Two thin bars, the 5-hour window over the week,
  // with their percentages, sit just left of the agent control; a team column gets the bars alone. A reading
  // older than 30 minutes is not shown.
  var USAGE_ACCT = 'aiondx.usage.acct.';
  var USAGE_CONV = 'aiondx.usage.conv.';
  var USAGE_STALE_MS = 30 * 60000;       // older than this the meter is dimmed, and its tooltip says how old it is
  var USAGE_HIDE_MS = 12 * 3600000;      // older than this it is not shown at all
  var usageAcct = {};        // key -> reading
  var usageConv = {};        // conversation id -> { acct, at }
  var usageEls = {};         // target key -> meter
  function takeUsage(data) {
    var a = {}, c = {};
    Object.keys(data).forEach(function (k) {
      var v = data[k];
      if (!v || typeof v !== 'object') return;
      if (k.indexOf(USAGE_ACCT) === 0) a[k.slice(USAGE_ACCT.length)] = v;
      else if (k.indexOf(USAGE_CONV) === 0) c[k.slice(USAGE_CONV.length)] = v;
    });
    usageAcct = a;
    usageConv = c;
  }
  /** The account reading for a chat, whatever its age: the limit pause needs a reset time even from an old reading. */
  function usageRecord(convId) {
    var c = usageConv[convId];
    var a = c && usageAcct[c.acct];
    return a && (a.five_hour || a.seven_day) ? a : null;
  }
  function usageOf(convId) {
    var a = usageRecord(convId);
    return a && Date.now() - (Number(a.at) || 0) <= USAGE_HIDE_MS ? a : null;
  }
  /** One window as it stands now. Past its reset time its usage is back to 0 until the next request opens a new window. */
  function windowNow(w) {
    if (!w || w.u === null || w.u === undefined) return null;
    var over = Number(w.reset) > 0 && Number(w.reset) * 1000 < Date.now();
    return { u: over ? 0 : Math.max(0, Number(w.u) || 0), reset: over ? 0 : Number(w.reset) || 0, status: over ? '' : w.status || '', over: over };
  }
  /** The window that has hit its limit and when it resets ({ name, until } in ms), or null. A rejected window stays rejected
   *  until its reset, so an old reading is as good as a new one here. */
  function accountLimit(convId) {
    var a = usageRecord(convId);
    if (!a) return null;
    var best = null;
    [['5-hour', a.five_hour], ['weekly', a.seven_day]].forEach(function (p) {
      var w = p[1];
      if (!w || !(Number(w.reset) > 0)) return;
      var rejected = w.status === 'rejected' || (a.status === 'rejected' && !(a.five_hour && a.five_hour.status === 'rejected') && !(a.seven_day && a.seven_day.status === 'rejected'));
      var until = Number(w.reset) * 1000;
      if (!rejected || until + LIMIT_MARGIN_MS <= Date.now()) return;
      if (!best || until > best.until) best = { name: p[0], until: until };
    });
    return best;
  }
  /** A line for the end of a nudge, so the agent sees what it is spending: "[Usage: 5-hour 62% (resets 15:10), week 31%.]". */
  function usageNote(convId) {
    var a = usageOf(convId);
    if (!a) return '';
    var five = windowNow(a.five_hour), week = windowNow(a.seven_day);
    var parts = [];
    if (five) parts.push('5-hour ' + pct(five.u) + (five.reset ? ' (resets ' + hhmm(five.reset * 1000) + ')' : ' (reset)'));
    if (week) parts.push('week ' + pct(week.u) + (week.reset && week.u >= 0.7 ? ' (resets ' + resetText(week.reset) + ')' : ''));
    if (!parts.length) return '';
    var at = Number(a.at) || 0;
    var warn = (five && five.u >= 0.9) || (week && week.u >= 0.9) ? ' Close to a limit: plan the work to fit.' : '';
    return '\n[Usage' + (Date.now() - at > USAGE_STALE_MS ? ' as of ' + hhmm(at) : '') + ': ' + parts.join(', ') + '.' + warn + ']';
  }
  function usageColour(u) { return u >= 0.9 ? 'rgb(var(--danger-6))' : u >= 0.7 ? 'rgb(var(--warning-6))' : 'rgb(var(--success-6))'; }
  function pct(u) { return Math.round(Math.max(0, Number(u) || 0) * 100) + '%'; }
  function resetText(sec) {
    var n = Number(sec);
    if (!n) return '';
    var d = new Date(n * 1000), now = new Date();
    var time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return d.toDateString() === now.toDateString() ? time : d.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
  }
  function windowText(name, raw) {
    var w = windowNow(raw);
    if (!w) return '';
    var r = resetText(w.reset);
    return name + ' ' + pct(w.u) + (w.status === 'rejected' ? ', limit reached' : '') + (r ? ' (resets ' + r + ')' : w.over ? ' (has reset)' : '');
  }
  function ageText(ms) {
    var m = Math.round(ms / 60000);
    return m < 2 ? 'just now' : m < 90 ? m + ' minutes ago' : Math.round(m / 60) + ' hours ago';
  }
  function placeUsage(t, beforeEl, convId) {
    var a = usageOf(convId);
    var el = usageEls[t.key];
    if (!a) { if (el && el.parentNode) el.parentNode.removeChild(el); delete usageEls[t.key]; return; }
    if (!el) {
      el = document.createElement('div');
      el.className = 'aiondx-usage';
      el.setAttribute('data-testid', 'aiondx-usage');
      el.innerHTML = '<span class="aiondx-usage-bars"><span class="aiondx-usage-bar" data-w="5h"><i></i></span>' +
        '<span class="aiondx-usage-bar" data-w="wk"><i></i></span></span><span class="aiondx-usage-text"></span>';
      usageEls[t.key] = el;
    }
    el.classList.toggle('aiondx-usage--compact', t.kind === 'team');
    if (el.parentNode !== beforeEl.parentNode || el.nextSibling !== beforeEl) beforeEl.parentNode.insertBefore(el, beforeEl);
    var five = windowNow(a.five_hour) || { u: 0 }, week = windowNow(a.seven_day) || { u: 0 };
    var stale = Date.now() - (Number(a.at) || 0) > USAGE_STALE_MS;
    if ((el.getAttribute('data-stale') === '1') !== stale) { if (stale) el.setAttribute('data-stale', '1'); else el.removeAttribute('data-stale'); }
    var bars = el.querySelectorAll('.aiondx-usage-bar i');
    [five, week].forEach(function (w, i) {
      var u = Math.min(1, Math.max(0, Number(w.u) || 0));
      bars[i].style.width = (u * 100).toFixed(1) + '%';
      bars[i].style.backgroundColor = usageColour(u);
    });
    var text = '5h ' + pct(five.u) + ' \u00b7 wk ' + pct(week.u);
    var tx = el.querySelector('.aiondx-usage-text');
    if (tx.textContent !== text) tx.textContent = text;
    var tip = 'Claude usage' + (a.label ? ', ' + a.label : '') + ': ' + [windowText('5-hour window', a.five_hour), windowText('week', a.seven_day)].filter(Boolean).join('; ') +
      '. Read at ' + new Date(Number(a.at) || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) +
      (stale ? ' (' + ageText(Date.now() - (Number(a.at) || 0)) + '; it may be higher now)' : '') + '.';
    if (el.title !== tip) { el.title = tip; el.setAttribute('aria-label', tip); }
    el.setAttribute('data-limit', five.status === 'rejected' || week.status === 'rejected' ? 'reached' : '');
    // Too narrow for the whole meter: it gives way, and hovering the account pill shows the same figures.
    if (t.kind !== 'team') {
      el.removeAttribute('data-narrow');
      if (tx.scrollWidth > tx.clientWidth + 1) el.setAttribute('data-narrow', '1');
    }
  }
  /** The account pill's hover card: which agent, and what its usage looks like now. */
  function fillAcctTip(el, pill) {
    var convId = pill._convId, info = convInfo[convId];
    var cur = info ? chatAgent(convId, info) : null;
    var box = el.querySelector('.arco-tooltip-content-inner');
    box.innerHTML = '<div class="aiondx-tip-title"></div><div class="aiondx-tip-body"></div><ul class="aiondx-tip-list"></ul><div class="aiondx-tip-foot"></div>';
    box.querySelector('.aiondx-tip-title').textContent = 'Agent: ' + (cur ? agentName(cur.id) : 'not known yet');
    var body = box.querySelector('.aiondx-tip-body'), list = box.querySelector('.aiondx-tip-list');
    var a = info && info.backend === 'claude' ? usageOf(convId) : null;
    if (a) {
      var lines = [windowText('5-hour window', a.five_hour), windowText('Week', a.seven_day)].filter(Boolean);
      lines.forEach(function (x) { var li = document.createElement('li'); li.textContent = x; list.appendChild(li); });
      var age = Date.now() - (Number(a.at) || 0);
      body.textContent = 'Claude usage' + (a.label ? ', ' + a.label : '') + ', read ' + ageText(age) + (age > USAGE_STALE_MS ? '; it may be higher now.' : '.');
    } else {
      body.style.display = info && info.backend === 'claude' ? '' : 'none';
      body.textContent = 'No usage reading yet. It appears after this chat\u2019s Claude makes its next request.';
    }
    if (!list.firstChild) list.style.display = 'none';
    box.querySelector('.aiondx-tip-foot').textContent = 'Click to switch this chat to another agent.';
  }
  function acctPill(node) { return node && node.closest ? node.closest('.aiondx-acct') : null; }
  function watchAcctHover() {
    var current = null;
    document.addEventListener('mouseover', function (ev) {
      var pill = acctPill(ev.target);
      if (!pill || pill === current) return;
      current = pill;
      if (tipTimer) clearTimeout(tipTimer);
      tipTimer = setTimeout(function () {
        tipTimer = null;
        if (current === pill && !acctMenu) openTip('acct', pill, function (el) { fillAcctTip(el, pill); });
      }, TIP_DELAY_MS);
    }, true);
    document.addEventListener('mouseout', function (ev) {
      if (!current || acctPill(ev.target) !== current) return;
      if (ev.relatedTarget && current.contains(ev.relatedTarget)) return;
      current = null;
      if (tipKey === 'acct') hideTip();
      else if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
    }, true);
    document.addEventListener('mousedown', function (ev) {
      if (!acctPill(ev.target)) return;
      current = null;
      if (tipKey === 'acct') hideTip();
      else if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
    }, true);
  }
  function dropUsage(key) {
    var el = usageEls[key];
    if (el && el.parentNode) el.parentNode.removeChild(el);
    delete usageEls[key];
  }

  // ---------------------------------------------------------------- drafts that survive closing the app (build 2026-09-26.1)

  // K, 2026-09-26: "i want chats to be saved in the chat box at all times. the app needs soft and hard
  // caching. it seems to do it well while the app is open, but it should be hard cached consistently
  // as well, when the app closes". AionUi keeps a composer's draft in memory only (useSendBoxDraft:
  // a Map behind an SWR key), so closing the app, or a crash, loses it. AionDX keeps two copies of
  // every message box's text: localStorage (aionui.dx.draft.<scope>), written as you type, and the
  // settings store (aiondx.draft.<scope>), written 2 s after you stop typing and when the window hides
  // or closes. A box found empty when it first appears gets the newer copy back. What is on screen is
  // compared with the saved copy every second, so a sent or cleared box clears its copy too.
  // <scope> is conv.<conversation id> or team.<team id>.<slot id>. Text only; attachments are not kept.
  var DRAFT_LS = KEY_PREFIX + 'draft.';
  var DRAFT_STORE = 'aiondx.draft.';
  var DRAFT_STORE_DELAY_MS = 2000;
  var DRAFT_MAX_AGE_MS = 30 * 24 * 3600000;
  var DRAFT_MAX_CHARS = 100000;
  var draftStore = {};       // scope -> { text, at } as last read from the store
  var draftTimers = {};      // scope -> pending store write
  var draftRestored = {};    // scope -> true once this page has offered its saved draft
  var draftSeen = typeof WeakMap === 'function' ? new WeakMap() : null;   // box -> first seen time

  function draftScope(t) { return t.kind === 'conv' ? 'conv.' + t.convId : 'team.' + t.teamId + '.' + t.slotId; }
  function draftBox(t) {
    var root = t.actions && (t.actions.closest('.sendbox-panel') || t.actions.parentNode);
    var box = root && root.querySelector('[data-testid="sendbox-input"]');
    if (!box) return null;
    return /^(TEXTAREA|INPUT)$/.test(box.tagName) ? box : box.querySelector('textarea, input');
  }
  function localDraft(scope) {
    try { var d = JSON.parse(localStorage.getItem(DRAFT_LS + scope)); return d && typeof d.text === 'string' ? d : null; } catch (e) { return null; }
  }
  function takeDrafts(data) {
    var next = {};
    Object.keys(data).forEach(function (k) {
      if (k.indexOf(DRAFT_STORE) !== 0) return;
      var v = data[k];
      if (!v || typeof v.text !== 'string') return;
      if (Date.now() - (Number(v.at) || 0) > DRAFT_MAX_AGE_MS) { var gone = {}; gone[k] = null; putPrefs(gone); return; }
      next[k.slice(DRAFT_STORE.length)] = v;
    });
    draftStore = next;
  }
  /** Save this box's text: at once to localStorage, and to the store once typing pauses (or now). */
  var draftUnloading = false;
  function saveDraft(scope, text, now) {
    text = String(text || '').slice(0, DRAFT_MAX_CHARS);
    var cur = localDraft(scope);
    if ((cur ? cur.text : '') !== text) {
      try {
        if (text.trim()) localStorage.setItem(DRAFT_LS + scope, JSON.stringify({ text: text, at: Date.now() }));
        else localStorage.removeItem(DRAFT_LS + scope);
      } catch (e) { /* storage full: the store copy still goes */ }
    }
    var stored = draftStore[scope];
    var pending = draftTimers[scope];
    if ((stored ? stored.text : '') === text) { if (pending) { clearTimeout(pending.timer); delete draftTimers[scope]; } return; }
    if (pending && pending.text === text && !now) return;   // already on its way, once typing has paused
    var write = function () {
      delete draftTimers[scope];
      var body = {};
      body[DRAFT_STORE + scope] = text.trim() ? { text: text, at: Date.now() } : null;
      if (text.trim()) draftStore[scope] = body[DRAFT_STORE + scope]; else delete draftStore[scope];
      if (sharedGone) return;
      fetch(apiUrl('/api/settings/client'), {
        method: 'PUT', credentials: 'include', keepalive: draftUnloading && JSON.stringify(body).length < 60000,
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf() }, body: JSON.stringify(body)
      }).catch(function () {});
    };
    if (pending) clearTimeout(pending.timer);
    if (now) write(); else draftTimers[scope] = { text: text, timer: setTimeout(write, DRAFT_STORE_DELAY_MS) };
  }
  /** Every second: offer each empty box its saved draft once, then keep the saved copy equal to the box. */
  function syncDrafts(flushNow) {
    if (disabled()) return;
    targets().forEach(function (t) {
      var box = draftBox(t);
      if (!box) return;
      var scope = draftScope(t);
      var text = box.value || '';
      if (!draftRestored[scope]) {
        // Give AionUi's own in-memory draft a moment to fill the box first.
        var first = draftSeen ? draftSeen.get(box) : 0;
        if (!first) { if (draftSeen) draftSeen.set(box, Date.now()); return; }
        if (Date.now() - first < 600) return;
        draftRestored[scope] = true;
        if (!text) {
          var a = localDraft(scope), b = draftStore[scope];
          var pick = a && b ? (Number(a.at) >= Number(b.at) ? a : b) : (a || b);
          if (pick && pick.text.trim() && Date.now() - (Number(pick.at) || 0) < DRAFT_MAX_AGE_MS) {
            setComposerValue(box, pick.text);
            return;
          }
        }
      }
      saveDraft(scope, text, flushNow);
    });
  }
  function watchDrafts() {
    document.addEventListener('input', function (ev) {
      var el = ev.target;
      if (!el || !el.closest || !el.closest('[data-testid="sendbox-input"]')) return;
      var t = targetOf(el);
      if (!t) return;
      draftRestored[draftScope(t)] = true;   // you are typing: nothing to restore over it
      saveDraft(draftScope(t), el.value || '', false);
    }, true);
    var flush = function () { syncDrafts(true); };
    var closing = function () { draftUnloading = true; syncDrafts(true); };
    window.addEventListener('beforeunload', closing);
    window.addEventListener('pagehide', closing);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(); });
    window.addEventListener('blur', flush);
    setInterval(function () { syncDrafts(false); try { renderSched(); } catch (e) {} }, 1000);
    document.addEventListener('input', function (ev) {
      var el = ev.target;
      if (el && el.closest && el.closest('[data-testid="sendbox-input"]')) { try { renderSched(); } catch (e) {} }
    }, true);
    // Old copies go after 30 days.
    try {
      for (var i = localStorage.length - 1; i >= 0; i--) {
        var k = localStorage.key(i);
        if (!k || k.indexOf(DRAFT_LS) !== 0) continue;
        var d = null;
        try { d = JSON.parse(localStorage.getItem(k)); } catch (e) { d = null; }
        if (!d || Date.now() - (Number(d.at) || 0) > DRAFT_MAX_AGE_MS) localStorage.removeItem(k);
      }
    } catch (e) {}
  }
  /** Set a React-controlled text box: the prototype's setter, then an input event React hears. */
  function setComposerValue(ta, value) {
    var proto = ta.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(ta, value); else ta.value = value;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // ---------------------------------------------------------------- first-run setup inside the app (build 2026-09-26.1)

  // What AionDX needs in AionUi's own settings on a new machine (DIVERGENCE-AUDIT.md, table 2), made here
  // with the user's own session, once per PROVISION_VERSION: the Loop tool's MCP row (by bare name: the
  // installer puts %LOCALAPPDATA%\AionDX\bin first on PATH), the Butler switched off (Antigravity is the
  // setup agent, patch 0006), and the AionDX themes (window.__aionDxThemes, from aiondx-themes.js, which
  // patch 0009 writes into the app). AionUi reads its settings once when the window loads, so a first
  // theme install reloads the window once. Recorded in aiondx.provisioned = {v, at, build, did}.
  // Version 2 (K, 2026-09-26: "We can remove AionCLI, same waste as the butler"): Aion CLI switched off, with the
  // built-in assistants that run on it. A machine set up at version 1 gets only that step.
  var PROVISION_KEY = 'aiondx.provisioned';
  var PROVISION_VERSION = 2;
  var provisionState = { running: false, data: null };
  var THEME_MAP = { '': 'aiondx-dark', light: 'aiondx-light', dark: 'aiondx-dark' };

  async function sendJson(method, url, body) {
    return fetch(apiUrl(url), {
      method: method, credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf() },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  }
  async function provision(data) {
    if (provisionState.running || sharedGone || disabled()) return;
    var cur = data[PROVISION_KEY];
    if (cur && Number(cur.v) >= PROVISION_VERSION) return;
    // Once per window: a step that failed is tried again at the next start, not every few seconds.
    if (provisionState.tried) return;
    provisionState.tried = true;
    provisionState.running = true;
    var from = cur ? Number(cur.v) || 0 : 0;   // the version this machine was set up at
    var did = [];
    var failed = [];
    var reload = false;
    try {
      if (from < 1) await provisionFirst(data, did, failed, function () { reload = true; });
      // 4. Aion CLI off, and the built-in assistants that run on it (agent type aionrs, and the same agent id).
      var ga = await getJson('/api/assistants');
      var alist = ga.data && Array.isArray(ga.data) ? ga.data : null;
      if (!alist) failed.push('aioncli:list');
      else {
        var aion = {};
        alist.forEach(function (a) { if (a && a.agent && a.agent.type === 'aionrs' && a.agent_id && a.id !== 'aionui-assistant') aion[a.agent_id] = true; });
        for (var k = 0; k < alist.length; k++) {
          var a = alist[k];
          if (!a || !a.enabled || !((a.agent && a.agent.type === 'aionrs') || (a.agent_id && aion[a.agent_id]))) continue;
          var off = await sendJson('PATCH', '/api/assistants/' + encodeURIComponent(a.id) + '/state', { enabled: false });
          if (off.ok) did.push('off:' + a.id); else failed.push('off:' + a.id + ' ' + off.status);
        }
      }
      var rec = {};
      rec[PROVISION_KEY] = failed.length ? { v: from, at: Date.now(), build: BUILD, did: did, failed: failed }
                                          : { v: PROVISION_VERSION, at: Date.now(), build: BUILD, did: did };
      await putPrefs(rec);
      console.log('[dx] first-run setup: ' + (did.join(', ') || 'nothing to do') + (failed.length ? '; failed, tried again at the next start: ' + failed.join(', ') : ''));
      // Once per window: AionUi reads its settings at load, so the new theme needs one reload.
      var once = 'aionui.dx.provision-reloaded';
      if (reload && !sessionStorage.getItem(once)) { sessionStorage.setItem(once, '1'); location.reload(); }
    } catch (e) {
      console.log('[dx] first-run setup failed; it tries again at the next start', e);
    } finally {
      provisionState.running = false;
    }
  }
  /** Version 1's steps: the Loop tool's MCP row, the Butler off, the AionDX themes. */
  async function provisionFirst(data, did, failed, needReload) {
    {
      // 1. The Loop tool, for every chat created from now on.
      var g = await getJson('/api/mcp/servers');
      var rows = g.data && Array.isArray(g.data) ? g.data : null;
      var row = null;
      for (var i = 0; rows && i < rows.length; i++) if (rows[i] && rows[i].name === 'aiondx-loop') { row = rows[i]; break; }
      if (!rows) failed.push('mcp:list');   // not read: no create, which could overwrite a row the user edited
      else if (!row) {
        var r = await sendJson('POST', '/api/mcp/servers', { name: 'aiondx-loop', builtin: false,
          description: 'AionDX Loop: agents see and change the Loop button in the message box (on or off, the continue message, a compaction). AionDX patch 0007.',
          transport: { type: 'stdio', command: 'aiondx-loop', args: [], env: {} } });
        if (r.ok) { row = unwrap(await r.json()); did.push('mcp:aiondx-loop'); }
        else failed.push('mcp:create ' + r.status);
      }
      if (row && row.id && !row.enabled) {
        var t = await sendJson('POST', '/api/mcp/servers/' + row.id + '/toggle');
        if (t.ok) did.push('mcp:enabled'); else failed.push('mcp:enable ' + t.status);
      }
      // 2. The Butler off: Antigravity sets AionDX up.
      var b = await sendJson('PATCH', '/api/assistants/aionui-assistant/state', { enabled: false });
      if (b.ok) did.push('butler:off');
      // 3. The AionDX themes, and the AionDX one for the mode already chosen.
      var themes = window.__aionDxThemes;
      if (Array.isArray(themes) && themes.length) {
        var list = Array.isArray(data['theme.userThemes']) ? data['theme.userThemes'].slice() : [];
        themes.forEach(function (th) {
          var at = -1;
          for (var j = 0; j < list.length; j++) if (list[j] && list[j].id === th.id) { at = j; break; }
          if (at >= 0) list[at] = th; else list.push(th);
        });
        var body = { 'theme.userThemes': list };
        var active = data['theme.activeId'] || '';
        if (Object.prototype.hasOwnProperty.call(THEME_MAP, active)) body['theme.activeId'] = THEME_MAP[active];
        var w = await putPrefs(body);
        if (w && w.ok) { did.push('themes'); needReload(); } else failed.push('themes');
      }
    }
  }

  // ---------------------------------------------------------------- Welcome to AionDX (build 2026-09-26.1)

  // K, 2026-09-26: Antigravity setup should be the first screen, "Welcome to AionDX" / "Please sign up for
  // a free antigravity key so it can migrate your agent and user preferences from other ui's you may be
  // using", with an option to skip and have everything configured by an external agent (like Claude via
  // Claude Desktop), on the same screen as the global options (instructions for every agent) and the
  // account migration options, all handled by Antigravity. Shown once, after first-run setup, until the
  // user finishes it or picks "Not now"; reopened from Settings > Appearance ("AionDX setup").
  // State: aiondx.welcome = { done, mode: 'antigravity' | 'external' | 'later', at, conv }.
  var WELCOME_KEY = 'aiondx.welcome';
  var AGY_INSTALL = 'irm https://antigravity.google/cli/install.ps1 | iex; & "$env:LOCALAPPDATA\\AionDX\\bin\\aiondx.exe" doctor';
  var welcome = { el: null, step: 0, data: null, agy: null, alt: null, via: null, conv: null, opened: false };
  // The failsafe (K, 2026-09-26: "make sure antigravity works, failsafe if need be"). The setup skill is in
  // every AionDX chat, so any working agent can run the setup. When Antigravity is not installed, its
  // sign-in reports failed, or it has not answered 90 s after "Sign in", step 1 offers "Set up with <agent>"
  // for the first working agent in the new-chat list (Claude Code, Codex, Gemini, Qwen, OpenCode, then any).
  var WELCOME_ALT_AFTER_MS = 90000;
  var SETUP_PREFERENCE = ['claude', 'codex', 'gemini', 'qwen', 'opencode'];
  function pickSetupAgent(list) {
    var ok = (list || []).filter(function (a) {
      return a.enabled && agentOnline(a) && a.backend !== 'antigravity' && a.type !== 'aionrs' && a.source === 'generated';
    });
    ok.sort(function (x, y) {
      var ix = SETUP_PREFERENCE.indexOf(x.backend), iy = SETUP_PREFERENCE.indexOf(y.backend);
      return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy);
    });
    return ok[0] || null;
  }
  function showAlt(show) {
    var b = welcome.el && welcome.el.querySelector('.aiondx-w-alt');
    if (!b) return;
    var on = !!(show && welcome.alt);
    if (on) b.textContent = 'Set up with ' + welcome.alt.name;
    b.hidden = !on;
  }
  var WELCOME_OPTIONS = [
    ['agents', true, 'Agents and their settings', 'Custom agents, commands and prompts from Claude Code, Claude Desktop, Codex, Gemini CLI, Cursor, Windsurf, Cline and the others found on this PC.'],
    ['mcp', true, 'MCP servers', 'The tool servers those apps use, registered once in AionDX for every agent. Keys and tokens are never copied; placeholders mark where one is needed.'],
    ['skills', true, 'Skills, rules and instructions', 'Skill folders, rule files and each app\'s global instructions, merged into one master copy.'],
    ['accounts', false, 'Sign-ins and accounts', 'Only if ticked: which accounts those apps are signed in to, so each agent here can use the same one. The agent asks before each one and never copies a password or token.']
  ];

  function takeWelcome(data) {
    welcome.data = data[WELCOME_KEY] || null;
    var sign = data['aiondx.agy.signin'];
    if (welcome.el && welcome.step === 'agy' && sign && welcome.startedAt && Number(sign.at) > welcome.startedAt) {
      if (sign.state === 'done') { welcome.mode = null; welcome.via = welcome.agy; showWelcome(2); }
      else if (sign.state === 'waiting' && !welcome.toldWaiting) {
        welcome.toldWaiting = true;
        welcomeStatus('A Google sign-in page opened in your browser. Finish it there; if the page shows a code, paste it into the box at the top of the window.');
      }
      else if (sign.state === 'failed' && !welcome.signinFailed) {
        welcome.signinFailed = true;
        welcomeStatus((sign.message || 'Antigravity\'s sign-in did not finish.') + (welcome.alt ? ' Try again, or set up with ' + welcome.alt.name + ' instead.' : ' Try again.'));
        showAlt(true);
      }
    }
    if (welcome.el || welcome.opened || disabled()) return;
    // After first-run setup has run once, whatever came of its steps (a failed one is retried at the next start).
    var prov = data[PROVISION_KEY];
    if (!prov || !prov.at) return;
    if (welcome.data && (welcome.data.done || welcome.data.mode === 'later')) return;
    welcome.opened = true;
    showWelcome(1);
  }

  function welcomeBrief(mode) {
    var el = welcome.el;
    var text = el ? String(el.querySelector('.aiondx-welcome-prefs').value || '').trim() : '';
    var chosen = WELCOME_OPTIONS.filter(function (o) { var cb = el && el.querySelector('[data-opt="' + o[0] + '"]'); return cb ? cb.checked : o[1]; });
    // Clearer for Antigravity (K, 2026-09-26: it "made scripts for the tester to run himself"): the same scan and import the
    // Welcome screen's Import button runs, as two commands, and plainly no work handed back to the user.
    var cmd = mode === 'external' ? '"%LOCALAPPDATA%\\AionDX\\bin\\aiondx.exe"' : 'aiondx';
    var skip = [];
    var picked = function (id) { return chosen.some(function (o) { return o[0] === id; }); };
    if (!picked('agents')) skip.push('agents', 'commands', 'prompts');
    if (!picked('skills')) skip.push('skills', 'rules', 'instructions');
    if (!picked('mcp')) skip.push('mcp');
    var lines = [];
    lines.push('AionDX setup, from the Welcome screen (' + new Date().toISOString().slice(0, 10) + ').');
    lines.push('');
    lines.push(mode === 'external'  // an agent outside AionDX; otherwise one in it, which has the skill
      ? 'You are setting AionDX up on this Windows PC for its user. AionDX is a free edition of AionUi. Its setup procedure is %APPDATA%\\AionUi\\aionui\\builtin-skills\\auto-inject\\aiondx-setup\\SKILL.md; its safety rules apply to everything below.'
      : 'Set AionDX up for me now, with your aiondx-setup skill and its safety rules.');
    lines.push('');
    lines.push('Do every step yourself, in this chat: run the commands, read and write the files. Never give me a script or a command to run, and never ask me to open a terminal. If a step fails, fix it or tell me what failed; do not hand the work back to me.');
    lines.push('');
    lines.push('1. Run this, and wait for it (up to two minutes). It lists what my other AI apps have; it reads names, sizes and dates only, and needs no Node.js:');
    lines.push('   ' + cmd + ' setup scan');
    lines.push('2. Show me what it found, a short list per app, and wait for my yes, or for what to leave out.');
    lines.push('3. Then run this. It copies what I said yes to into ~/.aiondx, writes one set of instructions for every agent, and puts MCP servers in the AionDX MCP file with placeholders for keys:');
    lines.push('   ' + cmd + ' setup apply --all' + skip.map(function (k) { return ' --skip ' + k; }).join('') + (text ? ' --prefs "<my instructions below, on one line>"' : '') +
      '   (add --skip agents, commands, prompts, skills, rules, instructions, mcp or wire for anything I leave out)');
    lines.push('4. Show me the summary it prints, including any keys still needed and where the report is.');
    lines.push('');
    lines.push('My instructions for every agent:');
    lines.push(text ? text.split(/\r?\n/).map(function (l) { return '   > ' + l; }).join('\n') : '   (none given: keep what my other tools already have)');
    lines.push('');
    lines.push('What to bring over:');
    WELCOME_OPTIONS.forEach(function (o) { lines.push('   [' + (chosen.indexOf(o) >= 0 ? 'x' : ' ') + '] ' + o[2] + ': ' + o[3]); });
    return lines.join('\n');
  }

  function closeWelcome() {
    if (welcome.el && welcome.el.parentNode) welcome.el.parentNode.removeChild(welcome.el);
    welcome.el = null;
    welcome.step = 0;
  }
  function saveWelcome(fields) {
    var rec = Object.assign({}, welcome.data || {}, fields, { at: Date.now() });
    welcome.data = rec;
    var body = {};
    body[WELCOME_KEY] = rec;
    putPrefs(body);
  }

  /** Black or white, whichever reads better on this colour. */
  function onColour(hex) {
    var c = hexRgb(hex);
    if (!c) return '#ffffff';
    var lin = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    var L = 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
    return L > 0.4 ? '#111111' : '#ffffff';
  }
  function paintWelcomeButtons() {
    if (!welcome.el) return;
    var accent = currentAccent();
    var btns = welcome.el.querySelectorAll('.arco-btn-primary');
    for (var i = 0; i < btns.length; i++) {
      btns[i].style.backgroundColor = accent;
      btns[i].style.borderColor = accent;
      btns[i].style.color = onColour(accent);
    }
  }
  /** One run at a time per Welcome button: disabled until its work settles, so a second click cannot start
   *  a second chat (K, September 26th: "i hit it a bunch, it started a bunch of conversations"). */
  function once(btn, work) {
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('arco-btn-loading');
    Promise.resolve().then(work).catch(function (e) { console.log('[dx] welcome', e); }).then(function () {
      btn.disabled = false;
      btn.classList.remove('arco-btn-loading');
    });
  }
  // ---- the one-click setup (K, 2026-09-26: "we want a streamlined 'one-click' ish setup process", Antigravity
  // as the backup "which needs clearer instructions"). The main process runs the setup skill's survey and import
  // (patch 0009, window.aiondxSetup): step 1 looks, "found" lists what it found with a tick box each, one Import
  // copies it all in and gives every agent the instructions, "done" says what happened. No agent, sign-in or
  // Node.js is needed. Without window.aiondxSetup (WebUI) step 1 is the Antigravity screen, as before.
  var FOUND_KINDS = { agents: ['custom agent', 'custom agents'], commands: ['command', 'commands'], skills: ['skill', 'skills'],
    prompts: ['prompt', 'prompts'], rules: ['rule file', 'rule files'] };
  var WIRE_AGENTS = [['claude-code', 'Claude Code', '~/.claude/CLAUDE.md'], ['codex', 'Codex', '~/.codex/AGENTS.md'],
    ['antigravity', 'Antigravity', '~/.gemini/config/AGENTS.md'], ['gemini-cli', 'Gemini CLI', '~/.gemini/GEMINI.md'],
    ['qwen-code', 'Qwen Code', '~/.qwen/QWEN.md'], ['opencode', 'OpenCode', '~/.config/opencode/AGENTS.md']];
  function oneClick() { return !!(window.aiondxSetup && typeof window.aiondxSetup.scan === 'function'); }
  /** What the survey found, per app: instructions files, folders of custom files, MCP servers. */
  function foundGroups(survey) {
    var home = String(survey.home || '');
    var tilde = function (p) { p = String(p || ''); return home && p.toLowerCase().indexOf(home.toLowerCase()) === 0 ? '~' + p.slice(home.length) : p; };
    var masked = function (list) {
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var x = String(list[i]);
        out.push(x);
        if (/^-/.test(x) && /(?:^|[-_])(?:api[-_]?key|key|token|secret|password|auth)(?:$|[-_=])/i.test(x.replace(/^-+/, '')) && i + 1 < list.length) { out.push('***'); i++; }
      }
      return out;
    };
    var groups = [];
    (survey.tools || []).forEach(function (t) {
      if (!t.installed || t.id === 'aionui') return;
      var items = [];
      (t.locations || []).forEach(function (l) {
        if (!l.exists || l.excluded) return;
        if (l.kind === 'instructions' && l.type === 'file' && !l.secretLooking) {
          items.push({ type: 'item', path: l.path, title: 'Instructions', desc: tilde(l.path) + (l.modified ? ', changed ' + String(l.modified).slice(0, 10) : '') });
        } else if (FOUND_KINDS[l.kind] && l.type === 'dir' && l.count > 0) {
          items.push({ type: 'item', path: l.path, title: l.count + ' ' + FOUND_KINDS[l.kind][l.count === 1 ? 0 : 1], desc: tilde(l.path) });
        } else if (l.kind === 'mcp' && l.mcp && Array.isArray(l.mcp.servers)) {
          l.mcp.servers.forEach(function (s) {
            var how = s.url ? String(s.url) : [s.command || ''].concat(masked((s.args || []).slice(0, 4))).join(' ');
            items.push({ type: 'mcp', file: l.path, name: s.name, title: 'MCP server ' + s.name,
              desc: how + (s.envNames && s.envNames.length ? '. Needs ' + s.envNames.join(', ') : '') + (s.headerNames && s.headerNames.length ? '. Needs a ' + s.headerNames.join(', ') + ' header' : '') });
          });
        }
      });
      if (items.length) groups.push({ tool: t.name, items: items });
    });
    return groups;
  }
  function wireChoices(survey) {
    var installed = {};
    (survey.tools || []).forEach(function (t) { if (t.installed) installed[t.id] = true; });
    return WIRE_AGENTS.filter(function (a) { return a[0] === 'antigravity' ? !!welcome.agy : !!installed[a[0]]; });
  }
  async function runWelcomeScan() {
    welcomeStatus('Looking through your AI apps. This reads names, sizes and dates only.');
    var r = null;
    try { r = await window.aiondxSetup.scan(); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
    if (!welcome.el || welcome.step !== 1) return;
    if (!r || !r.ok || !r.survey) {
      welcomeStatus('The look-through did not finish (' + String((r && r.error) || 'no answer').slice(0, 300) + '). You can set up with Antigravity instead.');
      return;
    }
    welcome.survey = r.survey;
    showWelcome('found');
  }
  function welcomePlan() {
    var el = welcome.el;
    var plan = { prefs: String((el.querySelector('.aiondx-welcome-prefs') || {}).value || '').trim(), items: [], mcp: [], wire: [] };
    [].forEach.call(el.querySelectorAll('input[data-found]'), function (cb) {
      if (!cb.checked) return;
      var it = welcome.foundIndex[Number(cb.getAttribute('data-found'))];
      if (!it) return;
      if (it.type === 'mcp') plan.mcp.push({ file: it.file, name: it.name }); else plan.items.push(it.path);
    });
    [].forEach.call(el.querySelectorAll('input[data-wire]'), function (cb) { if (cb.checked) plan.wire.push(cb.getAttribute('data-wire')); });
    return plan;
  }
  async function runWelcomeImport() {
    var plan = welcomePlan();
    if (!plan.items.length && !plan.mcp.length && !plan.prefs) { welcomeStatus('Nothing is ticked. Tick what to bring over, or press Not now.'); return; }
    welcomeStatus('Importing...');
    var r = null;
    try { r = await window.aiondxSetup.apply(plan); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
    if (!welcome.el || welcome.step !== 'found') return;
    if (!r || !r.ok || !r.result) {
      welcomeStatus('The import did not finish (' + String((r && r.error) || 'no answer').slice(0, 300) + '). Nothing else was changed after that point; the report in ~/.aiondx/harvest says what was.');
      return;
    }
    welcome.result = r.result;
    saveWelcome({ done: true, mode: 'import', report: r.result.report || null, prefs: plan.prefs });
    showWelcome('done');
  }
  function welcomeDoneLines(res) {
    var lines = [];
    var byKind = {};
    (res.copied || []).forEach(function (c) { byKind[c.kind] = (byKind[c.kind] || 0) + (c.kind === 'instructions' ? 1 : (c.files || 0)); });
    var parts = [];
    if (byKind.instructions) parts.push(byKind.instructions + ' instructions file' + (byKind.instructions === 1 ? '' : 's'));
    Object.keys(FOUND_KINDS).forEach(function (k) { if (byKind[k]) parts.push(byKind[k] + ' ' + FOUND_KINDS[k][byKind[k] === 1 ? 0 : 1].replace(/^custom /, 'custom ')); });
    if (parts.length) lines.push('Brought over: ' + parts.join(', ') + '. The copies are in ' + res.aiondx + '.');
    var wired = (res.wired || []).filter(function (w) { return !w.skipped && !w.error; }).map(function (w) { return w.name; });
    if (res.aiondxMd) lines.push('One set of instructions for every agent: ' + res.aiondxMd + (wired.length ? ', now read by ' + wired.join(', ') + '.' : '.'));
    var m = res.mcp || {};
    if ((m.added || []).length) {
      lines.push('MCP servers: ' + m.added.join(', ') + ', in the AionDX MCP file. No chat loads them; ask any agent to use one when you need it.');
      var need = (m.placeholders || []).filter(function (n) { return (m.fromEnvironment || []).indexOf(n) < 0; });
      if ((m.fromEnvironment || []).length) lines.push('Keys already in your environment variables, used as they are: ' + m.fromEnvironment.join(', ') + '.');
      if (need.length) lines.push('Keys still needed: ' + need.join(', ') + '. Put each in the "secrets" section of ' + m.file + ', or set it as an environment variable.');
    }
    if (res.secretsRemoved) lines.push(res.secretsRemoved + ' key-like string' + (res.secretsRemoved === 1 ? ' was' : 's were') + ' left out of the instructions.');
    if (!lines.length) lines.push('Nothing needed bringing over.');
    return lines;
  }

  function showWelcome(step) {
    if (step === 1 && !oneClick()) step = 'agy';   // WebUI, or an app without the one-click setup
    welcome.step = step;
    if (!welcome.el) {
      welcome.el = document.createElement('div');
      welcome.el.className = 'aiondx-welcome-backdrop';
      welcome.el.innerHTML = '<div class="aiondx-welcome" role="dialog" aria-modal="true" aria-labelledby="aiondx-welcome-title"></div>';
      welcome.el.addEventListener('keydown', function (ev) { ev.stopPropagation(); if (ev.key === 'Escape') laterWelcome(); });
      document.body.appendChild(welcome.el);
    }
    var box = welcome.el.firstChild;
    if (step === 1) {
      box.innerHTML =
        '<img class="aiondx-welcome-mark" src="./aiondx-mark.svg" alt="">' +
        '<h2 id="aiondx-welcome-title" class="aiondx-welcome-title">Welcome to AionDX</h2>' +
        '<p class="aiondx-welcome-text">AionDX can bring over what your other AI apps already use: their instructions, custom agents, ' +
          'commands, skills and MCP servers. It looks first and shows you what it found. Nothing changes until you press Import.</p>' +
        '<div class="aiondx-welcome-status" aria-live="polite"></div>' +
        '<div class="aiondx-welcome-actions">' +
          '<button type="button" class="arco-btn arco-btn-primary arco-btn-size-default aiondx-w-scan">Look for my setup</button>' +
          '<button type="button" class="arco-btn arco-btn-secondary arco-btn-size-default aiondx-w-agy">Set up with Antigravity instead</button>' +
          '<button type="button" class="arco-btn arco-btn-text arco-btn-size-default aiondx-w-later">Not now</button>' +
        '</div>' +
        '<p class="aiondx-welcome-foot">Not now closes this; Settings &gt; Appearance &gt; Open AionDX setup brings it back.</p>';
      box.querySelector('.aiondx-w-scan').addEventListener('click', function (ev) { once(ev.currentTarget, runWelcomeScan); });
      box.querySelector('.aiondx-w-agy').addEventListener('click', function () { showWelcome('agy'); });
      box.querySelector('.aiondx-w-later').addEventListener('click', laterWelcome);
      loadAgents(true).then(function (list) {
        for (var i = 0; i < list.length; i++) if (list[i].backend === 'antigravity') { welcome.agy = list[i]; break; }
      }, function () {});
    } else if (step === 'found') {
      var groups = foundGroups(welcome.survey || {});
      var wires = wireChoices(welcome.survey || {});
      welcome.foundIndex = [];
      box.innerHTML =
        '<h2 id="aiondx-welcome-title" class="aiondx-welcome-title">' + (groups.length ? 'Here is what AionDX found' : 'Nothing to bring over') + '</h2>' +
        '<p class="aiondx-welcome-text">' + (groups.length
          ? 'Untick anything to leave out. Keys and tokens are never copied: an MCP server that needs one gets a placeholder, which your environment variables fill when they have it.'
          : 'AionDX found no instructions, custom agents, commands, skills or MCP servers from other AI apps on this PC. You can still give every agent your own instructions below.') + '</p>' +
        '<div class="aiondx-welcome-found"></div>' +
        (wires.length ? '<div class="aiondx-welcome-label">Give the instructions to</div><div class="aiondx-welcome-options aiondx-welcome-wire"></div>' : '') +
        '<label class="aiondx-welcome-label" for="aiondx-welcome-prefs">Your own instructions for every agent (optional)</label>' +
        '<textarea id="aiondx-welcome-prefs" class="aiondx-welcome-prefs" rows="3" placeholder="How every agent should work for you: language, tone, what to always or never do."></textarea>' +
        '<div class="aiondx-welcome-status" aria-live="polite"></div>' +
        '<div class="aiondx-welcome-actions">' +
          '<button type="button" class="arco-btn arco-btn-primary arco-btn-size-default aiondx-w-import">Import</button>' +
          '<button type="button" class="arco-btn arco-btn-secondary arco-btn-size-default aiondx-w-back">Back</button>' +
          '<button type="button" class="arco-btn arco-btn-text arco-btn-size-default aiondx-w-later">Not now</button>' +
        '</div>';
      var holder = box.querySelector('.aiondx-welcome-found');
      var addOption = function (parent, attr, value, title, desc) {
        var lab = document.createElement('label');
        lab.className = 'aiondx-welcome-option';
        lab.innerHTML = '<input type="checkbox" checked><span><span class="aiondx-welcome-option-title"></span><span class="aiondx-welcome-option-desc"></span></span>';
        lab.querySelector('input').setAttribute(attr, value);
        lab.querySelector('.aiondx-welcome-option-title').textContent = title;
        lab.querySelector('.aiondx-welcome-option-desc').textContent = desc;
        parent.appendChild(lab);
      };
      groups.forEach(function (g) {
        var head = document.createElement('div');
        head.className = 'aiondx-welcome-group';
        head.textContent = g.tool;
        holder.appendChild(head);
        var list = document.createElement('div');
        list.className = 'aiondx-welcome-options';
        holder.appendChild(list);
        g.items.forEach(function (it) {
          welcome.foundIndex.push(it);
          addOption(list, 'data-found', String(welcome.foundIndex.length - 1), it.title, it.desc);
        });
      });
      var wireBox = box.querySelector('.aiondx-welcome-wire');
      wires.forEach(function (a) { addOption(wireBox, 'data-wire', a[0], a[1], a[2] + ', between AionDX markers; the rest of the file stays as it is'); });
      var prefsTa = box.querySelector('.aiondx-welcome-prefs');
      if (welcome.data && welcome.data.prefs) prefsTa.value = welcome.data.prefs;
      box.querySelector('.aiondx-w-import').addEventListener('click', function (ev) { once(ev.currentTarget, runWelcomeImport); });
      box.querySelector('.aiondx-w-back').addEventListener('click', function () { showWelcome(1); });
      box.querySelector('.aiondx-w-later').addEventListener('click', laterWelcome);
    } else if (step === 'done') {
      var res = welcome.result || {};
      box.innerHTML =
        '<img class="aiondx-welcome-mark" src="./aiondx-mark.svg" alt="">' +
        '<h2 id="aiondx-welcome-title" class="aiondx-welcome-title">Your setup is in AionDX</h2>' +
        '<ul class="aiondx-welcome-done"></ul>' +
        '<div class="aiondx-welcome-status" aria-live="polite"></div>' +
        '<div class="aiondx-welcome-actions">' +
          '<button type="button" class="arco-btn arco-btn-primary arco-btn-size-default aiondx-w-finish">Finish</button>' +
          (welcome.agy ? '<button type="button" class="arco-btn arco-btn-secondary arco-btn-size-default aiondx-w-agy">Also sign in to Antigravity (free)</button>' : '') +
        '</div>';
      var ul = box.querySelector('.aiondx-welcome-done');
      welcomeDoneLines(res).forEach(function (t) { var li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
      if (res.report) welcomeStatus('What changed, and how to undo each change:', res.report);
      box.querySelector('.aiondx-w-finish').addEventListener('click', closeWelcome);
      var agyBtn = box.querySelector('.aiondx-w-agy');
      if (agyBtn) agyBtn.addEventListener('click', function () { showWelcome('agy'); });
    } else if (step === 'agy') {
      box.innerHTML =
        '<img class="aiondx-welcome-mark" src="./aiondx-mark.svg" alt="">' +
        '<h2 id="aiondx-welcome-title" class="aiondx-welcome-title">' + (oneClick() ? 'Set up with Antigravity' : 'Welcome to AionDX') + '</h2>' +
        '<p class="aiondx-welcome-text">Sign in to Antigravity with your Google account, and it can bring over the agent and user preferences from the other AI apps you use. There is no key to paste: Google\'s sign-in page does it.</p>' +
        // K, 2026-09-26: "we should explain that antigravity is a free way to ... and it's provided by google at X usage
        // in Y amount of time ... and that it's all to help you migrate and setup". Google publishes no number for the
        // free plan (antigravity.google/docs/plans: "Meaningful quota, refreshed weekly"; research note of the 26th).
        '<div class="aiondx-welcome-facts">' +
          '<div class="aiondx-welcome-fact"><div class="aiondx-welcome-fact-title">Free with a Google account</div>' +
            '<div class="aiondx-welcome-fact-desc">Antigravity is Google\'s coding agent. Its plan for individuals costs nothing and comes with ' +
            'an allowance that refreshes every week. Google does not publish a number for it: it depends on how much work each request takes.</div></div>' +
          '<div class="aiondx-welcome-fact"><div class="aiondx-welcome-fact-title">What it does for you</div>' +
            '<div class="aiondx-welcome-fact-desc">It helps you move in. It finds the agents, MCP servers, skills and instructions your other AI ' +
            'apps use, shows you what it found, and sets them up in AionDX, asking before each change. That is a one-time job; afterwards ' +
            'Antigravity is one more agent you can use or ignore, and nothing in AionDX needs it.</div></div>' +
        '</div>' +
        '<div class="aiondx-welcome-status" aria-live="polite"></div>' +
        '<div class="aiondx-welcome-actions">' +
          '<button type="button" class="arco-btn arco-btn-primary arco-btn-size-default aiondx-w-signin">Sign in to Antigravity (free, with Google)</button>' +
          '<button type="button" class="arco-btn arco-btn-secondary arco-btn-size-default aiondx-w-alt" hidden></button>' +
          '<button type="button" class="arco-btn arco-btn-secondary arco-btn-size-default aiondx-w-external" ' +
            'title="Any agent that can read and write files on this PC can do this setup instead: Claude in Claude Desktop, Claude Code, Codex, and others. AionDX gives you a brief to paste into it.">Use another agent instead</button>' +
          (oneClick() ? '<button type="button" class="arco-btn arco-btn-secondary arco-btn-size-default aiondx-w-back">Back</button>' : '') +
          '<button type="button" class="arco-btn arco-btn-text arco-btn-size-default aiondx-w-later">Not now</button>' +
        '</div>' +
        '<p class="aiondx-welcome-foot">Not now closes this; Settings &gt; Appearance &gt; Open AionDX setup brings it back.</p>';
      var agyBack = box.querySelector('.aiondx-w-back');
      if (agyBack) agyBack.addEventListener('click', function () { showWelcome(1); });
      box.querySelector('.aiondx-w-signin').addEventListener('click', function (ev) { once(ev.currentTarget, startWelcomeSignin); });
      box.querySelector('.aiondx-w-external').addEventListener('click', function () { welcome.mode = 'external'; showWelcome(2); });
      box.querySelector('.aiondx-w-alt').addEventListener('click', function () {
        if (!welcome.alt) return;
        welcome.mode = 'agent';
        welcome.via = welcome.alt;
        showWelcome(2);
      });
      box.querySelector('.aiondx-w-later').addEventListener('click', laterWelcome);
      refreshWelcomeStatus();
    } else {
      var external = welcome.mode === 'external';
      var via = welcome.via || welcome.agy;
      var viaName = via ? via.name : 'Antigravity';
      box.innerHTML =
        '<h2 id="aiondx-welcome-title" class="aiondx-welcome-title">Set up your agents</h2>' +
        '<p class="aiondx-welcome-text"></p>' +
        '<label class="aiondx-welcome-label" for="aiondx-welcome-prefs">Instructions for all your agents</label>' +
        '<textarea id="aiondx-welcome-prefs" class="aiondx-welcome-prefs" rows="5" placeholder="How every agent should work for you: language, tone, what to always or never do. Leave empty to keep what your other apps already have."></textarea>' +
        '<div class="aiondx-welcome-label">Bring over what you already use</div>' +
        '<div class="aiondx-welcome-options"></div>' +
        '<div class="aiondx-welcome-actions">' +
          (external
            ? '<button type="button" class="arco-btn arco-btn-primary arco-btn-size-default aiondx-w-copy">Copy the setup brief</button>'
            : '<button type="button" class="arco-btn arco-btn-primary arco-btn-size-default aiondx-w-go"></button>') +
          '<button type="button" class="arco-btn arco-btn-secondary arco-btn-size-default aiondx-w-back">Back</button>' +
          '<button type="button" class="arco-btn arco-btn-text arco-btn-size-default aiondx-w-later">Not now</button>' +
        '</div>' +
        '<div class="aiondx-welcome-status" aria-live="polite"></div>';
      box.querySelector('.aiondx-welcome-text').textContent = external
        ? 'Your agent will do this setup. Choose what it should bring over, then copy the brief and paste it into that agent.'
        : viaName + ' will do this setup. It shows you what it found and asks before it copies or changes anything.';
      var goBtn = box.querySelector('.aiondx-w-go');
      if (goBtn) goBtn.textContent = 'Let ' + viaName + ' set it up';
      var opts = box.querySelector('.aiondx-welcome-options');
      WELCOME_OPTIONS.forEach(function (o) {
        var lab = document.createElement('label');
        lab.className = 'aiondx-welcome-option';
        lab.innerHTML = '<input type="checkbox"><span><span class="aiondx-welcome-option-title"></span><span class="aiondx-welcome-option-desc"></span></span>';
        lab.querySelector('input').setAttribute('data-opt', o[0]);
        lab.querySelector('input').checked = o[1];
        lab.querySelector('.aiondx-welcome-option-title').textContent = o[2];
        lab.querySelector('.aiondx-welcome-option-desc').textContent = o[3];
        opts.appendChild(lab);
      });
      box.querySelector('.aiondx-w-back').addEventListener('click', function () { welcome.mode = null; showWelcome('agy'); });
      box.querySelector('.aiondx-w-later').addEventListener('click', laterWelcome);
      var go = box.querySelector('.aiondx-w-go');
      if (go) go.addEventListener('click', function (ev) { once(ev.currentTarget, sendWelcomeBrief); });
      var copy = box.querySelector('.aiondx-w-copy');
      if (copy) copy.addEventListener('click', function () {
        var brief = welcomeBrief('external');
        var st = box.querySelector('.aiondx-welcome-status');
        var ok = function () {
          st.textContent = 'Copied. Paste it into Claude Desktop, Claude Code or another agent that can read and write files on this PC.';
          saveWelcome({ done: true, mode: 'external' });
        };
        (navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(brief) : Promise.reject())
          .then(ok, function () {
            var ta = document.createElement('textarea'); ta.value = brief; document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); ok(); } catch (e) { st.textContent = 'Could not copy; select the text below.'; } ta.remove();
          });
      });
      var ta = box.querySelector('.aiondx-welcome-prefs');
      if (welcome.data && welcome.data.prefs) ta.value = welcome.data.prefs;
      ta.addEventListener('input', function () { welcome.prefsDraft = ta.value; });
    }
    paintWelcomeButtons();
    var focus = welcome.el.querySelector('.arco-btn-primary');
    if (focus) try { focus.focus(); } catch (e) {}
  }
  function laterWelcome() { saveWelcome({ mode: 'later' }); closeWelcome(); }
  function welcomeStatus(text, code) {
    var st = welcome.el && welcome.el.querySelector('.aiondx-welcome-status');
    if (!st) return;
    st.textContent = text;
    if (!code) return;
    var c = document.createElement('code');
    c.className = 'aiondx-welcome-code';
    c.textContent = code;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'arco-btn arco-btn-secondary arco-btn-size-mini aiondx-welcome-copy';
    b.textContent = 'Copy';
    b.addEventListener('click', function () {
      var done = function () { b.textContent = 'Copied'; };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done, function () {});
    });
    st.appendChild(c);
    st.appendChild(b);
  }

  /** Is Antigravity's CLI installed (AionUi's own health check) and signed in (the wrapper's record)? */
  async function refreshWelcomeStatus() {
    var list = await loadAgents(true);
    var a = null;
    for (var i = 0; i < list.length; i++) if (list[i].backend === 'antigravity') { a = list[i]; break; }
    welcome.agy = a;
    welcome.alt = pickSetupAgent(list);
    if (!welcome.el || welcome.step !== 'agy') return;
    if (!a || !agentOnline(a)) {
      welcomeStatus('Antigravity\'s command-line tool is not on this PC yet. Paste this into PowerShell, then restart AionDX' +
        (welcome.alt ? ', or set up with ' + welcome.alt.name + ' now' : '') + ':', AGY_INSTALL);
      showAlt(true);
    } else {
      welcomeStatus('Antigravity is installed. Signing in opens Google in your browser; come back here when it is done.');
      showAlt(false);
    }
  }

  /** Step 1: open a chat with Antigravity; its first turn signs it in (the wrapper shows the sign-in panel). */
  async function startWelcomeSignin() {
    var a = welcome.agy || await findAgent(function (x) { return x.backend === 'antigravity'; });
    if (!a) {
      welcomeStatus('Antigravity is not in AionDX\'s agent list. Restart AionDX after installing it' + (welcome.alt ? ', or set up with ' + welcome.alt.name + '.' : '.'));
      showAlt(true);
      return;
    }
    welcome.mode = null;
    welcome.signinFailed = false;
    if (welcome.polling) { welcomeStatus('Antigravity is starting. If a Google page opened in your browser, finish the sign-in there.'); return; }
    welcome.startedAt = Date.now();
    var conv = welcome.conv;
    if (!conv) {
      welcomeStatus('Starting Antigravity...');
      conv = await createChat(a, 'Hello. I am setting up AionDX with you. Reply with the single word READY.', 'AionDX setup');
      if (!conv) { welcomeStatus('Could not start a chat with Antigravity. Check Settings > Agents, then try again.'); return; }
      welcome.conv = conv;
      saveWelcome({ conv: conv, mode: 'antigravity' });
    } else {
      var again = await postJson('/api/conversations/' + conv + '/messages', { content: 'Reply with the single word READY.' });
      if (!again.ok) { welcomeStatus('Could not reach the Antigravity chat (' + again.status + '). Try again.'); return; }
    }
    welcomeStatus('Sign in with Google in the browser window that opens. This screen moves on by itself once you are signed in.');
    welcome.polling = true;
    // Signed in already: its reply arrives with no sign-in; move on once it answers.
    var tries = 0, slowTold = false;
    var timer = setInterval(async function () {
      tries++;
      if (!welcome.el || welcome.step !== 'agy' || tries > 120) { clearInterval(timer); welcome.polling = false; return; }
      var msgs = await getMessages(conv, 10);
      var ready = msgs && msgs.some(function (m) { return m.position === 'left' && /^\W*READY\W*$/i.test(String(msgText(m)).trim()); });
      if (ready) { clearInterval(timer); welcome.polling = false; welcome.mode = null; welcome.via = a; showWelcome(2); return; }
      if (!slowTold && Date.now() - welcome.startedAt > WELCOME_ALT_AFTER_MS && !welcome.signinFailed) {
        slowTold = true;
        welcomeStatus('Antigravity has not answered yet. If a Google page opened in your browser, finish the sign-in there' +
          (welcome.alt ? ', or set up with ' + welcome.alt.name + ' instead.' : '.'));
        showAlt(true);
      }
    }, 3000);
  }

  /** Step 2: the brief goes to the Antigravity chat, and the user is taken there to watch. */
  async function sendWelcomeBrief() {
    var brief = welcomeBrief('agent');
    var prefsBox = welcome.el && welcome.el.querySelector('.aiondx-welcome-prefs');
    var prefs = prefsBox ? prefsBox.value : '';
    var via = welcome.via || welcome.agy || await findAgent(function (x) { return x.backend === 'antigravity'; });
    var isAgy = !!via && via.backend === 'antigravity';
    // Antigravity's own sign-in chat carries on; any other agent gets a chat of its own.
    var conv = isAgy ? (welcome.conv || (welcome.data && welcome.data.conv)) : null;
    if (!conv) {
      conv = via ? await createChat(via, brief, 'AionDX setup') : null;
      if (!conv) { welcomeStatus('Could not start a chat with ' + (via ? via.name : 'Antigravity') + '.'); return; }
    } else {
      var r = await postJson('/api/conversations/' + conv + '/messages', { content: brief });
      if (!r.ok) { welcomeStatus('Could not send the brief (' + r.status + ').'); return; }
    }
    saveWelcome({ done: true, mode: isAgy ? 'antigravity' : 'agent', agent: via ? via.id : null, conv: conv, prefs: prefs });
    closeWelcome();
    location.hash = '#/conversation/' + conv;
  }

  // ---------------------------------------------------------------- Respond now (rebuilt 2026-10-01)

  // K, 2026-09-26: "a llm often gets backlogged in messages. I would like a way to place my messages at the top of the queue. two ways: a
  // little tick box in the top right of each message box 'Respond Now' and on messages already sent and unread/queued, a button to the left of
  // the message that's a lightning bolt ... and has a tooltip". Build 2026-09-26.1 read that as "stop the agent": the tick box and the bolt
  // cancelled the running turn, or sent a "Respond now: stop what you are doing..." note that only piled onto the queue. K, 2026-10-01: "all
  // your 'respond now' button does is send another message ... that message just gets piled on right? This is maybe the dumbest implementation
  // i have ever seen ... seems like the lightning bolt actually stops the agent, that's not what i intended. i want the message to go to the
  // top of their message queue to be seen next, not stop pending processes".
  //
  // It is for team columns now, and goes through AionCore patch core-0002 (POST /api/teams/{id}/agents/{slot}/steer):
  //   - tick, then send: the message goes into the member's running turn when its agent takes messages mid-turn (Claude, Codex), which reads
  //     it at its next step, and is otherwise first in the member's queue. {content}
  //   - the bolt beside a message of yours still waiting in a member's queue does the same for that message. {message_id}
  // Nothing is stopped and no note is sent. A solo chat has neither: its agent takes a message at its next step already (the "Unread" badge).
  // The bolts come from run-state slot_work[].queued_foreground_message_ids (core-0002), matched by text through the team's mailbox
  // (GET /api/teams/{id}/mailbox) to your messages in the member's chat, so a message has its bolt exactly while it waits in the queue and
  // loses it when the member's turn starts on it. An AionCore without core-0002 has neither the route nor the list: no bolts, and a ticked
  // send goes as usual.
  var ICON_BOLT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z" fill="currentColor"/></svg>';
  var rnBoxes = [];          // tick boxes on screen
  var rnBolts = [];          // bolt buttons on screen
  var rnBusy = {};           // member + message -> a bolt's request in flight
  var steerGone = false;     // this AionCore has no steer route: a ticked send goes as usual

  function panelOf(node) { return node && node.closest ? node.closest('.sendbox-panel') : null; }
  function boxIn(panel) {
    var box = panel && panel.querySelector('[data-testid="sendbox-input"]');
    return box ? (/^(TEXTAREA|INPUT)$/.test(box.tagName) ? box : box.querySelector('textarea, input')) : null;
  }
  function steerAgent(t, body) {
    return postJson('/api/teams/' + t.teamId + '/agents/' + encodeURIComponent(t.slotId) + '/steer', body);
  }
  function rnWho(t) { return (teamCache[t.teamId] && teamCache[t.teamId].names[t.slotId]) || 'The member'; }
  function steerNotice(t, outcome) {
    var who = rnWho(t);
    if (outcome === 'delivered_midturn') return who + ' has your message now and reads it at its next step. Nothing was stopped.';
    if (outcome === 'queued_first' || outcome === 'moved_to_front') {
      return 'Your message is first in ' + who + "'s queue, and is read as soon as its current turn ends. That agent cannot take a message in the middle of a turn. Nothing was stopped.";
    }
    if (outcome === 'not_queued') return 'That message has been read already.';
    return 'Done.';
  }
  async function steerAnswer(r) {
    var j = null;
    try { j = await r.json(); } catch (e) {}
    var d = j ? unwrap(j) : null;
    return d && d.outcome ? d.outcome : '';
  }
  /** Without the steer route the message goes the way AionUi would have sent it. */
  function sendAsUsual(t, text) {
    return postJson(isLeadRole(t.role) ? '/api/teams/' + t.teamId + '/messages' : '/api/teams/' + t.teamId + '/agents/' + encodeURIComponent(t.slotId) + '/messages', { content: text });
  }

  /** The tick box was on when you sent: the message goes ahead of the member's queue, and into its running turn if it can take it. */
  function maybeRespondNow(ev, node) {
    if (disabled()) return;
    var panel = panelOf(node);
    var cb = panel && panel.querySelector('.aiondx-rn input');
    if (!cb || !cb.checked) return;
    if (panel.classList.contains('overflow-visible')) return;   // a slash or @ menu is open: Enter picks from it
    var ta = boxIn(panel);
    var text = ta ? (ta.value || '') : '';
    if (!text.trim() || /^\s*\//.test(text)) return;
    var t = targetOf(node);
    if (!t || t.kind !== 'team') return;
    var a = agentLive[t.key];
    var busy = a && (a.state === 'working' || a.state === 'queued');
    cb.checked = false;
    if (!busy || steerGone) return;                            // idle, or no steer route: AionUi sends it as usual
    ev.preventDefault(); ev.stopImmediatePropagation();
    setComposerValue(ta, '');
    userSent(node, text);
    var back = function (why) { setComposerValue(ta, text); notify(t, why, ''); };
    steerAgent(t, { content: text }).then(async function (r) {
      if (r.status === 404 || r.status === 405) {
        steerGone = true;
        var u = await sendAsUsual(t, text);
        if (u.ok) notify(t, 'Sent as usual: this AionCore cannot put a message ahead of the queue yet.', '');
        else back('Could not send it (' + u.status + '); it is back in the box.');
        return;
      }
      if (!r.ok) { back('Could not put it first (' + r.status + '); it is back in the box.'); return; }
      notify(t, steerNotice(t, await steerAnswer(r)), '');
      scanTeamQueues().catch(function () {});
    }, function () { back("Could not reach AionDX's backend; your message is back in the box."); });
  }
  function watchRespondNow() {
    window.addEventListener('keydown', function (ev) {
      var enter = ev.key === 'Enter' || ev.code === 'Enter' || ev.code === 'NumpadEnter' || ev.keyCode === 13;
      if (!enter || ev.shiftKey || ev.ctrlKey || ev.metaKey || ev.altKey || ev.isComposing || composingNow) return;
      var el = ev.target;
      if (!el || !el.closest || !el.closest('[data-testid="sendbox-input"]')) return;
      maybeRespondNow(ev, el);
    }, true);
    window.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('[data-testid="sendbox-send-btn"]') : null;
      if (b && !b.disabled) maybeRespondNow(ev, b);
    }, true);
  }

  /** A queued message's bolt: it goes to the top of the member's queue, and into its running turn if that can take it. */
  function boltClick(t, mailboxId) {
    var key = t.key + '/' + mailboxId;
    if (rnBusy[key]) return;
    rnBusy[key] = true;
    var done = function (text) {
      delete rnBusy[key];
      notify(t, text, '');
      scanTeamQueues().catch(function () {});
    };
    steerAgent(t, { message_id: mailboxId }).then(async function (r) {
      if (r.status === 404 || r.status === 405) { steerGone = true; done('This AionCore cannot move a message ahead of the queue yet.'); return; }
      if (!r.ok) { done('Could not move it (' + r.status + ').'); return; }
      done(steerNotice(t, await steerAnswer(r)));
    }, function () { done("Could not reach AionDX's backend."); });
    renderRespondNow();
  }
  function makeBolt(t, mailboxId) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'aiondx-rn-bolt';
    b.setAttribute('data-testid', 'aiondx-respond-now');
    b.innerHTML = ICON_BOLT;
    b.title = 'Respond now: this message goes to the top of the queue and is read at the agent\'s next step. Nothing it is doing is stopped.';
    b.setAttribute('aria-label', 'Respond now');
    b.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); boltClick(b._t, b._mid); });
    return b;
  }

  var rnQueued = {};         // member conversation id -> { t, items: [{ bubble: message id in the chat, id: mailbox id }] }
  /** A tick box in every team message box, and a bolt beside each message of yours that still waits in a member's queue. */
  function renderRespondNow() {
    var liveBoxes = [], liveBolts = [];
    if (!disabled()) {
      targets().forEach(function (t) {
        if (t.kind !== 'team') return;
        var panel = t.actions && t.actions.closest('.sendbox-panel');
        if (!panel) return;
        var lab = panel.querySelector('.aiondx-rn');
        if (!lab) {
          lab = document.createElement('label');
          lab.className = 'aiondx-rn';
          lab.setAttribute('data-testid', 'aiondx-respond-now-box');
          lab.title = 'Respond now: when you send, the agent reads this message at its next step, ahead of everything else queued for it. Nothing it is doing is stopped.';
          lab.innerHTML = '<input type="checkbox"><span>Respond now</span>';
          panel.appendChild(lab);
        }
        liveBoxes.push(lab);
      });
      var r = route();
      if (r && r.kind === 'team') {
        Object.keys(rnQueued).forEach(function (conv) {
          var q = rnQueued[conv];
          q.items.forEach(function (it) {
            var row = document.getElementById('message-' + it.bubble);
            var qb = row && placeBolt(row, q.t, it.id);
            if (qb) liveBolts.push(qb);
          });
        });
      }
    }
    rnBoxes.forEach(function (el) { if (liveBoxes.indexOf(el) < 0 && el.parentNode) el.parentNode.removeChild(el); });
    rnBolts.forEach(function (el) { if (liveBolts.indexOf(el) < 0 && el.parentNode) el.parentNode.removeChild(el); });
    rnBoxes = liveBoxes;
    rnBolts = liveBolts;
  }
  /** The bolt hangs off the left edge of the message's bubble (the box around message-text-content). */
  function placeBolt(row, t, mailboxId) {
    var content = row.querySelector('[data-testid="message-text-content"]');
    var host = content && content.parentElement;
    if (!host) return null;
    var b = host.querySelector(':scope > .aiondx-rn-bolt');
    if (!b) { b = makeBolt(t, mailboxId); host.appendChild(b); }
    if (!host.classList.contains('aiondx-rn-host')) host.classList.add('aiondx-rn-host');
    b._t = t;
    b._mid = mailboxId;
    b.disabled = !!rnBusy[t.key + '/' + mailboxId];
    return b;
  }
  function normText(x) { return String(x || '').replace(/\s+/g, ' ').trim(); }
  /** For team pages, every few seconds: which of your messages each member still has waiting in its queue. */
  async function scanTeamQueues() {
    var r = route();
    if (!r || r.kind !== 'team' || disabled()) { if (Object.keys(rnQueued).length) { rnQueued = {}; renderRespondNow(); } return; }
    var next = {};
    try {
      var rs = await getJson('/api/teams/' + r.id + '/run-state');
      var ws = ((rs.data && rs.data.slot_work) || []).filter(function (w) { return w && Array.isArray(w.queued_foreground_message_ids) && w.queued_foreground_message_ids.length; });
      if (ws.length) {
        var mb = await getJson('/api/teams/' + r.id + '/mailbox?limit=400');
        var rows = Array.isArray(mb.data) ? mb.data : ((mb.data && mb.data.messages) || []);
        var byId = {};
        rows.forEach(function (m) { if (m && m.id) byId[m.id] = m; });
        for (var i = 0; i < ws.length; i++) {
          var w = ws[i];
          var t = { kind: 'team', key: 'team:' + r.id + ':' + w.slot_id, teamId: r.id, slotId: w.slot_id, role: w.role || '' };
          var mc = await memberConversation(t);
          if (!mc.convId) continue;
          var msgs = (await getMessages(mc.convId, 40)) || [];
          var used = {}, items = [];
          w.queued_foreground_message_ids.forEach(function (mid) {
            var row = byId[mid];
            if (!row) return;
            var want = normText(row.content);
            for (var k = msgs.length - 1; k >= 0; k--) {
              var m = msgs[k];
              if (m.position !== 'right' || m.hidden || used[m.id]) continue;
              if (normText(msgText(m)) === want) { used[m.id] = true; items.push({ bubble: m.id, id: mid }); break; }
            }
          });
          if (items.length) next[mc.convId] = { t: t, items: items };
        }
      }
    } catch (e) {
      return;   // a read that failed says nothing about the queue: what is on screen stays until the next one
    }
    rnQueued = next;
    renderRespondNow();
  }

  // ---------------------------------------------------------------- unsend (build 2026-09-25.5)

  // K, 2026-09-25: "want the ability to unsend messages that haven't been read yet ... I mean what's
  // been sent in chat and unread". A message sent to a Claude chat while it works shows "Unread"
  // until Claude takes it: AionCore writes it straight into Claude's input with the message's msg_id
  // as its uuid, and Claude holds it in its own command queue until its next step. Claude drops a
  // queued message on a cancel_async_message control request naming that uuid (tested live
  // 2026-09-25, tools\cancel-queued-test.js). AionDX's account router (patch 0002) sits between
  // AionCore and Claude, so Unsend records aiondx.unsend.req.<msg_id> in the settings store; the
  // router running that chat sees it within a second, sends the cancel, and answers in
  // aiondx.unsend.result.<msg_id>. An unsent message stays in the chat, struck through and marked
  // Unsent; AionCore still has the row. Research: ! LLM Files\Research\2026-09-25_unsend-queued-messages.md.
  var UNSEND_REQ = 'aiondx.unsend.req.';
  var UNSEND_RES = 'aiondx.unsend.result.';
  var UNSEND_WAIT_MS = 20000;
  var unsendResults = {};    // msg_id -> { cancelled, conv, messageId, at, error }
  var unsendPending = {};    // message id -> { conv, msgId, at }
  var unsendShown = {};      // msg_id -> result already announced and cleared from the store

  function convTarget(convId) { return { kind: 'conv', key: 'conv:' + convId, convId: convId }; }

  function takeUnsend(data) {
    var res = {};
    Object.keys(data).forEach(function (k) {
      if (k.indexOf(UNSEND_RES) !== 0) return;
      var v = data[k];
      if (v && typeof v === 'object') res[k.slice(UNSEND_RES.length)] = v;
    });
    Object.keys(unsendShown).forEach(function (k) { if (!res[k]) res[k] = unsendShown[k]; });
    unsendResults = res;
    Object.keys(unsendPending).forEach(function (mid) {
      var p = unsendPending[mid];
      var r = p.msgId ? res[p.msgId] : null;
      if (!r) {
        if (p.msgId && Date.now() - p.at > UNSEND_WAIT_MS) {
          delete unsendPending[mid];
          var clear = {};
          clear[UNSEND_REQ + p.msgId] = null;
          putPrefs(clear);
          notify(convTarget(p.conv), 'Not unsent: this chat\'s Claude process did not answer.',
            'It can unsend once it has restarted with the current AionDX router (Reconnect agent, or AionUi\'s next start).');
        }
        return;
      }
      delete unsendPending[mid];
      // Shown once: the router's answer can go from the store (the struck-through row keeps its mark here).
      unsendShown[p.msgId] = r;
      var drop = {};
      drop[UNSEND_RES + p.msgId] = null;
      putPrefs(drop);
      if (r.cancelled) notify(convTarget(p.conv), 'Unsent. The agent never saw it.', '');
      else notify(convTarget(p.conv), 'Too late to unsend: the agent had already picked it up.', r.error ? String(r.error) : '');
    });
  }

  async function unsendMessage(convId, messageId) {
    if (unsendPending[messageId]) return;
    unsendPending[messageId] = { conv: convId, msgId: null, at: Date.now() };
    renderUnsend();
    var fail = function (text) { delete unsendPending[messageId]; notify(convTarget(convId), text, ''); renderUnsend(); };
    try { await unsendSteps(convId, messageId, fail); }
    catch (e) { fail('Could not unsend: ' + (e && e.message ? e.message : 'the request failed') + '.'); }
  }
  async function unsendSteps(convId, messageId, fail) {
    var m = null;
    var g = await getJson('/api/conversations/' + convId + '/messages/' + encodeURIComponent(messageId));
    if (!g.err && g.data) m = g.data.message || g.data;
    if (!m || !(m.msg_id || m.msgId)) {
      var list = await getMessages(convId, 80);
      for (var i = 0; list && i < list.length; i++) if (list[i].id === messageId) { m = list[i]; break; }
    }
    var msgId = m && (m.msg_id || m.msgId);
    if (!msgId) { fail('Could not unsend: the message was not found.'); return; }
    if (m.status && m.status !== 'pending') { fail('Too late to unsend: the agent already picked it up.'); return; }
    unsendPending[messageId].msgId = msgId;
    unsendPending[messageId].at = Date.now();
    var body = {};
    body[UNSEND_REQ + msgId] = { conv: convId, messageId: messageId, at: Date.now() };
    var w = await putPrefs(body);
    if (!w || !w.ok) { fail('Could not unsend: the request could not be saved.'); return; }
    pullShared().catch(function () {});
  }

  /** An Unsend button inside each "Unread" badge of a Claude chat; unsent messages marked. */
  function renderUnsend() {
    var r = route();
    if (!r || r.kind !== 'conv' || disabled()) return;
    var info = convInfo[r.id];
    if (!info || Date.now() - info.at > CONV_INFO_MS) loadConvInfo(r.id);
    if (info && info.backend === 'claude') {
      var badges = document.querySelectorAll('[data-testid="message-status-badge"]');
      for (var i = 0; i < badges.length; i++) {
        var badge = badges[i];
        var row = badge.closest('[id^="message-"]');
        if (!row) continue;
        var mid = row.id.slice('message-'.length);
        var btn = badge.querySelector('.aiondx-unsend');
        if (!btn) {
          btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'aiondx-unsend';
          btn.setAttribute('data-testid', 'aiondx-unsend');
          btn.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            var b = ev.currentTarget;
            unsendMessage(b._conv, b._mid).catch(function (e) { console.log('[dx] unsend error', e); });
          });
          badge.appendChild(btn);
        }
        btn._conv = r.id;
        btn._mid = mid;
        var pending = !!unsendPending[mid];
        var label = pending ? 'Unsending...' : 'Unsend';
        if (btn.textContent !== label) btn.textContent = label;
        btn.disabled = pending;
      }
    }
    Object.keys(unsendResults).forEach(function (msgId) {
      var res = unsendResults[msgId];
      if (!res || !res.cancelled || res.conv !== r.id || !res.messageId) return;
      var el = document.getElementById('message-' + res.messageId);
      if (el && el.getAttribute('data-aiondx-unsent') !== '1') el.setAttribute('data-aiondx-unsent', '1');
    });
  }

  // ---------------------------------------------------------------- styles

  // The team icon shown in place of an idle team's spinner (see reconcileSpinners), as a CSS mask.
  var SPIN_ICON = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48' fill='none' stroke='black' stroke-width='4' stroke-linecap='round'>" +
    "<circle cx='19' cy='15' r='7'/><path d='M5 41c0-8 6-13 14-13s14 5 14 13'/><circle cx='35' cy='16' r='5'/><path d='M36 28c5 0 8 4 8 10'/></svg>";
  var CSS = [
    '.aiondx-loop{display:inline-flex;flex:0 0 auto;margin-inline-end:4px}',
    '.aiondx-loop .aiondx-loop-btn{display:inline-flex;align-items:center;justify-content:center;',
    '  transition:background-color .15s,border-color .15s}',
    '.aiondx-loop-icon{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;',
    '  width:14px;height:14px;color:var(--color-text-3)}',
    '.aiondx-loop-icon svg{display:block;width:100%;height:100%}',
    // On: the theme's primary colour, as a tint and a ring. Waiting (a paused member sitting out
    // a limit, or a backoff after a short reply): the theme's warning amber, the same way.
    '.sendbox-actions .aiondx-loop--on .aiondx-loop-btn,',
    '.sendbox-actions .aiondx-loop--on .aiondx-loop-btn:hover{background-color:rgba(var(--primary-6),.14) !important;',
    '  border-color:rgb(var(--primary-6)) !important}',
    '.aiondx-loop--on .aiondx-loop-icon{color:rgb(var(--primary-6))}',
    '.sendbox-actions .aiondx-loop--waiting .aiondx-loop-btn,',
    '.sendbox-actions .aiondx-loop--waiting .aiondx-loop-btn:hover{background-color:rgba(var(--warning-6),.16) !important;',
    '  border-color:rgb(var(--warning-6)) !important}',
    '.aiondx-loop--waiting .aiondx-loop-icon{color:rgb(var(--warning-6))}',
    // The agent's own state, read from the backend every 3 s for the chats on screen (K,
    // 2026-09-24: AionUi's own "processing" marker can vanish while the agent is still
    // printing). A green dot while the agent works, a red dot while it is paused or blocked.
    // The dot is the signal that always shows: K's Windows has animations switched off, which
    // Chromium reports as prefers-reduced-motion, so a spinning icon alone would never appear
    // for him. Where motion is allowed the icon also turns.
    '.aiondx-loop .aiondx-loop-btn{position:relative;overflow:visible}',
    '.aiondx-loop--busy .aiondx-loop-btn::after,.aiondx-loop--dead .aiondx-loop-btn::after{content:"";position:absolute;',
    '  top:-2px;right:-2px;width:9px;height:9px;border-radius:50%;box-shadow:0 0 0 2px var(--color-bg-2)}',
    '.aiondx-loop--busy .aiondx-loop-btn::after{background:rgb(var(--success-6))}',
    '.aiondx-loop--dead .aiondx-loop-btn::after{background:rgb(var(--danger-6))}',
    // An agent changed this Loop through the AionDX Loop tool: a purple mark at the bottom right of
    // the button for 10 minutes, with a notice at the top of the window when it happens.
    '.aiondx-loop--agent .aiondx-loop-btn::before{content:"";position:absolute;bottom:-2px;right:-2px;width:9px;height:9px;',
    '  border-radius:50%;background:rgb(var(--purple-6,114,46,209));box-shadow:0 0 0 2px var(--color-bg-2)}',
    '.aiondx-toasts{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:10060;display:flex;',
    '  flex-direction:column;align-items:center;gap:8px;pointer-events:none}',
    '.aiondx-toasts .aiondx-toast{display:flex;align-items:flex-start;gap:8px;max-width:440px;margin:0;text-align:left;',
    '  line-height:20px;pointer-events:auto}',
    '.aiondx-toast-icon{display:inline-flex;flex-shrink:0;width:16px;height:16px;margin-top:2px;color:rgb(var(--purple-6,114,46,209))}',
    '.aiondx-toast-icon svg{display:block;width:100%;height:100%}',
    '.aiondx-toast-body{display:flex;flex-direction:column;font-size:14px;color:var(--color-text-1)}',
    '.aiondx-toast-sub{font-size:12px;line-height:18px;color:var(--color-text-3)}',
    // Where a notice happened, and a click that opens it.
    '.aiondx-toast-where{font-size:12px;line-height:18px;font-weight:600;color:var(--color-text-2)}',
    '.aiondx-toasts .aiondx-toast--link{cursor:pointer}',
    '.aiondx-toasts .aiondx-toast--link:hover,.aiondx-toasts .aiondx-toast--link:focus-visible{outline:none;',
    '  box-shadow:0 0 0 1px rgb(var(--primary-6)),0 4px 10px rgba(0,0,0,.12)}',
    // The ring around the Loop button: the agent's cache time left, drawn as an arc (no animation;
    // it is redrawn every 3 s). Amber in the last quarter.
    '.aiondx-loop{position:relative}',
    '.aiondx-loop--warm::before{content:"";position:absolute;left:-3px;top:-3px;width:34px;height:34px;border-radius:50%;',
    '  pointer-events:none;background:conic-gradient(rgb(var(--aiondx-ring,var(--primary-6))) calc(var(--aiondx-warm,0) * 360deg),',
    '  transparent 0);-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 2px),#000 calc(100% - 2px));',
    '  mask:radial-gradient(farthest-side,transparent calc(100% - 2px),#000 calc(100% - 2px))}',
    '.aiondx-loop--warm-low{--aiondx-ring:var(--warning-6)}',
    // Resting: on, but not nudging until the agent works again.
    '.sendbox-actions .aiondx-loop--resting .aiondx-loop-btn{border:1px dashed rgb(var(--primary-6)) !important}',
    // On until the user stops it: an infinity mark at the button's lower right.
    '.aiondx-loop{position:relative}',
    '.aiondx-loop--forever::after{content:"\\221E";position:absolute;right:-3px;bottom:-4px;min-width:12px;height:12px;padding:0 1px;',
    '  border-radius:6px;background:rgb(var(--primary-6));color:#fff;font-size:10px;font-weight:700;line-height:12px;text-align:center;',
    '  pointer-events:none;box-shadow:0 0 0 1px var(--color-bg-2)}',
    '.aiondx-loop--resting .aiondx-loop-icon{color:rgb(var(--primary-6));opacity:.65}',
    '.aiondx-dot--resting{background:transparent;border:1px dashed rgb(var(--primary-6));box-sizing:border-box}',
    '.aiondx-ringkey{display:inline-block;width:10px;height:10px;border-radius:50%;box-sizing:border-box;',
    '  border:2px solid rgb(var(--primary-6))}',
    '.aiondx-tip-cache{margin-bottom:6px}',
    // The menu's keep-warm choice.
    '.aiondx-hold{padding:2px 12px 8px}',
    '.aiondx-hold-title{font-size:12px;line-height:18px;color:var(--color-text-2);margin-bottom:4px}',
    '.aiondx-hold-row{display:flex;flex-wrap:wrap;gap:6px}',
    '.aiondx-menu .aiondx-hold-btn--on{background-color:rgba(var(--primary-6),.14) !important;',
    '  border-color:rgb(var(--primary-6)) !important;color:rgb(var(--primary-6)) !important}',
    '.aiondx-hold-desc{font-size:12px;line-height:17px;color:var(--color-text-3);margin-top:4px}',
    '.aiondx-resume .aiondx-hold-row{align-items:center}',
    '.aiondx-resume-time{width:104px;height:24px;padding:0 6px;border-radius:var(--border-radius-small,4px);',
    '  border:1px solid var(--color-border-2);background:var(--color-bg-2);color:var(--color-text-1);font-size:12px;color-scheme:light dark}',
    // Welcome to AionDX, the first-run screen.
    '.aiondx-welcome-backdrop{position:fixed;inset:0;z-index:10050;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55)}',
    '.aiondx-welcome{box-sizing:border-box;width:min(580px,92vw);max-height:90vh;overflow-y:auto;padding:28px 32px;border-radius:12px;',
    '  border:1px solid var(--color-border-2);background:var(--color-bg-2);color:var(--color-text-1);box-shadow:0 12px 48px rgba(0,0,0,.35)}',
    '.aiondx-welcome-mark{display:block;width:40px;height:40px;margin-bottom:10px}',
    '.aiondx-welcome-title{margin:0 0 6px;font-size:22px;line-height:30px;font-weight:600;color:var(--color-text-1)}',
    '.aiondx-welcome-text{margin:0 0 14px;font-size:14px;line-height:21px;color:var(--color-text-2)}',
    '.aiondx-welcome-facts{display:flex;flex-direction:column;gap:10px;margin:0 0 14px;padding:12px 14px;border:1px solid var(--color-border-2);',
    '  border-radius:8px;background:var(--color-fill-1)}',
    '.aiondx-welcome-fact-title{font-size:13px;font-weight:600;line-height:19px;color:var(--color-text-1)}',
    '.aiondx-welcome-fact-desc{font-size:12px;line-height:18px;color:var(--color-text-2);margin-top:2px}',
    '.aiondx-welcome-status{min-height:18px;margin:10px 0 0;font-size:13px;line-height:19px;color:var(--color-text-2);overflow-wrap:anywhere}',
    '.aiondx-welcome-code{display:block;margin-top:6px;padding:8px 10px;border-radius:6px;background:var(--color-fill-2);',
    '  font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:17px;white-space:pre-wrap;word-break:break-all;user-select:all}',
    '.aiondx-welcome-copy{margin-top:6px}',
    // The buttons stay at the dialog's bottom edge while the text above them scrolls (a laptop screen, or the
    // install line with Antigravity's explanation, is taller than 90vh).
    '.aiondx-welcome-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px;position:sticky;bottom:-28px;z-index:1;',
    '  padding:12px 0 14px;background:var(--color-bg-2);box-shadow:0 -10px 12px -12px rgba(0,0,0,.35)}',
    '.aiondx-welcome-foot{margin:18px 0 0;font-size:12px;line-height:17px;color:var(--color-text-3)}',
    '.aiondx-welcome-label{display:block;margin:16px 0 6px;font-size:13px;font-weight:600;color:var(--color-text-1)}',
    '.aiondx-welcome-prefs{box-sizing:border-box;width:100%;min-height:96px;resize:vertical;padding:8px 10px;border-radius:6px;',
    '  border:1px solid var(--color-border-2);background:var(--color-bg-1);color:var(--color-text-1);font:inherit;font-size:13px;line-height:19px}',
    '.aiondx-welcome-prefs:focus{outline:none;border-color:rgb(var(--primary-6))}',
    '.aiondx-welcome-options{display:grid;gap:10px}',
    '.aiondx-welcome-option{display:flex;gap:8px;align-items:flex-start;cursor:pointer;font-size:13px;line-height:18px}',
    '.aiondx-welcome-option input{margin-top:2px;flex:0 0 auto}',
    '.aiondx-welcome-option-title{display:block;font-weight:500;color:var(--color-text-1)}',
    '.aiondx-welcome-option-desc{display:block;font-size:12px;line-height:17px;color:var(--color-text-3);word-break:break-word}',
    // The one-click setup: what was found, per app, and what was done.
    '.aiondx-welcome-found{margin-top:4px}',
    '.aiondx-welcome-group{margin:14px 0 6px;font-size:12px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:var(--color-text-2)}',
    '.aiondx-welcome-done{margin:10px 0 0;padding-left:18px;display:grid;gap:8px;font-size:13px;line-height:19px;color:var(--color-text-1)}',
    '.aiondx-welcome-done li{word-break:break-word}',
    '.aiondx-setup-open{margin-top:8px}',
    // Claude Code plugins (/plugin).
    '.aiondx-plugins-backdrop[hidden]{display:none !important}',
    '.aiondx-plugins{position:relative;width:min(720px,94vw)}',
    '.aiondx-plugins-close{position:absolute;top:14px;right:16px;width:28px;height:28px;border:0;border-radius:6px;background:transparent;',
    '  color:var(--color-text-2);font-size:20px;line-height:28px;cursor:pointer}',
    '.aiondx-plugins-close:hover{background:var(--color-fill-2)}',
    '.aiondx-plugins-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between}',
    '.aiondx-plugins-tabs{display:flex;gap:4px}',
    '.aiondx-plugins-tab{height:28px;padding:0 12px;border:1px solid var(--color-border-2);border-radius:14px;background:transparent;',
    '  color:var(--color-text-2);font-size:13px;cursor:pointer}',
    '.aiondx-plugins-tab--on{border-color:rgb(var(--primary-6));color:rgb(var(--primary-6));background:rgba(var(--primary-6),.1)}',
    '.aiondx-plugins-search,.aiondx-plugins-source{box-sizing:border-box;height:28px;padding:0 10px;border-radius:6px;',
    '  border:1px solid var(--color-border-2);background:var(--color-bg-1);color:var(--color-text-1);font-size:13px}',
    '.aiondx-plugins-search{flex:1 1 200px;max-width:280px}',
    '.aiondx-plugins-search:focus,.aiondx-plugins-source:focus{outline:none;border-color:rgb(var(--primary-6))}',
    '.aiondx-plugins-status--bad{color:rgb(var(--danger-6))}',
    '.aiondx-plugins-list{display:flex;flex-direction:column;gap:6px;margin-top:8px;max-height:46vh;overflow-y:auto;padding-right:4px}',
    '.aiondx-plugins-row{display:flex;gap:12px;align-items:flex-start;padding:10px 12px;border:1px solid var(--color-border-2);',
    '  border-radius:8px;background:var(--color-fill-1)}',
    '.aiondx-plugins-main{flex:1 1 auto;min-width:0}',
    '.aiondx-plugins-name{font-size:14px;font-weight:600;line-height:20px;color:var(--color-text-1);word-break:break-word}',
    '.aiondx-plugins-meta{font-size:12px;line-height:17px;color:var(--color-text-3)}',
    '.aiondx-plugins-desc{margin-top:3px;font-size:12px;line-height:17px;color:var(--color-text-2);word-break:break-word}',
    '.aiondx-plugins-btns{display:flex;flex-wrap:wrap;gap:6px;flex:0 0 auto;justify-content:flex-end;max-width:230px}',
    '.aiondx-plugins-empty{padding:14px 4px;font-size:13px;color:var(--color-text-3)}',
    '.aiondx-plugins-add{display:flex;gap:8px}',
    '.aiondx-plugins-source{flex:1 1 auto}',
    '.aiondx-plugins-pending{padding:12px 14px;border:1px solid rgb(var(--warning-6));border-radius:8px;background:var(--color-fill-1)}',
    '.aiondx-plugins-pending .aiondx-welcome-actions{position:static;padding:8px 0 0;box-shadow:none;background:transparent}',
    '.aiondx-w-alt[hidden]{display:none !important}',
    '[data-aiondx-drift="1"]{display:none !important}',
    // The Claude usage meter: two thin bars (5-hour, week) and their percentages.
    '.aiondx-usage{display:inline-flex;align-items:center;gap:6px;flex:0 1 auto;min-width:0;margin-inline-end:8px;font-size:11px;',
    '  line-height:12px;color:var(--color-text-3);cursor:default;user-select:none}',
    '.aiondx-usage-bars{display:flex;flex-direction:column;gap:2px;width:72px;flex:0 0 auto}',
    '.aiondx-usage-bar{display:block;height:3px;border-radius:2px;background:var(--color-fill-3);overflow:hidden}',
    '.aiondx-usage-bar i{display:block;height:100%;border-radius:2px;transition:width .4s}',
    '.aiondx-usage-text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.aiondx-usage[data-limit="reached"] .aiondx-usage-text{color:rgb(var(--danger-6))}',
    '.aiondx-usage[data-narrow="1"]{display:none}',
    '.aiondx-usage[data-stale="1"]{opacity:.55}',
    '.aiondx-usage--compact{margin-inline-end:4px}',
    '.aiondx-usage--compact .aiondx-usage-text{display:none}',
    '.aiondx-usage--compact .aiondx-usage-bars{width:36px}',
    // Respond now: a small tick box in each message box's top-right corner (inside the box's top padding),
    // and a bolt to the left of a message still waiting in the queue.
    '.sendbox-panel:has(> .aiondx-rn){padding-top:24px !important}',
    // AionUi's own "Interrupt & send" (team members, while one works and you have typed): the same interrupt as Respond
    // now, as a wide button between the permission shield and the context meter (K, 2026-09-26: "it's the same thing
    // as ticking the respond now checkbox, and the button on the bottom takes up a way lot of space"). Found by its
    // lightning icon, so any language; AionDX's own controls are left alone.
    '.sendbox-actions .arco-btn:has(.i-icon-lightning):not([class*="aiondx"]){display:none !important}',
    '.aiondx-rn{position:absolute;top:5px;right:14px;z-index:2;display:inline-flex;align-items:center;gap:4px;',
    '  font-size:11px;line-height:14px;color:var(--color-text-3);cursor:pointer;user-select:none}',
    '.aiondx-rn input{width:11px;height:11px;margin:0;cursor:pointer}',
    '.aiondx-rn:has(input:checked){color:rgb(var(--warning-6))}',
    '.aiondx-rn-host{position:relative}',
    '.aiondx-rn-bolt{position:absolute;top:50%;right:calc(100% + 8px);transform:translateY(-50%);display:inline-flex;align-items:center;',
    '  justify-content:center;width:24px;height:24px;padding:0;border:1px solid var(--color-border-2);border-radius:50%;background:var(--color-bg-2);',
    '  color:rgb(var(--warning-6));cursor:pointer}',
    '.aiondx-rn-bolt:hover{background:rgba(var(--warning-6),.14);border-color:rgb(var(--warning-6))}',
    '.aiondx-rn-bolt[disabled]{opacity:.5;cursor:default}',
    '.aiondx-rn-bolt svg{width:13px;height:13px;display:block}',
    // Unsend, inside a Claude chat's "Unread" badge; an unsent message struck through.
    '[data-testid="message-status-badge"] .aiondx-unsend{margin-inline-start:8px;padding:0;border:none;background:none;',
    '  font:inherit;font-size:12px;color:rgb(var(--danger-6));cursor:pointer;user-select:none}',
    '[data-testid="message-status-badge"] .aiondx-unsend:hover{text-decoration:underline}',
    '[data-testid="message-status-badge"] .aiondx-unsend[disabled]{color:var(--color-text-3);cursor:default;text-decoration:none}',
    '[data-aiondx-unsent] [data-testid="message-text-content"] > *{text-decoration:line-through;opacity:.5}',
    '[data-aiondx-unsent] [data-testid="message-status-badge"]{display:none}',
    '[data-aiondx-unsent] [data-testid="message-text-content"]::after{content:"Unsent";display:block;margin-top:2px;',
    '  font-size:12px;color:var(--color-text-3);text-align:end}',
    // The account pill before AionUi's model picker, and its menu.
    '.aiondx-acct{display:inline-flex !important;align-items:center;gap:4px;flex-shrink:0;margin-inline-end:6px;max-width:120px}',
    '.aiondx-acct-icon{display:inline-flex;width:13px;height:13px;color:var(--color-text-3)}',
    '.aiondx-acct-icon svg{display:block;width:100%;height:100%}',
    '.aiondx-acct-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}',
    '.aiondx-acct.aiondx-acct--chosen{background-color:rgba(var(--primary-6),.12) !important;border-color:rgb(var(--primary-6)) !important}',
    '.aiondx-acct--chosen .aiondx-acct-icon{color:rgb(var(--primary-6))}',
    '.aiondx-acct.aiondx-acct--compact{width:24px;min-width:24px;height:24px;padding:0;margin-inline-end:0;justify-content:center;border-radius:50%}',
    '.aiondx-acct--compact .aiondx-acct-label{display:none}',
    '.aiondx-acct--compact .aiondx-acct-icon{width:13px;height:13px}',
    '.aiondx-acct-menu{width:320px}',
    '.aiondx-acct-menu .arco-dropdown-menu{max-height:min(420px,70vh);overflow-y:auto}',
    '.aiondx-acct-confirm{padding:2px 12px 10px;font-size:13px;line-height:19px;color:var(--color-text-1)}',
    '.aiondx-acct-btns{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}',
    // The Antigravity sign-in panel (patch 0008): stays until the sign-in lands or gives up.
    '.aiondx-signin{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:10061;display:flex;gap:10px;',
    '  align-items:flex-start;width:440px;max-width:calc(100vw - 32px);margin:0;padding:12px 16px;text-align:left;line-height:20px}',
    '.aiondx-signin-body{flex:1;min-width:0}',
    '.aiondx-signin-title{font-size:14px;font-weight:600;color:var(--color-text-1)}',
    '.aiondx-signin-msg{font-size:13px;color:var(--color-text-1);margin-top:2px}',
    '.aiondx-signin-hint{font-size:12px;color:var(--color-text-3);margin-top:6px}',
    '.aiondx-signin-row{display:flex;gap:8px;margin-top:6px}',
    '.aiondx-signin-code{flex:1;min-width:0;height:28px;padding:0 8px;border-radius:var(--border-radius-small,4px);',
    '  border:1px solid var(--color-border-2);background:var(--color-bg-2);color:var(--color-text-1);font-size:13px}',
    '.aiondx-signin-note{font-size:12px;color:var(--color-text-2);margin-top:4px;min-height:0}',
    '.aiondx-signin-close{flex:none;width:24px;height:24px;margin:-4px -8px 0 0;padding:0;border:0;border-radius:4px;',
    '  background:transparent;color:var(--color-text-3);font-size:18px;line-height:24px;cursor:pointer}',
    '.aiondx-signin-close:hover{background:var(--color-fill-2);color:var(--color-text-1)}',
    // The AionDX accent row under the theme gallery (patch 0009).
    '.aiondx-accent{margin:16px 0 4px;padding:14px 16px;border:1px solid var(--color-border-2);border-radius:8px;background:var(--color-bg-2)}',
    '.aiondx-accent-title{font-size:14px;font-weight:600;color:var(--color-text-1)}',
    '.aiondx-accent-desc{font-size:12px;line-height:18px;color:var(--color-text-3);margin-top:2px}',
    '.aiondx-accent-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:10px}',
    '.aiondx-swatch{width:24px;height:24px;padding:0;border-radius:50%;border:2px solid var(--color-bg-2);cursor:pointer;',
    '  box-shadow:0 0 0 1px var(--color-border-2)}',
    '.aiondx-swatch--on{box-shadow:0 0 0 2px var(--color-text-1)}',
    '.aiondx-swatch-custom{display:inline-flex;align-items:center;gap:6px;padding:2px 8px 2px 2px;border-radius:14px;cursor:pointer;',
    '  font-size:12px;color:var(--color-text-2);box-shadow:0 0 0 1px var(--color-border-2)}',
    '.aiondx-swatch-custom.aiondx-swatch--on{box-shadow:0 0 0 2px var(--color-text-1)}',
    '.aiondx-swatch-custom input{width:22px;height:22px;padding:0;border:none;border-radius:50%;background:none;cursor:pointer}',
    '.aiondx-accent-toggle{display:inline-flex;align-items:center;gap:6px;margin-top:10px;font-size:13px;color:var(--color-text-1);cursor:pointer}',
    '.aiondx-bg-desc{margin-top:12px}',
    '.aiondx-bg-reset{padding:0 4px;border:none;background:none;font:inherit;font-size:12px;color:rgb(var(--primary-6));cursor:pointer}',
    '.aiondx-bg-reset[disabled]{color:var(--color-text-3);cursor:default}',
    // Schedule send: the round button before AionUi's draft button, its count, and its menu.
    '.aiondx-sched-wrap{position:relative}',
    '.aiondx-sched-count{position:absolute;top:-3px;right:-3px;min-width:14px;height:14px;padding:0 3px;border-radius:7px;background:rgb(var(--warning-6));',
    '  color:#111;font-size:10px;line-height:14px;text-align:center;pointer-events:none}',
    '.aiondx-sched-count:empty{display:none}',
    '.aiondx-sched-menu{width:340px}',
    '.aiondx-sched-menu .arco-dropdown-menu{max-height:min(460px,75vh);overflow-y:auto}',
    '.aiondx-sched-quick-item.aiondx-sched-off{opacity:.45;cursor:default}',
    '.aiondx-sched-custom{display:flex;align-items:center;gap:8px;padding:6px 12px}',
    '.aiondx-sched-when{flex:1 1 auto;min-width:0;height:28px;padding:0 6px;border:1px solid var(--color-border-2);border-radius:4px;background:var(--color-bg-2);color:var(--color-text-1)}',
    '.aiondx-sched-item{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;padding:6px 12px;font-size:12px;line-height:18px;color:var(--color-text-2)}',
    '.aiondx-sched-item-when{color:var(--color-text-1);font-weight:600}',
    '.aiondx-sched-item-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.aiondx-sched-item-btns{grid-column:1 / -1;display:flex;gap:12px}',
    // A team spinner whose members are all idle: the spinner hides, the team's icon shows (see reconcileSpinners).
    '[data-aiondx-idle="1"] .arco-spin{display:none}',
    '[data-aiondx-idle="1"]::before{content:"";display:block;width:16px;height:16px;background-color:currentColor;',
    '  -webkit-mask:url("data:image/svg+xml,' + encodeURIComponent(SPIN_ICON) + '") center / contain no-repeat;',
    '  mask:url("data:image/svg+xml,' + encodeURIComponent(SPIN_ICON) + '") center / contain no-repeat}',
    '.aiondx-ctx-title{margin-top:18px}',
    '.aiondx-ctx-rows{margin-top:8px}',
    '.aiondx-ctx-row{display:flex;align-items:center;gap:8px;margin:4px 0;font-size:12px;color:var(--color-text-2)}',
    '.aiondx-ctx-row .aiondx-swatch-custom{min-width:128px}',
    '.aiondx-ctx-from{width:56px;height:24px;padding:0 6px;border:1px solid var(--color-border-2);border-radius:4px;background:var(--color-bg-2);color:var(--color-text-1)}',
    '.aiondx-ctx-from[disabled]{opacity:.5}',
    // Chat colours (build 2026-09-26.3).
    '.aiondx-bubbles{display:flex;flex-direction:column;gap:6px;margin-top:8px}',
    '.aiondx-bubble-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;transition:box-shadow .3s}',
    '.aiondx-bubble-text{flex:1;min-width:0}',
    '.aiondx-bubble-name{font-size:13px;line-height:18px;color:var(--color-text-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.aiondx-bubble-desc{font-size:12px;line-height:16px;color:var(--color-text-3)}',
    '.aiondx-bubble-sub{margin-top:8px;font-size:12px;font-weight:600;color:var(--color-text-2)}',
    '.aiondx-bubble-team{align-self:flex-start;max-width:100%;height:26px;padding:0 6px;border-radius:var(--border-radius-small,4px);',
    '  border:1px solid var(--color-border-2);background:var(--color-bg-2);color:var(--color-text-1);font-size:12px}',
    '.aiondx-bubble-pick{position:relative;display:inline-flex;cursor:pointer}',
    '.aiondx-bubble-pick input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}',
    '.aiondx-bubble-pick span{display:inline-block;min-width:44px;padding:2px 8px;border-radius:12px;border:1px dashed var(--color-border-3);',
    '  font-size:12px;line-height:18px;text-align:center;color:var(--color-text-2)}',
    '.aiondx-bubble-pick--set span{border-style:solid;border-color:transparent}',
    '.aiondx-colour-focus{box-shadow:0 0 0 2px var(--aiondx-accent,#2dd4bf),0 0 0 6px rgba(45,212,191,.18)}',
    '.aiondx-colour-menu{position:fixed;z-index:10070;min-width:200px;max-width:360px;padding:4px 0;border-radius:8px;',
    '  border:1px solid var(--color-border-2);background:var(--color-bg-popup);box-shadow:0 8px 24px rgba(0,0,0,.28)}',
    '.aiondx-colour-menu .arco-dropdown-menu-item{padding:0 12px;line-height:32px;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}',
    '.aiondx-colour-menu .arco-dropdown-menu-item:hover{background:var(--color-fill-2)}',
    '.aiondx-mcp-switch{margin-left:4px;flex:none}',
    '@keyframes aiondx-spin{to{transform:rotate(360deg)}}',
    '@media (prefers-reduced-motion:no-preference){.aiondx-loop--busy .aiondx-loop-icon svg{animation:aiondx-spin 1.6s linear infinite}}',

    // The Permission pill, shrunk to its shield (K, 2026-09-24: "taking up ALL THE SPACE").
    // AionUi's own button and dropdown, restyled only: label and caret hidden, a 28 x 28
    // circle like the loop button. A hover card names the mode instead.
    // AionUi sizes this pill with !important flex rules (flex-basis 0, grow 1, max-width
    // max-content; conversationTurnClock CSS), so the size is pinned with !important too.
    // Matched at any depth: the inner flex span is RuntimeSelectorPill's, the label is
    // MarqueePillLabel's root, the caret is icon-park's Down.
    '.sendbox-actions [data-testid="mode-selector"] .agent-mode-compact-pill{flex:0 0 28px !important;width:28px !important;',
    '  min-width:28px !important;max-width:28px !important;padding:0 !important;border-radius:50% !important;justify-content:center}',
    // AionUi also strips this pill's background; give it back the grey circle of Arco's
    // secondary button, like the loop and "+" buttons beside it.
    '.sendbox-actions [data-testid="mode-selector"] .agent-mode-compact-pill{background-color:var(--color-secondary) !important}',
    '.sendbox-actions [data-testid="mode-selector"] .agent-mode-compact-pill:hover{background-color:var(--color-secondary-hover) !important}',
    '.sendbox-actions [data-testid="mode-selector"] .agent-mode-compact-pill span.gap-6px{gap:0 !important;justify-content:center}',
    '.sendbox-actions [data-testid="mode-selector"] .agent-mode-compact-pill span.overflow-hidden.relative,',
    '.sendbox-actions [data-testid="mode-selector"] .agent-mode-compact-pill .i-icon-down,',
    '.sendbox-actions [data-testid="mode-selector"] .agent-mode-compact-pill span.gap-6px > :last-child:not(:first-child):not([data-testid="runtime-selector-loading-indicator"]){display:none !important}',
    '.sendbox-actions [data-testid="mode-selector"] .agent-mode-compact-pill:has([data-testid="runtime-selector-loading-indicator"]) span.gap-6px > :first-child{display:none !important}',
    // A chat whose agent has not started (see holdStart): no endless spinner, and the pill says it can be pressed.
    'html[data-aiondx-held] [data-testid="acp-model-selector-loading"]{opacity:.35;cursor:pointer}',
    'html[data-aiondx-held] [data-testid="acp-model-selector-loading"] *{animation:none !important}',
    'html[data-aiondx-held] [data-testid="acp-model-selector-warmup"]{cursor:pointer !important}',

    // Hover explainer. The inner classes are Arco's tooltip, which AionUi restyles with its own
    // overlay colours, so it matches the app's tooltips in both themes.
    '.aiondx-tip{position:fixed;z-index:1060;width:380px;max-width:calc(100vw - 16px);pointer-events:none}',
    '.aiondx-tip .arco-tooltip-content{padding:10px 12px;font-size:13px;line-height:19px}',
    '.aiondx-tip-title{font-size:14px;font-weight:600;margin-bottom:4px}',
    '.aiondx-tip-list{margin:6px 0;padding-inline-start:16px;font-size:12.5px;line-height:18px}',
    '.aiondx-tip-list li{margin:1px 0}',
    '.aiondx-tip-legend{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:6px;font-size:12px}',
    '.aiondx-tip-legend span{display:inline-flex;align-items:center;gap:5px}',
    '.aiondx-dot{display:inline-block;width:8px;height:8px;border-radius:50%}',
    '.aiondx-dot--off{background:var(--color-text-3)}',
    '.aiondx-dot--on{background:rgb(var(--primary-6))}',
    '.aiondx-dot--waiting{background:rgb(var(--warning-6))}',
    '.aiondx-dot--busy{background:rgb(var(--success-6))}',
    '.aiondx-dot--dead{background:rgb(var(--danger-6))}',
    '.aiondx-dot--agent{background:rgb(var(--purple-6,114,46,209))}',
    '.aiondx-tip-by{margin-top:4px;font-size:12px}',
    '.aiondx-by{padding:0 12px 8px;margin-top:-4px;font-size:12px;line-height:18px;color:var(--color-text-2)}',
    '.aiondx-menu .aiondx-item--disabled{cursor:default;opacity:.6}',
    '.aiondx-tip-agent{margin-bottom:6px;font-weight:600}',
    '.aiondx-tip-legend2{margin-top:2px}',
    '.aiondx-tip-now{margin-top:6px;font-size:12px}',
    '.aiondx-tip-foot{margin-top:4px;font-size:12px;opacity:.75}',

    '.aiondx-menu{position:fixed;z-index:1050;width:300px;font-size:14px;color:var(--color-text-1)}',
    // Arco caps .arco-dropdown-menu at 200px with overflow:auto, which cut the
    // message box in half. Lift the cap on ours only.
    '.aiondx-menu .arco-dropdown-menu{max-height:none;overflow:visible}',
    '.aiondx-menu .arco-dropdown-menu-item{display:flex;align-items:flex-start;gap:8px;cursor:pointer;',
    '  padding:6px 12px;line-height:20px;height:auto;white-space:normal;user-select:none}',
    '.aiondx-menu .aiondx-item--current{background-color:var(--color-fill-2)}',
    '.aiondx-check{width:16px;flex-shrink:0;color:rgb(var(--primary-6))}',
    '.aiondx-item-desc{display:block;font-size:12px;line-height:18px;color:var(--color-text-3)}',
    '.aiondx-divider{height:1px;margin:4px 0;background:var(--color-fill-3)}',
    '.aiondx-field{padding:4px 12px 8px}',
    '.aiondx-textarea{display:block;box-sizing:border-box;width:100%;min-height:76px;resize:vertical;',
    '  padding:6px 10px;border:1px solid transparent;border-radius:var(--border-radius-small,4px);',
    '  background:var(--color-fill-2);color:var(--color-text-1);font:inherit;font-size:13px;line-height:19px;outline:none}',
    '.aiondx-textarea:hover{background:var(--color-fill-3)}',
    '.aiondx-textarea:focus{border-color:rgb(var(--primary-6));background:var(--color-bg-2)}',
    '.aiondx-note{padding:0 12px 6px;font-size:12px;line-height:18px;color:var(--color-text-3)}',
    '.aiondx-status{padding:0 12px 8px;font-size:12px;line-height:18px;color:var(--color-text-2)}'
  ].join('\n');

  var ICON_LOOP = '<svg viewBox="0 0 48 48" fill="none" aria-hidden="true">' +
    '<path d="M36 8l6 6-6 6" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M8 24v-4a6 6 0 0 1 6-6h28" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M12 40l-6-6 6-6" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M40 24v4a6 6 0 0 1-6 6H6" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var CHECK = '✓';

  function ensureStyle() {
    if (document.getElementById('aiondx-style')) return;
    var st = document.createElement('style');
    st.id = 'aiondx-style';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  // ---------------------------------------------------------------- pills

  var pills = {};        // target key -> { el, target }
  var menu = null;       // dropdown, appended to body while open
  var menuKey = null;    // which pill's menu is open
  var menuParts = null;  // the parts of the open menu that change

  function buildPill(key) {
    var wrap = document.createElement('span');
    wrap.className = 'aiondx-loop';
    wrap.setAttribute('data-testid', 'aiondx-loop');

    // Same class list as the composer's own circle buttons (Arco <Button shape="circle"
    // size="small">, 28 x 28): an icon only, so it fits narrow team columns.
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'arco-btn arco-btn-secondary arco-btn-size-small arco-btn-shape-circle aiondx-loop-btn';
    btn.setAttribute('aria-haspopup', 'menu');
    btn.innerHTML = '<span class="aiondx-loop-icon">' + ICON_LOOP + '</span>';
    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (menu && menuKey === key) closeMenu();
      else { closeMenu(); openMenu(key); }
    });
    wrap.appendChild(btn);
    wireTip(wrap, key);
    return wrap;
  }

  /** On, but holding back: a paused member sitting out a limit, or a failed turn's retry wait.
   *  (Until build 2026-09-25.4 a backoff after a short reply counted too; those waits now sit
   *  inside the cache window and are the Loop's ordinary rhythm.) */
  function isWaiting(s) {
    return !!(s.nextRetryAt && Date.now() < s.nextRetryAt);
  }
  function pillState(s) {
    if (!s.on) return 'off';
    if (s.restingSince) return 'resting';
    return isWaiting(s) ? 'waiting' : 'on';
  }
  /** How much of its cache window the agent has left, 0 to 1; 1 while it works; -1 when not known. */
  function warmth(t, s) {
    var a = agentLive[t.key];
    if (a && (a.state === 'working' || a.state === 'queued')) return 1;
    if (!s.lastAt) return -1;
    var left = s.lastAt + CACHE_TTL_MS - Date.now();
    return left > 0 ? Math.min(1, left / CACHE_TTL_MS) : 0;
  }

  function paintPill(p) {
    var s = state(p.target);
    var st = pillState(s);
    if (p.el.getAttribute('data-state') !== st) p.el.setAttribute('data-state', st);
    p.el.classList.toggle('aiondx-loop--on', st === 'on');
    p.el.classList.toggle('aiondx-loop--waiting', st === 'waiting');
    p.el.classList.toggle('aiondx-loop--resting', st === 'resting');
    // On until the user stops it: a small infinity mark on the button.
    p.el.classList.toggle('aiondx-loop--forever', !!(s.on && s.forever));
    // The ring around the button: the cache time the agent has left, while its Loop is on.
    var w = s.on ? warmth(p.target, s) : -1;
    p.el.classList.toggle('aiondx-loop--warm', w > 0);
    p.el.classList.toggle('aiondx-loop--warm-low', w > 0 && w < 0.25);
    var wv = w > 0 ? w.toFixed(3) : '0';
    if (p.el.style.getPropertyValue('--aiondx-warm') !== wv) p.el.style.setProperty('--aiondx-warm', wv);
    var a = agentLive[p.target.key];
    var agent = a ? a.state : 'unknown';
    if (p.el.getAttribute('data-agent') !== agent) p.el.setAttribute('data-agent', agent);
    p.el.classList.toggle('aiondx-loop--busy', agent === 'working');
    p.el.classList.toggle('aiondx-loop--dead', agent === 'paused' || agent === 'blocked');
    var marked = agentMarked(s);
    p.el.classList.toggle('aiondx-loop--agent', marked);
    var btn = p.el.firstChild;
    var pressed = s.on ? 'true' : 'false';
    if (btn.getAttribute('aria-pressed') !== pressed) btn.setAttribute('aria-pressed', pressed);
    var aria = 'Loop, ' + STATE_WORDS[st] + (s.on && s.forever ? ' until you stop it' : '') + '; agent ' + AGENT_WORDS[agent] +
      (marked ? '; changed by ' + s.agentMark.who + ' at ' + hhmm(s.agentMark.at) : '');
    if (btn.getAttribute('aria-label') !== aria) btn.setAttribute('aria-label', aria);
    // No native title: the hover explainer below replaces it, and two tooltips would stack.
    if (btn.hasAttribute('title')) btn.removeAttribute('title');
    if (tip && tipKey === p.target.key) fillTip(tip, p.target);
  }

  // ---------------------------------------------------------------- hover explainer

  var STATE_WORDS = { off: 'off', on: 'on', waiting: 'holding back', resting: 'on, resting' };
  var AGENT_WORDS = { working: 'working', idle: 'idle', queued: 'queued', paused: 'paused', blocked: 'blocked', unknown: 'state unknown' };
  var TIP_DELAY_MS = 350;
  var tip = null;        // the explainer element, while shown
  var tipKey = null;     // which pill it belongs to ('perm' for the Permission button)
  var tipAnchor = null;  // the element it points at
  var tipTimer = null;

  function tipText(t, s) {
    var team = t.kind === 'team';
    var hold = holdMinutes(s);
    if (s.on && s.forever) {
      return {
        body: (team ? 'Keeps this team member working' : 'Keeps this chat working') + ' until you stop it. ' +
          (team ? 'When it stops with nothing queued' : 'When a turn ends') + ', the Loop sends your continue message.',
        points: [
          team ? 'Never sends while it works or has work queued.' : 'Never sends while the agent is working.',
          'After a short reply the next nudge comes 2, then 4 min after its last message, inside the 5 min cache window.',
          'No time limit: it never rests, wakes the agent even after its cache has run out, and keeps retrying after failures and limits.',
          'After ' + STALL_LIMIT + ' nudges with no reply it waits for the agent to answer, and stays on.',
          'It ends when you switch it off from its menu, press the agent\'s Stop button, say stop, or ask for its Loop to be ' +
            'turned off ("turn off your loop"). No agent turns it off on its own.',
          'Runs on any page while AionUi is open.'
        ]
      };
    }
    return {
      body: team
        ? 'Keeps this team member working. When it stops with nothing queued, the Loop sends your continue message.'
        : 'Keeps this chat working. When a turn ends, the Loop sends your continue message.',
      points: [
        team ? 'Never sends while it works or has work queued.' : 'Never sends while the agent is working.',
        'After a short reply the next nudge comes 2, then 4 min after its last message, inside the 5 min cache window.',
        hold ? 'After ' + hold + ' min of short replies it rests and lets the cache expire.'
             : 'After a short reply it rests and lets the cache expire.',
        'It never wakes an agent whose cache has run out.',
        team ? 'After a rate-limit pause it waits for the reset, then resumes, teammates first.'
             : 'After a rate-limit failure it waits for the reset.',
        'Your messages keep it on; saying stop ("stop", "time to stop work", "stand down", "good night") switches it off.',
        'Also off from its menu, the agent\'s Stop button, "turn off your loop", or after ' + STALL_LIMIT + ' nudges with no reply. Runs on any page while AionUi is open.'
      ]
    };
  }

  /** "Cache: warm until 16:25 (3 min). Next nudge 16:24." for the hover card and the menu. */
  function cacheLine(t, s) {
    if (!s.on) return '';
    var a = agentLive[t.key];
    if (a && a.state === 'working') return 'Cache: in use while it works.';
    if (!s.lastAt) return 'Cache: not read yet.';
    var until = s.lastAt + CACHE_TTL_MS;
    var now = Date.now();
    if (until <= now) return 'Cache: ran out at ' + hhmm(until) + '.';
    return 'Cache: warm until ' + hhmm(until) + ' (' + Math.max(1, Math.round((until - now) / 60000)) + ' min).' +
      (!s.restingSince && s.nextNudgeAt > now ? ' Next nudge ' + hhmm(s.nextNudgeAt) + '.' : '');
  }

  function agentLine(t) {
    var a = agentLive[t.key];
    if (!a) return 'Agent: checking.';
    if (a.state === 'working') {
      return 'Agent: working' + (a.since ? ', turn open ' + Math.max(1, Math.round((Date.now() - a.since) / 60000)) + ' min' : '') + '.';
    }
    if (a.state === 'idle') return 'Agent: idle.';
    if (a.state === 'queued') return 'Agent: queued, waiting to start.';
    if (a.state === 'paused') return 'Agent: paused by the team runtime, usually a provider limit.';
    if (a.state === 'blocked') return 'Agent: blocked' + (a.detail ? ' (' + a.detail + ')' : '') + '.';
    return 'Agent: status unknown.';
  }

  function fillTip(el, t) {
    var s = state(t);
    var st = pillState(s);
    var txt = tipText(t, s);
    // The heading already says on, off or holding back; this line adds only what it does not.
    var now;
    if (s.on) now = 'Now: ' + statusText(t, s).replace(/^On\.\s*/, '');
    else if (s.offReason && s.offReason !== 'turned off') now = 'Switched off: ' + s.offReason + '.';
    else now = s.queue.length ? s.queue.length + ' older queued message(s) will still send when idle.' : '';
    if (!s.on && compactPending(s)) now = (now ? now + ' ' : '') + compactLine(s);
    var box = el.querySelector('.arco-tooltip-content-inner');
    var html =
      '<div class="aiondx-tip-title"></div>' +
      '<div class="aiondx-tip-agent"></div>' +
      '<div class="aiondx-tip-cache"></div>' +
      '<div class="aiondx-tip-body"></div>' +
      '<ul class="aiondx-tip-list"></ul>' +
      '<div class="aiondx-tip-legend"><span>Loop:</span>' +
        '<span><i class="aiondx-dot aiondx-dot--off"></i>Off</span>' +
        '<span><i class="aiondx-dot aiondx-dot--on"></i>On</span>' +
        '<span><i class="aiondx-dot aiondx-dot--waiting"></i>Holding back</span>' +
        '<span><i class="aiondx-dot aiondx-dot--resting"></i>Resting</span>' +
        '<span><i class="aiondx-ringkey"></i>Ring: cache time left</span>' +
      '</div>' +
      '<div class="aiondx-tip-legend aiondx-tip-legend2"><span>Agent dot:</span>' +
        '<span><i class="aiondx-dot aiondx-dot--busy"></i>Working</span>' +
        '<span><i class="aiondx-dot aiondx-dot--dead"></i>Paused or blocked</span>' +
        '<span><i class="aiondx-dot aiondx-dot--agent"></i>An agent changed the Loop</span>' +
      '</div>' +
      '<div class="aiondx-tip-now"></div>' +
      '<div class="aiondx-tip-by"></div>' +
      '<div class="aiondx-tip-foot">Click to switch it on or off, or edit the message.</div>';
    if (!box.querySelector('.aiondx-tip-agent')) box.innerHTML = html;
    box.querySelector('.aiondx-tip-title').textContent = 'Loop is ' + STATE_WORDS[st];
    box.querySelector('.aiondx-tip-agent').textContent = agentLine(t);
    var cacheEl = box.querySelector('.aiondx-tip-cache');
    var cache = cacheLine(t, s);
    cacheEl.textContent = cache;
    cacheEl.style.display = cache ? '' : 'none';
    box.querySelector('.aiondx-tip-body').textContent = txt.body;
    var list = box.querySelector('.aiondx-tip-list');
    if (list.childNodes.length !== txt.points.length) {
      list.textContent = '';
      txt.points.forEach(function () { list.appendChild(document.createElement('li')); });
    }
    txt.points.forEach(function (line, i) { if (list.childNodes[i].textContent !== line) list.childNodes[i].textContent = line; });
    var nowEl = box.querySelector('.aiondx-tip-now');
    nowEl.textContent = now;
    nowEl.style.display = now ? '' : 'none';
    var byText = agentChangeLine(s);
    var byEl = box.querySelector('.aiondx-tip-by');
    byEl.textContent = byText;
    byEl.style.display = byText ? '' : 'none';
  }

  function placeTip() {
    if (!tip || !tipAnchor) return;
    var r = tipAnchor.getBoundingClientRect();
    var w = tip.offsetWidth || 340;
    var left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    tip.style.left = left + 'px';
    // The composer sits at the bottom of the window, so open upward; flip down if it would clip;
    // in a window too short for either, keep it inside the window.
    var h = tip.offsetHeight || 0;
    var top;
    if (r.top - h - 8 >= 8) top = r.top - h - 8;
    else if (r.bottom + 8 + h <= window.innerHeight - 8) top = r.bottom + 8;
    else top = Math.max(8, window.innerHeight - h - 8);
    tip.style.top = top + 'px';
  }

  /** One hover card at a time, pointing at `anchor`; `fill` writes its content. */
  function openTip(key, anchor, fill) {
    hideTip();
    if (menu || !anchor || !document.contains(anchor)) return;
    tipKey = key;
    tipAnchor = anchor;
    tip = document.createElement('div');
    tip.className = 'aiondx-tip';
    tip.setAttribute('role', 'tooltip');
    tip.id = 'aiondx-tip';
    tip.innerHTML = '<div class="arco-tooltip-content"><div class="arco-tooltip-content-inner"></div></div>';
    fill(tip);
    document.body.appendChild(tip);
    anchor.setAttribute('aria-describedby', 'aiondx-tip');
    placeTip();
  }

  function showTip(key) {
    var p = pills[key];
    if (!p) return;
    openTip(key, p.el.firstChild, function (el) { fillTip(el, p.target); });
  }

  function hideTip() {
    if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
    if (tipAnchor) tipAnchor.removeAttribute('aria-describedby');
    if (tip && tip.parentNode) tip.parentNode.removeChild(tip);
    tip = null;
    tipKey = null;
    tipAnchor = null;
  }

  function wireTip(wrap, key) {
    var btn = wrap.firstChild;
    var later = function () { if (tipTimer) clearTimeout(tipTimer); tipTimer = setTimeout(function () { tipTimer = null; showTip(key); }, TIP_DELAY_MS); };
    btn.addEventListener('mouseenter', later);
    btn.addEventListener('mouseleave', hideTip);
    btn.addEventListener('mousedown', hideTip);
    btn.addEventListener('focus', function () { if (btn.matches(':focus-visible')) later(); });
    btn.addEventListener('blur', hideTip);
  }

  /** Put one pill at the front of each target's composer action row, before the
   *  Permission pill. React re-mounts those rows when layout changes, which drops
   *  foreign nodes, so this runs from a MutationObserver and simply re-inserts. */
  // Why a message box has no Loop button (K, 2026-09-26, a team: "Loop buttons gone", not reproduced in the
  // harness). Written to the store as aiondx.diag.loop, the newest 12, each kind and place at most every 10 minutes, so
  // the next time it happens the page's own answer is there to read.
  var DIAG_KEY = 'aiondx.diag.loop';
  var diagSeen = {};
  var diagList = [];
  function diagnose(kind, where, detail) {
    var id = kind + '|' + where;
    var now = Date.now();
    if (diagSeen[id] && now - diagSeen[id] < 10 * 60000) return;
    diagSeen[id] = now;
    var r = route();
    var entry = Object.assign({ at: now, kind: kind, where: where, route: r ? r.kind + ':' + r.id : location.hash.slice(0, 80), build: BUILD }, detail || {});
    console.log('[dx] diag ' + kind + ' ' + where, entry);
    diagList.push(entry);
    if (diagList.length > 12) diagList = diagList.slice(-12);
    var body = {};
    body[DIAG_KEY] = diagList;
    putPrefs(body);
  }
  /** Class names of an element and its ancestors, for the diagnosis. */
  function classChain(el, depth) {
    var out = [];
    for (var i = 0; el && el !== document.body && i < (depth || 10); i++, el = el.parentElement) {
      out.push(el.tagName.toLowerCase() + (el.getAttribute('data-slot-id') ? '[slot=' + el.getAttribute('data-slot-id') + ']' : '') +
        (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 4).join('.') : ''));
    }
    return out;
  }
  /** Every message box on screen should carry a Loop button; record the ones that do not, and why not. */
  function diagnoseMissing() {
    if (disabled()) return;
    var r = route();
    var boxes = document.querySelectorAll('[data-testid="sendbox-input"]');
    for (var i = 0; i < boxes.length; i++) {
      var box = boxes[i];
      if (!box.getClientRects().length) continue;   // not on screen
      var panel = box.closest('.sendbox-panel') || box.parentElement;
      var col = box.closest('[data-slot-id]');
      // A member's button is in its own column; never count the next column's.
      if (col) { if (col.querySelector('.aiondx-loop')) continue; }
      else {
        var root = panel;
        for (var up = 0; root && up < 4 && !root.querySelector('.aiondx-loop'); up++) root = root.parentElement;
        if (root && root.querySelector('.aiondx-loop')) continue;
      }
      var acts = panel && panel.querySelector('.sendbox-actions');
      diagnose('no-button', col ? 'slot ' + col.getAttribute('data-slot-id') : 'box ' + i, {
        routeKind: r ? r.kind : 'none', inSlot: !!col, hasActions: !!acts,
        actionsInOwnSlot: !!(acts && col && acts.closest('[data-slot-id]') === col),
        boxes: boxes.length, slots: document.querySelectorAll('[data-slot-id]').length,
        chain: classChain(panel, 10), actionsChildren: acts ? classChain(acts, 1).concat([].slice.call(acts.children, 0, 6).map(function (c) { return classChain(c, 1)[0]; })) : [] });
    }
  }

  function render() {
    var list = targets();
    var live = {};
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      live[t.key] = true;
      // One member's failure must not cost the others their buttons.
      try {
        var p = pills[t.key];
        if (!p) p = pills[t.key] = { el: buildPill(t.key), target: t };
        p.target = t;
        if (p.el.parentNode !== t.actions || t.actions.firstChild !== p.el) t.actions.insertBefore(p.el, t.actions.firstChild);
        paintPill(p);
      } catch (e) {
        diagnose('pill-failed', t.key, { error: String(e && e.stack || e).slice(0, 600) });
      }
    }
    try { diagnoseMissing(); } catch (e) {}
    Object.keys(pills).forEach(function (k) {
      if (live[k]) return;
      var el = pills[k].el;
      if (el.parentNode) el.parentNode.removeChild(el);
      delete pills[k];
      if (menuKey === k) closeMenu();
      if (tipKey === k) hideTip();
    });
    [labelPermissionButtons, paintContextRings, renderSched, reconcileSpinners, ensureAccentPicker, focusColour, renderAccounts, renderUnsend, renderRespondNow, hideDriftNotices, tagBubbles, renderMcpSwitches, markHeldStart, labelModels, holdTitle].forEach(function (step) {
      try { step(); } catch (e) { console.log('[dx] render step failed', e); }
    });
    if (menu) refreshMenu();
  }

  // ---------------------------------------------------------------- menu

  function ago(ms) {
    var sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (sec < 60) return sec + 's ago';
    var min = Math.round(sec / 60);
    if (min < 60) return min + ' min ago';
    return Math.round(min / 60) + ' h ago';
  }

  function statusText(t, s) {
    if (s.on) {
      // `why` is what the last check decided, written by the loop itself: "Not sending: it is
      // working.", "Waiting a minute after your message.", "Paused ... Retry 1 of 10 at 10:31."
      var base = s.restingSince ? restText(s) : s.why;
      if (!base && s.nextRetryAt && Date.now() < s.nextRetryAt) {
        base = (t.kind === 'team' ? 'Paused by the team runtime, usually a provider limit.' : 'The last turn failed.') +
          ' Retry ' + (((t.kind === 'team' ? s.resumeAttempts : s.errAttempts) || 0) + 1) + ' of ' + RETRY_MAX +
          ' at ' + hhmm(s.nextRetryAt) + '.';
      }
      if (!base) {
        base = t.kind === 'team' ? 'Waiting for this member to stop with nothing queued.' : 'Waiting for the current turn to finish.';
      }
      var count = s.fires ? ' ' + s.fires + (s.fires === 1 ? ' nudge' : ' nudges') + ' so far' +
        (s.lastFired ? ', last ' + ago(s.lastFired) : '') + '.' : '';
      var res = s.wakeAt && base.indexOf('resume') < 0 ? ' Resumes at ' + hhmm(s.wakeAt) + '.' : '';
      return (s.forever ? 'On until you stop it. ' : 'On. ') + base + res + count + (compactPending(s) ? ' ' + compactLine(s) : '');
    }
    var off;
    if (s.offReason && s.offReason !== 'turned off') off = 'Off: ' + s.offReason + '.';
    else if (s.queue.length) off = s.queue.length + ' older queued message(s) will still send when idle.';
    else off = 'Off.';
    return off + (compactPending(s) ? ' ' + compactLine(s) : '');
  }

  function compactLine(s) {
    return 'Compaction asked for at ' + hhmm(s.compactAt) + '; it goes out when the agent stops.';
  }

  /** choice: 'on', 'forever' (on until the user stops it) or 'off'. */
  function makeItem(choice, title, desc) {
    var on = choice !== 'off';
    var el = document.createElement('div');
    el.className = 'arco-dropdown-menu-item';
    el.setAttribute('role', 'menuitemradio');
    el.setAttribute('data-choice', choice);
    el.innerHTML = '<span class="aiondx-check" aria-hidden="true"></span>' +
      '<span><span class="aiondx-item-title"></span>' + (desc ? '<span class="aiondx-item-desc"></span>' : '') + '</span>';
    el.querySelector('.aiondx-item-title').textContent = title;
    if (desc) el.querySelector('.aiondx-item-desc').textContent = desc;
    el.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      var p = menuKey && pills[menuKey];
      if (!p) return;
      setOn(p.target, on, on ? 'turned on' : 'turned off', true, choice === 'forever');
      closeMenu();
    });
    return el;
  }

  function markCurrent(el, current) {
    el.classList.toggle('aiondx-item--current', current);
    el.setAttribute('aria-checked', current ? 'true' : 'false');
    var chk = el.firstChild;
    var want = current ? CHECK : '';
    if (chk.textContent !== want) chk.textContent = want;
  }

  /** Built once each time the menu opens. After that only refreshMenu touches it. */
  function buildMenu() {
    var p = menuKey && pills[menuKey];
    if (!p || !menu) return;
    var t = p.target;
    var s = state(t);
    var box = menu.firstChild;

    var g1 = document.createElement('div');
    g1.className = 'arco-dropdown-menu-group-title';
    g1.textContent = t.kind === 'team' ? 'Keep this member working' : 'Keep working after each turn';
    box.appendChild(g1);
    var onItem = makeItem('on', 'On', t.kind === 'team'
      ? 'Sends your continue message whenever it is idle with nothing queued, and resumes it after a pause'
      : 'Sends your continue message after every turn');
    var foreverItem = makeItem('forever', 'On until I stop it',
      'No time limit, never rests, never gives up. It ends when you switch it off here, press the agent\'s Stop ' +
      'button, or ask for its Loop to be turned off. No agent turns it off on its own.');
    var offItem = makeItem('off', 'Off', null);
    box.appendChild(onItem);
    box.appendChild(foreverItem);
    box.appendChild(offItem);

    var div = document.createElement('div');
    div.className = 'aiondx-divider';
    box.appendChild(div);

    var g2 = document.createElement('div');
    g2.className = 'arco-dropdown-menu-group-title';
    g2.textContent = 'Continue message';
    box.appendChild(g2);

    var field = document.createElement('div');
    field.className = 'aiondx-field';
    var ta = document.createElement('textarea');
    ta.className = 'aiondx-textarea';
    ta.value = s.msg;
    ta.spellcheck = true;
    ta.addEventListener('input', function () {
      var cur = state(t);
      cur.msg = ta.value.trim() ? ta.value : DEFAULT_MSG;
      save(t, cur);
      // Agents read the message too; written once typing pauses.
      var k = sharedKey(t);
      if (msgTimers[k]) clearTimeout(msgTimers[k]);
      msgTimers[k] = setTimeout(function () { delete msgTimers[k]; pushShared(t, 'user', ''); }, MSG_PUSH_DELAY_MS);
    });
    // Keep keystrokes away from the app's own shortcuts while typing here.
    ta.addEventListener('keydown', function (ev) {
      ev.stopPropagation();
      if (ev.key === 'Escape') { closeMenu(); }
    });
    field.appendChild(ta);
    box.appendChild(field);

    var note = document.createElement('div');
    note.className = 'aiondx-note';
    note.textContent = 'Sends only once the agent has stopped. After a short reply the next nudge comes 2, then 4 min ' +
      'after its last message, while its cache is warm; it never wakes a cold agent. Saying stop switches it off.';
    box.appendChild(note);

    // How long it keeps the cache warm through short replies before it rests. Agents set the same
    // with the Loop tool (holdMin).
    var hold = document.createElement('div');
    hold.className = 'aiondx-hold';
    hold.innerHTML = '<div class="aiondx-hold-title">Keep its cache warm through short replies for</div>' +
      '<div class="aiondx-hold-row" role="radiogroup" aria-label="Keep its cache warm through short replies for"></div>';
    hold.title = 'A warm nudge reads the cached chat at a tenth of the input price; letting the cache run out and ' +
      'reloading costs 1.25 times. 45 min of warm nudges costs about one reload. Then it rests.';
    var holdRow = hold.querySelector('.aiondx-hold-row');
    HOLD_CHOICES.forEach(function (m) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'arco-btn arco-btn-secondary arco-btn-size-mini aiondx-hold-btn';
      b.setAttribute('role', 'radio');
      b.setAttribute('data-hold', String(m));
      b.textContent = !m ? 'Off' : (m < 120 ? m + ' min' : (m / 60) + ' h');
      b.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var cur = state(t);
        if (holdMinutes(cur) === m) return;
        cur.holdMin = m;
        save(t, cur);
        pushShared(t, 'user', '');
        publishStatus(t);
        refreshMenu();
        render();
      });
      holdRow.appendChild(b);
    });
    box.appendChild(hold);

    // Resume at a set time (build 2026-09-26.2). Agents set the same with the Loop tool (resume_at).
    var res = document.createElement('div');
    res.className = 'aiondx-hold aiondx-resume';
    res.innerHTML = '<div class="aiondx-hold-title">Resume at a set time</div>' +
      '<div class="aiondx-hold-row"><input type="time" class="aiondx-resume-time" aria-label="Resume at">' +
      '<button type="button" class="arco-btn arco-btn-secondary arco-btn-size-mini aiondx-resume-set">Set</button>' +
      '<button type="button" class="arco-btn arco-btn-text arco-btn-size-mini aiondx-resume-clear">Clear</button></div>' +
      '<div class="aiondx-hold-desc aiondx-resume-note"></div>';
    res.title = 'Holds the agent until then, keeping its cache warm while that costs less than one reload, then sends ' +
      'one nudge saying the time has come, with the continue message. Switching the Loop off clears it.';
    var resTime = res.querySelector('.aiondx-resume-time');
    var setResume = function () {
      var at = nextClock(resTime.value);
      if (!at) return;
      var cur = state(t);
      cur.wakeAt = at; cur.wakeMsg = ''; cur.wakeBy = 'the user'; cur.wakeSelf = false;
      cur.restingSince = 0; cur.restKind = '';
      save(t, cur);
      if (!cur.on) setOn(t, true, 'turned on');   // writes the record, resume time included
      else pushShared(t, 'user', 'resume at ' + hhmm(at));
      publishStatus(t);
      refreshMenu();
      render();
    };
    resTime.addEventListener('keydown', function (ev) {
      ev.stopPropagation();
      if (ev.key === 'Escape') closeMenu();
      else if (ev.key === 'Enter') { ev.preventDefault(); setResume(); }
    });
    res.querySelector('.aiondx-resume-set').addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); setResume(); });
    res.querySelector('.aiondx-resume-clear').addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      var cur = state(t);
      if (!cur.wakeAt) return;
      cur.wakeAt = 0; cur.wakeMsg = ''; cur.wakeBy = ''; cur.wakeSelf = false;
      if (cur.restKind === 'resume') { cur.restingSince = 0; cur.restKind = ''; }
      save(t, cur);
      pushShared(t, 'user', 'resume time cleared');
      publishStatus(t);
      refreshMenu();
      render();
    });
    box.appendChild(res);

    var status = document.createElement('div');
    status.className = 'aiondx-status';
    box.appendChild(status);

    var by = document.createElement('div');
    by.className = 'aiondx-by';
    box.appendChild(by);

    // No compaction item (K, 2026-10-01: "Compact next context needs to be taken out of the loop menu (should have never been there in the first place").
    // An agent can still ask for a compaction with the Loop tool's compact option; the status line shows it.

    menuParts = { onItem: onItem, foreverItem: foreverItem, offItem: offItem, status: status, by: by, ta: ta, hold: holdRow,
      resTime: resTime, resNote: res.querySelector('.aiondx-resume-note') };
    refreshMenu();
  }

  /** Update the open menu in place: check marks and status text only. Nothing the
   *  pointer can be resting on is ever replaced. */
  function refreshMenu() {
    var p = menuKey && pills[menuKey];
    if (!menu || !menuParts || !p) return;
    var s = state(p.target);
    markCurrent(menuParts.onItem, s.on && !s.forever);
    markCurrent(menuParts.foreverItem, s.on && !!s.forever);
    markCurrent(menuParts.offItem, !s.on);
    var cl = cacheLine(p.target, s);
    var text = statusText(p.target, s) + (cl ? ' ' + cl : '');
    if (menuParts.status.textContent !== text) menuParts.status.textContent = text;
    var hm = holdMinutes(s);
    Array.prototype.forEach.call(menuParts.hold.querySelectorAll('.aiondx-hold-btn'), function (b) {
      var on = Number(b.getAttribute('data-hold')) === hm;
      b.classList.toggle('aiondx-hold-btn--on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    var rn = s.wakeAt ? 'Resumes at ' + hhmm(s.wakeAt) + (s.wakeBy && s.wakeBy !== 'the user' ? ', set by ' + s.wakeBy : '') + '.'
      : (s.wokeAt && Date.now() - s.wokeAt < 6 * 3600000 ? 'Resumed at ' + hhmm(s.wokeAt) + '. ' : '') + 'None set.';
    if (menuParts.resNote.textContent !== rn) menuParts.resNote.textContent = rn;
    if (s.wakeAt && document.activeElement !== menuParts.resTime && menuParts.resTime.value !== hhmm(s.wakeAt)) menuParts.resTime.value = hhmm(s.wakeAt);
    var byText = agentChangeLine(s);
    if (menuParts.by.textContent !== byText) menuParts.by.textContent = byText;
    menuParts.by.style.display = byText ? '' : 'none';
    // A message an agent changed while the menu is open, unless K is typing in it.
    if (document.activeElement !== menuParts.ta && menuParts.ta.value !== s.msg) menuParts.ta.value = s.msg;
  }

  function placeMenu() {
    var p = menuKey && pills[menuKey];
    if (!menu || !p) return;
    var r = p.el.getBoundingClientRect();
    var w = menu.offsetWidth || 300;
    var left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
    menu.style.left = left + 'px';
    // The composer sits at the bottom of the window, so open upward, the way the
    // Permission dropdown does. Never past the top of the window: in a short window the menu
    // scrolls, with On and Off first.
    menu.style.bottom = (window.innerHeight - r.top + 6) + 'px';
    menu.style.top = 'auto';
    menu.style.maxHeight = Math.max(160, r.top - 6 - 8) + 'px';
    menu.style.overflowY = 'auto';
  }

  function openMenu(key) {
    hideTip();
    if (menu || !pills[key]) return;
    menuKey = key;
    menu = document.createElement('div');
    menu.className = 'aiondx-menu';
    menu.setAttribute('role', 'menu');
    var box = document.createElement('div');
    box.className = 'arco-dropdown-menu';
    menu.appendChild(box);
    document.body.appendChild(menu);
    buildMenu();
    placeMenu();
    setTimeout(function () {
      document.addEventListener('mousedown', onOutside, true);
      window.addEventListener('resize', placeMenu);
      document.addEventListener('keydown', onKey, true);
    }, 0);
  }

  function closeMenu() {
    if (!menu) return;
    document.removeEventListener('mousedown', onOutside, true);
    window.removeEventListener('resize', placeMenu);
    document.removeEventListener('keydown', onKey, true);
    if (menu.parentNode) menu.parentNode.removeChild(menu);
    menu = null;
    menuKey = null;
    menuParts = null;
  }

  function onOutside(ev) {
    if (!menu) return;
    var p = menuKey && pills[menuKey];
    if (menu.contains(ev.target) || (p && p.el.contains(ev.target))) return;
    closeMenu();
  }
  function onKey(ev) { if (ev.key === 'Escape') closeMenu(); }

  // ---------------------------------------------------------------- AionUi notices AionDX has moved past (2026-09-26)

  // Directive 6, row B14 of the upstream matrix: AionCore compares each agent CLI with the version compiled
  // into it and posts "The installed agy is newer than the version AionUi verified ... report anything that
  // behaves oddly" at the start of a chat (aionui-session backend\cli_version.rs, drift_notice; there is no
  // switch). AionDX keeps agent CLIs current, so that line would open nearly every chat, the first-run
  // Antigravity chat among them (seen in the standalone smoke test, September 26th). The "newer" line is
  // hidden; "older than verified" stays, since it can matter.
  var DRIFT_RE = /is newer than the version AionUi verified|\u9ad8\u4e8e AionUi \u9a8c\u8bc1\u8fc7\u7684\u7248\u672c|\u9ad8\u65bc AionUi \u9a57\u8b49\u904e\u7684\u7248\u672c/;
  function hideDriftNotices() {
    var rows = document.querySelectorAll('[id^="message-"]:not([data-aiondx-drift])');
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var text = r.textContent || '';
      if (!text) continue;   // not rendered yet: look again next time
      r.setAttribute('data-aiondx-drift', text.length < 600 && DRIFT_RE.test(text) ? '1' : '0');
    }
  }
  // AionUi's login route sets the page title to "AionUi" on the way in, before it moves on; the window
  // takes its title from the page, so AionDX's name is put back whenever the title says AionUi.
  function holdTitle() {
    if (/AionUi/.test(document.title)) document.title = document.title.replace(/AionUi/g, 'AionDX');
  }

  // ---------------------------------------------------------------- wiring

  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () { scheduled = false; render(); });
  }

  function ours(node) {
    if (!node) return false;
    if (menu && (node === menu || menu.contains(node))) return true;
    if (tip && (node === tip || tip.contains(node))) return true;
    if (toastBox && (node === toastBox || toastBox.contains(node))) return true;
    if (signinBox && (node === signinBox || signinBox.contains(node))) return true;
    if (pickerEl && (node === pickerEl || pickerEl.contains(node))) return true;
    if (acctMenu && (node === acctMenu || acctMenu.contains(node))) return true;
    if (schedMenu && (node === schedMenu || schedMenu.contains(node))) return true;
    if (welcome.el && (node === welcome.el || welcome.el.contains(node))) return true;
    if (colourMenu && (node === colourMenu || colourMenu.contains(node))) return true;
    if (node.classList && (node.classList.contains('aiondx-unsend') || node.classList.contains('aiondx-rn') || node.classList.contains('aiondx-rn-bolt') ||
        node.classList.contains('aiondx-usage') || node.classList.contains('aiondx-mcp-switch') || node.classList.contains('aiondx-sched-wrap'))) return true;
    for (var ak in acctEls) {
      if (Object.prototype.hasOwnProperty.call(acctEls, ak) && (node === acctEls[ak] || acctEls[ak].contains(node))) return true;
    }
    for (var k in pills) {
      if (Object.prototype.hasOwnProperty.call(pills, k)) {
        var el = pills[k].el;
        if (node === el || el.contains(node)) return true;
      }
    }
    return false;
  }

  /** True when a batch of mutations includes something other than our own pills and
   *  menu changing. Reacting to our own changes is what made the menu rebuild itself
   *  every frame. */
  function foreignChange(records) {
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (ours(r.target)) continue;
      var j;
      for (j = 0; j < r.addedNodes.length; j++) if (!ours(r.addedNodes[j])) return true;
      for (j = 0; j < r.removedNodes.length; j++) if (!ours(r.removedNodes[j])) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- live agent state

  // K, 2026-09-24: "I would like better indication of when the ai is or isn't engaged. I have
  // seen the ai actively printing to the chat when the 'processing' bib ... is missing." So the
  // chats on screen are checked against the backend every 3 s, independently of the loop:
  // a team member's run-state slot, or a solo chat's conversation status, with fresh output
  // (under 6 s old) as a backstop in case the status lags the stream.
  var agentLive = {};    // target key -> { state: working|idle|queued|paused|blocked|unknown, since, detail }
  // A long queue, told once (2026-09-26). A team lead, in its team's log: a member's queue reached 33
  // messages with no warning, then AionCore reported "could not process 33 queued message(s) after 3
  // delivery attempts" and paused it; another reached 60 the next evening. So a member whose queued
  // messages reach QUEUE_WARN gets one notice, again only after its queue has fallen below half that.
  var QUEUE_WARN = 20;
  var queueWarned = {};  // target key -> told about its current long queue
  var pulsing = false;
  var pulseRun = null;   // the check in flight, so an on-demand check can wait for it

  function liveFromWork(w) {
    if (!w) return { state: 'unknown' };
    if (w.state === 'running' || w.state === 'starting') return { state: 'working', since: w.active_turn_started_at_ms || null };
    if (w.state === 'paused') return { state: 'paused' };
    if (w.blocked_reason || w.state === 'blocked') return { state: 'blocked', detail: w.blocked_reason || '' };
    if (w.state === 'queued') return { state: 'queued' };
    return { state: 'idle' };
  }

  async function liveFromConv(convId) {
    var g = await getJson('/api/conversations/' + convId);
    if (g.err || !g.data) return { state: 'unknown' };
    var st = g.data.status || (g.data.state && g.data.state.status);
    if (g.data.runtime) {
      convMidturn[convId] = !!g.data.runtime.supports_midturn_delivery;
      convTurn[convId] = convBusy(g.data) ? (g.data.runtime.turn_id || null) : null;
    }
    if (st === 'pending') return { state: 'queued' };
    if (convBusy(g.data)) return { state: 'working' };
    var msgs = await getMessages(convId, 1);
    var last = msgs && msgs[msgs.length - 1];
    if (last && last.position === 'left' && Date.now() - (last.created_at || 0) < 6000) return { state: 'working', detail: 'fresh output' };
    return { state: 'idle' };
  }

  /** A turn that just ended read the cache moments ago: the ring fills at once instead of waiting
   *  for the next Loop check to read the chat. */
  function setLive(t, next) {
    var prev = agentLive[t.key];
    agentLive[t.key] = next;
    if (prev && prev.state === 'working' && next.state !== 'working' && next.state !== 'unknown') {
      var s = state(t);
      if (s.on) { s.lastAt = Math.max(s.lastAt || 0, Date.now()); save(t, s); }
    }
  }

  function pulse() {
    if (pulsing) return pulseRun;
    pulseRun = pulseOnce();
    return pulseRun;
  }
  async function pulseOnce() {
    if (disabled()) return;
    pulsing = true;
    try {
      // Every 3 s, on any page, so an agent's change to a Loop shows within seconds.
      await pullShared();
      var list = targets();
      if (!list.length) return;
      var runs = {};
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        try {
          if (t.kind === 'team') {
            if (!(t.teamId in runs)) {
              var rs = await getJson('/api/teams/' + t.teamId + '/run-state');
              runs[t.teamId] = (rs.err || !rs.data) ? null : (rs.data.slot_work || []);
            }
            var work = null, ws = runs[t.teamId] || [];
            for (var j = 0; j < ws.length; j++) if (ws[j] && ws[j].slot_id === t.slotId) { work = ws[j]; break; }
            setLive(t, runs[t.teamId] ? liveFromWork(work) : { state: 'unknown' });
            if (work) {
              var waiting = (Number(work.queued_foreground_count) || 0) + (Number(work.queued_background_count) || 0);
              if (waiting >= QUEUE_WARN && !queueWarned[t.key]) {
                queueWarned[t.key] = true;
                notify(t, '{who} has ' + waiting + ' messages waiting.',
                  'A queue this long stopped a member on September 25th. Respond now, or the bolt beside a queued message, gets yours answered first.');
              } else if (waiting < QUEUE_WARN / 2) delete queueWarned[t.key];
            }
          } else {
            setLive(t, await liveFromConv(t.convId));
          }
        } catch (e) {
          agentLive[t.key] = { state: 'unknown' };
        }
      }
      for (var k in pills) if (Object.prototype.hasOwnProperty.call(pills, k)) paintPill(pills[k]);
      applyPendingMoves();
    } finally {
      pulsing = false;
    }
  }

  // ---------------------------------------------------------------- the Permission pill

  // Styled down to its shield by the CSS above. AionUi keeps its own dropdown; this adds the
  // hover card that replaces the hidden label, and an aria-label for the same reason.
  function permissionButton(node) {
    return node && node.closest ? node.closest('.sendbox-actions [data-testid="mode-selector"] button') : null;
  }
  function permissionLabel(btn) {
    var lab = btn.querySelector('span.overflow-hidden');
    var text = lab ? (lab.firstElementChild || lab).textContent : '';
    if (!text) {
      var host = btn.closest('[data-testid="mode-selector"]');
      text = host ? (host.getAttribute('data-current-mode') || '') : '';
    }
    text = String(text).replace(/\s+/g, ' ').trim();
    var dot = text.indexOf(' · ');
    return dot >= 0 ? text.slice(dot + 3) : text;   // "Permission · Bypass (YOLO)" -> "Bypass (YOLO)"
  }
  function fillPermissionTip(el, btn) {
    var mode = permissionLabel(btn) || 'not reported yet';
    var box = el.querySelector('.arco-tooltip-content-inner');
    box.innerHTML = '<div class="aiondx-tip-title"></div><div class="aiondx-tip-body"></div><div class="aiondx-tip-foot"></div>';
    box.querySelector('.aiondx-tip-title').textContent = 'Permission: ' + mode;
    box.querySelector('.aiondx-tip-body').textContent = mode.indexOf('→') >= 0
      ? 'What the agent may do without asking you first. The change after the arrow applies from its next turn.'
      : 'What the agent may do without asking you first.';
    box.querySelector('.aiondx-tip-foot').textContent = 'Click to change it.';
  }
  function labelPermissionButtons() {
    var btns = document.querySelectorAll('.sendbox-actions [data-testid="mode-selector"] button');
    for (var i = 0; i < btns.length; i++) {
      var aria = 'Permission: ' + (permissionLabel(btns[i]) || 'unknown');
      if (btns[i].getAttribute('aria-label') !== aria) btns[i].setAttribute('aria-label', aria);
    }
  }
  function watchPermissionHover() {
    var current = null;
    document.addEventListener('mouseover', function (ev) {
      var btn = permissionButton(ev.target);
      if (!btn || btn === current) return;
      current = btn;
      if (tipTimer) clearTimeout(tipTimer);
      tipTimer = setTimeout(function () {
        tipTimer = null;
        if (current === btn) openTip('perm', btn, function (el) { fillPermissionTip(el, btn); });
      }, TIP_DELAY_MS);
    }, true);
    document.addEventListener('mouseout', function (ev) {
      if (!current || permissionButton(ev.target) !== current) return;
      if (ev.relatedTarget && current.contains(ev.relatedTarget)) return;
      current = null;
      if (tipKey === 'perm') hideTip();
      else if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
    }, true);
    document.addEventListener('mousedown', function (ev) {
      if (!permissionButton(ev.target)) return;
      current = null;
      if (tipKey === 'perm') hideTip();
      else if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
    }, true);
  }

  // ---------------------------------------------------------------- schedule send (R-003, 2026-10-01)

  // K, 2026-10-01: "need a 'schedule send' button next to the send to draft box button (should have a timer icon or something)".
  // A round button beside AionUi's draft button holds what is typed in the box and sends it later: in 15 minutes, an hour,
  // three hours, tomorrow at 9:00, or at a time picked. Each is a record in the settings store (aiondx.sched.<id> = { id,
  // scope, text, due, at }), so it survives closing the app and shows in any window. Every window checks every 5 seconds
  // and sends what is due through the same route a Loop nudge takes; a window claims a record in the store first, so two
  // windows do not both send it. A message due while the app was closed goes out when it opens, and the notice says it
  // was late. Text only; attachments in the box are not scheduled. Menu: the button's popover lists what is waiting,
  // with Send now and Cancel.
  var SCHED_STORE = 'aiondx.sched.';
  var SCHED_LS = KEY_PREFIX + 'sched';
  var SCHED_CLAIM_MS = 120000;      // a claim this old belongs to a window that died
  var SCHED_LATE_MS = 120000;       // sent this long after it was due: the notice says so
  var SCHED_MIN_MS = 15000;         // the soonest a time can be set
  var WINDOW_ID = Math.random().toString(36).slice(2, 10);
  var schedStore = {};      // id -> record, as the store last had it
  var schedUnsynced = {};   // id -> record the store has not confirmed yet
  var schedBusy = {};       // id -> a send in flight
  var schedEls = {};        // target key -> its button wrapper
  var schedMenu = null;
  var ICON_SCHED = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="13.5" r="6.5" stroke="currentColor" stroke-width="2"/>' +
    '<path d="M12 10.3v3.4l2.2 1.4M9.8 3.5h4.4M12 3.5V7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function validSched(r) {
    return !!r && typeof r === 'object' && typeof r.id === 'string' && typeof r.text === 'string' && !!r.text.trim() && Number(r.due) > 0 &&
      /^(conv|team)\./.test(String(r.scope || ''));
  }
  function schedLocal() {
    try { var a = JSON.parse(localStorage.getItem(SCHED_LS)); return Array.isArray(a) ? a.filter(validSched) : []; } catch (e) { return []; }
  }
  function schedSaveLocal(list) {
    try { if (list.length) localStorage.setItem(SCHED_LS, JSON.stringify(list)); else localStorage.removeItem(SCHED_LS); } catch (e) {}
  }
  /** Every scheduled message, soonest first. The store is the truth once it has answered; until then, and where there is
   *  no store, this window's own copy is. */
  function schedAll() {
    var m = {};
    if (!sharedReady || sharedGone) schedLocal().forEach(function (r) { m[r.id] = r; });
    Object.keys(schedStore).forEach(function (id) { m[id] = schedStore[id]; });
    Object.keys(schedUnsynced).forEach(function (id) { m[id] = schedUnsynced[id]; });
    return Object.keys(m).map(function (id) { return m[id]; }).sort(function (a, b) { return a.due - b.due; });
  }
  function schedPending(scope) { return schedAll().filter(function (r) { return r.scope === scope; }); }
  function schedPut(rec) {
    schedUnsynced[rec.id] = rec;
    schedSaveLocal(schedLocal().filter(function (r) { return r.id !== rec.id; }).concat([rec]));
    var body = {};
    body[SCHED_STORE + rec.id] = rec;
    return putPrefs(body);
  }
  function schedRemove(id) {
    delete schedStore[id];
    delete schedUnsynced[id];
    schedSaveLocal(schedLocal().filter(function (r) { return r.id !== id; }));
    var body = {};
    body[SCHED_STORE + id] = null;
    return putPrefs(body);
  }
  function takeSched(data) {
    var next = {};
    Object.keys(data).forEach(function (k) {
      if (k.indexOf(SCHED_STORE) !== 0) return;
      var v = data[k];
      if (validSched(v)) next[v.id] = v;
    });
    schedStore = next;
    Object.keys(schedUnsynced).forEach(function (id) {
      if (next[id]) { delete schedUnsynced[id]; return; }
      var body = {};
      body[SCHED_STORE + id] = schedUnsynced[id];
      putPrefs(body);
    });
  }
  function schedTarget(scope) {
    var m = /^conv\.(.+)$/.exec(scope);
    if (m) return { kind: 'conv', key: 'conv:' + m[1], convId: m[1] };
    m = /^team\.([^.]+)\.([^.]+)$/.exec(scope);
    return m ? { kind: 'team', key: 'team:' + m[1] + ':' + m[2], teamId: m[1], slotId: m[2], role: '' } : null;
  }
  function whenText(ms) {
    var d = new Date(ms), now = new Date();
    var time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return time;
    var tomorrow = new Date(now.getTime() + 86400000);
    if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow ' + time;
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' + time;
  }

  /** Put this box's text on the schedule, due at dueMs, and empty the box. */
  function scheduleSend(t, dueMs) {
    var box = draftBox(t);
    var text = box ? String(box.value || '') : '';
    if (!text.trim()) { toast('Nothing to schedule.', 'Type the message first.'); return false; }
    if (!(dueMs >= Date.now() + SCHED_MIN_MS)) { toast('That time has passed.', 'Pick a time that is still ahead.'); return false; }
    var rec = { v: 1, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), scope: draftScope(t), text: text.slice(0, DRAFT_MAX_CHARS), due: dueMs, at: Date.now() };
    schedPut(rec);
    setComposerValue(box, '');
    saveDraft(rec.scope, '', true);
    notify(t, 'Scheduled for ' + whenText(dueMs) + '.', '"' + quoteOf(text) + '"');
    renderSched();
    return true;
  }
  /** Take the record in the store for this window before sending it, so another open window does not send it too. */
  async function schedClaim(rec) {
    if (sharedGone) return true;
    var c = rec.claim;
    if (c && c.by !== WINDOW_ID && Date.now() - Number(c.at) < SCHED_CLAIM_MS) return false;
    var key = SCHED_STORE + rec.id;
    var mine = Object.assign({}, rec, { claim: { by: WINDOW_ID, at: Date.now() } });
    var body = {};
    body[key] = mine;
    await putPrefs(body);
    var g = await getJson('/api/settings/client?keys=' + encodeURIComponent(key));
    var got = g.data && g.data[key];
    if (got && got.claim && got.claim.by === WINDOW_ID) { schedStore[rec.id] = got; return true; }
    return false;
  }
  async function schedSend(rec) {
    if (schedBusy[rec.id]) return;
    schedBusy[rec.id] = true;
    try {
      if (!(await schedClaim(rec))) return;
      var t = schedTarget(rec.scope);
      if (!t) { schedFail(rec, 'its chat is not known'); return; }
      var r = t.kind === 'conv'
        ? await postJson('/api/conversations/' + t.convId + '/messages', { content: rec.text })
        : await postJson('/api/teams/' + t.teamId + '/agents/' + encodeURIComponent(t.slotId) + '/messages', { content: rec.text });
      if (r.status === 401 || r.status === 403 || r.status === 404) { schedFail(rec, 'the chat refused it (' + r.status + ')'); return; }
      if (!r.ok) return;   // transient: the next check tries again
      schedRemove(rec.id);
      var late = Date.now() - rec.due > SCHED_LATE_MS;
      notify(t, 'Scheduled message sent' + (late ? ' late (it was due at ' + hhmm(rec.due) + ')' : '') + '.', '"' + quoteOf(rec.text) + '"');
      applyUserSent(t, rec.text);
      renderSched();
    } finally {
      delete schedBusy[rec.id];
    }
  }
  function schedFail(rec, reason) {
    var t = schedTarget(rec.scope);
    var failed = Object.assign({}, rec, { failed: reason, claim: null });
    schedStore[rec.id] = failed;
    schedPut(failed);
    if (t) notify(t, 'A scheduled message could not be sent: ' + reason + '.', '"' + quoteOf(rec.text) + '"');
    renderSched();
  }
  /** Send what is due. Waits for the store to answer first, so a message another window already sent is not sent twice. */
  function fireScheduled() {
    if (disabled() || !(sharedReady || sharedGone)) return;
    var now = Date.now();
    schedAll().forEach(function (r) { if (r.due <= now && !r.failed) schedSend(r).catch(function () {}); });
  }

  /** The button before AionUi's draft button in each message box. */
  function renderSched() {
    var live = {};
    targets().forEach(function (t) {
      var anchor = t.actions && (t.actions.querySelector('.sendbox-draft-tooltip-anchor:not(.aiondx-sched-wrap)') || t.actions.querySelector('.sendbox-send-tooltip-anchor'));
      if (!anchor || !anchor.parentNode) return;
      live[t.key] = true;
      var wrap = schedEls[t.key];
      if (!wrap) {
        wrap = document.createElement('span');
        wrap.className = 'sendbox-draft-tooltip-anchor aiondx-sched-wrap';
        wrap.innerHTML = '<button type="button" class="arco-btn arco-btn-secondary arco-btn-size-default arco-btn-shape-circle sendbox-draft-tool-action aiondx-sched" ' +
          'data-testid="aiondx-sched-btn" aria-haspopup="menu">' + ICON_SCHED + '<span class="aiondx-sched-count"></span></button>';
        wrap.firstChild.addEventListener('click', function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          var b = ev.currentTarget;
          if (b.disabled) return;
          if (schedMenu && schedMenu._key === wrap._t.key) closeSchedMenu(); else openSchedMenu(wrap);
        });
        schedEls[t.key] = wrap;
      }
      wrap._t = t;
      if (wrap.parentNode !== anchor.parentNode || wrap.nextSibling !== anchor) anchor.parentNode.insertBefore(wrap, anchor);
      var btn = wrap.firstChild;
      var box = draftBox(t);
      var has = !!(box && String(box.value || '').trim());
      var n = schedPending(draftScope(t)).length;
      var ok = has || n > 0;
      btn.disabled = !ok;
      btn.classList.toggle('sendbox-draft-tool-action--enabled', ok);
      btn.classList.toggle('sendbox-draft-tool-action--disabled', !ok);
      var count = btn.querySelector('.aiondx-sched-count');
      var label = n ? String(n) : '';
      if (count.textContent !== label) count.textContent = label;
      var tip = 'Schedule send' + (n ? ': ' + n + ' waiting' : has ? ': send this message later' : ': type a message first');
      if (btn.getAttribute('aria-label') !== tip) { btn.setAttribute('aria-label', tip); btn.title = tip; }
    });
    Object.keys(schedEls).forEach(function (k) {
      if (live[k]) return;
      var w = schedEls[k];
      if (w.parentNode) w.parentNode.removeChild(w);
      delete schedEls[k];
      if (schedMenu && schedMenu._key === k) closeSchedMenu();
    });
  }

  function closeSchedMenu() {
    if (!schedMenu) return;
    document.removeEventListener('mousedown', onSchedOutside, true);
    if (schedMenu.parentNode) schedMenu.parentNode.removeChild(schedMenu);
    schedMenu = null;
  }
  function onSchedOutside(ev) {
    if (!schedMenu) return;
    var w = schedEls[schedMenu._key];
    if (schedMenu.contains(ev.target) || (w && w.contains(ev.target))) return;
    closeSchedMenu();
  }
  function placeSchedMenu(wrap) {
    if (!schedMenu || !wrap) return;
    var r = wrap.getBoundingClientRect();
    var w = schedMenu.offsetWidth || 320, h = schedMenu.offsetHeight || 0;
    schedMenu.style.left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8) + 'px';
    var top = r.top - 6 - h;
    if (top < 8) top = Math.min(r.bottom + 6, Math.max(8, window.innerHeight - h - 8));
    schedMenu.style.top = Math.max(8, top) + 'px';
    schedMenu.style.bottom = 'auto';
  }
  function openSchedMenu(wrap) {
    closeSchedMenu();
    closeMenu();
    closeAcctMenu();
    hideTip();
    var m = document.createElement('div');
    m.className = 'aiondx-menu aiondx-sched-menu';
    m.setAttribute('role', 'menu');
    m.setAttribute('data-testid', 'aiondx-sched-menu');
    m._key = wrap._t.key;
    m.addEventListener('keydown', function (ev) { ev.stopPropagation(); if (ev.key === 'Escape') closeSchedMenu(); });
    document.body.appendChild(m);
    schedMenu = m;
    fillSchedMenu(m, wrap);
    setTimeout(function () { document.addEventListener('mousedown', onSchedOutside, true); }, 0);
  }
  function localInput(ms) {
    var d = new Date(ms);
    var p = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function fillSchedMenu(m, wrap) {
    var t = wrap._t;
    var scope = draftScope(t);
    var box = draftBox(t);
    var has = !!(box && String(box.value || '').trim());
    m.innerHTML = '<div class="arco-dropdown-menu"><div class="arco-dropdown-menu-group-title">Send this message later</div>' +
      '<div class="aiondx-sched-quick"></div>' +
      '<div class="aiondx-sched-custom"><input type="datetime-local" class="aiondx-sched-when" aria-label="Send at"><button type="button" class="arco-btn arco-btn-primary arco-btn-size-small aiondx-sched-go">Schedule</button></div>' +
      '<div class="aiondx-note aiondx-sched-note"></div>' +
      '<div class="arco-dropdown-menu-group-title aiondx-sched-waiting-title">Waiting</div><div class="aiondx-sched-list"></div></div>';
    var quick = m.querySelector('.aiondx-sched-quick');
    var now = Date.now();
    var nine = new Date(); nine.setHours(9, 0, 0, 0);
    if (nine.getTime() <= now + 60000) nine.setDate(nine.getDate() + 1);
    [['In 15 minutes', now + 15 * 60000], ['In 1 hour', now + 3600000], ['In 3 hours', now + 3 * 3600000],
     [(nine.getDate() === new Date().getDate() ? 'Today' : 'Tomorrow') + ' at 9:00', nine.getTime()]].forEach(function (q) {
      var it = document.createElement('div');
      it.className = 'arco-dropdown-menu-item aiondx-sched-quick-item' + (has ? '' : ' aiondx-sched-off');
      it.setAttribute('role', 'menuitem');
      it.innerHTML = '<span class="aiondx-item-title"></span><span class="aiondx-item-desc"></span>';
      it.querySelector('.aiondx-item-title').textContent = q[0];
      it.querySelector('.aiondx-item-desc').textContent = whenText(q[1]);
      it.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (!has) return;
        if (scheduleSend(t, q[1])) closeSchedMenu();
      });
      quick.appendChild(it);
    });
    var when = m.querySelector('.aiondx-sched-when');
    when.min = localInput(now + 60000);
    when.value = localInput(Math.ceil((now + 3600000) / 300000) * 300000);
    var go = m.querySelector('.aiondx-sched-go');
    go.disabled = !has;
    go.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      var ms = when.value ? new Date(when.value).getTime() : 0;
      if (!(ms > 0)) { toast('Pick a date and time first.'); return; }
      if (scheduleSend(t, ms)) closeSchedMenu();
    });
    m.querySelector('.aiondx-sched-note').textContent = has ? 'Text only: attachments in the box are not scheduled.' : 'Type the message in the box first.';
    var list = m.querySelector('.aiondx-sched-list');
    var items = schedPending(scope);
    m.querySelector('.aiondx-sched-waiting-title').style.display = items.length ? '' : 'none';
    items.forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'aiondx-sched-item';
      row.setAttribute('data-id', r.id);
      row.innerHTML = '<span class="aiondx-sched-item-when"></span><span class="aiondx-sched-item-text"></span>' +
        '<span class="aiondx-sched-item-btns"><button type="button" class="aiondx-bg-reset aiondx-sched-now">Send now</button><button type="button" class="aiondx-bg-reset aiondx-sched-cancel">Cancel</button></span>';
      row.querySelector('.aiondx-sched-item-when').textContent = r.failed ? 'Failed: ' + r.failed : whenText(r.due);
      row.querySelector('.aiondx-sched-item-text').textContent = quoteOf(r.text);
      var nowBtn = row.querySelector('.aiondx-sched-now');
      if (r.failed) nowBtn.textContent = 'Try again';
      nowBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var again = Object.assign({}, r, { due: Date.now(), failed: null, claim: null });
        schedPut(again).then(function () { fireScheduled(); });
        schedStore[r.id] = again;
        closeSchedMenu();
        fireScheduled();
      });
      row.querySelector('.aiondx-sched-cancel').addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        schedRemove(r.id);
        renderSched();
        if (schedMenu === m) fillSchedMenu(m, wrap);
      });
      list.appendChild(row);
    });
    placeSchedMenu(wrap);
  }

  // ---------------------------------------------------------------- the sidebar's team spinner (R-007, 2026-10-01)

  // K, 2026-10-01: "some of the teams sessions show (in the sidebar) that they are still running (spinning/swirly circle) when no
  // lane is moving". AionUi spins a team's sidebar icon while the team has an active run (useSiderTeamRunning: accepted, running or
  // cancelling), taken from run events and refreshed from the run snapshot only at load and on a reconnect. A run can stay open
  // with every member idle or paused, and a missed event leaves it spinning. AionDX asks the team's run-state every 10 seconds for
  // each spinner on screen, and where no member is running, starting or queued the spinner gives way to the team's own icon.
  var SPIN_CHECK_MS = 10000;
  var spinVerdict = {};     // team id -> { at, moving }
  var spinReading = {};     // team id -> a read in flight
  /** Whether any member of a team is working or about to. Not knowing counts as working: AionUi's spinner stays. */
  function teamMoving(runState) {
    var ws = runState && runState.slot_work;
    if (!Array.isArray(ws)) return true;
    return ws.some(function (w) { return !!w && (w.state === 'running' || w.state === 'starting' || w.state === 'queued' || !!w.active_turn_id); });
  }
  function readSpinner(id) {
    if (spinReading[id]) return;
    spinReading[id] = true;
    getJson('/api/teams/' + encodeURIComponent(id) + '/run-state').then(function (g) {
      spinVerdict[id] = { at: Date.now(), moving: g.err || !g.data ? true : teamMoving(g.data) };
    }, function () { spinVerdict[id] = { at: Date.now(), moving: true }; }).then(function () {
      delete spinReading[id];
      schedule();
    });
  }
  function reconcileSpinners() {
    var list = document.querySelectorAll('[data-testid^="team-spinner-"], [data-testid^="collapsed-team-spinner-"]');
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      var id = String(el.getAttribute('data-testid')).replace(/^(?:collapsed-)?team-spinner-/, '');
      var v = spinVerdict[id];
      if (!v || Date.now() - v.at > SPIN_CHECK_MS) readSpinner(id);
      var idle = !disabled() && !!v && !v.moving;
      if ((el.getAttribute('data-aiondx-idle') === '1') !== idle) {
        if (idle) { el.setAttribute('data-aiondx-idle', '1'); el.title = 'No member is working'; }
        else { el.removeAttribute('data-aiondx-idle'); el.removeAttribute('title'); }
      }
    }
  }

  // ---------------------------------------------------------------- links to local files that open outside AionUi (R-014, 2026-10-01)

  // K, 2026-09-27: "Oh, yeah the markdown link just opens it in AionDX. I want external folder links", and 2026-09-26: "allow the llm to
  // directly/symbolically link a file, basically placing a shortcut icon in chat with label space attached to it". AionUi turns a Markdown
  // link to a local path into a chip (components/Markdown/LocalFileLink.tsx: span[data-local-file-path], a button that opens AionUi's own
  // preview, a copy button), inside the message's open shadow root. AionDX adds a third button to each chip with an absolute path: it opens
  // the file the way Windows would (POST /api/shell/open-file: a folder in Explorer, a file in its own program), and Shift+click shows it
  // in its folder (/api/shell/show-item-in-folder). A chip for a folder, found by a trailing slash or by /api/fs/metadata, opens in
  // Explorer when clicked: AionUi's preview cannot show one. The shadow roots are not watched by the page's observer, so the chips are
  // looked for again at each live-state check (every 3 seconds).
  var ICON_EXT = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" style="width:14px;height:14px;display:block"><path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var dirCache = {};        // path -> { at, dir }
  function markdownRoots() {
    var out = [];
    var hosts = document.querySelectorAll('.markdown-shadow');
    for (var i = 0; i < hosts.length; i++) if (hosts[i].shadowRoot) out.push(hosts[i].shadowRoot);
    return out;
  }
  function absoluteLocalPath(p) { return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p) || /^\/(?:Users|home|tmp|private|var|mnt|Volumes)\//.test(p); }
  /** Open a local path as Windows would, or show it in its folder. */
  function openOutside(path, reveal) {
    var fail = function (why) { toast('Could not open it' + (why ? ' (' + why + ')' : '') + '.', path); return false; };
    return postJson(reveal ? '/api/shell/show-item-in-folder' : '/api/shell/open-file', { file_path: path })
      .then(function (r) { return r.ok ? true : fail(r.status); }, function () { return fail(''); });
  }
  function pathIsDir(path) {
    if (/[\\/]$/.test(path)) return Promise.resolve(true);
    var c = dirCache[path];
    if (c && Date.now() - c.at < 5 * 60000) return Promise.resolve(c.dir);
    return postJson('/api/fs/metadata', { path: path }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      var d = j ? unwrap(j) : null;
      var dir = !!(d && (d.is_directory || d.isDirectory));
      dirCache[path] = { at: Date.now(), dir: dir };
      return dir;
    }, function () { return false; });
  }
  function decorateLocalLinks() {
    if (disabled()) return;
    markdownRoots().forEach(function (root) {
      var chips = root.querySelectorAll('span[data-local-file-path]');
      for (var i = 0; i < chips.length; i++) {
        (function (chip) {
          var path = chip.getAttribute('data-local-file-path') || '';
          if (!absoluteLocalPath(path)) return;
          if (!chip.querySelector('.aiondx-ext')) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'aiondx-ext';
            b.setAttribute('aria-label', 'Open outside AionDX');
            b.title = 'Open outside AionDX (Shift+click: show it in its folder)';
            b.innerHTML = ICON_EXT;
            b.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;' +
              'border-radius:4px;background:transparent;color:inherit;opacity:.65;cursor:pointer;flex-shrink:0';
            b.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); openOutside(path, ev.shiftKey); });
            chip.appendChild(b);
          }
          if (!chip.hasAttribute('data-aiondx-dir-checked')) {
            chip.setAttribute('data-aiondx-dir-checked', '1');
            pathIsDir(path).then(function (dir) { if (dir) chip.setAttribute('data-aiondx-dir', '1'); });
          }
        })(chips[i]);
      }
    });
  }
  /** A click on a folder chip's label opens the folder in Explorer instead of AionUi's preview. */
  function watchLocalLinks() {
    window.addEventListener('click', function (ev) {
      if (disabled() || ev.defaultPrevented) return;
      var path = ev.composedPath ? ev.composedPath() : [];
      var label = null, chip = null;
      for (var i = 0; i < path.length; i++) {
        var n = path[i];
        if (!n || n.nodeType !== 1) continue;
        if (!label && n.classList && n.classList.contains('markdown-local-file-link')) label = n;
        if (n.hasAttribute && n.hasAttribute('data-local-file-path')) { chip = n; break; }
      }
      if (!label || !chip || chip.getAttribute('data-aiondx-dir') !== '1') return;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      openOutside(chip.getAttribute('data-local-file-path'), ev.shiftKey);
    }, true);
  }

  // ---------------------------------------------------------------- opening a team does not wake it (P-011)

  // K, 2026-09-24: "teams should not auto-wake just because you open the team's chat." Opening a
  // team page calls POST /api/teams/{id}/session (useTeamWarmup; TeamPermissionContext calls it
  // too, as a head start before a mode or model change). For a team with no session yet, as after
  // every AionUi restart, that starts one, attaches the lead and queues the lead's unread mailbox
  // as work (aionui-team service.rs ensure_session_inner, try_start_recovery_drain), so the lead
  // takes turns and wakes its teammates. Nothing needs that call: every real send (K's, the
  // Loop's, an agent's) starts the session itself (send_message, send_message_to_agent,
  // interrupt_agent, attach and restart all call ensure_session_inner), and the mode and model
  // pickers read the conversation, not the session. So when run-state says the team has no
  // session (session_generation null), the call is answered here and never reaches the backend.
  // A team whose session is running gets the real call: it only reconciles member runtimes, and
  // the drain runs once per session. Any failure to tell passes the call through unchanged.
  var nativeFetch = window.fetch;
  var heldWakes = {};   // team id -> when the page's wake call was last answered here
  function reqMethod(input, init) { return String((init && init.method) || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase(); }
  function reqUrl(input) { return typeof input === 'string' ? input : (input && input.url) || String(input || ''); }
  /** The id in a request's path when the method and path match, else null. */
  function callId(re, input, init, methods) {
    if (methods.indexOf(reqMethod(input, init)) < 0) return null;
    var m = re.exec(reqUrl(input));
    return m ? decodeURIComponent(m[1]) : null;
  }
  var TEAM_SESSION_RE = /\/api\/teams\/([^/?#]+)\/session(?:[?#]|$)/;
  function holdTeamWake(teamId, args) {
    return nativeFetch.call(window, apiUrl('/api/teams/' + encodeURIComponent(teamId) + '/run-state'), { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var d = j && j.data !== undefined ? j.data : j;
        if (d && typeof d === 'object' && d.session_generation == null) {
          heldWakes[teamId] = Date.now();
          console.log('[dx] team ' + teamId + ' has no session; opening it did not wake it (it starts on the first message)');
          return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return nativeFetch.apply(window, args);
      }, function () { return nativeFetch.apply(window, args); });
  }

  // ---------------------------------------------------------------- opening a chat does not start its agent

  // K, 2026-09-26: agents "touching off on their own or just by viewing the team window", "or chat"; he chose "Don't
  // start chats on open". Opening a solo chat sends POST /api/conversations/{id}/runtime/ensure from five hooks on
  // mount (the header model picker, the send box's model and mode hooks, the permission pill, the message warmup),
  // and for Claude, Codex and the other ACP agents that starts the agent's process. Research: ! LLM Files\Research\
  // 2026-09-26_chat-start-on-open.md. The first message starts the agent anyway (AionCore's send builds it), so for an
  // ACP chat whose agent is not running the call is held here, unanswered, until the chat's first send is accepted,
  // a /btw question or a picker change needs the agent, or the user presses the model pill; then it goes through once
  // and the pickers fill with the agent's own options. A chat whose agent runs, Antigravity (it starts nothing),
  // aionrs, and any doubt (a failed lookup, the kill switch) go straight through.
  var heldStarts = {};   // conversation id -> [{ args, resolve, reject, at }]
  var ENSURE_RE = /\/api\/conversations\/([^/?#]+)\/runtime\/ensure(?:[?#]|$)/;
  var SEND_RE = /\/api\/conversations\/([^/?#]+)\/messages(?:[?#]|$)/;
  var NEEDS_AGENT_RE = /\/api\/conversations\/([^/?#]+)\/(?:side-question|config-options\/[^/?#]+)(?:[?#]|$)/;
  // ---------------------------------------------------------------- model names with their versions

  // K, 2026-09-26, from the friend's install: the model pickers showed "Fable", "Opus", "Sonnet", the version only on
  // hover. Claude Code names its aliases by family and puts the version in the description ("Opus 5.5 with 1M
  // context · $4/$20 per Mtok"), which AionUi shows as a tooltip. Every model list that reaches this page through
  // runtime/ensure is read for those descriptions, and the names in the pills and menus get their version: "Opus 5.5",
  // "Opus 5.5 (1M context)", "Default (Opus 5.5)". The names learned are kept, so a chat whose agent has not started
  // yet shows them too.
  var MODEL_LS = KEY_PREFIX + 'modelLabels';
  var modelLabels = (function () { try { return JSON.parse(localStorage.getItem(MODEL_LS)) || {}; } catch (e) { return {}; } })();
  function versionedName(name, desc) {
    name = String(name || '').trim();
    desc = String(desc || '');
    var fam = /\b(Opus|Sonnet|Haiku|Fable)\s+(\d+(?:\.\d+)?)/i.exec(desc);
    if (!name || !fam) return null;
    var family = fam[1].charAt(0).toUpperCase() + fam[1].slice(1).toLowerCase();
    if (/^default\b/i.test(name)) return 'Default (' + family + ' ' + fam[2] + ')';
    var at = new RegExp('^' + family + '\\b', 'i').exec(name);
    if (!at || new RegExp('^' + family + '\\s+\\d', 'i').test(name)) return null;   // another family, or it has a version already
    return family + ' ' + fam[2] + name.slice(family.length);
  }
  /** Reads a runtime/ensure answer (or any JSON with model options) for names to give versions. */
  function learnModels(json) {
    var changed = false;
    var visit = function (node, depth) {
      if (!node || typeof node !== 'object' || depth > 8) return;
      if (Array.isArray(node)) { node.forEach(function (x) { visit(x, depth + 1); }); return; }
      var name = node.name || node.label, desc = node.description;
      if (typeof name === 'string' && typeof desc === 'string' && (node.value !== undefined || node.id !== undefined)) {
        var v = versionedName(name, desc);
        if (v && modelLabels[name] !== v) { modelLabels[name] = v; changed = true; }
      }
      Object.keys(node).forEach(function (k) { if (node[k] && typeof node[k] === 'object') visit(node[k], depth + 1); });
    };
    visit(json, 0);
    if (changed) { try { localStorage.setItem(MODEL_LS, JSON.stringify(modelLabels)); } catch (e) {} schedule(); }
  }
  function tapModels(r) {
    try { if (r && r.ok) r.clone().json().then(learnModels, function () {}); } catch (e) { /* the answer goes on as it is */ }
    return r;
  }
  /** The pills ("Opus · High") and the model menu's rows get the versioned names. A pill React relabels (a model
   *  or effort change sets its text node again) is watched and relabelled at once. */
  var labelWatched = typeof WeakSet === 'function' ? new WeakSet() : null;
  function relabelHost(host) {
    var w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = w.nextNode())) {
      var t = n.nodeValue, trimmed = t.trim();
      if (!trimmed) continue;
      var head = trimmed.split(' · ')[0];
      var v = modelLabels[head];
      if (v && v !== head) n.nodeValue = t.replace(head, v);
    }
  }
  function labelModels() {
    if (disabled() || !Object.keys(modelLabels).length) return;
    var hosts = document.querySelectorAll('.sendbox-model-btn, .header-model-btn, [data-testid^="acp-model-selector"], .arco-dropdown-menu-item .min-w-0.truncate');
    for (var i = 0; i < hosts.length; i++) {
      relabelHost(hosts[i]);
      if (labelWatched && !labelWatched.has(hosts[i]) && hosts[i].matches('.sendbox-model-btn, .header-model-btn, [data-testid^="acp-model-selector"]')) {
        labelWatched.add(hosts[i]);
        (function (h) { new MutationObserver(function () { if (!disabled()) relabelHost(h); }).observe(h, { characterData: true, childList: true, subtree: true }); })(hosts[i]);
      }
    }
  }

  function holdStart(convId, args) {
    return nativeFetch.call(window, apiUrl('/api/conversations/' + encodeURIComponent(convId)), { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var d = j && j.data !== undefined ? j.data : j;
        var cold = !!(d && typeof d === 'object' && d.type === 'acp' && d.runtime && d.runtime.has_task === false);
        if (!cold || disabled()) return nativeFetch.apply(window, args).then(tapModels);
        return new Promise(function (resolve, reject) {
          (heldStarts[convId] = heldStarts[convId] || []).push({ args: args, resolve: resolve, reject: reject, at: Date.now() });
          console.log('[dx] chat ' + convId + ': its agent is not running, and opening the chat did not start it (the first message does)');
          schedule();
        });
      }, function () { return nativeFetch.apply(window, args).then(tapModels); });
  }
  /** Lets a chat's held calls through: one reaches the backend, and every caller gets the answer. */
  function releaseStarts(convId, why) {
    var held = heldStarts[convId];
    if (!held || !held.length) return Promise.resolve(false);
    delete heldStarts[convId];
    console.log('[dx] chat ' + convId + ': ' + why + '; its agent starts now');
    schedule();
    return nativeFetch.apply(window, held[0].args).then(function (r) {
      tapModels(r);
      var copies = held.map(function (h, i) { return i === 0 ? r : r.clone(); });
      held.forEach(function (h, i) { h.resolve(copies[i]); });
      return true;
    }, function (e) { held.forEach(function (h) { h.reject(e); }); return false; });
  }
  /** Pressing the model or mode pill of a chat whose start is held starts it, so its models are there for the next press. */
  function watchPickerPress() {
    document.addEventListener('pointerdown', function (ev) {
      try {
        var r = route();
        if (!r || r.kind !== 'conv' || !heldStarts[r.id]) return;
        var t = ev.target && ev.target.closest ? ev.target.closest('[data-testid^="acp-model-selector"], [data-testid="mode-selector"]') : null;
        if (t) releaseStarts(r.id, 'the model pill was pressed');
      } catch (e) { /* nothing to release */ }
    }, true);
  }
  /** The open chat's start is held: its model pill loses the endless spinner and shows it can be pressed. */
  function markHeldStart() {
    var r = route();
    var id = r && r.kind === 'conv' && heldStarts[r.id] && heldStarts[r.id].length ? r.id : null;
    var root = document.documentElement;
    if (id) { if (root.getAttribute('data-aiondx-held') !== id) root.setAttribute('data-aiondx-held', id); }
    else if (root.hasAttribute('data-aiondx-held')) root.removeAttribute('data-aiondx-held');
  }

  var ANY_SEND_RE = /\/api\/((?:conversations\/[^/?#]+|teams\/[^/?#]+(?:\/agents\/[^/?#]+)?))\/messages(?:[?#]|$)/;
  /** The text of a message send's JSON body (content, or input on a team's route); null when there is none. */
  function sentText(init) {
    try {
      var b = init && typeof init.body === 'string' ? JSON.parse(init.body) : null;
      var t = b && (b.content !== undefined ? b.content : b.input !== undefined ? b.input : b.text);
      return typeof t === 'string' ? t : null;
    } catch (e) { return null; }
  }
  function guardFetch() {
    window.fetch = function (input, init) {
      var args = arguments;
      var id;
      try {
        if (!disabled()) {
          if ((id = callId(TEAM_SESSION_RE, input, init, ['POST']))) return holdTeamWake(id, args);
          if ((id = callId(ENSURE_RE, input, init, ['POST']))) return holdStart(id, args);
          if (callId(/\/api\/conversations\/([^/?#]+)\/config-options(?:[/?#]|$)/, input, init, ['GET', 'PUT', 'POST'])) return nativeFetch.apply(window, args).then(tapModels);
          // Every agent's catalog (its model options, with the descriptions that carry the versions). The new-chat page,
          // the chat pills and the agent pickers read it; a chat's own start answers without models (measured
          // 2026-09-26, the standalone app), so this is where the versions come from.
          if (callId(/\/api\/(agents)(?:\/management)?(?:[?#]|$)/, input, init, ['GET'])) return nativeFetch.apply(window, args).then(tapModels);
          if ((id = callId(NEEDS_AGENT_RE, input, init, ['POST', 'PUT'])) && heldStarts[id]) {
            return releaseStarts(id, 'a command needs its agent').then(function () { return nativeFetch.apply(window, args); });
          }
          // A message that starts with /plugin and reaches the send by any other road (a queued draft, say): the panel
          // takes it, and the send is refused with a reason AionUi can show. Nothing goes to the agent.
          var sentPlugin = callId(ANY_SEND_RE, input, init, ['POST']) ? sentText(init) : null;
          if (sentPlugin !== null && isPluginCommand(sentPlugin)) {
            openPlugins(pluginArgs(sentPlugin));
            return Promise.resolve(new Response(JSON.stringify({ success: false,
              error: 'AionDX opened its Plugins panel for "' + sentPlugin.trim().split(/\s+/)[0] + '"; nothing was sent to the agent.' }),
              { status: 409, headers: { 'Content-Type': 'application/json' } }));
          }
          if ((id = callId(SEND_RE, input, init, ['POST'])) && heldStarts[id]) {
            var sent = id;
            return nativeFetch.apply(window, args).then(function (r) {
              if (r.ok) releaseStarts(sent, 'a message was sent');
              return r;
            });
          }
        }
      } catch (e) { /* the real call, as stock */ }
      return nativeFetch.apply(window, args);
    };
  }
  guardFetch();

  // ---------------------------------------------------------------- team column scrolling

  // K, 2026-09-24: "when I click into a chat, it automatically scoots my window so that chat is
  // in the far left column. I want to do the navigating with the side arrows." TeamPage.tsx
  // scrolls a column into view (inline: 'start') whenever it becomes the active member, and
  // clicking into its message box makes it active (TeamChatView onFocus -> switchTab). So a
  // column's scrollIntoView that follows your own press inside that same column is dropped.
  // The side arrows, the member tabs and programmatic jumps to another member still scroll.
  var lastColumnPress = { slot: null, at: 0 };
  function guardColumnScroll() {
    document.addEventListener('pointerdown', function (ev) {
      var col = ev.target && ev.target.closest ? ev.target.closest('[data-slot-id]') : null;
      lastColumnPress = col ? { slot: col.getAttribute('data-slot-id'), at: Date.now() } : { slot: null, at: 0 };
    }, true);
    var original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function () {
      try {
        if (!disabled() && this.hasAttribute && this.hasAttribute('data-slot-id') &&
            this.getAttribute('data-slot-id') === lastColumnPress.slot && Date.now() - lastColumnPress.at < 1500) {
          return undefined;
        }
      } catch (e) { /* fall through to the real scroll */ }
      return original.apply(this, arguments);
    };
  }

  function start() {
    ensureStyle();
    themePrefs = loadThemePrefs();
    applyThemePrefs(themePrefs);
    watchSends();
    watchDrafts();
    watchRespondNow();
    watchPermissionHover();
    watchAcctHover();
    watchLocalLinks();
    window.addEventListener('resize', schedule);
    guardColumnScroll();
    watchPickerPress();
    // Bubble phase: AionUi's own right-click menus run first and mark the event handled.
    document.addEventListener('contextmenu', onContextMenu);
    render();
    pulse().catch(function () {});
    setInterval(function () { pulse().catch(function (e) { console.log('[dx] pulse error', e); }); }, PULSE_MS);
    setInterval(function () { try { decorateLocalLinks(); } catch (e) {} }, PULSE_MS);
    setInterval(function () { scanTeamQueues().catch(function () {}); }, 4000);
    setInterval(function () { try { fireScheduled(); } catch (e) { console.log('[dx] schedule error', e); } }, 5000);
    // Re-insert pills whenever React rebuilds a composer. Throttled to one check
    // per frame, and changes inside our own nodes are ignored.
    new MutationObserver(function (records) {
      if (foreignChange(records)) schedule();
    }).observe(document.body, { childList: true, subtree: true });
    new MutationObserver(function () { try { paintContextRings(); } catch (e) {} })
      .observe(document.body, { attributes: true, attributeFilter: ['stroke-dashoffset'], subtree: true });
    window.addEventListener('hashchange', function () { closeMenu(); closeAcctMenu(); hideTip(); schedule(); });
    window.addEventListener('scroll', hideTip, true);
    window.addEventListener('blur', hideTip);
    setInterval(function () {
      render();
      tick().catch(function (e) { console.log('[dx] tick error', e); });
    }, POLL_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  function firstTarget() { var l = targets(); return l.length ? l[0] : null; }
  window.__aionDx = {
    targets: function () { return targets().map(function (t) { return { key: t.key, on: state(t).on }; }); },
    status: function () { var t = firstTarget(); return t ? state(t) : null; },
    on: function () { var t = firstTarget(); if (t) setOn(t, true, 'console'); },
    off: function () { var t = firstTarget(); if (t) setOn(t, false, 'console'); },
    tickNow: function () { return tick(); },
    stored: function () { return storedTargets().map(function (t) { return { key: t.key, on: state(t).on }; }); },
    repaint: function () { render(); },
    pulseNow: function () { return Promise.resolve(pulseRun).then(function () { return pulse(); }); },
    agent: function (key) { return agentLive[key] || null; },
    heldWakes: function () { return heldWakes; },
    heldStarts: function () { var o = {}; Object.keys(heldStarts).forEach(function (k) { o[k] = heldStarts[k].length; }); return o; },
    accounts: function () { return { rec: accountsRec, prefs: accountPrefs, agents: agentPrefs, list: agentList.all }; },
    usage: function () { return { acct: usageAcct, conv: usageConv }; },
    statedResetMs: function (text, at) { return statedResetMs(text, at); },
    ctxColour: function (pct) { return ctxColour(pct); },
    sched: function () { return schedAll(); },
    spinners: function () { return spinVerdict; },
    decorateLinks: function () { return decorateLocalLinks(); },
    spinReset: function () { spinVerdict = {}; schedule(); },
    fireSched: function () { return fireScheduled(); },
    accountLimit: function (convId) { return accountLimit(convId); },
    unsend: function () { return { results: unsendResults, pending: unsendPending }; },
    scanQueues: function () { return scanTeamQueues(); },
    drafts: function () { return { store: draftStore, restored: draftRestored }; },
    syncDrafts: function () { syncDrafts(false); },
    setLive: function (key, st) { agentLive[key] = { state: st }; },
    shared: function () { return shared; },
    pullNow: function () { return pullShared(); },
    build: BUILD,
    saysStop: function (text) { return saysStop(text); },
    saysLoopOff: function (text) { return saysLoopOff(text); },
    asksLoopOff: function (text) { return asksLoopOff(text); },
    plugins: function () { return plugins; },
    diag: function () { return diagList; },
    stop: function () { try { localStorage.setItem(KEY_PREFIX + 'disabled', '1'); } catch (e) {} render(); },
    start: function () { try { localStorage.removeItem(KEY_PREFIX + 'disabled'); } catch (e) {} render(); }
  };
})();
