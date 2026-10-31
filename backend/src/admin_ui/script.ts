// The dashboard's script. Written without template literals so it can sit inside String.raw safely.
import { CONTENT_JS } from './content';
import { MONETIZATION_JS } from './monetization';

export const ADMIN_JS = String.raw`
(function () {
  'use strict';
  var API = '/api/v1';
  var S = { access: null, refresh: null, user: null, isAdmin: false, page: '', caps: [], role: '', timer: null, shell: false, bound: false, menuOpen: false, openReports: 0 };
  var root = document.getElementById('app');

  // ---------- tiny helpers (everything is built with textContent, never raw HTML strings)
  function h(tag, attrs) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === false || v == null) return;
      if (k === 'class') el.className = v;
      else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
    el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function when(x) { return x ? new Date(x).toLocaleString() : ''; }
  function ago(x) {
    var s = Math.max(0, (Date.now() - new Date(x).getTime()) / 1000);
    if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago'; return Math.floor(s / 86400) + ' d ago';
  }
  function dur(sec) {
    if (sec == null) return '-';
    if (sec < 120) return sec + ' s'; if (sec < 7200) return Math.round(sec / 60) + ' min';
    if (sec < 172800) return Math.round(sec / 3600) + ' h'; return Math.round(sec / 86400) + ' d';
  }

  // ---------- talking to the API (sign in, refresh once on 401)
  function post(path, body, token) {
    return fetch(path, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
      body: JSON.stringify(body || {})
    });
  }
  function takeSession(data) {
    S.access = data.accessToken; S.refresh = data.refreshToken;
    try { sessionStorage.setItem('uv_admin_rt', S.refresh); } catch (e) {}
  }
  function refreshSession() {
    if (!S.refresh) return Promise.resolve(false);
    return post('/auth/refresh', { refreshToken: S.refresh }).then(function (r) {
      if (!r.ok) return false;
      return r.json().then(function (d) { takeSession(d); return true; });
    }).catch(function () { return false; });
  }
  function api(method, path, body, retry) {
    var opts = { method: method, headers: { Authorization: 'Bearer ' + S.access } };
    if (body instanceof Blob) { opts.headers['Content-Type'] = body.type; opts.body = body; } // a photo, sent as it is
    else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    // Photo and video uploads live at the server root (/media/...); everything else is under /api/v1.
    return fetch((path.indexOf('/media/') === 0 ? '' : API) + path, opts).then(function (r) {
      if (r.status === 401 && !retry) {
        return refreshSession().then(function (ok) {
          if (!ok) { signOut(); throw new Error('Your session ended. Please sign in again.'); }
          return api(method, path, body, true);
        });
      }
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) { var e = new Error(data.message || ('Request failed (' + r.status + ')')); e.status = r.status; throw e; }
        return data;
      });
    });
  }

  // ---------- sign in
  function signOut() {
    try { sessionStorage.removeItem('uv_admin_rt'); } catch (e) {}
    if (S.access && S.refresh) post('/auth/logout', { refreshToken: S.refresh }).catch(function () {});
    S.access = S.refresh = S.user = null; S.shell = false; stopTimer(); document.title = 'UniVibe admin'; renderLogin();
  }
  function renderLogin(message) {
    clear(root);
    var email = h('input', { type: 'email', placeholder: 'Email', autocomplete: 'username' });
    var pass = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
    var err = h('div', { class: 'err' }, message || '');
    var go = h('button', { class: 'btn', type: 'button' }, 'Sign in');
    function submit() {
      go.disabled = true; err.textContent = '';
      post('/auth/login', { email: email.value.trim(), password: pass.value, deviceName: 'Admin dashboard' }).then(function (r) {
        return r.json().then(function (d) {
          if (!r.ok) throw new Error(d.message || 'Could not sign in.');
          takeSession(d); S.user = d.user || {}; return start();
        });
      }).catch(function (e) { err.textContent = e.message; go.disabled = false; });
    }
    go.addEventListener('click', submit);
    pass.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    root.appendChild(h('div', { class: 'login' }, h('div', { class: 'brand' }, 'Uni', h('b', null, 'Vibe'), ' admin'),
      h('p', { class: 'muted small' }, 'Moderators and administrators only.'), email, pass, err, go));
  }

  // ---------- after sign in: find out what this account may do
  function start() {
    return api('GET', '/moderation/access').then(function (a) {
      S.caps = a.capabilities || []; S.role = a.role || ''; S.me = a.id || ''; S.universityId = a.universityId || '';
      S.isAdmin = S.caps.indexOf('overview.view') >= 0;
      if (!S.isAdmin) return;
      return api('GET', '/admin/overview').then(function (d) { S.openReports = (d.reports && d.reports.open) || 0; }, function () {});
    }).then(function () {
      renderShell();
    }).catch(function (e) {
      var msg = e.status === 403 ? 'This account is not a moderator or administrator.' : e.message;
      S.access = null; renderLogin(msg);
    });
  }

  // ---------- navigation: one list drives the sidebar, the page header and the breadcrumbs
  var ICONS = {
    overview: 'M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z',
    analytics: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
    safety: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
    communities: 'M17 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M10 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM21 20v-2a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8',
    content: 'M5 4h14v16H5zM8 9h8M8 13h8M8 17h5',
    events: 'M4 6h16v14H4zM4 10h16M9 3v5M15 3v5',
    reports: 'M5 3v18M5 4h12l-2 4 2 4H5',
    people: 'M16 8a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM4 21c0-4 4-6 8-6s8 2 8 6',
    system: 'M3 12h4l3-8 4 16 3-8h4',
    audit: 'M4 6h16M4 12h16M4 18h10',
    menu: 'M3 6h18M3 12h18M3 18h18'
  };
  function icon(name) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', ICONS[name]); svg.appendChild(p); return svg;
  }
  // cap is the capability the server grants (see permissions.ts). The API enforces it too; hiding a link is just courtesy.
  var PAGES = {
    overview: { title: 'Overview', group: 'Monitor', cap: 'overview.view', desc: 'Counts and 14-day activity across UniVibe. Counts only, never message text.', view: function (r) { viewOverview(); } },
    analytics: { title: 'Analytics', group: 'Monitor', cap: 'analytics.view', desc: 'Growth and activity over a period you choose, compared with the period before it.', view: viewAnalytics },
    system: { title: 'System health', group: 'Monitor', cap: 'system.view', desc: 'Job queue, push devices, uploads and server status. Refreshes every 30 seconds.', view: function (r) { viewSystem(); } },
    safety: { title: 'Trust & safety', group: 'Moderate', cap: 'analytics.view', desc: 'How fast reports are handled, what is waiting, and what keeps being reported.', view: viewSafety },
    reports: { title: 'Reports', group: 'Moderate', cap: 'reports.review', desc: 'Review what students reported and decide what happens next.', view: viewReports },
    people: { title: 'People', group: 'Moderate', cap: 'users.view', desc: 'Find a student, review their history, suspend or reinstate an account.', view: viewUsers },
    communities: { title: 'Communities', group: 'Manage', cap: 'communities.view', desc: 'Every community: who runs it, how active it is, and whether it has been reported.', view: viewCommunities },
    content: { title: 'Content', group: 'Manage', cap: 'content.view', desc: 'Search posts and comments, and remove or restore them with a recorded reason.', view: viewContent },
    events: { title: 'Events', group: 'Manage', cap: 'events.view', desc: 'Every event with its organizer, going count and status.', view: viewEvents },
    audit: { title: 'Audit log', group: 'Records', cap: 'audit.view', desc: 'Every privileged action: who did what, to what, and when.', view: function (r) { viewAudit(); } }
  };
  var NAV = [['Monitor', ['overview', 'analytics', 'system']], ['Moderate', ['reports', 'safety', 'people']], ['Manage', ['communities', 'content', 'events']], ['Records', ['audit']]];
  var ALIASES = { users: 'people', health: 'system' };

  function href(page, id, params) {
    var s = '#/' + page + (id ? '/' + encodeURIComponent(id) : '');
    var q = Object.keys(params || {}).filter(function (k) { return params[k] != null && params[k] !== ''; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
    return q ? s + '?' + q : s;
  }
  function dec(s) { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) { return s; } }
  function parseHash() {
    var raw = (location.hash || '').replace(/^#\/?/, ''), qi = raw.indexOf('?');
    var path = qi < 0 ? raw : raw.slice(0, qi), qs = qi < 0 ? '' : raw.slice(qi + 1), params = {};
    qs.split('&').forEach(function (p) { if (!p) return; var kv = p.split('='); params[dec(kv[0])] = dec(kv[1] || ''); });
    var parts = path.split('/').filter(Boolean);
    var page = ALIASES[parts[0]] || parts[0] || '';
    return { page: page, id: parts[1] ? dec(parts[1]) : null, params: params };
  }
  function allowed(id) { var p = PAGES[id]; return !!p && (!p.cap || S.caps.indexOf(p.cap) >= 0); }

  var body, crumbsEl, titleEl, descEl, sideEl, menuBtn;
  function setMenu(open) {
    S.menuOpen = open; root.classList.toggle('menu-open', open);
    if (menuBtn) menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function paintNav() {
    if (!sideEl) return;
    Array.prototype.forEach.call(sideEl.querySelectorAll('a.nav'), function (a) {
      var on = a.getAttribute('data-id') === S.page;
      a.classList.toggle('on', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    var b = sideEl.querySelector('[data-badge="reports"]');
    if (b) { b.textContent = S.openReports > 99 ? '99+' : String(S.openReports || ''); b.hidden = !S.openReports; }
  }
  function refreshBadge() {
    if (!S.isAdmin) return;
    api('GET', '/admin/overview').then(function (d) { S.openReports = (d.reports && d.reports.open) || 0; paintNav(); }).catch(function () {});
  }
  // Pages call this to describe where we are. crumbs: [[label, link?], ...] after the group name.
  function setHeader(title, desc, crumbs) {
    var def = PAGES[S.page], trail = [h('li', null, def.group)];
    (crumbs || [[def.title]]).forEach(function (c) { trail.push(h('li', null, c[1] ? h('a', { href: c[1] }, c[0]) : c[0])); });
    clear(crumbsEl); crumbsEl.appendChild(h('ol', null, trail));
    titleEl.textContent = title; descEl.textContent = desc || '';
    document.title = title + ' - UniVibe admin';
  }
  function renderPage(focus) {
    stopTimer();
    var r = parseHash();
    if (!allowed(r.page)) {
      r = { page: S.isAdmin ? 'overview' : 'reports', id: null, params: {} };
      try { history.replaceState(null, '', href(r.page)); } catch (e) {}
    }
    S.page = r.page; setMenu(false); paintNav();
    var def = PAGES[r.page];
    setHeader(def.title, def.desc);
    clear(body);
    def.view(r);
    if (focus) { titleEl.focus({ preventScroll: true }); window.scrollTo(0, 0); }
  }
  function onRoute() { if (S.shell && S.access) renderPage(true); }

  function renderShell() {
    clear(root); S.shell = true; S.menuOpen = false; root.classList.remove('menu-open');
    menuBtn = h('button', { class: 'btn ghost menu-btn', type: 'button', 'aria-label': 'Menu', 'aria-controls': 'side', 'aria-expanded': 'false', onclick: function () { setMenu(!S.menuOpen); } }, icon('menu'));
    root.appendChild(h('a', { class: 'skip', href: '#main', onclick: function (e) { e.preventDefault(); titleEl.focus(); } }, 'Skip to content'));
    root.appendChild(h('header', { class: 'top' }, h('div', { class: 'row tight' }, menuBtn, h('div', { class: 'brand' }, 'Uni', h('b', null, 'Vibe'), ' admin')),
      h('div', { class: 'row tight' }, h('span', { class: 'muted small who' }, (S.user && (S.user.fullName || S.user.name)) || ''),
        h('span', { class: 'pill teal role' }, S.role || 'staff'), h('button', { class: 'btn ghost', type: 'button', onclick: signOut }, 'Sign out'))));
    sideEl = h('nav', { class: 'side', id: 'side', 'aria-label': 'Main navigation' });
    NAV.forEach(function (g) {
      var ids = g[1].filter(allowed); if (!ids.length) return;
      var grp = h('div', { class: 'grp' }, h('div', { class: 'grp-t' }, g[0]));
      ids.forEach(function (id) {
        grp.appendChild(h('a', { class: 'nav', href: href(id), 'data-id': id }, icon(id), h('span', null, PAGES[id].title),
          id === 'reports' && S.isAdmin ? h('span', { class: 'badge', 'data-badge': 'reports', hidden: true, 'aria-label': 'open reports' }) : null));
      });
      sideEl.appendChild(grp);
    });
    crumbsEl = h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' });
    titleEl = h('h1', { tabindex: '-1', id: 'page-title' });
    descEl = h('p', { class: 'muted small desc' });
    body = h('div', { class: 'content' });
    root.appendChild(h('div', { class: 'shell' }, sideEl, h('main', { class: 'main', id: 'main' }, crumbsEl, h('div', { class: 'pagehead' }, titleEl, descEl), body)));
    root.appendChild(h('div', { class: 'scrim', onclick: function () { setMenu(false); } }));
    if (!S.bound) {
      S.bound = true;
      window.addEventListener('hashchange', onRoute);
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.menuOpen) { setMenu(false); if (menuBtn) menuBtn.focus(); } });
    }
    paintNav(); renderPage(false); refreshBadge();
  }
  function stopTimer() { if (S.timer) { clearInterval(S.timer); S.timer = null; } }
  function fail(el, e) { clear(el); el.appendChild(h('div', { class: 'err', role: 'alert' }, e.message)); }

  // ---------- 1. overview
  function kpi(label, n, tone, link) {
    var inner = [h('div', { class: 'n' }, n == null ? '-' : n.toLocaleString()), h('div', { class: 'l' }, label)];
    return link ? h('a', { class: 'card kpi kpi-link ' + (tone || ''), href: link }, inner) : h('div', { class: 'card kpi ' + (tone || '') }, inner);
  }
  function chart(title, rows, span) {
    var W = 300, H = 90, pad = 14, max = Math.max.apply(null, rows.map(function (r) { return r.n; }).concat([1]));
    var bw = (W - 2 * 4) / rows.length;
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('width', '100%');
    rows.forEach(function (r, i) {
      var bh = Math.round((r.n / max) * (H - pad - 4));
      var rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('class', 'bar' + (i === rows.length - 1 ? ' today' : ''));
      rect.setAttribute('x', 4 + i * bw + 1); rect.setAttribute('width', Math.max(1, bw - 3));
      rect.setAttribute('y', H - pad - bh); rect.setAttribute('height', Math.max(bh, r.n ? 1 : 0)); rect.setAttribute('rx', 2);
      var t = document.createElementNS('http://www.w3.org/2000/svg', 'title'); t.textContent = r.day + ': ' + r.n; rect.appendChild(t);
      svg.appendChild(rect);
    });
    [[0, rows[0].day.slice(5)], [rows.length - 1, rows[rows.length - 1].day.slice(5)]].forEach(function (p, k) {
      var tx = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      tx.setAttribute('x', k === 0 ? 4 : W - 4); tx.setAttribute('y', H - 2); tx.setAttribute('text-anchor', k === 0 ? 'start' : 'end'); tx.textContent = p[1]; svg.appendChild(tx);
    });
    var total = rows.reduce(function (a, r) { return a + r.n; }, 0);
    return h('div', { class: 'card' }, h('h3', null, title), h('div', { class: 'small muted' }, total.toLocaleString() + ' in ' + (span || '14 days')), svg);
  }
  function viewOverview() {
    var out = h('div', null, 'Loading...'); body.appendChild(out);
    api('GET', '/admin/overview').then(function (d) {
      clear(out); var t = d.totals, r = d.reports; S.openReports = r.open || 0; paintNav();
      out.appendChild(h('div', { class: 'grid' },
        kpi('Students', t.users, '', href('people')), kpi('Verified email', t.verified), kpi('Active today', t.activeToday), kpi('Active in 7 days', t.activeWeek),
        kpi('Suspended now', t.suspended, t.suspended ? 'warn' : ''), kpi('Open reports', r.open || 0, (r.open || 0) ? 'bad' : '', href('reports', null, { status: 'open' })), kpi('Under review', r.under_review || 0, '', href('reports', null, { status: 'under_review' })),
        kpi('Posts', t.posts), kpi('Comments', t.comments), kpi('Messages', t.messages), kpi('Events', t.events), kpi('Communities', t.communities)));
      out.appendChild(h('div', { class: 'charts' }, chart('New students per day', d.days.signups), chart('Posts per day', d.days.posts),
        chart('Messages per day', d.days.messages), chart('Events created per day', d.days.events), chart('Reports per day', d.days.reports)));
    }).catch(function (e) { fail(out, e); });
  }

  // ---------- analytics: activity in a chosen period, compared with the period just before
  function delta(cur, prev) {
    if (!prev) return cur ? 'new activity (none before)' : 'no change (none before)';
    var p = Math.round(((cur - prev) / prev) * 100);
    return (p > 0 ? '+' : '') + p + '% vs previous period (' + prev.toLocaleString() + ')';
  }
  function metric(label, tip, t, link) {
    var up = t.current > t.previous;
    var el = kpi(label, t.current, '', link);
    el.appendChild(h('div', { class: 'small ' + (t.current === t.previous ? 'muted' : up ? 'ok' : 'muted') }, delta(t.current, t.previous)));
    el.setAttribute('title', tip);
    return el;
  }
  // The page's content-security policy forbids style attributes, so widths are set through the DOM instead.
  function fill(pct) { var el = h('span', { class: 'hbf' }); el.style.width = pct + '%'; return el; }
  function viewAnalytics(r) {
    var p = r.params, custom = !!(p.from || p.to), days = custom ? null : (['7', '30', '90'].indexOf(p.days) >= 0 ? p.days : '30');
    var bar = h('div', { class: 'row seg', role: 'navigation', 'aria-label': 'Period' });
    [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days']].forEach(function (d) {
      bar.appendChild(h('a', { class: 'tab' + (days === d[0] ? ' on' : ''), href: href('analytics', null, { days: d[0] }), 'aria-current': days === d[0] ? 'page' : false }, d[1]));
    });
    var from = h('input', { type: 'date', 'aria-label': 'From', value: p.from || '' }), to = h('input', { type: 'date', 'aria-label': 'To', value: p.to || '' });
    var msg = h('span', { class: 'small err', role: 'alert' });
    bar.appendChild(h('span', { class: 'row tight custom' + (custom ? ' on' : '') }, from, h('span', { class: 'muted small' }, 'to'), to,
      h('button', { class: 'btn ghost', type: 'button', onclick: function () {
        if (!from.value || !to.value) { msg.textContent = 'Pick both dates.'; return; }
        msg.textContent = ''; location.hash = href('analytics', null, { from: from.value, to: to.value });
      } }, 'Apply'), msg));
    var out = h('div', null, 'Loading...'); body.appendChild(bar); body.appendChild(out);
    function load() {
      clear(out); out.appendChild(h('p', { class: 'muted' }, 'Loading...'));
      api('GET', '/admin/analytics' + (custom ? '?from=' + encodeURIComponent(p.from || '') + '&to=' + encodeURIComponent(p.to || '') : '?days=' + days)).then(function (d) {
        clear(out); var t = d.totals, rg = d.range, sfx = rg.length + ' days';
        out.appendChild(h('p', { class: 'muted small' }, rg.from + ' to ' + rg.to + ' (UTC days), compared with ' + rg.prevFrom + ' to ' + rg.prevTo + '.'));
        out.appendChild(h('h3', null, 'Activity in this period'));
        out.appendChild(h('div', { class: 'grid' },
          metric('New students', 'Accounts created in the period.', t.signups, href('people')),
          metric('Verified their email', 'Accounts whose email was verified in the period, whenever they signed up.', t.verified),
          metric('Active students', 'Different people who signed in or kept a session alive in the period.', d.active.distinct),
          metric('Posts', 'Active posts created.', t.posts), metric('Comments', 'Active comments created.', t.comments),
          metric('Messages', 'Messages sent. Counts only, never text.', t.messages), metric('Communities created', 'New communities.', t.communities),
          metric('Community joins', 'Memberships started.', t.joins), metric('Events created', 'New events.', t.events),
          metric('Event sign-ups', 'Registrations that are still active.', t.rsvps),
          metric('Reports received', 'Reports filed in the period.', t.reports, href('reports', null, { status: 'open' }))));
        out.appendChild(h('div', { class: 'charts' }, chart('New students per day', d.daily.signups, sfx), chart('Active students per day', d.active.daily, sfx),
          chart('Posts per day', d.daily.posts, sfx), chart('Comments per day', d.daily.comments, sfx), chart('Messages per day', d.daily.messages, sfx),
          chart('Event sign-ups per day', d.daily.rsvps, sfx), chart('Community joins per day', d.daily.joins, sfx), chart('Reports per day', d.daily.reports, sfx)));
        var rs = d.reports.byReason, max = Math.max.apply(null, rs.map(function (x) { return x.n; }).concat([1]));
        out.appendChild(h('h3', null, 'Reports by reason'));
        out.appendChild(h('div', { class: 'card' }, rs.length ? rs.map(function (x) {
          return h('div', { class: 'hbar' }, h('span', { class: 'small' }, x.reason.replace('_', ' ')), h('span', { class: 'hb' }, fill(Math.max(2, Math.round((x.n / max) * 100)))), h('span', { class: 'small' }, x.n));
        }) : h('p', { class: 'muted small' }, 'No reports in this period.')));
        out.appendChild(h('div', { class: 'card' }, h('h3', null, 'Time to first review'),
          h('div', { class: 'small' }, d.reports.avgHoursToFirstReview == null ? 'No reports in this period have been reviewed yet.'
            : 'Average ' + d.reports.avgHoursToFirstReview + ' hours, across ' + d.reports.reviewed + ' reviewed reports filed in this period.'),
          h('div', { class: 'small muted' }, 'Reports still waiting are not counted, so this can look better than it feels while the queue is long.')));
        out.appendChild(h('h3', null, 'Right now (not tied to the period)'));
        out.appendChild(h('div', { class: 'grid' }, kpi('Students', d.accounts.users), kpi('With verified email', d.accounts.verified),
          kpi('Suspended now', d.accounts.suspended, d.accounts.suspended ? 'warn' : '')));
        out.appendChild(h('details', { class: 'card small' }, h('summary', null, 'How these are counted'),
          h('ul', null,
            h('li', null, 'Days are UTC days. The comparison period is the same number of days immediately before the first day.'),
            h('li', null, 'Active students: different people with a sign-in or a session refresh in the period. It is a sign-in measure, not time in the app.'),
            h('li', null, 'Posts, comments and messages count only items that are currently active, so removed content is not included.'),
            h('li', null, 'Retention, feature adoption and notification delivery are not shown because the app does not record what they need yet.'))));
      }).catch(function (e) { fail(out, e); out.appendChild(h('button', { class: 'btn ghost', type: 'button', onclick: load }, 'Retry')); });
    }
    load();
  }

  // ---------- trust and safety: what came in, how fast it is handled, what is still waiting
  function hbars(rows, label) {
    var max = Math.max.apply(null, rows.map(function (x) { return x.n; }).concat([1]));
    return rows.map(function (x) { return h('div', { class: 'hbar' }, h('span', { class: 'small' }, label(x)), h('span', { class: 'hb' }, fill(Math.max(2, Math.round((x.n / max) * 100)))), h('span', { class: 'small' }, x.n)); });
  }
  function hours(t, what) {
    if (!t.n) return 'No ' + what + ' in this period yet.';
    return 'Median ' + t.median + ' h, average ' + t.avg + ' h, across ' + t.n + ' report' + (t.n > 1 ? 's' : '') + '.';
  }
  function viewSafety(r) {
    var p = r.params, custom = !!(p.from || p.to), days = custom ? null : (['7', '30', '90'].indexOf(p.days) >= 0 ? p.days : '30');
    var bar = h('div', { class: 'row seg', role: 'navigation', 'aria-label': 'Period' });
    [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days']].forEach(function (d) {
      bar.appendChild(h('a', { class: 'tab' + (days === d[0] ? ' on' : ''), href: href('safety', null, { days: d[0] }), 'aria-current': days === d[0] ? 'page' : false }, d[1]));
    });
    var from = h('input', { type: 'date', 'aria-label': 'From', value: p.from || '' }), to = h('input', { type: 'date', 'aria-label': 'To', value: p.to || '' }), msg = h('span', { class: 'small err', role: 'alert' });
    bar.appendChild(h('span', { class: 'row tight custom' + (custom ? ' on' : '') }, from, h('span', { class: 'muted small' }, 'to'), to,
      h('button', { class: 'btn ghost', type: 'button', onclick: function () {
        if (!from.value || !to.value) { msg.textContent = 'Pick both dates.'; return; }
        location.hash = href('safety', null, { from: from.value, to: to.value });
      } }, 'Apply'), msg));
    var out = h('div'); body.appendChild(bar); body.appendChild(out);
    function load() {
      clear(out); out.appendChild(h('p', { class: 'muted' }, 'Loading...'));
      api('GET', '/admin/trust-safety' + (custom ? '?from=' + encodeURIComponent(p.from || '') + '&to=' + encodeURIComponent(p.to || '') : '?days=' + days)).then(function (d) {
        clear(out); var w = d.waiting, sfx = d.range.length + ' days';
        out.appendChild(h('p', { class: 'muted small' }, d.range.from + ' to ' + d.range.to + ' (UTC days).'));
        out.appendChild(h('h3', null, 'Waiting right now'));
        out.appendChild(h('div', { class: 'grid' }, kpi('Unresolved reports', w.total, w.total ? 'warn' : '', href('reports', null, { status: 'open' })), kpi('Nobody has them yet', w.unassigned, '', href('reports', null, { status: 'open', assigned: 'unassigned' })),
          kpi('Escalated', w.escalated, w.escalated ? 'bad' : '', href('reports', null, { status: 'escalated' })), kpi('Older than 3 days', w.overThreeDays, w.overThreeDays ? 'bad' : '')));
        out.appendChild(h('div', { class: 'card' }, h('h3', null, 'How long they have waited'), hbars([{ k: 'Under a day', n: w.underDay }, { k: '1 to 3 days', n: w.oneToThreeDays }, { k: 'Over 3 days', n: w.overThreeDays }], function (x) { return x.k; })));
        out.appendChild(h('h3', null, 'In this period'));
        out.appendChild(h('div', { class: 'grid' }, kpi('Reports received', d.received), kpi('Moderation actions', d.actionsByType.reduce(function (a, x) { return a + x.n; }, 0))));
        out.appendChild(h('div', { class: 'card' }, h('h3', null, 'Speed'),
          h('div', { class: 'small' }, h('b', null, 'First look: '), hours(d.firstReview, 'reports looked at')),
          h('div', { class: 'small' }, h('b', null, 'Resolved: '), hours(d.resolution, 'resolved reports')),
          h('div', { class: 'small ' + (d.stillWaitingFromPeriod ? 'err' : 'muted') }, d.stillWaitingFromPeriod + ' report' + (d.stillWaitingFromPeriod === 1 ? '' : 's') + ' from this period ' + (d.stillWaitingFromPeriod === 1 ? 'is' : 'are') + ' still unresolved and not counted in the times above.')));
        out.appendChild(h('div', { class: 'charts' }, chart('Reports per day', d.daily.reports, sfx), chart('Moderation actions per day', d.daily.actions, sfx)));
        out.appendChild(h('div', { class: 'card' }, h('h3', null, 'By reason'), d.byReason.length ? hbars(d.byReason, function (x) { return x.reason.replace('_', ' '); }) : h('p', { class: 'muted small' }, 'No reports in this period.')));
        out.appendChild(h('div', { class: 'card' }, h('h3', null, 'By what was reported'), d.byTarget.length ? hbars(d.byTarget, function (x) { return x.targetType.replace('_', ' '); }) : h('p', { class: 'muted small' }, 'No reports in this period.')));
        out.appendChild(h('div', { class: 'card' }, h('h3', null, 'Actions taken'), d.actionsByType.length ? hbars(d.actionsByType, function (x) { return x.action.replace('_', ' '); }) : h('p', { class: 'muted small' }, 'No actions in this period.')));
        out.appendChild(h('div', { class: 'card' }, h('h3', null, 'Reported more than once'),
          h('p', { class: 'small' }, d.repeated.targets + ' item' + (d.repeated.targets === 1 ? ' was' : 's were') + ' reported by two or more people.'),
          d.repeated.top.length ? hbars(d.repeated.top, function (x) { return x.targetType.replace('_', ' '); }) : null));
        out.appendChild(h('details', { class: 'card small' }, h('summary', null, 'How these are counted'), h('ul', null,
          h('li', null, 'First look is the moment a report was first taken, marked under review, escalated or decided. Resolved is when it was dismissed or acted on.'),
          h('li', null, 'Times only cover reports filed in the period, and the still-unresolved ones are listed separately, so a long queue cannot hide behind a fast average.'),
          h('li', null, 'Reports have no severity field, so urgency is shown by age and escalation instead.'),
          h('li', null, 'Reporters who file the same item twice are counted once (the app blocks duplicates), so "more than once" means different people.'))));
      }).catch(function (e) { fail(out, e); out.appendChild(h('button', { class: 'btn ghost', type: 'button', onclick: load }, 'Retry')); });
    }
    load();
  }

  // ---------- manage: communities, content, events (shared pieces first)
  function has(cap) { return S.caps.indexOf(cap) >= 0; }
  function nav2(page, f, patch) { var n = Object.assign({}, f, patch); if (!('page' in (patch || {}))) n.page = ''; Object.keys(n).forEach(function (k) { if (n[k] === 'all') n[k] = ''; }); location.hash = href(page, null, n); }
  function pagerFor(el, page, f, d) {
    clear(el); if (d.pages <= 1) return;
    var cur = d.page, link = function (n, label, off) { return off ? h('span', { class: 'muted small' }, label) : h('a', { class: 'btn ghost', href: href(page, null, Object.assign({}, f, { status: f.status === 'all' ? '' : f.status, page: n > 1 ? n : '' })) }, label); };
    el.appendChild(link(cur - 1, 'Previous', cur <= 1)); el.appendChild(h('span', { class: 'small' }, 'Page ' + d.page + ' of ' + d.pages)); el.appendChild(link(cur + 1, 'Next', cur >= d.pages));
  }
  // A button that opens a reason box; nothing happens until the reason is given and confirmed.
  function actionForm(label, danger, confirmText, run) {
    var box = h('div'), open = false;
    var btn = h('button', { class: 'btn ' + (danger ? 'danger' : 'ghost'), type: 'button' }, label);
    var why = h('textarea', { placeholder: 'Reason (required, kept in the history)', 'aria-label': 'Reason', maxlength: 500 });
    var msg = h('input', { type: 'text', maxlength: 300, placeholder: 'Message to the owner or author (optional, they see it)', 'aria-label': 'Message' });
    var out = h('div', { class: 'small', role: 'status' }), go = h('button', { class: 'btn ' + (danger ? 'danger' : ''), type: 'button' }, 'Confirm: ' + label);
    var panel = h('div', null, why, msg, h('div', { class: 'row' }, go, h('button', { class: 'btn ghost', type: 'button', onclick: function () { toggle(false); } }, 'Cancel')), out);
    function toggle(v) { open = v; btn.setAttribute('aria-expanded', v ? 'true' : 'false'); clear(box); if (v) { box.appendChild(panel); why.focus(); } }
    btn.setAttribute('aria-expanded', 'false'); btn.addEventListener('click', function () { toggle(!open); });
    go.addEventListener('click', function () {
      var r = why.value.trim(); if (r.length < 3) { out.textContent = 'Please give a reason first.'; out.className = 'small err'; why.focus(); return; }
      if (!window.confirm(confirmText)) return;
      go.disabled = true;
      run({ note: r, userMessage: msg.value }).catch(function (e) { go.disabled = false; out.textContent = e.message; out.className = 'small err'; });
    });
    return h('div', null, btn, box);
  }
  function filterBar(page, f, spec) {
    var row = h('div', { class: 'row' });
    spec.forEach(function (s) { row.appendChild(pick(s[0], f[s[1]] || s[2][0][0], s[2], function (v) { nav2(page, f, (function (o) { o[s[1]] = v; return o; })({})); })); });
    return row;
  }
  function searchBox(page, f, placeholder) {
    var q = h('input', { type: 'search', placeholder: placeholder, 'aria-label': 'Search', value: f.q || '' });
    function go() { var t = q.value.trim(); if (t && t.length < 2) return; nav2(page, f, { q: t }); }
    q.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    return h('div', { class: 'row' }, q, h('button', { class: 'btn', type: 'button', onclick: go }, 'Search'));
  }
  function uniPick(d, f, page) { return d.universities && d.universities.length > 1 ? pick('Campus', f.university || '', [['', 'All campuses']].concat(d.universities.map(function (u) { return [u.id, u.name]; })), function (v) { nav2(page, f, { university: v }); }) : null; }
  function listShell(page, route, fields, apiPath, draw, searchHint, specs) {
    var f = {}; fields.forEach(function (k) { f[k] = route.params[k] || ''; });
    var results = h('div'), pager = h('div', { class: 'row pager' }), uniSlot = h('span');
    if (searchHint) body.appendChild(searchBox(page, f, searchHint));
    var bar = filterBar(page, f, specs); bar.appendChild(uniSlot); body.appendChild(bar); body.appendChild(results); body.appendChild(pager);
    function load() {
      clear(results); results.appendChild(h('p', { class: 'muted' }, 'Loading...'));
      var qs = {}; fields.forEach(function (k) { if (f[k] && f[k] !== 'all') qs[k] = f[k]; });
      api('GET', apiPath + href('', null, qs).slice(2)).then(function (d) {
        clear(results); clear(uniSlot); var u = uniPick(d, f, page); if (u) uniSlot.appendChild(u);
        results.appendChild(h('p', { class: 'muted small', role: 'status' }, d.total.toLocaleString() + (d.total === 1 ? ' result' : ' results')));
        if (!d.items.length) results.appendChild(h('p', { class: 'muted' }, 'Nothing matches. Try a different search or filter.'));
        d.items.forEach(function (x) { results.appendChild(draw(x, load, d)); });
        pagerFor(pager, page, f, d);
      }).catch(function (e) { fail(results, e); results.appendChild(h('button', { class: 'btn ghost', type: 'button', onclick: load }, 'Retry')); });
    }
    load();
  }
  var YESNO = function (label) { return [['', label], ['1', 'Yes']]; };

  // ---- communities
  function viewCommunities(r) {
    if (r.id) return viewCommunity(r.id);
    S.communitiesBack = location.hash || href('communities');
    listShell('communities', r, ['q', 'status', 'visibility', 'university', 'reported', 'sort', 'page'], '/admin/communities', function (c) {
      return h('div', { class: 'card' }, h('a', { class: 'link', href: href('communities', c.id) }, c.name),
        h('div', { class: 'small muted' }, 'by ' + c.owner.name + ' (@' + c.owner.handle + ') - ' + c.university + ' - created ' + ago(c.createdAt)),
        h('div', null, h('span', { class: 'pill' + (c.status === 'active' ? ' teal' : c.status === 'suspended' ? ' red' : '') }, c.status), h('span', { class: 'pill' }, c.visibility),
          c.openReports ? h('span', { class: 'pill red' }, c.openReports + ' open report' + (c.openReports > 1 ? 's' : '')) : null),
        h('div', { class: 'small muted' }, c.members + ' members - ' + c.posts + ' posts - ' + c.events + ' events'));
    }, 'Community name (2+ letters)', [
      ['Status', 'status', [['', 'Any status'], ['active', 'Active'], ['archived', 'Archived'], ['suspended', 'Suspended'], ['deleted', 'Deleted']]],
      ['Visibility', 'visibility', [['', 'Public and private'], ['public', 'Public'], ['private', 'Private']]],
      ['Reported', 'reported', YESNO('All')],
      ['Sort by', 'sort', [['', 'Newest first'], ['oldest', 'Oldest first'], ['name', 'Name A to Z'], ['members', 'Most members']]]]);
  }
  function viewCommunity(id) {
    var detail = h('div', null, 'Loading...'); body.appendChild(detail);
    var back = S.communitiesBack || href('communities');
    function open() {
      api('GET', '/admin/communities/' + id).then(function (c) {
        clear(detail); setHeader(c.name, c.category + ' - ' + c.visibility + ' - ' + c.university, [['Communities', back], [c.name]]);
        var a = c.activity, mc = {}; c.memberCounts.forEach(function (x) { mc[x.status] = (mc[x.status] || 0) + x.n; });
        detail.appendChild(h('div', { class: 'card' }, h('p', null, c.description),
          h('div', null, h('span', { class: 'pill' + (c.status === 'active' ? ' teal' : c.status === 'suspended' ? ' red' : '') }, c.status), h('span', { class: 'pill' }, 'joining: ' + c.membershipPolicy.replace('_', ' ')),
            h('span', { class: 'pill' }, 'posting: ' + c.postPermission), c.discoverable ? null : h('span', { class: 'pill' }, 'hidden from discovery')),
          c.suspension ? h('p', { class: 'small err' }, 'Suspended ' + when(c.suspension.at) + (c.suspension.by ? ' by ' + c.suspension.by : '')) : null,
          c.rules.length ? h('details', { class: 'small' }, h('summary', null, 'Rules (' + c.rules.length + ')'), h('ol', null, c.rules.map(function (x) { return h('li', null, x); }))) : null));
        detail.appendChild(h('div', { class: 'grid' }, kpi('Members', c.members), kpi('Joined, last 7 days', a.joinsLast7Days), kpi('Posts', a.posts), kpi('Posts, last 7 days', a.postsLast7Days),
          kpi('Channels', a.channels), kpi('Channel messages, 7 days', a.channelMessagesLast7Days), kpi('Upcoming events', a.upcomingEvents), kpi('Join requests waiting', a.pendingRequests),
          kpi('Open reports', c.reports.open, c.reports.open ? 'bad' : '', c.reports.open ? href('reports', null, { status: 'open' }) : ''), kpi('All reports', c.reports.total)));
        detail.appendChild(h('div', { class: 'card' }, h('h3', null, 'Who runs it'),
          c.staff.map(function (s) { return h('div', { class: 'small' }, h('a', { class: 'link', href: href('people', s.id) }, s.name + ' (@' + s.handle + ')'), ' - ' + s.role); }),
          h('p', { class: 'muted small' }, 'Ordinary members are counted, not listed. Message text is never shown here.')));
        if (has('communities.suspend') && c.status !== 'deleted') {
          var run = function (kind) { return function (b) { return api('POST', '/admin/communities/' + id + '/' + kind, b).then(open); }; };
          detail.appendChild(h('div', { class: 'card' }, h('h3', null, c.status === 'suspended' ? 'Restore this community' : 'Suspend this community'),
            h('p', { class: 'muted small' }, c.status === 'suspended' ? 'It goes back to how it was before the suspension.' : 'Members lose access and it disappears from discovery until restored. Open reports about it are settled.'),
            c.status === 'suspended' ? actionForm('Restore', false, 'Restore ' + c.name + '?', run('restore')) : actionForm('Suspend', true, 'Suspend ' + c.name + '? Its members will lose access.', run('suspend'))));
        }
        detail.appendChild(h('div', { class: 'card' }, h('h3', null, 'Moderation history'), c.history.length ? h('div', { class: 'scroll' }, h('table', null, c.history.map(function (x) { return h('tr', null, h('td', null, when(x.at)), h('td', null, x.action.replace('_', ' ')), h('td', null, x.by || ''), h('td', null, x.note || '')); }))) : h('p', { class: 'muted small' }, 'None.')));
      }).catch(function (e) { fail(detail, e); detail.appendChild(h('div', { class: 'row' }, h('button', { class: 'btn ghost', type: 'button', onclick: open }, 'Retry'), h('a', { class: 'link', href: back }, 'Back to Communities'))); });
    }
    open();
  }

  // ---- content
  function viewContent(r) {
    var type = r.params.type === 'comment' ? 'comment' : 'post';
    var seg = h('div', { class: 'row seg', role: 'navigation', 'aria-label': 'Kind' });
    [['post', 'Posts'], ['comment', 'Comments']].forEach(function (t) { seg.appendChild(h('a', { class: 'tab' + (type === t[0] ? ' on' : ''), href: href('content', null, { type: t[0] }), 'aria-current': type === t[0] ? 'page' : false }, t[1])); });
    body.appendChild(seg);
    var from = h('input', { type: 'date', 'aria-label': 'From', value: r.params.from || '' }), to = h('input', { type: 'date', 'aria-label': 'To', value: r.params.to || '' });
    var rt = Object.assign({}, r, { params: Object.assign({}, r.params, { type: type }) });
    body.appendChild(h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Between'), from, h('span', { class: 'muted small' }, 'and'), to,
      h('button', { class: 'btn ghost', type: 'button', onclick: function () { nav2('content', { type: type, q: r.params.q, status: r.params.status, reported: r.params.reported, university: r.params.university, sort: r.params.sort }, { from: from.value, to: to.value }); } }, 'Apply dates')));
    listShell('content', rt, ['type', 'q', 'status', 'university', 'reported', 'from', 'to', 'sort', 'page'], '/admin/content', function (x, reload) {
      var removed = x.status === 'removed';
      var run = function (kind) { return function (b) { return api('POST', '/admin/content/' + type + '/' + x.id + '/' + kind, b).then(reload); }; };
      return h('div', { class: 'card' }, h('div', null, h('span', { class: 'pill' + (removed ? ' red' : ' teal') }, x.status), x.community ? h('span', { class: 'pill' }, x.community) : null,
        x.openReports ? h('span', { class: 'pill red' }, x.openReports + ' open report' + (x.openReports > 1 ? 's' : '')) : (x.totalReports ? h('span', { class: 'pill' }, x.totalReports + ' past') : null)),
        h('div', { class: 'quote' }, x.preview),
        h('div', { class: 'small muted' }, h('a', { class: 'link', href: href('people', x.author.id) }, x.author.name + ' (@' + x.author.handle + ')'), ' - ' + x.university + ' - ' + ago(x.createdAt)),
        has('content.moderate') ? (removed ? actionForm('Restore', false, 'Restore this ' + type + '?', run('restore')) : actionForm('Remove', true, 'Remove this ' + type + '? The author is told.', run('remove'))) : null);
    }, 'Words in the text (2+ letters)', [
      ['Status', 'status', [['', 'Active and removed'], ['active', 'Active'], ['removed', 'Removed']]], ['Reported', 'reported', YESNO('All')],
      ['Sort by', 'sort', [['', 'Newest first'], ['oldest', 'Oldest first']]]]);
    body.appendChild(h('p', { class: 'muted small' }, 'Shows what any student on campus can read, plus anything that has been reported. Followers-only posts and private-community posts appear only once reported.'));
  }

  // ---- events
  function viewEvents(r) {
    listShell('events', r, ['q', 'when', 'status', 'hidden', 'reported', 'university', 'community', 'organizer', 'sort', 'page'], '/admin/events', function (e, reload) {
      var mine = e.university === S.universityId;
      var run = function (kind) { return function (b) { return api('POST', '/moderation/events/' + e.id + '/' + kind, b).then(reload); }; };
      return h('div', { class: 'card' }, h('div', null, h('span', { class: 'pill' + (e.status === 'published' ? ' teal' : '') }, e.status), e.hidden ? h('span', { class: 'pill red' }, 'hidden') : null,
        h('span', { class: 'pill' }, e.type.replace('_', ' ')), h('span', { class: 'pill' }, e.visibility), e.openReports ? h('span', { class: 'pill red' }, e.openReports + ' open report' + (e.openReports > 1 ? 's' : '')) : null),
        h('div', null, h('b', null, e.title)),
        h('div', { class: 'small muted' }, when(e.startsAt) + (e.venue ? ' - ' + e.venue : ' - online') + ' - ' + e.registered + ' going'),
        h('div', { class: 'small muted' }, 'by ', h('a', { class: 'link', href: href('people', e.organizer.id) }, e.organizer.name + ' (@' + e.organizer.handle + ')'), e.community ? ' - in ' + e.community.name : '', ' - ' + e.university),
        mine && has('reports.review') ? (e.hidden ? actionForm('Restore', false, 'Make this event visible again?', run('restore')) : actionForm('Hide', true, 'Hide this event from students?', run('hide')))
          : h('div', { class: 'small muted' }, 'Events from other campuses can only be hidden by that campus\'s moderators.'));
    }, 'Event title (2+ letters)', [
      ['When', 'when', [['', 'Any date'], ['upcoming', 'Upcoming'], ['past', 'Past']]], ['Status', 'status', [['', 'Any status'], ['published', 'Published'], ['cancelled', 'Cancelled'], ['completed', 'Completed']]],
      ['Hidden', 'hidden', YESNO('Hidden or not')], ['Reported', 'reported', YESNO('All')],
      ['Sort by', 'sort', [['', 'Newest first'], ['soonest', 'Soonest first'], ['latest', 'Latest first']]]]);
  }

  // ---------- 2. reports queue
  var REPORT_ACTIONS = [['remove_content', 'Remove post / comment / channel message'], ['restore_content', 'Restore removed content'], ['hide_event', 'Hide event'], ['restore_event', 'Restore event'], ['suspend_user', 'Suspend the person'], ['unsuspend_user', 'Lift suspension']];
  function previewText(p) {
    if (p == null) return '(content is no longer available)';
    if (typeof p === 'string') return p;
    return p.text || p.title || p.content || p.name || JSON.stringify(p).slice(0, 400);
  }
  function viewReports(r) {
    var STATUSES = [['open', 'Open'], ['under_review', 'Under review'], ['escalated', 'Escalated'], ['action_taken', 'Action taken'], ['dismissed', 'Dismissed']];
    var status = STATUSES.some(function (s) { return s[0] === r.params.status; }) ? r.params.status : 'open';
    var assigned = r.params.assigned === 'me' || r.params.assigned === 'unassigned' ? r.params.assigned : '';
    var live = status === 'open' || status === 'under_review' || status === 'escalated';
    var bar = h('div', { class: 'row seg', role: 'navigation', 'aria-label': 'Report status' }), list = h('div'), more = h('div');
    var who = live ? pick('Handled by', assigned, [['', 'Anyone'], ['me', 'Me'], ['unassigned', 'Nobody yet']], function (v) { location.hash = href('reports', null, { status: status, assigned: v }); }) : null;
    body.appendChild(bar); if (who) body.appendChild(h('div', { class: 'row' }, who)); body.appendChild(list); body.appendChild(more);
    STATUSES.forEach(function (s) {
      bar.appendChild(h('a', { class: 'tab' + (status === s[0] ? ' on' : ''), href: href('reports', null, { status: s[0], assigned: assigned }), 'aria-current': status === s[0] ? 'page' : false }, s[1]));
    });
    function load(cursor) {
      if (!cursor) clear(list); clear(more);
      var qs = '?status=' + (status === 'escalated' ? 'under_review&escalated=1' : status) + (assigned && live ? '&assigned=' + assigned : '') + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      api('GET', '/moderation/reports' + qs).then(function (d) {
        if (!d.items.length && !cursor) list.appendChild(h('p', { class: 'muted' }, status === 'open' && !assigned ? 'Nothing waiting. All clear.' : 'No reports match.'));
        d.items.forEach(function (x) { list.appendChild(reportCard(x, function () { load(null); })); });
        if (d.nextCursor) more.appendChild(h('button', { class: 'btn ghost', type: 'button', onclick: function () { load(d.nextCursor); } }, 'Load more'));
      }).catch(function (e) { fail(list, e); list.appendChild(h('button', { class: 'btn ghost', type: 'button', onclick: function () { load(null); } }, 'Retry')); });
    }
    load(null);
  }
  function reportCard(r, reload) {
    var live = r.status === 'open' || r.status === 'under_review', canAssign = S.caps.indexOf('reports.assign') >= 0;
    var note = h('textarea', { placeholder: 'Reason (required to dismiss, escalate or act; kept in the history)', 'aria-label': 'Reason', maxlength: 500 });
    var msg = h('input', { type: 'text', maxlength: 300, placeholder: 'Message to the person (optional, they see it)', 'aria-label': 'Message to the person', style: false });
    var days = h('input', { type: 'number', min: 1, max: 30, value: 7, 'aria-label': 'Days', style: false });
    var sel = h('select', { 'aria-label': 'Action' });
    REPORT_ACTIONS.forEach(function (a) { sel.appendChild(h('option', { value: a[0] }, a[1])); });
    var out = h('div', { class: 'small', role: 'status' });
    var card = h('div', { class: 'card' });
    function bad(text) { out.textContent = text; out.className = 'small err'; }
    function done(text) { clear(card); card.appendChild(h('div', { class: 'ok', role: 'status' }, text)); refreshBadge(); }
    function reason() { var v = note.value.trim(); if (v.length < 3) { bad('Please give a reason first.'); note.focus(); return null; } return v; }
    function post(path, b, okText) { return api('POST', '/moderation/reports/' + r.id + '/' + path, b).then(function () { if (okText) done(okText); else { refreshBadge(); reload(); } }).catch(function (e) { bad(e.message); }); }
    function review(st) {
      var why = st === 'dismissed' ? reason() : note.value.trim(); if (st === 'dismissed' && !why) return;
      if (st === 'dismissed' && !window.confirm('Dismiss this report? Nothing will happen to the reported item.')) return;
      post('review', { status: st, note: why || '' }, st === 'dismissed' ? 'Dismissed.' : 'Marked under review.');
    }
    function act() {
      var why = reason(); if (!why) return;
      var label = sel.options[sel.selectedIndex].text;
      if (!window.confirm(label + '? This applies to everything open about the same item.')) return;
      var b = { action: sel.value, note: why, userMessage: msg.value };
      if (sel.value === 'suspend_user') b.days = Math.max(1, Math.min(30, parseInt(days.value, 10) || 7));
      post('action', b, 'Done: ' + label + '.');
    }
    function escalate() {
      var why = reason(); if (!why) return;
      if (!window.confirm('Escalate to an administrator?')) return;
      post('escalate', { note: why });
    }
    var mine = r.assignedTo && S.me && r.assignedTo.id === S.me;
    card.appendChild(h('div', null, h('span', { class: 'pill red' }, r.reason.replace('_', ' ')), h('span', { class: 'pill' }, r.targetType),
      r.escalatedAt ? h('span', { class: 'pill amber' }, 'escalated') : null,
      r.reportCount > 1 ? h('span', { class: 'pill amber' }, r.reportCount + ' reports on this') : null,
      live ? h('span', { class: 'pill' + (r.assignedTo ? ' teal' : '') }, r.assignedTo ? 'with ' + (mine ? 'you' : r.assignedTo.name || 'a moderator') : 'nobody yet') : null,
      h('span', { class: 'muted small' }, ago(r.createdAt))));
    card.appendChild(h('div', { class: 'quote' }, previewText(r.preview)));
    if (r.details) card.appendChild(h('div', { class: 'small' }, h('span', { class: 'muted' }, 'Reporter says: '), r.details));
    if (r.reporter) card.appendChild(h('div', { class: 'small muted' }, 'Reported by ' + (r.reporter.name || r.reporter.fullName || 'a student')));
    if (live) {
      var take = !mine ? h('button', { class: 'btn ghost', type: 'button', onclick: function () { post('assign', { to: 'me' }); } }, r.assignedTo ? 'Take over' : 'Take it') : null;
      var release = (mine || (canAssign && r.assignedTo)) ? h('button', { class: 'btn ghost', type: 'button', onclick: function () { post('assign', { to: 'none' }); } }, 'Release') : null;
      card.appendChild(h('div', { class: 'row' }, take, release));
      card.appendChild(note); card.appendChild(msg);
      card.appendChild(h('div', { class: 'row' }, sel, h('span', { class: 'muted small' }, 'days (suspend):'), days, h('button', { class: 'btn danger', type: 'button', onclick: act }, 'Apply')));
      card.appendChild(h('div', { class: 'row' }, r.status === 'open' ? h('button', { class: 'btn ghost', type: 'button', onclick: function () { review('under_review'); } }, 'Mark under review') : null,
        !r.escalatedAt ? h('button', { class: 'btn ghost', type: 'button', onclick: escalate }, 'Escalate') : null,
        h('button', { class: 'btn ghost', type: 'button', onclick: function () { review('dismissed'); } }, 'Dismiss')));
    } else card.appendChild(h('div', { class: 'small muted' }, 'Status: ' + r.status.replace('_', ' ')));
    card.appendChild(out);
    card.appendChild(reportDetails(r, reload));
    return card;
  }
  // Notes, other reports on the same item, and what was done before. Loaded only when opened.
  function reportDetails(r, reload) {
    var box = h('details', { class: 'small' }, h('summary', null, 'Notes and history' + (r.noteCount ? ' (' + r.noteCount + ' notes)' : ''))), inner = h('div'), loaded = false;
    box.appendChild(inner);
    function draw() {
      clear(inner); inner.appendChild(h('p', { class: 'muted' }, 'Loading...'));
      api('GET', '/moderation/reports/' + r.id).then(function (d) {
        clear(inner);
        if (d.reportsOnThis.length) inner.appendChild(h('p', { class: 'muted' }, 'All reports on this item: ' + d.reportsOnThis.map(function (x) { return x.n + ' ' + x.reason.replace('_', ' '); }).join(', ') + '.'));
        if (d.resolvedAt) inner.appendChild(h('p', null, 'Resolved ' + ago(d.resolvedAt) + (d.resolvedBy ? ' by ' + d.resolvedBy : '') + (d.resolutionNote ? ': ' + d.resolutionNote : '.')));
        d.notes.forEach(function (n) { inner.appendChild(h('div', { class: 'quote' }, n.note, h('div', { class: 'muted' }, (n.by || 'a staff member') + ' - ' + when(n.at)))); });
        if (!d.notes.length) inner.appendChild(h('p', { class: 'muted' }, 'No notes yet.'));
        if (d.history.length) inner.appendChild(h('div', { class: 'scroll' }, h('table', null, d.history.map(function (a) { return h('tr', null, h('td', null, when(a.at)), h('td', null, a.action.replace('_', ' ')), h('td', null, a.by || ''), h('td', null, a.note || '')); }))));
        var nb = h('textarea', { placeholder: 'Private note for staff', 'aria-label': 'Private note', maxlength: 1000 }), no = h('div', { class: 'small', role: 'status' });
        inner.appendChild(nb);
        inner.appendChild(h('button', { class: 'btn ghost', type: 'button', onclick: function () {
          if (!nb.value.trim()) { no.textContent = 'Write a note first.'; no.className = 'small err'; return; }
          api('POST', '/moderation/reports/' + r.id + '/notes', { note: nb.value }).then(draw).catch(function (e) { no.textContent = e.message; no.className = 'small err'; });
        } }, 'Add note'));
        inner.appendChild(no);
      }).catch(function (e) { fail(inner, e); inner.appendChild(h('button', { class: 'btn ghost', type: 'button', onclick: draw }, 'Retry')); });
    }
    box.addEventListener('toggle', function () { if (box.open && !loaded) { loaded = true; draw(); } });
    return box;
  }

  // ---------- 3. people
  var PEOPLE_STATUS = [['all', 'Everyone'], ['active', 'Active'], ['suspended', 'Suspended'], ['unverified', 'Email not verified'], ['recent', 'Joined in last 7 days'], ['reported', 'Has open reports'], ['deactivated', 'Deactivated']];
  var PEOPLE_SORT = [['newest', 'Newest first'], ['oldest', 'Oldest first'], ['name', 'Name A to Z'], ['seen', 'Last seen']];
  function pick(label, value, options, onchange) {
    var sel = h('select', { 'aria-label': label });
    options.forEach(function (o) { var op = h('option', { value: o[0] }, o[1]); if (o[0] === value) op.selected = true; sel.appendChild(op); });
    sel.addEventListener('change', function () { onchange(sel.value); });
    return sel;
  }
  function badges(u) {
    return h('div', null, u.role !== 'user' ? h('span', { class: 'pill teal' }, u.role) : null, !u.verified ? h('span', { class: 'pill amber' }, 'email not verified') : null,
      u.suspendedUntil ? h('span', { class: 'pill red' }, 'suspended until ' + when(u.suspendedUntil)) : null, u.deactivated ? h('span', { class: 'pill' }, 'deactivated') : null,
      u.openReports ? h('span', { class: 'pill red' }, u.openReports + ' open report' + (u.openReports > 1 ? 's' : '')) : null);
  }
  function viewUsers(r) {
    if (r.id) return viewPerson(r.id);
    var P = r.params, page = Math.max(1, parseInt(P.page, 10) || 1);
    var f = { q: P.q || '', status: P.status || 'all', university: P.university || '', sort: P.sort || 'newest' };
    S.peopleBack = location.hash || href('people');
    function go(change) { var n = Object.assign({}, f, change); n.page = null; if (n.status === 'all') n.status = ''; if (n.sort === 'newest') n.sort = ''; location.hash = href('people', null, n); }
    var q = h('input', { type: 'search', placeholder: 'Name, @handle or email (2+ letters)', 'aria-label': 'Search people', value: f.q });
    function search() { var t = q.value.trim(); if (t && t.length < 2) return; go({ q: t }); }
    q.addEventListener('keydown', function (e) { if (e.key === 'Enter') search(); });
    var uniSlot = h('span'), results = h('div'), pager = h('div', { class: 'row pager' });
    body.appendChild(h('div', { class: 'row' }, q, h('button', { class: 'btn', type: 'button', onclick: search }, 'Search')));
    body.appendChild(h('div', { class: 'row' }, pick('Show', f.status, PEOPLE_STATUS, function (v) { go({ status: v }); }), uniSlot,
      pick('Sort by', f.sort, PEOPLE_SORT, function (v) { go({ sort: v }); })));
    body.appendChild(results); body.appendChild(pager);
    function load() {
      clear(results); results.appendChild(h('p', { class: 'muted' }, 'Loading...'));
      var qs = { q: f.q, status: f.status === 'all' ? '' : f.status, university: f.university, sort: f.sort === 'newest' ? '' : f.sort, page: page > 1 ? page : '' };
      api('GET', '/admin/users' + href('', null, qs).slice(2)).then(function (d) {
        clear(results); clear(uniSlot); clear(pager);
        if (d.universities && d.universities.length > 1) uniSlot.appendChild(pick('Campus', f.university, [['', 'All campuses']].concat(d.universities.map(function (u) { return [u.id, u.name]; })), function (v) { go({ university: v }); }));
        results.appendChild(h('p', { class: 'muted small', role: 'status' }, d.total.toLocaleString() + (d.total === 1 ? ' person' : ' people')));
        if (!d.items.length) results.appendChild(h('p', { class: 'muted' }, 'No one matches. Try a different search or filter.'));
        d.items.forEach(function (u) {
          results.appendChild(h('div', { class: 'card' }, h('a', { class: 'link', href: href('people', u.id) }, u.name + ' @' + u.handle),
            h('div', { class: 'small muted' }, u.email + ' - ' + u.university + ' - joined ' + ago(u.joinedAt) + (u.lastSeenAt ? ' - seen ' + ago(u.lastSeenAt) : ' - never seen')), badges(u)));
        });
        if (d.pages > 1) {
          var link = function (n, label, off) { return off ? h('span', { class: 'muted small' }, label) : h('a', { class: 'btn ghost', href: href('people', null, Object.assign({}, f, { status: f.status === 'all' ? '' : f.status, sort: f.sort === 'newest' ? '' : f.sort, page: n > 1 ? n : '' })) }, label); };
          pager.appendChild(link(page - 1, 'Previous', page <= 1)); pager.appendChild(h('span', { class: 'small' }, 'Page ' + d.page + ' of ' + d.pages)); pager.appendChild(link(page + 1, 'Next', page >= d.pages));
        }
      }).catch(function (e) { fail(results, e); results.appendChild(h('button', { class: 'btn ghost', type: 'button', onclick: load }, 'Retry')); });
    }
    load();
  }
  function viewPerson(id) {
    var detail = h('div', null, 'Loading...'); body.appendChild(detail);
    var back = S.peopleBack || href('people');
    function open() {
      api('GET', '/admin/users/' + id).then(function (u) {
        clear(detail);
        setHeader(u.name, '@' + u.handle + ' - ' + u.email, [['People', back], [u.name]]);
        var c = u.counts, canSuspend = S.caps.indexOf('users.suspend') >= 0, canNote = S.caps.indexOf('users.note') >= 0;
        var reasonBox = h('textarea', { placeholder: 'Reason (required, kept in the history)', 'aria-label': 'Reason', maxlength: 500 });
        var msg = h('input', { type: 'text', maxlength: 300, placeholder: 'Message the person will see (optional)', 'aria-label': 'Message to the person' });
        var days = h('input', { type: 'number', min: 1, max: 30, value: 7, 'aria-label': 'Days' }), out = h('div', { class: 'small', role: 'status' });
        function run(kind) {
          var why = reasonBox.value.trim();
          if (why.length < 3) { out.textContent = 'Please give a reason first.'; out.className = 'small err'; reasonBox.focus(); return; }
          var n = Math.max(1, Math.min(30, parseInt(days.value, 10) || 7));
          var ask = kind === 'suspend' ? 'Suspend ' + u.name + ' for ' + n + ' day' + (n > 1 ? 's' : '') + '? They will not be able to post, message or host events until it ends.' : 'Lift the suspension on ' + u.name + '?';
          if (!window.confirm(ask)) return;
          var b = { note: why, userMessage: msg.value }; if (kind === 'suspend') b.days = n;
          api('POST', '/admin/users/' + id + '/' + kind, b).then(function () { open(); }).catch(function (e) { out.textContent = e.message; out.className = 'small err'; });
        }
        var noteBox = h('textarea', { placeholder: 'Private note for staff (the person never sees it)', 'aria-label': 'Private note', maxlength: 1000 }), noteOut = h('div', { class: 'small', role: 'status' });
        function addNote() {
          if (!noteBox.value.trim()) { noteOut.textContent = 'Write a note first.'; noteOut.className = 'small err'; return; }
          api('POST', '/admin/users/' + id + '/notes', { note: noteBox.value }).then(function () { open(); }).catch(function (e) { noteOut.textContent = e.message; noteOut.className = 'small err'; });
        }
        detail.appendChild(h('div', { class: 'card' }, h('div', { class: 'small muted' }, u.university + ' - joined ' + when(u.joinedAt) + ' - ' + (u.lastSeenAt ? 'last seen ' + ago(u.lastSeenAt) : 'never seen')), badges(u),
          h('div', { class: 'grid' }, kpi('Posts', c.posts), kpi('Comments', c.comments), kpi('Messages sent', c.messages), kpi('Communities', c.communities),
            kpi('Events hosted', c.eventsHosted), kpi('Events joined', c.eventsJoined), kpi('Reports about them', c.reportsAboutThem, c.reportsAboutThem ? 'warn' : '', c.reportsAboutThem ? href('reports', null, { status: 'open' }) : ''),
            kpi('Reports they made', c.reportsTheyMade), kpi('Signed-in devices', c.sessions))));
        if (u.role === 'admin') detail.appendChild(h('p', { class: 'muted small' }, 'Administrators cannot be suspended here.'));
        else if (canSuspend) detail.appendChild(h('div', { class: 'card' }, h('h3', null, u.suspendedUntil ? 'Lift the suspension' : 'Suspend this account'), reasonBox, msg,
          h('div', { class: 'row' }, u.suspendedUntil ? h('button', { class: 'btn', type: 'button', onclick: function () { run('unsuspend'); } }, 'Lift suspension')
            : [h('span', { class: 'muted small' }, 'Suspend for'), days, h('span', { class: 'muted small' }, 'days (1 to 30, then it ends by itself)'), h('button', { class: 'btn danger', type: 'button', onclick: function () { run('suspend'); } }, 'Suspend')]), out));
        detail.appendChild(h('div', { class: 'card' }, h('h3', null, 'Staff notes'),
          u.notes.length ? u.notes.map(function (n) { return h('div', { class: 'quote' }, n.note, h('div', { class: 'small muted' }, (n.by || 'a staff member') + ' - ' + when(n.at))); }) : h('p', { class: 'muted small' }, 'No notes yet.'),
          canNote ? [noteBox, h('div', { class: 'row' }, h('button', { class: 'btn ghost', type: 'button', onclick: addNote }, 'Add note')), noteOut] : null));
        detail.appendChild(h('div', { class: 'card' }, h('h3', null, 'Moderation history'),
          u.actions.length ? h('div', { class: 'scroll' }, h('table', null, u.actions.map(function (a) { return h('tr', null, h('td', null, when(a.at)), h('td', null, a.action.replace('_', ' ')), h('td', null, a.by || ''), h('td', null, a.note || '')); }))) : h('p', { class: 'muted small' }, 'None.')));
      }).catch(function (e) { fail(detail, e); detail.appendChild(h('div', { class: 'row' }, h('button', { class: 'btn ghost', type: 'button', onclick: open }, 'Retry'), h('a', { class: 'link', href: back }, 'Back to People'))); });
    }
    open();
  }

  // ---------- 4. system health
  function viewSystem() {
    var out = h('div', null, 'Loading...'); body.appendChild(out);
    function load() {
      api('GET', '/admin/health').then(function (d) {
        clear(out); var j = d.jobs, failed = Object.keys(j.failedByKind || {});
        var failedTotal = failed.reduce(function (a, k) { return a + j.failedByKind[k]; }, 0);
        out.appendChild(h('div', { class: 'grid' },
          kpi('Jobs waiting', (j.byStatus && j.byStatus.pending) || 0), kpi('Jobs failed', failedTotal, failedTotal ? 'bad' : ''), kpi('Jobs retrying', j.retrying, j.retrying ? 'warn' : ''),
          h('div', { class: 'card kpi ' + (j.oldestPendingSeconds > 120 ? 'warn' : '') }, h('div', { class: 'n' }, dur(j.oldestPendingSeconds)), h('div', { class: 'l' }, 'Oldest waiting job')),
          kpi('Push devices active', d.pushTokens.active), kpi('Push devices revoked', d.pushTokens.revoked), kpi('Uploads pending', d.media.pending, d.media.pending > 50 ? 'warn' : ''),
          kpi('Live locations on', d.liveShares)));
        if (failed.length) out.appendChild(h('div', { class: 'card' }, h('h3', null, 'Failed jobs by kind'), h('table', null, failed.map(function (k) { return h('tr', null, h('td', null, k), h('td', null, j.failedByKind[k])); }))));
        out.appendChild(h('div', { class: 'card' }, h('h3', null, 'Server'), h('table', null,
          h('tr', null, h('td', null, 'Database size'), h('td', null, (d.database.bytes / 1048576).toFixed(1) + ' MB')),
          h('tr', null, h('td', null, 'Server uptime'), h('td', null, dur(d.server.uptimeSeconds))),
          h('tr', null, h('td', null, 'Memory (in use / total)'), h('td', null, d.server.heapMb + ' / ' + d.server.rssMb + ' MB')),
          h('tr', null, h('td', null, 'Node'), h('td', null, d.server.node)),
          h('tr', null, h('td', null, 'Checked'), h('td', null, when(d.checkedAt))))));
      }).catch(function (e) { fail(out, e); });
    }
    load(); S.timer = setInterval(load, 30000);
  }

  // ---------- 5. audit log
  function viewAudit() {
    var table = h('table'), more = h('div');
    table.appendChild(h('tr', null, h('th', null, 'When'), h('th', null, 'Who'), h('th', null, 'Action'), h('th', null, 'Target'), h('th', null, 'Details')));
    body.appendChild(h('div', { class: 'card scroll' }, table)); body.appendChild(more);
    function load(cursor) {
      clear(more);
      api('GET', '/admin/audit' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : '')).then(function (d) {
        d.items.forEach(function (a) {
          table.appendChild(h('tr', null, h('td', null, when(a.at)), h('td', null, a.actor ? a.actor.name : 'system'), h('td', null, a.action.replace(/_/g, ' ')),
            h('td', null, (a.targetType || '') + (a.targetId ? ' ' + a.targetId.slice(0, 8) : '')), h('td', { class: 'muted' }, a.details && Object.keys(a.details).length ? JSON.stringify(a.details) : '')));
        });
        if (d.nextCursor) more.appendChild(h('button', { class: 'btn ghost', type: 'button', onclick: function () { load(d.nextCursor); } }, 'Load more'));
      }).catch(function (e) { more.appendChild(h('div', { class: 'err' }, e.message)); });
    }
    load(null);
  }

${MONETIZATION_JS}
${CONTENT_JS}
  // ---------- go
  var saved = null; try { saved = sessionStorage.getItem('uv_admin_rt'); } catch (e) {}
  if (saved) { S.refresh = saved; refreshSession().then(function (ok) { if (!ok) return renderLogin(); return fetch('/me', { headers: { Authorization: 'Bearer ' + S.access } }).then(function (r) { return r.json(); }).then(function (u) { S.user = u; return start(); }).catch(function () { return start(); }); }); }
  else renderLogin();
})();
`;
