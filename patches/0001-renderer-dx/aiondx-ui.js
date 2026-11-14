/* aiondx-ui.js - injected into the AionUi renderer via a <script> tag in
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
 * loop's box switched that loop off. The owner talks to their agents all the time, so every team loop they
 * switched on was off again before it ever fired: each saved team loop read "Off: you sent a
 * message", 0 sends, which they read as "the loop only works for claude agents". Now a send of
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
 * keeps a prompt cached for a set time after its last use and refreshes that free each time it is read:
 * 5 minutes for every AionDX chat until October 12th, 2026, and one hour for a subscriber's main
 * conversation since then (5 minutes on extra usage). The length is decided on Anthropic's side, so
 * AionDX measures it: the launcher reads each answer's cache write (claude-stream-proxy.js) into
 * aiondx.cache.conv.<chat>, and the Loop counts from that record (cacheWindow). A chat without one
 * is counted at 5 minutes. A nudge inside the window reads the cache (0.1x the input price); a nudge
 * after it writes the whole context again (1.25x, 2x for an hour cache). Until build 2026-09-25.4 a short reply ("nothing to do yet") pushed
 * the next nudge to 5, 10, 20 and 30 minutes after the last one, so almost every nudge after the
 * second paid a full reload. A team lead logged it (AionDX dev log, September 25th), and the owner reported the same: usage burned on
 * re-caching. Now, counted from the agent's own last message:
 *   - after real work the next nudge goes once the chat is quiet (20 s);
 *   - after a short reply (under 3 minutes, fewer than 6 tool-call records) it goes at 2 minutes,
 *     then 4, 8, 15 and 30 after more of them, never later than its keep-warm time (6 minutes before an
 *     hour cache runs out, 1 minute before a 5-minute one);
 *   - after 45 minutes of short replies (the hold; 12 warm reads cost about one reload) it RESTS:
 *     no more nudges, and the cache is allowed to expire;
 *   - an agent whose cache has already expired (2 minutes before an hour cache's end, 20 s before a
 *     5-minute one's) is never nudged. Until November 11th, 2026 this counted 5 minutes from the last
 *     message whatever the real length, so a lane whose nudge was held up a few minutes (team spacing,
 *     a draft, your message) was put to rest with its cache still warm for most of an hour, and its next
 *     turn paid to write it again. It rests until someone else gives
 *     it work; the Loop carries on after that turn. Switching a Loop on for a cold agent sends one
 *     nudge, because someone asked for exactly that.
 * So a Loop left on overnight, or on after AionUi was closed, does nothing to a cold agent.
 *
 * YOUR STOP SWITCHES IT OFF. A message you send that says stop ("stop", "time to stop work", "stand
 * down", "we're done", "good night" and the rest of STOP_RES) switches off the Loop of that chat,
 * or every Loop of that team. A team lead found the Loop nudging at 06:58 after the owner had ended
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
 * "Loop · On", which the owner found too wide for team columns.
 *
 * SHARED WITH AGENTS (since 2026-09-24, P-010). a request. Each Loop's settings (on
 * or off, the continue message, a compaction request) are kept in AionUi's per-user settings
 * store, GET/PUT /api/settings/client, where the AionDX Loop tool (patches\0007-loop-tool, an MCP
 * server every agent gets) reads and writes the same record: aiondx.loop.conv.<id> and
 * aiondx.loop.team.<teamId>.<slotId>. This script reads them on every check (every 3 s), so a
 * change an agent makes shows within seconds: a notice at the top of the window with the agent's
 * name and note, and a purple mark on the button for 10 minutes. What the Loop last decided goes
 * to aiondx.loopstatus.<same> for the tool's loop_status, and aiondx.engine says this script is
 * running. Counters and timers stay in localStorage. Conversation extra was the first plan, but a
 * PATCH there stamps updated_at and the sidebar sorts by it, so every toggle would have moved the
 * chat to the top of the owner's list.
 *
 * UNSEND, THE ACCOUNT PILL, NOTICES THAT SAY WHERE (since 2026-09-25). A message a Claude chat has not
 * read yet ("Unread" under it) gets an Unsend button (see "unsend" below). A Claude chat gets an
 * account pill beside AionUi's model picker (see "the chat's Claude account"). Every notice names its
 * team and member, or its chat, and a click opens it. (Build 2026-09-25.4 held messages to a working
 * agent in an outbox above the box first. a request. Removed in 2026-09-25.5.)
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
  // R-100 (2026-11-12, from a measurement on a team of November 10th: agents opened a skill only when their Loop message said to). Added to
  // every plain continue nudge, whatever its message, unless the option loop.skillsLine is off.
  var SKILLS_LINE = ' Skills: before a task, check your project\u2019s skills (its *-procedures skill lists them); when you learn a better way, update the matching skill.';

  // The cache window; see the header.
  var CACHE_TTL_MS = 5 * 60000;           // the length counted for a chat with no measured record (cacheWindow)
  var SHORT_TURN_MS = 3 * 60000;          // a turn after a nudge shorter than this ...
  var SHORT_TURN_TOOL_RECORDS = 6;        // ... with fewer tool-call records than this is "nothing to do"
  var NUDGE_WAITS_MS = [2, 4, 8, 15, 30].map(function (m) { return m * 60000; });  // after 1, 2, 3... short replies, from its last message; capped by the cache
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
  // narrowed where the owner also says them to agents about their work ("stop the tournament", "that's
  // enough data", "pause the spread", "shut it down" about a process), plus "time to stop" and
  // "good night". A phrase that negates stop ("don't stop", "until I tell you to stop") never counts.
  // Each is tested clause by clause (split at . ! ? ; , and line breaks), and a phrase in a clause
  // that begins with when, once, after, until, before, if and the like (STOP_SUBORD_RE) does not
  // count: build 2026-09-25.5 read "...and then swap it when we are done testing", said to the
  // team lead about a game install, as the owner's stop and switched off both members' Loops; their
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
  // A stop that is not the Loop's. September 28th, one message to a team lead stood two teammates down and let a third carry on, and every Loop in the team
  // went off, the third's too. So a message that carves someone out ("let Builder continue working", "except Worker") stops nothing, a stop told to be relayed to
  // others ("have them stand down", "tell Worker to stand down") is the lead's to carry out, and a stop followed by its
  // condition ("stand down once it is produced") waits for the condition. The owner can say it plainly to stop everyone.
  var STOP_CARVE_RES = [
    /\b(?:let|keep|leave)\s+(?!(?:me|us|you|it\s+be)\b)[\w'-]+(?:\s+[\w'-]+){0,3}?\s+(?:continue|carry\s+on|keep\s+(?:going|working|running)|go\s+on|going|running|working)\b/i,
    /\b(?:except|excluding|other\s+than|apart\s+from|aside\s+from)\s+\S/i,
    /\b(?:but|though)\s+(?:keep|let|leave)\b/i];
  var STOP_RELAY_RE = /\b(?:have|tell|ask|get|make|order|instruct|want)\s+(?:the\s+)?(?!(?:everyone|everybody|all|the\s+team|us|you|y'?all|to)\b)[\w'-]+(?:\s+[\w'-]+){0,2}?\s+(?:to\s+)?$/i;
  var STOP_THEN_COND_RE = /^\s*(?:and\s+|then\s+)?(?:once|when|whenever|after|until|till|if|unless|as\s+soon\s+as)\b/i;
  var STOP_SUBORD_RE = /\b(?:when|whenever|once|after|until|till|before|if|unless|as\s+soon\s+as|by\s+the\s+time|so\s+that|in\s+case)\b/i;
  // Turning the Loop itself off, said to one chat or member (a request of 2026-09-26).
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
  // that runs until you stop it only after that, from that chat (the owner's words, which no agent writes).
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
  var BUILD = '2026-11-13.1';
  var PAGE_LOADED_AT = /[?&]dxopen=0(&|$)/.test(String(location.search || '')) ? 0 : Date.now();   // (the test harness passes dxopen=0) 2026-10-31: nothing the Loop does starts within a minute of the page opening, and a resume time that passed before it opened is dropped
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
  /** forever: on until the user stops it (a request of 2026-09-26). No hold, no rest, no giving up. */
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
    // The menu, the console and your stop phrases are the owner; anything else is the Loop switching itself off.
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
  // it. A team's "Loop buttons gone" (a request of 2026-09-26) was this view: the Loop looked only for member
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
   *  one an agent switched on in a chat the owner has never opened. */
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
   *  team lead switched Loops on and the owner saw nothing change; aioncore's request log showed no
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
    var c = { at: Date.now(), ok: false, name: '', map: {}, backend: {}, names: {}, assistants: {}, roles: {} };
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
        c.roles[m.slot_id] = String(m.role || '');
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
  /** "December 13th": a date as it is written in AionDX's text. */
  function longDate(ms) {
    var d = new Date(ms), n = d.getDate();
    var suf = (n % 100 >= 11 && n % 100 <= 13) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
    return ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][d.getMonth()] + ' ' + n + suf;
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
    takeOptions(g.data);
    takeAccounts(g.data);
    takeUsage(g.data);
    takeGroups(g.data);
    notifyOff = g.data['system.notificationEnabled'] === false;
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

  // ---------------------------------------------------------------- options: every choice AionDX offers, in one list that an agent can read

  // A request of 2026-10-20: AionDX should be configurable by the agent of any user. Every choice a user can make is an entry in OPTIONS, with a plain
  // label, what it does, its default and its limits. The Settings page draws its rows from the list, the list is published to the settings store
  // (aiondx.options.schema), and `aiondx config list | get | set | reset` (the command line and the aiondx-loop MCP tool) read and change the values
  // in the store (aiondx.options), so an agent needs no knowledge of this page. The page takes a newer value from the store within seconds. A value
  // equal to the default is not stored. `via` entries are mechanisms with their own command; they are listed so an agent finds them.
  var OPTIONS_KEY = 'aiondx.options', OPTIONS_SCHEMA_KEY = 'aiondx.options.schema';
  var OPTIONS_LS = KEY_PREFIX + 'options';
  var OPTIONS = [
    { id: 'links.files', group: 'Links', type: 'choice', default: 'outside', choices: [['outside', 'Outside AionDX (its own program, or Explorer for a folder)'], ['preview', 'A preview tab inside AionDX']],
      label: 'Open file and folder links in', desc: 'Where a link to a file or folder on this PC opens. A folder always opens in Explorer. Alt+click uses the other one; Shift+click shows it in its folder.' },
    { id: 'links.docs', group: 'Links', type: 'choice', default: 'browser', choices: [['pane', 'A pane beside the chat, inside AionDX'], ['browser', 'Your web browser']],
      label: 'Open Claude Docs in', desc: 'Where a Claude Doc link opens. The pane keeps its own Claude sign-in, asked for once. Alt+click uses the other one.' },
    { id: 'help.tips', group: 'Help', type: 'bool', default: true,
      label: 'Show tips for AionDX\u2019s controls', desc: 'A bubble points at each AionDX control the first time it is on screen and says how to use it, until you press Got it. Off hides them all.' },
    { id: 'loop.skillsLine', group: 'The Loop', type: 'bool', default: true,
      label: 'Remind agents of their skills', desc: 'Each Loop nudge to keep working ends with one line: check the project\u2019s skills before a task, and update the matching skill when you learn a better way. Agents rarely open a skill unless told (measured on a team, November 10th).' },
    { id: 'spellcheck', group: 'Typing', type: 'bool', default: true,
      label: 'Check spelling', desc: 'Underline misspelled words in message boxes; right-click one for suggestions.' },
    { id: 'draft.quote', group: 'Typing', type: 'bool', default: true,
      label: 'Keep a reply quote with its draft', desc: 'A message you are replying to stays quoted over the unsent draft, through a restart.' },
    { id: 'voice.system', group: 'Voice', type: 'bool', default: true,
      label: 'Read replies with the Windows voice when there is no key', desc: 'The speaker button on a reply uses the voice Windows already has (free, offline) until an ElevenLabs key is set.' },
    { id: 'stop.show', group: 'Stop', type: 'number', min: 1, max: 120, unit: 'seconds', default: 3,
      label: 'Show a Stop button after', desc: 'A chat that is working with no Stop button on screen gets AionDX’s own after this many seconds.' },
    { id: 'stop.force', group: 'Stop', type: 'number', min: 2, max: 60, unit: 'seconds', default: 5,
      label: 'End the agent if Stop has not taken after', desc: 'Stop always halts (a request of 2026-11-09). Pressing it cancels the turn and sends the cancel again; a chat still working this long after the press has its agent ended and started again, history kept, with no second click.' },
    { id: 'lag.bigPage', group: 'Long chats', type: 'number', min: 100, max: 20000, unit: 'rows', default: 400,
      label: 'A long chat starts at', desc: 'Above this many message rows, AionDX does less work per change of the page, so typing stays quick.' },
    { id: 'lag.chainPages', group: 'Long chats', type: 'number', min: 1, max: 50, unit: 'pages', default: 3,
      label: 'Older pages loaded without scrolling', desc: 'A chat loads its older messages 50 at a time as you scroll up. When a page asks for more by itself, with no scrolling from you, only this many are fetched; the rest wait until you scroll.' },
    { id: 'via.loop', via: 'aiondx loop set --help', group: 'Other settings', type: 'command', label: 'The Loop', desc: 'Keeps an agent working: on or off, message, hold, compaction, per member.' },
    { id: 'via.usage', via: 'aiondx usage --help', group: 'Other settings', type: 'command', label: 'Usage meter and alerts', desc: 'Your Claude account’s usage, and alerts at a percentage.' },
    { id: 'via.mcp', via: 'aiondx mcp --help', group: 'Other settings', type: 'command', label: 'MCP servers', desc: 'Add, switch and call the MCP servers of a chat or of every chat.' },
    { id: 'via.theme', via: 'Settings > Appearance', group: 'Other settings', type: 'command', label: 'Colours', desc: 'Accent, backdrop, chat bubbles and the context ring; the page owns them (aiondx.theme in the settings store).' },
    { id: 'via.caches', via: 'Settings > Appearance > Agent caches', group: 'Other settings', type: 'command', label: 'Agent caches', desc: 'Clear what Claude Code, Devin and AionDX keep on this PC, by age.' }
  ];
  var optionValues = (function () { try { return (JSON.parse(localStorage.getItem(OPTIONS_LS)) || {}).values || {}; } catch (e) { return {}; } })();
  var optionsAt = (function () { try { return Number((JSON.parse(localStorage.getItem(OPTIONS_LS)) || {}).at) || 0; } catch (e) { return 0; } })();
  var optionsSchemaSent = null;
  function optionDef(id) { for (var i = 0; i < OPTIONS.length; i++) if (OPTIONS[i].id === id) return OPTIONS[i]; return null; }
  /** A value cleaned up to what the option allows, or undefined when it is not allowed at all. */
  function cleanOption(def, v) {
    if (!def || def.type === 'command') return undefined;
    if (def.type === 'bool') {
      if (v === true || v === false) return v;
      var s = String(v).toLowerCase();
      if (/^(1|true|yes|on)$/.test(s)) return true;
      if (/^(0|false|no|off)$/.test(s)) return false;
      return undefined;
    }
    if (def.type === 'number') {
      if (v === '' || v === null || v === undefined) return undefined;
      var n = Number(v);
      if (!isFinite(n)) return undefined;
      return Math.min(def.max, Math.max(def.min, Math.round(n)));
    }
    if (def.type === 'choice') {
      var c = String(v).toLowerCase();
      for (var i = 0; i < def.choices.length; i++) if (def.choices[i][0] === c) return c;
      return undefined;
    }
    return String(v);
  }
  function opt(id) {
    var def = optionDef(id);
    if (!def) return undefined;
    var v = Object.prototype.hasOwnProperty.call(optionValues, id) ? cleanOption(def, optionValues[id]) : undefined;
    return v === undefined ? def.default : v;
  }
  function saveOptions(at) {
    optionsAt = at;
    try { localStorage.setItem(OPTIONS_LS, JSON.stringify({ values: optionValues, at: optionsAt })); } catch (e) {}
  }
  /** Set (or, with undefined, reset) one option from this window: kept here and written to the store. Returns the value now in force. */
  function setOption(id, value) {
    var def = optionDef(id);
    if (!def || def.type === 'command') return undefined;
    var v = value === undefined ? undefined : cleanOption(def, value);
    if (value !== undefined && v === undefined) return undefined;
    if (v === undefined || v === def.default) delete optionValues[id]; else optionValues[id] = v;
    saveOptions(Date.now());
    var rec = {}; rec[OPTIONS_KEY] = { values: optionValues, at: optionsAt, by: 'user' };
    putPrefs(rec);
    applyOptions();
    refreshOptionsUi();
    return opt(id);
  }
  /** A newer record from the store (the command line, an agent, another window) wins. */
  function takeOptions(data) {
    var rec = data && data[OPTIONS_KEY];
    if (rec && typeof rec === 'object' && rec.values && typeof rec.values === 'object' && (Number(rec.at) || 0) > optionsAt) {
      var next = {};
      Object.keys(rec.values).forEach(function (k) { var d = optionDef(k); var v = d ? cleanOption(d, rec.values[k]) : undefined; if (v !== undefined && v !== d.default) next[k] = v; });
      optionValues = next;
      saveOptions(Number(rec.at));
      applyOptions();
      refreshOptionsUi();
    }
    publishOptionSchema(data);
  }
  /** The list itself goes to the store once per build, so `aiondx config` can describe every option without this page. */
  function publishOptionSchema(data) {
    var have = data && data[OPTIONS_SCHEMA_KEY];
    if (optionsSchemaSent === BUILD || (have && have.build === BUILD)) { optionsSchemaSent = BUILD; return; }
    optionsSchemaSent = BUILD;
    var rec = {};
    rec[OPTIONS_SCHEMA_KEY] = { build: BUILD, options: OPTIONS.map(function (d) {
      var o = { id: d.id, group: d.group, type: d.type, label: d.label, desc: d.desc };
      if (d.type !== 'command') o.default = d.default;
      if (d.choices) o.choices = d.choices.map(function (c) { return c[0]; });
      if (d.type === 'number') { o.min = d.min; o.max = d.max; o.unit = d.unit; }
      if (d.via) o.via = d.via;
      return o;
    }) };
    putPrefs(rec);
  }
  function applyOptions() {
    try { applySpellcheck(true); } catch (e) {}
  }
  function stopShowMs() { return STOP_OVERRIDE ? STOP_OVERRIDE.show : opt('stop.show') * 1000; }
  function stopForceMs() { return STOP_OVERRIDE ? STOP_OVERRIDE.force : opt('stop.force') * 1000; }

  /** Spelling: Chromium underlines misspelled words in a text box when the box's spellcheck attribute allows it. Electron's checker does the work. */
  var spellApplied = null;
  function applySpellcheck(force) {
    var on = opt('spellcheck') !== false;
    if (!force && spellApplied === on && !every('spellcheck', 3000)) return;
    spellApplied = on;
    var boxes = document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]');
    for (var i = 0; i < boxes.length; i++) {
      var want = on ? 'true' : 'false';
      if (boxes[i].getAttribute('spellcheck') !== want) boxes[i].setAttribute('spellcheck', want);
    }
  }

  // The options on Settings > Appearance, drawn from the list.
  var optionsEl = null;
  function buildOptionsUi() {
    var el = document.createElement('div');
    el.className = 'aiondx-opts';
    el.setAttribute('data-testid', 'aiondx-options');
    var html = '<div class="aiondx-accent-title">AionDX options</div>' +
      '<div class="aiondx-accent-desc">Every choice below can also be read and changed by an agent: <code>aiondx config list</code>.</div>';
    var group = '';
    OPTIONS.forEach(function (d) {
      if (d.type === 'command') return;
      if (d.group !== group) { group = d.group; html += '<div class="aiondx-opt-group">' + group + '</div>'; }
      html += '<div class="aiondx-opt-row" data-opt="' + d.id + '"><label class="aiondx-opt-label" title="' + d.desc.replace(/"/g, '&quot;') + '">' + d.label + '</label><span class="aiondx-opt-input"></span><button type="button" class="aiondx-bg-reset aiondx-opt-reset" aria-label="Reset ' + d.label + '">Reset</button></div>';
    });
    el.innerHTML = html;
    Array.prototype.forEach.call(el.querySelectorAll('.aiondx-opt-row'), function (row) {
      var d = optionDef(row.getAttribute('data-opt'));
      var host = row.querySelector('.aiondx-opt-input');
      var input;
      if (d.type === 'bool') { input = document.createElement('input'); input.type = 'checkbox'; }
      else if (d.type === 'choice') {
        input = document.createElement('select');
        d.choices.forEach(function (c) { var o = document.createElement('option'); o.value = c[0]; o.textContent = c[1]; input.appendChild(o); });
      } else { input = document.createElement('input'); input.type = 'number'; input.min = d.min; input.max = d.max; input.className = 'aiondx-opt-number'; }
      input.setAttribute('data-testid', 'aiondx-opt-' + d.id);
      input.addEventListener('change', function () { setOption(d.id, d.type === 'bool' ? input.checked : input.value); });
      host.appendChild(input);
      if (d.unit) { var u = document.createElement('span'); u.className = 'aiondx-opt-unit'; u.textContent = d.unit; host.appendChild(u); }
      row.querySelector('.aiondx-opt-reset').addEventListener('click', function (ev) { ev.preventDefault(); setOption(d.id, undefined); });
    });
    return el;
  }
  function refreshOptionsUi() {
    if (!optionsEl) return;
    Array.prototype.forEach.call(optionsEl.querySelectorAll('.aiondx-opt-row'), function (row) {
      var d = optionDef(row.getAttribute('data-opt'));
      var input = row.querySelector('[data-testid^="aiondx-opt-"]');
      var v = opt(d.id);
      if (d.type === 'bool') { if (input.checked !== v) input.checked = v; }
      else if (document.activeElement !== input && String(input.value) !== String(v)) input.value = String(v);
      var reset = row.querySelector('.aiondx-opt-reset');
      reset.style.visibility = Object.prototype.hasOwnProperty.call(optionValues, d.id) ? 'visible' : 'hidden';
    });
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

  /** Write this Loop's settings to the store, so the agent's tool sees what the owner set. */
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
      lastAt: s.lastAt || 0, warmUntil: coldAtOf(s), newestUntil: warmAtOf(s), cacheMeasured: !!s.cacheMeasured, holdMin: holdMinutes(s),
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

  // Notices at the top of the window. a request of 2026-09-25. Each notice about a Loop names its team and member, or
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

  // a request of 2026-09-24.
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

  // a request of 2026-09-25. The
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
  // Background colours (a request of 2026-09-26). The colour you pick is the app's backdrop (--bg-base); the
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
      (window.aiondxSignin ? '<div class="aiondx-accent-title aiondx-signin-title">Sign-in</div>' +
        '<div class="aiondx-accent-desc">Sign Claude Code in once, in your browser: model calls, Claude Docs, your claude.ai skills and connectors all come with it, and it renews itself.</div>' +
        '<button type="button" class="arco-btn arco-btn-secondary arco-btn-size-small aiondx-signin-open" data-testid="aiondx-signin-open">Sign in to your agents</button>' : '') +
      (portableBridge() ? '<div class="aiondx-accent-title aiondx-drive-title">Chats on a drive</div>' +
        '<div class="aiondx-accent-desc">Keep your chats, teams and their history on a drive that goes with you. AionDX on any PC opens them while the drive is plugged in.</div>' +
        '<div class="aiondx-accent-desc aiondx-drive-state" data-testid="aiondx-drive-state">Checking...</div>' +
        '<button type="button" class="arco-btn arco-btn-secondary arco-btn-size-small aiondx-drive-move" data-testid="aiondx-drive-move">Move my chats to a drive...</button>' : '') +
      (cacheBridge() ? '<div class="aiondx-accent-title aiondx-cache-title">Agent caches</div>' +
        '<div class="aiondx-accent-desc">See what Claude Code, Devin and AionDX keep on this PC, and clear the caches, or the history older than a week, a month or more.</div>' +
        '<button type="button" class="arco-btn arco-btn-secondary arco-btn-size-small aiondx-cache-open" data-testid="aiondx-cache-open">Clear agent caches</button>' : '') +
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
    var cacheOpen = el.querySelector('.aiondx-cache-open');
    if (cacheOpen) cacheOpen.addEventListener('click', function (ev) { ev.preventDefault(); openCaches(); });
    var signinOpen = el.querySelector('.aiondx-signin-open');
    if (signinOpen) signinOpen.addEventListener('click', function (ev) { ev.preventDefault(); welcome.opened = true; showWelcome('accounts'); });
    var driveMove = el.querySelector('.aiondx-drive-move');
    if (driveMove) {
      driveMove.addEventListener('click', function (ev) { ev.preventDefault(); moveToDrive(); });
      paintDriveState(el);
    }
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
    optionsEl = buildOptionsUi();
    el.appendChild(optionsEl);
    refreshOptionsUi();
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

  // a request of 2026-10-01. AionUi's ring
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
        Array.prototype.forEach.call(box.querySelectorAll('.aiondx-ctx-row'), function (r) { r.__dirty = 0; });
        var zones = Array.prototype.map.call(box.querySelectorAll('.aiondx-ctx-row'), function (r) {
          return { from: Number(r.querySelector('.aiondx-ctx-from').value) || 0, color: r.querySelector('.aiondx-ctx-color').value };
        });
        changeThemePrefs({ ctx: { zones: zones } });
      };
      var later = function () { row.__dirty = Date.now(); if (timer) clearTimeout(timer); timer = setTimeout(commit, 250); };
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
      if (row.__dirty && Date.now() - row.__dirty < 2000) return;   // an edit waiting for its commit is not written over
      if (document.activeElement !== col && col.value !== zones[i].color) col.value = zones[i].color;
      if (document.activeElement !== from && from.value !== String(zones[i].from)) from.value = String(zones[i].from);
    });
    var reset = pickerEl.querySelector('.aiondx-ctx-reset');
    if (reset) reset.disabled = !saved;
  }

  // ---------------------------------------------------------------- chat colours (build 2026-09-26.3)

  // a request of 2026-09-26, and "color changes
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
      // A link or a picture gets the main process's menu (Open link in browser, Copy link, Copy image). The colour menu used to take every
      // right-click inside a reply and stop it there, so a link in a reply showed only the colours (2026-10-22).
      if (n.tagName === 'A' && /^(?:https?|mailto):/i.test(n.href || '')) return;
      if (n.tagName === 'IMG') return;
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

  // a request of 2026-09-26; agents change servers freely and the owner sees each change. Research:
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
    var warmTo = coldAtOf(s);
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
    // The agent's last message, and its cache window: measured by the launcher when it can be (cacheWindow), else the last message
    // plus CACHE_TTL_MS. Kept for the button's warmth ring and the tool's loop_status.
    var lastAt = lastAny ? (lastAny.created_at || 0) : 0;
    var cw = cacheWindow(convId, lastAt);
    if (lastAt !== (s.lastAt || 0) || cw.coldAt !== (s.coldAt || 0) || cw.warmAt !== (s.warmAt || 0) || cw.ttl !== (s.cacheTtl || 0) || cw.measured !== !!s.cacheMeasured) {
      s.lastAt = lastAt; s.coldAt = cw.coldAt; s.warmAt = cw.warmAt; s.cacheTtl = cw.ttl; s.cacheMeasured = cw.measured; save(t, s);
    }
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
    // Opening AionDX never starts an agent (2026-10-31): no nudge in the first minute, and a resume time that passed while
    // AionDX was closed is dropped, not sent late.
    if (Date.now() - PAGE_LOADED_AT < 60000) { why(t, s, 'Waiting: AionDX has only just opened.'); return; }
    if (s.wakeAt && s.wakeAt < PAGE_LOADED_AT - 120000) {
      var missedWake = s.wakeAt;
      s.wakeAt = 0; s.wakeMsg = ''; s.wakeBy = ''; s.wakeSelf = false;
      save(t, s);
      why(t, s, 'The resume time (' + hhmm(missedWake) + ') passed while AionDX was closed, so nothing was sent.');
      return;
    }
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
    // a request of 2026-10-01.
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
        // After a move from an hour to 5 minutes, an older hour part can outlive the newest part: the Loop rests only once all of it is gone,
        // and keeps the chat warm against the newest part (a nudge after that part ran out still saves the hour part).
        var coldAt = cw.coldAt;
        var restFrom = coldAt - warmMargin(cw.restTtl);
        var warmBy = cw.warmAt - warmLead(cw.ttl);
        var wakeAsked = s.onAt && s.onAt >= restFrom && !((s.lastFired || 0) > s.onAt);
        // Until the user stops it: never rests, so a cold agent is woken too.
        if (lastAt && now > restFrom && !wakeAsked && !s.forever) { rest(t, s, 'cold', coldAt); return; }
        // A resume time far off: one reload then costs less than keeping the cache warm until it.
        if (holding && wake - now > resumeWarmMax(cw.ttl)) { rest(t, s, 'resume', coldAt); return; }
        // Nothing to do for the whole hold: stop keeping the cache warm. A near resume time keeps it warm
        // to the end instead.
        if (!holding && !s.forever && s.nudgeLevel && s.shortSince && now - s.shortSince >= holdMinutes(s) * 60000) { rest(t, s, 'hold', coldAt); return; }
        // Short replies: the next nudge 2, 4, 8, 15, then 30 minutes after the agent's last message, and never after the keep-warm
        // time. Holding for a resume time: one keep-warm nudge per cache window.
        s.nextNudgeAt = holding ? warmBy
                                : s.nudgeLevel ? Math.min(lastAt + NUDGE_WAITS_MS[s.nudgeLevel - 1], warmBy) : 0;
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
    // A team's agent logged the 07:00 nudge as the owner's instruction while the owner was asleep, and its
    // lead switched the Loop off over it. Resume notes already carry "[Loop]".
    var plainContinue = !wakeDue && !limitResume && !holding;
    var text = LOOP_TAG + (wakeDue ? resumeText(s, wake) : limitResume ? limitResumeText(s) : holding ? holdingText(s, wake) : s.msg) +
      (plainContinue && opt('loop.skillsLine') !== false ? SKILLS_LINE : '') + usageNote(convId);
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
    // a request of 2026-09-25: the Loop's nudge
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
   *  loop off, and since the owner talks to their agents all the time, no team loop ever got to fire
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
    if (t && t.key) userSendAt[t.key] = Date.now();   // a Stop's halt watch leaves the turn this message starts alone
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
    // The agent's Stop button (a request of 2026-09-26): that chat's or
    // member's Loop goes off, whatever its mode, so it does not start the agent again straight after.
    document.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('.sendbox-stop-button') : null;
      if (!b || b.disabled || disabled()) return;
      var t = targetOf(b);
      if (!t) return;
      // First, before AionUi's own handler cancels the turn: the draft box must not send its next message when it ends.
      holdDraftBox(b, t);
      // 2026-10-31: AionUi's own Stop for a member does nothing when no team run is active, so the conversation is cancelled and the member
      // paused here too. 2026-11-09: then watched until it is idle (deadHalt), for solo chats and members alike.
      if (t.kind === 'team') hardStop(t).catch(function () {});
      deadHalt(t, t.convId).catch(function () {});
      if (!state(t).on) return;
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


  // ---------------------------------------------------------------- clearing agent caches (2026-10-13)

  // a request of 2026-10-13: clear the caches of one agent profile (Claude Code's accounts and Devin first), or only what is older than
  // a week, a month and so on. Settings > Appearance > Clear agent caches opens this panel. The work is the main process's aiondx:cache
  // (aiondx-cache.js, patch 0009): two groups per profile, caches (rebuild themselves) and history (transcripts, logs, local edit history,
  // cleared by age only). Each profile is scanned with the chosen age before anything is removed, and a Remove needs a second click.
  var cachePanel = { el: null, days: 7, profiles: null, token: 0 };
  var CACHE_AGES = [[0, 'Everything (caches only)'], [1, '1 day'], [7, '1 week'], [30, '1 month'], [90, '3 months'], [180, '6 months']];
  /** The cache profile that goes with an agent's name on Settings > Agents: Claude Code (Second) is claude:second, plain Claude Code is claude:main. */
  function cacheProfileHint(name) {
    name = String(name || '');
    if (/devin/i.test(name)) return 'devin';
    if (!/claude/i.test(name)) return '';
    var m = /\(([^()]+)\)\s*$/.exec(name);
    var slug = (m ? m[1] : 'main').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return 'claude:' + (slug || 'main');
  }
  /** Settings > Agents: a Clear cache button on the entry of each Claude Code account and of Devin, opening the panel at that profile. */
  function renderAgentCacheButtons() {
    if (!cacheBridge()) return;
    var rows = document.querySelectorAll('div[data-testid^="agent-row-"]');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var tid = row.getAttribute('data-testid') || '';
      if (/^agent-row-(status|test|edit|delete|remove|toggle|switch)-/.test(tid) || row.querySelector('.aiondx-agent-cache')) continue;
      var nameEl = row.querySelector('.truncate');
      var hint = nameEl ? cacheProfileHint(nameEl.textContent) : '';
      var acts = row.lastElementChild;
      if (!hint || !acts || acts === row.firstElementChild) continue;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'arco-btn arco-btn-secondary arco-btn-size-small aiondx-agent-cache';
      b.setAttribute('data-testid', 'aiondx-agent-cache-' + tid.slice('agent-row-'.length));
      b.setAttribute('data-profile', hint);
      b.textContent = 'Clear cache';
      b.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); openCaches(ev.currentTarget.getAttribute('data-profile')); });
      acts.insertBefore(b, acts.firstChild);
    }
  }
  function cacheBridge() { return window.aiondxCache && typeof window.aiondxCache.scan === 'function' ? window.aiondxCache : null; }
  // ---------------------------------------------------------------- AionDX on a drive (R-102, 2026-11-12)
  // A request of 2026-11-12: take the chats and their history between PCs on a drive. The main process (patch 0009,
  // aiondx:portable) picks the folder and starts the mover, which closes AionDX, moves its whole data folder there with every stored path
  // rewritten (aiondx-data-move.js --portable) and opens it again; patch 0015 opens a plugged-in AionDX drive at start, on any PC. The Claude
  // launcher keeps each chat's Claude history on the drive too. Here: the card in Settings, and the notices at start.
  function portableBridge() { return window.aiondxPortable && typeof window.aiondxPortable.status === 'function' ? window.aiondxPortable : null; }
  function paintDriveState(card) {
    var b = portableBridge(), st = card && card.querySelector('.aiondx-drive-state');
    if (!b || !st) return;
    b.status().then(function (r) {
      if (!r || !r.ok) { st.textContent = 'Could not read where the chats are.'; return; }
      st.textContent = r.portable ? 'Your chats are on the drive, in ' + r.userData + '.' : 'Your chats are on this PC, in ' + r.userData + '.';
      var btn = card.querySelector('.aiondx-drive-move');
      if (btn) btn.textContent = r.portable ? 'Move them to another folder...' : 'Move my chats to a drive...';
    }, function () { st.textContent = 'Could not read where the chats are.'; });
  }
  async function moveToDrive() {
    var b = portableBridge();
    if (!b) return;
    var c = await b.choose();
    if (!c || !c.ok) { if (c && c.error) toast('Not moved: ' + c.error, ''); return; }
    var ok = window.confirm('Move your chats to ' + c.to + '?\n\nAionDX closes, copies all of its data there (chats, teams, their working folders and Claude history), ' +
      'checks every chat, and opens again by itself. A large set of chats takes a few minutes. Your current folder is kept, renamed, until you delete it.\n\n' +
      'Close any work in progress first: running agents are stopped when AionDX closes.');
    if (!ok) return;
    var r = await b.move(c.to);
    if (!r || !r.ok) toast('Not moved: ' + ((r && r.error) || 'no answer') + '.', '');
    else toast('AionDX is closing to move your chats to ' + c.to + '. It opens again when the move is done.', '');
  }
  var DRIVE_SEEN = 'aiondx.dx.driveSeen';
  function driveNotices() {
    var b = portableBridge();
    if (!b) return;
    b.status().then(function (r) {
      if (!r || !r.ok) return;
      var st = r.start || {};
      var seen = '';
      try { seen = localStorage.getItem(DRIVE_SEEN) || ''; } catch (e) {}
      var last = r.last;
      if (last && last.at && String(last.at) !== seen && (last.state === 'done' || last.state === 'failed')) {
        try { localStorage.setItem(DRIVE_SEEN, String(last.at)); } catch (e) {}
        if (last.state === 'done') toast('Your chats are now in ' + last.to + '.', 'Your old folder is kept, renamed with ".moved-", next to where it was; delete it once everything works from the drive.');
        else toast('Your chats were not moved: ' + (last.error || 'the move failed and was undone') + '.', (last.log || []).slice(-2).join(' '));
      }
      if (st.state === 'using') return;
      // Not using a drive: look for one in the background (each drive is given a second and a half), and ask before taking it up.
      if (typeof b.scan !== 'function') { if (st.state === 'missing') toast('Your AionDX drive is not plugged in, so these are this PC\'s own chats.', 'Plug in the drive holding ' + st.path + ' and restart AionDX to open yours.'); return; }
      b.scan().then(function (sc) {
        var f = sc && sc.ok && sc.found && sc.found[0];
        if (!f) {
          if (st.state === 'missing') toast('Your AionDX drive is not plugged in, so these are this PC\'s own chats.', 'Plug in the drive holding ' + st.path + ' and restart AionDX to open yours.');
          return;
        }
        if (f.have !== f.want) {
          var go = window.confirm('An AionDX drive is plugged in as ' + f.have + ':, but its chats were made on ' + f.want + ':.\n\n' +
            'Give it the letter ' + f.want + ': on this PC too? Windows asks for permission once, then AionDX restarts and opens the chats on it. ' +
            'The letter stays with the drive on this PC.');
          if (go) b.letter(f.have, f.want).then(function (x) { if (!x || !x.ok) toast('The drive letter was not changed: ' + ((x && x.error) || 'no answer'), ''); });
          return;
        }
        var ok = window.confirm('An AionDX drive is plugged in: ' + f.dir + '.\n\nOpen the chats on it? AionDX restarts and uses the drive while it is plugged in; ' +
          'unplugged, this PC\'s own chats open, as now.');
        if (ok) b.adopt(f.dir, f.id).then(function (x) { if (!x || !x.ok) toast('Not opened: ' + ((x && x.error) || 'no answer'), ''); });
      }, function () {});
    }, function () {});
  }
  function sizeText(n) {
    n = Number(n) || 0;
    if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB';
    if (n >= 1048576) return Math.round(n / 1048576) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }
  function filesText(n) { n = Number(n) || 0; return n.toLocaleString('en-US') + (n === 1 ? ' file' : ' files'); }
  function cacheStatus(text, bad) {
    var el = cachePanel.el && cachePanel.el.querySelector('.aiondx-cache-status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('aiondx-plugins-status--bad', !!bad);
  }
  function openCaches(focusId) {
    if (!cachePanel.el) {
      cachePanel.el = document.createElement('div');
      cachePanel.el.className = 'aiondx-welcome-backdrop aiondx-cache-backdrop';
      cachePanel.el.setAttribute('data-testid', 'aiondx-cache');
      cachePanel.el.innerHTML =
        '<div class="aiondx-welcome aiondx-cache" role="dialog" aria-modal="true" aria-labelledby="aiondx-cache-title">' +
          '<button type="button" class="aiondx-plugins-close" aria-label="Close">×</button>' +
          '<h2 id="aiondx-cache-title" class="aiondx-welcome-title">Clear agent caches</h2>' +
          '<p class="aiondx-welcome-text">Caches rebuild themselves. History is what the agents kept from your work: Claude Code’s session transcripts, ' +
            'file history and to-do lists, Devin’s logs and local edit history, and AionDX’s logs. History is cleared by age only, and a Claude chat whose ' +
            'transcript is removed cannot be resumed. Sign-ins, settings, memory, skills and databases are never touched, and neither is a file used in the last ten minutes.</p>' +
          '<label class="aiondx-cache-age">Older than <select class="aiondx-cache-days" aria-label="Older than"></select></label>' +
          '<div class="aiondx-welcome-status aiondx-cache-status" aria-live="polite"></div>' +
          '<div class="aiondx-cache-list"></div>' +
        '</div>';
      var box = cachePanel.el.firstChild;
      var sel = box.querySelector('.aiondx-cache-days');
      CACHE_AGES.forEach(function (a) {
        var o = document.createElement('option');
        o.value = String(a[0]);
        o.textContent = a[1];
        if (a[0] === cachePanel.days) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', function () { cachePanel.days = Number(sel.value); paintCaches(); });
      cachePanel.el.addEventListener('keydown', function (ev) { ev.stopPropagation(); if (ev.key === 'Escape') closeCaches(); });
      cachePanel.el.addEventListener('mousedown', function (ev) { if (ev.target === cachePanel.el) closeCaches(); });
      box.querySelector('.aiondx-plugins-close').addEventListener('click', closeCaches);
      document.body.appendChild(cachePanel.el);
    }
    cachePanel.el.hidden = false;
    cachePanel.profiles = null;
    cachePanel.focus = focusId || '';
    paintCaches();
  }
  function closeCaches() { if (cachePanel.el) cachePanel.el.hidden = true; cachePanel.token++; }
  async function paintCaches() {
    var bridge = cacheBridge();
    var list = cachePanel.el && cachePanel.el.querySelector('.aiondx-cache-list');
    if (!list) return;
    if (!bridge) { cacheStatus('This works in the AionDX app, not in the browser (WebUI).', true); return; }
    var token = ++cachePanel.token;
    var stale = function () { return token !== cachePanel.token || cachePanel.el.hidden; };
    if (!cachePanel.profiles) {
      cacheStatus('Looking for agent profiles...');
      var p = await bridge.profiles();
      if (stale()) return;
      if (!p || !p.ok) { cacheStatus((p && p.error) || 'The cache tool did not answer.', true); return; }
      cachePanel.profiles = p.profiles;
    }
    list.textContent = '';
    var rows = cachePanel.profiles.map(function (pr) {
      var row = document.createElement('div');
      row.className = 'aiondx-cache-row';
      row.setAttribute('data-profile', pr.id);
      row.innerHTML = '<div class="aiondx-cache-name"></div><div class="aiondx-cache-dir"></div><div class="aiondx-cache-body">Reading...</div>';
      row.querySelector('.aiondx-cache-name').textContent = pr.label;
      row.querySelector('.aiondx-cache-dir').textContent = pr.dir;
      list.appendChild(row);
      return row;
    });
    cacheStatus(cachePanel.profiles.length ? 'Reading each profile...' : 'No agent profiles were found on this PC.');
    // The profile the panel was opened for (the Clear cache button on an agent's entry) is read first, shown first and outlined.
    var order = [];
    for (var o = 0; o < rows.length; o++) order.push(o);
    for (var f = 0; f < rows.length && cachePanel.focus; f++) {
      if (cachePanel.profiles[f].id !== cachePanel.focus) continue;
      order.splice(order.indexOf(f), 1);
      order.unshift(f);
      rows[f].classList.add('aiondx-cache-row--focus');
      list.insertBefore(rows[f], list.firstChild);
    }
    for (var oi = 0; oi < order.length; oi++) {
      if (stale()) return;
      await scanCacheRow(rows[order[oi]], cachePanel.profiles[order[oi]], bridge, stale);
    }
    if (!stale()) cacheStatus(cachePanel.profiles.length ? 'Choose what to clear. Nothing is removed until you confirm.' : '');
  }
  async function scanCacheRow(row, pr, bridge, stale) {
    var body = row.querySelector('.aiondx-cache-body');
    var r = await bridge.scan(pr.id, cachePanel.days);
    if (stale && stale()) return;
    body.textContent = '';
    if (!r || !r.ok) { body.textContent = (r && r.error) || 'Could not read this profile.'; return; }
    [['cache', 'Caches'], ['history', 'History']].forEach(function (g) {
      var x = r.groups[g[0]] || {};
      var line = document.createElement('div');
      line.className = 'aiondx-cache-line';
      line.setAttribute('data-group', g[0]);
      line.innerHTML = '<span class="aiondx-cache-line-label"></span><span class="aiondx-cache-line-info"></span><span class="aiondx-cache-line-act"></span>';
      line.querySelector('.aiondx-cache-line-label').textContent = g[1];
      var info = line.querySelector('.aiondx-cache-line-info');
      var act = line.querySelector('.aiondx-cache-line-act');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'arco-btn arco-btn-secondary arco-btn-size-small aiondx-cache-clear';
      btn.textContent = 'Clear ' + g[1].toLowerCase();
      if (x.error) { info.textContent = x.error; btn.disabled = true; }
      else if (!x.count) { info.textContent = 'Nothing to clear' + (cachePanel.days ? ' at this age.' : '.'); btn.disabled = true; }
      else {
        info.textContent = sizeText(x.bytes) + ' in ' + filesText(x.count) + (x.partial ? ' (read partly: it took too long)' : '');
        info.title = (x.targets || []).map(function (t) { return t.label + ': ' + sizeText(t.bytes) + ' in ' + filesText(t.files); }).join('\n');
        btn.addEventListener('click', function () { confirmCacheClear(row, pr, g, x, line, act, btn, bridge); });
      }
      act.appendChild(btn);
      body.appendChild(line);
    });
  }
  function confirmCacheClear(row, pr, g, x, line, act, btn, bridge) {
    var info = line.querySelector('.aiondx-cache-line-info');
    var days = cachePanel.days;

    info.textContent = 'Remove ' + filesText(x.count) + ' (' + sizeText(x.bytes) + ') from ' + pr.label + (days ? ', older than ' + CACHE_AGES.filter(function (a) { return a[0] === days; })[0][1] : '') + '?' +
      (g[0] === 'history' ? ' Claude chats whose transcript goes cannot be resumed.' : '');
    info.classList.add('aiondx-cache-confirm');
    act.textContent = '';
    var yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'arco-btn arco-btn-primary arco-btn-status-danger arco-btn-size-small aiondx-cache-yes';
    yes.textContent = 'Remove';
    var no = document.createElement('button');
    no.type = 'button';
    no.className = 'arco-btn arco-btn-secondary arco-btn-size-small aiondx-cache-no';
    no.textContent = 'Cancel';
    act.appendChild(yes);
    act.appendChild(no);
    no.addEventListener('click', function () { info.classList.remove('aiondx-cache-confirm'); scanCacheRow(row, pr, bridge); });
    yes.addEventListener('click', async function () {
      yes.disabled = true; no.disabled = true;
      info.textContent = 'Removing...';
      var r = await bridge.clear(pr.id, g[0], days);
      var msg = r && r.ok ? 'Removed ' + filesText(r.deleted) + ' (' + sizeText(r.bytes) + ').' + (r.skipped ? ' ' + filesText(r.skipped) + ' left: in use, or newer than ten minutes.' : '')
        : ((r && r.error) || 'The clear did not finish.');
      cacheStatus(pr.label + ': ' + msg, !(r && r.ok));
      await scanCacheRow(row, pr, bridge);
    });
  }

  // ---------------------------------------------------------------- Stop must stop (2026-10-01)

  // a request of 2026-10-13: a chat could not be stopped. AionCore's log showed the first Stop landing (the turn ended within half a
  // second), a new turn starting seventeen seconds later, and the second press of Stop never reaching the server at all. AionUi's
  // button had no usable turn for the new turn, so nothing was sent. After a press of Stop in a solo chat AionDX now reads the
  // chat's turn from the server, waits 2.5 seconds, and when that same turn is still running and no cancel is under way it sends the
  // cancel itself, with the turn id the server gave. A different turn (a message sent after the press) is left alone.
  // Since 2026-11-09 deadHalt below does this and more (the cancel again at 1.2 s, then the agent ended); the old backstop was removed
  // on 2026-11-10, when a scan showed nothing called it any more.

  // ---- Stop halts, every time (a request of 2026-11-09: "THE STOP BUTTON NEEDS TO DEAD-HALT THINGS, EVERY TIME")
  // After any press of Stop (AionUi's, AionDX's, or the chat menu's), the chat is watched until it is idle: the cancel goes again with the
  // turn the server names (a turn that started from a queue, a Loop nudge or a scheduled send in the meantime is cancelled too), a team
  // member is paused again, and a chat still working stop.force seconds after the press has its agent process ended and started again
  // (runtime/restart: whatever it was running ends; the chat keeps its history and session). A message you send after the press is
  // yours: the watch lets that turn run. One watch per chat; a second press starts the escalation over from the end step.
  var haltWatch = {};          // target key -> { at, token }
  var userSendAt = {};         // target key -> when you last sent something from this page
  function haltNote(text, sub) { toast(text, sub || ''); }
  async function deadHalt(t, convId) {
    if (!t) return;
    if (!convId && t.kind === 'team') { var m = await memberConversation(t); convId = m && m.convId; }
    if (!convId) return;
    var key = t.key, start = Date.now(), token = (haltWatch[key] && haltWatch[key].token || 0) + 1;
    var again = !!haltWatch[key];
    haltWatch[key] = { at: start, token: token };
    var live = function () { return haltWatch[key] && haltWatch[key].token === token; };
    var resent = again, restarted = false;
    var cancelNow = async function (turn) {
      var r = turn ? await postJson('/api/conversations/' + convId + '/cancel', { turn_id: turn }).catch(function () { return null; }) : null;
      if (t.kind === 'team') postJson('/api/teams/' + t.teamId + '/runs/stop/agents/' + encodeURIComponent(t.slotId) + '/pause', { reason: 'Stopped by the user.' }).catch(function () {});
      return r;
    };
    try {
      for (var i = 0; i < 40 && live(); i++) {
        await new Promise(function (res) { setTimeout(res, i === 0 ? 400 : 600); });
        if (!live()) return;
        if ((userSendAt[key] || 0) > start) return;          // you sent something after Stop: that turn is yours
        var g = await getJson('/api/conversations/' + convId);
        if (!g.data) continue;
        var busy = convBusy(g.data), rt = g.data.runtime || {};
        if (!busy) {
          if (restarted) haltNote('Stopped.', 'The agent did not stop on its own, so it was ended and started again. The chat keeps its history.');
          return;
        }
        var waited = Date.now() - start;
        // a cancel already under way is not sent again (the end step below still comes if it never ends)
        if (!resent && waited >= 1200) { resent = true; if (rt.state !== 'cancelling') await cancelNow(rt.turn_id); continue; }
        if (!restarted && (waited >= stopForceMs() || again)) {
          restarted = true;
          var rr = await postJson(t.kind === 'conv' ? '/api/conversations/' + convId + '/runtime/restart'
            : '/api/teams/' + t.teamId + '/agents/' + encodeURIComponent(t.slotId) + '/runtime/restart', {}).catch(function () { return null; });
          if (!rr || !rr.ok) haltNote('Stop: the agent could not be ended.', 'HTTP ' + (rr ? rr.status : 'no answer') + '. Stop is sent again until it stops.');
          continue;
        }
        if (restarted && i % 3 === 0 && rt.state !== 'cancelling') await cancelNow(rt.turn_id);
      }
      if (live()) haltNote('Stop: the chat still reports working.', 'Cancels and a restart were sent. If it keeps going, close and reopen AionDX.');
    } finally { if (live()) delete haltWatch[key]; }
  }

  // a request of 2026-10-01. AionUi's draft box (the queue of messages added with the draft button) has two modes: Manual, which sends
  // nothing by itself, and Auto, which sends the next message as soon as a turn ends, and a turn the Stop button cancelled ends like
  // any other (useConversationCommandQueue.ts: the queue drains on turn completion, and handleStop does not pause it). So Stop in
  // Auto mode stops the agent for the length of one cancel and then starts it on the next queued message. Pressing Stop now also
  // puts that chat's draft box on Manual, before the cancel goes out; the messages stay in the box, and the mode toggle on the box
  // puts it back on Auto. For a team member's Stop AionUi already pauses the member (the pause route), so only the box is held.
  /** The draft box (CommandQueuePanel) that belongs to a message box: found by walking up from the box's panel. */
  function draftBoxOf(node) {
    var el = node && node.closest ? (node.closest('.sendbox-panel') || node) : node;
    for (var i = 0; el && i < 8; i++, el = el.parentElement) {
      var list = el.querySelector && el.querySelector('[data-command-queue-list]');
      if (list) return list;
      if (el.hasAttribute && el.hasAttribute('data-slot-id')) break;   // a team column ends the search: another column's box is not ours
    }
    return null;
  }
  function holdDraftBox(stopButton, t) {
    var list = draftBoxOf(stopButton);
    if (!list) return false;
    var panel = list.closest('[aria-label]') || list.parentElement;
    var buttons = panel ? panel.querySelectorAll('button') : [];
    for (var i = 0; i < buttons.length; i++) {
      var txt = String(buttons[i].textContent || '');
      var aria = String(buttons[i].getAttribute('aria-label') || '');
      if (/auto/i.test(txt) && (/send/i.test(txt) || /mode/i.test(aria))) {
        buttons[i].click();
        notify(t, 'The draft box for {who} is on Manual send now, so it does not start the agent again after Stop. Its messages are still in it.', '');
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- Claude Code plugins, /plugin (build 2026-09-26.6)

  // A tester, through a request of 2026-09-26, then "it seems we should
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

  // a request of 2026-09-25. Then,
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
    var added = accountsRec && Array.isArray(accountsRec.accounts) ? accountsRec.accounts.filter(function (x) { return x && x.id === agentId && x.added; })[0] : null;
    if (!any && added) return 'Claude Code (' + added.label + ')';
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
    // R-119: the accounts added from "+ Add account" or Settings' sign-in; the launcher runs a chat moved to one on that account
    (typeof addedAccounts === 'function' ? addedAccounts() : []).forEach(function (a) {
      if (seen[a.id]) return;
      seen[a.id] = true;
      out.push({ agentId: a.id, name: 'Claude Code (' + a.label + ')' });
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
   *  control and the picker stacked (a request of 2026-09-26). */
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
      } else if (r.kind === 'team' && !col) {
        // AionUi's single view of a team (a request of 2026-10-02): the member in front has no [data-slot-id] column around its header, so its model picker was never found.
        var sv = singleViewTarget(r.id);
        if (sv) t = { kind: 'team', key: sv.key, teamId: sv.teamId, slotId: sv.slotId, role: sv.role, single: true };
      } else if (r.kind === 'conv' && !col) {
        t = { kind: 'conv', key: 'conv:' + r.id, convId: r.id };
      }
      if (t) { t.anchor = pickerSlot(sel); out.push(t); }
    }
    return out;
  }

  function renderAccounts() {
    var live = {}, liveUsage = {};
    var list = acctTargets();
    if (list.length) loadAgents(false);
    list.forEach(function (t) {
      var convId = t.kind === 'conv' ? t.convId : (teamCache[t.teamId] && teamCache[t.teamId].map[t.slotId]);
      if (!convId) { if (usageEls[t.key]) liveUsage[t.key] = true; if (t.kind === 'team') memberConversation(t).then(function (r) { if (r && r.convId) schedule(); }, function () {}); return; }
      var info = convInfo[convId];
      if (!info || Date.now() - info.at > CONV_INFO_MS) loadConvInfo(convId);
      if (!info) { if (usageEls[t.key]) liveUsage[t.key] = true; return; }   // chat info is being read: keep the meter on screen meanwhile
      // A team column offers only Claude-to-Claude switches; a solo chat always has new-chat picks. A Claude member that is
      // offered no switch (one Claude agent only, or the lists not read yet) still gets its usage bar, before the model picker.
      if (!info.agentId || !agentList.at) {
        if (info.backend === 'claude') { liveUsage[t.key] = true; placeUsage(t, t.anchor, convId); }
        return;
      }
      live[t.key] = true;
      liveUsage[t.key] = true;
      var el = acctEls[t.key] || (acctEls[t.key] = buildAcctPill(t.key));
      el._t = t;
      el._convId = convId;
      el.classList.toggle('aiondx-acct--compact', t.kind === 'team' && !t.single);
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
    Object.keys(usageEls).forEach(function (k) { if (!liveUsage[k]) dropUsage(k); });
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
    var label = t.kind === 'team' && !t.single ? '' : shortAgentName(name);
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
    acctMenu.style.maxHeight = '';
    acctMenu.style.overflowY = '';
    var w = acctMenu.offsetWidth || 300;
    var h = acctMenu.offsetHeight || 0;
    acctMenu.style.left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8) + 'px';
    // Below the control if it fits, else above; on a window too short for either (a laptop screen, a small window), on the side with
    // more room, as tall as that room, scrolling inside: its lower items used to fall off the bottom of the window where no click reaches.
    var below = window.innerHeight - 8 - (r.bottom + 6), above = r.top - 6 - 8;
    var top;
    if (h <= below) top = r.bottom + 6;
    else if (h <= above) top = r.top - 6 - h;
    else if (below >= above) { top = r.bottom + 6; acctMenu.style.maxHeight = Math.max(120, below) + 'px'; }
    else { var room = Math.max(120, above); acctMenu.style.maxHeight = room + 'px'; top = r.top - 6 - room; }
    if (acctMenu.style.maxHeight) acctMenu.style.overflowY = 'auto';
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
      // A request of 2026-10-20: any agent type in any slot, the lead's included. AionCore's replace route (patch core-0006) keeps the slot, the name and the
      // role, gives the slot a new conversation on the new agent, and stops the team's running agents; they start again on the next message.
      var cache = teamCache[t.teamId];
      var mine = cache && cache.assistants ? cache.assistants[t.slotId] : '';
      var swaps = enabledAgents().filter(function (a) { return a.id !== mine && a.status !== 'offline' && a.status !== 'missing'; });
      if (swaps.length) {
        var more2 = m.querySelector('.aiondx-acct-more');
        more2.innerHTML = '<div class="arco-dropdown-menu-group-title">Swap this ' + (isLeadRole(t.role) ? 'lead' : 'member') + ' for</div><div class="aiondx-acct-items" data-group="swap"></div>';
        var box2 = more2.querySelector('[data-group="swap"]');
        swaps.forEach(function (a) {
          var it = menuItem(a.name, 'A new conversation on this agent, in the same slot', 'data-assistant', a.id);
          it.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            confirmSwap(m, t, a);
          });
          box2.appendChild(it);
        });
        note.textContent += ' A swap puts another agent in this slot.';
      }
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

  /** The second step for swapping the agent in a team slot. */
  function confirmSwap(m, t, a) {
    m._confirming = true;
    var box = m.querySelector('.arco-dropdown-menu');
    box.innerHTML = '<div class="arco-dropdown-menu-group-title"></div><div class="aiondx-acct-confirm"><div class="aiondx-acct-warn"></div>' +
      '<div class="aiondx-acct-btns"><button type="button" class="arco-btn arco-btn-secondary arco-btn-size-small aiondx-acct-cancel">Cancel</button>' +
      '<button type="button" class="arco-btn arco-btn-primary arco-btn-size-small aiondx-acct-move">Swap it</button></div></div>';
    box.querySelector('.arco-dropdown-menu-group-title').textContent = 'Swap this ' + (isLeadRole(t.role) ? 'lead' : 'member') + ' for ' + a.name + '?';
    box.querySelector('.aiondx-acct-warn').textContent = 'The slot, its name, its mailbox and its Loop stay. It gets a new conversation on ' + a.name + ', empty: the old conversation\u2019s history stays with the old agent, out of the team. ' +
      'Every agent in this team stops now and starts again with the next message, so do it when none is working.';
    placeAcctMenu(acctEls[t.key]);
    box.querySelector('.aiondx-acct-cancel').addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); closeAcctMenu(); });
    box.querySelector('.aiondx-acct-move').addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      closeAcctMenu();
      swapAgent(t, a).catch(function (e) { console.log('[dx] swap error', e); notify(t, 'Not swapped: the request failed.', ''); });
    });
  }
  async function teamBusyNow(teamId) {
    var rs = await getJson('/api/teams/' + teamId + '/run-state');
    var ws = (rs.data && rs.data.slot_work) || [];
    for (var i = 0; i < ws.length; i++) {
      var w = ws[i];
      if (w && (w.state === 'running' || w.state === 'starting' || w.active_turn_id)) return w.slot_id || true;
    }
    return false;
  }
  async function swapAgent(t, a) {
    var busy = await teamBusyNow(t.teamId);
    if (busy) { notify(t, 'Not swapped: an agent in this team is working. Swap when none is.', ''); return; }
    var r = await postJson('/api/teams/' + t.teamId + '/agents/' + encodeURIComponent(t.slotId) + '/replace', { assistant_id: a.id });
    if (r && r.ok) {
      notify(t, 'Swapped to ' + a.name + '. The team page reloads.', '');
      setTimeout(function () { try { location.reload(); } catch (e) {} }, 900);
    } else {
      var why = '';
      try { var j = r ? await r.json() : null; why = j && (j.message || j.error || j.msg) ? ': ' + String(j.message || j.error || j.msg).slice(0, 160) : ''; } catch (e) {}
      notify(t, 'Not swapped (' + (r ? r.status : 'no answer') + ')' + why + '. This needs AionDX\u2019s own AionCore; run AionDX Apply Update.', '');
    }
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

  // a request. AionDX's Claude launcher reads the chat's account windows from Anthropic's rate-limit
  // headers (patches\0002 claude-stream-proxy.js, startUsage) into aiondx.usage.acct.<key>, and which account a
  // chat runs on into aiondx.usage.conv.<conversation id>. Two thin bars, the 5-hour window over the week,
  // with their percentages, sit just left of the agent control; a team column gets the bars alone. A reading
  // older than 30 minutes is not shown.
  var USAGE_ACCT = 'aiondx.usage.acct.';
  var USAGE_CONV = 'aiondx.usage.conv.';
  var USAGE_STALE_MS = 30 * 60000;       // older than this the meter is dimmed, and its tooltip says how old it is
  var USAGE_HIDE_MS = 3 * 24 * 3600000;  // older than this it is not shown at all (a window that has reset reads 0%, so an old reading is still honest)
  var usageAcct = {};        // key -> reading
  var usageConv = {};        // conversation id -> { acct, at }
  var usageEls = {};         // target key -> meter
  var USAGE_CFG = 'aiondx.usage.config';
  var USAGE_ALERT = 'aiondx.usagealert.';
  var USAGE_FIRED = 'aiondx.usagefired.';
  var usageCfg = { pollSec: 3, writeSec: 60, alerts: true };   // the settings panel (click the usage meter); the Loop tool and AionCore's tap read them too
  var usageAlerts = {};      // scope (team.<id> or conv.<id>) -> { rules: [{ window, at, notify, message, by, who, slot, conv }] }
  var usageFired = {};       // scope -> { rule@account -> { reset, at } }: an alert goes off once per window
  var usageTaken = 0;
  function takeUsage(data) {
    var cfg = data[USAGE_CFG];
    if (cfg && typeof cfg === 'object') {
      usageCfg = { pollSec: Math.min(300, Math.max(1, Number(cfg.pollSec) || 3)), writeSec: Math.min(600, Math.max(5, Number(cfg.writeSec) || 60)), alerts: cfg.alerts !== false };
    }
    // The meter and the alert check follow the refresh rate the owner chose (a reading can only be as new as the last one AionCore's tap wrote).
    if (usageCfg.pollSec > 3 && Date.now() - usageTaken < usageCfg.pollSec * 1000 - 400) return;
    usageTaken = Date.now();
    var a = {}, c = {}, al = {}, fi = {}, cc = {}, ca = {}, cx = {};
    Object.keys(data).forEach(function (k) {
      var v = data[k];
      if (!v || typeof v !== 'object') return;
      if (k.indexOf(CACHE_CONV) === 0) cc[k.slice(CACHE_CONV.length)] = v;
      else if (k.indexOf(CACHE_ACCT) === 0) ca[k.slice(CACHE_ACCT.length)] = v;
      else if (k.indexOf(CTX_COMPACT) === 0) cx[k.slice(CTX_COMPACT.length)] = v;
      else if (k.indexOf(USAGE_ACCT) === 0) a[k.slice(USAGE_ACCT.length)] = v;
      else if (k.indexOf(USAGE_CONV) === 0) c[k.slice(USAGE_CONV.length)] = v;
      else if (k.indexOf(USAGE_ALERT) === 0) al[k.slice(USAGE_ALERT.length)] = v;
      else if (k.indexOf(USAGE_FIRED) === 0) fi[k.slice(USAGE_FIRED.length)] = v;
    });
    usageAcct = a;
    usageConv = c;
    cacheConv = cc;
    var newCompact = Object.keys(cx).some(function (id) { return !ctxCompact[id] || ctxCompact[id].at !== cx[id].at; });
    ctxCompact = cx;
    if (newCompact) { ctxAsk = {}; try { renderSched(); } catch (e) {} }
    try { checkCacheLength(ca); } catch (e) { console.log('[dx] cache length check failed', e); }
    usageAlerts = al;
    usageFired = fi;
    try { checkUsageAlerts(); } catch (e) { console.log('[dx] usage alert check failed', e); }
  }
  // The prompt cache, measured (2026-11-11). AionDX's Claude launcher reads the first event of every answer to the chat's main
  // conversation, which says how much was read from the cache and how long what it wrote is kept (1 hour or 5 minutes), and keeps
  // aiondx.cache.conv.<chat> = { at, until, ttl, read, write, ctx, rebuilt? } (claude-stream-proxy.js, startCache). until: the latest
  // moment the cache can still exist; past it the cache is gone for certain. Anthropic can still drop one earlier, which the next call
  // shows as a rebuild.
  var CACHE_CONV = 'aiondx.cache.conv.';
  var cacheConv = {};        // conversation id -> record
  // Each account's length, as its chats' answers last showed it (2026-11-11.3): aiondx.cache.acct.<account> = { label, ttl, at, from,
  // changedAt }. A request of 2026-11-11: if Anthropic moves an account back to 5 minutes (or to an hour), say so once, the day it happens.
  // The length this window last told the user about is kept per account in the browser's storage, so several pages tell it once; the first
  // reading only sets it.
  // The size after a compaction (R-103, 2026-11-12): the launcher writes aiondx.ctx.conv.<chat> = { at, pre, post, fixed, tokens } when Claude
  // reports a finished compaction (claude-stream-proxy.js, readShare). AionCore keeps the size from before until the next reply measures the new
  // one, so the meter used to show the old size. While the chat's count still equals the size before (within 2%), the meter shows the estimate.
  var CTX_COMPACT = 'aiondx.ctx.conv.';
  var ctxCompact = {};
  function compactView(info) {
    var r = info && info.convId ? ctxCompact[info.convId] : null;
    if (!r || !(Number(r.tokens) > 0) || !(Number(r.pre) > 0) || Date.now() - Number(r.at) > 86400000) return null;
    return Math.abs(Number(info.used) - Number(r.pre)) <= Math.max(500, Number(r.pre) * 0.02) ? r : null;
  }
  var CACHE_ACCT = 'aiondx.cache.acct.';
  var CACHE_SEEN = 'aiondx.dx.cacheLen.';
  function lengthText(ttl) { return ttl === '1h' ? '1 hour' : '5 minutes'; }
  function checkCacheLength(accts) {
    Object.keys(accts).forEach(function (key) {
      var r = accts[key];
      if (!r || (r.ttl !== '1h' && r.ttl !== '5m')) return;
      var seen = null;
      try { seen = localStorage.getItem(CACHE_SEEN + key); } catch (e) { return; }
      if (seen === r.ttl) return;
      try { localStorage.setItem(CACHE_SEEN + key, r.ttl); } catch (e) { return; }
      if (!seen) return;
      var who = r.label ? 'the ' + r.label + ' account' : 'a Claude account';
      var when = Number(r.changedAt || r.at) > 0 ? ', from ' + hhmm(Number(r.changedAt || r.at)) : '';
      console.log('[dx] prompt cache length for ' + who + ': ' + lengthText(r.ttl) + ' (was ' + lengthText(seen) + ')' + when);
      toast('Anthropic now keeps the prompt cache of ' + who + "'s chats " + lengthText(r.ttl) + ' (it was ' + lengthText(seen) + ')' + when + '.',
        r.ttl === '5m'
          ? 'Measured from their answers. Anthropic gives 5 minutes when an account is on extra usage, or when they change it on their side. The Loop now keeps chats warm on the 5-minute cycle.'
          : 'Measured from their answers. The Loop now counts with the hour: fewer keep-warm nudges, and quiet chats stay warm longer.',
        { where: 'Prompt cache' });
    });
  }
  /** The chat's measured cache record, or null. */
  function cacheRecord(convId) {
    var r = convId ? cacheConv[convId] : null;
    return r && Number(r.until) > 0 && Number(r.at) > 0 ? r : null;
  }
  function ttlMsOf(r) { return r.ttl === '1h' ? 3600000 : r.ttl === '5m' ? 300000 : Math.max(60000, Number(r.until) - Number(r.at)); }
  /** When the newest part of a record runs out: its tailUntil (2026-11-11.3), never later than until; until for an older record. */
  function tailOf(r) { var u = Number(r.until), tl = Number(r.tailUntil); return tl > 0 && tl < u ? tl : u; }
  /** The window the Loop counts with: { coldAt, warmAt, ttl, restTtl, measured }. coldAt: when all of the cache is gone for certain (the Loop
   *  rests after it). warmAt: when the newest part runs out (the Loop keeps the chat warm against it). They differ after Anthropic moved a
   *  chat from an hour to 5 minutes while an older hour part still lives. ttl: the newest part's length; restTtl: the length behind coldAt.
   *  A record the chat's messages have outrun (a message more than a minute after its until: the chat ran without the launcher's reading)
   *  is not used. */
  function cacheWindow(convId, lastAt) {
    var r = cacheRecord(convId);
    if (r && !(lastAt && lastAt > Number(r.until) + 60000)) {
      var tail = tailOf(r), ttl = ttlMsOf(r);
      return { coldAt: Number(r.until), warmAt: tail, ttl: ttl, restTtl: tail < Number(r.until) ? 3600000 : ttl, measured: true };
    }
    var at = lastAt ? lastAt + CACHE_TTL_MS : 0;
    return { coldAt: at, warmAt: at, ttl: CACHE_TTL_MS, restTtl: CACHE_TTL_MS, measured: false };
  }
  /** How long before coldAt the last keep-warm nudge is planned, and how long before it the Loop rests instead (a nudge then could land
   *  after the cache is gone). An hour cache leaves room for a team's send spacing; a 5-minute one keeps the old timing. */
  function warmLead(ttl) { return ttl >= 30 * 60000 ? 6 * 60000 : 60000; }
  function warmMargin(ttl) { return ttl >= 30 * 60000 ? 2 * 60000 : 20000; }
  /** A resume time further off than this lets the cache run out: three hour-cache nudges, or 50 minutes of 5-minute ones, cost less
   *  than one reload. */
  function resumeWarmMax(ttl) { return Math.max(RESUME_WARM_MAX_MS, 3 * ttl); }
  /** The Loop's saved window: when its cache runs out, and how long it is. */
  function coldAtOf(s) { return s.coldAt || (s.lastAt ? s.lastAt + CACHE_TTL_MS : 0); }
  /** When the newest part of the Loop's saved window runs out (coldAtOf for a window with one length). */
  function warmAtOf(s) { var c = coldAtOf(s); return s.warmAt && s.warmAt < c ? s.warmAt : c; }
  function ttlOf(s) { return s.cacheTtl || CACHE_TTL_MS; }
  function usageScope(t) { return t.kind === 'team' ? 'team.' + t.teamId : 'conv.' + t.convId; }
  /** The chats a usage alert scope covers: [{ convId, slotId, teamId, role, name }], or null while the team is not read yet. */
  function alertMembers(scope) {
    var m = /^(team|conv)\.(.+)$/.exec(scope);
    if (!m) return [];
    if (m[1] === 'conv') return [{ convId: m[2], slotId: '', teamId: '', role: '', name: '' }];
    var tc = teamCache[m[2]];
    if (!tc || !tc.ok) {
      if (!teamFailed[m[2]]) memberConversation({ teamId: m[2], slotId: '' }).then(function () { schedule(); }, function () {});
      return null;
    }
    return Object.keys(tc.map).filter(function (slot) { return !!tc.map[slot]; }).map(function (slot) {
      return { convId: tc.map[slot], slotId: slot, teamId: m[2], role: tc.roles[slot] || '', name: tc.names[slot] || '' };
    });
  }
  /** Look at every alert rule against the readings now. A rule goes off once for a window; it is armed again when the window resets or
   *  the usage has dropped 5 points under the threshold. */
  function checkUsageAlerts() {
    if (disabled() || !usageCfg.alerts) return;
    Object.keys(usageAlerts).forEach(function (scope) {
      var rec = usageAlerts[scope];
      if (!rec || !Array.isArray(rec.rules) || !rec.rules.length) return;
      var members = alertMembers(scope);
      if (!members) return;
      var fired = Object.assign({}, usageFired[scope] || {}), changed = false;
      rec.rules.forEach(function (rule) {
        var thr = Number(rule.at);
        if (!(thr > 0)) return;
        var key = rule.window === 'week' ? 'seven_day' : 'five_hour';
        var done = {};
        members.forEach(function (mem) {
          var cr = usageConv[mem.convId];
          var a = cr && usageAcct[cr.acct];
          var w = a && windowNow(a[key]);
          if (!w || done[cr.acct]) return;
          done[cr.acct] = true;
          var fk = rule.window + '@' + rule.at + '@' + rule.notify + '|' + cr.acct;
          var prev = fired[fk];
          if (w.u < thr) { if (prev && w.u < thr - 0.05) { delete fired[fk]; changed = true; } return; }
          var reset = Number(a[key].reset) || 0;
          if (prev && Number(prev.reset) === reset) return;
          fired[fk] = { reset: reset, at: Date.now() };
          changed = true;
          sendUsageAlert(scope, rec, rule, cr.acct, a, w, members);
        });
      });
      if (changed) {
        usageFired[scope] = fired;
        var body = {};
        body[USAGE_FIRED + scope] = fired;
        putPrefs(body);
      }
    });
  }
  function alertText(rule, a, w) {
    var win = rule.window === 'week' ? 'weekly' : '5-hour';
    var other = windowNow(rule.window === 'week' ? a.five_hour : a.seven_day);
    return '[AionDX usage alert] ' + (a.label ? 'The Claude account ' + a.label : 'Your Claude account') + ' is at ' + pct(w.u) + ' of its ' + win + ' window' +
      ' (an alert at ' + Math.round(Number(rule.at) * 100) + '% was set' + (rule.who ? ' by ' + rule.who : rule.by === 'user' ? ' by the user' : '') + ')' +
      (w.reset ? ', resets ' + resetText(w.reset) : '') + (other ? '; ' + (rule.window === 'week' ? '5-hour' : 'week') + ' ' + pct(other.u) : '') + '. ' +
      (rule.message ? String(rule.message) : 'Finish or checkpoint what you are doing now, hand off anything that needs a long run, and tell the user if the rest of the work will not fit.');
  }
  function sendUsageAlert(scope, rec, rule, acct, a, w, members) {
    var text = alertText(rule, a, w);
    var to = [];
    if (scope.indexOf('conv.') === 0) to = members;
    else if (rule.notify === 'all') to = members.filter(function (m) { var c = usageConv[m.convId]; return c && c.acct === acct; });
    else if (rule.notify === 'self') to = members.filter(function (m) { return m.slotId === rule.slot || m.convId === rule.conv; });
    else to = members.filter(function (m) { return isLeadRole(m.role); });
    if (!to.length) { console.log('[dx] usage alert ' + scope + ': nobody to tell (' + rule.notify + ')'); return; }
    to.forEach(function (m) {
      var done = function (ok) { console.log('[dx] usage alert ' + scope + ' -> ' + (m.name || m.convId) + (ok ? ' sent' : ' failed')); };
      if (!m.teamId) { postJson('/api/conversations/' + m.convId + '/messages', { content: text }).then(function (r) { done(r.ok); }, function () { done(false); }); return; }
      var t = { kind: 'team', key: 'team:' + m.teamId + ':' + m.slotId, teamId: m.teamId, slotId: m.slotId, role: m.role };
      // Respond now: the message goes ahead of the queue and into the running turn, the same as the bolt.
      steerAgent(t, { content: text }).then(function (r) {
        if (r.status === 404 || r.status === 405) return sendAsUsual(t, text);
        return r;
      }).then(function (r) { done(r && r.ok); }, function () { done(false); });
    });
    toast('Usage alert: ' + pct(w.u) + ' of the ' + (rule.window === 'week' ? 'weekly' : '5-hour') + ' window', (a.label ? a.label + '. ' : '') + 'Sent to ' + to.map(function (m) { return m.name || 'the agent'; }).join(', ') + '.');
  }
  /** The account reading for a chat, whatever its age: the limit pause needs a reset time even from an old reading. */
  function usageRecord(convId) {
    var c = usageConv[convId] || usageGuess(convId);
    var a = c && usageAcct[c.acct];
    return a && (a.five_hour || a.seven_day) ? a : null;
  }
  // A chat whose Claude has not started since the launcher began recording has no record of which account it runs on, so its meter was
  // missing while a sibling's showed (2026-11-02: teams opened without starting their agents). Every chat of one agent runs on one
  // account, so a chat without a record borrows the account of the newest chat that has one and uses the same agent.
  var agentOf = {};      // conversation id -> its agent's id ('' when it has none), read from the conversation
  var agentAsked = {};
  var agentAskFailed = {};   // conversation id -> when its last read failed (asked again a minute later at the earliest)
  // A failed read used to clear its mark and repaint, and the repaint asked again: for a deleted chat that still had a usage record, a loop
  // at render speed (2026-11-11: 7,360 requests for four deleted chats in 24 seconds). A chat the backend no longer has (404) is never
  // asked again; any other failure waits a minute; only a read that found something repaints.
  function agentRead(convId) {
    if (agentOf[convId] !== undefined || agentAsked[convId]) return;
    if (agentAskFailed[convId] && Date.now() - agentAskFailed[convId] < 60000) return;
    agentAsked[convId] = true;
    getJson('/api/conversations/' + convId).then(function (g) {
      var e = g && g.data && g.data.extra;
      if (g && g.data) { agentOf[convId] = String((e && e.agent_id) || ''); schedule(); return; }
      delete agentAsked[convId];
      if (g && g.err === 404) agentOf[convId] = '';
      else agentAskFailed[convId] = Date.now();
    }, function () { delete agentAsked[convId]; agentAskFailed[convId] = Date.now(); });
  }
  function usageGuess(convId) {
    // the agent a chat runs on: the one picked for it in the account menu, else the one it was made with
    var agentFor = function (cid) { return agentPrefs[cid] || agentOf[cid]; };
    var aid = agentFor(convId);
    if (aid === undefined) { agentRead(convId); return null; }
    if (!aid) return null;
    var best = null;
    Object.keys(usageConv).forEach(function (cid) {
      if (agentFor(cid) === undefined) { agentRead(cid); return; }
      if (agentFor(cid) !== aid) return;
      if (!best || (Number(usageConv[cid].at) || 0) > (Number(best.at) || 0)) best = usageConv[cid];
    });
    return best;
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
  /** ", <account label> (<plan>)": the plan read from the credentials replaces a plan written into the label by hand ("personal (Pro)"). */
  function acctName(a) {
    var label = String(a.label || ''), plan = String(a.plan || '');
    if (plan) label = label.replace(/\s*\((?:Free|Pro|Max|Ultra)\)\s*$/i, '');
    return (label ? ', ' + label : '') + (plan ? (label ? ' · ' : ', ') + plan : '');
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
      el.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); if (el._t) openUsagePanel(el._t); });
      usageEls[t.key] = el;
    }
    el._t = t;
    el.classList.toggle('aiondx-usage--compact', t.kind === 'team' && !t.single);
    if (el.parentNode !== beforeEl.parentNode || el.nextSibling !== beforeEl) beforeEl.parentNode.insertBefore(el, beforeEl);
    // An account with no 5-hour window (Ultra, from 2026-10-30) has no 5-hour figure in its readings: the meter then shows the week alone.
    var has5 = !!windowNow(a.five_hour);
    var five = windowNow(a.five_hour) || { u: 0 }, week = windowNow(a.seven_day) || { u: 0 };
    if ((el.getAttribute('data-no5h') === '1') === has5) { if (has5) el.removeAttribute('data-no5h'); else el.setAttribute('data-no5h', '1'); }
    var stale = Date.now() - (Number(a.at) || 0) > USAGE_STALE_MS;
    if ((el.getAttribute('data-stale') === '1') !== stale) { if (stale) el.setAttribute('data-stale', '1'); else el.removeAttribute('data-stale'); }
    var bars = el.querySelectorAll('.aiondx-usage-bar i');
    [five, week].forEach(function (w, i) {
      var u = Math.min(1, Math.max(0, Number(w.u) || 0));
      bars[i].style.width = (u * 100).toFixed(1) + '%';
      bars[i].style.backgroundColor = usageColour(u);
    });
    var text = (has5 ? '5h ' + pct(five.u) + ' \u00b7 ' : '') + 'wk ' + pct(week.u);
    var tx = el.querySelector('.aiondx-usage-text');
    if (tx.textContent !== text) tx.textContent = text;
    var tip = 'Claude usage' + acctName(a) + ': ' + [windowText('5-hour window', a.five_hour), windowText('week', a.seven_day)].filter(Boolean).join('; ') + (has5 ? '' : ' (this plan has no 5-hour limit)') +
      '. Read at ' + new Date(Number(a.at) || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) +
      (stale ? ' (' + ageText(Date.now() - (Number(a.at) || 0)) + '; it may be higher now)' : '') + '.';
    if (el.title !== tip) { el.title = tip; el.setAttribute('aria-label', tip); }
    el.setAttribute('data-limit', five.status === 'rejected' || week.status === 'rejected' ? 'reached' : '');
    // Too narrow for the whole meter: it gives way, and hovering the account pill shows the same figures.
    if (t.kind !== 'team' || t.single) {
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
      body.textContent = 'Claude usage' + acctName(a) + ', read ' + ageText(age) + (age > USAGE_STALE_MS ? '; it may be higher now.' : '.');
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


  // ---------------------------------------------------------------- usage settings and alerts (2026-10-09)

  // a request of 2026-10-09: agents read their usage, carry on, and the next time they look they are far over. A usage alert
  // is a threshold on a window (5-hour or week) of the account a chat runs on, for one team or one chat: when a reading crosses
  // it, AionDX sends the message at once to the team lead, to every member on that account, or to the agent that set it,
  // the way the Respond-now bolt does (into the running turn). Agents set alerts with the aiondx usage alert command, the owner
  // here: click the usage meter. The panel also sets how often the meter and the alert check follow the readings, and how often
  // AionCore's tap writes a reading that has not moved.
  var usagePanel = null;
  function closeUsagePanel() {
    if (!usagePanel) return;
    if (usagePanel.el.parentNode) usagePanel.el.parentNode.removeChild(usagePanel.el);
    document.removeEventListener('keydown', usagePanel.onKey, true);
    usagePanel = null;
  }
  function saveUsageCfg() {
    var b = {};
    b[USAGE_CFG] = { pollSec: usageCfg.pollSec, writeSec: usageCfg.writeSec, alerts: usageCfg.alerts, at: Date.now() };
    putPrefs(b);
  }
  function saveUsageRules(scope, rules) {
    var b = {};
    if (rules.length) {
      usageAlerts[scope] = Object.assign({}, usageAlerts[scope] || {}, { rules: rules, at: Date.now(), rev: ((usageAlerts[scope] && usageAlerts[scope].rev) || 0) + 1 });
      b[USAGE_ALERT + scope] = usageAlerts[scope];
    } else {
      delete usageAlerts[scope];
      b[USAGE_ALERT + scope] = null;
    }
    putPrefs(b);
  }
  function optionsHtml(list, cur) {
    return list.map(function (o) { return '<option value="' + o[0] + '"' + (String(o[0]) === String(cur) ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('');
  }
  function openUsagePanel(t) {
    closeUsagePanel();
    var scope = usageScope(t);
    var el = document.createElement('div');
    el.className = 'aiondx-uspanel';
    el.setAttribute('data-testid', 'aiondx-usage-panel');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Usage settings');
    el.innerHTML = '<div class="aiondx-uspanel-box"><div class="aiondx-uspanel-head"><b>Usage settings</b><button type="button" data-act="close" aria-label="Close">\u2715</button></div>' +
      '<div class="aiondx-uspanel-now"></div>' +
      '<div class="aiondx-uspanel-sec"><label>Refresh the meter and check alerts every <select data-f="pollSec"></select></label>' +
      '<label>Take a reading from Claude\u2019s traffic at least every <select data-f="writeSec"></select> (a reading that moved a whole percent is taken at once)</label>' +
      '<label class="aiondx-uspanel-chk"><input type="checkbox" data-f="alerts"> Send usage alerts</label></div>' +
      '<div class="aiondx-uspanel-sec"><b class="aiondx-uspanel-h"></b><div class="aiondx-uspanel-rules"></div>' +
      '<div class="aiondx-uspanel-add"><select data-f="nwin"></select> at <input type="number" min="1" max="100" value="80" data-f="npct"> % <span>tell</span> <select data-f="nwho"></select>' +
      '<button type="button" data-act="add">Add alert</button></div>' +
      '<div class="aiondx-uspanel-note">The message goes straight into the agent\u2019s running turn, the same as the Respond-now bolt. An alert goes off once per window; agents can set their own with <code>aiondx usage alert</code>.</div></div></div>';
    var q = function (sel) { return el.querySelector(sel); };
    q('[data-f="pollSec"]').innerHTML = optionsHtml([[1, '1 second'], [3, '3 seconds'], [5, '5 seconds'], [10, '10 seconds'], [30, '30 seconds'], [60, 'minute']], usageCfg.pollSec);
    q('[data-f="writeSec"]').innerHTML = optionsHtml([[5, '5 seconds'], [15, '15 seconds'], [30, '30 seconds'], [60, 'minute'], [120, '2 minutes'], [300, '5 minutes']], usageCfg.writeSec);
    q('[data-f="alerts"]').checked = usageCfg.alerts;
    q('.aiondx-uspanel-h').textContent = t.kind === 'team' ? 'Alerts for this team (' + ((teamCache[t.teamId] && teamCache[t.teamId].name) || 'team') + ')' : 'Alerts for this chat';
    q('[data-f="nwin"]').innerHTML = optionsHtml([['5h', '5-hour window'], ['week', 'weekly window']], '5h');
    q('[data-f="nwho"]').innerHTML = t.kind === 'team'
      ? optionsHtml([['lead', 'the team lead'], ['all', 'every member on that account']], 'lead')
      : optionsHtml([['self', 'this agent']], 'self');
    function paint() {
      var cid = t.kind === 'conv' ? t.convId : (teamCache[t.teamId] && teamCache[t.teamId].map[t.slotId]);
      var a = cid ? usageOf(cid) : null;
      q('.aiondx-uspanel-now').textContent = a ? ['5-hour window', 'Week'].map(function (n, i) { return windowText(n, i ? a.seven_day : a.five_hour); }).filter(Boolean).join('  \u00b7  ') + '  (read ' + ageText(Date.now() - (Number(a.at) || 0)) + ')' : 'No usage reading yet.';
      var rules = ((usageAlerts[scope] && usageAlerts[scope].rules) || []);
      var box = q('.aiondx-uspanel-rules');
      box.innerHTML = '';
      if (!rules.length) box.innerHTML = '<div class="aiondx-uspanel-none">No alerts set.</div>';
      rules.forEach(function (r, i) {
        var row = document.createElement('div');
        row.className = 'aiondx-uspanel-rule';
        var who = r.notify === 'all' ? 'every member on that account' : r.notify === 'self' ? (r.who || 'the agent that set it') : 'the team lead';
        row.innerHTML = '<span></span><button type="button" data-act="del" data-i="' + i + '">Remove</button>';
        row.firstChild.textContent = (r.window === 'week' ? 'Weekly' : '5-hour') + ' window at ' + Math.round(Number(r.at) * 100) + '%: tell ' + who + (r.by === 'agent' ? ' (set by ' + (r.who || 'an agent') + ')' : '') + (r.message ? ' \u2014 ' + r.message : '');
        box.appendChild(row);
      });
    }
    paint();
    el.addEventListener('change', function (ev) {
      var fld = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-f');
      if (fld === 'pollSec' || fld === 'writeSec') { usageCfg[fld] = Number(ev.target.value) || usageCfg[fld]; saveUsageCfg(); }
      else if (fld === 'alerts') { usageCfg.alerts = !!ev.target.checked; saveUsageCfg(); }
    });
    el.addEventListener('click', function (ev) {
      if (ev.target === el) { closeUsagePanel(); return; }
      var b = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (!b) return;
      var act = b.getAttribute('data-act');
      if (act === 'close') closeUsagePanel();
      else if (act === 'del') {
        var rules = ((usageAlerts[scope] && usageAlerts[scope].rules) || []).slice();
        rules.splice(Number(b.getAttribute('data-i')), 1);
        saveUsageRules(scope, rules);
        paint();
      } else if (act === 'add') {
        var pctv = Math.round(Number(q('[data-f="npct"]').value));
        if (!(pctv >= 1 && pctv <= 100)) { q('[data-f="npct"]').focus(); return; }
        var rule = { window: q('[data-f="nwin"]').value, at: pctv / 100, notify: q('[data-f="nwho"]').value, by: 'user' };
        var list = ((usageAlerts[scope] && usageAlerts[scope].rules) || []).filter(function (r) { return !(r.window === rule.window && r.notify === rule.notify); });
        list.push(rule);
        saveUsageRules(scope, list);
        paint();
      }
    });
    usagePanel = { el: el, onKey: function (ev) { if (ev.key === 'Escape') { ev.stopPropagation(); closeUsagePanel(); } } };
    document.addEventListener('keydown', usagePanel.onKey, true);
    document.body.appendChild(el);
    var iv = setInterval(function () { if (!usagePanel || usagePanel.el !== el) { clearInterval(iv); return; } paint(); }, 4000);
  }

  // ---------------------------------------------------------------- drafts that survive closing the app (build 2026-09-26.1)

  // a request of 2026-09-26. AionUi keeps a composer's draft in memory only (useSendBoxDraft:
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
  /** What a draft is made of: its text and the reply quote above it, as one comparable string. */
  function draftSig(d) { return d ? String(d.text || '') + '\u0000' + String(d.quote || '') : '\u0000'; }
  /** The reply quote showing over a message box ("Reply" on selected text puts it there), as its text, or ''. AionUi keeps it in the box's own state, so
   *  a restart or a move to another chat loses it; the draft keeps it (option draft.quote). */
  function draftQuoteOf(box) {
    try {
      if (opt('draft.quote') === false) return '';
      var panel = box.closest('.sendbox-panel');
      var q = panel && panel.querySelector('.line-clamp-3.whitespace-pre-wrap');
      return q ? String(q.textContent || '').trim() : '';
    } catch (e) { return ''; }
  }
  /** Put a quote back over a box. The quote is state inside AionUi's send box (a useState; the event that sets it is private to the bundle), so the
   *  setter is found through React's fiber: the hook after a ref, holding null, before a hook holding 0 (replyQuote, then caretPosition, in SendBox
   *  of AionUi 2.2.2). When that shape is not found the quote goes into the draft as a block quote, which is what a sent reply carries anyway. */
  function setReplyQuoteInBox(box, content) {
    try {
      var key = Object.keys(box).filter(function (k) { return k.indexOf('__reactFiber$') === 0; })[0];
      var f = key ? box[key] : null;
      for (var depth = 0; f && depth < 80; f = f.return, depth++) {
        var hooks = [], h = f.memoizedState;
        if (!h || typeof h !== 'object') continue;
        while (h && hooks.length < 300) { hooks.push(h); h = h.next; }
        for (var i = 1; i < hooks.length - 1; i++) {
          var hk = hooks[i], prev = hooks[i - 1], next = hooks[i + 1];
          if (hk.memoizedState === null && hk.queue && typeof hk.queue.dispatch === 'function' &&
              prev.memoizedState && typeof prev.memoizedState === 'object' && Object.keys(prev.memoizedState).join() === 'current' && !prev.queue &&
              next.memoizedState === 0 && next.queue) {
            hk.queue.dispatch({ messageId: '', content: content, position: 'left' });
            return true;
          }
        }
      }
    } catch (e) { /* fall through to the text */ }
    return false;
  }
  /** Save this box's text and quote: at once to localStorage, and to the store once typing pauses (or now). */
  var draftUnloading = false;
  function saveDraft(scope, text, now, quote) {
    text = String(text || '').slice(0, DRAFT_MAX_CHARS);
    quote = quote ? String(quote).slice(0, 20000) : '';
    var sig = text + '\u0000' + quote;
    var keep = !!(text.trim() || quote);
    var cur = localDraft(scope);
    if (draftSig(cur) !== sig) {
      try {
        if (keep) localStorage.setItem(DRAFT_LS + scope, JSON.stringify({ text: text, quote: quote, at: Date.now() }));
        else localStorage.removeItem(DRAFT_LS + scope);
      } catch (e) { /* storage full: the store copy still goes */ }
    }
    var stored = draftStore[scope];
    var pending = draftTimers[scope];
    if (draftSig(stored) === sig) { if (pending) { clearTimeout(pending.timer); delete draftTimers[scope]; } return; }
    if (pending && pending.sig === sig && !now) return;   // already on its way, once typing has paused
    var write = function () {
      delete draftTimers[scope];
      var body = {};
      body[DRAFT_STORE + scope] = keep ? { text: text, quote: quote, at: Date.now() } : null;
      if (keep) draftStore[scope] = body[DRAFT_STORE + scope]; else delete draftStore[scope];
      if (sharedGone) return;
      fetch(apiUrl('/api/settings/client'), {
        method: 'PUT', credentials: 'include', keepalive: draftUnloading && JSON.stringify(body).length < 60000,
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf() }, body: JSON.stringify(body)
      }).catch(function () {});
    };
    if (pending) clearTimeout(pending.timer);
    if (now) write(); else draftTimers[scope] = { text: text, sig: sig, timer: setTimeout(write, DRAFT_STORE_DELAY_MS) };
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
        var a = localDraft(scope), b = draftStore[scope];
        var pick = a && b ? (Number(a.at) >= Number(b.at) ? a : b) : (a || b);
        var fresh = pick && Date.now() - (Number(pick.at) || 0) < DRAFT_MAX_AGE_MS;
        var quoted = fresh && pick.quote && opt('draft.quote') !== false && !draftQuoteOf(box);
        if (quoted && !setReplyQuoteInBox(box, pick.quote)) {
          // No React setter to be found: the quote goes in as a block quote ahead of the text, as a sent reply would carry it.
          var asText = String(pick.quote).split('\n').map(function (l) { return '> ' + l; }).join('\n') + '\n\n';
          if (!text) { setComposerValue(box, asText + (pick.text || '')); return; }
        }
        if (!text) {
          if (fresh && pick.text.trim()) {
            setComposerValue(box, pick.text);
            return;
          }
        }
      }
      saveDraft(scope, text, flushNow, draftQuoteOf(box));
    });
  }
  function watchDrafts() {
    document.addEventListener('input', function (ev) {
      var el = ev.target;
      if (!el || !el.closest || !el.closest('[data-testid="sendbox-input"]')) return;
      var t = targetOf(el);
      if (!t) return;
      draftRestored[draftScope(t)] = true;   // you are typing: nothing to restore over it
      saveDraft(draftScope(t), el.value || '', false, draftQuoteOf(el));
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
  // Version 2 (a request of 2026-09-26): Aion CLI switched off, with the
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

  // A request of 2026-09-26: Antigravity setup is the first screen ("Welcome to AionDX": sign up for a free Antigravity key so it can
  // migrate the user's agent and preferences from other apps), with an option to skip and have everything configured by an external
  // agent (like Claude via Claude Desktop), on the same screen as the global options (instructions for every agent) and the
  // account migration options, all handled by Antigravity. Shown once, after first-run setup, until the
  // user finishes it or picks "Not now"; reopened from Settings > Appearance ("AionDX setup").
  // State: aiondx.welcome = { done, mode: 'antigravity' | 'external' | 'later', at, conv }.
  var WELCOME_KEY = 'aiondx.welcome';
  var AGY_INSTALL = 'irm https://antigravity.google/cli/install.ps1 | iex; & "$env:LOCALAPPDATA\\AionDX\\bin\\aiondx.exe" doctor';
  var welcome = { el: null, step: 0, data: null, agy: null, alt: null, via: null, conv: null, opened: false };
  // The failsafe (a request of 2026-09-26). The setup skill is in
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
    // Clearer for Antigravity (a request of 2026-09-26: it had handed a tester scripts to run): the same scan and import the
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
   *  a second chat (a request of September 26th). */
  function once(btn, work) {
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('arco-btn-loading');
    Promise.resolve().then(work).catch(function (e) { console.log('[dx] welcome', e); }).then(function () {
      btn.disabled = false;
      btn.classList.remove('arco-btn-loading');
    });
  }
  // ---- the one-click setup (a request of 2026-09-26, Antigravity
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

  // ---- the Welcome screen's "Sign in to your agents" (build 2026-10-12.1)
  var accounts = { timer: null, account: '' };
  function accountsBox() { return welcome.el && welcome.step === 'accounts' ? welcome.el.firstChild : null; }
  function accountsFlow(on, msg) {
    var box = accountsBox();
    if (!box) return;
    var f = box.querySelector('.aiondx-acc-flow');
    f.hidden = !on;
    if (msg !== undefined) {
      var m = f.querySelector('.aiondx-acc-flow-msg');
      m.textContent = '';
      if (msg && msg.url) {
        m.appendChild(document.createTextNode('The sign-in page opened in your browser. If it did not, '));
        var a = document.createElement('a');
        a.href = msg.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'open it here';
        m.appendChild(a);
        m.appendChild(document.createTextNode('. When the page shows a code instead of finishing, paste it below.'));
      } else if (msg) m.textContent = String(msg);
    }
    box.querySelectorAll('.aiondx-acc-signin, .aiondx-acc-add').forEach(function (b) { b.disabled = !!on; });
  }
  function accountsStop() { if (accounts.timer) { clearInterval(accounts.timer); accounts.timer = null; } }
  function accountsStatus() {
    var box = accountsBox();
    if (!box || !window.aiondxSignin) return Promise.resolve();
    var st = box.querySelector('.aiondx-acc-state');
    return window.aiondxSignin.status('claude').then(function (r) {
      if (!accountsBox()) return;
      if (!r || !r.ok) st.textContent = 'Could not ask Claude Code: ' + ((r && r.error) || 'no answer') + '.';
      else if (!r.installed) st.textContent = 'Not installed on this PC.';
      else if (r.loggedIn && r.renews === false) st.textContent = 'Signed in' + (r.email ? ' as ' + r.email : '') + ' with an old sign-in that cannot renew itself and carries no Claude Docs or claude.ai skills: sign in again once.';
      else if (r.loggedIn) st.textContent = 'Signed in' + (r.email ? ' as ' + r.email : '') + (r.plan ? ' (' + r.plan + ')' : '') + '. It renews itself' +
        (r.renewsUntil ? ' until ' + longDate(r.renewsUntil) + '; sign in again before then' : '') + '; Claude Docs and your claude.ai skills come with it.';
      else st.textContent = 'Not signed in.';
      var b = box.querySelector('.aiondx-acc-signin');
      b.textContent = r && r.loggedIn ? 'Sign in again' : 'Sign in';
      b.disabled = !!(r && r.installed === false);
      box.querySelector('.aiondx-acc-add').disabled = !!(r && r.installed === false);
    }, function () { if (accountsBox()) st.textContent = 'Could not ask Claude Code.'; });
  }
  async function accountsStart(account) {
    accounts.account = account;
    accountsFlow(true, account ? 'Starting the sign-in for the account "' + account + '"...' : 'Starting the sign-in...');
    welcomeStatus('', '');
    var r = await window.aiondxSignin.start('claude', account || undefined);
    if (!r || !r.ok) { accountsFlow(false); welcomeStatus('The sign-in did not start: ' + ((r && (r.error || r.text)) || 'no answer') + '.', ''); return; }
    accountsFlow(true, r.url ? { url: r.url } : 'The sign-in page should be open in your browser.');
    var box = accountsBox();
    if (box) box.querySelector('.aiondx-acc-code').focus();
    accountsStop();
    var started = Date.now();
    accounts.timer = setInterval(function () {
      if (!accountsBox() || Date.now() - started > 11 * 60000) { accountsStop(); return; }
      window.aiondxSignin.poll().then(function (p) {
        if (!p || p.state === 'running' || p.state === 'none') return;
        accountsStop();
        accountsFlow(false);
        if (p.state === 'done') accountsDone(account);
        else welcomeStatus('The sign-in did not finish.', p.text || '');
      }, function () {});
    }, 1500);
  }
  function accountsCode() {
    var box = accountsBox();
    if (!box) return;
    var input = box.querySelector('.aiondx-acc-code');
    var code = input.value.trim();
    if (!code) return;
    window.aiondxSignin.code(code).then(function (r) {
      if (r && r.ok) { input.value = ''; accountsFlow(true, 'Code sent. Waiting for Claude Code to finish the sign-in...'); }
      else welcomeStatus((r && r.error) || 'The code could not be passed on.', '');
    });
  }
  async function accountsDone(account) {
    if (!account) { welcomeStatus('Signed in. Claude chats started from now on use this sign-in.', ''); accountsStatus(); return; }
    var st = await window.aiondxSignin.status('claude', account);
    var label = account.charAt(0).toUpperCase() + account.slice(1) + (st && st.plan ? ' (' + st.plan + ')' : '');
    var reg = await window.aiondxSignin.register(account, label);
    if (!reg || !reg.ok) { welcomeStatus('Signed in, but the account could not be added to the chats\' account menu: ' + ((reg && reg.error) || 'no answer') + '.', ''); return; }
    // the chats' account menu reads aiondx.accounts
    try {
      var cur = await getJson('/api/settings/client?keys=' + encodeURIComponent(ACCOUNTS_KEY));
      var rec = (cur && cur.data && cur.data[ACCOUNTS_KEY]) || {};
      var list = Array.isArray(rec.accounts) ? rec.accounts.filter(function (a) { return a && a.id !== account; }) : [];
      list.push({ id: account, label: label, added: true });
      var body = {};
      body[ACCOUNTS_KEY] = Object.assign({ v: 1 }, rec, { accounts: list });
      accountsRec = body[ACCOUNTS_KEY];
      await putPrefs(body);
    } catch (e) { /* the launcher has it; the menu catches up when the list is next written */ }
    welcomeStatus('Signed in as ' + ((st && st.email) || 'the new account') + '. "' + label + '" is now in every Claude chat\'s account menu.', '');
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
          (window.aiondxSignin ? '<button type="button" class="arco-btn arco-btn-secondary arco-btn-size-default aiondx-w-accounts">Sign in to your agents</button>' : '') +
          '<button type="button" class="arco-btn arco-btn-text arco-btn-size-default aiondx-w-later">Not now</button>' +
        '</div>' +
        '<p class="aiondx-welcome-foot">Not now closes this; Settings &gt; Appearance &gt; Open AionDX setup brings it back.</p>';
      box.querySelector('.aiondx-w-scan').addEventListener('click', function (ev) { once(ev.currentTarget, runWelcomeScan); });
      box.querySelector('.aiondx-w-agy').addEventListener('click', function () { showWelcome('agy'); });
      var accBtn = box.querySelector('.aiondx-w-accounts');
      if (accBtn) accBtn.addEventListener('click', function () { showWelcome('accounts'); });
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
    } else if (step === 'accounts') {
      // A request of 2026-10-11: signing an agent in took an agent (or an outside model) and a long time. Here a button starts the agent's
      // own sign-in (main process aiondx:signin): its sign-in page opens in the browser, a code it shows can be pasted here, and the agent
      // keeps its own credentials, as it does outside AionDX. Claude Code first; another account gets its own folder and joins every
      // chat's account menu.
      box.innerHTML =
        '<img class="aiondx-welcome-mark" src="./aiondx-mark.svg" alt="">' +
        '<h2 id="aiondx-welcome-title" class="aiondx-welcome-title">Sign in to your agents</h2>' +
        '<p class="aiondx-welcome-text">Each agent signs in with its own sign-in page, in your browser. AionDX starts it and keeps nothing: the agent keeps its sign-in, as it does outside AionDX.</p>' +
        '<div class="aiondx-acc-row" data-testid="aiondx-acc-claude">' +
          '<div class="aiondx-acc-name">Claude Code</div>' +
          '<div class="aiondx-acc-state">Checking...</div>' +
          '<div class="aiondx-acc-actions">' +
            '<button type="button" class="arco-btn arco-btn-primary arco-btn-size-small aiondx-acc-signin">Sign in</button>' +
            '<button type="button" class="arco-btn arco-btn-secondary arco-btn-size-small aiondx-acc-add">Add another Claude account</button>' +
          '</div>' +
        '</div>' +
        '<div class="aiondx-acc-flow" hidden>' +
          '<div class="aiondx-acc-flow-msg"></div>' +
          '<div class="aiondx-signin-row"><input class="arco-input aiondx-acc-code" type="text" spellcheck="false" autocomplete="off" placeholder="Code from the sign-in page, if it shows one">' +
          '<button type="button" class="arco-btn arco-btn-primary arco-btn-size-small aiondx-acc-send">Submit</button>' +
          '<button type="button" class="arco-btn arco-btn-text arco-btn-size-small aiondx-acc-cancel">Cancel</button></div>' +
        '</div>' +
        '<div class="aiondx-welcome-status" aria-live="polite"></div>' +
        '<div class="aiondx-welcome-actions">' +
          '<button type="button" class="arco-btn arco-btn-secondary arco-btn-size-default aiondx-w-back">Back</button>' +
          '<button type="button" class="arco-btn arco-btn-text arco-btn-size-default aiondx-w-later">Done</button>' +
        '</div>';
      box.querySelector('.aiondx-w-back').addEventListener('click', function () { accountsStop(); showWelcome(1); });
      box.querySelector('.aiondx-w-later').addEventListener('click', function () { accountsStop(); laterWelcome(); });
      box.querySelector('.aiondx-acc-signin').addEventListener('click', function () { accountsStart(''); });
      box.querySelector('.aiondx-acc-add').addEventListener('click', function () {
        var name = window.prompt('A short name for the other Claude account (letters, digits and dashes), for example: work');
        if (name === null) return;
        name = String(name).trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(name)) { welcomeStatus('An account name is a short word: letters, digits and dashes.', ''); return; }
        accountsStart(name);
      });
      box.querySelector('.aiondx-acc-send').addEventListener('click', accountsCode);
      box.querySelector('.aiondx-acc-code').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); accountsCode(); } });
      box.querySelector('.aiondx-acc-cancel').addEventListener('click', function () { window.aiondxSignin.cancel(); accountsStop(); accountsFlow(false); welcomeStatus('Sign-in cancelled.', ''); });
      accountsStatus();
    } else if (step === 'agy') {
      box.innerHTML =
        '<img class="aiondx-welcome-mark" src="./aiondx-mark.svg" alt="">' +
        '<h2 id="aiondx-welcome-title" class="aiondx-welcome-title">' + (oneClick() ? 'Set up with Antigravity' : 'Welcome to AionDX') + '</h2>' +
        '<p class="aiondx-welcome-text">Sign in to Antigravity with your Google account, and it can bring over the agent and user preferences from the other AI apps you use. There is no key to paste: Google\'s sign-in page does it.</p>' +
        // a request of 2026-09-26. Google publishes no number for the
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

  // a request of 2026-09-26. Build 2026-09-26.1 read that as "stop the agent": the tick box and the bolt
  // cancelled the running turn, or sent a "Respond now: stop what you are doing..." note that only piled onto the queue. a request of 2026-10-01.
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
  /** Runs fn on the press itself (R-104, 2026-11-12: "lightning bolt send still doesn't do anything"). A click needs the press and the release
   *  on the same element in the same place; while an agent works the page redraws many times a second (a streaming reply re-renders the
   *  message rows, and a repaint can move a control AionDX placed), so a click on a bolt was often never delivered, with no request and no
   *  error. A keyboard click (Enter or Space, detail 0) still works; a click that follows a handled press is ignored. */
  function onPress(el, fn) {
    el.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0 || el.disabled) return;
      ev.preventDefault(); ev.stopPropagation();
      el._pressAt = Date.now();
      fn(ev);
    });
    el.addEventListener('click', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      if (el.disabled || Date.now() - (el._pressAt || 0) < 1500) return;
      fn(ev);
    });
  }
  /** True when el already comes before ref under the same parent (other AionDX controls may sit between): nothing to move. */
  function placedBefore(el, ref) {
    return el.parentNode === ref.parentNode && !!(el.compareDocumentPosition(ref) & Node.DOCUMENT_POSITION_FOLLOWING);
  }
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
  setTimeout(function () { try { if (!disabled()) driveNotices(); } catch (e) {} }, 4000);
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
    onPress(b, function () { boltClick(b._t, b._mid); });
    return b;
  }

  var rnQueued = {};         // member key -> { t, items: [{ id: mailbox id, want: its text, at: when it was sent }] }
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
        Object.keys(rnQueued).forEach(function (key) {
          var q = rnQueued[key];
          queuedRows(q).forEach(function (m) {
            var qb = placeBolt(m.row, q.t, m.id);
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
  /** Where a member's messages are on screen: its column, or the whole page when it is the member in front in the single view. */
  function rnContainer(t) {
    var col = null;
    var cols = document.querySelectorAll('[data-slot-id]');
    for (var i = 0; i < cols.length; i++) if (cols[i].getAttribute('data-slot-id') === t.slotId) { col = cols[i]; break; }
    if (col) return col;
    var sv = singleViewTarget(t.teamId);
    return sv && sv.slotId === t.slotId ? document : null;
  }
  function sameMessage(shown, want) {
    if (!shown || !want) return false;
    if (shown === want) return true;
    // A long message can be shown shortened or with attachment lines around it: the start of both is the same text.
    var n = Math.min(120, shown.length, want.length);
    return n >= 40 && shown.slice(0, n) === want.slice(0, n);
  }
  /** The rows on screen that are your messages still waiting in this member's queue, matched by their text, so it does not matter how
   *  far back in the chat they are or which id the page gave the row (a request of 2026-10-02: a message sent in this view keeps the page's own id until the chat is read again, and
   *  the member's last 40 chat messages, where the old code looked, are a few minutes of its work). Several queued messages with one
   *  text take the latest bubbles with that text, oldest first. */
  function queuedRows(q) {
    var scope = rnContainer(q.t);
    if (!scope) return [];
    var rows = [].slice.call(scope.querySelectorAll('[data-testid="message-text-right"]'));
    if (!rows.length) return [];
    var texts = rows.map(function (row) {
      var c = row.querySelector('[data-testid="message-text-content"]');
      return normText(c ? c.textContent : '');
    });
    var used = {}, out = [], lost = [];
    // Newest queued message first, taking the newest unused bubble that shows its text.
    q.items.slice().sort(function (a, b) { return b.at - a.at; }).forEach(function (it) {
      for (var i = rows.length - 1; i >= 0; i--) {
        if (used[i] || !sameMessage(texts[i], it.want)) continue;
        used[i] = true;
        out.push({ row: rows[i], id: it.id });
        return;
      }
      lost.push(it);
    });
    // A message sent in this view can show text the mailbox row does not have (the page's own copy, before the chat is read again), and
    // then no bubble matches. AionUi marks the bubbles that wait unread, so the unmatched queued messages (newest first) take the
    // newest unmatched unread bubbles. The bolt sits on the right message even when the text differs, so long as the counts agree.
    if (lost.length) {
      var unread = [];
      for (var j = rows.length - 1; j >= 0; j--) if (!used[j] && rows[j].querySelector('[data-testid="message-status-badge"]')) unread.push(j);
      var n = Math.min(lost.length, unread.length);
      for (var k = 0; k < n; k++) out.push({ row: rows[unread[k]], id: lost[k].id, byBadge: true });
      if (lost.length > n) {
        diagnose('bolt-no-row', q.t.key, { waiting: q.items.length, unmatched: lost.length - n, bubbles: rows.length, unread: unread.length,
          wantStart: lost[n].want.slice(0, 50), wantLen: lost[n].want.length });
      }
    }
    return out;
  }
  /** For team pages, every few seconds: which of your messages each member still has waiting in its queue. */
  async function scanTeamQueues() {
    var r = route();
    if (!r || r.kind !== 'team' || disabled()) { if (Object.keys(rnQueued).length) { rnQueued = {}; renderRespondNow(); renderUnsend(); } return; }
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
          var items = [];
          w.queued_foreground_message_ids.forEach(function (mid) {
            var row = byId[mid];
            if (row) items.push({ id: mid, want: normText(row.content), at: Number(row.created_at) || 0 });
          });
          if (items.length) next[t.key] = { t: t, items: items };
        }
      }
    } catch (e) {
      return;   // a read that failed says nothing about the queue: what is on screen stays until the next one
    }
    rnQueued = next;
    renderRespondNow();
    renderUnsend();   // the queue just changed: Unsend lines follow it at once, not at the next change of the page
  }

  // ---------------------------------------------------------------- unsend (build 2026-09-25.5)

  // a request of 2026-09-25. A message sent to a Claude chat while it works shows "Unread"
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
          delete unsendEdits[mid];
          var clear = {};
          clear[UNSEND_REQ + p.msgId] = null;
          putPrefs(clear);
          notify(convTarget(p.conv), 'Not unsent: this chat\'s Claude process did not answer.',
            'It can unsend once it has restarted with the current AionDX router (Reconnect agent, or AionUi\'s next start).');
        }
        return;
      }
      delete unsendPending[mid];
      if (!r.cancelled) delete unsendEdits[mid];
      // Shown once: the router's answer can go from the store (the struck-through row keeps its mark here).
      unsendShown[p.msgId] = r;
      var drop = {};
      drop[UNSEND_RES + p.msgId] = null;
      putPrefs(drop);
      if (r.cancelled) { notify(convTarget(p.conv), 'Unsent. The agent never saw it.', ''); finishEdit(mid); }
      else notify(convTarget(p.conv), 'Too late to unsend: the agent had already picked it up.', r.error ? String(r.error) : '');
    });
  }

  async function unsendMessage(convId, messageId) {
    if (unsendPending[messageId]) return;
    unsendPending[messageId] = { conv: convId, msgId: null, at: Date.now() };
    renderUnsend();
    var fail = function (text) { delete unsendPending[messageId]; delete unsendEdits[messageId]; notify(convTarget(convId), text, ''); renderUnsend(); };
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
    if (!r || disabled()) return;
    if (r.kind === 'team') { renderTeamUnsend(r); return; }
    if (r.kind !== 'conv') return;
    var info = convInfo[r.id];
    if (!info || Date.now() - info.at > CONV_INFO_MS) loadConvInfo(r.id);
    if (info && info.backend === 'claude') unsendButtons(document, r.id, null);
    Object.keys(unsendResults).forEach(function (msgId) {
      var res = unsendResults[msgId];
      if (!res || !res.cancelled || res.conv !== r.id || !res.messageId) return;
      var el = document.getElementById('message-' + res.messageId);
      if (el && el.getAttribute('data-aiondx-unsent') !== '1') el.setAttribute('data-aiondx-unsent', '1');
    });
  }
  /** An Unsend button in every "Unread" badge inside scope. queued (a team member's waiting messages, matched to their bubbles) is
   *  { row element -> { t, id: mailbox id } }: those are taken back from the team's queue; the others are the member's own chat messages. */
  function unsendButtons(scope, convId, queued, chatToo) {
    var badges = scope.querySelectorAll('[data-testid="message-status-badge"]');
    for (var i = 0; i < badges.length; i++) {
      var badge = badges[i];
      var row = badge.closest('[id^="message-"]');
      if (!row) continue;
      var mine = null;
      if (queued) for (var q = 0; q < queued.length; q++) if (queued[q].row === row) { mine = queued[q]; break; }
      if (!mine && chatToo === false) continue;   // a message not in the queue, in a chat that is not Claude's: nothing to take back
      unsendButton(badge, row, convId, mine);
    }
    // A message waiting in a team member's queue is drawn without an Unread badge (the member's chat does not hold it yet): its
    // Unsend sits in a line of its own under the bubble. Found 2026-10-10 in the real app; a badge was all the first version looked for.
    var live = [];
    if (queued) queued.forEach(function (m) {
      if (!m.row || !m.row.id || m.row.querySelector('[data-testid="message-status-badge"]')) return;
      var foot = queuedFoot(m.row);
      if (!foot) return;
      live.push(foot);
      unsendButton(foot, m.row, convId, m);
    });
    [].slice.call(scope.querySelectorAll('.aiondx-unsend-foot')).forEach(function (f) {
      if (live.indexOf(f) < 0 && f.parentNode) f.parentNode.removeChild(f);
    });
  }
  /** The line under a queued bubble that holds its Unsend (made once; the bubble's own parts are the page's). */
  function queuedFoot(row) {
    var foot = row.querySelector('.aiondx-unsend-foot');
    if (foot) return foot;
    var content = row.querySelector('[data-testid="message-text-content"]');
    var bubble = content && content.parentElement;
    if (!bubble || !bubble.parentNode) return null;
    foot = document.createElement('div');
    foot.className = 'aiondx-unsend-foot';
    foot.setAttribute('data-testid', 'aiondx-unsend-foot');
    foot.appendChild(document.createTextNode('Waiting in the queue'));
    bubble.parentNode.insertBefore(foot, bubble.nextSibling);
    return foot;
  }
  /** The Unsend button inside host (an Unread badge, or a queued bubble's line), set for this row. */
  function unsendButton(host, row, convId, mine) {
    var mid = row.id.slice('message-'.length);
    var btn = host.querySelector('.aiondx-unsend');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'aiondx-unsend';
      btn.setAttribute('data-testid', 'aiondx-unsend');
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var b = ev.currentTarget;
        var go = b._q ? unsendQueued(b._q, b._conv, b._mid) : unsendMessage(b._conv, b._mid);
        go.catch(function (e) { console.log('[dx] unsend error', e); });
      });
      host.appendChild(btn);
    }
    btn._conv = convId;
    btn._mid = mid;
    btn._q = mine;
    var pending = !!unsendPending[mid];
    var label = pending ? 'Unsending...' : 'Unsend';
    if (btn.textContent !== label) btn.textContent = label;
    btn.disabled = pending;
    // Edit: take it back, and the text comes back in the message box to change and send again (a request of 2026-10-09: edit a
    // message that was sent and is unread).
    var ed = host.querySelector('.aiondx-edit');
    if (!ed) {
      ed = document.createElement('button');
      ed.type = 'button';
      ed.className = 'aiondx-edit';
      ed.setAttribute('data-testid', 'aiondx-edit');
      ed.textContent = 'Edit';
      ed.title = 'Take this message back and put its text in the message box, to change it and send it again';
      ed.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var b = ev.currentTarget;
        editUnread(b._row, b._conv, b._q).catch(function (e) { console.log('[dx] edit error', e); });
      });
      host.appendChild(ed);
    }
    ed._row = row;
    ed._conv = convId;
    ed._q = mine;
    ed.disabled = pending;
    return btn;
  }
  var unsendEdits = {};      // bubble id -> { text, convId, key }: put back in the message box once the message has been taken back
  /** Edit an unread message: take it back like Unsend, then its text goes into the message box of the chat it was sent from. */
  async function editUnread(row, convId, q) {
    var mid = row.id.slice('message-'.length);
    if (unsendPending[mid]) return;
    var c = row.querySelector('[data-testid="message-text-content"]');
    var text = c ? String(c.innerText || c.textContent || '').replace(/\r/g, '').trim() : '';
    if (!text) { notify(q ? q.t : convTarget(convId), 'Could not edit: the message text was not found.', ''); return; }
    unsendEdits[mid] = { text: text, convId: convId, key: q ? q.t.key : null, at: Date.now() };
    await (q ? unsendQueued(q, convId, mid) : unsendMessage(convId, mid));
  }
  /** The message was taken back: its text goes in the box (after what is typed there already). */
  function finishEdit(mid) {
    var e = unsendEdits[mid];
    if (!e) return;
    delete unsendEdits[mid];
    var ts = targets().filter(function (x) {
      if (e.key) return x.key === e.key;
      if (x.kind === 'conv') return x.convId === e.convId;
      return !!(teamCache[x.teamId] && teamCache[x.teamId].map[x.slotId] === e.convId);
    });
    var ta = ts.length ? boxIn(panelOf(ts[0].actions)) : null;
    if (!ta) { notify(e.key ? { kind: 'team', key: e.key } : convTarget(e.convId), 'Taken back. The message box is not on screen: your text was ' + e.text.slice(0, 300), ''); return; }
    var cur = String(ta.value || '');
    setComposerValue(ta, cur.trim() ? cur.replace(/\s+$/, '') + '\n\n' + e.text : e.text);
    try { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } catch (x) { /* a box without a caret */ }
  }
  var teamUnsent = {};       // bubble id -> true: taken back from a team member's queue
  /** A team page: the Unread bubbles of each member on screen. A message still in the member's queue is taken back there; one the member's
   *  chat already holds (delivered into its running turn, waiting for Claude to read it) goes the way a solo chat's does. */
  function renderTeamUnsend(r) {
    var tc = teamCache[r.id];
    if (!tc) return;
    Object.keys(tc.map).forEach(function (slotId) {
      var convId = tc.map[slotId];
      var t = { kind: 'team', key: 'team:' + r.id + ':' + slotId, teamId: r.id, slotId: slotId, role: '' };
      var scope = rnContainer(t);
      if (!scope || !convId) return;
      var info = convInfo[convId];
      if (!info || Date.now() - info.at > CONV_INFO_MS) loadConvInfo(convId);
      var q = rnQueued[t.key];
      var queued = q ? queuedRows(q).map(function (m) {
        var row = m.row.id ? m.row : m.row.closest('[id^="message-"]');
        return { row: row, id: m.id, t: q.t };
      }) : [];
      var claude = !!(info && info.backend === 'claude');
      if (!queued.length && !claude) {
        [].slice.call(scope.querySelectorAll('.aiondx-unsend-foot')).forEach(function (f) { if (f.parentNode) f.parentNode.removeChild(f); });
        return;
      }
      unsendButtons(scope, convId, queued, claude);
    });
    Object.keys(teamUnsent).forEach(function (id) {
      var el = document.getElementById('message-' + id);
      if (el && el.getAttribute('data-aiondx-unsent') !== '1') el.setAttribute('data-aiondx-unsent', '1');
    });
  }
  /** Take one of your messages back out of a team member's queue; if it has left the queue meanwhile, the member's own chat decides. */
  async function unsendQueued(q, convId, domId) {
    if (unsendPending[domId]) return;
    unsendPending[domId] = { conv: convId, msgId: null, at: Date.now() };
    renderUnsend();
    var done = function (text) { delete unsendPending[domId]; delete unsendEdits[domId]; notify(q.t, text, ''); renderUnsend(); };
    try {
      var r = await steerAgent(q.t, { message_id: q.id, unsend: true });
      if (r.status === 404 || r.status === 405) { done('This AionCore cannot take a queued message back yet.'); return; }
      if (!r.ok) { done('Could not unsend (' + r.status + ').'); return; }
      var outcome = await steerAnswer(r);
      if (outcome === 'unsent') {
        teamUnsent[domId] = true;
        finishEdit(domId);
        done('Unsent. ' + rnWho(q.t) + ' will never read it.');
        scanTeamQueues().catch(function () {});
        return;
      }
      // not_queued: the member already has it. A running Claude turn may still hold it unread in its own queue.
      delete unsendPending[domId];
      renderUnsend();
      await unsendMessage(convId, domId);
    } catch (e) { done('Could not unsend: ' + (e && e.message ? e.message : 'the request failed') + '.'); }
  }

  // ---------------------------------------------------------------- picture viewer (build 2026-10-09.1)

  // a request of 2026-10-09. A picture in a chat opens in AionDX's own viewer: previous and next walk through every picture
  // shown in the chat (the arrow buttons, the arrow keys), the wheel zooms, a drag moves a zoomed picture, Esc closes. AionUi's
  // pictures from tools had a viewer whose arrows did nothing (each picture was its own group once the list scrolled), and
  // pictures that an agent links in its text (markdown, drawn inside a shadow root) had none at all.
  var viewer = null;         // { el, img, items: [src], i, scale, x, y }
  function viewerPictures() {
    var out = [];
    var rows = document.querySelectorAll('[id^="message-"]');
    var seen = {};
    function take(img) {
      var src = img.currentSrc || img.src;
      if (!src || seen[src + '#' + out.length]) return;
      var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      if (w < 32 || h < 32) return;
      if (img.closest && (img.closest('.aiondx-viewer') || img.closest('button') || img.closest('.arco-avatar'))) return;
      out.push({ src: src, alt: img.getAttribute('alt') || '' });
    }
    function walk(root) {
      var imgs = root.querySelectorAll ? root.querySelectorAll('img, *') : [];
      for (var i = 0; i < imgs.length; i++) {
        var n = imgs[i];
        if (n.tagName === 'IMG') take(n);
        else if (n.shadowRoot) walk(n.shadowRoot);
      }
    }
    for (var r = 0; r < rows.length; r++) walk(rows[r]);
    return out;
  }
  function viewerPaint() {
    if (!viewer) return;
    var it = viewer.items[viewer.i];
    if (!it) return;
    viewer.img.src = it.src;
    viewer.img.alt = it.alt;
    viewer.img.style.transform = 'translate(' + viewer.x + 'px,' + viewer.y + 'px) scale(' + viewer.scale + ')';
    viewer.img.style.cursor = viewer.scale > 1 ? 'grab' : 'zoom-in';
    viewer.count.textContent = (viewer.i + 1) + ' / ' + viewer.items.length + (it.alt ? '  \u00b7  ' + it.alt : '');
    viewer.prev.disabled = viewer.i <= 0;
    viewer.next.disabled = viewer.i >= viewer.items.length - 1;
    viewer.zoomText.textContent = Math.round(viewer.scale * 100) + '%';
  }
  function viewerGo(step) {
    if (!viewer) return;
    // The list is read again each time: pictures further along may have been drawn since the viewer opened.
    var cur = viewer.items[viewer.i];
    var fresh = viewerPictures();
    var at = -1;
    for (var i = 0; i < fresh.length; i++) if (cur && fresh[i].src === cur.src) { at = i; break; }
    if (at >= 0) { viewer.items = fresh; viewer.i = at; }
    var to = viewer.i + step;
    if (to < 0 || to >= viewer.items.length) { viewerPaint(); return; }
    viewer.i = to;
    viewer.scale = 1; viewer.x = 0; viewer.y = 0;
    viewerPaint();
  }
  function viewerZoom(factor) {
    if (!viewer) return;
    viewer.scale = Math.min(8, Math.max(0.2, viewer.scale * factor));
    if (viewer.scale <= 1) { viewer.x = 0; viewer.y = 0; }
    viewerPaint();
  }
  function viewerClose() {
    if (!viewer) return;
    if (viewer.el.parentNode) viewer.el.parentNode.removeChild(viewer.el);
    viewer = null;
  }
  function viewerOpen(img) {
    viewerClose();
    var items = viewerPictures();
    var src = img.currentSrc || img.src;
    var i = -1;
    for (var k = 0; k < items.length; k++) if (items[k].src === src) { i = k; if (img.getAttribute('alt') === items[k].alt) break; }
    if (i < 0) { items.push({ src: src, alt: img.getAttribute('alt') || '' }); i = items.length - 1; }
    var el = document.createElement('div');
    el.className = 'aiondx-viewer';
    el.setAttribute('data-testid', 'aiondx-viewer');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Picture viewer');
    el.innerHTML = '<div class="aiondx-viewer-bar"><span class="aiondx-viewer-count"></span><span class="aiondx-viewer-tools">' +
      '<button type="button" data-act="out" title="Zoom out (-)" aria-label="Zoom out">\u2212</button>' +
      '<span class="aiondx-viewer-zoom"></span>' +
      '<button type="button" data-act="in" title="Zoom in (+)" aria-label="Zoom in">+</button>' +
      '<button type="button" data-act="fit" title="Fit to window (0)" aria-label="Fit to window">Fit</button>' +
      '<button type="button" data-act="close" title="Close (Esc)" aria-label="Close">\u2715</button></span></div>' +
      '<button type="button" class="aiondx-viewer-nav aiondx-viewer-prev" data-act="prev" title="Previous picture (\u2190)" aria-label="Previous picture">\u2039</button>' +
      '<div class="aiondx-viewer-stage"><img draggable="false" alt=""></div>' +
      '<button type="button" class="aiondx-viewer-nav aiondx-viewer-next" data-act="next" title="Next picture (\u2192)" aria-label="Next picture">\u203a</button>';
    viewer = { el: el, img: el.querySelector('img'), items: items, i: i, scale: 1, x: 0, y: 0,
      count: el.querySelector('.aiondx-viewer-count'), zoomText: el.querySelector('.aiondx-viewer-zoom'),
      prev: el.querySelector('.aiondx-viewer-prev'), next: el.querySelector('.aiondx-viewer-next') };
    var drag = null;
    el.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (b) {
        var act = b.getAttribute('data-act');
        if (act === 'prev') viewerGo(-1);
        else if (act === 'next') viewerGo(1);
        else if (act === 'in') viewerZoom(1.25);
        else if (act === 'out') viewerZoom(0.8);
        else if (act === 'fit') { viewer.scale = 1; viewer.x = 0; viewer.y = 0; viewerPaint(); }
        else if (act === 'close') viewerClose();
        return;
      }
      if (drag && drag.moved) return;
      if (ev.target === viewer.img) { if (viewer.scale > 1) { viewer.scale = 1; viewer.x = 0; viewer.y = 0; } else viewer.scale = 2; viewerPaint(); return; }
      if (ev.target.classList && (ev.target.classList.contains('aiondx-viewer') || ev.target.classList.contains('aiondx-viewer-stage'))) viewerClose();
    });
    el.addEventListener('wheel', function (ev) { ev.preventDefault(); viewerZoom(ev.deltaY < 0 ? 1.15 : 1 / 1.15); }, { passive: false });
    el.addEventListener('mousedown', function (ev) {
      if (ev.target !== viewer.img || viewer.scale <= 1) return;
      drag = { sx: ev.clientX, sy: ev.clientY, x: viewer.x, y: viewer.y, moved: false };
      ev.preventDefault();
    });
    window.addEventListener('mousemove', function onMove(ev) {
      if (!viewer || viewer.el !== el) { window.removeEventListener('mousemove', onMove); return; }
      if (!drag) return;
      var dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      viewer.x = drag.x + dx; viewer.y = drag.y + dy;
      viewerPaint();
    });
    window.addEventListener('mouseup', function onUp() {
      if (!viewer || viewer.el !== el) { window.removeEventListener('mouseup', onUp); return; }
      if (drag) setTimeout(function () { drag = null; }, 0);
    });
    document.body.appendChild(el);
    viewerPaint();
  }
  function watchPictures() {
    window.addEventListener('click', function (ev) {
      if (disabled() || viewer) return;
      if (ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
      var path = ev.composedPath ? ev.composedPath() : [];
      var img = path[0];
      if (!img || img.tagName !== 'IMG') return;
      var inRow = false, linked = false;
      for (var i = 0; i < path.length; i++) {
        var n = path[i];
        if (n.id && typeof n.id === 'string' && n.id.indexOf('message-') === 0) { inRow = true; break; }
        if (n.tagName === 'A' || n.tagName === 'BUTTON') linked = true;
      }
      if (!inRow || linked) return;
      var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      if (w < 32 || h < 32) return;
      ev.preventDefault();
      ev.stopPropagation();
      viewerOpen(img);
    }, true);
    window.addEventListener('keydown', function (ev) {
      if (!viewer) return;
      var k = ev.key, used = true;
      if (k === 'Escape') viewerClose();
      else if (k === 'ArrowLeft' || k === 'PageUp') viewerGo(-1);
      else if (k === 'ArrowRight' || k === 'PageDown') viewerGo(1);
      else if (k === '+' || k === '=') viewerZoom(1.25);
      else if (k === '-' || k === '_') viewerZoom(0.8);
      else if (k === '0') { viewer.scale = 1; viewer.x = 0; viewer.y = 0; viewerPaint(); }
      else used = false;
      if (used) { ev.preventDefault(); ev.stopPropagation(); }
    }, true);
    window.addEventListener('hashchange', viewerClose);
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
    // The agent's own state, read from the backend every 3 s for the chats on screen (the owner,
    // 2026-09-24: AionUi's own "processing" marker can vanish while the agent is still
    // printing). A green dot while the agent works, a red dot while it is paused or blocked.
    // The dot is the signal that always shows: the developer's Windows has animations switched off, which
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
    // "+ Add account" (R-119): the dialog, and the row while an added account is picked (AionUi's own Claude pill underneath looks unpicked)
    '.aiondx-accdlg{width:min(540px,92vw);padding:20px 24px 0!important}',
    '.aiondx-accdlg-h{margin:0 0 14px;font-size:17px;font-weight:600;color:var(--color-text-1)}',
    '.aiondx-accdlg-row{display:flex;flex-direction:column;gap:4px;margin:0 0 6px}',
    '.aiondx-accdlg-lab{display:block;margin:10px 0 3px;font-size:13px;font-weight:600;color:var(--color-text-1)}',
    '.aiondx-accdlg-row .aiondx-accdlg-lab{margin-top:0}',
    '.aiondx-accdlg-opt{display:flex;gap:8px;align-items:flex-start;margin:3px 0;font-size:13px;line-height:1.4;color:var(--color-text-2);cursor:pointer}',
    '.aiondx-accdlg-opt b{color:var(--color-text-1)}',
    '.aiondx-accdlg-inline{display:flex;gap:16px;align-items:center;font-size:13px;color:var(--color-text-2)}',
    '.aiondx-accdlg-check{display:flex;gap:8px;align-items:center;margin:8px 0 0;font-size:13px;color:var(--color-text-2);cursor:pointer}',
    '.aiondx-accdlg-hint{font-size:12px;color:var(--color-text-3)}',
    '.aiondx-accdlg-p{font-size:13px;line-height:1.5;color:var(--color-text-2);margin:0 0 10px}',
    '.aiondx-accdlg-list{margin:0 0 12px;padding-left:18px;font-size:13px;line-height:1.55;color:var(--color-text-2)}',
    '.aiondx-accdlg-err{min-height:16px;margin-top:8px;font-size:12.5px;color:rgb(var(--danger-6))}',
    '.aiondx-accdlg-btns{position:sticky;bottom:0;display:flex;justify-content:flex-end;gap:8px;margin-top:12px;padding:12px 0 16px;background:inherit;border-top:1px solid var(--color-border-1,rgba(0,0,0,.08))}',
    '.aiondx-acc-pending [data-testid^="preset-pill-"][data-assistant-selected="true"]{background:transparent!important;box-shadow:none!important;opacity:.75}',
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
    // "Sign in to your agents"
    '.aiondx-acc-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;margin:14px 0 0;padding:10px 12px;border:1px solid var(--color-border-2);border-radius:8px}',
    '.aiondx-acc-name{font-weight:600;color:var(--color-text-1)}',
    '.aiondx-acc-state{flex:1;min-width:160px;font-size:13px;color:var(--color-text-2)}',
    '.aiondx-acc-actions{display:flex;gap:8px}',
    '.aiondx-acc-flow{margin:10px 0 0;font-size:13px;color:var(--color-text-1)}',
    '.aiondx-acc-flow .aiondx-signin-row{margin-top:8px}',
    '.aiondx-acc-code{flex:1;min-width:0;height:28px;padding:0 8px}',
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
    '.aiondx-plugins-backdrop[hidden],.aiondx-cache-backdrop[hidden]{display:none !important}',
    '.aiondx-cache{position:relative;width:min(720px,94vw)}',
    '.aiondx-cache-age{display:flex;align-items:center;gap:8px;margin:6px 0 4px;font-size:13px;color:var(--color-text-2)}',
    '.aiondx-cache-days{height:28px;padding:0 8px;border:1px solid var(--color-border-2);border-radius:6px;background:var(--color-bg-2);color:var(--color-text-1)}',
    '.aiondx-cache-list{display:flex;flex-direction:column;gap:8px;margin-top:6px;max-height:50vh;overflow-y:auto;padding-right:4px}',
    '.aiondx-cache-row{padding:10px 12px;border:1px solid var(--color-border-2);border-radius:8px}',
    '.aiondx-cache-name{font-size:14px;font-weight:600;color:var(--color-text-1)}',
    '.aiondx-cache-dir{font-size:12px;color:var(--color-text-3);overflow-wrap:anywhere}',
    '.aiondx-cache-body{margin-top:6px;font-size:13px;color:var(--color-text-2)}',
    '.aiondx-cache-line{display:flex;align-items:center;gap:10px;padding:4px 0}',
    '.aiondx-cache-line-label{flex:0 0 64px;color:var(--color-text-1)}',
    '.aiondx-cache-line-info{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}',
    '.aiondx-cache-line-act{flex:0 0 auto;display:flex;gap:6px}',
    '.aiondx-cache-confirm{color:rgb(var(--danger-6))}',
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
    '.aiondx-usage[data-no5h="1"] .aiondx-usage-bar[data-w="5h"]{display:none}',   // a plan with no 5-hour window (Ultra): the week bar alone
    '.aiondx-usage[data-limit="reached"] .aiondx-usage-text{color:rgb(var(--danger-6))}',
    '.aiondx-usage[data-narrow="1"] .aiondx-usage-text{display:none}',
    '.aiondx-usage[data-stale="1"]{opacity:.55}',
    '.aiondx-usage--compact{margin-inline-end:4px}',
    '.aiondx-usage{cursor:pointer}',
    '.aiondx-uspanel{position:fixed;inset:0;z-index:10070;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.4)}',
    '.aiondx-uspanel-box{width:min(560px,92vw);max-height:88vh;overflow:auto;padding:16px 18px;border-radius:10px;background:var(--color-bg-2);color:var(--color-text-1);',
    '  box-shadow:0 10px 40px rgba(0,0,0,.35);font-size:13px;line-height:20px}',
    '.aiondx-uspanel-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;font-size:15px}',
    '.aiondx-uspanel button{border:1px solid var(--color-border-2);border-radius:6px;background:var(--color-fill-2);color:var(--color-text-1);cursor:pointer;padding:2px 10px}',
    '.aiondx-uspanel button:hover{background:var(--color-fill-3)}',
    '.aiondx-uspanel select,.aiondx-uspanel input[type=number]{border:1px solid var(--color-border-2);border-radius:6px;background:var(--color-bg-1);color:var(--color-text-1);padding:2px 6px}',
    '.aiondx-uspanel input[type=number]{width:64px}',
    '.aiondx-uspanel-now{padding:6px 8px;margin-bottom:10px;border-radius:6px;background:var(--color-fill-2);color:var(--color-text-2)}',
    '.aiondx-uspanel-sec{display:flex;flex-direction:column;gap:8px;padding:10px 0;border-top:1px solid var(--color-border-2)}',
    '.aiondx-uspanel-sec label{display:block}',
    '.aiondx-uspanel-rule{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:3px 0}',
    '.aiondx-uspanel-none,.aiondx-uspanel-note{color:var(--color-text-3);font-size:12px}',
    '.aiondx-uspanel-add{display:flex;flex-wrap:wrap;align-items:center;gap:6px}',
    '.aiondx-uspanel code{padding:0 4px;border-radius:4px;background:var(--color-fill-2)}',
    // The picture viewer.
    '.aiondx-viewer{position:fixed;inset:0;z-index:10080;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.86);color:#fff}',
    '.aiondx-viewer-bar{position:absolute;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 16px;',
    '  background:linear-gradient(rgba(0,0,0,.55),transparent);font-size:13px;z-index:2}',
    '.aiondx-viewer-count{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
    '.aiondx-viewer-tools{display:inline-flex;align-items:center;gap:6px;flex:0 0 auto}',
    '.aiondx-viewer-zoom{min-width:44px;text-align:center;font-size:12px;opacity:.85}',
    '.aiondx-viewer button{border:0;border-radius:6px;background:rgba(255,255,255,.14);color:#fff;cursor:pointer;min-width:30px;height:30px;padding:0 8px;font-size:15px;line-height:30px}',
    '.aiondx-viewer button:hover:not(:disabled){background:rgba(255,255,255,.28)}',
    '.aiondx-viewer button:disabled{opacity:.3;cursor:default}',
    '.aiondx-viewer-nav{position:absolute;top:50%;transform:translateY(-50%);width:44px;height:64px;font-size:34px !important;line-height:60px !important;z-index:2}',
    '.aiondx-viewer-prev{left:14px}',
    '.aiondx-viewer-next{right:14px}',
    '.aiondx-viewer-stage{position:absolute;inset:48px 76px 24px;display:flex;align-items:center;justify-content:center;overflow:hidden}',
    '.aiondx-viewer-stage img{max-width:100%;max-height:100%;object-fit:contain;user-select:none;transition:transform .08s ease-out}',
    'body:has(.aiondx-viewer) .aiondx-toasts{z-index:10090}',
    '.aiondx-usage--compact .aiondx-usage-text{display:none}',
    '.aiondx-usage--compact .aiondx-usage-bars{width:36px}',
    // Respond now: a small tick box in each message box's top-right corner (inside the box's top padding),
    // and a bolt to the left of a message still waiting in the queue.
    '.sendbox-panel:has(> .aiondx-rn){padding-top:24px !important}',
    // AionUi's own "Interrupt & send" (team members, while one works and you have typed): the same interrupt as Respond
    // now, as a wide button between the permission shield and the context meter (a request of 2026-09-26). Found by its
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
    '.aiondx-opts{margin-top:14px}',
    '.aiondx-opt-group{margin:10px 0 4px;font-size:12px;opacity:.7;text-transform:uppercase;letter-spacing:.04em}',
    '.aiondx-opt-row{display:flex;align-items:center;gap:10px;padding:4px 0}',
    '.aiondx-opt-label{flex:1;min-width:0;font-size:13px}',
    '.aiondx-opt-input{display:inline-flex;align-items:center;gap:6px}',
    '.aiondx-opt-number{width:84px}',
    '.aiondx-opt-unit{font-size:12px;opacity:.7}',
    '.aiondx-agent-cache{flex-shrink:0}',
    '.aiondx-acct-menu{max-height:70vh;overflow-y:auto}',
    '.aiondx-cache-row--focus{outline:2px solid rgba(var(--aiondx-accent-rgb,45,212,191),.8);outline-offset:3px;border-radius:10px}',
    // Unsend, inside a Claude chat's "Unread" badge; an unsent message struck through.
    '[data-testid="message-status-badge"] .aiondx-unsend{margin-inline-start:8px;padding:0;border:none;background:none;',
    '  font:inherit;font-size:12px;color:rgb(var(--danger-6));cursor:pointer;user-select:none}',
    '[data-testid="message-status-badge"] .aiondx-unsend:hover{text-decoration:underline}',
    '[data-testid="message-status-badge"] .aiondx-unsend[disabled]{color:var(--color-text-3);cursor:default;text-decoration:none}',
    // ...and under a bubble still waiting in a team member's queue, which has no Unread badge.
    '.aiondx-unsend-foot{margin-top:4px;font-size:12px;color:var(--color-text-3);user-select:none;text-align:end}',
    '.aiondx-unsend-foot .aiondx-unsend{margin-inline-start:8px;padding:0;border:none;background:none;font:inherit;font-size:12px;',
    '  color:rgb(var(--danger-6));cursor:pointer}',
    '.aiondx-unsend-foot .aiondx-unsend:hover{text-decoration:underline}',
    '.aiondx-edit{margin-inline-start:8px;padding:0;border:none;background:none;font:inherit;font-size:12px;color:rgb(var(--primary-6));cursor:pointer;user-select:none}',
    '.aiondx-edit:hover{text-decoration:underline}',
    '.aiondx-edit[disabled]{color:var(--color-text-3);cursor:default;text-decoration:none}',
    '.aiondx-unsend-foot .aiondx-unsend[disabled]{color:var(--color-text-3);cursor:default;text-decoration:none}',
    '[data-aiondx-unsent] .aiondx-unsend-foot{display:none}',
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
    '.aiondx-stop-wrap{display:inline-flex}',
    '.aiondx-stop{color:rgb(var(--danger-6))}',
    '.aiondx-stop-sq{display:block;width:12px;height:12px;margin:0 auto;border-radius:2px;background:currentColor}',
    '.aiondx-solo-bolt svg{width:14px;height:14px;display:block;margin:0 auto;color:rgb(var(--warning-6))}',
    '.context-usage-indicator{position:relative}',
    '.aiondx-ctx{cursor:pointer;display:flex;align-items:center;justify-content:center;width:32px;height:32px}',
    '.aiondx-snow{position:absolute;left:0;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;color:#7dd3fc;pointer-events:auto}',
    '.aiondx-snow svg{width:11px;height:11px;display:block}',
    '.aiondx-sched-wrap{position:relative}',
    '.aiondx-sched-count{position:absolute;top:-3px;right:-3px;min-width:14px;height:14px;padding:0 3px;border-radius:7px;background:rgb(var(--warning-6));',
    '  color:#111;font-size:10px;line-height:14px;text-align:center;pointer-events:none}',
    '.aiondx-sched-count:empty{display:none}',
    '.aiondx-sched-menu{width:340px}',
    '.aiondx-sched-menu .arco-dropdown-menu{max-height:min(460px,75vh);overflow-y:auto}',
    '.aiondx-sched-modes{display:flex;gap:4px;margin:2px 12px 8px;padding:2px;border-radius:6px;background:var(--color-fill-2)}',
    '.aiondx-sched-mode{flex:1 1 0;height:26px;padding:0 8px;border-radius:4px;color:var(--color-text-2);font-size:13px}',
    '.aiondx-sched-mode.aiondx-sched-mode-on{background:var(--color-bg-2);color:var(--color-text-1);font-weight:600}',
    '.aiondx-sched-pane{display:flex;align-items:center;gap:8px;padding:0 12px 6px}',
    '.aiondx-sched-field{flex:1 1 0;min-width:0;display:flex;align-items:center;gap:4px;font-size:12px;color:var(--color-text-2)}',
    '.aiondx-sched-field input,.aiondx-sched-date,.aiondx-sched-time{min-width:0;height:28px;padding:0 6px;border:1px solid var(--color-border-2);border-radius:4px;background:var(--color-bg-2);color:var(--color-text-1)}',
    '.aiondx-sched-field input{width:100%}',
    '.aiondx-sched-date{flex:1 1 auto}',
    '.aiondx-sched-time{flex:0 0 112px}',
    '.aiondx-sched-custom{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 12px}',
    '.aiondx-sched-preview{min-width:0;font-size:12px;color:var(--color-text-2)}',
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
    // groups in the sidebar
    '[data-aiondx-grouped="1"]{display:none !important}',
    // while AionUi's menu is open for a hidden row, the row is back where the pointer is, out of sight
    // AionUi caps a menu at 200 px and scrolls the rest: one with AionDX's lines grows to fit them (they were below the fold)
    '.arco-dropdown-menu:has(> .arco-dropdown-menu-inner > .aiondx-gitem){max-height:none !important;overflow:visible !important}',
    '.aiondx-xsep{height:1px;margin:4px 8px;background:var(--color-border-2)}',
    '.aiondx-xitem--danger .aiondx-gitem-text{color:rgb(var(--danger-6))}',
    '.aiondx-xitem--armed{background:rgba(var(--danger-6),.12) !important}',
    '.aiondx-xitem--armed .aiondx-gitem-text{color:rgb(var(--danger-6));font-weight:600}',
    '.aiondx-gitem .aiondx-gitem-text::after{content:"\\25B8";margin-inline-start:8px;color:var(--color-text-3)}',
    '.aiondx-gitem--open .aiondx-gitem-text::after{content:"\\25BE"}',
    '.aiondx-gsub > div{padding-inline-start:22px}',
    '.aiondx-gcheck .i-icon{color:var(--aiondx-accent,#2dd4bf)}',
    '.aiondx-chatmenu-btn{display:inline-flex !important;align-items:center;justify-content:center;width:28px;height:28px;color:var(--color-text-2)}',
    '.aiondx-chatmenu-btn:hover{color:var(--color-text-1)}',
    // the Teams list, kept on the page while grouped teams need their rows, looks collapsed when you closed it
    '.aiondx-tvc > div.relative.group{display:none !important}',
    '.aiondx-tvc [data-testid="team-section-toggle"] .i-icon-right{transform:none !important}',
    '.aiondx-groups{padding-bottom:12px}',
    '.aiondx-gline{height:1px;margin:10px 10px 2px;background:var(--color-border-2)}',
    '.aiondx-gdrop-before{box-shadow:inset 0 2px 0 var(--aiondx-accent,#2dd4bf)}',
    '.aiondx-gdrop-after{box-shadow:inset 0 -2px 0 var(--aiondx-accent,#2dd4bf)}',
    '.aiondx-gdrop-gbefore{box-shadow:inset 0 2px 0 var(--aiondx-accent,#2dd4bf)}',
    '.aiondx-gdrop-gafter{box-shadow:inset 0 -2px 0 var(--aiondx-accent,#2dd4bf)}',
    '.aiondx-gdrop-sec{background:var(--color-fill-2);border-radius:8px}',
    '.aiondx-gdrop-new{background:var(--color-fill-3);color:var(--color-text-1)}',
    '.aiondx-gdrop-out{box-shadow:inset 0 0 0 1px var(--aiondx-accent,#2dd4bf);border-radius:8px}',
    'body.aiondx-dragging .aiondx-grow,body.aiondx-dragging .aiondx-ghead{cursor:grabbing}',
    '.aiondx-ghead{position:relative}',
    '.aiondx-gchev{display:inline-flex;align-items:center;margin-inline-end:4px;color:var(--color-text-3);transition:transform .15s}',
    '.aiondx-gchev--open{transform:rotate(90deg)}',
    '.aiondx-gtitle{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.aiondx-ghead:hover .aiondx-gtitle{color:var(--color-text-1)}',
    '.aiondx-gcount{margin-inline-start:6px;font-size:12px;color:var(--color-text-4)}',
    '.aiondx-gmore{display:none;align-items:center;justify-content:center;width:20px;height:20px;border-radius:4px;color:var(--color-text-3);flex:none;margin-inline-start:auto}',
    '.aiondx-gmore:hover{background:var(--color-fill-4);color:var(--color-text-1)}',
    '.aiondx-ghead:hover .aiondx-gmore,.aiondx-grow:hover .aiondx-gmore{display:inline-flex}',
    '.aiondx-ghead:hover .aiondx-gcount{display:none}',
    '.aiondx-gname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.aiondx-gempty{padding:4px 12px 4px 34px;font-size:12px;color:var(--color-text-4)}',
    '.aiondx-gnew{font-size:14px;font-weight:500;color:var(--color-text-3)}',
    '.aiondx-gnew:hover{color:var(--color-text-2)}',
    '.aiondx-gmenu{position:fixed;z-index:10070;min-width:180px;max-width:360px;max-height:none !important;overflow:visible !important}',
    '.aiondx-gdlg{position:fixed;inset:0;z-index:10080;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)}',
    '.aiondx-gdlg-card{width:340px;max-width:calc(100vw - 32px);padding:18px 18px 14px;border-radius:12px;border:1px solid var(--color-border-2);',
    '  background:var(--color-bg-popup);color:var(--color-text-1);box-shadow:0 12px 40px rgba(0,0,0,.4)}',
    '.aiondx-gdlg-title{font-size:15px;font-weight:600;margin-bottom:12px}',
    '.aiondx-gdlg-input{width:100%;box-sizing:border-box;height:34px;padding:0 10px;border-radius:8px;border:1px solid var(--color-border-3);background:var(--color-fill-2);color:var(--color-text-1);font-size:14px;outline:none}',
    '.aiondx-gdlg-input:focus{border-color:var(--aiondx-accent,#2dd4bf)}',
    '.aiondx-gdlg-err{min-height:18px;margin-top:6px;font-size:12px;color:rgb(var(--danger-6))}',
    '.aiondx-gdlg-btns{display:flex;justify-content:flex-end;gap:8px;margin-top:6px}',
    '.aiondx-gdlg-btns button{height:30px;padding:0 14px;border-radius:8px;border:1px solid var(--color-border-3);background:transparent;color:var(--color-text-1);font-size:13px;cursor:pointer}',
    '.aiondx-gdlg-btns .aiondx-gdlg-ok{background:var(--aiondx-accent,#2dd4bf);border-color:transparent;color:#04201c;font-weight:600}',
    '.aiondx-gguid-btn{display:inline-flex !important;align-items:center;gap:6px;margin-inline-start:12px}',
    '.aiondx-gguid-ic,.aiondx-gguid-chev{display:inline-flex;align-items:center}',
    '.aiondx-gguid-chev{transform:rotate(90deg);opacity:.7}',
    '.aiondx-mcp-switch{margin-left:4px;flex:none}',
    '@keyframes aiondx-spin{to{transform:rotate(360deg)}}',
    '@media (prefers-reduced-motion:no-preference){.aiondx-loop--busy .aiondx-loop-icon svg{animation:aiondx-spin 1.6s linear infinite}}',

    // The Permission pill, shrunk to its shield (a request of 2026-09-24).
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
    var left = warmAtOf(s) - Date.now();
    return left > 0 ? Math.min(1, left / ttlOf(s)) : 0;
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
    var until = coldAtOf(s);
    var now = Date.now();
    var how = s.cacheMeasured ? 'measured' : 'not measured, counted at ' + Math.round(ttlOf(s) / 60000) + ' min';
    if (until <= now) return 'Cache: ran out at ' + hhmm(until) + ' (' + how + ').';
    var tail = warmAtOf(s);
    var part = tail < until ? (tail > now ? ' The newest part, kept ' + Math.round(ttlOf(s) / 60000) + ' min, runs out at ' + hhmm(tail) + '.'
      : ' The newest part, kept ' + Math.round(ttlOf(s) / 60000) + ' min, ran out at ' + hhmm(tail) + '.') : '';
    return 'Cache: warm until ' + hhmm(until) + ' (' + Math.max(1, Math.round((until - now) / 60000)) + ' min, ' + how + ').' + part +
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
  // Why a message box has no Loop button (a request of 2026-09-26, a team: "Loop buttons gone", not reproduced in the
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
    if (!every('diag', 4000)) return;   // it asks for layout (getClientRects), which a big page pays for in full each time; it only records a fault
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
    var big = bigPage();
    Object.keys(pills).forEach(function (k) {
      if (live[k]) return;
      var el = pills[k].el;
      if (el.parentNode) el.parentNode.removeChild(el);
      delete pills[k];
      if (menuKey === k) closeMenu();
      if (tipKey === k) hideTip();
    });
    [labelPermissionButtons, paintContextRings, renderSched, reconcileSpinners, ensureAccentPicker, focusColour, renderAccounts, renderUnsend, renderRespondNow, hideDriftNotices, tagBubbles, renderMcpSwitches, markHeldStart, labelModels, holdTitle, applySpellcheck, renderAgentCacheButtons, renderGroups, renderGuidGroup, paintCostCard, renderChatMenuButton, renderBell, renderAccountPills, renderDxPanel].forEach(function (step, idx) {
      // On a page with a long message list each step is a sweep of the page: all but the context ring run at most every 400 ms there.
      if (big && idx !== 1 && !every('step' + idx, 400)) return;
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

    // No compaction item (a request of 2026-10-01).
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
    // A message an agent changed while the menu is open, unless the owner is typing in it.
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
    if (!every('drift', 1000)) return;   // a sweep of every message row: once a second is plenty for a notice at the start of a chat
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

  // a request of 2026-10-14 ("the ui is lagging so brutally bad for some conversations or teams"). render() runs on every change of the page, and
  // a streaming reply changes it many times a second. On a chat with thousands of rows its sweeps of the whole page cost tens of milliseconds each
  // (measured in the test harness at 3,000 rows: about 40% of the page's time while a reply streamed). So:
  //   - the whole-page sweeps (drift notices, sidebar spinners, the diagnosis) each run at most once per interval, and the 1-second timer below
  //     catches up on what a skipped run missed;
  //   - where one render has just taken more than 8 ms, on a page with over 400 messages the next waits eight times as long (at most 0.75 s), so a heavy page is repainted a few times
  //     a second, not on every frame. A page where render takes under 8 ms is repainted on the next frame as before.
  // window.__aionDx.repaint() (tests, debugging) runs everything at once.
  var sweepAt = {}, sweepWait = {};
  function every(name, ms) {
    var now = Date.now();
    if (sweepAt[name] && now - sweepAt[name] < ms) {
      // Skipped: one repaint is booked for when the interval is up, so a change that arrived in between (a spinner's verdict) is not left until the 15-second timer.
      if (!sweepWait[name]) sweepWait[name] = setTimeout(function () { sweepWait[name] = 0; schedule(); }, ms - (now - sweepAt[name]) + 20);
      return false;
    }
    sweepAt[name] = now;
    return true;
  }
  /** A page with a long message list (AionUi's list has one child per message; a team has one list per member). A settings change or a click on a small page is never slowed. */
  var bigAt = 0, bigVal = false;
  function bigPage() {
    var now = Date.now();
    if (now - bigAt < 1000) return bigVal;   // the answer is asked for many times a second and a sweep of a big page is not free
    bigAt = now;
    var ls = document.querySelectorAll('[data-testid="message-list-content"]');
    var n = 0;
    for (var i = 0; i < ls.length; i++) n += ls[i].childElementCount;
    bigVal = n > opt('lag.bigPage');
    return bigVal;
  }
  var scheduled = false, lastRenderMs = 0, lastRenderAt = 0;
  function timedRender() {
    var t0 = performance.now();
    render();
    lastRenderMs = performance.now() - t0;
    lastRenderAt = Date.now();
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    var wait = lastRenderMs > 8 && bigPage() ? Math.min(750, lastRenderMs * 8) - (Date.now() - lastRenderAt) : 0;
    if (wait > 0) setTimeout(function () { scheduled = false; timedRender(); }, wait);
    else requestAnimationFrame(function () { scheduled = false; timedRender(); });
  }

  function ours(node) {
    if (!node) return false;
    if (node.nodeType === 1 && node.closest && node.closest('.aiondx-groups, .aiondx-gmenu, .aiondx-gdlg, .aiondx-gguid-btn, .aiondx-chatmenu')) return true;
    if (node.nodeType === 1 && node.classList && (node.classList.contains('aiondx-gitem') || node.classList.contains('aiondx-gsub') || node.classList.contains('aiondx-xitem') || node.classList.contains('aiondx-xsep') || node.classList.contains('aiondx-cost-line'))) return true;
    if (menu && (node === menu || menu.contains(node))) return true;
    if (tip && (node === tip || tip.contains(node))) return true;
    if (toastBox && (node === toastBox || toastBox.contains(node))) return true;
    if (signinBox && (node === signinBox || signinBox.contains(node))) return true;
    if (pickerEl && (node === pickerEl || pickerEl.contains(node))) return true;
    if (acctMenu && (node === acctMenu || acctMenu.contains(node))) return true;
    if (schedMenu && (node === schedMenu || schedMenu.contains(node))) return true;
    if (welcome.el && (node === welcome.el || welcome.el.contains(node))) return true;
    if (colourMenu && (node === colourMenu || colourMenu.contains(node))) return true;
    if (node.classList && (node.classList.contains('aiondx-unsend') || node.classList.contains('aiondx-unsend-foot') || node.classList.contains('aiondx-edit') || node.classList.contains('aiondx-rn') || node.classList.contains('aiondx-rn-bolt') ||
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

  // a request of 2026-09-24 So the
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
      renderSched();   // also places the fallback Stop (paintStop), which waits on this state
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

  // a request of 2026-10-01.
  // A round button beside AionUi's draft button holds what is typed in the box and sends it later: in a number of days, hours and
  // minutes typed by hand, or at a date and time picked (since 2026-10-13; before it, four fixed times). Each is a record in the settings store (aiondx.sched.<id> = { id,
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
  var schedMode = 'in';     // which way of saying when the menu shows: 'in' (days, hours, minutes) or 'at' (date and time)
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
      // 2026-10-31: opening AionDX never starts an agent. A message that came due more than SCHED_LATE_MS ago (AionDX was closed,
      // or the PC was asleep) is not sent; it waits in the menu as failed, and Try again sends it.
      if (Date.now() - rec.due > SCHED_LATE_MS) { schedFail(rec, 'it was due at ' + hhmm(rec.due) + ' and AionDX was not running, so it was not sent'); return; }
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
  // ---------------------------------------------------------------- a Stop that is there when AionUi's is not (2026-10-13)

  // a request of 2026-10-13: "some agents just keep going when the UI gives me no stop command, or clicking it does nothing (then it
  // disappears)". AionUi draws its Stop from its own idea of the turn (the stream it has seen), so a turn it missed (one a Loop nudge,
  // a scheduled or queued message started, or one begun while the page was reconnecting) runs with no Stop on screen, and a press during
  // a turn change can send nothing. AionDX already asks every 3 seconds whether each chat is working (agentLive). A solo chat that has
  // been working for 3 seconds with no Stop button of AionUi's gets one of AionDX's, which cancels with the turn id the server gives.
  // A chat still working after a Stop has its agent ended and started again by deadHalt. Team members are covered since 2026-10-31.
  var STOP_OVERRIDE = null;   // tests: { show, force } in ms; otherwise the options stop.show and stop.force
  var stopEls = {};      // target key -> the fallback button
  var stopSeen = {};     // target key -> since when it has worked with no Stop of AionUi's on screen
  function paintStop(t, wrap) {
    var now = Date.now();
    var a = agentLive[t.key];
    var working = !!a && a.state === 'working';
    var native = !!(t.actions && t.actions.querySelector('.sendbox-stop-button'));
    // A team member gets the plain Stop too (2026-10-31): AionUi's own Stop for a member does nothing when no team run is active
    // (a turn a scheduled task or a retry started), and it left the member's queue to start the next turn.
    var plain = true;
    if (plain && working && !native) { if (!stopSeen[t.key]) stopSeen[t.key] = now; } else delete stopSeen[t.key];
    // No Force stop button any more (2026-11-10): every Stop is watched and the agent ended and started again by itself after stop.force
    // seconds (deadHalt). The button turned to Force stop at that same moment, so a press restarted an agent deadHalt had just restarted.
    var show = working && plain && !!stopSeen[t.key] && now - stopSeen[t.key] >= stopShowMs();
    var el = stopEls[t.key];
    if (!show) { if (el && el.parentNode) el.parentNode.removeChild(el); return; }
    if (!el) {
      el = document.createElement('span');
      el.className = 'aiondx-stop-wrap';   // not the draft button's anchor class: renderSched finds its own anchor by that class and would shuffle the two
      el.innerHTML = '<button type="button" class="arco-btn arco-btn-secondary arco-btn-size-default arco-btn-shape-circle aiondx-stop" data-testid="aiondx-stop-btn"><span class="aiondx-stop-sq"></span></button>';
      el.firstChild.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); fallbackStop(el._t); });
      stopEls[t.key] = el;
    }
    el._t = t;
    if (!placedBefore(el, wrap)) wrap.parentNode.insertBefore(el, wrap);
    var btn = el.firstChild;
    var tip = 'Stop: AionUi shows no Stop button, but this chat is still working.';
    if (btn.title !== tip) { btn.title = tip; btn.setAttribute('aria-label', tip); }
  }
  async function fallbackStop(t) {
    if (!t.convId && t.kind === 'conv') return;
    // As AionUi's own Stop: the Loop goes off and the draft box does not send its next message.
    if (stopEls[t.key]) holdDraftBox(stopEls[t.key], t);
    var r = await hardStop(t);
    deadHalt(t, t.convId).catch(function () {});
    toast(r.ok ? 'Stop sent.' : r.nothing ? 'Nothing is running in this chat.' : 'Stop could not be sent yet.', r.ok ? 'It is watched until it stops; if it does not, the agent is ended and started again.' : r.nothing ? '' : r.why + '. It is watched and stopped until it is idle.');
  }
  // A bolt for a solo chat (2026-11-01). Team members have one (AionUi's Interrupt & send, and the bolt beside a waiting message); a solo
  // chat had none, so a message you typed while its agent worked could only wait for the agent's next step. While a solo chat works
  // and its box holds a message, the bolt ends the turn and sends the message first, so the agent answers it now.
  var soloBoltEls = {};   // target key -> the bolt button
  function paintSoloBolt(t, wrap) {
    var a = agentLive[t.key];
    var box = t.kind === 'conv' ? draftBox(t) : null;
    var text = box ? String(box.value || '') : '';
    var show = t.kind === 'conv' && !!a && a.state === 'working' && !!text.trim() && !/^\s*\//.test(text);
    var el = soloBoltEls[t.key];
    if (!show) { if (el && el.parentNode) el.parentNode.removeChild(el); return; }
    if (!el) {
      el = document.createElement('span');
      el.className = 'aiondx-stop-wrap aiondx-solo-bolt-wrap';
      el.innerHTML = '<button type="button" class="arco-btn arco-btn-secondary arco-btn-size-default arco-btn-shape-circle aiondx-solo-bolt" data-testid="aiondx-solo-bolt">' + ICON_BOLT + '</button>';
      el.firstChild.title = 'Interrupt and send: ends what the agent is doing and sends this message first.';
      el.firstChild.setAttribute('aria-label', el.firstChild.title);
      onPress(el.firstChild, function () { interruptAndSendSolo(el._t); });
      soloBoltEls[t.key] = el;
    }
    el._t = t;
    if (!placedBefore(el, wrap)) wrap.parentNode.insertBefore(el, wrap);
  }
  var soloBoltBusy = {};
  async function interruptAndSendSolo(t) {
    var box = draftBox(t);
    var text = box ? String(box.value || '') : '';
    if (!text.trim()) { toast('Type the message first: the bolt stops the agent and sends what is in the box.', ''); return; }
    if (soloBoltBusy[t.key]) return;
    soloBoltBusy[t.key] = true;
    toast('Interrupting the agent to send your message…', '"' + quoteOf(text) + '"');
    try { await interruptAndSendSoloNow(t, box, text); } finally { delete soloBoltBusy[t.key]; }
  }
  async function interruptAndSendSoloNow(t, box, text) {
    var convId = t.convId;
    setComposerValue(box, '');
    var back = function (why) { setComposerValue(box, text); toast(why, 'Your message is back in the box.'); };
    var g = await getJson('/api/conversations/' + convId);
    var turn = g.data && g.data.runtime && convBusy(g.data) ? g.data.runtime.turn_id : null;
    if (turn) {
      var c = await postJson('/api/conversations/' + convId + '/cancel', { turn_id: turn });
      if (!c || !c.ok) { back('Could not interrupt the agent (HTTP ' + (c && c.status) + ').'); return; }
      // The turn ends within a moment; the message goes as soon as the chat is free (10 seconds at most).
      for (var i = 0; i < 20; i++) {
        await new Promise(function (r) { setTimeout(r, 500); });
        var s = await getJson('/api/conversations/' + convId);
        if (!(s.data && convBusy(s.data))) break;
      }
    }
    userSent(box, text);
    var r = await postJson('/api/conversations/' + convId + '/messages', { content: text });
    if (!r || !r.ok) { back('Could not send it (HTTP ' + (r && r.status) + ').'); return; }
    applyUserSent(t, text);
    toast('Interrupted, and your message was sent first.', '"' + quoteOf(text) + '"');
  }
  // The context meter is always there, and a snowflake in it says the prompt cache has gone cold (2026-11-01).
  // AionUi draws the ring only while its page holds a token count for the chat: after a restart, a switch of chats or a long
  // idle the count is gone and the ring is too. AionDX reads the chat's last known count and window (extra.last_token_usage and
  // last_context_limit, which AionCore keeps) and draws the ring itself whenever AionUi's is missing. A provider keeps a prompt
  // cache for a limited time after its last use (research: Research/2026-11-01_provider-prompt-cache-lifetimes.md); once that
  // has passed with the agent idle, the next turn pays to write the whole context again, and the ring carries a snowflake.
  // Measured only (2026-11-11, second build): the snowflake shows when the chat's measured record (cacheRecord) says its cache is gone,
  // and never from an estimate. Before, it counted a length per provider from the conversation's last change; Anthropic's length changed
  // under it (5 minutes to an hour on October 12th) and the field it counted from was the wrong one. A chat with no record (another
  // provider, or a Claude chat that ran without AionDX's launcher) shows no cache state.
  var ICON_SNOW = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M4.2 7l15.6 10M19.8 7 4.2 17M9 3.8l3 2.4 3-2.4M9 20.2l3-2.4 3 2.4"/></svg>';
  var ctxInfo = {}, ctxAsk = {}, ctxState = {}, ctxEls = {};
  function ctxProvider(d) {
    var e = (d && d.extra) || {};
    var b = String(e.backend || e.acp_backend || (d && d.type) || '').toLowerCase();
    if (/claude|anthropic/.test(b)) return 'claude';
    if (/codex|openai|gpt/.test(b)) return 'codex';
    if (/gemini|antigravity|agy/.test(b)) return 'gemini';
    return '';
  }
  function ctxSaved(convId) { try { var v = JSON.parse(localStorage.getItem('aiondx.ctx.' + convId)); return v && typeof v === 'object' ? v : null; } catch (e) { return null; } }
  function ctxRefresh(t) {
    var k = t.key, st = (agentLive[k] || {}).state || '';
    var changed = ctxState[k] !== st;
    ctxState[k] = st;
    if (!changed && ctxAsk[k] && Date.now() - ctxAsk[k] < 20000) return;
    ctxAsk[k] = Date.now();
    (async function () {
      var convId = t.convId;
      if (!convId && t.kind === 'team') { var m = await memberConversation(t); convId = m && m.convId; }
      if (!convId) return;
      var g = await getJson('/api/conversations/' + convId);
      var d = g && g.data;
      if (!d) { if (!ctxInfo[k]) { var sv = ctxSaved(convId); if (sv) { ctxInfo[k] = sv; renderSched(); } } return; }
      var old = ctxInfo[k] || ctxSaved(convId) || {};
      var e = d.extra || {};
      if (agentOf[convId] === undefined) agentOf[convId] = String(e.agent_id || '');
      var u = e.last_token_usage;
      var used = u && Number(u.total_tokens) > 0 ? Number(u.total_tokens) : (old.used || 0);
      var limit = Number(e.last_context_limit) > 0 ? Number(e.last_context_limit) : (old.limit || 0);
      // The count AionCore keeps for every chat that has run (acp_session runtime context_usage: { used, size }), served by
      // /api/conversations/{id}/usage with or without a live agent. extra.last_token_usage is never written by AionCore 0.2.2, so on its own
      // the ring stayed empty after a restart for every chat that had not spoken since (2026-11-02: teams opened without starting agents).
      try {
        var gu = await getJson('/api/conversations/' + convId + '/usage');
        var cu = gu && gu.data;
        if (cu && Number(cu.used) > 0) used = Number(cu.used);
        if (cu && Number(cu.size) > 0) limit = Number(cu.size);
        // the session cost (a request of 2026-11-09: solo chats show it as team members do)
        var cost = cu && cu.cost && Number(cu.cost.amount) > 0 ? { amount: Number(cu.cost.amount), currency: String(cu.cost.currency || 'USD') } : null;
      } catch (er) {}
      // busy: this chat's own conversation has a turn in flight. The cache state reads this, not the team's run-state, which can disagree
      // with the conversation (2026-11-11: a team lead idle for 22 minutes showed no cache state at all).
      var busy = convBusy(d);
      var info = { used: used, limit: limit, updatedAt: Number(d.modified_at) || old.updatedAt || 0, provider: ctxProvider(d), cost: cost || old.cost || null, busy: busy, convId: convId };
      ctxInfo[k] = info;
      try { localStorage.setItem('aiondx.ctx.' + convId, JSON.stringify(info)); } catch (er) {}
      renderSched();
    })().catch(function () {});
  }
  /** { since, at, minutes } when this chat's measured prompt cache has run out with the agent idle; null otherwise. */
  function ctxCold(t, info) {
    var c = ctxCache(t, info);
    return c && !c.warm ? { since: c.until, at: c.at, minutes: c.span } : null;
  }
  /** This chat's prompt cache from its measured record: { warm, until, at, minutes, rebuilt } (until: when it runs out or ran out); null
   *  while a turn runs or when there is no record. */
  function ctxCache(t, info) {
    if (info.busy) return null;
    var r = cacheRecord(info.convId);
    if (!r) return null;
    var until = Number(r.until), tail = tailOf(r);
    return { warm: Date.now() < until, until: until, tail: tail, at: Number(r.at), minutes: Math.round(ttlMsOf(r) / 60000),
      span: Math.max(1, Math.round((until - Number(r.at)) / 60000)), rebuilt: r.rebuilt || null };
  }
  function spanText(minutes) { return minutes >= 60 && minutes % 60 === 0 ? (minutes / 60) + ' hour' + (minutes > 60 ? 's' : '') : minutes + ' minutes'; }
  /** The hover line (plain words, 2026-11-13): "Cache good until 09:12 (saved at the last reply, 08:12, for 1 hour). Messages before then
   *  reuse it, so they are cheaper and quicker." or "Cache expired at 09:12, 1 hour after the last reply (08:12). ...", and the last
   *  rebuild when there was one in the last day. */
  function promptCacheLine(c) {
    if (!c) return '';
    var line;
    if (c.warm && c.tail < c.until) {
      line = 'Cache good until ' + hhmm(c.until) + '. The last reply (' + hhmm(c.at) + ') saved most of the chat for 1 hour and its newest part for ' +
        spanText(c.minutes) + (Date.now() < c.tail ? ', until ' : ', which expired at ') + hhmm(c.tail) + '. Messages before ' + hhmm(c.until) +
        ' reuse what is saved, so they are cheaper and quicker.';
    } else if (c.warm) {
      line = 'Cache good until ' + hhmm(c.until) + ' (saved at the last reply, ' + hhmm(c.at) + ', for ' + spanText(c.span) + '). Messages before then reuse it, so they are cheaper and quicker.';
    } else {
      line = 'Cache expired at ' + hhmm(c.until) + ', ' + spanText(c.span) + ' after the last reply (' + hhmm(c.at) + '). Your next message resends the whole conversation, so it costs more and starts slower.';
    }
    var rb = c.rebuilt;
    if (rb && Number(rb.at) > Date.now() - 86400000) {
      line += '\nLast resent in full at ' + hhmm(Number(rb.at)) + (rb.afterMin !== null && rb.afterMin !== undefined ? ', ' + rb.afterMin + ' min after the reply before' : '') +
        ' (' + Math.round((Number(rb.tokens) || 0) / 1000) + 'K tokens' + (rb.early ? ', although the cache should still have been there' : '') + ').';
    }
    return line;
  }
  function ctxSnow(host, cold, reading) {
    var s = host.querySelector(':scope > .aiondx-snow');
    if (!cold) { if (s) s.parentNode.removeChild(s); return; }
    if (!s) { s = document.createElement('span'); s.className = 'aiondx-snow'; s.innerHTML = ICON_SNOW; host.appendChild(s); }
    // the snowflake takes the ring's hover, so it carries the ring's reading first, then the cache
    var tip = (reading ? reading + '\n' : '') + 'Cache expired at ' + hhmm(cold.since) + ', ' + spanText(cold.minutes) + ' after the last reply (' + hhmm(cold.at) +
      '). Your next message resends the whole conversation, so it costs more and starts slower.';
    if (s.title !== tip) s.title = tip;
  }
  function paintCtx(t, wrap) {
    ctxRefresh(t);
    var info = ctxInfo[t.key];
    var stock = t.actions && t.actions.querySelector('.context-usage-indicator:not(.aiondx-ctx)');
    var el = ctxEls[t.key];
    var cold = info ? ctxCold(t, info) : null;
    var cmp = compactView(info);
    if (stock && !cmp) {
      if (stock.getAttribute('data-aiondx-hidden')) { stock.style.display = ''; stock.removeAttribute('data-aiondx-hidden'); }
      if (el && el.parentNode) el.parentNode.removeChild(el); ctxSnow(stock, cold, info ? ctxReading(info, null) : ''); return;
    }
    if (stock && cmp && !stock.getAttribute('data-aiondx-hidden')) { stock.style.display = 'none'; stock.setAttribute('data-aiondx-hidden', '1'); }
    var send = t.actions && t.actions.querySelector('.sendbox-send-tooltip-anchor');
    if (!info || !send || !send.parentNode) { if (el && el.parentNode) el.parentNode.removeChild(el); return; }
    if (!el) {
      el = document.createElement('div');
      el.className = 'context-usage-indicator aiondx-ctx';
      el.setAttribute('data-testid', 'aiondx-ctx');
      el.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20" style="transform:rotate(-90deg)"><circle cx="10" cy="10" r="9" fill="none" stroke="var(--color-fill-3)" stroke-width="2"></circle>' +
        '<circle cx="10" cy="10" r="9" fill="none" stroke="rgb(var(--primary-6))" stroke-width="2" stroke-linecap="round"></circle></svg>';
      ctxEls[t.key] = el;
    }
    var circ = 2 * Math.PI * 9;
    var usedNow = cmp ? Number(cmp.tokens) : info.used;
    var pct = info.limit > 0 ? Math.max(0, Math.min(100, usedNow / info.limit * 100)) : 0;
    var arc = el.querySelectorAll('circle')[1];
    var dash = String(circ), off = String(circ - pct / 100 * circ);
    if (arc.getAttribute('stroke-dasharray') !== dash) arc.setAttribute('stroke-dasharray', dash);
    if (arc.getAttribute('stroke-dashoffset') !== off) arc.setAttribute('stroke-dashoffset', off);
    var disp = info.limit > 0 ? '' : 'none';
    if (arc.style.display !== disp) arc.style.display = disp;
    var reading = ctxReading(info, cmp);
    var tip = reading;
    var cl = promptCacheLine(ctxCache(t, info));
    if (cl) tip += '\n' + cl;
    if (el.title !== tip) el.title = tip;
    if (el.parentNode !== send.parentNode || el.nextSibling !== send) send.parentNode.insertBefore(el, send);
    ctxSnow(el, cold, reading);
  }
  /** The ring's reading: how full the chat is (or the estimate after a compaction), and the session's cost when known. */
  function ctxReading(info, cmp) {
    var usedNow = cmp ? Number(cmp.tokens) : info.used;
    var pct = info.limit > 0 ? Math.max(0, Math.min(100, usedNow / info.limit * 100)) : 0;
    return (cmp ? 'Compacted at ' + hhmm(Number(cmp.at)) + ': about ' + Math.round(usedNow / 1000) + 'K now' + (info.limit > 0 ? ' (' + pct.toFixed(1) + '% of ' + Math.round(info.limit / 1000) + 'K)' : '') +
        ', down from ' + Math.round(Number(cmp.pre) / 1000) + 'K. An estimate until the next reply measures it.'
      : info.limit > 0 ? pct.toFixed(1) + '% of the context window used (' + Math.round(info.used / 1000) + 'K of ' + Math.round(info.limit / 1000) + 'K)'
      : info.used > 0 ? Math.round(info.used / 1000) + 'K tokens used; the window size is not known' : 'No context count yet for this chat') +
      (info.cost ? '\nSession cost ≈ ' + costText(info.cost) : '');
  }
  function costText(c) {
    var a = Number(c && c.amount) || 0, cur = String((c && c.currency) || 'USD');
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: a >= 1 ? 2 : 4 }).format(a); } catch (e) { return cur + ' ' + a.toFixed(2); }
  }
  /** AionUi's own ring shows "Session cost" in its hover card only when its live usage carried one (a team member's does); a solo chat's
   *  ring is filled from a saved count with none. The card gets the cost AionCore keeps for the chat (a request of 2026-11-09). */
  function paintCostCard() {
    var cards = document.querySelectorAll('.context-usage-popover');
    if (!cards.length) return;
    var r = route();
    if (!r) return;
    // The cache line (2026-11-11), for the chat whose ring the card belongs to: the solo chat, or the team member whose ring is under the
    // pointer.
    var ct = null;
    var hovered = document.querySelector('.context-usage-indicator:hover');
    targets().forEach(function (x) { if (!ct && (r.kind === 'conv' || (hovered && x.actions && x.actions.contains(hovered)))) ct = x; });
    var ctInfo = ct ? ctxInfo[ct.key] : null;
    var line = ctInfo ? promptCacheLine(ctxCache(ct, ctInfo)) : '';
    for (var ci = 0; ci < cards.length; ci++) {
      var cin = cards[ci].querySelector('.p-8px') || cards[ci];
      var cl = cin.querySelector('.aiondx-cache-line');
      if (!line) { if (cl) cl.remove(); continue; }
      if (!cl) { cl = document.createElement('div'); cl.className = 'text-12px text-t-secondary mt-4px aiondx-cache-line'; cin.appendChild(cl); }
      if (cl.textContent !== line) cl.textContent = line;
    }
    if (r.kind !== 'conv') return;
    var info = ctxInfo['conv:' + r.id];
    for (var i = 0; i < cards.length; i++) {
      var inner = cards[i].querySelector('.p-8px') || cards[i];
      var mine = inner.querySelector('.aiondx-cost-line');
      var all = inner.textContent || '';
      if (mine) all = all.replace(mine.textContent || '', '');
      var cacheEl = inner.querySelector('.aiondx-cache-line');
      if (cacheEl) all = all.replace(cacheEl.textContent || '', '');
      if (/Session cost/.test(all)) { if (mine) mine.remove(); continue; }   // AionUi's own line is there (perhaps since ours went in)
      if (!info || !info.cost) { if (mine) mine.remove(); continue; }
      var text = 'Session cost ≈ ' + costText(info.cost);
      if (!mine) { mine = document.createElement('div'); mine.className = 'text-12px text-t-secondary mt-4px aiondx-cost-line'; inner.insertBefore(mine, inner.children[1] || null); }
      if (mine.textContent !== text) mine.textContent = text;
    }
  }
  /** A hard stop (2026-10-31): the Loop goes off; the conversation's turn is cancelled (AionCore then keeps scheduled tasks out of
   *  that conversation until you write to it again); and a team member is paused, so what it had queued does not start the next
   *  turn. Used by AionDX's Stop and, for team members, by every press of AionUi's own Stop button (a solo chat's own press has
   *  deadHalt). */
  async function hardStop(t) {
    if (state(t).on) { setOn(t, false, 'you pressed Stop', true); notify(t, 'Loop off for {who}: you pressed Stop.', ''); }
    var convId = t.convId;
    if (!convId && t.kind === 'team') { var m = await memberConversation(t); convId = m && m.convId; }
    if (!convId) return { ok: false, why: 'its conversation is not known' };
    var pause = t.kind === 'team'
      ? postJson('/api/teams/' + t.teamId + '/runs/stop/agents/' + encodeURIComponent(t.slotId) + '/pause', { reason: 'Stopped by the user.' }).catch(function () { return null; })
      : Promise.resolve(null);
    var g = await getJson('/api/conversations/' + convId);
    var turn = g.data && g.data.runtime && convBusy(g.data) ? g.data.runtime.turn_id : null;
    var r = turn ? await postJson('/api/conversations/' + convId + '/cancel', { turn_id: turn }) : null;
    var p = await pause;
    if (r && r.ok) return { ok: true };
    if (p && p.ok) return { ok: true };
    if (!turn) return { ok: false, nothing: true };
    return { ok: false, why: 'HTTP ' + (r && r.status) };
  }

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
      paintStop(t, wrap);
      paintSoloBolt(t, wrap);
      paintCtx(t, wrap);
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
    Object.keys(ctxEls).forEach(function (k) {
      if (live[k]) return;
      if (ctxEls[k].parentNode) ctxEls[k].parentNode.removeChild(ctxEls[k]);
      delete ctxEls[k];
    });
    Object.keys(soloBoltEls).forEach(function (k) {
      if (live[k]) return;
      if (soloBoltEls[k].parentNode) soloBoltEls[k].parentNode.removeChild(soloBoltEls[k]);
      delete soloBoltEls[k];
    });
    Object.keys(stopEls).forEach(function (k) {
      if (live[k]) return;
      if (stopEls[k].parentNode) stopEls[k].parentNode.removeChild(stopEls[k]);
      delete stopEls[k];
      delete stopSeen[k];
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
    // A request of 2026-10-13: the fixed times (15 minutes, 1 hour, 3 hours, tomorrow 9:00) were not enough. Two ways to say when:
    // "In" a number of days, hours and minutes typed by hand, or "At" a date (today at first) and a time.
    m.innerHTML = '<div class="arco-dropdown-menu"><div class="arco-dropdown-menu-group-title">Send this message later</div>' +
      '<div class="aiondx-sched-modes" role="tablist">' +
        '<button type="button" class="aiondx-bg-reset aiondx-sched-mode" data-mode="in" role="tab">In</button>' +
        '<button type="button" class="aiondx-bg-reset aiondx-sched-mode" data-mode="at" role="tab">At</button></div>' +
      '<div class="aiondx-sched-pane aiondx-sched-pane-in">' +
        '<label class="aiondx-sched-field"><input type="number" min="0" max="365" step="1" inputmode="numeric" class="aiondx-sched-days" aria-label="Days"><span>days</span></label>' +
        '<label class="aiondx-sched-field"><input type="number" min="0" max="999" step="1" inputmode="numeric" class="aiondx-sched-hours" aria-label="Hours"><span>hours</span></label>' +
        '<label class="aiondx-sched-field"><input type="number" min="0" max="9999" step="1" inputmode="numeric" class="aiondx-sched-mins" aria-label="Minutes"><span>minutes</span></label></div>' +
      '<div class="aiondx-sched-pane aiondx-sched-pane-at">' +
        '<input type="date" class="aiondx-sched-date" aria-label="Date"><input type="time" class="aiondx-sched-time" aria-label="Time"></div>' +
      '<div class="aiondx-sched-custom"><span class="aiondx-sched-preview"></span><button type="button" class="arco-btn arco-btn-primary arco-btn-size-small aiondx-sched-go">Schedule</button></div>' +
      '<div class="aiondx-note aiondx-sched-note"></div>' +
      '<div class="arco-dropdown-menu-group-title aiondx-sched-waiting-title">Waiting</div><div class="aiondx-sched-list"></div></div>';
    var now = Date.now();
    var days = m.querySelector('.aiondx-sched-days'), hours = m.querySelector('.aiondx-sched-hours'), mins = m.querySelector('.aiondx-sched-mins');
    var dateIn = m.querySelector('.aiondx-sched-date'), timeIn = m.querySelector('.aiondx-sched-time');
    var preview = m.querySelector('.aiondx-sched-preview');
    var go = m.querySelector('.aiondx-sched-go');
    days.value = '0'; hours.value = '0'; mins.value = '15';
    // The date starts as today; the time an hour on, to the next five minutes. When that falls after midnight the date follows it.
    var start = localInput(Math.ceil((now + 3600000) / 300000) * 300000).split('T');
    dateIn.value = start[0]; timeIn.value = start[1];
    dateIn.min = localInput(now).split('T')[0];
    /** The moment the box describes, or 0 when it is not complete. */
    function chosen() {
      if (schedMode === 'at') return dateIn.value && timeIn.value ? new Date(dateIn.value + 'T' + timeIn.value).getTime() || 0 : 0;
      var n = function (el) { var v = parseInt(el.value, 10); return v > 0 ? v : 0; };
      var total = n(days) * 86400000 + n(hours) * 3600000 + n(mins) * 60000;
      return total > 0 && total <= 366 * 86400000 ? Date.now() + total : 0;
    }
    function refreshPick() {
      m.querySelectorAll('.aiondx-sched-mode').forEach(function (b) {
        var on = b.getAttribute('data-mode') === schedMode;
        b.classList.toggle('aiondx-sched-mode-on', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      m.querySelector('.aiondx-sched-pane-in').style.display = schedMode === 'in' ? '' : 'none';
      m.querySelector('.aiondx-sched-pane-at').style.display = schedMode === 'at' ? '' : 'none';
      var ms = chosen();
      preview.textContent = ms ? 'Sends ' + whenText(ms) : (schedMode === 'in' ? 'Type how long to wait.' : 'Pick a date and time.');
      go.disabled = !has;
    }
    m.querySelectorAll('.aiondx-sched-mode').forEach(function (b) {
      b.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        schedMode = b.getAttribute('data-mode');
        refreshPick();
      });
    });
    [days, hours, mins, dateIn, timeIn].forEach(function (el) {
      el.addEventListener('input', refreshPick);
      el.addEventListener('change', refreshPick);
      el.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); go.click(); } });
    });
    go.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      var ms = chosen();
      if (!(ms > 0)) { toast(schedMode === 'in' ? 'Type how long to wait first.' : 'Pick a date and time first.'); return; }
      if (scheduleSend(t, ms)) closeSchedMenu();
    });
    refreshPick();
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

  // ---------------------------------------------------------------- groups in the sidebar (2026-11-02)

  // a request of 2026-11-02. Right-click a chat or a team and put it in a group; a group is a named heading in the sidebar under the teams and
  // conversations, with its chats and teams beneath it; the last line is "New Group +". A chat that is not in a group stays where AionUi puts it.
  // On the new-chat page a Group menu (None by default) puts the chat about to be made in a group. Groups live in the page (a pref in AionCore's
  // settings store, aiondx.groups, and localStorage), not in AionCore: AionUi's own Projects belong to folders and have a file explorer behind them.
  //
  //   aiondx.groups = { v: 1, at, groups: [{ id, name }], items: { "c:<conversation id>" | "t:<team id>": <group id> }, collapsed: { <group id>: true } }
  //
  // A grouped chat's row in AionUi's list is hidden (data-aiondx-grouped), not moved: React owns those rows. AionDX's row for it takes the icon
  // and name from the hidden one (the team icon for a team, the agent's logo for a chat), or from what it saw last when that row is not on the page
  // (the Teams list collapsed), checked against the backend so an archived or deleted chat leaves the group. Its right-click menu is AionUi's own
  // for a chat or a team, with one line more for the group (the same menu in a group and out of one). A chat or a team is dragged into a group,
  // out of it, and to any place in it; the order inside a group is the user's (aiondx.groups.order), by default the order they were added.
  var GROUPS_PREF = 'aiondx.groups';
  var groupsState = { v: 1, at: 0, groups: [], items: {}, order: [], collapsed: {} };   // order: every grouped key, in the order the user placed them
  var groupCache = {};         // item key -> { name, icon }: what a grouped item looked like when its sidebar row was last on the page
  var groupInfo = {};          // item key -> { at, gone, name }: the backend's word on an item whose row is not on the page
  var groupInfoAsk = {};
  var groupsSig = '', groupsEl = null, guidBtn = null, gMenu = null, gDlg = null;
  var guidGroup = null;        // the group picked on the new-chat page for the chat about to be made: { id, at }
  var menuFor = null;          // { key, at }: the sidebar chat whose menu AionUi has just opened
  var SVG_G_TEAM = '<svg width="16" height="16" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M19 20C22.866 20 26 16.866 26 13C26 9.134 22.866 6 19 6C15.134 6 12 9.134 12 13C12 16.866 15.134 20 19 20Z" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 40.8V42H34V40.8C34 36.32 34 34.08 33.13 32.37C32.36 30.86 31.14 29.64 29.63 28.87C27.92 28 25.68 28 21.2 28H16.8C12.32 28 10.08 28 8.37 28.87C6.86 29.64 5.64 30.86 4.87 32.37C4 34.08 4 36.32 4 40.8Z" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M32.6 7C34.64 8.22 36 10.45 36 13C36 15.55 34.64 17.78 32.6 19M44 42V40.8C44 36.32 44 34.08 43.13 32.37C42.36 30.86 41.14 29.64 39.63 28.87" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var SVG_G_CHAT = '<svg width="16" height="16" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M6 10H42V34H26L16 42V34H6V10Z" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var SVG_G_FOLDER = '<svg width="14" height="14" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M5 10H19L24 16H43V40H5V10Z" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var SVG_G_CHEV = '<svg width="12" height="12" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M19 12L31 24L19 36" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var SVG_G_MORE = '<svg width="14" height="14" viewBox="0 0 48 48" fill="none" aria-hidden="true"><circle cx="24" cy="12" r="3" fill="currentColor"/><circle cx="24" cy="24" r="3" fill="currentColor"/><circle cx="24" cy="35" r="3" fill="currentColor"/></svg>';

  function normGroups(j) {
    var s = { v: 1, at: Number(j && j.at) || 0, groups: [], items: {}, order: [], collapsed: {} };
    var ids = {};
    if (j && Array.isArray(j.groups)) j.groups.forEach(function (g) {
      if (g && g.id && g.name && !ids[String(g.id)]) { ids[String(g.id)] = 1; s.groups.push({ id: String(g.id), name: String(g.name).slice(0, 80) }); }
    });
    if (j && j.items && typeof j.items === 'object') Object.keys(j.items).forEach(function (k) { if (/^[ct]:./.test(k) && ids[j.items[k]]) s.items[k] = String(j.items[k]); });
    // the order the user placed them in; a record from before the order was kept (or an item missing from it) goes after, in the order it was added
    var seen = {};
    if (j && Array.isArray(j.order)) j.order.forEach(function (k) { if (s.items[k] && !seen[k]) { seen[k] = 1; s.order.push(k); } });
    Object.keys(s.items).forEach(function (k) { if (!seen[k]) { seen[k] = 1; s.order.push(k); } });
    if (j && j.collapsed && typeof j.collapsed === 'object') Object.keys(j.collapsed).forEach(function (k) { if (ids[k] && j.collapsed[k]) s.collapsed[k] = true; });
    return s;
  }
  function loadGroups() {
    try { var j = JSON.parse(localStorage.getItem(KEY_PREFIX + 'groups')); if (j && typeof j === 'object') groupsState = normGroups(j); } catch (e) {}
    try { var c = JSON.parse(localStorage.getItem(KEY_PREFIX + 'groups.cache')); if (c && typeof c === 'object') groupCache = c; } catch (e) {}
  }
  /** The shared copy (another window, or an agent's change) wins when it is newer than this page's own. */
  function takeGroups(data) {
    var v = data && data[GROUPS_PREF];
    if (!v || typeof v !== 'object' || (Number(v.at) || 0) <= groupsState.at) return;
    groupsState = normGroups(v);
    try { localStorage.setItem(KEY_PREFIX + 'groups', JSON.stringify(groupsState)); } catch (e) {}
    schedule();
  }
  function saveGroups() {
    groupsState.at = Date.now();
    try { localStorage.setItem(KEY_PREFIX + 'groups', JSON.stringify(groupsState)); } catch (e) {}
    var b = {};
    b[GROUPS_PREF] = groupsState;
    putPrefs(b);
    schedule();
  }
  function groupById(id) { for (var i = 0; i < groupsState.groups.length; i++) if (groupsState.groups[i].id === id) return groupsState.groups[i]; return null; }
  function groupByName(name) {
    var n = String(name).trim().toLowerCase();
    for (var i = 0; i < groupsState.groups.length; i++) if (groupsState.groups[i].name.toLowerCase() === n) return groupsState.groups[i];
    return null;
  }
  /** A new group; the group of that name when there already is one. */
  function createGroup(name) {
    name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!name) return null;
    var have = groupByName(name);
    if (have) return have.id;
    var id = 'g' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
    groupsState.groups.push({ id: id, name: name });
    saveGroups();
    return id;
  }
  function renameGroup(id, name) {
    var g = groupById(id);
    name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!g || !name) return;
    g.name = name;
    saveGroups();
  }
  function deleteGroup(id) {
    groupsState.groups = groupsState.groups.filter(function (g) { return g.id !== id; });
    Object.keys(groupsState.items).forEach(function (k) { if (groupsState.items[k] === id) delete groupsState.items[k]; });
    groupsState.order = groupsState.order.filter(function (k) { return !!groupsState.items[k]; });
    delete groupsState.collapsed[id];
    saveGroups();
  }
  /** Put an item in a group, or (gid null) back in AionUi's own lists. It goes to the end of the group's list. */
  function assignGroup(key, gid) { moveItem(key, gid, null, false); }
  /** Put an item in a group at the place the user chose: before refKey (or after it), or at the end when there is none. gid null takes it out. */
  function moveItem(key, gid, refKey, after) {
    delete groupsState.items[key];
    groupsState.order = groupsState.order.filter(function (k) { return k !== key; });
    if (gid && groupById(gid)) {
      groupsState.items[key] = gid;
      var at = refKey && refKey !== key ? groupsState.order.indexOf(refKey) : -1;
      if (at >= 0) groupsState.order.splice(after ? at + 1 : at, 0, key); else groupsState.order.push(key);
    }
    saveGroups();
  }
  /** The keys of a group, in the order the user placed them. */
  function groupKeys(gid) { return groupsState.order.filter(function (k) { return groupsState.items[k] === gid; }); }
  function toggleGroup(id) {
    if (groupsState.collapsed[id]) delete groupsState.collapsed[id]; else groupsState.collapsed[id] = true;
    saveGroups();
  }

  // ---- what the sidebar shows now
  function iconHtml(el) {
    if (!el) return '';
    var c = el.cloneNode(true);
    var all = c.querySelectorAll ? c.querySelectorAll('[id],[data-testid]') : [];
    for (var i = 0; i < all.length; i++) { all[i].removeAttribute('id'); all[i].removeAttribute('data-testid'); }
    c.removeAttribute('id'); c.removeAttribute('data-testid');
    var h = c.innerHTML || '';
    return h.length > 6000 ? '' : h;
  }
  /** What a stock row shows, to be drawn again in the group: its inside as it is now (the working spinner, the waiting-for-you icon, the unread dot, the
   *  pin, the fork badge: AionUi draws each of them from live state, in the row), without its menu button and without the ids that name AionUi's own row. */
  function mirrorHtml(row) {
    var c = row.cloneNode(true);
    var all = c.querySelectorAll('[id],[data-testid],[draggable]');
    for (var i = 0; i < all.length; i++) { all[i].removeAttribute('id'); all[i].removeAttribute('data-testid'); all[i].removeAttribute('draggable'); }
    var btns = c.querySelectorAll('.sider-action-btn');
    for (var j = 0; j < btns.length; j++) {
      var holder = btns[j];
      while (holder.parentNode && holder.parentNode !== c) holder = holder.parentNode;
      if (holder.parentNode === c) c.removeChild(holder);
    }
    var h = c.innerHTML || '';
    return h.length > 20000 ? '' : h;
  }
  /** An icon kept from an earlier launch names the backend's port: point it at this one. */
  function freshIcon(html) { return String(html || '').replace(/src="http:\/\/127\.0\.0\.1:\d+(\/[^"]*)"/g, function (m, p) { return 'src="' + apiUrl(p) + '"'; }); }
  function sideIndex(scroll) {
    var idx = {};
    var rows = scroll.querySelectorAll('.chat-history__item[id^="c-"]');
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], nm = r.querySelector('.chat-history__item-name');
      idx['c:' + r.id.slice(2)] = { hide: r, drag: r, name: nm ? nm.textContent.trim() : '', icon: iconHtml(r.firstElementChild), html: mirrorHtml(r) };
    }
    // a team's icon, or its spinner while it has a run in progress
    var ti = scroll.querySelectorAll('[data-testid^="team-icon-"], [data-testid^="team-spinner-"]');
    for (var j = 0; j < ti.length; j++) {
      var row = ti[j].closest('.h-34px');
      if (!row || !row.parentElement || row.closest('.aiondx-groups')) continue;
      var nameEl = row.children[1];
      idx['t:' + String(ti[j].getAttribute('data-testid')).replace(/^team-(?:icon|spinner)-/, '')] = { hide: row.parentElement, drag: row, name: nameEl ? nameEl.textContent.trim() : '', icon: '', html: mirrorHtml(row) };
    }
    return idx;
  }
  function askGroupInfo(k) {
    var c = groupInfo[k];
    if ((c && Date.now() - c.at < 180000) || groupInfoAsk[k]) return;
    groupInfoAsk[k] = true;
    getJson((k.charAt(0) === 'c' ? '/api/conversations/' : '/api/teams/') + encodeURIComponent(k.slice(2))).then(function (g) {
      var d = g && g.data;
      if (g && g.err === 404) groupInfo[k] = { at: Date.now(), gone: true, name: '' };
      else if (d) groupInfo[k] = { at: Date.now(), gone: !!d.archived_at, name: String(d.name || '') };
      else groupInfo[k] = { at: Date.now() - 150000, gone: false, name: '' };   // a failed read is tried again in 30 s and does not remove anything
    }).catch(function () { groupInfo[k] = { at: Date.now() - 150000, gone: false, name: '' }; }).then(function () { delete groupInfoAsk[k]; schedule(); });
  }
  function removeGroupsUi() {
    if (groupsEl && groupsEl.parentNode) groupsEl.parentNode.removeChild(groupsEl);
    groupsSig = '';
    var hidden = document.querySelectorAll('[data-aiondx-grouped]');
    for (var i = 0; i < hidden.length; i++) hidden[i].removeAttribute('data-aiondx-grouped');
  }
  function gEl(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

  // A team's row in AionUi's Teams list is what gives it its live states, AionUi's own menu (from its row, a group's row or the team's
  // header) and a click that opens it, and AionUi draws no rows while that list is closed. So the list is kept open on the page, and when
  // you close it AionDX hides its rows instead (aionui.dx.teams.closed); the arrow shows it closed. Whether AionUi has it open is AionUi's
  // own setting (team-section-expanded), read, not guessed from the rows: with no teams, or a grouped team just archived, there are no rows
  // either way, and guessing from them flipped the list open and shut every 400 ms (found 2026-11-10).
  var TEAMS_CLOSED = KEY_PREFIX + 'teams.closed';
  var selfToggle = false;
  function teamsClosed() { try { return localStorage.getItem(TEAMS_CLOSED) === '1'; } catch (e) { return false; } }
  function setTeamsClosed(v) { try { if (v) localStorage.setItem(TEAMS_CLOSED, '1'); else localStorage.removeItem(TEAMS_CLOSED); } catch (e) {} }
  function keepTeamRows(scroll) {
    var toggle = scroll.querySelector('[data-testid="team-section-toggle"]');
    var section = toggle && toggle.parentElement;
    if (!section) return;
    var open = false;
    try { open = localStorage.getItem('team-section-expanded') === 'true'; } catch (e) {}
    if (!open && !section.__aiondxOpening) {
      // AionUi has it closed: open it on the page once, and keep it looking closed
      setTeamsClosed(true);
      section.__aiondxOpening = true;
      selfToggle = true;
      try { toggle.click(); } finally { selfToggle = false; }
      setTimeout(function () { section.__aiondxOpening = false; schedule(); }, 1500);
    }
    section.classList.toggle('aiondx-tvc', teamsClosed());
  }
  function watchTeamsToggle() {
    document.addEventListener('click', function (ev) {
      if (selfToggle || disabled()) return;
      var t = ev.target;
      var tg = t && t.closest ? t.closest('[data-testid="team-section-toggle"]') : null;
      if (!tg || t.closest('[data-testid="team-create-btn"]')) return;
      ev.preventDefault();
      ev.stopPropagation();
      setTeamsClosed(!teamsClosed());
      schedule();
    }, true);
  }

  function renderGroups() {
    var scroll = document.querySelector('[class*="_scrollArea_"]');
    if (disabled() || !scroll || !scroll.querySelector('[data-testid="team-section-toggle"]')) { removeGroupsUi(); return; }
    keepTeamRows(scroll);
    var idx = sideIndex(scroll);
    // each team's members read ahead, so its menu has its actions the first time it opens
    Object.keys(idx).forEach(function (k) {
      if (k.charAt(0) !== 't') return;
      var tid = k.slice(2), tc = teamCache[tid];
      if ((!tc || Date.now() - tc.at > 120000) && !teamReads[tid] && !(teamFailed[tid] && Date.now() - teamFailed[tid] < 30000)) memberConversation({ teamId: tid, slotId: '' }).catch(function () {});
    });
    var narrow = scroll.clientWidth > 0 && scroll.clientWidth < 140;
    var r = route();
    var activeKey = r ? (r.kind === 'conv' ? 'c:' : 't:') + r.id : '';
    var sections = [], hide = [], cacheMoved = false;
    groupsState.groups.forEach(function (g) {
      var rows = [];
      groupKeys(g.id).forEach(function (k) {
        var live = idx[k], info = null;
        if (live && live.name) {
          info = { name: live.name, icon: live.icon };
          var old = groupCache[k];
          if (!old || old.name !== live.name || old.icon !== live.icon) { groupCache[k] = { name: live.name, icon: live.icon }; cacheMoved = true; }
        } else {
          askGroupInfo(k);
          var gi = groupInfo[k], cc = groupCache[k];
          if (gi && gi.gone) return;
          var nm = (gi && gi.name) || (cc && cc.name) || '';
          if (!nm) return;
          info = { name: nm, icon: cc ? cc.icon : '' };
        }
        if (live) hide.push(live.hide);
        rows.push({ key: k, name: info.name, icon: info.icon, active: k === activeKey, html: live ? live.html : '' });
      });
      sections.push({ id: g.id, name: g.name, collapsed: !!groupsState.collapsed[g.id], rows: rows });
    });
    // AionUi's own rows of the grouped items stay out of its lists
    var marked = scroll.querySelectorAll('[data-aiondx-grouped]');
    for (var m = 0; m < marked.length; m++) if (hide.indexOf(marked[m]) < 0) marked[m].removeAttribute('data-aiondx-grouped');
    for (var h = 0; h < hide.length; h++) if (hide[h].getAttribute('data-aiondx-grouped') !== '1') hide[h].setAttribute('data-aiondx-grouped', '1');
    if (cacheMoved) { try { localStorage.setItem(KEY_PREFIX + 'groups.cache', JSON.stringify(groupCache)); } catch (e) {} }
    // every chat and team that can be dragged gets its place in the lists as a drag source (AionUi's rows are not draggable by themselves)
    // (not a pinned chat: AionUi drags those itself to reorder the pinned section, and a native drag on the same row cancels AionUi's; found 2026-11-10)
    Object.keys(idx).forEach(function (k) {
      var d = idx[k].drag;
      if (!d) return;
      var own = !d.closest('[aria-roledescription="sortable"]');
      if (own && d.getAttribute('draggable') !== 'true') d.setAttribute('draggable', 'true');
      else if (!own && d.getAttribute('draggable') === 'true') d.removeAttribute('draggable');
    });
    var sig = JSON.stringify([narrow, sections]);
    if (!groupsEl) {
      groupsEl = gEl('div', 'aiondx-groups');
      groupsEl.setAttribute('data-testid', 'aiondx-groups');
      groupsEl.addEventListener('click', onGroupsClick);
      groupsEl.addEventListener('contextmenu', onGroupsContext);
    }
    // not while something is being dragged: rebuilding the rows would drop it from under the pointer (it is drawn again when the drag ends)
    if (sig !== groupsSig && (dragKey || dragGroup) && groupsEl.parentNode === scroll) { injectGroupItem(); return; }
    if (sig !== groupsSig) {
      groupsSig = sig;
      groupsEl.textContent = '';
      groupsEl.style.display = narrow ? 'none' : '';
      // one line between AionUi's own lists and the groups
      var line = gEl('div', 'aiondx-gline');
      line.setAttribute('data-testid', 'aiondx-group-line');
      groupsEl.appendChild(line);
      sections.forEach(function (s) {
        var sec = gEl('div', 'aiondx-gsec');
        sec.setAttribute('data-gid', s.id);
        groupsEl.appendChild(sec);
        var head = gEl('div', 'aiondx-ghead group/label sider-section-label flex items-center px-12px h-28px select-none mt-8px cursor-pointer');
        head.setAttribute('data-gid', s.id);
        head.setAttribute('draggable', 'true');
        head.setAttribute('data-testid', 'aiondx-group-head-' + s.id);
        var chev = gEl('span', 'aiondx-gchev' + (s.collapsed ? '' : ' aiondx-gchev--open'));
        chev.innerHTML = SVG_G_CHEV;
        head.appendChild(chev);
        head.appendChild(gEl('span', 'aiondx-gtitle text-14px text-t-tertiary sider-section-title font-[500] leading-none', s.name));
        head.appendChild(gEl('span', 'aiondx-gcount', s.rows.length ? String(s.rows.length) : ''));
        var more = gEl('span', 'aiondx-gmore aiondx-ghead-more');
        more.title = 'Rename or delete this group';
        more.innerHTML = SVG_G_MORE;
        head.appendChild(more);
        sec.appendChild(head);
        if (s.collapsed) return;
        if (!s.rows.length) sec.appendChild(gEl('div', 'aiondx-gempty', 'Empty. Right-click a chat or a team to add it, or drag one here.'));
        s.rows.forEach(function (row) {
          var el = gEl('div', 'aiondx-grow h-34px rd-8px flex items-center gap-8px ps-10px pe-8px cursor-pointer relative overflow-hidden shrink-0 group min-w-0 transition-colors hover:bg-fill-3' + (row.active ? ' !bg-fill-3' : ''));
          el.setAttribute('data-aiondx-key', row.key);
          el.setAttribute('data-gid', s.id);
          el.setAttribute('draggable', 'true');
          el.setAttribute('data-testid', 'aiondx-group-row-' + row.key.replace(':', '-'));
          if (row.html) {
            // AionUi's own row, as it is now: the same icon states, unread dot, pin and badges
            el.innerHTML = row.html;
          } else {
            // its row is not on the page (the Teams list is collapsed): the icon and the name last seen
            var ic = gEl('span', 'size-22px flex items-center justify-center shrink-0 relative');
            ic.innerHTML = row.key.charAt(0) === 't' ? SVG_G_TEAM : (freshIcon(row.icon) || SVG_G_CHAT);
            el.appendChild(ic);
            el.appendChild(gEl('span', 'aiondx-gname text-14px font-[500] text-t-primary', row.name));
          }
          var mo = gEl('span', 'aiondx-gmore aiondx-grow-more');
          mo.title = 'Menu';
          mo.innerHTML = SVG_G_MORE;
          el.appendChild(mo);
          sec.appendChild(el);
        });
      });
      var add = gEl('div', 'aiondx-gnew h-34px rd-8px flex items-center gap-8px ps-12px pe-8px cursor-pointer select-none mt-8px hover:bg-fill-3', 'New Group +');
      add.setAttribute('data-testid', 'aiondx-group-new');
      groupsEl.appendChild(add);
    }
    if (groupsEl.parentNode !== scroll || scroll.lastElementChild !== groupsEl) scroll.appendChild(groupsEl);
    injectGroupItem();
  }

  // ---- one menu for every chat and team (a request of 2026-11-10: "GET EVERY CHAT TYPE USING BASICALLY THE SAME MENU")
  // The menu is AionUi's own row menu for that chat or team (Pin, Mark as unread, Rename, Create scheduled task, Archive...), with AionDX's
  // lines under it: the group (its choices open inside the same menu) and the context and cache actions that fit the chat now. It opens
  // from the sidebar row (right-click or its three dots), from a group's row, and from the three dots in a chat's or a team's header, and
  // comes up under the row or button it was opened from. AionUi places it at its own row, which is hidden for a grouped item and absent from
  // the header, so AionDX moves it (holdPlace). Only when AionUi has no row on the page (a chat in a folded project folder) does AionDX draw
  // the menu itself (openOwnMenu), from the same parts, with Rename and Archive.
  var menuAnchor = null;     // { key, at, rect }: where the menu being opened belongs
  var opening = false;       // AionDX is opening AionUi's menu itself: the sidebar listeners leave the event alone
  var SVG_X_CHECK = '<svg width="14" height="14" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M10 25l9 9 19-20" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var SVG_X_BLANK = '<svg width="14" height="14" viewBox="0 0 48 48" aria-hidden="true"></svg>';
  var SVG_X_RENAME = '<svg width="14" height="14" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M7 42h34M11 30l20-20 6 6-20 20H11v-6z" stroke="currentColor" stroke-width="3.5" stroke-linejoin="round"/></svg>';
  var SVG_X_ARCHIVE = '<svg width="14" height="14" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M6 8h36v9H6zM9 17v23h30V17M19 25h10" stroke="currentColor" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/></svg>';
  function anchorOf(el) { var r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }
  /** A menu under its anchor, right edges lined up (left edges when it is wider than the room to the anchor's right edge), above it when
   *  there is no room below, always inside the window. */
  function placeAt(pop, a) {
    var w = pop.offsetWidth || 200, h = pop.offsetHeight || 120;
    var left = a.right - w;
    if (left < 4) left = a.left;
    left = Math.max(4, Math.min(left, window.innerWidth - w - 4));
    var top = a.bottom + 2;
    if (top + h > window.innerHeight - 6) top = a.top - h - 2 >= 6 ? a.top - h - 2 : Math.max(6, window.innerHeight - h - 6);
    var L = Math.round(left) + 'px', T = Math.round(top) + 'px';
    if (pop.style.left !== L) pop.style.left = L;
    if (pop.style.top !== T) pop.style.top = T;
  }
  /** Keeps AionUi's menu where AionDX put it: AionUi places it again when it opens or grows. Ends when the menu closes. */
  function holdPlace(pop, a) {
    pop.__aiondxAnchor = a;
    placeAt(pop, a);
    if (pop.__aiondxObs) return;
    pop.__aiondxObs = new MutationObserver(function () {
      if (!pop.__aiondxAnchor || getComputedStyle(pop).display === 'none') { pop.__aiondxObs.disconnect(); pop.__aiondxObs = null; pop.__aiondxAnchor = null; return; }
      placeAt(pop, pop.__aiondxAnchor);
    });
    pop.__aiondxObs.observe(pop, { attributes: true, attributeFilter: ['style'] });
  }
  /** The menu of a chat ("c:<id>") or a team ("t:<id>"), under anchorEl (an element, or a { left, right, top, bottom }). */
  function openChatMenu(key, anchorEl) {
    if (!key || !anchorEl) return;
    var a = anchorEl.getBoundingClientRect ? anchorOf(anchorEl) : anchorEl;
    closeGMenu();
    restorePopups();
    var scroll = document.querySelector('[class*="_scrollArea_"]');
    var live = scroll ? sideIndex(scroll)[key] : null;
    var trg = live && key.charAt(0) === 't' ? live.hide.querySelector('[data-testid="sider-item-menu-trigger"]') : null;
    if (!live || (key.charAt(0) === 't' && !trg)) { openOwnMenu(key, a); return; }
    menuFor = { key: key, at: Date.now() };
    menuAnchor = { key: key, at: Date.now(), rect: a };
    opening = true;
    try {
      if (trg) trg.click();
      else live.hide.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(a.right), clientY: Math.round(a.bottom), button: 2 }));
    } finally { opening = false; }
    afterMenuOpens();
  }
  /** The menu for a chat AionUi has no row for on the page: Rename and Archive (AionUi's own routes), then AionDX's lines. A chat that is not
   *  one of the sidebar's own (a team member's) gets AionDX's context lines only. */
  function openOwnMenu(key, a) {
    var team = key.charAt(0) === 't', id = key.slice(2);
    var own = team || !liveConvs || liveConvs['c:' + id];
    var items = [];
    if (own) {
      items.push({ label: 'Rename', icon: SVG_X_RENAME, run: function () {
        var nameNow = (groupCache[key] && groupCache[key].name) || '';
        askGroupName(team ? 'Rename team' : 'Rename chat', nameNow, 'Rename', function (name) {
          var url = team ? '/api/teams/' + encodeURIComponent(id) + '/name' : '/api/conversations/' + encodeURIComponent(id);
          fetch(apiUrl(url), { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf() }, body: JSON.stringify({ name: name }) })
            .then(function (r) { if (!r.ok) toast('Not renamed.', 'HTTP ' + r.status); else { if (groupCache[key]) groupCache[key].name = name; delete groupInfo[key]; schedule(); } }, function () { toast('Not renamed.', ''); });
        }, '__rename__');
      } });
      items.push({ label: 'Archive', icon: SVG_X_ARCHIVE, run: function () {
        postJson('/api/sidebar/' + (team ? 'team' : 'conversation') + '/' + encodeURIComponent(id) + '/archive', {}).then(function (r) {
          if (!r.ok) { toast('Not archived.', 'HTTP ' + r.status); return; }
          if (groupsState.items[key]) assignGroup(key, null);
          toast(team ? 'Team archived.' : 'Chat archived.', '');
          schedule();
        }, function () { toast('Not archived.', ''); });
      } });
    }
    openGMenu(a, items, own ? key : null, own ? null : key);
  }
  function openGroupMenu(gid, at) {
    var g = groupById(gid);
    if (!g) return;
    openGMenu(at, [
      { label: 'Rename group', icon: SVG_X_RENAME, run: function () { askGroupName('Rename group', g.name, 'Rename', function (name) { renameGroup(gid, name); }, gid); } },
      { label: 'Delete group (its chats and teams are kept)', icon: SVG_X_ARCHIVE, run: function () { deleteGroup(gid); } }
    ]);
  }
  function onGroupsClick(ev) {
    var t = ev.target && ev.target.closest ? ev.target : null;
    if (!t) return;
    var head = t.closest('.aiondx-ghead');
    if (head) {
      if (t.closest('.aiondx-ghead-more')) { openGroupMenu(head.getAttribute('data-gid'), anchorOf(head)); return; }
      toggleGroup(head.getAttribute('data-gid'));
      return;
    }
    var row = t.closest('.aiondx-grow');
    if (row) {
      if (t.closest('.aiondx-grow-more')) { openChatMenu(row.getAttribute('data-aiondx-key'), row); return; }
      var key = row.getAttribute('data-aiondx-key');
      // the click goes to AionUi's own row, so everything a click does there (opening it, marking it read) happens; its address when that row is not on the page
      var sc = document.querySelector('[class*="_scrollArea_"]');
      var live = sc ? sideIndex(sc)[key] : null;
      if (live && live.drag) live.drag.click();
      else location.hash = (key.charAt(0) === 'c' ? '#/conversation/' : '#/team/') + key.slice(2);
      return;
    }
    if (t.closest('.aiondx-gnew')) askGroupName('New group', '', 'Create', function (name) { createGroup(name); });
  }
  function onGroupsContext(ev) {
    var t = ev.target && ev.target.closest ? ev.target : null;
    if (!t) return;
    var head = t.closest('.aiondx-ghead');
    if (head) { ev.preventDefault(); ev.stopPropagation(); openGroupMenu(head.getAttribute('data-gid'), anchorOf(head)); return; }
    var row = t.closest('.aiondx-grow');
    if (row) { ev.preventDefault(); ev.stopPropagation(); openChatMenu(row.getAttribute('data-aiondx-key'), row); }
  }

  // ---- AionDX's own menus (a group's heading, the new-chat page's Group choice, a chat AionUi has no row for), built from the same parts as AionUi's
  function closeGMenu() {
    if (!gMenu) return;
    if (gMenu.parentNode) gMenu.parentNode.removeChild(gMenu);
    gMenu = null;
    document.removeEventListener('mousedown', gMenuOutside, true);
    document.removeEventListener('keydown', gMenuKey, true);
    window.removeEventListener('blur', closeGMenu);
  }
  function gMenuOutside(ev) { if (gMenu && !gMenu.contains(ev.target)) closeGMenu(); }
  function gMenuKey(ev) { if (ev.key === 'Escape') { ev.stopPropagation(); closeGMenu(); } }
  /** at: { left, right, top, bottom } to open under, or { x, y } for its top left corner. items: [{ label, icon, check, sep, run, confirm }].
   *  chatKey: the chat or team whose AionDX lines (group, context, caches) go under the items; actionsKey: the context lines only. */
  function openGMenu(at, items, chatKey, actionsKey) {
    closeGMenu();
    gMenu = gEl('div', 'aiondx-gmenu arco-dropdown-menu arco-dropdown-menu-light arco-dropdown-menu-vertical arco-dropdown-menu-pop');
    gMenu.setAttribute('role', 'menu');
    gMenu.setAttribute('data-testid', 'aiondx-group-menu');
    var inner = gEl('div', 'arco-dropdown-menu-inner');
    gMenu.appendChild(inner);
    items.forEach(function (it) {
      if (it.sep) { inner.appendChild(gEl('div', 'aiondx-xsep')); return; }
      inner.appendChild(actionLine('aiondx-gmenu-item', it.check ? SVG_X_CHECK : (it.icon || SVG_X_BLANK), it.label, it.confirm, it.run, '', it.check));
    });
    if (chatKey) addDxLines(inner, chatKey, false);
    else if (actionsKey) addDxLines(inner, actionsKey, true);
    document.body.appendChild(gMenu);
    var a = at.right !== undefined ? at : { left: at.x, right: at.x + (gMenu.offsetWidth || 200), top: at.y - 2, bottom: at.y - 2 };
    gMenu.__aiondxAnchor = a;
    placeAt(gMenu, a);
    setTimeout(function () {
      document.addEventListener('mousedown', gMenuOutside, true);
      document.addEventListener('keydown', gMenuKey, true);
      window.addEventListener('blur', closeGMenu);
    }, 0);
  }

  // ---- AionDX's lines in a chat's or a team's menu
  var SVG_X_STOP = '<svg width="14" height="14" viewBox="0 0 48 48" fill="none" aria-hidden="true"><rect x="12" y="12" width="24" height="24" rx="3" stroke="currentColor" stroke-width="3.5"/></svg>';
  var SVG_X_COMPACT = '<svg width="14" height="14" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M16 6v12H4M32 6v12h12M16 42V30H4M32 42V30h12" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var SVG_X_FRESH = '<svg width="14" height="14" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M40 24a16 16 0 1 1-4.7-11.3M40 6v8h-8" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var SVG_X_RESTART = '<svg width="14" height="14" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M24 6v18M14 12a16 16 0 1 0 20 0" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/></svg>';
  var SVG_X_DISK = '<svg width="14" height="14" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M8 12h32M18 12V7h12v5M12 12l2 29h20l2-29M20 20v14M28 20v14" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  /** The Loop and live-state target for a chat key, or every member of a team key. */
  function targetsForKey(key) {
    if (key.charAt(0) === 'c') return [{ kind: 'conv', key: 'conv:' + key.slice(2), convId: key.slice(2) }];
    var teamId = key.slice(2), tc = teamCache[teamId];
    if (!tc || !tc.ok) { memberConversation({ teamId: teamId, slotId: '' }).then(function () { schedule(); }, function () {}); return []; }
    return Object.keys(tc.map).map(function (slot) { return { kind: 'team', key: 'team:' + teamId + ':' + slot, teamId: teamId, slotId: slot, role: tc.roles[slot] || '', convId: tc.map[slot] || null }; });
  }
  function isWorking(t) { var a = agentLive[t.key]; return !!a && (a.state === 'working' || a.state === 'queued'); }
  function requestCompact(t) {
    var s = state(t);
    s.compactAt = Date.now();
    save(t, s);
    try { publishStatus(t); } catch (e) {}
  }
  /** Whether AionUi's sidebar row of a chat or team shows it working (its spinner), for one that is not on screen. */
  function rowShowsWork(key) {
    var sc = document.querySelector('[class*="_scrollArea_"]');
    var live = sc ? sideIndex(sc)[key] : null;
    return !!live && !!live.hide.querySelector('[data-testid^="team-spinner-"], .arco-spin');
  }
  /** Stop for every member of a team that is working, each checked with AionCore first (a member that is idle is not paused). */
  async function stopMembers(ts) {
    var n = 0;
    for (var i = 0; i < ts.length; i++) {
      var t = ts[i];
      if (!t.convId) continue;
      var g = await getJson('/api/conversations/' + t.convId).catch(function () { return {}; });
      if (!(g && g.data && convBusy(g.data))) continue;
      n++;
      hardStop(t).catch(function () {});
      deadHalt(t, t.convId).catch(function () {});
    }
    return n;
  }
  /** The actions offered for a key, as it stands now. Each: { id, label, icon, run, confirm, danger }. */
  function menuActions(key) {
    var ts = targetsForKey(key), team = key.charAt(0) === 't';
    var out = [];
    var working = ts.filter(isWorking);
    var busy = working.length > 0 || rowShowsWork(key);
    if (busy) out.push({ id: 'stop', icon: SVG_X_STOP, danger: true, label: team ? 'Stop every member that is working' : 'Stop',
      run: async function () {
        if (team) { var n = await stopMembers(ts); toast(n ? 'Stop sent to ' + n + ' member' + (n === 1 ? '' : 's') + '.' : 'No member is working.', n ? 'Each is watched until it stops; one that does not is ended and started again.' : ''); return; }
        ts.forEach(function (t) { hardStop(t).catch(function () {}); deadHalt(t, t.convId).catch(function () {}); });
        toast('Stop sent.', 'It is watched until it stops; if it does not, the agent is ended and started again.');
      } });
    if (ts.length) out.push({ id: 'compact', icon: SVG_X_COMPACT, label: team ? 'Compact every member\u2019s context' : 'Compact context',
      run: function () { ts.forEach(requestCompact); render(); toast(team ? 'Compaction asked for every member.' : 'Compaction asked for.', 'It goes out the next time ' + (team ? 'each member' : 'the agent') + ' stops (an agent that offers no compact command is skipped). The chat keeps a summary.'); } });
    var resettable = team ? ts.filter(function (t) { return !isLeadRole(t.role); }) : [];
    if (team && resettable.length) out.push({ id: 'fresh', icon: SVG_X_FRESH, confirm: true, danger: true, label: 'Start fresh contexts (' + resettable.length + ' member' + (resettable.length === 1 ? '' : 's') + ', not the lead)',
      run: async function () {
        var ok = 0, failed = [];
        for (var i = 0; i < resettable.length; i++) {
          var r = await postJson('/api/teams/' + resettable[i].teamId + '/agents/' + encodeURIComponent(resettable[i].slotId) + '/context/reset', {}).catch(function () { return null; });
          if (r && r.ok) ok++; else failed.push(r ? r.status : 'no answer');
        }
        toast('Fresh context for ' + ok + ' of ' + resettable.length + ' members.', failed.length ? 'Not reset: ' + failed.join(', ') + ' (a member that is working cannot be reset; stop it first).' : 'Their chat history stays; their agents start without it.');
      } });
    if (ts.length) out.push({ id: 'restart', icon: SVG_X_RESTART, confirm: busy, label: team ? 'Restart every member\u2019s agent (contexts kept)' : 'Restart the agent (context kept)',
      run: async function () {
        var ok = 0;
        for (var i = 0; i < ts.length; i++) {
          var t = ts[i];
          var r = await postJson(t.kind === 'conv' ? '/api/conversations/' + t.convId + '/runtime/restart' : '/api/teams/' + t.teamId + '/agents/' + encodeURIComponent(t.slotId) + '/runtime/restart', {}).catch(function () { return null; });
          if (r && r.ok) ok++;
        }
        toast(ok === ts.length ? 'Restarted.' : 'Restarted ' + ok + ' of ' + ts.length + '.', 'Whatever was running ended. The session and its context carry on.');
      } });
    if (cacheBridge()) out.push({ id: 'disk', icon: SVG_X_DISK, label: 'Clear disk caches\u2026',
      run: function () {
        var c = key.charAt(0) === 'c' ? key.slice(2) : (ts[0] && ts[0].convId);
        var info = c ? convInfo[c] : null, cur = info ? chatAgent(c, info) : null;
        openCaches(cur ? cacheProfileHint(agentName(cur.id)) : '');
      } });
    return out;
  }
  /** Closes the menu a line is in: AionDX's own, or AionUi's (put out of sight; it closes itself at the next press outside it). */
  function closeMenuOf(node) {
    if (gMenu && gMenu.contains(node)) { closeGMenu(); return; }
    var pp = node.closest('.arco-trigger') || node.parentElement;
    if (pp && pp.style) { pp.setAttribute('data-aiondx-hid', '1'); pp.style.setProperty('visibility', 'hidden', 'important'); pp.style.setProperty('pointer-events', 'none', 'important'); }
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }
  /** A line built like AionUi's own menu lines: icon, then text. */
  function menuLine(cls, icon, testid) {
    var it = gEl('div', 'arco-dropdown-menu-item ' + cls);
    it.setAttribute('role', 'menuitem');
    it.setAttribute('tabindex', '0');
    if (testid) it.setAttribute('data-testid', testid);
    var line = gEl('div', 'flex items-center gap-8px');
    var ic = gEl('span', 'i-icon');
    ic.innerHTML = icon;
    line.appendChild(ic);
    line.appendChild(gEl('span', 'aiondx-gitem-text'));
    it.appendChild(line);
    return it;
  }
  /** A line that does something when clicked; confirm: one that cannot be undone asks for a second click, in place. */
  function actionLine(cls, icon, label, confirm, run, testid, checked) {
    var line = menuLine(cls + (checked ? ' aiondx-gcheck' : ''), icon, testid);
    var text = line.querySelector('.aiondx-gitem-text');
    text.textContent = label;
    line.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (confirm && !(line.__armed > Date.now())) {
        line.__armed = Date.now() + 6000;
        text.textContent = 'Click again: ' + label.charAt(0).toLowerCase() + label.slice(1);
        line.classList.add('aiondx-xitem--armed');
        setTimeout(function () { if (line.__armed && line.__armed <= Date.now()) { line.__armed = 0; text.textContent = label; line.classList.remove('aiondx-xitem--armed'); } }, 6100);
        return;
      }
      closeMenuOf(line);
      if (run) Promise.resolve(run()).catch(function (e) { toast('That did not go through.', String(e && e.message || e)); });
    });
    return line;
  }
  /** AionDX's lines at the end of a menu: the group line (its choices open in the same menu), then the actions. actionsOnly: no group line. */
  function addDxLines(m, key, actionsOnly) {
    Array.prototype.forEach.call(m.querySelectorAll(':scope > .aiondx-gitem, :scope > .aiondx-gsub, :scope > .aiondx-xitem, :scope > .aiondx-xsep'), function (x) { x.remove(); });
    var acts = menuActions(key);
    if (actionsOnly && !acts.length) return;
    if (m.children.length) m.appendChild(gEl('div', 'aiondx-xsep'));
    if (!actionsOnly) {
      var it = menuLine('aiondx-gitem', SVG_G_FOLDER, 'aiondx-group-menu-item');
      it.setAttribute('data-gkey', key);
      m.appendChild(it);
      groupLineText(it);
      it.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); toggleGroupChoices(m, it, key); });
    }
    acts.forEach(function (a) { m.appendChild(actionLine('aiondx-xitem' + (a.danger ? ' aiondx-xitem--danger' : ''), a.icon, a.label, a.confirm, a.run, 'aiondx-menu-' + a.id)); });
  }
  function groupLineText(it) {
    var key = it.getAttribute('data-gkey'), cur = key && groupsState.items[key] ? groupById(groupsState.items[key]) : null;
    var tx = it.querySelector('.aiondx-gitem-text');
    var label = cur ? 'Group: ' + cur.name : 'Add to group';
    if (tx.textContent !== label) tx.textContent = label;
  }
  /** The group choices, opened under the group line inside the same menu: each group (a tick on the current one), New group, Remove from group. */
  function toggleGroupChoices(m, it, key) {
    var subs = m.querySelectorAll(':scope > .aiondx-gsub');
    if (subs.length) { Array.prototype.forEach.call(subs, function (x) { x.remove(); }); it.classList.remove('aiondx-gitem--open'); }
    else {
      var cur = groupsState.items[key] || '';
      var choices = groupsState.groups.map(function (g) { return { label: g.name, check: g.id === cur, run: function () { if (g.id !== cur) assignGroup(key, g.id); } }; });
      choices.push({ label: 'New group\u2026', run: function () { askGroupName('New group', '', 'Create', function (name) { var id = createGroup(name); if (id) assignGroup(key, id); }); } });
      if (cur) choices.push({ label: 'Remove from group', run: function () { assignGroup(key, null); } });
      var after = it;
      choices.forEach(function (c) {
        var line = actionLine('aiondx-gsub', c.check ? SVG_X_CHECK : SVG_X_BLANK, c.label, false, c.run, '', c.check);
        m.insertBefore(line, after.nextSibling);
        after = line;
      });
      it.classList.add('aiondx-gitem--open');
    }
    var pop = m.closest('.arco-trigger') || m.closest('.aiondx-gmenu');
    if (pop && pop.__aiondxAnchor) placeAt(pop, pop.__aiondxAnchor); else fitStockMenu(m);
  }

  // ---- AionUi's own chat and team menus get AionDX's lines
  /** A menu AionUi shows again is a change of style, which the page's observer does not see: the lines are brought up to date on a timer. */
  function afterMenuOpens() { [40, 150, 400].forEach(function (ms) { setTimeout(schedule, ms); }); }
  /** A menu put out of sight after a choice is shown again the next time AionUi opens it (AionUi keeps the menu and reuses it). */
  function restorePopups() {
    var hid = document.querySelectorAll('[data-aiondx-hid]');
    for (var i = 0; i < hid.length; i++) { hid[i].removeAttribute('data-aiondx-hid'); hid[i].style.removeProperty('visibility'); hid[i].style.removeProperty('pointer-events'); }
  }
  /** Each menu AionUi opens for a chat or a team gets AionDX's lines at the end. The menu belongs to the row that was asked for (menuFor, set
   *  where it was opened); the lines are made again at each opening, so they follow the chat's state. AionUi caps a menu at 200 px and
   *  scrolls the rest, which hid these lines: such a menu is let grow (CSS), and moved where it was opened from (holdPlace), or up when it
   *  runs off the window. */
  function injectGroupItem() {
    var ask = menuFor && Date.now() - menuFor.at < 5000 ? menuFor : null;
    var menus = document.querySelectorAll('.arco-dropdown-menu-inner');
    for (var i = 0; i < menus.length; i++) {
      var m = menus[i];
      if (m.closest('.aiondx-gmenu')) continue;
      var txt = m.textContent || '';
      if (!/Rename/.test(txt) || !/Archive|Pin/.test(txt)) continue;
      var pop = m.closest('.arco-trigger') || m;
      var cs = getComputedStyle(pop);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;      // a closed menu, kept by AionUi
      var it = m.querySelector(':scope > .aiondx-gitem');
      if (!it && !ask) continue;
      if (ask && (!it || it.getAttribute('data-gstamp') !== String(ask.at))) {
        addDxLines(m, ask.key, false);
        it = m.querySelector(':scope > .aiondx-gitem');
        it.setAttribute('data-gstamp', String(ask.at));
        menuFor = null;
        if (menuAnchor && menuAnchor.key === ask.key && Date.now() - menuAnchor.at < 5000) { holdPlace(pop, menuAnchor.rect); menuAnchor = null; }
        else pop.__aiondxAnchor = null;
      } else if (it) groupLineText(it);
      if (!pop.__aiondxAnchor) fitStockMenu(m);
    }
  }
  /** A menu that grew past the window's bottom is moved up so its last line shows. */
  function fitStockMenu(m) {
    var pop = m.closest('.arco-trigger');
    if (!pop) return;
    var r = pop.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 6 && r.height < window.innerHeight - 12) {
      var top = parseFloat(pop.style.top) || r.top;
      pop.style.top = Math.max(6, top - (r.bottom - (window.innerHeight - 6))) + 'px';
    }
  }

  // ---- a grouped item that is archived or deleted leaves its group (2026-11-10: "ARCHIVING STILL DOESN'T WORK FOR THE NEW GROUPS")
  // AionCore's answer for one chat does not say whether it is archived, so the group kept showing an archived chat from its last known name.
  // The lists do leave archived chats and teams out: every 30 seconds, and right after an Archive in a menu, a grouped chat or team that is
  // in neither list leaves its group. A list that could not be read whole changes nothing.
  var liveConvs = null, reconAt = 0, reconBusy = false;
  async function reconcileGroups(now) {
    if (reconBusy || disabled()) return;
    if (!now && Date.now() - reconAt < 30000) return;
    reconBusy = true;
    reconAt = Date.now();
    try {
      var keys = Object.keys(groupsState.items);
      var live = {}, okC = false, okT = false;
      var g = await getJson('/api/conversations?limit=500').catch(function () { return null; });
      var d = g && g.data;
      if (d && Array.isArray(d.items) && !d.has_more) {
        okC = true;
        var lc = {};
        d.items.forEach(function (x) { if (x && x.id) { live['c:' + x.id] = 1; lc['c:' + x.id] = 1; } });
        liveConvs = lc;
      }
      if (keys.some(function (k) { return k.charAt(0) === 't'; })) {
        var tl = await getJson('/api/teams').catch(function () { return null; });
        var arr = tl && tl.data ? (Array.isArray(tl.data) ? tl.data : tl.data.items) : null;
        if (Array.isArray(arr)) { okT = true; arr.forEach(function (x) { if (x && x.id && !x.archived_at) live['t:' + x.id] = 1; }); }
      }
      var gone = keys.filter(function (k) { return (k.charAt(0) === 'c' ? okC : okT) && !live[k]; });
      if (gone.length) {
        gone.forEach(function (k) { delete groupsState.items[k]; });
        groupsState.order = groupsState.order.filter(function (k) { return !!groupsState.items[k]; });
        saveGroups();
      }
    } catch (e) { /* the next run tries again */ } finally { reconBusy = false; }
  }

  // ---- the chat window's own menu button (a request of 2026-11-09: "give a 3-dot menu in the chat window itself"): the same menu
  var chatMenuBtn = null;
  function renderChatMenuButton() {
    var r = route();
    // the chat's or the team's own header: the one with its title, outside the sidebar (the sidebar has a header too, with the logo, and
    // until 2026-11-10 the button went there)
    var hdr = null;
    if (r && !disabled()) {
      var hs = document.querySelectorAll('header.arco-layout-header');
      for (var i = 0; i < hs.length && !hdr; i++) if (!hs[i].closest('.arco-layout-sider') && hs[i].querySelector('[data-testid="chat-title-editor-trigger"]')) hdr = hs[i];
    }
    var right = hdr ? hdr.querySelector(':scope > .shrink-0') : null;
    if (!right) { if (chatMenuBtn && chatMenuBtn.parentNode) chatMenuBtn.parentNode.removeChild(chatMenuBtn); return; }
    if (!chatMenuBtn) {
      chatMenuBtn = gEl('div', 'shrink-0 aiondx-chatmenu');
      chatMenuBtn.innerHTML = '<span class="h-28px w-28px"><button type="button" class="arco-btn arco-btn-text arco-btn-size-mini arco-btn-shape-square arco-btn-icon-only aiondx-chatmenu-btn" data-testid="aiondx-chat-menu" aria-haspopup="menu" title="Menu">' + SVG_G_MORE + '</button></span>';
      chatMenuBtn.querySelector('button').addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var rr = route();
        if (!rr) return;
        openChatMenu((rr.kind === 'conv' ? 'c:' : 't:') + rr.id, ev.currentTarget);
      });
    }
    if (chatMenuBtn.parentNode !== right || right.lastElementChild !== chatMenuBtn) right.appendChild(chatMenuBtn);
  }

  // ---- the chat's notification bell (R-112, a request of 2026-11-13). A bell in the chat's header, before the menu button. It holds only notices
  // whose condition the app checks each time (aiondx-notices.js in the main process: Claude Docs needs a sign-in, an agent started before Docs or
  // a sign-in and needs a reconnect); a notice whose condition stops holding is gone at the next check. New notices show a red bubble with their
  // count over the bell; opening the bell marks them seen and the bubble goes. Nothing restarts an agent by itself: a reconnect costs the user
  // usage, so it is a button. Checked when a chat opens, every minute while the window is in front, and after a sign-in or a reconnect.
  var bellBtn = null, bellPop = null, bellNotices = [], bellFor = '', bellAt = 0, bellBusy = false, bellTeam = {};
  var BELL_SEEN_KEY = KEY_PREFIX + 'bell.seen';
  var SVG_BELL = '<svg width="14" height="14" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M24 5c-7 0-12 5-12 12v9l-4 7h32l-4-7v-9c0-7-5-12-12-12z" stroke="currentColor" stroke-width="3.6" stroke-linejoin="round"/><path d="M19 37c1 3.5 3 5 5 5s4-1.5 5-5" stroke="currentColor" stroke-width="3.6" stroke-linecap="round"/></svg>';
  function bellSeen() { try { return JSON.parse(localStorage.getItem(BELL_SEEN_KEY)) || {}; } catch (e) { return {}; } }
  function bellMarkSeen() {
    var s = bellSeen(), now = Date.now();
    bellNotices.forEach(function (n) { s[n.id] = now; });
    Object.keys(s).forEach(function (k) { if (now - s[k] > 30 * 86400000) delete s[k]; });
    try { localStorage.setItem(BELL_SEEN_KEY, JSON.stringify(s)); } catch (e) {}
  }
  function bellUnseen() { var s = bellSeen(); return bellNotices.filter(function (n) { return !s[n.id]; }).length; }
  async function bellChats(r) {
    if (r.kind === 'conv') return [{ conv: r.id }];
    var c = bellTeam[r.id];
    if (!c || Date.now() - c.at > 60000) {
      var t = await getJson('/api/teams/' + encodeURIComponent(r.id));
      var rows = t && t.data ? (t.data.assistants || t.data.agents || []) : [];
      c = bellTeam[r.id] = { at: Date.now(), list: rows.filter(function (a) { return a && a.conversation_id; }).map(function (a) {
        return { conv: a.conversation_id, slot: a.slot_id, name: a.name, team: r.id };
      }) };
    }
    return c.list;
  }
  async function bellCheck(force) {
    var r = route();
    if (!r || !window.aiondxNotices || bellBusy) return;
    var key = r.kind + ':' + r.id;
    if (!force && key === bellFor && Date.now() - bellAt < 60000) return;
    bellBusy = true;
    try {
      var chats = await bellChats(r);
      var res = await window.aiondxNotices.check(chats.map(function (c) { return c.conv; }));
      var list = res && res.ok ? res.notices : [];
      list.forEach(function (n) {
        var c = chats.filter(function (x) { return x.conv === n.conv; })[0];
        if (c && c.name) n.who = c.name;
        if (c && c.slot) { n.slot = c.slot; n.team = c.team; }
      });
      bellNotices = list;
      bellFor = key;
      bellAt = Date.now();
      paintBell();
      if (bellPop) fillBellPop();
    } catch (e) { /* the next check tries again */ } finally { bellBusy = false; }
  }
  function paintBell() {
    if (!bellBtn) return;
    var n = bellUnseen();
    var badge = bellBtn.querySelector('.aiondx-bell-badge');
    badge.textContent = n > 9 ? '9+' : String(n);
    badge.style.display = n ? '' : 'none';
    var b = bellBtn.querySelector('button');
    b.title = bellNotices.length ? bellNotices.length + ' notice' + (bellNotices.length === 1 ? '' : 's') + ' for this chat' : 'Notices for this chat';
    b.setAttribute('aria-label', n ? n + ' new notice' + (n === 1 ? '' : 's') : 'Notices');
  }
  function closeBellPop() { if (bellPop && bellPop.parentNode) bellPop.parentNode.removeChild(bellPop); bellPop = null; }
  function fillBellPop() {
    if (!bellPop) return;
    bellPop.innerHTML = '';
    if (!bellNotices.length) { bellPop.appendChild(gEl('div', 'aiondx-bell-empty', 'Nothing needs your attention in this chat.')); return; }
    bellNotices.forEach(function (n) {
      var item = gEl('div', 'aiondx-bell-item');
      item.appendChild(gEl('div', 'aiondx-bell-title', n.title + (n.who ? ' (' + n.who + ')' : '')));
      item.appendChild(gEl('div', 'aiondx-bell-text', n.text));
      var st = gEl('div', 'aiondx-bell-status');
      if (n.action) {
        var b = gEl('button', 'arco-btn arco-btn-primary arco-btn-size-small aiondx-bell-act', n.action.label);
        b.type = 'button';
        b.addEventListener('click', function () { bellAct(n, b, st); });
        item.appendChild(b);
      }
      item.appendChild(st);
      bellPop.appendChild(item);
    });
  }
  async function bellAct(n, btn, st) {
    btn.disabled = true;
    try {
      if (n.action.op === 'reconnect') {
        var c = await getJson('/api/conversations/' + encodeURIComponent(n.conv));
        if (c && c.data && c.data.status === 'running') { st.textContent = 'It is working right now. Reconnect when it finishes, so nothing it is doing is cut off.'; btn.disabled = false; return; }
        st.textContent = 'Reconnecting...';
        var r = n.slot ? await postJson('/api/teams/' + encodeURIComponent(n.team) + '/agents/' + encodeURIComponent(n.slot) + '/runtime/restart', {})
                       : await postJson('/api/conversations/' + encodeURIComponent(n.conv) + '/runtime/restart', {});
        st.textContent = r && r.ok ? 'Reconnected. The chat is kept.' : 'The reconnect did not go through' + (r && r.status ? ' (' + r.status + ')' : '') + '. Try again in a moment.';
        if (!(r && r.ok)) btn.disabled = false;
        setTimeout(function () { bellCheck(true); }, 4000);
        return;
      }
      if (n.action.op === 'signin') {
        if (!window.aiondxSignin) { st.textContent = 'Sign in from Settings: Sign in to your agents.'; return; }
        st.textContent = 'Opening the Claude sign-in page in your browser...';
        var s = await window.aiondxSignin.start('claude', n.action.account || undefined);
        if (!s || !s.ok) { st.textContent = 'The sign-in did not start: ' + ((s && (s.error || s.text)) || 'no answer') + '.'; btn.disabled = false; return; }
        st.textContent = 'Finish the sign-in on the page that opened; this updates by itself.';
        if (s.url) { var a = gEl('a', 'aiondx-bell-link', 'Open the sign-in page again'); a.href = s.url; st.appendChild(document.createTextNode(' ')); st.appendChild(a); }
        var started = Date.now();
        var t = setInterval(function () {
          if (Date.now() - started > 11 * 60000) { clearInterval(t); btn.disabled = false; return; }
          window.aiondxSignin.poll().then(function (p) {
            if (!p || p.state === 'running' || p.state === 'none') return;
            clearInterval(t);
            if (p.state === 'done') { st.textContent = 'Signed in.'; bellCheck(true); }
            else { st.textContent = 'The sign-in did not finish.'; btn.disabled = false; }
          }, function () {});
        }, 1500);
      }
    } catch (e) { st.textContent = 'That did not work: ' + e.message; btn.disabled = false; }
  }
  function openBellPop(anchor) {
    if (bellPop) { closeBellPop(); return; }
    bellPop = gEl('div', 'aiondx-bell-pop');
    bellPop.setAttribute('role', 'dialog');
    bellPop.setAttribute('aria-label', 'Notices for this chat');
    var rc = anchor.getBoundingClientRect();
    bellPop.style.top = Math.round(rc.bottom + 6) + 'px';
    bellPop.style.right = Math.max(8, Math.round(document.documentElement.clientWidth - rc.right)) + 'px';
    document.body.appendChild(bellPop);
    fillBellPop();
    bellMarkSeen();
    paintBell();
    bellCheck(true);
    setTimeout(function () {
      var off = function (ev) {
        if (!bellPop) { document.removeEventListener('pointerdown', off, true); return; }
        if (bellPop.contains(ev.target) || (bellBtn && bellBtn.contains(ev.target))) return;
        closeBellPop();
        document.removeEventListener('pointerdown', off, true);
      };
      document.addEventListener('pointerdown', off, true);
    }, 0);
  }
  function renderBell() {
    if (!window.aiondxNotices) return;
    var r = route();
    var hdr = null;
    if (r && !disabled()) {
      var hs = document.querySelectorAll('header.arco-layout-header');
      for (var i = 0; i < hs.length && !hdr; i++) if (!hs[i].closest('.arco-layout-sider') && hs[i].querySelector('[data-testid="chat-title-editor-trigger"]')) hdr = hs[i];
    }
    var right = hdr ? hdr.querySelector(':scope > .shrink-0') : null;
    if (!right) { if (bellBtn && bellBtn.parentNode) bellBtn.parentNode.removeChild(bellBtn); closeBellPop(); return; }
    if (!bellBtn) {
      bellBtn = gEl('div', 'shrink-0 aiondx-bell');
      bellBtn.innerHTML = '<span class="h-28px w-28px aiondx-bell-wrap"><button type="button" class="arco-btn arco-btn-text arco-btn-size-mini arco-btn-shape-square arco-btn-icon-only aiondx-bell-btn" data-testid="aiondx-bell" aria-haspopup="dialog">' + SVG_BELL + '</button><span class="aiondx-bell-badge" style="display:none"></span></span>';
      bellBtn.querySelector('button').addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); openBellPop(ev.currentTarget); });
    }
    var before = chatMenuBtn && chatMenuBtn.parentNode === right ? chatMenuBtn : null;
    if (bellBtn.parentNode !== right || (before && bellBtn.nextSibling !== before)) right.insertBefore(bellBtn, before);
    var key = r.kind + ':' + r.id;
    if (key !== bellFor) { bellNotices = []; paintBell(); closeBellPop(); }
    if (document.visibilityState === 'visible') bellCheck(false);
  }
  (function bellStyle() {
    var st = document.createElement('style');
    st.id = 'aiondx-bell-style';
    st.textContent = [
      '.aiondx-bell{display:inline-flex;align-items:center;align-self:center;margin-inline-end:4px}',
      '.aiondx-bell-wrap{position:relative;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px}',
      '.aiondx-bell-btn{display:inline-flex !important;align-items:center;justify-content:center;width:28px;height:28px;padding:0 !important;color:var(--color-text-2)!important}',
      '.aiondx-bell-btn svg{display:block}',
      '.aiondx-bell-btn:hover{color:var(--color-text-1)!important}',
      '.aiondx-bell-badge{position:absolute;top:-4px;right:-5px;min-width:16px;height:16px;padding:0 4px;box-sizing:border-box;border-radius:8px;',
      '  background:#f53f3f;color:#fff;font-size:10px;font-weight:600;line-height:16px;text-align:center;pointer-events:none;',
      '  border:1px solid #f53f3f;box-shadow:0 0 0 2px var(--color-bg-1,#fff)}',
      '.aiondx-bell-pop{position:fixed;z-index:1100;width:340px;max-height:60vh;overflow:auto;padding:6px;border-radius:8px;',
      '  background:var(--color-bg-popup,var(--color-bg-1,#fff));border:1px solid var(--color-border-2,rgba(0,0,0,.12));box-shadow:0 6px 24px rgba(0,0,0,.18)}',
      '.aiondx-bell-empty{padding:12px;color:var(--color-text-3);font-size:13px}',
      '.aiondx-bell-item{padding:10px 10px 12px;border-radius:6px}',
      '.aiondx-bell-item+.aiondx-bell-item{border-top:1px solid var(--color-border-1,rgba(0,0,0,.08))}',
      '.aiondx-bell-title{font-size:13px;font-weight:600;color:var(--color-text-1);margin-bottom:4px}',
      '.aiondx-bell-text{font-size:12.5px;line-height:1.45;color:var(--color-text-2);margin-bottom:8px}',
      '.aiondx-bell-status{font-size:12px;color:var(--color-text-3);margin-top:6px}',
      '.aiondx-bell-status:empty{display:none}',
    ].join('\n');
    document.head.appendChild(st);
  })();
  setInterval(function () { if (document.visibilityState === 'visible' && route()) bellCheck(false); }, 60000);
  /** A team's row in AionUi's list: its icon, or its spinner while a run is going. */
  function teamRowOf(node) {
    var row = node.closest ? node.closest('.h-34px') : null;
    var ic = row && row.querySelector('[data-testid^="team-icon-"], [data-testid^="team-spinner-"]');
    if (!ic || !row.closest('[class*="_scrollArea_"]') || row.closest('.aiondx-groups')) return null;
    return { id: String(ic.getAttribute('data-testid')).replace(/^team-(?:icon|spinner)-/, '') };
  }
  // ---- question notices: a backstop for the ones the live stream did not bring (patch 0019; a request of 2026-11-09: "i'm not seeing
  // question notifications pop in time"). AionUi notifies from its live event stream only, and a stream event that is late or dropped
  // (the backend logged dropped live events when the page's channel was full) gives a late notice or none. Every 4 seconds AionDX asks
  // AionCore what the busy chats are waiting on (/confirmations): the chats on screen that are working, solo chats active in the last ten
  // minutes, and the members of teams with a run going. A question the stream has not told of (window.__aionDxOnAsk, from patch 0019)
  // gets a desktop notice and an in-app notice that opens the chat. Each question once.
  var askSeen = {};          // conversation id -> when the stream last told of a question in it
  var askNotified = {};      // conversation id + question id -> when it was notified
  var qSolo = { at: 0, list: [] }, qTeams = { at: 0, list: [], reading: false }, qTurn = 0, qBusy = false;
  var notifyOff = false;      // AionUi's own setting (Settings, notifications) switched off: no desktop notice from AionDX either
  window.__aionDxOnAsk = function (a) { if (a && a.conversation_id) askSeen[a.conversation_id] = Date.now(); };
  function noticeAsk(c) {
    var text = c.label + ' is waiting for you.';
    var place = { href: c.href, where: c.where || c.label };
    if (!notifyOff) try {
      var n = new Notification('AionDX', { body: text, tag: 'aiondx-ask-' + c.convId });
      n.onclick = function () { try { window.focus(); } catch (e) {} location.hash = c.href; try { n.close(); } catch (e) {} };
    } catch (e) { /* no desktop notices here */ }
    toast(text, 'An agent asked a question or wants a permission. Click to open it.', place);
  }
  async function questionCandidates() {
    var now = Date.now(), out = [], seen = {};
    var add = function (c) { if (c.convId && !seen[c.convId]) { seen[c.convId] = true; out.push(c); } };
    // on screen and working
    targets().forEach(function (t) {
      var a = agentLive[t.key];
      if (!a || a.state !== 'working') return;
      if (t.kind === 'conv') add({ convId: t.convId, label: 'This chat', href: '#/conversation/' + t.convId });
      else { var tc = teamCache[t.teamId]; add({ convId: tc && tc.map[t.slotId], label: (tc && tc.names[t.slotId]) || 'A team member', where: tc && tc.name, href: '#/team/' + t.teamId }); }
    });
    if (now - qSolo.at > 30000) {
      qSolo.at = now;
      var g = await getJson('/api/conversations?limit=500').catch(function () { return {}; });
      var items = g && g.data ? (g.data.items || (Array.isArray(g.data) ? g.data : [])) : [];
      qSolo.list = items.filter(function (x) { return x && x.id && now - Number(x.modified_at || x.updated_at || 0) < 10 * 60000; })
        .map(function (x) { return { convId: x.id, label: x.name || 'A chat', href: '#/conversation/' + x.id }; });
    }
    qSolo.list.forEach(add);
    if (now - qTeams.at > 15000 && !qTeams.reading) {
      qTeams.reading = true;
      try {
        var tl = await getJson('/api/teams');
        var teams = tl && tl.data ? (Array.isArray(tl.data) ? tl.data : (tl.data.items || [])) : [];
        var list = [];
        for (var i = 0; i < teams.length && i < 20; i++) {
          var tm = teams[i];
          if (!tm || !tm.id || tm.archived_at) continue;
          var rs = await getJson('/api/teams/' + encodeURIComponent(tm.id) + '/run-state').catch(function () { return {}; });
          var work = rs && rs.data && Array.isArray(rs.data.slot_work) ? rs.data.slot_work : [];
          var members = tm.agents || tm.assistants || [];
          work.forEach(function (w) {
            if (!w || !(w.state === 'running' || w.state === 'starting' || w.active_turn_id)) return;
            var m = members.filter(function (x) { return x && x.slot_id === w.slot_id; })[0];
            if (m && m.conversation_id) list.push({ convId: m.conversation_id, label: m.name || 'A team member', where: tm.name, href: '#/team/' + tm.id });
          });
        }
        qTeams.list = list;
        qTeams.at = Date.now();
      } catch (e) { qTeams.at = Date.now(); } finally { qTeams.reading = false; }
    }
    qTeams.list.forEach(add);
    return out;
  }
  async function questionSweep() {
    if (disabled() || qBusy) return;
    qBusy = true;
    try {
      var cands = await questionCandidates();
      if (!cands.length) return;
      // at most 16 chats a sweep, taken in turn
      var take = cands.length <= 16 ? cands : cands.slice(qTurn % cands.length).concat(cands).slice(0, 16);
      qTurn += 16;
      for (var i = 0; i < take.length; i++) {
        var c = take[i];
        var g = await getJson('/api/conversations/' + encodeURIComponent(c.convId) + '/confirmations').catch(function () { return {}; });
        var list = g && Array.isArray(g.data) ? g.data : [];
        var fresh = false;
        list.forEach(function (q) {
          var id = String((q && (q.call_id || q.callId || q.id)) || '');
          if (!id) return;
          var k = c.convId + ':' + id;
          if (askNotified[k]) return;
          askNotified[k] = Date.now();
          fresh = true;
        });
        // one notice a chat, however many questions it has waiting; none when AionUi's own notice went out for it
        if (fresh && Date.now() - (askSeen[c.convId] || 0) >= 45000) noticeAsk(c);
      }
      // forget old ones
      var cut = Date.now() - 6 * 3600000;
      Object.keys(askNotified).forEach(function (k) { if (askNotified[k] < cut) delete askNotified[k]; });
    } catch (e) { /* the next sweep tries again */ } finally { qBusy = false; }
  }

  // ---- Reply goes to one message box (patch 0018; a request of 2026-11-09): the box you last typed in or clicked. With none yet on this
  // page, the box of the lane where the replied-to text was selected. With one box on the page, that box.
  var lastBox = null;          // the last message box (its textarea) you used
  function watchLastBox() {
    var mark = function (ev) {
      var t = ev.target;
      var ta = t && t.closest ? (t.closest('[data-testid="sendbox-input"]') || (t.closest('.sendbox-panel') && t.closest('.sendbox-panel').querySelector('textarea'))) : null;
      if (ta) lastBox = ta.tagName === 'TEXTAREA' ? ta : (ta.querySelector('textarea') || ta);
    };
    document.addEventListener('focusin', mark, true);
    document.addEventListener('mousedown', mark, true);
    document.addEventListener('keydown', mark, true);
  }
  window.__aionDxReplyFor = function (container) {
    try {
      if (disabled() || !container || !container.querySelector) return true;
      var boxes = document.querySelectorAll('[data-testid="sendbox-input"]');
      if (boxes.length <= 1) return true;
      var mine = container.querySelector('textarea, [data-testid="sendbox-input"]');
      if (lastBox && document.contains(lastBox)) return !!mine && (mine === lastBox || container.contains(lastBox));
      // no box used yet: the lane the selection is in
      var sel = window.getSelection && window.getSelection();
      var node = sel && sel.anchorNode;
      var el = node && (node.nodeType === 1 ? node : node.parentElement);
      var lane = el && el.closest ? el.closest('[data-slot-id]') : null;
      if (lane) return lane.contains(container);
      return true;
    } catch (e) { return true; }
  };

  function watchSidebarMenus() {
    watchLastBox();
    document.addEventListener('contextmenu', function (ev) {
      var t = ev.target;
      if (opening || !t || !t.closest || t.closest('.aiondx-groups') || disabled()) return;
      var row = t.closest('.chat-history__item[id^="c-"]');
      if (row) { restorePopups(); menuFor = { key: 'c:' + row.id.slice(2), at: Date.now() }; menuAnchor = null; afterMenuOpens(); return; }
      // AionUi has no right-click menu for a team, only the three dots: right-click opens that menu
      var tr = teamRowOf(t);
      if (tr) { ev.preventDefault(); ev.stopPropagation(); openChatMenu('t:' + tr.id, t.closest('.h-34px') || t); }
    }, true);
    document.addEventListener('click', function (ev) {
      var t = ev.target;
      if (opening || !t || !t.closest || t.closest('.aiondx-groups')) return;
      // an Archive in a chat's or a team's menu: the group lets it go once the lists say it is archived
      var mi = t.closest('.arco-dropdown-menu-item');
      if (mi && !mi.closest('.aiondx-gmenu') && (mi.textContent || '').trim() === 'Archive') {
        var gi = mi.parentElement && mi.parentElement.querySelector(':scope > .aiondx-gitem');
        var gk = gi && gi.getAttribute('data-gkey');
        if (gk && groupsState.items[gk]) [1200, 3500, 8000].forEach(function (ms) { setTimeout(function () { reconcileGroups(true); }, ms); });
        return;
      }
      var b = t.closest('[data-testid^="conversation-row-menu-"]');
      if (b) { restorePopups(); menuFor = { key: 'c:' + String(b.getAttribute('data-testid')).slice(22), at: Date.now() }; menuAnchor = null; afterMenuOpens(); return; }
      var d = t.closest('[data-testid="sider-item-menu-trigger"]');
      var tr = d ? teamRowOf(d) : null;
      if (tr) { restorePopups(); menuFor = { key: 't:' + tr.id, at: Date.now() }; menuAnchor = null; afterMenuOpens(); }
    }, true);
    setInterval(function () { reconcileGroups(false); }, 30000);
    setTimeout(function () { reconcileGroups(true); }, 4000);
    window.addEventListener('hashchange', onGroupHash);
    watchGroupDrag();
    watchTeamsToggle();
  }

  // ---- drag and drop: a chat or a team can be dragged into a group, out of it, and to any place in it
  var dragKey = null;
  function dragKeyOf(t) {
    var gr = t.closest('.aiondx-grow');
    if (gr) return gr.getAttribute('data-aiondx-key');
    var row = t.closest('.chat-history__item[id^="c-"]');
    if (row && row.closest('[class*="_scrollArea_"]')) return 'c:' + row.id.slice(2);
    var tr = teamRowOf(t);
    return tr ? 't:' + tr.id : null;
  }
  function clearDropMarks() {
    var ms = document.querySelectorAll('.aiondx-gdrop-before,.aiondx-gdrop-after,.aiondx-gdrop-sec,.aiondx-gdrop-new,.aiondx-gdrop-out,.aiondx-gdrop-gbefore,.aiondx-gdrop-gafter');
    for (var i = 0; i < ms.length; i++) ms[i].classList.remove('aiondx-gdrop-before', 'aiondx-gdrop-after', 'aiondx-gdrop-sec', 'aiondx-gdrop-new', 'aiondx-gdrop-out', 'aiondx-gdrop-gbefore', 'aiondx-gdrop-gafter');
  }
  var dragGroup = null;      // a whole group being dragged: its id
  /** Put a group before or after another, in the order the user chose. */
  function moveGroup(gid, ref, after) {
    var g = groupById(gid);
    if (!g || !groupById(ref) || gid === ref) return;
    groupsState.groups = groupsState.groups.filter(function (x) { return x.id !== gid; });
    var at = -1;
    for (var i = 0; i < groupsState.groups.length; i++) if (groupsState.groups[i].id === ref) at = i;
    groupsState.groups.splice(after ? at + 1 : at, 0, g);
    saveGroups();
  }
  /** Where a dragged group would land: { gid: the group it goes beside, after, el } or null. */
  function groupDropTarget(t, y) {
    if (!dragGroup || !t || !t.closest || !t.closest('.aiondx-groups')) return null;
    var sec = t.closest('.aiondx-gsec');
    if (sec) {
      var gid = sec.getAttribute('data-gid');
      if (gid === dragGroup) return null;
      var r = sec.getBoundingClientRect();
      return { gid: gid, after: y > r.top + r.height / 2, el: sec };
    }
    var last = groupsState.groups.length ? groupsState.groups[groupsState.groups.length - 1].id : '';
    if (t.closest('.aiondx-gnew') && last && last !== dragGroup) return { gid: last, after: true, el: t.closest('.aiondx-gnew') };
    var line = t.closest('.aiondx-gline');
    if (line && groupsState.groups.length && groupsState.groups[0].id !== dragGroup) return { gid: groupsState.groups[0].id, after: false, el: line };
    return null;
  }
  function endDrag() { dragKey = null; dragGroup = null; clearDropMarks(); document.body.classList.remove('aiondx-dragging'); schedule(); }
  /** Where a drag over t would land: { kind, gid, ref, after, el } or null when t is not a place to drop. */
  function dropTarget(t, y) {
    if (!dragKey || !t || !t.closest) return null;
    if (t.closest('.aiondx-groups')) {
      var row = t.closest('.aiondx-grow'), head = t.closest('.aiondx-ghead'), sec = t.closest('.aiondx-gsec'), nw = t.closest('.aiondx-gnew');
      if (row) {
        var rk = row.getAttribute('data-aiondx-key');
        if (rk === dragKey) return null;
        var r = row.getBoundingClientRect();
        return { kind: 'row', gid: row.getAttribute('data-gid'), ref: rk, after: y > r.top + r.height / 2, el: row };
      }
      if (head) {
        var first = groupKeys(head.getAttribute('data-gid'))[0];
        if (first === dragKey) return null;      // already the first of this group
        return { kind: 'head', gid: head.getAttribute('data-gid'), ref: first || null, after: false, el: sec || head };
      }
      if (sec) return { kind: 'sec', gid: sec.getAttribute('data-gid'), ref: null, after: false, el: sec };
      if (nw) return { kind: 'new', el: nw };
      return null;
    }
    // AionUi's own lists: a chat or team that is in a group may go back
    var sc = t.closest('[class*="_scrollArea_"]');
    if (sc && groupsState.items[dragKey]) return { kind: 'out', el: sc };
    return null;
  }
  function watchGroupDrag() {
    document.addEventListener('dragstart', function (ev) {
      var t = ev.target;
      if (disabled() || !t || !t.closest) return;
      // a whole group, by its heading
      var gh = t.closest('.aiondx-ghead');
      if (gh && !t.closest('.aiondx-grow')) {
        dragGroup = gh.getAttribute('data-gid');
        try {
          ev.dataTransfer.effectAllowed = 'move';
          ev.dataTransfer.setData('text/plain', 'group:' + dragGroup);
          if (ev.dataTransfer.setDragImage) ev.dataTransfer.setDragImage(gh, 24, 14);
        } catch (e) {}
        closeGMenu();
        document.body.classList.add('aiondx-dragging');
        return;
      }
      var key = dragKeyOf(t);
      if (!key) return;
      dragKey = key;
      try {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', key);
        var src = t.closest('.aiondx-grow, .chat-history__item, .h-34px');
        if (src && ev.dataTransfer.setDragImage) ev.dataTransfer.setDragImage(src, 24, 17);
      } catch (e) {}
      closeGMenu();
      document.body.classList.add('aiondx-dragging');
    }, true);
    document.addEventListener('dragover', function (ev) {
      if (dragGroup) {
        clearDropMarks();
        var gt = groupDropTarget(ev.target, ev.clientY);
        if (!gt) return;
        ev.preventDefault();
        try { ev.dataTransfer.dropEffect = 'move'; } catch (e) {}
        gt.el.classList.add(gt.after ? 'aiondx-gdrop-gafter' : 'aiondx-gdrop-gbefore');
        return;
      }
      if (!dragKey) return;
      clearDropMarks();
      var d = dropTarget(ev.target, ev.clientY);
      if (!d) return;
      ev.preventDefault();
      try { ev.dataTransfer.dropEffect = 'move'; } catch (e) {}
      d.el.classList.add(d.kind === 'row' ? (d.after ? 'aiondx-gdrop-after' : 'aiondx-gdrop-before') : d.kind === 'new' ? 'aiondx-gdrop-new' : d.kind === 'out' ? 'aiondx-gdrop-out' : 'aiondx-gdrop-sec');
    }, true);
    document.addEventListener('drop', function (ev) {
      if (dragGroup) {
        var gd = groupDropTarget(ev.target, ev.clientY), moving = dragGroup;
        endDrag();
        if (!gd) return;
        ev.preventDefault();
        ev.stopPropagation();
        moveGroup(moving, gd.gid, gd.after);
        return;
      }
      if (!dragKey) return;
      var d = dropTarget(ev.target, ev.clientY), key = dragKey;
      endDrag();
      if (!d) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (d.kind === 'new') askGroupName('New group', '', 'Create', function (name) { var id = createGroup(name); if (id) assignGroup(key, id); });
      else if (d.kind === 'out') assignGroup(key, null);
      else moveItem(key, d.gid, d.ref, d.after);
    }, true);
    document.addEventListener('dragend', endDrag, true);
  }

  // ---- the dialog for a group's name
  function closeGroupDialog() {
    if (gDlg && gDlg.parentNode) gDlg.parentNode.removeChild(gDlg);
    gDlg = null;
  }
  function askGroupName(title, initial, okLabel, done, selfId) {
    closeGroupDialog();
    gDlg = gEl('div', 'aiondx-gdlg');
    gDlg.setAttribute('data-testid', 'aiondx-group-dialog');
    var card = gEl('div', 'aiondx-gdlg-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.appendChild(gEl('div', 'aiondx-gdlg-title', title));
    var input = gEl('input', 'aiondx-gdlg-input');
    input.type = 'text';
    input.maxLength = 60;
    input.spellcheck = false;
    input.placeholder = selfId === '__rename__' ? 'Name' : 'Group name';
    input.value = initial || '';
    input.setAttribute('data-testid', 'aiondx-group-name');
    card.appendChild(input);
    var err = gEl('div', 'aiondx-gdlg-err');
    card.appendChild(err);
    var btns = gEl('div', 'aiondx-gdlg-btns');
    var cancel = gEl('button', 'aiondx-gdlg-cancel', 'Cancel');
    cancel.type = 'button';
    var ok = gEl('button', 'aiondx-gdlg-ok', okLabel || 'OK');
    ok.type = 'button';
    ok.setAttribute('data-testid', 'aiondx-group-ok');
    btns.appendChild(cancel);
    btns.appendChild(ok);
    card.appendChild(btns);
    gDlg.appendChild(card);
    var submit = function () {
      var name = input.value.replace(/\s+/g, ' ').trim();
      if (!name) { err.textContent = 'Type a name for the group.'; return; }
      var same = selfId === '__rename__' ? null : groupByName(name);
      if (same && same.id !== selfId && selfId) { err.textContent = 'There is already a group called ' + same.name + '.'; return; }
      closeGroupDialog();
      done(name);
    };
    ok.addEventListener('click', submit);
    cancel.addEventListener('click', closeGroupDialog);
    gDlg.addEventListener('mousedown', function (ev) { if (ev.target === gDlg) closeGroupDialog(); });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeGroupDialog(); }
    });
    document.body.appendChild(gDlg);
    input.focus();
    input.select();
  }

  // ---- the new-chat page: a Group menu beside "Work in a project", None by default
  function guidLabel() { var g = guidGroup && groupById(guidGroup.id); return 'Group: ' + (g ? g.name : 'None'); }
  function renderGuidGroup() {
    var onGuid = /^#\/guid(?:[/?]|$)/.test(location.hash);
    var foot = onGuid && !disabled() ? document.querySelector('[class*="_workspaceFootnote_"]') : null;
    if (!foot) { if (guidBtn && guidBtn.parentNode) guidBtn.parentNode.removeChild(guidBtn); return; }
    if (guidGroup && !groupById(guidGroup.id)) guidGroup = null;
    if (!guidBtn) {
      var proj = foot.querySelector('button');
      guidBtn = gEl('button', (proj ? proj.className + ' ' : '') + 'aiondx-gguid-btn');
      guidBtn.type = 'button';
      guidBtn.setAttribute('data-testid', 'aiondx-guid-group');
      guidBtn.innerHTML = '<span class="aiondx-gguid-ic">' + SVG_G_FOLDER + '</span><span class="aiondx-gguid-text"></span><span class="aiondx-gguid-chev">' + SVG_G_CHEV + '</span>';
      guidBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var items = [{ label: 'None', check: !guidGroup, run: function () { guidGroup = null; schedule(); } }];
        groupsState.groups.forEach(function (g) { items.push({ label: g.name, check: !!guidGroup && guidGroup.id === g.id, run: function () { guidGroup = { id: g.id, at: Date.now() }; schedule(); } }); });
        items.push({ sep: true });
        items.push({ label: 'New Group +', run: function () { askGroupName('New group', '', 'Create', function (name) { var id = createGroup(name); if (id) { guidGroup = { id: id, at: Date.now() }; schedule(); } }); } });
        openGMenu(anchorOf(guidBtn), items);
      });
    }
    var tx = guidBtn.querySelector('.aiondx-gguid-text');
    var label = guidLabel();
    if (tx.textContent !== label) tx.textContent = label;
    if (guidBtn.parentNode !== foot) foot.appendChild(guidBtn);
  }
  /** A chat made from the new-chat page lands in the group picked there. */
  function onGroupHash(ev) {
    var oldH = ev && ev.oldURL ? String(ev.oldURL).split('#')[1] || '' : '';
    var newH = location.hash.replace(/^#/, '');
    var wasGuid = /^\/guid(?:[/?]|$)/.test(oldH), isGuid = /^\/guid(?:[/?]|$)/.test(newH);
    if (isGuid && !wasGuid) guidGroup = null;
    var m = /^\/conversation\/([^/?#]+)/.exec(newH);
    if (!m || !wasGuid || !guidGroup || !groupById(guidGroup.id)) return;
    var gid = guidGroup.id, id = m[1];
    guidGroup = null;
    // only a chat that has just been made: a click on an older one must not join the group
    getJson('/api/conversations/' + encodeURIComponent(id)).then(function (g) {
      var d = g && g.data;
      var made = Number(d && d.created_at) || 0;
      if (!d || !(Date.now() - made < 180000)) return;
      assignGroup('c:' + id, gid);
      var grp = groupById(gid);
      if (grp) toast('Added to the group ' + grp.name + '.', '');
    }).catch(function () {});
  }

  // ---------------------------------------------------------------- the sidebar's team spinner (R-007, 2026-10-01)

  // a request of 2026-10-01. AionUi spins a team's sidebar icon while the team has an active run (useSiderTeamRunning: accepted, running or
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
    if (!every('spin', 500)) return;
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

  // a request of 2026-09-27, and 2026-09-26: "allow the llm to
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
  // Opening a path (a request of 2026-10-09, from the 2026-10-03 report that a folder chip answered 400 and an installer showed "too big to
  // preview"). AionCore's /api/shell/open-file only takes a file, so a folder was refused. AionDX's AionCore (patch core-0005) has
  // /api/shell/open-path: a folder opens in Explorer, a program or installer is shown selected in its folder, anything else opens in
  // its own program, "reveal" shows a file selected, "run" starts a program. An AionCore without it gets the older routes.
  var openPathGone = false;
  /** Why an open failed, in words: the answer's own message when there is one, else what the status means. */
  async function openFailText(r) {
    var msg = '';
    try { var j = await r.json(); msg = String((j && (j.message || j.error || (j.data && j.data.message))) || ''); } catch (e) {}
    if (/not found/i.test(msg) || r.status === 400 || r.status === 404) return 'AionDX cannot find that path on this PC' + (msg && !/not found/i.test(msg) ? ' (' + msg + ')' : '');
    return msg || 'status ' + r.status;
  }
  /** Open a local path as Windows would, or show it in its folder (reveal), or start a program (run). */
  function openOutside(path, reveal, run) {
    var fail = function (why) { toast('Could not open it: ' + (why || 'AionDX did not answer') + '.', path); return false; };
    var legacy = function () {
      return pathInfo(path).then(function (inf) {
        var url = inf.dir ? '/api/shell/open-folder-with' : reveal ? '/api/shell/show-item-in-folder' : '/api/shell/open-file';
        var body = inf.dir ? { folder_path: path, tool: 'explorer' } : { file_path: path };
        return postJson(url, body).then(function (r) { return r.ok ? true : openFailText(r).then(fail); });
      });
    };
    if (openPathGone) return legacy().catch(function () { return fail(''); });
    return postJson('/api/shell/open-path', { path: path, action: run ? 'run' : reveal ? 'reveal' : 'auto' }).then(function (r) {
      if (r.status === 404 || r.status === 405) { openPathGone = true; return legacy(); }
      return r.ok ? true : openFailText(r).then(fail);
    }).catch(function () { return fail(''); });
  }
  var NO_PREVIEW_EXT = /\.(?:exe|msi|msix|msp|appx|bat|cmd|com|scr|ps1|vbs|jar|lnk|reg|dll|sys|bin|iso|img|vhd|vhdx|zip|7z|rar|gz|tgz|tar|bz2|xz|cab|dmg|apk|mp4|mkv|avi|mov|wmv|mp3|wav|flac|psd|blend|unitypackage|pak|dat|db|sqlite)$/i;
  var PREVIEW_MAX_BYTES = 5 * 1024 * 1024;
  /** Whether a path is a folder, and how big a file is. A trailing slash is a folder without asking. */
  function pathInfo(path) {
    if (/[\\/]$/.test(path)) return Promise.resolve({ dir: true, size: 0 });
    var c = dirCache[path];
    if (c && Date.now() - c.at < 5 * 60000) return Promise.resolve(c);
    return postJson('/api/fs/metadata', { path: path }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      var d = j ? unwrap(j) : null;
      var inf = { at: Date.now(), dir: !!(d && (d.is_directory || d.isDirectory)), size: d && Number(d.size) > 0 ? Number(d.size) : 0 };
      dirCache[path] = inf;   // a refusal too (outside the sandbox, 403): it was asked again on every repaint (101 times on 2026-11-11)
      return inf;
    }, function () { return { dir: false, size: 0 }; });
  }
  /** AionUi's preview cannot show it: a folder, a program, an archive, a media file, anything over the preview size. The click opens it outside. */
  function noPreview(path, inf) { return !!inf && (inf.dir || NO_PREVIEW_EXT.test(path) || inf.size > PREVIEW_MAX_BYTES); }
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
            pathInfo(path).then(function (inf) {
              if (inf.dir) chip.setAttribute('data-aiondx-dir', '1');
              if (noPreview(path, inf)) chip.setAttribute('data-aiondx-nopreview', '1');
              var toPreview = opt('links.files') === 'preview';
              chip.title = inf.dir ? 'Opens the folder in Explorer' : !toPreview ? 'Opens the file outside AionDX (Alt+click: a preview; Shift+click: show it in its folder)' :
                noPreview(path, inf) ? 'Shows the file in its folder (Explorer)' : 'Opens a preview; the arrow button opens it outside AionDX';
            });
          }
        })(chips[i]);
      }
    });
  }
  /** A click on the label of a chip that AionUi cannot preview (a folder, a program, an archive, a big file) opens it outside instead:
   *  a folder in Explorer, a file selected in its folder. A link written run:C:/path/setup.exe asks first, then starts the program. */
  function watchLocalLinks() {
    window.addEventListener('click', function (ev) {
      if (disabled() || ev.defaultPrevented) return;
      var path = ev.composedPath ? ev.composedPath() : [];
      var label = null, chip = null, anchor = null;
      for (var i = 0; i < path.length; i++) {
        var n = path[i];
        if (!n || n.nodeType !== 1) continue;
        if (!anchor && n.tagName === 'A') anchor = n;
        if (!label && n.classList && n.classList.contains('markdown-local-file-link')) label = n;
        if (n.hasAttribute && n.hasAttribute('data-local-file-path')) { chip = n; break; }
      }
      if (anchor && !chip) {
        var href = anchor.getAttribute('href') || '';
        var m = /^run:(?:\/\/)?(.+)$/i.exec(href) || /^https?:\/\/aiondx\.invalid\/run\?path=(.+)$/i.exec(href);
        if (m) {
          ev.preventDefault(); ev.stopPropagation();
          var target = decodeLinkPath(m[1]);
          if (!absoluteLocalPath(target)) { toast('Could not run it: the link needs a full path.', target); return; }
          if (window.confirm('Run this program?\n\n' + target + '\n\nOnly continue if you expected this link.')) openOutside(target, false, true);
        }
        return;
      }
      if (!label || !chip) return;
      var p = chip.getAttribute('data-local-file-path');
      // A request of 2026-10-20: a link to a file or a folder opens outside AionDX unless the user chose otherwise (option links.files). The
      // choice is made at the click: the folder check below finishes seconds after a chip appears, and a chip clicked before that opened a tab.
      var viaPreview = opt('links.files') === 'preview';
      if (ev.altKey) viaPreview = !viaPreview;
      if (viaPreview && chip.getAttribute('data-aiondx-dir') !== '1' && chip.getAttribute('data-aiondx-nopreview') !== '1') return;
      if (!absoluteLocalPath(p)) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      openOutside(p, ev.shiftKey);
    }, true);
  }
  function decodeLinkPath(x) {
    var t = String(x || '').trim();
    try { t = decodeURIComponent(t); } catch (e) {}
    t = t.replace(/^file:\/\/\/?/i, '').replace(/^\/(?=[A-Za-z]:)/, '');
    return t;
  }

  // ---------------------------------------------------------------- links open in the system browser; pictures know their file

  // A request of 2026-10-20: "url's should open in the system's browser of choice, and not a tab inside AionDX". On 2026-10-22 the option
  // that put a link in a tab went with the built-in browser itself (patch 0012). AionUi's markdown links call
  // preview.openBrowserTab for any http(s) address (Markdown/index.tsx handleLinkClick), which 0012 makes open the system browser too. A click in
  // the capture phase gets there first: the address goes to the system's default browser through AionCore's open-external route (http and
  // https only), and AionUi's own handler never runs. Anchors that are AionDX's own, and anything that is not a left click, are left alone.
  var lastGestureAt = 0;
  var lastContext = null;     // { el, at }: the target of the newest right-click, so the main process can ask which picture it was
  function installLinkRouting() {
    // A press counts as scrolling only on a scrollbar (the press lands on the scroller itself, beyond its content width): a click on a tab or a button
    // opens a page, and the older pages that page asks for are the chain being paced.
    document.addEventListener('pointerdown', function (ev) {
      lastGestureAt = Date.now();
      var t = ev.target;
      if (t && t.clientWidth && typeof ev.offsetX === 'number' && ev.offsetX >= t.clientWidth && t.scrollHeight > t.clientHeight) lastScrollGestureAt = lastGestureAt;
    }, true);
    document.addEventListener('wheel', function () { lastScrollGestureAt = Date.now(); }, { capture: true, passive: true });
    document.addEventListener('touchmove', function () { lastScrollGestureAt = Date.now(); }, { capture: true, passive: true });
    document.addEventListener('keydown', function (ev) {
      lastGestureAt = Date.now();
      if (/^(PageUp|PageDown|Home|End|ArrowUp|ArrowDown)$/.test(ev.key || '')) lastScrollGestureAt = lastGestureAt;
    }, true);
    document.addEventListener('contextmenu', function (ev) { lastContext = { el: ev.target, at: Date.now() }; }, true);
    document.addEventListener('click', function (ev) {
      if (disabled() || ev.defaultPrevented || ev.button !== 0) return;
      var a = linkOf(ev);
      if (!a) return;
      var href = a.href || '';
      if (!/^https?:\/\//i.test(href)) return;
      // R-110: a Claude Doc opens in the Docs pane wherever its link is, AionDX's own cards included (not inside the pane itself)
      var docHere = isDocLink(href) && !(a.closest && a.closest('.aiondx-docs'));
      if (!docHere && a.closest('[class*="aiondx"]')) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      // R-110: a Claude Doc opens in the pane beside the chat (option links.docs; Alt+click uses the other place).
      if (isDocLink(href) && ((opt('links.docs') !== 'browser') !== !!ev.altKey)) { openDocsPane(href); return; }
      openInBrowser(href);
    }, true);
  }
  // The anchor rail's history (patch 0013). AionUi's rail downloads a chat's whole history, page after page, to read the user turns out of it:
  // 177 requests and 48 MB for a chat of 35,000 messages, on every open. AionCore patch core-0009 answers the same question in one request
  // (GET /api/conversations/{id}/anchors: each turn's id and two 120-character previews). The rail's loader calls this with its own loader as the
  // fall-back, which runs when AionCore is an older build or the request fails. The answer is shaped as the messages the rail's builder reads.
  window.__aionDxAnchors = function (id, fallback) {
    return getJson('/api/conversations/' + encodeURIComponent(id) + '/anchors').then(function (r) {
      var items = r && r.data && Array.isArray(r.data.items) ? r.data.items : null;
      if (!items) throw new Error('no anchors');
      var out = [];
      for (var i = 0; i < items.length; i++) {
        var a = items[i];
        out.push({ id: a.message_id, msg_id: a.msg_id, type: 'text', position: 'right', hidden: false, content: { content: a.question } });
        if (a.answer) out.push({ id: a.message_id + ':reply', type: 'text', position: 'left', hidden: false, content: { content: a.answer } });
      }
      return out;
    }).catch(function () { return fallback(id, { contentMode: 'compact' }); });
  };
  /** The link a click was on, also inside a shadow root (AionUi draws replies in one): the first <a href> on the event's composed path. */
  function linkOf(ev) {
    var path = ev.composedPath ? ev.composedPath() : [];
    for (var i = 0; i < path.length; i++) {
      var n = path[i];
      if (n && n.tagName === 'A' && n.getAttribute && n.getAttribute('href')) return n;
      if (n === document) break;
    }
    var t = ev.target;
    return t && t.closest ? t.closest('a[href]') : null;
  }
  // AionUi's own link handler ends in window.open (patch 0012 sends it on to the system browser): a Claude Doc goes to the Docs pane instead.
  (function hookOpen() {
    var nativeOpen = window.open;
    window.open = function (url) {
      try {
        if (!disabled() && typeof url === 'string' && isDocLink(url) && window.aiondxDocs && opt('links.docs') !== 'browser') { openDocsPane(url); return null; }
      } catch (e) { /* as stock */ }
      return nativeOpen.apply(window, arguments);
    };
  })();
  function openInBrowser(url) {
    return postJson('/api/shell/open-external', { url: url }).then(function (r) {
      if (!r.ok) toast('Could not open the link in your browser.', url);
      return r.ok;
    }, function () { toast('Could not open the link in your browser.', url); return false; });
  }

  // Older messages, paced. AionUi loads a chat's older messages when its list is scrolled near the top (MessageList.tsx handleMessageListScroll: a
  // page of 50 when scrollTop is 160 or less, then it moves scrollTop by the height added). A list that stays near the top after a page arrives
  // (a member column that is not showing, rows of little height) loads the next page, and the next: on 2026-10-20 opening a large team's page
  // sent 38 page requests in one second for one member, and a chat of 30,000 messages would load all of them into the page. The cause of
  // the lag in the longest chats is that DOM. So when a conversation's older pages are asked for in a chain with no scrolling from you (no wheel,
  // touch, scrolling key or press on a scrollbar in the last 2.5 seconds: a click on a tab or a button is not scrolling), the first few (option lag.chainPages) go through and the next one waits, unanswered, until you
  // scroll. Nothing else changes: scrolling up by hand loads pages as before.
  var olderLoads = {};            // conversation id -> times of recent older-page requests
  var lastScrollGestureAt = 0;
  var OLDER_RE = /\/api\/conversations\/([^/?#]+)\/messages\?[^#]*\bbefore=/;
  function pacedOlderPage(convId, args) {
    var now = Date.now();
    var recent = (olderLoads[convId] || []).filter(function (t) { return now - t < 10000; });
    olderLoads[convId] = recent;
    var scrolling = function () { return Date.now() - lastScrollGestureAt < 2500; };
    if (recent.length < opt('lag.chainPages') || scrolling()) { recent.push(now); return nativeFetch.apply(window, args); }
    diagnose('older-pages-held', convId.slice(0, 8), { pages: recent.length });
    return new Promise(function (resolve) {
      var until = Date.now() + 10 * 60000;
      var timer = setInterval(function () {
        if (!scrolling() && Date.now() < until && !disabled()) return;
        clearInterval(timer);
        (olderLoads[convId] = olderLoads[convId] || []).push(Date.now());
        resolve(nativeFetch.apply(window, args));
      }, 400);
    });
  }

  // Where a picture came from. AionUi loads a picture from its path as a data URL (POST /api/fs/image-base64), so the page has no path left. The
  // answer of that call is remembered against the picture (its length, and pieces of its start, middle and end), and the right-click menu in the main
  // process asks window.__aionDx.imagePathAt(x, y) for the path of the picture that was clicked ("Open image location").
  var imagePaths = {}, imageKeys = [];
  var IMAGE_RE = /\/api\/fs\/image-base64(?:[?#]|$)/;
  function imageKey(src) {
    src = String(src || '');
    var m = src.length >> 1;
    return src.length + ':' + src.slice(0, 48) + src.slice(m, m + 48) + src.slice(-48);
  }
  function rememberImage(dataUrl, path) {
    var p = String(path || '');
    if (!/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(p)) return;
    var k = imageKey(dataUrl);
    if (!imagePaths[k]) { imageKeys.push(k); if (imageKeys.length > 400) delete imagePaths[imageKeys.shift()]; }
    imagePaths[k] = p;
  }
  function tapImage(init) {
    return function (r) {
      try {
        var p = null;
        try { p = JSON.parse(init && init.body).path; } catch (e) { /* not our shape */ }
        if (p && r && r.ok) r.clone().json().then(function (j) {
          var d = j && j.data !== undefined ? j.data : j;
          if (typeof d === 'string' && d.length > 20) rememberImage(d, p);
        }, function () {});
      } catch (e) { /* the answer goes on as it is */ }
      return r;
    };
  }
  function imagePathAt(x, y) {
    var el = lastContext && Date.now() - lastContext.at < 3000 ? lastContext.el : document.elementFromPoint(x, y);
    var img = el && el.tagName === 'IMG' ? el : (el && el.closest ? el.closest('img') : null);
    if (!img && el && el.querySelector) img = el.querySelector('img');
    if (!img) return '';
    var src = img.currentSrc || img.src || '';
    if (/^file:/i.test(src)) return decodeLinkPath(src);
    return imagePaths[imageKey(src)] || '';
  }

  // Team members started from this page. A member should start when you message it or press its wake pill, and the page asks for it by POST
  // /api/teams/{id}/agents/{slot}/attach. On 2026-10-20 a member ran a turn on its own when a team page was opened (a day-old unread message of
  // yours was waiting in its mailbox); the page's request was the spark and nothing recorded what made it. Each such request is now written to the
  // diagnosis record with how long ago you last pressed a key or the mouse, and where the call came from.
  var ATTACH_RE = /\/api\/teams\/([^/?#]+)\/agents\/([^/?#]+)\/attach(?:[?#]|$)/;
  function noteAttach(input, init) {
    try {
      var m = ATTACH_RE.exec(reqUrl(input));
      if (!m || reqMethod(input, init) !== 'POST') return;
      var stack = String(new Error().stack || '').split('\n').slice(2, 8).map(function (l) { return l.trim().slice(0, 110); });
      diagnose('team-attach', m[2].slice(0, 8) + '@' + Date.now(), { slot: m[2].slice(0, 8), sinceGestureMs: lastGestureAt ? Date.now() - lastGestureAt : null, stack: stack });
    } catch (e) { /* a note must never stop the call */ }
  }

  // ---------------------------------------------------------------- opening a team does not wake it (P-011)

  // a request of 2026-09-24 Opening a
  // team page calls POST /api/teams/{id}/session (useTeamWarmup; TeamPermissionContext calls it
  // too, as a head start before a mode or model change). For a team with no session yet, as after
  // every AionUi restart, that starts one, attaches the lead and queues the lead's unread mailbox
  // as work (aionui-team service.rs ensure_session_inner, try_start_recovery_drain), so the lead
  // takes turns and wakes its teammates. Nothing needs that call: every real send (the owner's, the
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

  // A request of 2026-09-26: agents must not start on their own just because a team window or a chat is viewed ("Don't
  // start chats on open"). Opening a solo chat sends POST /api/conversations/{id}/runtime/ensure from five hooks on
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

  // A request of 2026-09-26, from a tester's install: the model pickers showed "Fable", "Opus", "Sonnet", the version only on
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
    // A request of 2026-10-12 (another PC): after Claude Code moved to Haiku 5.5 the pickers still said "Haiku 4.5". The agents answer holds
    // every agent, a disabled one included, and the last one read won; the disabled built-in still had the old list. Disabled agents are
    // now skipped, and a name whose agents disagree within one answer (two accounts offered different Fables) goes back to plain.
    var seen = {};
    var visit = function (node, depth) {
      if (!node || typeof node !== 'object' || depth > 8) return;
      if (Array.isArray(node)) { node.forEach(function (x) { visit(x, depth + 1); }); return; }
      if ((node.enabled === false || node.enabled === 0) && (node.backend !== undefined || node.agent_id !== undefined)) return;
      var name = node.name || node.label, desc = node.description;
      if (typeof name === 'string' && typeof desc === 'string' && (node.value !== undefined || node.id !== undefined)) {
        var v = versionedName(name, desc);
        if (v) { if (!seen[name]) seen[name] = {}; seen[name][v] = true; }
      }
      Object.keys(node).forEach(function (k) { if (node[k] && typeof node[k] === 'object') visit(node[k], depth + 1); });
    };
    visit(json, 0);
    Object.keys(seen).forEach(function (name) {
      var vs = Object.keys(seen[name]);
      if (vs.length === 1) { if (modelLabels[name] !== vs[0]) { modelLabels[name] = vs[0]; changed = true; } }
      else if (modelLabels[name] !== undefined) { delete modelLabels[name]; changed = true; }
    });
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
  // A message the backend did not accept is never lost (2026-11-01). While a confirmation (leave plan mode, a permission) was waiting,
  // the backend refused a message with 409, and AionUi cleared the box and showed nothing: the text was in no transcript and no up-arrow
  // history. Now a 409 on a chat's message holds the text and sends it as soon as the confirmation is answered (15 minutes at most);
  // any other refusal puts the text back in the box, with the reason.
  function unsentTarget(url) {
    var all = targets();
    var c = /\/api\/conversations\/([^/?#]+)\/messages/.exec(url);
    if (c) { for (var i = 0; i < all.length; i++) if (all[i].kind === 'conv' && all[i].convId === c[1]) return all[i]; return null; }
    var m = /\/api\/teams\/([^/?#]+)(?:\/agents\/([^/?#]+))?\/messages/.exec(url);
    if (!m) return null;
    for (var j = 0; j < all.length; j++) {
      if (all[j].kind !== 'team' || all[j].teamId !== m[1]) continue;
      if (m[2] ? all[j].slotId === decodeURIComponent(m[2]) : isLeadRole(all[j].role)) return all[j];
    }
    return null;
  }
  function restoreUnsent(url, text, why) {
    var t = unsentTarget(url);
    var box = t ? draftBox(t) : null;
    if (box) {
      var cur = String(box.value || '');
      setComposerValue(box, cur.trim() ? text + '\n\n' + cur : text);
      toast('Your message was not sent: ' + why + '. It is back in the box.', '"' + quoteOf(text) + '"');
    } else {
      toast('Your message was not sent: ' + why + '.', '"' + quoteOf(text) + '"');
    }
  }
  function holdUnsent(input, init, text) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var m = /\/api\/conversations\/([^/?#]+)\/messages/.exec(url);
    var started = Date.now();
    toast('A confirmation is waiting, so your message is held.', 'Answer it and the message goes in: "' + quoteOf(text) + '"');
    function again() {
      if (Date.now() - started > 15 * 60000) { restoreUnsent(url, text, 'the confirmation was not answered in 15 minutes'); return; }
      setTimeout(function () {
        nativeFetch.call(window, apiUrl('/api/conversations/' + m[1] + '/confirmations'), { credentials: 'include' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            var d = j && (j.data !== undefined ? j.data : j);
            var list = Array.isArray(d) ? d : d && (d.items || d.confirmations);
            if (Array.isArray(list) && list.length) return again();
            return nativeFetch.call(window, input, init).then(function (r2) {
              if (r2.ok) { toast('Your message went in.', '"' + quoteOf(text) + '"'); return; }
              if (r2.status === 409) return again();
              restoreUnsent(url, text, 'HTTP ' + r2.status);
            });
          }, function () { again(); });
      }, 2000);
    }
    again();
  }
  function recoverSend(input, init, r) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var text = sentText(init);
    if (text === null || !text.trim() || isPluginCommand(text) || r.status === 401 || r.status === 403) return;
    if (r.status === 409 && /\/api\/conversations\/[^/?#]+\/messages/.test(url)) { holdUnsent(input, init, text); return; }
    restoreUnsent(url, text, 'HTTP ' + r.status);
  }
  function guardFetch() {
    window.fetch = function (input, init) {
      var args = arguments;
      var id;
      try {
        if (!disabled()) {
          if ((id = callId(TEAM_SESSION_RE, input, init, ['POST']))) return holdTeamWake(id, args);
          if (pendingAccount && String((init && init.method) || (input && input.method) || 'GET').toUpperCase() === 'POST' &&
              CREATE_RE.test(String(typeof input === 'string' ? input : (input && input.url) || '').replace(/^https?:\/\/[^/]+/, ''))) {
            return nativeFetch.apply(window, args).then(tagNewChat);
          }
          if (callId(IMAGE_RE, input, init, ['POST'])) return nativeFetch.apply(window, args).then(tapImage(init));
          if ((id = callId(OLDER_RE, input, init, ['GET']))) return pacedOlderPage(id, args);
          noteAttach(input, init);
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
              else { try { recoverSend(input, init, r); } catch (e) {} }
              return r;
            });
          }
          if (callId(ANY_SEND_RE, input, init, ['POST'])) {
            return nativeFetch.apply(window, args).then(function (r) {
              if (!r.ok) { try { recoverSend(input, init, r); } catch (e) { /* the real answer goes back as it is */ } }
              return r;
            });
          }
        }
      } catch (e) { /* the real call, as stock */ }
      return nativeFetch.apply(window, args);
    };
  }
  guardFetch();
  installLinkRouting();

  // ---------------------------------------------------------------- Claude Docs inside AionDX (R-110)

  // A Claude Doc link (claude.ai, an /artifact/ or /docs/ address) opens in a pane docked at the right of the window, as the Claude app shows a
  // doc, instead of the system browser. The main process (patches/0009-identity/aiondx-docs.js) puts a claude.ai view in the space this code
  // reserves: the page narrows by the pane's width, this code draws the header (the doc's title, Open in browser, Reload, Close) and a drag edge
  // to resize it, and sends the view's rectangle whenever the window or the width changes. The pane keeps its own claude.ai sign-in: the first doc
  // shows claude.ai's sign-in in the pane once. Option links.docs ('pane' or 'browser'); Alt+click uses the other.
  var DOCS_W_KEY = KEY_PREFIX + 'docs.width';
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  var docsPane = null;           // { box, title, width } while open
  function isDocLink(href) {
    return /^https:\/\/([a-z0-9-]+\.)?claude\.ai\/(.*\/)?(artifact|artifacts|docs)\//i.test(href || '');
  }
  function docsZoom() {
    // Bounds go to the main process in window units; the page may be zoomed (Ctrl+wheel), which makes a CSS pixel bigger or smaller.
    var z = window.outerWidth && window.innerWidth ? window.outerWidth / window.innerWidth : 1;
    return z > 0.4 && z < 4 && Math.abs(z - 1) > 0.03 ? z : 1;
  }
  function docsWidth() {
    var saved = Number(lsGet(DOCS_W_KEY)) || 0;
    var w = saved || Math.round(window.innerWidth * 0.45);
    return Math.max(360, Math.min(w, window.innerWidth - 320));
  }
  function docsStyle(w) {
    var st = document.getElementById('aiondx-docs-style');
    if (!st) { st = document.createElement('style'); st.id = 'aiondx-docs-style'; document.head.appendChild(st); }
    st.textContent = w ? [
      '#root{width:calc(100vw - ' + w + 'px)!important;max-width:calc(100vw - ' + w + 'px)!important}',
      '.aiondx-docs{position:fixed;top:0;right:0;bottom:0;box-sizing:border-box;width:' + w + 'px;z-index:900;display:flex;flex-direction:column;',
      '  background:var(--color-bg-1,#fff);border-left:1px solid var(--color-border-2,rgba(0,0,0,.12))}',
      '.aiondx-docs-head{flex:0 0 36px;display:flex;align-items:center;gap:6px;padding:0 8px 0 12px;border-bottom:1px solid var(--color-border-2,rgba(0,0,0,.12));',
      '  font-size:13px;color:var(--color-text-1)}',
      '.aiondx-docs-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}',
      '.aiondx-docs-btn{flex:0 0 auto;border:0;background:transparent;color:var(--color-text-2);cursor:pointer;border-radius:4px;padding:4px 8px;font-size:12px}',
      '.aiondx-docs-btn:hover{background:var(--color-fill-2,rgba(0,0,0,.06));color:var(--color-text-1)}',
      '.aiondx-docs-body{flex:1 1 auto;position:relative}',
      '.aiondx-docs-note{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--color-text-3);font-size:13px}',
      '.aiondx-docs-edge{position:absolute;left:-3px;top:0;bottom:0;width:6px;cursor:col-resize;z-index:1}',
      '.aiondx-docs-edge:hover,.aiondx-docs-edge.on{background:rgb(var(--primary-6,22,93,255));opacity:.5}',
    ].join('\n') : '';
  }
  function docsBounds() {
    if (!docsPane) return null;
    var r = docsPane.body.getBoundingClientRect(), z = docsZoom();
    return { x: r.left * z, y: r.top * z, width: r.width * z, height: r.height * z };
  }
  function docsPlace() {
    if (!docsPane || !window.aiondxDocs) return;
    var b = docsBounds();
    if (b) window.aiondxDocs.bounds(b);
  }
  function closeDocsPane() {
    if (!docsPane) return;
    if (window.aiondxDocs) window.aiondxDocs.close();
    if (docsPane.box.parentNode) docsPane.box.parentNode.removeChild(docsPane.box);
    docsPane = null;
    docsStyle(0);
    window.dispatchEvent(new Event('resize'));
  }
  function openDocsPane(href) {
    if (!window.aiondxDocs) return openInBrowser(href);
    docsListen();
    if (!docsPane) {
      var w = docsWidth();
      docsStyle(w);
      var box = document.createElement('div');
      box.className = 'aiondx-docs';
      box.setAttribute('role', 'complementary');
      box.setAttribute('aria-label', 'Claude Doc');
      box.innerHTML = '<div class="aiondx-docs-edge" title="Drag to resize"></div>' +
        '<div class="aiondx-docs-head"><span class="aiondx-docs-title">Claude Doc</span>' +
        '<button type="button" class="aiondx-docs-btn" data-act="external" title="Open this doc in your browser">Open in browser</button>' +
        '<button type="button" class="aiondx-docs-btn" data-act="reload" title="Reload the doc">Reload</button>' +
        '<button type="button" class="aiondx-docs-btn" data-act="close" title="Close the doc" aria-label="Close">✕</button></div>' +
        '<div class="aiondx-docs-body"><div class="aiondx-docs-note">Opening the doc…</div></div>';
      document.body.appendChild(box);
      docsPane = { box: box, title: box.querySelector('.aiondx-docs-title'), body: box.querySelector('.aiondx-docs-body'), width: w };
      box.querySelector('.aiondx-docs-head').addEventListener('click', function (ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
        if (!b) return;
        var act = b.getAttribute('data-act');
        if (act === 'close') closeDocsPane();
        else if (act === 'external') window.aiondxDocs.external();
        else if (act === 'reload') window.aiondxDocs.reload();
      });
      var edge = box.querySelector('.aiondx-docs-edge');
      edge.addEventListener('pointerdown', function (ev) {
        ev.preventDefault();
        edge.setPointerCapture(ev.pointerId);
        edge.classList.add('on');
        var move = function (e) {
          if (!docsPane) return;
          var nw = Math.max(360, Math.min(window.innerWidth - e.clientX, window.innerWidth - 320));
          docsPane.width = Math.round(nw);
          docsStyle(docsPane.width);
          docsPlace();
        };
        var done = false;
        var up = function () {
          if (done) return;
          done = true;
          edge.classList.remove('on');
          edge.removeEventListener('pointermove', move);
          edge.removeEventListener('pointerup', up);
          edge.removeEventListener('lostpointercapture', up);
          document.removeEventListener('pointerup', up, true);
          if (docsPane) lsSet(DOCS_W_KEY, String(docsPane.width));
          window.dispatchEvent(new Event('resize'));
        };
        edge.addEventListener('pointermove', move);
        edge.addEventListener('pointerup', up);
        // the release can land elsewhere (over the doc's own view, which the page never hears from): the end of the capture ends the drag too
        edge.addEventListener('lostpointercapture', up);
        document.addEventListener('pointerup', up, true);
      });
      window.dispatchEvent(new Event('resize'));
    }
    var b = docsBounds();
    return window.aiondxDocs.open(href, b).then(function (r) {
      if (!r || !r.ok) { closeDocsPane(); toast('Could not open the doc inside AionDX; opening it in your browser.', r && r.error); openInBrowser(href); }
      return !!(r && r.ok);
    }, function () { closeDocsPane(); openInBrowser(href); return false; });
  }
  var docsListening = false;
  function docsListen() {
    if (docsListening || !window.aiondxDocs) return;
    docsListening = true;
    window.aiondxDocs.onEvent(function (d) {
      if (!docsPane || !d || d.kind !== 'state') return;
      if (!d.open) return;
      var note = docsPane.body.querySelector('.aiondx-docs-note');
      if (note && !d.loading) note.parentNode.removeChild(note);
      docsPane.title.textContent = d.signIn ? 'Sign in to Claude (once; AionDX remembers it)' : (d.title || 'Claude Doc').replace(/\s*[-|–]\s*Claude\s*$/, '');
    });
  }
  function installDocsPane() {
    window.addEventListener('resize', function () { if (docsPane) { docsStyle(docsPane.width = Math.max(360, Math.min(docsPane.width, window.innerWidth - 320))); docsPlace(); } });
    document.addEventListener('keydown', function (ev) {
      if (docsPane && ev.key === 'Escape' && ev.target && ev.target.closest && ev.target.closest('.aiondx-docs')) closeDocsPane();
    }, true);
  }
  installDocsPane();

  // ---------------------------------------------------------------- what's new (R-107, a request of 2026-11-13)

  // Once after an update, a small card in the corner names each new thing and says exactly how to use it, in a line or two: "VERY CLEAR, VERY
  // CONCISE, AND DIRECT ABOUT HOW TO INTERACT WITH THE NEW FEATURE". No steps for the user to carry out by hand: anything that needed doing was
  // done by the update. Shown once per release (aionui.dx.whatsnew.seen); Got it or the close button puts it away. A brand-new install, which
  // opens on the Welcome screen, marks it seen without showing it.
  var WHATS_NEW = {
    release: '0.27.5',
    items: [
      ['DX Docs', 'Ask your agent for a document, report or plan: it appears in the right-hand sidebar and fills in as you watch. Select text in it to comment; the agent is told. Edit, earlier versions and PDF are in its bar.'],
      ['More Claude accounts', 'On the new-chat page, click + Add account at the end of the agent row. Name the account, choose what it may do, and sign in on the page that opens; AionDX checks the key and adds a pill for it.'],
    ],
  };
  var WHATS_NEW_KEY = KEY_PREFIX + 'whatsnew.seen';
  // Decided at load (so a reload inside the delay cannot show it twice); shown 3 seconds later.
  function whatsNewDue() {
    var seen = null;
    try { seen = localStorage.getItem(WHATS_NEW_KEY); } catch (e) { return false; }
    if (seen === WHATS_NEW.release || disabled()) return false;
    var fresh = !seen && !Object.keys(localStorage).some(function (k) { return k.indexOf(KEY_PREFIX) === 0 && k !== WHATS_NEW_KEY; });
    try { localStorage.setItem(WHATS_NEW_KEY, WHATS_NEW.release); } catch (e) {}
    return !fresh && WHATS_NEW.items.length > 0;
  }
  function showWhatsNew() {
    if (document.querySelector('[data-testid="aiondx-whatsnew"]')) return;
    var card = gEl('div', 'aiondx-whatsnew');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'New in AionDX ' + WHATS_NEW.release);
    card.setAttribute('data-testid', 'aiondx-whatsnew');
    var head = gEl('div', 'aiondx-whatsnew-head');
    head.appendChild(gEl('span', 'aiondx-whatsnew-title', 'New in AionDX ' + WHATS_NEW.release));
    var x = gEl('button', 'aiondx-whatsnew-x', '✕');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');
    head.appendChild(x);
    card.appendChild(head);
    WHATS_NEW.items.forEach(function (it) {
      var row = gEl('div', 'aiondx-whatsnew-item');
      row.appendChild(gEl('div', 'aiondx-whatsnew-name', it[0]));
      row.appendChild(gEl('div', 'aiondx-whatsnew-how', it[1]));
      card.appendChild(row);
    });
    var ok = gEl('button', 'arco-btn arco-btn-primary arco-btn-size-small aiondx-whatsnew-ok', 'Got it');
    ok.type = 'button';
    card.appendChild(ok);
    var close = function () { if (card.parentNode) card.parentNode.removeChild(card); };
    x.addEventListener('click', close);
    ok.addEventListener('click', close);
    var st = document.getElementById('aiondx-whatsnew-style') || document.createElement('style');
    st.id = 'aiondx-whatsnew-style';
    st.textContent = [
      '.aiondx-whatsnew{position:fixed;right:16px;bottom:16px;z-index:1200;box-sizing:border-box;width:340px;padding:12px 14px 14px;border-radius:10px;',
      '  background:var(--color-bg-popup,var(--color-bg-1,#fff));border:1px solid var(--color-border-2,rgba(0,0,0,.12));box-shadow:0 8px 28px rgba(0,0,0,.2)}',
      '.aiondx-whatsnew-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}',
      '.aiondx-whatsnew-title{font-size:14px;font-weight:600;color:var(--color-text-1)}',
      '.aiondx-whatsnew-x{border:0;background:transparent;color:var(--color-text-3);cursor:pointer;font-size:13px;padding:2px 6px;border-radius:4px}',
      '.aiondx-whatsnew-x:hover{background:var(--color-fill-2,rgba(0,0,0,.06))}',
      '.aiondx-whatsnew-item{margin:0 0 10px}',
      '.aiondx-whatsnew-name{font-size:13px;font-weight:600;color:var(--color-text-1);margin-bottom:2px}',
      '.aiondx-whatsnew-how{font-size:12.5px;line-height:1.45;color:var(--color-text-2)}',
      '.aiondx-whatsnew-ok{margin-top:2px}',
    ].join('\n');
    if (!st.parentNode) document.head.appendChild(st);
    document.body.appendChild(card);
  }
  if (whatsNewDue()) setTimeout(showWhatsNew, 3000);

  // ---------------------------------------------------------------- tips: a bubble pointing at each AionDX control (a request of 2026-11-13)

  // "new features [should] receive bubble callout popups the user can dismiss as they want, but otherwise popup when they go to a new screen until
  // they do". Each tip points at its control the first time that control is on screen: what it is and how to use it, in two sentences. Got it (or
  // the close button) puts that tip away for good; a click anywhere else hides it on this screen only, and it comes back on the next screen where
  // its control shows. One tip at a time. Option help.tips switches them all off. The harness page switches them off for the other tests
  // (window.__aionDxTips === false) and on for its own.
  var COACH_TIPS = [
    { id: 'bell', sel: '[data-testid="aiondx-bell"]', title: 'Notices for this chat',
      text: 'A red number on the bell means something here needs you, like reconnecting an agent so it gets Claude Docs. Click it to see what and why; nothing restarts unless you click.' },
    { id: 'docs-link', find: function () {
        var as = document.querySelectorAll('a[href*="claude.ai"]');
        for (var i = 0; i < as.length; i++) if (isDocLink(as[i].href) && !as[i].closest('[class*="aiondx"]') && coachVisible(as[i])) return as[i];
        return null;
      }, title: 'Claude Docs open right here',
      text: 'Click a Claude Doc link to read it in a pane beside the chat. Drag the pane’s left edge to resize it, ✕ closes it, and Alt+click opens a doc in your browser instead.' },
    { id: 'loop', sel: '[data-testid="aiondx-loop"]', title: 'The Loop',
      text: 'While it is on, it tells the agent to keep going each time it stops with nothing left to do. Click to switch it on or off; hover it to see what it is doing.' },
    // 'ctx2': the first version (0.27.2) said the snowflake meant a warm cache; a new id shows the corrected tip to those who put it away
    { id: 'ctx2', sel: '.context-usage-indicator', title: 'How full this chat is',
      text: 'The ring fills as the chat\u2019s memory fills. A blue snowflake on it means the chat\u2019s cache has expired, so your next message costs more and starts slower. Hover the ring for the times.' },
    { id: 'account', sel: '[data-testid="aiondx-account"]', title: 'Which Claude account',
      text: 'This chat runs on the account named here. Click it to move the chat to another account, for example when one reaches its limit.' },
    { id: 'sched', sel: '[data-testid="aiondx-sched-btn"]', title: 'Schedule send',
      text: 'Type a message, then click this to pick a time; it is sent then. A number on it counts the messages waiting.' },
    { id: 'bolt', sel: '[data-testid="aiondx-solo-bolt"]', title: 'Answer this now',
      text: 'Shows while the agent works and you have typed something. Click it to stop the agent’s current step and have it answer you right away; Enter instead waits for its next step.' },
    { id: 'menu', sel: '[data-testid="aiondx-chat-menu"]', title: 'This chat’s menu',
      text: 'The same menu you get by right-clicking the chat in the list on the left.' },
    { id: 'dxdocs', sel: '[data-testid="aiondx-dx"] .dx-tab[data-tab="docs"]', title: 'DX Docs',
      text: 'Documents your agent writes appear here and fill in as you watch. Select text in a doc to comment (the agent is told), or press Edit. Files is the next tab.' },
    { id: 'add-account', sel: '[data-testid="aiondx-add-account"]', title: 'Add another Claude account',
      text: 'Click to sign in another Claude account; you choose what it may do before the sign-in page opens. It then gets its own pill here and shows in every chat\u2019s account button.' },
    { id: 'groups', sel: '[data-testid="aiondx-group-new"]', title: 'Groups',
      text: 'Make a group to keep related chats and teams together in this list.' },
    { id: 'drive', sel: '[data-testid="aiondx-drive-move"]', title: 'Chats on a drive',
      text: 'Moves all your chats to another drive or a USB drive. AionDX then works from there, and the drive carries them to another PC.' },
    { id: 'signin', sel: '[data-testid="aiondx-signin-open"]', title: 'Sign in your agents',
      text: 'Sign each Claude account in once here; Claude Docs and your claude.ai skills come with that sign-in.' },
  ];
  var COACH_DONE_KEY = KEY_PREFIX + 'tips.done';
  var coachShown = null;            // { tip, el, target }
  var coachScreen = '', coachHidden = {}, coachScreenAt = 0;
  function coachOn() {
    if (window.__aionDxTips === false || disabled()) return false;
    try { return opt('help.tips') !== false; } catch (e) { return true; }
  }
  function coachDoneList() { try { return JSON.parse(localStorage.getItem(COACH_DONE_KEY)) || {}; } catch (e) { return {}; } }
  function coachDone(id) { var d = coachDoneList(); d[id] = Date.now(); try { localStorage.setItem(COACH_DONE_KEY, JSON.stringify(d)); } catch (e) {} }
  function coachVisible(el) {
    if (!el || !el.isConnected) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  }
  function coachTarget(tip) {
    if (tip.find) return tip.find();
    var el = document.querySelector(tip.sel);
    return coachVisible(el) ? el : null;
  }
  function coachHide() {
    if (!coachShown) return;
    if (coachShown.el.parentNode) coachShown.el.parentNode.removeChild(coachShown.el);
    if (coachShown.target) coachShown.target.classList.remove('aiondx-coach-target');
    coachShown = null;
  }
  function coachPlace() {
    if (!coachShown) return;
    var r = coachShown.target.getBoundingClientRect(), el = coachShown.el;
    var w = el.offsetWidth, h = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    var below = r.bottom + 10 + h <= vh - 8 || r.top - 10 - h < 8;
    var top = below ? r.bottom + 10 : r.top - 10 - h;
    var left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, vw - w - 8));
    el.style.top = Math.round(top) + 'px';
    el.style.left = Math.round(left) + 'px';
    el.classList.toggle('aiondx-coach--above', !below);
    var arrow = el.querySelector('.aiondx-coach-arrow');
    arrow.style.left = Math.round(Math.max(12, Math.min(r.left + r.width / 2 - left - 6, w - 24))) + 'px';
  }
  function coachShow(tip, target) {
    var el = gEl('div', 'aiondx-coach');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', tip.title);
    el.setAttribute('data-testid', 'aiondx-coach-' + tip.id);
    el.appendChild(gEl('span', 'aiondx-coach-arrow'));
    var head = gEl('div', 'aiondx-coach-head');
    head.appendChild(gEl('span', 'aiondx-coach-title', tip.title));
    var x = gEl('button', 'aiondx-coach-x', '✕');
    x.type = 'button';
    x.setAttribute('aria-label', 'Got it, do not show again');
    head.appendChild(x);
    el.appendChild(head);
    el.appendChild(gEl('div', 'aiondx-coach-text', tip.text));
    var ok = gEl('button', 'arco-btn arco-btn-primary arco-btn-size-mini aiondx-coach-ok', 'Got it');
    ok.type = 'button';
    el.appendChild(ok);
    var done = function (ev) { if (ev) { ev.preventDefault(); ev.stopPropagation(); } coachDone(tip.id); coachHide(); };
    x.addEventListener('click', done);
    ok.addEventListener('click', done);
    document.body.appendChild(el);
    target.classList.add('aiondx-coach-target');
    coachShown = { tip: tip, el: el, target: target };
    coachPlace();
  }
  function coachScreenKey() {
    var s = location.hash || '';
    // Settings pages, and which panel of a page is open, count as screens of their own
    var tab = document.querySelector('.arco-tabs-header-title-active, [role="tab"][aria-selected="true"]');
    return s + (tab ? '|' + (tab.textContent || '').trim().slice(0, 40) : '');
  }
  function coachRun() {
    if (!coachOn()) { coachHide(); return; }
    var key = coachScreenKey();
    if (key !== coachScreen) { coachScreen = key; coachHidden = {}; coachScreenAt = Date.now(); coachHide(); }
    if (coachShown) {
      if (!coachVisible(coachShown.target)) coachHide(); else coachPlace();
      return;
    }
    if (Date.now() - coachScreenAt < 1200) return;   // let a new screen settle first
    // never over another AionDX card or menu, or a dialog of AionUi's
    if (document.querySelector('.aiondx-bell-pop, [data-testid="aiondx-whatsnew"], .aiondx-menu, .aiondx-acct-menu, .arco-modal-wrapper:not([style*="display: none"]), .aiondx-docs')) return;
    var done = coachDoneList();
    for (var i = 0; i < COACH_TIPS.length; i++) {
      var tip = COACH_TIPS[i];
      if (done[tip.id] || coachHidden[tip.id]) continue;
      var target = coachTarget(tip);
      if (target) { coachShow(tip, target); return; }
    }
  }
  function coachInstall() {
    // A click anywhere else hides the tip on this screen only; it comes back on the next screen where its control shows.
    document.addEventListener('pointerdown', function (ev) {
      if (!coachShown || coachShown.el.contains(ev.target)) return;
      coachHidden[coachShown.tip.id] = true;
      coachHide();
    }, true);
    window.addEventListener('resize', coachPlace);
    var st = document.createElement('style');
    st.id = 'aiondx-coach-style';
    st.textContent = [
      '.aiondx-coach{position:fixed;z-index:1150;box-sizing:border-box;width:290px;padding:10px 12px 12px;border-radius:8px;',
      '  background:rgb(var(--primary-6,22,93,255));color:#fff;box-shadow:0 6px 22px rgba(0,0,0,.25);font-size:12.5px;line-height:1.45}',
      '.aiondx-coach-arrow{position:absolute;top:-6px;width:12px;height:12px;background:inherit;transform:rotate(45deg);border-radius:2px}',
      '.aiondx-coach--above .aiondx-coach-arrow{top:auto;bottom:-6px}',
      '.aiondx-coach-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;position:relative}',
      '.aiondx-coach-title{font-size:13px;font-weight:600}',
      '.aiondx-coach-x{border:0;background:transparent;color:rgba(255,255,255,.85);cursor:pointer;font-size:12px;padding:2px 4px;border-radius:4px}',
      '.aiondx-coach-x:hover{background:rgba(255,255,255,.18);color:#fff}',
      '.aiondx-coach-text{position:relative;margin-bottom:8px}',
      '.aiondx-coach-ok{position:relative;background:#fff!important;color:rgb(var(--primary-6,22,93,255))!important;border:0!important}',
      '.aiondx-coach-target{outline:2px solid rgb(var(--primary-6,22,93,255));outline-offset:2px;border-radius:6px}',
    ].join('\n');
    document.head.appendChild(st);
    setInterval(function () { if (document.visibilityState === 'visible') coachRun(); }, 700);
  }
  coachInstall();

  // ---------------------------------------------------------------- DX Docs in the chat's right-hand sidebar (R-121, a request of 2026-11-13)

  // AionDX's own living documents, Claude Docs' behaviour copied: an agent makes a doc as a skeleton of sections ("Writing: ..." until filled)
  // and fills them while the user watches here, live; the user comments on a passage (the comment goes to the chat's agent), edits the
  // Markdown, goes back to an earlier version, exports a PDF. The sidebar is AionUi's workspace panel (files and changes); DX Docs takes it
  // over, with a Files tab to get AionUi's back. The docs are Markdown files in the DX Docs folder of the chat's project, else its working
  // folder (main process: aiondx-dxdocs-main.js and the engine dxdocs.js; the Markdown is drawn by aiondx-dxdocs-md.js).
  var DX_TAB_KEY = KEY_PREFIX + 'dx.tab';
  var dx = { el: null, conv: null, docsDir: null, view: 'list', doc: null, docs: [], md: '', editing: false, dirty: false, listening: false, opening: false, comments: [] };
  function dxApi(op, args) { return window.aiondxDx.call(op, Object.assign({ docsDir: dx.docsDir }, args || {})); }
  function dxSider() {
    var r = route();
    if (!r || r.kind !== 'conv' || disabled() || !window.aiondxDx || !window.__dxMd) return null;
    var s = document.querySelector('.chat-layout-right-sider');
    return s && !s.closest('.arco-layout-sider-left') ? s : null;
  }
  function dxCollapsed(s) { return !s || s.getBoundingClientRect().width < 60; }
  function dxExpand() {
    var s = dxSider();
    if (s && dxCollapsed(s)) window.dispatchEvent(new CustomEvent('aionui-workspace-toggle', { cancelable: true }));
  }
  function dxTab() { try { return localStorage.getItem(DX_TAB_KEY) || 'docs'; } catch (e) { return 'docs'; } }
  function dxSetTab(t) { try { localStorage.setItem(DX_TAB_KEY, t); } catch (e) {} if (dx.el) dx.el.classList.toggle('aiondx-dx--files', t === 'files'); dxPaintTabs(); }
  function dxPaintTabs() {
    if (!dx.el) return;
    var t = dxTab();
    dx.el.querySelectorAll('.dx-tab').forEach(function (b) { var on = b.getAttribute('data-tab') === t; b.classList.toggle('dx-tab--on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
  }
  /** Each repaint: the panel inside the sidebar of the open chat, or gone. */
  function renderDxPanel() {
    var s = dxSider();
    var conv = s ? route().id : null;
    if (!s) { if (dx.el && dx.el.parentNode) dx.el.parentNode.removeChild(dx.el); if (dx.docsDir && dx.conv) { window.aiondxDx && window.aiondxDx.call('unwatch', { docsDir: dx.docsDir }); } dx.conv = null; dx.docsDir = null; return; }
    if (!dx.el) dxBuild();
    if (dx.el.parentNode !== s) s.appendChild(dx.el);
    if (conv !== dx.conv) dxOpenChat(conv);
  }
  function dxBuild() {
    var el = document.createElement('div');
    el.className = 'aiondx-dx';
    el.setAttribute('data-testid', 'aiondx-dx');
    el.innerHTML = '<div class="dx-tabs" role="tablist"><button type="button" class="dx-tab" data-tab="docs" role="tab">DX Docs</button>' +
      '<button type="button" class="dx-tab" data-tab="files" role="tab">Files</button>' +
      '<button type="button" class="dx-hide" data-testid="aiondx-dx-hide" title="Hide the sidebar" aria-label="Hide the sidebar">\u21e5</button></div><div class="dx-main"></div>';
    el.querySelector('.dx-tabs').addEventListener('click', function (ev) {
      var b = ev.target.closest('.dx-tab');
      if (b) dxSetTab(b.getAttribute('data-tab'));
      // DX Docs covers the sidebar's own header, so it carries the sidebar's hide button (AionUi's own toggle)
      if (ev.target.closest('.dx-hide')) window.dispatchEvent(new CustomEvent('aionui-workspace-toggle', { cancelable: true }));
    });
    dx.el = el;
    dx.main = el.querySelector('.dx-main');
    el.classList.toggle('aiondx-dx--files', dxTab() === 'files');
    dxPaintTabs();
    // the Files tab sits over AionUi's own panel, at its top, so it can always come back
    if (!dx.listening) {
      dx.listening = true;
      window.aiondxDx.onEvent(function (e) { if (e && e.kind === 'changed' && e.docsDir === dx.docsDir) dxChanged(e.id); });
      document.addEventListener('selectionchange', dxSelection);
    }
  }
  async function dxOpenChat(conv) {
    if (dx.docsDir) window.aiondxDx.call('unwatch', { docsDir: dx.docsDir });
    dx.conv = conv; dx.docsDir = null; dx.view = 'list'; dx.doc = null; dx.editing = false; dx.docs = [];
    dx.main.innerHTML = '<div class="dx-empty">Opening this chat’s docs…</div>';
    var info = convInfo[conv];
    if (!info) { loadConvInfo(conv); for (var i = 0; i < 20 && !convInfo[conv]; i++) await new Promise(function (r) { setTimeout(r, 250); }); info = convInfo[conv]; }
    if (dx.conv !== conv) return;
    var w = await window.aiondxDx.call('where', { convId: conv, workspace: info ? info.workspace : '' });
    if (dx.conv !== conv) return;
    if (!w || !w.ok) { dx.main.innerHTML = '<div class="dx-empty"></div>'; dx.main.firstChild.textContent = (w && w.error) || 'No folder for docs.'; return; }
    dx.docsDir = w.docsDir;
    dx.where = w;
    window.aiondxDx.call('watch', { docsDir: dx.docsDir });
    await dxList();
  }
  function dxWhen(ms) { var d = new Date(ms); return d.toDateString() === new Date().toDateString() ? hhmm(ms) : longDate(ms); }
  async function dxList() {
    var r = await dxApi('list');
    dx.docs = r && r.ok ? r.docs : [];
    if (dx.view !== 'list') return;
    var m = dx.main;
    m.innerHTML = '<div class="dx-bar"><span class="dx-bar-title">DX Docs</span><button type="button" class="dx-btn" data-act="new">+ New doc</button></div><div class="dx-list" data-testid="aiondx-dx-list"></div>';
    var list = m.querySelector('.dx-list');
    if (!dx.docs.length) {
      var e = document.createElement('div');
      e.className = 'dx-empty';
      e.textContent = 'No docs in this chat yet. Ask the agent for a document, a report or a plan and it appears here as it is written; or press + New doc.';
      list.appendChild(e);
    }
    dx.docs.forEach(function (d) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'dx-row';
      row.setAttribute('data-doc', d.id);
      var t = document.createElement('span'); t.className = 'dx-row-title'; t.textContent = d.title;
      var meta = document.createElement('span'); meta.className = 'dx-row-meta';
      meta.textContent = dxWhen(d.modified) + (d.pending ? ' · ' + d.pending + ' to write' : '') + (d.openComments ? ' · ' + d.openComments + ' comment' + (d.openComments > 1 ? 's' : '') : '');
      row.appendChild(t); row.appendChild(meta);
      row.addEventListener('click', function () { dxOpen(d.id); });
      list.appendChild(row);
    });
    m.querySelector('[data-act="new"]').addEventListener('click', dxNew);
  }
  async function dxNew() {
    var title = window.prompt('Title of the new doc');
    if (!title || !title.trim()) return;
    var r = await dxApi('create', { title: title.trim() });
    if (r && r.ok) dxOpen(r.id); else toast('The doc was not made.', r && r.error);
  }
  async function dxOpen(id, keepScroll) {
    var r = await dxApi('read', { id: id });
    if (!r || !r.ok) { toast('That doc could not be read.', r && r.error); dx.view = 'list'; return dxList(); }
    var body = dx.view === 'doc' && dx.doc === id ? dx.main.querySelector('.dx-body') : null;
    var ratio = keepScroll && body && body.scrollHeight > body.clientHeight ? body.scrollTop / (body.scrollHeight - body.clientHeight) : null;
    var atEnd = keepScroll && body ? body.scrollTop + body.clientHeight >= body.scrollHeight - 30 : false;
    dx.view = 'doc'; dx.doc = id; dx.md = r.markdown; dx.comments = r.comments || []; dx.title = r.title || id;
    if (dx.editing) return dxEditingChanged();
    dxDrawDoc();
    var nb = dx.main.querySelector('.dx-body');
    if (nb && atEnd) nb.scrollTop = nb.scrollHeight;
    else if (nb && ratio !== null) nb.scrollTop = ratio * (nb.scrollHeight - nb.clientHeight);
  }
  function dxDrawDoc() {
    var m = dx.main;
    var open = dx.comments.filter(function (c) { return !c.resolved; }).length;
    m.innerHTML = '<div class="dx-bar"><button type="button" class="dx-btn dx-back" data-act="back" title="All docs">‹</button><span class="dx-bar-title"></span>' +
      '<button type="button" class="dx-btn" data-act="comments" title="Comments">Comments' + (open ? ' (' + open + ')' : '') + '</button>' +
      '<button type="button" class="dx-btn" data-act="edit">Edit</button><button type="button" class="dx-btn" data-act="more" title="History and export">⋯</button></div>' +
      '<div class="dx-body" data-testid="aiondx-dx-body"></div><div class="dx-comments" hidden></div>';
    m.querySelector('.dx-bar-title').textContent = dx.title;
    m.querySelector('.dx-body').innerHTML = window.__dxMd.toHtml(dx.md);
    m.querySelector('.dx-bar').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-act]');
      if (!b) return;
      var a = b.getAttribute('data-act');
      if (a === 'back') { dx.view = 'list'; dx.doc = null; dxList(); }
      else if (a === 'edit') dxEdit();
      else if (a === 'comments') dxComments(true);
      else if (a === 'more') dxMore(b);
    });
  }
  function dxChanged(id) {
    // a doc an agent made or changed: the sidebar opens (if shut) and shows it; the one on screen redraws in place
    var known = dx.docs.some(function (d) { return d.id === id; });
    if (dx.view === 'doc' && dx.doc === id) { dxOpen(id, true); return; }
    if (dx.view === 'list' || !known) {
      if (dxTab() !== 'docs') dxSetTab('docs');
      dxExpand();
      dxOpen(id);
      return;
    }
    dx.docs = dx.docs; // another doc changed while one is open: the list refreshes on the way back
  }
  function dxEdit() {
    dx.editing = true; dx.dirty = false; dx.theirs = null;
    var m = dx.main;
    m.innerHTML = '<div class="dx-bar"><span class="dx-bar-title"></span><button type="button" class="dx-btn" data-act="cancel">Cancel</button>' +
      '<button type="button" class="dx-btn dx-btn--primary" data-act="save">Save</button></div><div class="dx-note" hidden></div>' +
      '<textarea class="dx-edit" spellcheck="true" data-testid="aiondx-dx-edit"></textarea>';
    m.querySelector('.dx-bar-title').textContent = 'Editing ' + dx.title;
    var ta = m.querySelector('.dx-edit');
    ta.value = dx.md;
    ta.addEventListener('input', function () { dx.dirty = true; });
    ta.addEventListener('keydown', function (ev) { if ((ev.ctrlKey || ev.metaKey) && ev.key === 's') { ev.preventDefault(); dxSave(); } ev.stopPropagation(); });
    m.querySelector('.dx-bar').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-act]');
      if (!b) return;
      if (b.getAttribute('data-act') === 'save') dxSave();
      else { dx.editing = false; dxOpen(dx.doc); }
    });
    ta.focus();
  }
  function dxEditingChanged() {
    var n = dx.main.querySelector('.dx-note');
    if (!n) return;
    n.hidden = false;
    n.innerHTML = 'The agent changed this doc while you were editing. <button type="button" class="dx-btn" data-act="theirs">Show their version</button> <span>or Save to keep yours (theirs stays in the history).</span>';
    n.querySelector('[data-act="theirs"]').addEventListener('click', function () { dx.editing = false; dxOpen(dx.doc); });
  }
  async function dxSave() {
    var ta = dx.main.querySelector('.dx-edit');
    if (!ta) return;
    var r = await dxApi('save', { id: dx.doc, markdown: ta.value });
    if (!r || !r.ok) { toast('Not saved.', r && r.error); return; }
    dx.editing = false;
    dxOpen(dx.doc);
  }
  // ---- comments: select text in the doc, press Comment; it is kept with the doc and sent to the chat's agent
  var dxCommentBtn = null;
  function dxSelection() {
    if (!dx.el || dx.view !== 'doc' || dx.editing) { if (dxCommentBtn) dxCommentBtn.hidden = true; return; }
    var sel = window.getSelection ? window.getSelection() : null;
    var body = dx.main && dx.main.querySelector('.dx-body');
    var text = sel && !sel.isCollapsed ? String(sel).trim() : '';
    if (!text || !body || !body.contains(sel.anchorNode)) { if (dxCommentBtn) dxCommentBtn.hidden = true; return; }
    if (!dxCommentBtn) {
      dxCommentBtn = document.createElement('button');
      dxCommentBtn.type = 'button';
      dxCommentBtn.className = 'dx-comment-btn';
      dxCommentBtn.textContent = 'Comment';
      dxCommentBtn.setAttribute('data-testid', 'aiondx-dx-comment-btn');
      dxCommentBtn.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
      dxCommentBtn.addEventListener('click', function () { dxCommentBox(dxCommentBtn._quote, dxCommentBtn._section); });
      document.body.appendChild(dxCommentBtn);
    }
    var rr = sel.getRangeAt(0).getBoundingClientRect();
    dxCommentBtn._quote = text.slice(0, 2000);
    var h = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentNode);
    var sec = '';
    for (var n = h; n && n !== body; n = n.previousElementSibling || n.parentNode) { if (n.getAttribute && n.getAttribute('data-section') && /^H[1-6]$/.test(n.tagName)) { sec = n.getAttribute('data-section'); break; } }
    dxCommentBtn._section = sec;
    dxCommentBtn.style.top = Math.round(rr.bottom + 6) + 'px';
    dxCommentBtn.style.left = Math.round(Math.min(rr.left, window.innerWidth - 110)) + 'px';
    dxCommentBtn.hidden = false;
  }
  function dxCommentBox(quote, section) {
    if (dxCommentBtn) dxCommentBtn.hidden = true;
    dxComments(true, { quote: quote, section: section });
  }
  function dxComments(show, draft) {
    var box = dx.main.querySelector('.dx-comments');
    if (!box) return;
    box.hidden = !show;
    if (!show) return;
    box.innerHTML = '<div class="dx-comments-head"><span>Comments</span><button type="button" class="dx-btn" data-act="hide">✕</button></div><div class="dx-clist"></div>';
    box.querySelector('[data-act="hide"]').addEventListener('click', function () { box.hidden = true; });
    var list = box.querySelector('.dx-clist');
    if (draft) {
      var f = document.createElement('div');
      f.className = 'dx-cdraft';
      f.innerHTML = '<div class="dx-cquote"></div><textarea class="dx-ctext" placeholder="Your comment; the agent is told" data-testid="aiondx-dx-ctext"></textarea>' +
        '<div class="dx-crow"><button type="button" class="dx-btn" data-act="cancel">Cancel</button><button type="button" class="dx-btn dx-btn--primary" data-act="send" data-testid="aiondx-dx-csend">Send</button></div>';
      f.querySelector('.dx-cquote').textContent = '“' + draft.quote + '”';
      f.querySelector('.dx-ctext').addEventListener('keydown', function (ev) { ev.stopPropagation(); });
      f.querySelector('[data-act="cancel"]').addEventListener('click', function () { f.remove(); });
      f.querySelector('[data-act="send"]').addEventListener('click', function () { dxSendComment(draft, f.querySelector('.dx-ctext').value); });
      list.appendChild(f);
      setTimeout(function () { f.querySelector('.dx-ctext').focus(); }, 0);
    }
    if (!dx.comments.length && !draft) { var e = document.createElement('div'); e.className = 'dx-empty'; e.textContent = 'No comments. Select text in the doc and press Comment.'; list.appendChild(e); }
    dx.comments.slice().reverse().forEach(function (c) {
      var it = document.createElement('div');
      it.className = 'dx-citem' + (c.resolved ? ' dx-citem--done' : '');
      var q = document.createElement('div'); q.className = 'dx-cquote'; q.textContent = c.quote ? '“' + c.quote + '”' : (c.section || '');
      var t = document.createElement('div'); t.className = 'dx-ctext-shown'; t.textContent = c.text;
      it.appendChild(q); it.appendChild(t);
      (c.replies || []).forEach(function (rp) { var x = document.createElement('div'); x.className = 'dx-creply'; x.textContent = (rp.by === 'user' ? 'You: ' : 'Agent: ') + rp.text; it.appendChild(x); });
      if (c.resolved) { var d = document.createElement('div'); d.className = 'dx-cstate'; d.textContent = 'Resolved'; it.appendChild(d); }
      list.appendChild(it);
    });
  }
  async function dxSendComment(draft, text) {
    text = String(text || '').trim();
    if (!text) return;
    var r = await dxApi('comment', { id: dx.doc, quote: draft.quote, section: draft.section, text: text });
    if (!r || !r.ok) { toast('The comment was not saved.', r && r.error); return; }
    var msg = '[DX Doc comment] On "' + dx.title + '" (doc ' + dx.doc + (draft.section ? ', section "' + draft.section + '"' : '') + ', comment ' + r.comment.id + '):\n' +
      '> ' + draft.quote.replace(/\n/g, '\n> ') + '\n\n' + text + '\n\n(Answer with dxdoc_reply, and edit the doc with dxdoc_update when it asks for a change.)';
    var sent = await postJson('/api/conversations/' + dx.conv + '/messages', { content: msg }).catch(function () { return null; });
    if (!sent || !sent.ok) toast('The comment is saved with the doc, but the agent could not be told.', 'Send it a message to look at the doc’s comments.');
    dxOpen(dx.doc, true).then(function () { dxComments(true); });
  }
  function dxMore(anchor) {
    var old = document.querySelector('.dx-menu');
    if (old) { old.remove(); return; }
    var m = document.createElement('div');
    m.className = 'dx-menu';
    m.innerHTML = '<button type="button" data-act="history">Earlier versions</button><button type="button" data-act="pdf">Export as PDF</button><button type="button" data-act="reveal">Show the file</button>';
    var rc = anchor.getBoundingClientRect();
    m.style.top = Math.round(rc.bottom + 4) + 'px';
    m.style.right = Math.round(window.innerWidth - rc.right) + 'px';
    document.body.appendChild(m);
    var off = function (ev) { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('mousedown', off, true); } };
    setTimeout(function () { document.addEventListener('mousedown', off, true); }, 0);
    m.addEventListener('click', async function (ev) {
      var b = ev.target.closest('[data-act]');
      if (!b) return;
      m.remove();
      var a = b.getAttribute('data-act');
      if (a === 'reveal') dxApi('reveal', { id: dx.doc });
      else if (a === 'pdf') {
        var html = '<!doctype html><meta charset="utf-8"><title>' + window.__dxMd.esc(dx.title) + '</title><style>' + DX_PRINT_CSS + '</style>' + window.__dxMd.toHtml(dx.md);
        var r = await dxApi('pdf', { id: dx.doc, html: html });
        toast(r && r.ok ? 'Saved as PDF beside the doc.' : 'The PDF was not made.', r && (r.path || r.error));
      } else if (a === 'history') dxHistory();
    });
  }
  async function dxHistory() {
    var r = await dxApi('history', { id: dx.doc });
    var vs = r && r.ok ? r.versions : [];
    var m = dx.main;
    m.innerHTML = '<div class="dx-bar"><button type="button" class="dx-btn dx-back" data-act="back">‹</button><span class="dx-bar-title"></span></div><div class="dx-list"></div>';
    m.querySelector('.dx-bar-title').textContent = 'Earlier versions of ' + dx.title;
    m.querySelector('[data-act="back"]').addEventListener('click', function () { dxOpen(dx.doc); });
    var list = m.querySelector('.dx-list');
    if (!vs.length) { var e = document.createElement('div'); e.className = 'dx-empty'; e.textContent = 'No earlier versions yet.'; list.appendChild(e); }
    vs.forEach(function (v) {
      var row = document.createElement('button');
      row.type = 'button'; row.className = 'dx-row';
      row.textContent = dxWhen(v.at) + (new Date(v.at).toDateString() === new Date().toDateString() ? ' today' : '');
      row.addEventListener('click', async function () {
        var x = await dxApi('version', { id: dx.doc, version: v.version });
        if (!x || !x.ok) return;
        m.innerHTML = '<div class="dx-bar"><button type="button" class="dx-btn dx-back" data-act="back">‹</button><span class="dx-bar-title"></span>' +
          '<button type="button" class="dx-btn dx-btn--primary" data-act="restore">Restore this version</button></div><div class="dx-body"></div>';
        m.querySelector('.dx-bar-title').textContent = 'Version of ' + row.textContent;
        m.querySelector('.dx-body').innerHTML = window.__dxMd.toHtml(x.markdown);
        m.querySelector('[data-act="back"]').addEventListener('click', dxHistory);
        m.querySelector('[data-act="restore"]').addEventListener('click', async function () {
          var rr = await dxApi('restore', { id: dx.doc, version: v.version });
          if (rr && rr.ok) dxOpen(dx.doc); else toast('Not restored.', rr && rr.error);
        });
      });
      list.appendChild(row);
    });
  }
  var DX_PRINT_CSS = 'body{font:12pt/1.5 Segoe UI,Arial,sans-serif;color:#111;margin:0}h1{font-size:22pt;margin:0 0 12pt}h2{font-size:15pt;margin:16pt 0 6pt}' +
    'h3{font-size:12.5pt}table{border-collapse:collapse;margin:8pt 0}td,th{border:1px solid #bbb;padding:4pt 7pt}pre{background:#f4f4f4;padding:8pt;white-space:pre-wrap}' +
    'code{font-family:Consolas,monospace}.dx-pending{color:#888;font-style:italic}blockquote{border-left:3px solid #ccc;margin:0;padding-left:10pt;color:#444}';
  (function dxStyle() {
    var st = document.createElement('style');
    st.id = 'aiondx-dx-style';
    st.textContent = [
      '.aiondx-dx{position:absolute;inset:0;z-index:6;display:flex;flex-direction:column;background:var(--color-bg-1,#fff);color:var(--color-text-1)}',
      // Files: AionUi's own panel, whole; the switch back is a small pill at the bottom right
      '.aiondx-dx--files{inset:auto 10px 10px auto;background:transparent}',
      '.aiondx-dx--files .dx-main,.aiondx-dx--files .dx-hide{display:none}',
      '.aiondx-dx--files .dx-tabs{flex:0 0 auto;align-items:center;padding:2px 4px;border:1px solid var(--color-border-2,rgba(0,0,0,.12));border-radius:16px;background:var(--color-bg-1,#fff);box-shadow:0 2px 8px rgba(0,0,0,.12)}',
      '.aiondx-dx--files .dx-tab{border-bottom:0;padding:4px 10px;border-radius:12px}',
      '.dx-hide{margin-left:auto;align-self:center;border:0;background:transparent;color:var(--color-text-3);cursor:pointer;font-size:14px;padding:2px 6px;border-radius:4px}',
      '.dx-hide:hover{background:var(--color-fill-2,rgba(0,0,0,.06));color:var(--color-text-1)}',
      '.dx-tabs{flex:0 0 34px;display:flex;align-items:flex-end;gap:2px;padding:0 10px;border-bottom:1px solid var(--color-border-2,rgba(0,0,0,.1))}',
      '.dx-tab{border:0;background:transparent;padding:6px 10px;font-size:12.5px;color:var(--color-text-3);cursor:pointer;border-bottom:2px solid transparent}',
      '.dx-tab--on{color:var(--color-text-1);border-bottom-color:rgb(var(--primary-6,22,93,255));font-weight:600}',
      '.dx-main{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;position:relative}',
      '.dx-bar{flex:0 0 38px;display:flex;align-items:center;gap:4px;padding:0 8px 0 12px;border-bottom:1px solid var(--color-border-1,rgba(0,0,0,.06))}',
      '.dx-bar-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600}',
      '.dx-btn{flex:0 0 auto;border:0;background:transparent;color:var(--color-text-2);cursor:pointer;border-radius:5px;padding:4px 8px;font-size:12px}',
      '.dx-btn:hover{background:var(--color-fill-2,rgba(0,0,0,.06));color:var(--color-text-1)}',
      '.dx-btn--primary{background:rgb(var(--primary-6,22,93,255));color:#fff}',
      '.dx-btn--primary:hover{background:rgb(var(--primary-5,64,128,255));color:#fff}',
      '.dx-back{font-size:16px;padding:2px 8px}',
      '.dx-list{flex:1 1 auto;overflow:auto;padding:6px}',
      '.dx-row{display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;border:0;background:transparent;text-align:left;padding:8px 10px;border-radius:6px;cursor:pointer}',
      '.dx-row:hover{background:var(--color-fill-2,rgba(0,0,0,.05))}',
      '.dx-row-title{font-size:13px;font-weight:600;color:var(--color-text-1)}',
      '.dx-row-meta{font-size:11.5px;color:var(--color-text-3)}',
      '.dx-empty{padding:16px;font-size:12.5px;line-height:1.5;color:var(--color-text-3)}',
      '.dx-body{flex:1 1 auto;overflow:auto;padding:14px 18px 40px;font-size:13.5px;line-height:1.6;user-select:text}',
      '.dx-body h1{font-size:21px;margin:4px 0 12px}.dx-body h2{font-size:16px;margin:20px 0 6px}.dx-body h3{font-size:14px;margin:16px 0 4px}',
      '.dx-body p{margin:0 0 10px}.dx-body ul,.dx-body ol{margin:0 0 10px;padding-left:22px}.dx-body li{margin:2px 0}',
      '.dx-body .dx-task{list-style:none;margin-left:-18px}',
      '.dx-body table{border-collapse:collapse;margin:6px 0 12px;font-size:12.5px}.dx-body td,.dx-body th{border:1px solid var(--color-border-2,#ddd);padding:4px 8px}',
      '.dx-body th{background:var(--color-fill-1,rgba(0,0,0,.03))}',
      '.dx-body pre{background:var(--color-fill-1,rgba(0,0,0,.04));padding:10px;border-radius:6px;overflow:auto;font-size:12px}',
      '.dx-body code{font-family:Consolas,monospace;font-size:.92em}',
      '.dx-body blockquote{margin:0 0 10px;padding-left:12px;border-left:3px solid var(--color-border-2,#ddd);color:var(--color-text-2)}',
      '.dx-body img{max-width:100%}',
      '.dx-pending{display:flex;align-items:center;gap:8px;margin:2px 0 12px;padding:8px 10px;border-radius:6px;font-size:12.5px;color:var(--color-text-3);',
      '  background:linear-gradient(90deg,var(--color-fill-1,rgba(0,0,0,.03)),var(--color-fill-2,rgba(0,0,0,.07)),var(--color-fill-1,rgba(0,0,0,.03)));background-size:200% 100%;animation:dx-shimmer 1.6s linear infinite}',
      '.dx-pending-dot{width:7px;height:7px;border-radius:50%;background:rgb(var(--primary-6,22,93,255));animation:dx-pulse 1.2s ease-in-out infinite}',
      '@keyframes dx-shimmer{0%{background-position:100% 0}100%{background-position:-100% 0}}',
      '@keyframes dx-pulse{0%,100%{opacity:.35}50%{opacity:1}}',
      '@media (prefers-reduced-motion: reduce){.dx-pending,.dx-pending-dot{animation:none}}',
      '.dx-edit{flex:1 1 auto;resize:none;border:0;outline:0;padding:12px 14px;font:12.5px/1.55 Consolas,monospace;background:var(--color-bg-1,#fff);color:var(--color-text-1)}',
      '.dx-note{padding:8px 12px;font-size:12px;background:rgba(var(--warning-6,255,125,0),.12);color:var(--color-text-1)}',
      '.dx-comments{flex:0 0 auto;max-height:45%;overflow:auto;border-top:1px solid var(--color-border-2,rgba(0,0,0,.1));background:var(--color-bg-2,var(--color-bg-1))}',
      '.dx-comments-head{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;font-size:12.5px;font-weight:600}',
      '.dx-clist{padding:0 10px 10px}',
      '.dx-citem,.dx-cdraft{padding:8px 10px;margin:0 0 8px;border-radius:6px;background:var(--color-fill-1,rgba(0,0,0,.03));font-size:12.5px}',
      '.dx-citem--done{opacity:.6}',
      '.dx-cquote{font-size:12px;color:var(--color-text-3);margin-bottom:4px;max-height:3.2em;overflow:hidden}',
      '.dx-creply{margin-top:4px;padding-left:8px;border-left:2px solid var(--color-border-2,#ddd);color:var(--color-text-2)}',
      '.dx-cstate{margin-top:4px;font-size:11px;color:var(--color-text-3)}',
      '.dx-ctext{width:100%;box-sizing:border-box;min-height:56px;resize:vertical;font:inherit;padding:6px;border-radius:5px;border:1px solid var(--color-border-2,#ccc);background:var(--color-bg-1,#fff);color:var(--color-text-1)}',
      '.dx-crow{display:flex;justify-content:flex-end;gap:6px;margin-top:6px}',
      '.dx-comment-btn{position:fixed;z-index:1200;border:0;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;background:rgb(var(--primary-6,22,93,255));color:#fff;box-shadow:0 3px 10px rgba(0,0,0,.2)}',
      '.dx-menu{position:fixed;z-index:1200;display:flex;flex-direction:column;min-width:170px;padding:4px;border-radius:8px;background:var(--color-bg-popup,var(--color-bg-1,#fff));border:1px solid var(--color-border-2,rgba(0,0,0,.12));box-shadow:0 6px 20px rgba(0,0,0,.18)}',
      '.dx-menu button{border:0;background:transparent;text-align:left;padding:7px 10px;font-size:12.5px;border-radius:5px;cursor:pointer;color:var(--color-text-1)}',
      '.dx-menu button:hover{background:var(--color-fill-2,rgba(0,0,0,.06))}',
    ].join('\n');
    document.head.appendChild(st);
  })();

  // ---------------------------------------------------------------- "+ Add account" on the new-chat page (R-119, a request of 2026-11-13)

  // At the end of the new-chat page's agent row: "+ Add account" opens a dialog that names the account and sets what it may do before
  // the sign-in starts (everything, chats only, or Anthropic Console; personal or work; Claude Docs and connectors; SSO; the email). The
  // main process (aiondx-accounts.js) signs it in to its own folder, checks the key it saved and adds it to the launcher's accounts; no key
  // reaches this page. Each added account then has a pill in the row, "Claude Code (<name>)": picking it selects the row's Claude agent and
  // marks the next chat for that account, written (aiondx.agent.conv.<id> = {agent: <account>}) when AionCore creates the chat and before
  // its agent starts (AionDX holds a new chat's start until its first message). The account also shows in every Claude chat's account menu.
  var ADDED_MARK = 'added';         // entries of aiondx.accounts that this flow (or Settings' sign-in) added; the first version's two have none
  var pendingAccount = null;        // the account picked on the new-chat page for the next chat
  var accDlg = null;
  function addedAccounts() {
    var list = accountsRec && Array.isArray(accountsRec.accounts) ? accountsRec.accounts : [];
    return list.filter(function (a) { return a && a.id && a[ADDED_MARK]; });
  }
  async function rememberAccount(id, label, kind) {
    var cur = await getJson('/api/settings/client?keys=' + encodeURIComponent(ACCOUNTS_KEY));
    var rec = (cur && cur.data && cur.data[ACCOUNTS_KEY]) || {};
    var list = Array.isArray(rec.accounts) ? rec.accounts.filter(function (a) { return a && a.id !== id; }) : [];
    var entry = { id: id, label: label, kind: kind };
    entry[ADDED_MARK] = true;
    list.push(entry);
    var body = {};
    body[ACCOUNTS_KEY] = Object.assign({ v: 1 }, rec, { accounts: list, at: Date.now() });
    await putPrefs(body);
    accountsRec = body[ACCOUNTS_KEY];
  }
  function accountSlug(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '');
  }
  function closeAccDlg() {
    if (accDlg && accDlg.timer) clearInterval(accDlg.timer);
    if (accDlg && accDlg.el && accDlg.el.parentNode) accDlg.el.parentNode.removeChild(accDlg.el);
    accDlg = null;
  }
  function openAccDlg() {
    closeAccDlg();
    var el = document.createElement('div');
    el.className = 'aiondx-welcome-backdrop aiondx-accdlg-backdrop';
    el.innerHTML = '<div class="aiondx-welcome aiondx-accdlg" role="dialog" aria-modal="true" aria-labelledby="aiondx-accdlg-title" data-testid="aiondx-accdlg"></div>';
    el.addEventListener('keydown', function (ev) { ev.stopPropagation(); if (ev.key === 'Escape') { if (window.aiondxAccounts) window.aiondxAccounts.cancel(); closeAccDlg(); } });
    el.addEventListener('mousedown', function (ev) { if (ev.target === el && accDlg && accDlg.step === 'form') closeAccDlg(); });
    document.body.appendChild(el);
    accDlg = { el: el, box: el.firstChild, step: 'form' };
    accForm();
  }
  function accForm() {
    var b = accDlg.box;
    accDlg.step = 'form';
    b.innerHTML =
      '<h2 id="aiondx-accdlg-title" class="aiondx-accdlg-h">Add a Claude account</h2>' +
      '<label class="aiondx-accdlg-row"><span class="aiondx-accdlg-lab">Name it</span>' +
      '<input class="arco-input aiondx-accdlg-name" data-testid="aiondx-accdlg-name" maxlength="40" placeholder="For example Client B" autocomplete="off"></label>' +
      '<div class="aiondx-accdlg-hint aiondx-accdlg-folder"></div>' +
      '<div class="aiondx-accdlg-lab">What it can do</div>' +
      '<label class="aiondx-accdlg-opt"><input type="radio" name="aiondx-acc-kind" value="full" checked> <span><b>Everything</b> (recommended): chats, Claude Docs and connectors, your claude.ai skills, file upload. A full Claude sign-in that renews itself.</span></label>' +
      '<label class="aiondx-accdlg-opt"><input type="radio" name="aiondx-acc-kind" value="token"> <span><b>Chats only</b>: model calls, nothing else. A key that lasts a year; no Claude Docs or connectors.</span></label>' +
      '<label class="aiondx-accdlg-opt"><input type="radio" name="aiondx-acc-kind" value="console"> <span><b>Anthropic Console</b>: API billing, paid per use instead of a Claude plan.</span></label>' +
      '<div class="aiondx-accdlg-lab">It is for</div>' +
      '<div class="aiondx-accdlg-inline"><label><input type="radio" name="aiondx-acc-dom" value="personal" checked> Personal</label>' +
      '<label><input type="radio" name="aiondx-acc-dom" value="work"> Work</label>' +
      '<span class="aiondx-accdlg-hint">which projects it may run</span></div>' +
      '<label class="aiondx-accdlg-check"><input type="checkbox" class="aiondx-accdlg-docs" checked> Claude Docs and connectors in its chats</label>' +
      '<label class="aiondx-accdlg-check"><input type="checkbox" class="aiondx-accdlg-sso"> My organisation signs in with single sign-on (SSO)</label>' +
      '<label class="aiondx-accdlg-row"><span class="aiondx-accdlg-lab">Email (optional)</span>' +
      '<input class="arco-input aiondx-accdlg-email" maxlength="200" placeholder="Filled in on the sign-in page" autocomplete="off"></label>' +
      '<div class="aiondx-accdlg-err" role="alert"></div>' +
      '<div class="aiondx-accdlg-btns"><button type="button" class="arco-btn arco-btn-secondary aiondx-accdlg-cancel">Cancel</button>' +
      '<button type="button" class="arco-btn arco-btn-primary aiondx-accdlg-go" data-testid="aiondx-accdlg-go">Sign in</button></div>';
    var name = b.querySelector('.aiondx-accdlg-name');
    var folder = b.querySelector('.aiondx-accdlg-folder');
    var docs = b.querySelector('.aiondx-accdlg-docs');
    var sync = function () {
      var slug = accountSlug(name.value);
      folder.textContent = slug ? 'Signs in to its own folder, .claude-' + slug + ', so your other sign-ins stay as they are.' : '';
      var kind = (b.querySelector('input[name="aiondx-acc-kind"]:checked') || {}).value;
      docs.disabled = kind === 'token';
      if (kind === 'token') docs.checked = false;
      b.querySelector('.aiondx-accdlg-sso').disabled = kind === 'token';
      b.querySelector('.aiondx-accdlg-email').disabled = kind === 'token';
    };
    b.addEventListener('input', sync);
    b.addEventListener('change', sync);
    sync();
    b.querySelector('.aiondx-accdlg-cancel').addEventListener('click', closeAccDlg);
    b.querySelector('.aiondx-accdlg-go').addEventListener('click', function () { accStart(); });
    setTimeout(function () { name.focus(); }, 0);
  }
  function accErr(text) { var e = accDlg && accDlg.box.querySelector('.aiondx-accdlg-err'); if (e) e.textContent = text || ''; }
  async function accStart() {
    var b = accDlg.box;
    var label = b.querySelector('.aiondx-accdlg-name').value.trim();
    var id = accountSlug(label);
    if (!id) { accErr('Give the account a name first.'); return; }
    var taken = (accountsRec && accountsRec.accounts || []).some(function (a) { return a && a.id === id; });
    if (taken) { accErr('There is already an account called "' + id + '". Pick another name.'); return; }
    var o = {
      name: id, label: label,
      kind: (b.querySelector('input[name="aiondx-acc-kind"]:checked') || {}).value || 'full',
      domain: (b.querySelector('input[name="aiondx-acc-dom"]:checked') || {}).value || 'personal',
      docs: b.querySelector('.aiondx-accdlg-docs').checked,
      sso: b.querySelector('.aiondx-accdlg-sso').checked,
      email: b.querySelector('.aiondx-accdlg-email').value.trim(),
    };
    if (o.domain === 'personal' && /work/i.test(label)) { accErr('A personal account’s name cannot contain "work"; AionDX would treat it as a work account.'); return; }
    accDlg.o = o;
    accErr('');
    b.querySelector('.aiondx-accdlg-go').disabled = true;
    var r = await window.aiondxAccounts.start(o);
    if (!accDlg) return;
    if (!r || !r.ok) { b.querySelector('.aiondx-accdlg-go').disabled = false; accErr('The sign-in did not start: ' + ((r && r.error) || 'no answer') + '.'); return; }
    accWaiting(r.url);
  }
  function accWaiting(url) {
    var b = accDlg.box;
    accDlg.step = 'wait';
    b.innerHTML = '<h2 id="aiondx-accdlg-title" class="aiondx-accdlg-h">Sign in to Claude</h2>' +
      '<p class="aiondx-accdlg-p">The Claude sign-in page is open in your browser. Sign in there as the account you want for "' + escapeHtml(accDlg.o.label) + '"; this window updates by itself.</p>' +
      '<p class="aiondx-accdlg-p aiondx-accdlg-again"></p>' +
      '<div class="aiondx-accdlg-code" hidden><p class="aiondx-accdlg-p">The page shows a code instead of finishing. Paste it here:</p>' +
      '<input class="arco-input aiondx-accdlg-codein" autocomplete="off"> <button type="button" class="arco-btn arco-btn-primary aiondx-accdlg-codego">Continue</button></div>' +
      '<div class="aiondx-accdlg-err" role="alert"></div>' +
      '<div class="aiondx-accdlg-btns"><button type="button" class="arco-btn arco-btn-secondary aiondx-accdlg-cancel">Cancel</button></div>';
    if (url) {
      var a = document.createElement('a');
      a.href = url;
      a.textContent = 'Open the sign-in page again';
      b.querySelector('.aiondx-accdlg-again').appendChild(a);
    }
    b.querySelector('.aiondx-accdlg-cancel').addEventListener('click', function () { window.aiondxAccounts.cancel(); closeAccDlg(); });
    b.querySelector('.aiondx-accdlg-codego').addEventListener('click', function () {
      var c = b.querySelector('.aiondx-accdlg-codein').value.trim();
      if (c) window.aiondxAccounts.code(c).then(function (r) { if (!r || !r.ok) accErr((r && r.error) || 'The code could not be passed on.'); });
    });
    var started = Date.now();
    accDlg.timer = setInterval(function () {
      if (!accDlg) return;
      if (Date.now() - started > 11 * 60000) { clearInterval(accDlg.timer); accErr('The sign-in took too long and was stopped. Cancel and try again.'); return; }
      window.aiondxAccounts.poll().then(function (p) {
        if (!accDlg || !p) return;
        if (p.state === 'running') { b.querySelector('.aiondx-accdlg-code').hidden = !p.asksCode; return; }
        clearInterval(accDlg.timer);
        if (p.state === 'done') accVerify();
        else accErr('The sign-in did not finish. ' + (p.text ? p.text.split('\n').filter(Boolean).slice(-1)[0] : ''));
      }, function () {});
    }, 1500);
  }
  async function accVerify() {
    var b = accDlg.box, o = accDlg.o;
    accDlg.step = 'check';
    b.innerHTML = '<h2 id="aiondx-accdlg-title" class="aiondx-accdlg-h">Checking the key</h2><p class="aiondx-accdlg-p">Reading what the sign-in saved and asking Claude Code to accept it...</p>';
    var v = await window.aiondxAccounts.verify(o.name, o.kind);
    if (!accDlg) return;
    if (!v || !v.ok) {
      b.innerHTML = '<h2 id="aiondx-accdlg-title" class="aiondx-accdlg-h">The account was not added</h2><p class="aiondx-accdlg-p"></p>' +
        '<div class="aiondx-accdlg-btns"><button type="button" class="arco-btn arco-btn-secondary aiondx-accdlg-cancel">Close</button>' +
        '<button type="button" class="arco-btn arco-btn-primary aiondx-accdlg-retry">Try again</button></div>';
      b.querySelector('.aiondx-accdlg-p').textContent = (v && v.error) || 'The key could not be checked.';
      b.querySelector('.aiondx-accdlg-cancel').addEventListener('click', closeAccDlg);
      b.querySelector('.aiondx-accdlg-retry').addEventListener('click', accForm);
      return;
    }
    var s = await window.aiondxAccounts.save({ name: o.name, label: o.label, kind: o.kind, domain: o.domain, docs: o.docs });
    if (!accDlg) return;
    if (!s || !s.ok) { b.innerHTML = '<h2 class="aiondx-accdlg-h">Signed in, but not added</h2><p class="aiondx-accdlg-p"></p>'; b.querySelector('p').textContent = (s && s.error) || 'no answer'; return; }
    try { await rememberAccount(o.name, o.label, o.kind); } catch (e) { /* the launcher has it; the pill shows after the next read */ }
    accDlg.step = 'done';
    var lines = [];
    lines.push('Signed in' + (v.email ? ' as ' + v.email : '') + (v.plan ? ' (' + v.plan + ')' : '') + '.');
    lines.push('Key saved and checked: ' + v.key + (v.renewsUntil ? '; it renews itself until ' + longDate(v.renewsUntil) : '') + '.');
    if (v.scopeWords && v.scopeWords.length) lines.push('It may use: ' + v.scopeWords.join(', ') + '.');
    if (v.missing && v.missing.length) lines.push('Not granted: ' + v.missing.join(', ') + '.');
    lines.push('Claude Docs and connectors: ' + (s.docs ? 'on' : 'off') + '. It counts as ' + (s.domain === 'work' ? 'work' : 'personal') + '.');
    b.innerHTML = '<h2 id="aiondx-accdlg-title" class="aiondx-accdlg-h">"' + escapeHtml(o.label) + '" is added</h2>' +
      '<ul class="aiondx-accdlg-list" data-testid="aiondx-accdlg-result"></ul>' +
      '<p class="aiondx-accdlg-p">Pick <b>Claude Code (' + escapeHtml(o.label) + ')</b> in the agent row to start a chat on it. Every Claude chat’s account button offers it too.</p>' +
      '<div class="aiondx-accdlg-btns"><button type="button" class="arco-btn arco-btn-primary aiondx-accdlg-done">Done</button></div>';
    var ul = b.querySelector('.aiondx-accdlg-list');
    lines.forEach(function (t) { var li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
    b.querySelector('.aiondx-accdlg-done').addEventListener('click', closeAccDlg);
  }
  function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // The pills: one per added account, then "+ Add account", at the end of the row of AionUi's own pills.
  function renderAccountPills() {
    var r = location.hash || '';
    var first = /^#\/guid/.test(r) && !disabled() ? document.querySelector('[data-testid^="preset-pill-"]') : null;
    var row = first ? first.parentNode : null;
    document.querySelectorAll('.aiondx-acc-pill, .aiondx-add-acc').forEach(function (e) { if (!row || e.parentNode !== row) e.parentNode.removeChild(e); });
    if (!row) { if (!/^#\/guid/.test(r)) pendingAccount = pendingAccount && pendingAccount.at > Date.now() - 15000 ? pendingAccount : null; return; }
    var base = row.querySelector('[data-testid^="preset-pill-"][data-assistant-backend="claude"]');
    var plainPill = row.querySelector('[data-testid^="preset-pill-"][data-assistant-selected="false"]') || first;
    var onPill = row.querySelector('[data-testid^="preset-pill-"][data-assistant-selected="true"]') || first;
    var more = row.querySelector('[data-testid="assistant-more-btn"]');
    if (pendingAccount && (!base || base.getAttribute('data-assistant-selected') !== 'true')) pendingAccount = null;
    var have = {};
    row.querySelectorAll('.aiondx-acc-pill').forEach(function (e) { have[e.getAttribute('data-account')] = e; });
    if (window.aiondxAccounts && base) {
      addedAccounts().forEach(function (a) {
        var p = have[a.id];
        if (!p) {
          p = document.createElement('button');
          p.type = 'button';
          p.setAttribute('data-account', a.id);
          p.setAttribute('data-testid', 'aiondx-acc-pill-' + a.id);
          p.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            var b = document.querySelector('[data-testid^="preset-pill-"][data-assistant-backend="claude"]');
            if (b && b.getAttribute('data-assistant-selected') !== 'true') b.click();
            pendingAccount = { id: a.id, at: Date.now() };
            renderAccountPills();
          });
        }
        var on = !!(pendingAccount && pendingAccount.id === a.id);
        // only what changed is touched: a pill rebuilt between press and release gets no click
        var cls = (on ? onPill : plainPill).className.replace(/\s*aiondx-acc-pill(--on)?\b/g, '') + ' aiondx-acc-pill' + (on ? ' aiondx-acc-pill--on' : '');
        if (p.className !== cls) p.className = cls;
        if (p.getAttribute('aria-pressed') !== (on ? 'true' : 'false')) p.setAttribute('aria-pressed', on ? 'true' : 'false');
        var logo = base.querySelector('img, svg');
        var html = '<span class="inline-flex h-20px w-20px items-center justify-center overflow-hidden rounded-999px bg-fill-2">' + (logo ? logo.outerHTML : '') + '</span>' +
          '<span class="min-w-0 max-w-180px truncate whitespace-nowrap">Claude Code (' + escapeHtml(a.label) + ')</span>';
        if (p._html !== html) { p.innerHTML = html; p._html = html; }
        if (p.parentNode !== row) row.insertBefore(p, more || null);
      });
    }
    row.classList.toggle('aiondx-acc-pending', !!pendingAccount);
    if (window.aiondxAccounts) {
      var add = row.querySelector('.aiondx-add-acc');
      if (!add) {
        add = document.createElement('button');
        add.type = 'button';
        add.setAttribute('data-testid', 'aiondx-add-account');
        add.title = 'Sign in another Claude account';
        add.textContent = '+ Add account';
        add.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); openAccDlg(); });
      }
      var addCls = (more ? more.className : plainPill.className).replace(/\s*aiondx-acc-pill(--on)?\b/g, '') + ' aiondx-add-acc';
      if (add.className !== addCls) add.className = addCls;
      if (add.parentNode !== row || add.nextSibling) row.appendChild(add);
    }
  }
  // A press on one of AionUi's own pills takes the account pick back.
  document.addEventListener('click', function (ev) {
    var p = ev.target && ev.target.closest ? ev.target.closest('[data-testid^="preset-pill-"]') : null;
    if (p && pendingAccount && ev.isTrusted) { pendingAccount = null; setTimeout(renderAccountPills, 0); }
  }, true);
  // The new chat AionCore creates gets the account picked for it, before its agent can start.
  var CREATE_RE = /\/api\/conversations(?:[?#]|$)/;
  function tagNewChat(r) {
    var pick = pendingAccount;
    if (!pick || !r || !r.ok) return Promise.resolve(r);
    return r.clone().json().then(function (j) {
      var d = j && (j.data || j);
      var id = d && (d.id || (d.conversation && d.conversation.id));
      if (!id) return r;
      pendingAccount = null;
      var body = {};
      body[AGENT_PREFIX + id] = { agent: pick.id, at: Date.now(), by: 'user' };
      agentPrefs[id] = pick.id;
      return putPrefs(body).then(function () { return r; }, function () { return r; });
    }, function () { return r; });
  }

  // ---------------------------------------------------------------- team column scrolling

  // a request of 2026-09-24 TeamPage.tsx
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

  // ---------------------------------------------------------------- hooks for the app's own bundles (patch 0010, build 2026-10-02.1)

  // The AionUi feedback form sent logs, a database summary and a screenshot to AionUi's Sentry project. Patch 0010 sends its open and
  // submit calls here instead: the AionDX issues page opens in the browser, with what the person typed filled in.
  var ISSUES_URL = 'https://github.com/Renegade1993/AionDX/issues/new';
  window.aiondxFeedback = function (opts) {
    opts = opts || {};
    var text = String(opts.description || '').slice(0, 1500);
    var title = String(opts.moduleLabel || opts.module || 'Feedback').slice(0, 80);
    var url = ISSUES_URL + '?title=' + encodeURIComponent(title) + (text ? '&body=' + encodeURIComponent(text) : '');
    return postJson('/api/shell/open-external', { url: url }).then(function () { return undefined; }, function () { return undefined; });
  };
  /** Install a downloaded update: the main process checks the installer against the release's checksums, runs it silently, and the
   *  app closes and comes back. Without that bridge the installer is opened as AionUi's own button did. */
  window.aiondxInstallUpdate = function (file, openIt) {
    var u = window.aiondxUpdate;
    if (!u || typeof u.install !== 'function') return openIt();
    var say = function (m) { toast(m, 'The installer is in your Downloads folder.', null); };
    toast('Installing the update: AionDX closes, updates and opens again.', '', null);
    return u.install(file).then(function (r) { if (!r || !r.ok) say('The update was not installed: ' + ((r && r.error) || 'unknown error') + '.'); },
      function (e) { say('The update was not installed: ' + String(e && e.message || e) + '.'); });
  };

  // ---------------------------------------------------------------- Ctrl+Z in the message box (build 2026-10-02.1)

  // a request of 2026-10-02. In AionUi's box Chromium records one undo
  // step per character: the page changes the DOM beside the box on every keystroke (React redraws the highlight layer, and rewrites the
  // textarea's own child text), and Chromium ends its typing command whenever the DOM changes under it. A sentence needed as many
  // presses of Ctrl+Z as it had characters (measured in the built app, tools\probe-undo*.js: 43 presses for 43 characters; 1 for a
  // bare textarea). So the two message boxes (a chat's, the new-chat page's) keep their own history, taken from the input events:
  // typing and deleting in one burst (no pause over a second) is one step, a paste, a cut or a line break is its own, Ctrl+Z steps
  // back, Ctrl+Y and Ctrl+Shift+Z forward. A change the page makes itself (a send emptying the box, a draft put back, a restore) starts
  // a new history from that text, so Ctrl+Z never puts back what was already sent.
  var UNDO_PAUSE_MS = 1000;
  var UNDO_LIMIT = 300;
  var undoHist = typeof WeakMap === 'function' ? new WeakMap() : null;
  function undoBox(el) {
    return !!(el && el.tagName === 'TEXTAREA' && el.closest && el.closest('[data-testid="sendbox-input"], [data-testid="guid-input"]'));
  }
  function undoKind(type) {
    if (/^insert(Text|CompositionText|ReplacementText)$/.test(type)) return 'ins';
    if (/^delete(ContentBackward|ContentForward|WordBackward|WordForward|SoftLineBackward|SoftLineForward)$/.test(type)) return 'del';
    return 'other';
  }
  function undoState(ta) {
    var h = undoHist.get(ta);
    if (!h) { h = { stack: [{ v: ta.value, s: ta.selectionStart, e: ta.selectionEnd }], i: 0, at: 0, kind: '', applying: false }; undoHist.set(ta, h); }
    return h;
  }
  /** What the history last knew against what the box holds: a difference is the page's own change, and starts the history again. */
  function undoSync(ta) {
    var h = undoState(ta);
    if (h.stack[h.i].v !== ta.value) { h.stack = [{ v: ta.value, s: ta.selectionStart, e: ta.selectionEnd }]; h.i = 0; h.at = 0; h.kind = ''; }
    return h;
  }
  function undoApply(ta, h, to, how) {
    var snap = h.stack[to];
    h.applying = true;
    try {
      var desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      if (desc && desc.set) desc.set.call(ta, snap.v); else ta.value = snap.v;
      var ev;
      try { ev = new InputEvent('input', { bubbles: true, inputType: how }); } catch (e) { ev = new Event('input', { bubbles: true }); }
      ta.dispatchEvent(ev);
      try { ta.setSelectionRange(snap.s, snap.e); } catch (e) {}
    } finally { h.applying = false; }
    h.i = to;
    h.at = 0;
    h.kind = '';
  }
  function watchUndo() {
    if (!undoHist) return;
    // Before an edit: the text as it stands is the starting point if the page changed it since the last one.
    window.addEventListener('beforeinput', function (ev) {
      if (undoBox(ev.target) && ev.inputType !== 'historyUndo' && ev.inputType !== 'historyRedo') undoSync(ev.target);
    }, true);
    window.addEventListener('input', function (ev) {
      var ta = ev.target;
      if (!ev.inputType || !undoBox(ta)) return;        // an input event the page made up (no inputType) is a change it made itself
      if (ev.inputType === 'historyUndo' || ev.inputType === 'historyRedo') return;
      var h = undoState(ta);
      if (h.applying) return;
      var kind = undoKind(ev.inputType);
      var now = Date.now();
      var snap = { v: ta.value, s: ta.selectionStart, e: ta.selectionEnd };
      if (h.i < h.stack.length - 1) h.stack.length = h.i + 1;                      // an edit after an undo ends the redo line
      if (kind !== 'other' && kind === h.kind && now - h.at < UNDO_PAUSE_MS && h.i > 0) h.stack[h.i] = snap;   // the same burst
      else {
        h.stack.push(snap);
        if (h.stack.length > UNDO_LIMIT) h.stack.shift();
        h.i = h.stack.length - 1;
      }
      h.kind = kind;
      h.at = now;
    }, true);
    window.addEventListener('keydown', function (ev) {
      if (ev.defaultPrevented || ev.isComposing || composingNow || ev.altKey || !(ev.ctrlKey || ev.metaKey)) return;
      var k = String(ev.key || '').toLowerCase();
      var undo = k === 'z' && !ev.shiftKey;
      var redo = (k === 'z' && ev.shiftKey) || (k === 'y' && !ev.shiftKey);
      if (!undo && !redo) return;
      var ta = ev.target;
      if (!undoBox(ta) || disabled()) return;
      var h = undoSync(ta);
      var to = undo ? h.i - 1 : h.i + 1;
      ev.preventDefault();                                   // the browser's own history is the per-character one
      if (to < 0 || to >= h.stack.length) return;            // nothing further that way
      undoApply(ta, h, to, undo ? 'historyUndo' : 'historyRedo');
    }, true);
  }

  function start() {
    ensureStyle();
    themePrefs = loadThemePrefs();
    applyThemePrefs(themePrefs);
    watchSends();
    watchDrafts();
    watchRespondNow();
    watchUndo();
    watchPermissionHover();
    watchAcctHover();
    loadGroups();
    watchSidebarMenus();
    watchLocalLinks();
    watchPictures();
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
    setInterval(function () { questionSweep().catch(function () {}); }, 4000);
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
    repaint: function () { sweepAt = {}; render(); },
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
    schedState: function (id) { return schedStore[id] || null; },
    resetCtx: function () { ctxInfo = {}; ctxAsk = {}; ctxState = {}; },
    ctxLines: function () { return targets().map(function (t) { var i = ctxInfo[t.key]; return { key: t.key, info: i || null, line: i ? promptCacheLine(ctxCache(t, i)) : '' }; }); },
    accountLimit: function (convId) { return accountLimit(convId); },
    unsend: function () { return { results: unsendResults, pending: unsendPending }; },
    runUnsend: function () { try { renderUnsend(); return 'ok'; } catch (e) { return String((e && e.stack) || e); } },
    teamUnsendState: function () {
      var r = route();
      var tc = r && r.kind === 'team' ? teamCache[r.id] : null;
      return { route: r && r.kind, hasTeam: !!tc, map: tc ? tc.map : null, queued: Object.keys(rnQueued).map(function (k) { return k + ':' + rnQueued[k].items.length; }),
        backends: tc ? Object.keys(tc.map).map(function (sl) { var i = convInfo[tc.map[sl]]; return sl.slice(0, 8) + '=' + (i ? i.backend : 'unloaded'); }) : [], disabled: !!disabled() };
    },
    scanQueues: function () { return scanTeamQueues(); },
    viewer: function () { return viewer ? { i: viewer.i, n: viewer.items.length, scale: viewer.scale, count: viewer.count.textContent, prevOff: viewer.prev.disabled, nextOff: viewer.next.disabled } : null; },
    viewerPictures: function () { return viewerPictures(); },
    usageSettings: function () { return { cfg: usageCfg, alerts: usageAlerts, fired: usageFired }; },
    checkAlerts: function () { return checkUsageAlerts(); },
    openUsagePanel: function (t) { return openUsagePanel(t); },
    queuedRowsOf: function (q) { return queuedRows(q).map(function (m) { return { id: m.id, byBadge: !!m.byBadge }; }); },
    setQueued: function (q) { rnQueued = q; renderRespondNow(); },
    openOutside: function (p, r, run) { return openOutside(p, r, run); },
    drafts: function () { return { store: draftStore, restored: draftRestored }; },
    setReplyQuoteInBox: function (box, q) { return setReplyQuoteInBox(box, q); },
    draftQuoteOf: function (box) { return draftQuoteOf(box); },
    syncDrafts: function () { syncDrafts(false); },
    setLive: function (key, st) { agentLive[key] = { state: st }; },
    stopTimes: function (show, force) { STOP_OVERRIDE = { show: show, force: force }; },
    options: function () { return { values: optionValues, defs: OPTIONS.length }; },
    option: function (id) { return opt(id); },
    setOption: function (id, v) { return setOption(id, v); },
    imagePathAt: function (x, y) { return imagePathAt(x, y); },
    rememberImage: function (u, p) { return rememberImage(u, p); },
    olderLoads: function () { return JSON.parse(JSON.stringify(olderLoads)); },
    swapAgent: function (t, a) { return swapAgent(t, a); },
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
