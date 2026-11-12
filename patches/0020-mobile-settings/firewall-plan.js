// The netsh plans for the bridge's Windows Firewall rule, built in the MAIN process from nothing the renderer controls but the
// port. The same rules as core-0016's firewall.rs (add_rule_plan): a fixed netsh.exe path, a fixed rule name, the Private profile
// only, inbound TCP on one port, for one program; a path netsh could misread (a ", an =, a control character, a relative path, a
// trailing separator) is refused, never quoted around. apply.js inlines the part between the INLINE markers into out/main/index.js;
// the last line is for the tests only.
// AIONDX-0020-INLINE-BEGIN
function __aiondxMobileFirewallPlan() {
  const RULE_NAME = 'AionDX mobile bridge';
  const PORT_MIN = 1024, PORT_MAX = 65535;
  const fail = (error) => ({ ok: false, error });
  const isAbsoluteWin = (p) => /^[A-Za-z]:\\/.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p);
  /** A Windows path netsh can take as one program= value, or an error. */
  function checkPath(p, what) {
    if (typeof p !== 'string' || !p) return what + ' is missing';
    if (!isAbsoluteWin(p)) return what + ' must be an absolute path';
    if (/[\\/]$/.test(p)) return what + ' must be a file, not a folder';
    if (/["=]/.test(p) || /[\u0000-\u001f\u007f]/.test(p)) return what + ' contains a character netsh cannot take safely';
    return null;
  }
  function netshPath(systemRoot) {
    const root = typeof systemRoot === 'string' && isAbsoluteWin(systemRoot) && !/["=\u0000-\u001f]/.test(systemRoot) ? systemRoot.replace(/[\\/]+$/, '') : 'C:\\Windows';
    return root + '\\System32\\netsh.exe';
  }
  /** opts: { port, program, systemRoot }. port must be an integer 1024-65535 (allow only); program is the bundled aioncore.exe. */
  function buildPlan(action, opts) {
    opts = opts || {};
    const netsh = netshPath(opts.systemRoot);
    if (action === 'remove') {
      return { ok: true, program: netsh, args: ['advfirewall', 'firewall', 'delete', 'rule', 'name=' + RULE_NAME] };
    }
    if (action !== 'allow') return fail('unknown firewall action');
    const port = opts.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) return fail('the port must be a whole number from ' + PORT_MIN + ' to ' + PORT_MAX);
    const bad = checkPath(opts.program, 'the bridge program');
    if (bad) return fail(bad);
    return {
      ok: true,
      program: netsh,
      args: ['advfirewall', 'firewall', 'add', 'rule', 'name=' + RULE_NAME, 'dir=in', 'action=allow', 'protocol=TCP',
        'localport=' + port, 'profile=private', 'program=' + opts.program, 'enable=yes'],
    };
  }
  /** Read-only, no admin needed: what is there now. */
  function showPlan(systemRoot) {
    return { program: netshPath(systemRoot), args: ['advfirewall', 'firewall', 'show', 'rule', 'name=' + RULE_NAME, 'verbose'] };
  }
  /** English `show rule ... verbose` output (localized output reads as "not there"). */
  function parseShowRule(output) {
    const blocks = [];
    let cur = null;
    for (const line of String(output || '').split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const key = line.slice(0, i).trim().toLowerCase(), value = line.slice(i + 1).trim();
      if (key === 'rule name') { cur = value.toLowerCase() === RULE_NAME.toLowerCase() ? { enabled: false, profiles: [], port: null } : null; if (cur) blocks.push(cur); continue; }
      if (!cur) continue;
      if (key === 'enabled') cur.enabled = /^yes$/i.test(value);
      else if (key === 'profiles') cur.profiles = value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      else if (key === 'localport') cur.port = /^\d+$/.test(value) && +value > 0 && +value < 65536 ? +value : null;
    }
    if (!blocks.length) return { present: false, enabled: false, privateOnly: false, port: null };
    const port = blocks.every((b) => b.port === blocks[0].port) ? blocks[0].port : null;
    return { present: true, enabled: blocks.every((b) => b.enabled), privateOnly: blocks.every((b) => b.profiles.length === 1 && b.profiles[0] === 'private'), port };
  }
  return { RULE_NAME, PORT_MIN, PORT_MAX, buildPlan, showPlan, parseShowRule, checkPath, netshPath };
}
// AIONDX-0020-INLINE-END
module.exports = __aiondxMobileFirewallPlan();
