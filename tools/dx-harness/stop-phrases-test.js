// stop-phrases-test.js: which of your messages switch a Loop off (patch 0001 saysStop).
// Run: node tools\dx-harness\stop-phrases-test.js. Exit 0 only when every case is right.
// Pulls STOP_RES, STOP_NOT_RES, STOP_SUBORD_RE and saysStop out of aionui-dx.js and runs them on sample messages.
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', '..', 'patches', '0001-renderer-dx', 'aionui-dx.js'), 'utf8');
const grab = (start, endMark) => { const i = src.indexOf(start); const j = src.indexOf(endMark, i); return src.slice(i, j + endMark.length); };
const code = grab('  var STOP_RES = [', '];') + '\n' + grab('  var STOP_NOT_RES = [', '];') + '\n' + grab('  var STOP_SUBORD_RE =', ';') + '\n' +
  grab('  function saysStop(text) {', '\n    return false;\n  }') + '\nmodule.exports = saysStop;';
const m = { exports: null }; new Function('module', code)(m);
const saysStop = m.exports;
const cases = [
  ['can you get the original, replace it/back it up, and then swap it when we are done testing', false],
  ['stop', true], ['Please stop.', true], ['okay stop now', true], ['ok, time to stop work for today', true],
  ["we're done", true], ["We're done for today.", true], ["If that's all, we're done.", true], ["alright we're done here", true],
  ["we're done testing the map, now run the build", false], ['once we are done with this, commit', false],
  ["don't stop working on the map tests", false], ['keep working until i tell you to stop', false],
  ['good night', true], ['thanks, good night!', true], ['I had a good night of sleep', false],
  ['stand down', true], ['usage is cooked', true], ["that's enough for now", true], ["that's enough data to decide", false],
  ['when you stop here, write the notes', false], ['call it a day', true], ['wrap it up', true],
  ['[AionDX Loop: sent automatically, not typed by the user] CONTINUE WORKING. keep going until the user interrupts.', false],
  // The September 26th review: questions, other negations, conditions, and phrases inside ordinary work talk.
  ['why did you stop working?', false], ['should I stop now?', false], ["we can't stop now", false],
  ["the server won't stop now", false], ['make sure it doesnt stop working', false], ['wrap it up in a helper function', false],
  ['time to stop the old server and start the new one', false], ['the loop should stop there', false],
  ['If the build fails, stop.', false], ['Once the tests pass, we are done.', false],
  ['stop working', true], ['ok stop working for today', true], ['please stop now', true], ["it's time to stop", true],
  ["let's stop here", true], ['stop for now', true], ['ok, wrap it up', true], ["let's call it a day", true],
  ['Great work today. Stop working now and write your notes.', true], ['stop working on the map tests and look at the build', false],
  ['stop working and switch to the docs', false],
];
let bad = 0;
for (const [t, want] of cases) { const got = saysStop(t); if (got !== want) bad++; console.log((got === want ? 'ok  ' : 'BAD ') + JSON.stringify(t) + ' -> ' + got); }
console.log(bad ? bad + ' wrong' : 'all ' + cases.length + ' right');
process.exit(bad ? 1 : 0);
