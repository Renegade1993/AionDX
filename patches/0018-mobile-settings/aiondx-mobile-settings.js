/* AionDX patch 0018: Settings > Mobile - the PC side of pairing and managing phones (core-0015's admin routes).
 * docs/mobile-bridge/DESKTOP-UI-SPEC.md; CONTRACT.md §3 (pairing, SAS, devices), §5.3 (re-key).
 * A "Mobile" item in the settings sidebar, and a Mobile card at the top of Settings > Remote (#/settings/webui), next to
 * the existing remote-access settings: a new route would mean patching the bundle's router, this needs no anchor in it.
 * Everything a phone sent (its name, platform) is put on the page as text, never as HTML.
 * Needs qrcodegen.js (window.AionDxQrcodegen) loaded first. */
(function () {
  'use strict';
  if (window.__aionDxMobile) return;

  var STATUS_MS = 2000, OFFER_MS = 1000, DEVICES_MS = 2000, FIREWALL_MS = 10000;
  var ROUTE = '#/settings/webui';

  // ---------------------------------------------------------------- backend (the same address and CSRF as patch 0001)

  function csrf() {
    if (window.__coreCsrfToken) return window.__coreCsrfToken;
    var m = document.cookie.match(/(?:^|;\s*)aionui-csrf-token=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }
  function apiUrl(path) {
    var port = window.__backendPort;
    return (port ? 'http://127.0.0.1:' + port : '') + path;
  }
  /** ApiResponse<T> unwrapped: resolves with data, rejects with an Error carrying .status and the server's message. */
  function api(method, path, body) {
    var opts = { method: method, credentials: 'include', headers: { 'x-csrf-token': csrf() } };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(apiUrl(path), opts).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; }
        if (!r.ok || (j && j.success === false)) {
          var err = new Error((j && (j.msg || j.message || j.error)) || ('http ' + r.status));
          err.status = r.status;
          throw err;
        }
        return j && j.data !== undefined ? j.data : j;
      });
    });
  }

  // ---------------------------------------------------------------- small DOM helpers (text only for anything a phone sent)

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function button(label, kind, onClick) {
    var b = el('button', 'arco-btn arco-btn-size-small arco-btn-shape-square ' + (kind === 'primary' ? 'arco-btn-primary' : kind === 'danger' ? 'arco-btn-secondary arco-btn-status-danger' : 'arco-btn-secondary'));
    b.type = 'button';
    b.appendChild(el('span', null, label));
    b.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); onClick(ev); });
    return b;
  }
  function setLabel(b, label) { if (b.firstChild.textContent !== label) b.firstChild.textContent = label; }
  function toggle(onChange) {
    var b = el('button', 'arco-switch arco-switch-type-circle aiondx-mobile-switch');
    b.type = 'button';
    b.setAttribute('role', 'switch');
    b.appendChild(el('div', 'arco-switch-dot'));
    b.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); if (!b.disabled) onChange(!b.__on); });
    return b;
  }
  function setToggle(b, on, disabled) {
    b.__on = !!on;
    b.classList.toggle('arco-switch-checked', !!on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.disabled = !!disabled;
  }
  function row(label, control, hint) {
    var r = el('div', 'aiondx-mobile-row');
    var left = el('div', 'aiondx-mobile-row-text');
    left.appendChild(el('div', 'aiondx-mobile-label', label));
    if (hint) left.appendChild(el('div', 'aiondx-mobile-hint', hint));
    r.appendChild(left);
    r.appendChild(control);
    return r;
  }
  function when(ts) {
    if (ts == null || ts === '') return null;
    var n = typeof ts === 'number' ? ts : (/^\d+$/.test(String(ts)) ? Number(ts) : Date.parse(ts));
    if (!isFinite(n)) return null;
    return n < 1e12 ? n * 1000 : n;   // seconds or milliseconds
  }
  function ago(ts) {
    var t = when(ts);
    if (t == null) return 'never';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }
  function day(ts) { var t = when(ts); return t == null ? '' : new Date(t).toLocaleDateString(); }

  // ---------------------------------------------------------------- QR (vendored qrcodegen; drawn on a canvas)

  function qrCanvas(text) {
    var q = window.AionDxQrcodegen;
    var c = el('canvas', 'aiondx-mobile-qr');
    if (!q) { c.setAttribute('data-error', 'no QR library'); return c; }
    var qr = q.QrCode.encodeText(text, q.QrCode.Ecc.MEDIUM);
    var border = 4, scale = Math.max(3, Math.floor(240 / (qr.size + border * 2)));
    var px = (qr.size + border * 2) * scale;
    c.width = px; c.height = px;
    var g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, px, px);   // a QR needs light quiet zone and dark modules in any theme
    g.fillStyle = '#000000';
    for (var y = 0; y < qr.size; y++) for (var x = 0; x < qr.size; x++) if (qr.getModule(x, y)) g.fillRect((x + border) * scale, (y + border) * scale, scale, scale);
    c.setAttribute('data-uri', text);
    c.setAttribute('aria-label', 'Pairing QR code');
    return c;
  }

  // ---------------------------------------------------------------- style (theme tokens only)

  function ensureStyle() {
    if (document.getElementById('aiondx-mobile-style')) return;
    var s = el('style');
    s.id = 'aiondx-mobile-style';
    s.textContent = [
      '.aiondx-mobile-card [hidden],.aiondx-mobile-dialog [hidden]{display:none !important}',
      '.aiondx-mobile-card{margin:0 0 16px;padding:16px 20px;border-radius:12px;background:var(--color-fill-1, var(--bg-2));color:var(--color-text-1)}',
      '.aiondx-mobile-title{font-size:16px;font-weight:500;margin:0 0 4px}',
      '.aiondx-mobile-desc,.aiondx-mobile-hint{font-size:12px;color:var(--color-text-3)}',
      '.aiondx-mobile-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 0}',
      '.aiondx-mobile-label{font-size:14px}',
      '.aiondx-mobile-status{font-size:12px;color:var(--color-text-2);padding:2px 0 8px}',
      '.aiondx-mobile-status ul{margin:4px 0 0;padding-left:18px}',
      '.aiondx-mobile-error{color:rgb(var(--danger-6));font-size:12px;padding:4px 0}',
      '.aiondx-mobile-banner{background:rgba(var(--warning-6),.14);border:1px solid rgba(var(--warning-6),.5);border-radius:8px;padding:10px 12px;margin:8px 0;font-size:13px;display:flex;gap:12px;align-items:flex-start;justify-content:space-between}',
      '.aiondx-mobile-banner .aiondx-mobile-hint{margin-top:4px;word-break:break-all}',
      '.aiondx-mobile-section{margin-top:12px;font-size:13px;font-weight:500}',
      '.aiondx-mobile-device{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;padding:10px 0;border-top:1px solid var(--color-border-2)}',
      '.aiondx-mobile-device-main{min-width:0;flex:1}',
      '.aiondx-mobile-device-name{font-size:14px;background:transparent;border:1px solid transparent;border-radius:4px;color:var(--color-text-1);padding:1px 4px;margin-left:-5px;width:100%;max-width:280px}',
      '.aiondx-mobile-device-name:hover,.aiondx-mobile-device-name:focus{border-color:var(--color-border-3);outline:none}',
      '.aiondx-mobile-device-actions{display:flex;flex-direction:column;gap:6px;align-items:flex-end}',
      '.aiondx-mobile-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:rgb(var(--success-6));margin-left:6px;vertical-align:middle}',
      '.aiondx-mobile-inline{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--color-text-2)}',
      '.aiondx-mobile-adv summary{cursor:pointer;font-size:13px;color:var(--color-text-2);padding:8px 0}',
      '.aiondx-mobile-adv input[type=text],.aiondx-mobile-adv input[type=number],.aiondx-mobile-adv textarea{background:var(--color-fill-2);border:1px solid var(--color-border-2);border-radius:4px;color:var(--color-text-1);padding:4px 8px;font:inherit;font-size:13px}',
      '.aiondx-mobile-adv textarea{width:260px;height:56px;resize:vertical}',
      '.aiondx-mobile-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2000;display:flex;align-items:center;justify-content:center}',
      '.aiondx-mobile-dialog{background:var(--color-bg-3, var(--color-bg-2));color:var(--color-text-1);border-radius:12px;padding:20px 24px;min-width:340px;max-width:440px;box-shadow:0 8px 32px rgba(0,0,0,.4);text-align:center}',
      '.aiondx-mobile-dialog h3{margin:0 0 8px;font-size:16px;font-weight:500}',
      '.aiondx-mobile-dialog p{font-size:13px;color:var(--color-text-2);margin:8px 0}',
      '.aiondx-mobile-qr{display:block;margin:12px auto;border-radius:6px;max-width:260px;width:100%;height:auto;image-rendering:pixelated}',
      '.aiondx-mobile-sas{font-size:40px;font-weight:600;letter-spacing:6px;font-variant-numeric:tabular-nums;margin:12px 0;color:var(--color-text-1)}',
      '.aiondx-mobile-buttons{display:flex;gap:8px;justify-content:center;margin-top:14px;flex-wrap:wrap}',
      '.aiondx-mobile-countdown{font-size:12px;color:var(--color-text-3)}'
    ].join('\n');
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------- the card

  var card = null;          // built once, kept while the page shows
  var ui = {};              // its live parts
  var status = null, devices = [], firewall = null, firewallMissing = false;
  var timers = { status: null, devices: null, firewall: null };
  var savingSettings = false;

  function buildCard() {
    var c = el('div', 'aiondx-mobile-card');
    c.id = 'aiondx-mobile';
    c.setAttribute('data-testid', 'aiondx-mobile-card');
    c.appendChild(el('div', 'aiondx-mobile-title', 'Mobile'));
    c.appendChild(el('div', 'aiondx-mobile-desc', 'Use the AionDX phone app with this PC: see your agents and teams, answer their questions and approvals, and send messages. Phones connect over your own network.'));

    ui.toggle = toggle(function (on) { saveSettings({ enabled: on }); });
    ui.toggle.setAttribute('data-testid', 'aiondx-mobile-enable');
    var accessRow = row('Phone access', ui.toggle, 'Off until you turn it on.');
    ui.toggleHint = accessRow.querySelector('.aiondx-mobile-hint');
    ui.toggleHint.setAttribute('data-testid', 'aiondx-mobile-enable-hint');
    c.appendChild(accessRow);
    ui.status = el('div', 'aiondx-mobile-status');
    ui.status.setAttribute('data-testid', 'aiondx-mobile-status');
    c.appendChild(ui.status);
    ui.error = el('div', 'aiondx-mobile-error');
    ui.error.setAttribute('data-testid', 'aiondx-mobile-error');
    ui.error.hidden = true;
    c.appendChild(ui.error);

    ui.banner = el('div', 'aiondx-mobile-banner');
    ui.banner.setAttribute('data-testid', 'aiondx-mobile-recovery');
    ui.banner.hidden = true;
    var bt = el('div');
    ui.bannerText = el('div');
    ui.bannerDetail = el('div', 'aiondx-mobile-hint');
    bt.appendChild(ui.bannerText); bt.appendChild(ui.bannerDetail);
    ui.banner.appendChild(bt);
    ui.banner.appendChild(button('Dismiss', null, function () {
      api('POST', '/api/mobile/admin/recovery/dismiss').then(refreshStatus, function (e) { showError('Could not dismiss: ' + e.message); });
    }));
    c.appendChild(ui.banner);

    ui.pair = button('Pair a phone', 'primary', function () { openPairing(); });
    ui.pair.setAttribute('data-testid', 'aiondx-mobile-pair');
    var pr = el('div', 'aiondx-mobile-row');
    pr.appendChild(el('div', 'aiondx-mobile-hint', 'Pairing shows a QR code to scan with the phone app, then a code to compare on both screens.'));
    pr.appendChild(ui.pair);
    c.appendChild(pr);

    c.appendChild(el('div', 'aiondx-mobile-section', 'Paired phones'));
    ui.devices = el('div');
    ui.devices.setAttribute('data-testid', 'aiondx-mobile-devices');
    c.appendChild(ui.devices);

    ui.firewall = el('div');
    ui.firewall.setAttribute('data-testid', 'aiondx-mobile-firewall');
    ui.firewall.hidden = true;
    c.appendChild(ui.firewall);

    c.appendChild(buildAdvanced());
    return c;
  }

  function buildAdvanced() {
    var d = el('details', 'aiondx-mobile-adv');
    d.appendChild(el('summary', null, 'Advanced'));
    ui.port = el('input'); ui.port.type = 'number'; ui.port.min = '1'; ui.port.max = '65535';
    ui.port.setAttribute('data-testid', 'aiondx-mobile-port');
    d.appendChild(row('Port', ui.port, 'The port phones connect to on this PC.'));
    ui.hostName = el('input'); ui.hostName.type = 'text';
    ui.hostName.setAttribute('data-testid', 'aiondx-mobile-hostname');
    d.appendChild(row('PC name', ui.hostName, 'Shown on the phone.'));
    ui.extraUrls = el('textarea');
    ui.extraUrls.setAttribute('data-testid', 'aiondx-mobile-extraurls');
    ui.extraUrls.placeholder = 'http://100.64.1.2:47734';
    d.appendChild(row('Extra addresses', ui.extraUrls, 'One per line, for example a Tailscale 100.x address or MagicDNS name.'));
    ui.mdns = toggle(function (on) { saveSettings({ mdns: on }); });
    ui.mdns.setAttribute('data-testid', 'aiondx-mobile-mdns');
    d.appendChild(row('Announce on the local network (mDNS)', ui.mdns, 'Lets the phone app find this PC without typing an address.'));
    ui.tasksWrite = toggle(function (on) { saveSettings({ tasksWrite: on }); });
    ui.tasksWrite.setAttribute('data-testid', 'aiondx-mobile-taskswrite');
    d.appendChild(row('Allow phones to edit tasks', ui.tasksWrite));
    var save = button('Save', 'primary', function () {
      var port = parseInt(ui.port.value, 10);
      if (!(port >= 1 && port <= 65535)) { showError('The port must be a number from 1 to 65535.'); return; }
      saveSettings({
        port: port,
        hostName: ui.hostName.value.trim(),
        extraUrls: ui.extraUrls.value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean)
      }, true);
    });
    save.setAttribute('data-testid', 'aiondx-mobile-save');
    var sr = el('div', 'aiondx-mobile-row');
    ui.saved = el('div', 'aiondx-mobile-hint');
    sr.appendChild(ui.saved); sr.appendChild(save);
    d.appendChild(sr);
    return d;
  }

  function showError(text) {
    ui.error.textContent = text || '';
    ui.error.hidden = !text;
  }

  function saveSettings(patch, fields) {
    savingSettings = true;
    if (fields) ui.saved.textContent = 'Saving...';
    return api('PUT', '/api/mobile/admin/settings', patch).then(function (s) {
      savingSettings = false;
      if (s && typeof s === 'object' && 'enabled' in s) { status = s; paintStatus(true); }
      if (fields) ui.saved.textContent = 'Saved.';
      refreshStatus();
    }, function (e) {
      savingSettings = false;
      if (fields) ui.saved.textContent = '';
      showError('Could not save: ' + e.message);
      paintStatus();
    });
  }

  function paintStatus(fillFields) {
    var s = status || {};
    setToggle(ui.toggle, s.enabled, savingSettings);
    var hint = s.enabled ? "On. Phones you've paired can connect." : 'Off until you turn it on.';
    if (ui.toggleHint.textContent !== hint) ui.toggleHint.textContent = hint;
    ui.status.textContent = '';
    if (s.enabled) {
      ui.status.appendChild(el('div', null, s.listening ? 'Listening on port ' + s.port + '.' : 'Not listening yet.'));
      var urls = Array.isArray(s.urls) ? s.urls : [];
      if (urls.length) {
        var ul = el('ul');
        urls.forEach(function (u) { ul.appendChild(el('li', null, String(u))); });
        ui.status.appendChild(el('div', null, 'Phones can reach this PC at:'));
        ui.status.appendChild(ul);
      }
    } else {
      ui.status.appendChild(el('div', null, 'Off.'));
    }
    if (s.error) showError('Mobile access is unavailable this session: ' + s.error);
    else if (/^Mobile access is unavailable/.test(ui.error.textContent)) showError('');
    var rec = s.lastRecovery;
    ui.banner.hidden = !rec;
    if (rec) {
      ui.bannerText.textContent = rec.kind === 'host_key'
        ? "This PC's mobile identity was reset. Every phone must pair again."
        : "The mobile bridge's data was damaged and has been reset. Paired phones need to pair again.";
      ui.bannerDetail.textContent = rec.movedTo ? 'The old data was moved to ' + rec.movedTo : '';
    }
    ui.pair.disabled = !s.listening;
    setToggle(ui.mdns, s.mdns, savingSettings);
    setToggle(ui.tasksWrite, s.tasksWrite, savingSettings);
    if (fillFields || ui.port.value === '') {
      // not while the user is typing in them
      if (document.activeElement !== ui.port && s.port != null) ui.port.value = String(s.port);
      if (document.activeElement !== ui.hostName) ui.hostName.value = s.hostName || '';
      if (document.activeElement !== ui.extraUrls) ui.extraUrls.value = (Array.isArray(s.extraUrls) ? s.extraUrls : []).join('\n');
    }
  }

  function refreshStatus() {
    return api('GET', '/api/mobile/admin/status').then(function (s) {
      var first = !status;
      status = s || {};
      paintStatus(first);
    }, function (e) {
      showError('Could not read the mobile bridge status: ' + e.message);
    });
  }

  // ---------------------------------------------------------------- devices

  function refreshDevices() {
    return api('GET', '/api/mobile/admin/devices').then(function (list) {
      devices = Array.isArray(list) ? list : (list && Array.isArray(list.devices) ? list.devices : []);
      paintDevices();
    }, function () { /* the status line already says when the bridge is unreachable */ });
  }

  function paintDevices() {
    var box = ui.devices;
    var focused = document.activeElement && box.contains(document.activeElement) ? document.activeElement.getAttribute('data-device') : null;
    if (focused) return;   // a name is being edited: repaint on the next tick after it
    box.textContent = '';
    if (!devices.length) { box.appendChild(el('div', 'aiondx-mobile-hint', 'No phones paired yet.')); return; }
    devices.forEach(function (d) { box.appendChild(deviceRow(d)); });
  }

  function deviceRow(d) {
    var r = el('div', 'aiondx-mobile-device');
    r.setAttribute('data-testid', 'aiondx-mobile-device');
    r.setAttribute('data-device-id', d.deviceId);
    var main = el('div', 'aiondx-mobile-device-main');
    var name = el('input', 'aiondx-mobile-device-name');
    name.type = 'text';
    name.value = d.name || '';
    name.setAttribute('data-device', d.deviceId);
    name.setAttribute('aria-label', 'Phone name');
    function commit() {
      var v = name.value.trim();
      if (!v || v === d.name) { name.value = d.name || ''; return; }
      api('PATCH', '/api/mobile/admin/devices/' + encodeURIComponent(d.deviceId), { name: v }).then(function (nd) {
        if (nd && nd.name) d.name = nd.name; else d.name = v;
        refreshDevices();
      }, function (e) { name.value = d.name || ''; showError('Could not rename: ' + e.message); });
    }
    name.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); name.blur(); } if (ev.key === 'Escape') { name.value = d.name || ''; name.blur(); } });
    name.addEventListener('blur', function () { commit(); setTimeout(paintDevices, 0); });
    var head = el('div');
    head.appendChild(name);
    if (d.activeSessions > 0) { var dot = el('span', 'aiondx-mobile-dot'); dot.title = 'Connected now'; dot.setAttribute('data-testid', 'aiondx-mobile-device-active'); head.appendChild(dot); }
    main.appendChild(head);
    main.appendChild(el('div', 'aiondx-mobile-hint', [d.platform, d.appVersion ? 'app ' + d.appVersion : '', d.pairedAt ? 'paired ' + day(d.pairedAt) : ''].filter(Boolean).join(' · ')));
    main.appendChild(el('div', 'aiondx-mobile-hint', 'Last seen ' + ago(d.lastSeenAt) + (d.lastAddress ? ' from ' + d.lastAddress : '')));
    var confirmRow = el('div', 'aiondx-mobile-inline');
    var sw = toggle(function (on) {
      setToggle(sw, on, true);
      api('PATCH', '/api/mobile/admin/devices/' + encodeURIComponent(d.deviceId), { requireConfirm: on }).then(refreshDevices, function (e) {
        setToggle(sw, !on, false); showError('Could not change it: ' + e.message);
      });
    });
    sw.setAttribute('data-testid', 'aiondx-mobile-device-confirm');
    setToggle(sw, d.requireConfirm, false);
    confirmRow.appendChild(sw);
    confirmRow.appendChild(el('span', null, 'Confirm sensitive actions on the phone' + (d.confirmMode === 'passcode' ? ' (passcode)' : d.confirmMode ? ' (' + d.confirmMode + ')' : '')));
    main.appendChild(confirmRow);
    r.appendChild(main);
    var actions = el('div', 'aiondx-mobile-device-actions');
    var rk = button('Reset confirmation key', null, function () { openRekey(d); });
    rk.setAttribute('data-testid', 'aiondx-mobile-device-rekey');
    var rv = button('Revoke', 'danger', function () { confirmRevoke(d); });
    rv.setAttribute('data-testid', 'aiondx-mobile-device-revoke');
    actions.appendChild(rk);
    actions.appendChild(rv);
    r.appendChild(actions);
    return r;
  }

  // ---------------------------------------------------------------- dialogs

  var dialog = null;   // { overlay, box, onClose, timers[] }
  function openDialog(onClose) {
    closeDialog(true);
    var overlay = el('div', 'aiondx-mobile-overlay');
    overlay.setAttribute('data-testid', 'aiondx-mobile-dialog');
    var box = el('div', 'aiondx-mobile-dialog');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    overlay.appendChild(box);
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) closeDialog(); });
    document.body.appendChild(overlay);
    dialog = { overlay: overlay, box: box, onClose: onClose || null, timers: [] };
    return dialog;
  }
  /** quiet: replaced by another dialog or finished, so onClose (a cancel) does not run. */
  function closeDialog(quiet) {
    if (!dialog) return;
    var d = dialog;
    dialog = null;
    d.timers.forEach(function (t) { clearInterval(t); clearTimeout(t); });
    if (d.overlay.parentNode) d.overlay.parentNode.removeChild(d.overlay);
    if (!quiet && d.onClose) d.onClose();
  }
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && dialog) closeDialog(); });

  function countdown(d, node, expiresAt, onExpire) {
    var end = when(expiresAt);
    function tick() {
      if (end == null) { node.textContent = ''; return; }
      var s = Math.max(0, Math.round((end - Date.now()) / 1000));
      node.textContent = 'Expires in ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
      if (s === 0 && onExpire) { onExpire(); onExpire = null; }
    }
    tick();
    d.timers.push(setInterval(tick, 1000));
  }

  function confirmRevoke(dev) {
    var d = openDialog();
    d.box.appendChild(el('h3', null, 'Revoke this phone?'));
    d.box.appendChild(el('p', null, '"' + (dev.name || 'This phone') + '" will be signed out and must pair again to use AionDX.'));
    var b = el('div', 'aiondx-mobile-buttons');
    var yes = button('Revoke', 'danger', function () {
      yes.disabled = true;
      api('DELETE', '/api/mobile/admin/devices/' + encodeURIComponent(dev.deviceId)).then(function () { closeDialog(true); refreshDevices(); }, function (e) {
        yes.disabled = false; d.box.appendChild(el('p', 'aiondx-mobile-error', 'Could not revoke: ' + e.message));
      });
    });
    yes.setAttribute('data-testid', 'aiondx-mobile-revoke-confirm');
    b.appendChild(button('Cancel', null, function () { closeDialog(); }));
    b.appendChild(yes);
    d.box.appendChild(b);
  }

  /** Screen 2: the QR, then the phone's SAS to compare. Closing it while waiting rejects the offer. */
  function openPairing() {
    var offerId = null, state = 'starting', settled = false;
    function reject() {
      if (offerId && !settled) { settled = true; api('POST', '/api/mobile/admin/pairing-offers/' + encodeURIComponent(offerId) + '/reject').catch(function () {}); }
    }
    var d = openDialog(reject);
    d.box.setAttribute('data-testid', 'aiondx-mobile-pairing');
    d.box.appendChild(el('h3', null, 'Pair a phone'));
    var body = el('div');
    d.box.appendChild(body);
    body.appendChild(el('p', null, 'Creating a pairing code...'));

    function show(nodes) { body.textContent = ''; nodes.forEach(function (n) { body.appendChild(n); }); }
    function ended(text) {
      settled = true;
      d.box.setAttribute('data-state', 'ended');
      var b = el('div', 'aiondx-mobile-buttons');
      var again = button('Try again', 'primary', function () { closeDialog(true); openPairing(); });
      again.setAttribute('data-testid', 'aiondx-mobile-pair-again');
      b.appendChild(button('Close', null, function () { closeDialog(true); }));
      b.appendChild(again);
      show([el('p', null, text), b]);
    }

    api('POST', '/api/mobile/admin/pairing-offers', {}).then(function (o) {
      if (dialog !== d) { offerId = o && o.offerId; reject(); return; }   // closed before it arrived
      offerId = o.offerId;
      state = 'waiting';
      d.box.setAttribute('data-state', 'waiting');
      d.box.setAttribute('data-offer-id', offerId);
      var cd = el('div', 'aiondx-mobile-countdown');
      var cancel = button('Cancel', null, function () { closeDialog(); });
      cancel.setAttribute('data-testid', 'aiondx-mobile-pair-cancel');
      var b = el('div', 'aiondx-mobile-buttons'); b.appendChild(cancel);
      show([el('p', null, 'Scan this with the AionDX app on your phone.'), qrCanvas(o.uri), cd, b]);
      countdown(d, cd, o.expiresAt, function () { if (state === 'waiting') ended('The pairing code expired.'); });
      var busy = false;
      d.timers.push(setInterval(function () {
        if (busy || settled || dialog !== d) return;
        busy = true;
        api('GET', '/api/mobile/admin/pairing-offers/' + encodeURIComponent(offerId)).then(function (st) {
          busy = false;
          if (settled || dialog !== d || !st) return;
          if (st.state === 'request_received' && state !== 'request_received') { state = 'request_received'; showSas(st.request || {}); }
          else if (st.state === 'approved') { settled = true; closeDialog(true); refreshDevices(); }
          else if (st.state === 'rejected') ended('Pairing was cancelled.');
          else if (st.state === 'aborted') ended('The phone stopped pairing.');
          else if (st.state === 'expired') ended('The pairing code expired.');
        }, function () { busy = false; });
      }, OFFER_MS));
    }, function (e) {
      settled = true;
      ended('Could not start pairing: ' + e.message);
    });

    function showSas(req) {
      d.box.setAttribute('data-state', 'request_received');
      var who = el('p', null, (req.deviceName || 'A phone') + (req.platform ? ' (' + req.platform + ')' : '') + ' wants to pair.');
      var sas = el('div', 'aiondx-mobile-sas', String(req.sas || ''));
      sas.setAttribute('data-testid', 'aiondx-mobile-sas');
      var note = el('p', null, "Check that your phone shows the same code. If it doesn't, someone else may be trying to pair.");
      var b = el('div', 'aiondx-mobile-buttons');
      var no = button("They don't match", 'danger', function () {
        settled = true;
        api('POST', '/api/mobile/admin/pairing-offers/' + encodeURIComponent(offerId) + '/reject').then(function () { ended('Pairing was cancelled. Nothing was paired.'); }, function () { ended('Pairing was cancelled.'); });
      });
      no.setAttribute('data-testid', 'aiondx-mobile-sas-mismatch');
      var yes = button('The codes match', 'primary', function () {
        yes.disabled = true; no.disabled = true;
        api('POST', '/api/mobile/admin/pairing-offers/' + encodeURIComponent(offerId) + '/approve', { sasConfirmed: true }).then(function () {
          settled = true; closeDialog(true); refreshDevices();
        }, function (e) {
          yes.disabled = false; no.disabled = false;
          body.appendChild(el('p', 'aiondx-mobile-error', 'Could not approve: ' + e.message));
        });
      });
      yes.setAttribute('data-testid', 'aiondx-mobile-sas-match');
      b.appendChild(no); b.appendChild(yes);
      show([who, sas, note, b]);
    }
  }

  /** §5.3: a QR the phone scans to get a new confirmation key; no SAS step, the bridge completes it on its own. */
  function openRekey(dev) {
    var d = openDialog();
    d.box.setAttribute('data-testid', 'aiondx-mobile-rekey');
    d.box.appendChild(el('h3', null, 'Reset confirmation key'));
    var body = el('div');
    d.box.appendChild(body);
    body.appendChild(el('p', null, 'Creating a code...'));
    api('POST', '/api/mobile/admin/devices/' + encodeURIComponent(dev.deviceId) + '/rekey-offers', {}).then(function (o) {
      if (dialog !== d) return;
      body.textContent = '';
      body.appendChild(el('p', null, 'On "' + (dev.name || 'the phone') + '", scan this with the AionDX app. It sets up a new key for confirming sensitive actions.'));
      body.appendChild(qrCanvas(o.uri));
      var cd = el('div', 'aiondx-mobile-countdown');
      body.appendChild(cd);
      countdown(d, cd, o.expiresAt, function () { body.appendChild(el('p', null, 'The code expired. Close this and try again if the phone did not finish.')); });
      var b = el('div', 'aiondx-mobile-buttons');
      b.appendChild(button('Done', 'primary', function () { closeDialog(true); refreshDevices(); }));
      body.appendChild(b);
      d.timers.push(setInterval(refreshDevices, DEVICES_MS));
    }, function (e) {
      body.textContent = '';
      body.appendChild(el('p', 'aiondx-mobile-error', 'Could not create the code: ' + e.message));
    });
  }

  // ---------------------------------------------------------------- firewall (phase 5 route; never run automatically)

  function refreshFirewall() {
    if (firewallMissing) return Promise.resolve();
    return api('GET', '/api/mobile/admin/firewall').then(function (f) { firewall = f || null; paintFirewall(); }, function (e) {
      if (e.status === 404 || e.status === 405) { firewallMissing = true; ui.firewall.hidden = true; }
    });
  }

  function paintFirewall() {
    var f = firewall;
    var box = ui.firewall;
    box.hidden = !f;
    if (!f) return;
    box.textContent = '';
    box.appendChild(el('div', 'aiondx-mobile-section', 'Windows Firewall'));
    var text = f.rule === 'present' ? 'Phones are allowed through Windows Firewall on Private networks.'
      : f.rule === 'absent' ? 'Windows Firewall may block phones from reaching this PC.'
      : 'Could not tell whether Windows Firewall allows phones.';
    var r = el('div', 'aiondx-mobile-row');
    var t = el('div', 'aiondx-mobile-hint', text);
    t.setAttribute('data-testid', 'aiondx-mobile-firewall-state');
    t.setAttribute('data-rule', String(f.rule));
    r.appendChild(t);
    if (f.rule === 'absent') {
      var go = button(ALLOW_LABEL, 'primary', function () { allowFirewall(f.plan, go); });
      go.setAttribute('data-testid', 'aiondx-mobile-firewall-allow');
      r.appendChild(go);
    } else if (f.rule === 'present' && bridgeApi()) {
      var rm = button('Remove the rule', null, function () { removeFirewall(rm); });
      rm.setAttribute('data-testid', 'aiondx-mobile-firewall-remove');
      r.appendChild(rm);
    }
    box.appendChild(r);
  }

  var ALLOW_LABEL = 'Allow phones through Windows Firewall (Private networks only)';
  /** The main process's one narrow handler (patch 0018's apply.js: window.aiondxMobile). The page passes the port and nothing
   *  else; main builds the rule itself for the app's own aioncore.exe and runs it through elevate.exe (a UAC prompt), and answers
   *  { ok, error }. */
  function bridgeApi() {
    var m = window.aiondxMobile;
    return m && typeof m.allowFirewall === 'function' ? m : null;
  }
  function firewallCall(btn, busyLabel, label, call, what) {
    btn.disabled = true;
    setLabel(btn, busyLabel);
    Promise.resolve().then(call).then(function (res) {
      btn.disabled = false; setLabel(btn, label);
      if (res && res.ok) { showError(''); refreshFirewall(); }
      else showError('The firewall rule was not ' + what + ': ' + ((res && res.error) || 'no answer'));
    }, function () {
      btn.disabled = false; setLabel(btn, label);
      showError('The firewall rule was not ' + what + '.');
    });
  }
  function removeFirewall(btn) {
    var api2 = bridgeApi();
    if (api2 && typeof api2.removeFirewall === 'function') firewallCall(btn, 'Waiting for Windows...', 'Remove the rule', function () { return api2.removeFirewall(); }, 'removed');
  }
  /** Only on the user's click. Without the main-process handler (an older build), the exact command is shown for the user to run
   *  themselves in an administrator prompt, never executed from here. */
  function allowFirewall(plan, btn) {
    var api2 = bridgeApi();
    var port = status && status.port;
    if (api2) { firewallCall(btn, 'Waiting for Windows...', ALLOW_LABEL, function () { return api2.allowFirewall(port); }, 'added'); return; }
    if (!plan) { showError('This build cannot change Windows Firewall.'); return; }
    var d = openDialog();
    d.box.appendChild(el('h3', null, 'Allow phones through Windows Firewall'));
    d.box.appendChild(el('p', null, 'This build cannot ask Windows for permission itself yet. To allow phones on Private networks, run this in a Command Prompt opened with "Run as administrator":'));
    var cmd = el('pre', 'aiondx-mobile-hint');
    cmd.setAttribute('data-testid', 'aiondx-mobile-firewall-command');
    cmd.style.cssText = 'text-align:left;white-space:pre-wrap;word-break:break-all;user-select:text';
    // Shown for reading and copying only: key=value arguments with spaces are quoted the way netsh's own help writes them.
    cmd.textContent = [plan.program].concat(plan.args).map(function (a) {
      a = String(a);
      if (!/\s/.test(a)) return a;
      var i = a.indexOf('=');
      return i > 0 ? a.slice(0, i + 1) + '"' + a.slice(i + 1) + '"' : '"' + a + '"';
    }).join(' ');
    d.box.appendChild(cmd);
    var b = el('div', 'aiondx-mobile-buttons');
    b.appendChild(button('Close', null, function () { closeDialog(true); }));
    d.box.appendChild(b);
  }

  // ---------------------------------------------------------------- placement, polling, render loop

  function onPage() { return location.hash.indexOf(ROUTE) === 0; }

  function ensureSider() {
    var webui = document.querySelector('[data-settings-id="webui"]');
    if (!webui || document.querySelector('[data-settings-id="aiondx-mobile"]')) return;
    var item = webui.cloneNode(true);
    item.setAttribute('data-settings-id', 'aiondx-mobile');
    item.setAttribute('data-settings-path', 'webui');
    item.setAttribute('data-testid', 'aiondx-mobile-nav');
    item.classList.remove('active');
    // The label is the item's one non-empty text node ("Remote"), wherever the app's markup puts it.
    var walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
    for (var t = walker.nextNode(); t; t = walker.nextNode()) { if (t.nodeValue.trim()) { t.nodeValue = 'Mobile'; break; } }
    var icon = item.querySelector('svg');
    if (icon) {   // a phone outline, the same size and stroke as the app's icons
      icon.innerHTML = '<rect x="13" y="4" width="22" height="40" rx="3" stroke="currentColor" stroke-width="4" fill="none"/><path d="M21 37h6" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>';
    }
    item.addEventListener('click', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      var go = function () { var c = document.getElementById('aiondx-mobile'); if (c) c.scrollIntoView({ block: 'start', behavior: 'smooth' }); };
      if (!onPage()) { location.hash = ROUTE; setTimeout(go, 400); } else go();
    });
    webui.parentNode.insertBefore(item, webui.nextSibling);
  }

  function anchor() {
    if (!onPage()) return null;
    var tabs = document.querySelector('.arco-tabs');
    return tabs && tabs.parentNode ? tabs : null;
  }

  function startPolling() {
    if (timers.status) return;
    refreshStatus(); refreshDevices(); refreshFirewall();
    timers.status = setInterval(function () { if (!document.hidden) refreshStatus(); }, STATUS_MS);
    timers.devices = setInterval(function () { if (!document.hidden) refreshDevices(); }, DEVICES_MS);
    timers.firewall = setInterval(function () { if (!document.hidden) refreshFirewall(); }, FIREWALL_MS);
  }
  function stopPolling() {
    Object.keys(timers).forEach(function (k) { if (timers[k]) { clearInterval(timers[k]); timers[k] = null; } });
  }

  function render() {
    try { ensureSider(); } catch (e) { console.log('[dx-mobile] sidebar', e); }
    var a = anchor();
    if (!a) {
      if (card && card.parentNode) card.parentNode.removeChild(card);
      stopPolling();
      return;
    }
    ensureStyle();
    if (!card) card = buildCard();
    if (card.parentNode !== a.parentNode || card.nextSibling !== a) a.parentNode.insertBefore(card, a);
    startPolling();
  }

  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () { scheduled = false; render(); });
  }
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('hashchange', schedule);
  schedule();

  window.__aionDxMobile = {
    refresh: function () { return Promise.all([refreshStatus(), refreshDevices(), refreshFirewall()]); },
    state: function () { return { status: status, devices: devices, firewall: firewall, firewallMissing: firewallMissing, dialog: !!dialog }; }
  };
})();
