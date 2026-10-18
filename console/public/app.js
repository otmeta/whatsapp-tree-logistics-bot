/* Driver Requests Console — client.
 *
 * Mirrors the prototype's client-side state model: one `state` object, a single
 * render() per change. Request text is written by drivers and is therefore
 * untrusted — everything derived from sheet data goes through esc(). */

(function () {
  'use strict';

  var STATUS_COLORS = {
    'To be contacted':       { bg: '#FFE1AC', text: '#7A4A00', bar: '#F0A93C' },
    'In Progress':           { bg: '#D9E7FF', text: '#1B4B8F', bar: '#3E7BD6' },
    'Completed':             { bg: '#D8F0DD', text: '#1B5E2A', bar: '#199948' },
    'Not started':           { bg: '#FFDCDC', text: '#8C2020', bar: '#D24E4E' },
    'needs to be clarified': { bg: '#FFF3C4', text: '#6F5A00', bar: '#D8B326' }
  };
  var STATUS_FALLBACK = { bg: '#EDF0EC', text: '#46584C', bar: '#9AA79E' };

  var state = {
    ready: false,
    authed: false,
    publicDashboard: true,
    actor: null,
    ownerGroups: [],
    view: 'inbox',
    requests: [],
    options: null,
    dashboard: null,
    syncedAt: null,
    selectedId: null,
    client: 'All',          // contract: All | amazon | voi
    station: 'All',         // location within the contract
    statusFilter: 'Open',
    owner: 'All',           // 'All' | 'me' | a specific owner name
    query: '',
    draft: '',
    density: 'comfortable',
    sort: 'oldest',        // 'oldest' = SLA order (design default), 'newest' = arrivals first
    newIds: {},            // requests that arrived while this tab was open and are still unread
    onlyNew: false,        // the "N new" chip filters down to just those
    baselineReady: false,  // first load establishes what was already there
    lastTotal: null,       // drives the cheap pulse check
    pollMs: 300000,        // how often to check for new requests; server-configurable
    error: null,
    gateError: null,
    saving: false,
    pickingWho: false,
    showPastOwners: false,
    pendingRequestId: null
  };

  var root = document.getElementById('app');

  // ---------------------------------------------------------------- helpers

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function statusColors(status) { return STATUS_COLORS[status] || STATUS_FALLBACK; }

  function ageColor(age) {
    if (age == null) return '#8B998F';
    if (age <= 7) return '#5D6D63';
    if (age <= 21) return '#8A5A00';
    return '#B4291F';
  }

  function initials(name) {
    var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '??';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function isOpen(status) {
    return String(status || '').trim().toLowerCase() !== 'completed';
  }

  function cleanPhone(phone) {
    return String(phone || '').replace(/^whatsapp:/i, '');
  }

  function shortTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  function relativeWhen(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('en-GB', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false
    });
  }

  function statusPill(status, size) {
    var c = statusColors(status);
    return '<span class="pill" style="background:' + c.bg + ';color:' + c.text +
      (size ? ';font-size:' + size : '') + '">' + esc(status || '—') + '</span>';
  }

  function api(path, options) {
    return fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, options || {}))
      .then(function (res) {
        return res.text().then(function (text) {
          var body = null;
          try { body = text ? JSON.parse(text) : null; } catch (e) { /* ignore */ }
          if (!res.ok) {
            var err = new Error((body && body.error) || ('HTTP ' + res.status));
            err.status = res.status;
            throw err;
          }
          return body;
        });
      });
  }

  // Mirrors lib/clients.js — the station prefix is the contract.
  function clientOf(station) {
    var value = String(station || '').trim().toUpperCase();
    if (value.indexOf('VOI') === 0) return 'voi';
    if (value.indexOf('DBE') === 0) return 'amazon';
    return 'other';
  }

  function locationOf(station) {
    var value = String(station || '').trim();
    if (clientOf(value) === 'voi') {
      var rest = value.replace(/^voi\s*/i, '').trim();
      return rest || '(no city)';
    }
    return value || '(none)';
  }

  function clientConfig(key) {
    return (state.options && state.options.clients || []).find(function (c) { return c.key === key; }) || null;
  }

  /** Locations present in the data for the selected contract. */
  function locationsForFilter() {
    var counts = {};
    state.requests.forEach(function (r) {
      if (state.client !== 'All' && clientOf(r.station) !== state.client) return;
      var loc = locationOf(r.station);
      counts[loc] = (counts[loc] || 0) + 1;
    });
    return Object.keys(counts).sort(function (a, b) {
      if (counts[b] !== counts[a]) return counts[b] - counts[a];
      return a.localeCompare(b);
    });
  }

  /** Owners that actually appear in the data, most work first. */
  function ownersInData() {
    var counts = {};
    state.requests.forEach(function (r) {
      var name = r.owner || 'Unassigned';
      if (name === 'Unassigned') return;
      counts[name] = (counts[name] || 0) + 1;
    });
    return Object.keys(counts).sort(function (a, b) {
      if (counts[b] !== counts[a]) return counts[b] - counts[a];
      return a.localeCompare(b);
    });
  }

  /** How many open requests the signed-in person is carrying. */
  function myOpenCount() {
    if (!state.actor) return 0;
    return state.requests.filter(function (r) {
      return isOpen(r.status) && r.owner === state.actor.name;
    }).length;
  }

  function newCount() { return Object.keys(state.newIds).length; }

  /**
   * Works out which requests appeared since the last poll. The first load only
   * establishes the baseline - everything already in the sheet is not "new", or
   * opening the console would claim 68 arrivals.
   */
  function noteArrivals(previousIds) {
    var present = {};
    state.requests.forEach(function (r) { present[r.id] = true; });

    if (!state.baselineReady) {
      state.baselineReady = true;
    } else {
      state.requests.forEach(function (r) {
        if (!previousIds[r.id]) state.newIds[r.id] = true;
      });
    }

    // Drop anything that has since left the sheet, so the count cannot drift.
    Object.keys(state.newIds).forEach(function (id) {
      if (!present[id]) delete state.newIds[id];
    });
  }

  /** Marks a request read, so the chip and badge stop counting it. */
  function markRead(id) {
    if (state.newIds[id]) {
      delete state.newIds[id];
      if (newCount() === 0) state.onlyNew = false;
    }
  }

  /** Puts the count in the tab title so it is visible when the tab is not focused. */
  function updateTabTitle() {
    var base = 'Driver Requests · Tree Logistics';
    var n = newCount();
    document.title = n > 0 ? '(' + n + ') ' + base : base;
  }

  // ---------------------------------------------------------------- filtering

  function filtered() {
    var q = state.query.trim().toLowerCase();

    var rows = state.requests.filter(function (r) {
      if (state.onlyNew && !state.newIds[r.id]) return false;
      if (state.client !== 'All' && clientOf(r.station) !== state.client) return false;
      if (state.station !== 'All' && locationOf(r.station) !== state.station) return false;

      // Owner filter, independent of status: "my open requests" is the common case.
      if (state.owner === 'me') {
        if (!state.actor || r.owner !== state.actor.name) return false;
      } else if (state.owner !== 'All' && r.owner !== state.owner) return false;

      if (state.statusFilter === 'Open' && !isOpen(r.status)) return false;
      if (state.statusFilter === 'Unassigned' && r.owner !== 'Unassigned') return false;
      if (['To be contacted', 'In Progress', 'Completed', 'Not started', 'needs to be clarified']
        .indexOf(state.statusFilter) !== -1 && r.status !== state.statusFilter) return false;

      if (q) {
        var hay = [r.first, r.last, r.first + ' ' + r.last, r.id, r.text, r.category, r.owner, r.station]
          .join(' ').toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });

    var newestFirst = state.sort === 'newest';

    return rows.sort(function (a, b) {
      var aa = a.age == null ? -1 : a.age;
      var bb = b.age == null ? -1 : b.age;
      if (bb !== aa) return newestFirst ? aa - bb : bb - aa;
      // Request IDs carry the send time, so they break ties in arrival order.
      return newestFirst
        ? String(b.id).localeCompare(String(a.id))
        : String(a.id).localeCompare(String(b.id));
    });
  }

  function selected() {
    if (!state.selectedId) return null;
    return state.requests.find(function (r) { return r.id === state.selectedId; }) || null;
  }

  function relatedTo(request) {
    var key = cleanPhone(request.phone).replace(/\D/g, '');
    if (!key) return [];
    return state.requests.filter(function (r) {
      return r.id !== request.id && cleanPhone(r.phone).replace(/\D/g, '') === key;
    });
  }

  // ---------------------------------------------------------------- views

  function topBar() {
    var openCount = state.requests.filter(function (r) { return isOpen(r.status); }).length;
    var tabs = [['inbox', 'Inbox'], ['dashboard', 'Dashboard']];

    return '' +
      '<div class="topbar">' +
        '<div class="brand">' +
          '<span class="brand-plate"><img src="/assets/tree-logistics-logo.png" alt="Tree Logistics"></span>' +
          '<span>' +
            '<div class="brand-title">Driver Requests</div>' +
            '<div class="brand-sub mono">DA — Request · Tree Logistics</div>' +
          '</span>' +
        '</div>' +
        '<div class="tabs">' +
          tabs.map(function (t) {
            return '<button class="tab' + (state.view === t[0] ? ' active' : '') +
              '" data-view="' + t[0] + '">' + t[1] + '</button>';
          }).join('') +
        '</div>' +
        '<div class="topbar-right">' +
          '<span class="live"><span class="dot"></span>Bot live · +49 15888 725850</span>' +
          '<span class="synced mono">synced ' + esc(shortTime(state.syncedAt)) + '</span>' +
          (state.saving ? '<span class="synced">saving…</span>' : '') +
          '<button class="avatar-btn" id="whoBtn" title="' +
            esc(!state.authed ? 'Enter the team code to open the queue'
              : state.actor ? state.actor.name + ' · ' + state.actor.team
              : 'Choose who you are') + '">' +
            esc(!state.authed ? '\u00b7\u00b7\u00b7' : state.actor ? initials(state.actor.name) : '?') +
          '</button>' +
        '</div>' +
      '</div>' +
      (state.error ? '<div class="banner">' + esc(state.error) + '</div>' : '') +
      (openCount === 0 && state.authed && state.view === 'inbox'
        ? '' : '');
  }

  function queuePane() {
    var rows = filtered();
    var openTotal = state.requests.filter(function (r) { return isOpen(r.status); }).length;
    var chips = ['Open', 'Unassigned', 'To be contacted', 'In Progress', 'All'];
    var clientList = (state.options && state.options.clients) || [];
    var locations = locationsForFilter();

    var list = rows.length === 0
      ? '<div class="queue-empty">Nothing matches these filters.</div>'
      : rows.map(function (r) {
        var c = statusColors(r.status);
        return '' +
          '<div class="row' + (r.id === state.selectedId ? ' selected' : '') + '" data-id="' + esc(r.id) + '"' +
            ' style="border-left-color:' + c.bar + '">' +
            '<div class="row-line">' +
              '<span class="row-name">' + esc((r.first + ' ' + r.last).trim() || 'Unknown driver') + '</span>' +
              '<span class="station-tag"' +
                (clientOf(r.station) === 'voi' ? ' style="background:#E4EDFA;color:#1B4B8F"' : '') + '>' +
                esc(r.station || '—') + '</span>' +
              (state.newIds[r.id] ? '<span class="new-tag">NEW</span>' : '') +
              '<span class="row-age" style="color:' + ageColor(r.age) + '">' +
                (r.age == null ? '—' : r.age + 'd open') + '</span>' +
            '</div>' +
            '<div class="row-preview">' + esc(String(r.text || '').replace(/\s*\n+\s*/g, ' ')) + '</div>' +
            '<div class="row-line">' +
              statusPill(r.status) +
              (r.category ? '<span class="pill pill-cat">' + esc(r.category) + '</span>' : '') +
              '<span class="row-owner' + (r.owner === 'Unassigned' ? ' unassigned' : '') + '">' +
                esc(r.owner) + '</span>' +
            '</div>' +
            (r.isDuplicate
              ? '<div class="dup">' + r.samePhoneOpenCount +
                ' requests from this number — possible duplicate</div>'
              : '') +
          '</div>';
      }).join('');

    return '' +
      '<div class="queue">' +
        '<div class="queue-head">' +
          '<div class="queue-title">' +
            '<h2>Open queue</h2>' +
            '<span class="queue-count">' + rows.length + ' of ' + openTotal + ' open</span>' +
            '<button class="sort-btn" id="sortBtn" title="Change the order of the queue">' +
              (state.sort === 'newest' ? 'Newest first' : 'Oldest first') +
            '</button>' +
          '</div>' +
          (newCount() > 0
            ? '<button class="new-chip' + (state.onlyNew ? ' on' : '') + '" id="newChip">' +
              '<span class="new-dot"></span>' +
              newCount() + ' new since you opened' +
              (state.onlyNew ? ' — showing only these' : '') +
              '</button>'
            : '') +
          '<div class="owner-row">' +
            '<button class="chip mine-chip' + (state.owner === 'me' ? ' on' : '') + '" id="mineChip"' +
              (state.actor ? '' : ' disabled title="Choose who you are first"') + '>' +
              'Assigned to me' + (myOpenCount() ? ' · ' + myOpenCount() : '') +
            '</button>' +
            '<select class="owner-select" id="ownerSelect" title="Filter by owner">' +
              '<option value="All"' + (state.owner === 'All' ? ' selected' : '') + '>Everyone</option>' +
              '<option value="Unassigned"' + (state.owner === 'Unassigned' ? ' selected' : '') + '>Unassigned</option>' +
              ownersInData().map(function (name) {
                return '<option value="' + esc(name) + '"' +
                  (state.owner === name ? ' selected' : '') + '>' + esc(name) + '</option>';
              }).join('') +
            '</select>' +
          '</div>' +
          '<input class="search" id="search" placeholder="Search driver, request ID, text…" value="' +
            esc(state.query) + '">' +
          '<div class="segmented" style="grid-template-columns:repeat(' + (clientList.length + 1) + ',1fr)">' +
            ('<button data-client="All"' + (state.client === 'All' ? ' class="on"' : '') + '>All</button>') +
            clientList.map(function (c) {
              return '<button data-client="' + esc(c.key) + '"' +
                (state.client === c.key ? ' class="on"' : '') + '>' + esc(c.short || c.label) + '</button>';
            }).join('') +
          '</div>' +
          (locations.length > 1
            ? '<div class="chips">' +
              ('<button class="chip' + (state.station === 'All' ? ' on' : '') + '" data-station="All">' +
                (state.client === 'voi' ? 'All cities' : 'All') + '</button>') +
              locations.map(function (loc) {
                return '<button class="chip' + (state.station === loc ? ' on' : '') +
                  '" data-station="' + esc(loc) + '">' + esc(loc) + '</button>';
              }).join('') +
              '</div>'
            : '') +
          '<div class="chips">' +
            chips.map(function (c) {
              return '<button class="chip' + (state.statusFilter === c ? ' on' : '') +
                '" data-chip="' + esc(c) + '">' + esc(c) + '</button>';
            }).join('') +
          '</div>' +
        '</div>' +
        '<div class="queue-list">' + list + '</div>' +
      '</div>';
  }

  function selectMarkup(id, label, value, values, allowBlank) {
    var opts = (allowBlank && values.indexOf('') === -1 ? [''] : []).concat(values);
    return '' +
      '<div class="field">' +
        '<label for="' + id + '">' + esc(label) + '</label>' +
        '<select id="' + id + '" data-field="' + id.replace('f-', '') + '">' +
          opts.map(function (v) {
            return '<option value="' + esc(v) + '"' +
              (String(value || '') === String(v) ? ' selected' : '') + '>' +
              (v === '' ? '—' : esc(v)) + '</option>';
          }).join('') +
        '</select>' +
      '</div>';
  }

  function detailPane() {
    var r = selected();
    if (!r) {
      return '<div class="detail"><div class="detail-empty">Select a request from the queue.</div></div>';
    }

    var o = state.options || {};
    var ownerValues = [''];
    (state.ownerGroups || []).forEach(function (g) {
      g.people.forEach(function (p) { if (ownerValues.indexOf(p) === -1) ownerValues.push(p); });
    });
    // A legacy owner already on the row must stay visible in the dropdown.
    if (r.owner && ownerValues.indexOf(r.owner) === -1 && r.owner !== 'Unassigned') {
      ownerValues.push(r.owner);
    }

    var related = relatedTo(r);

    var activity = (r.activity || []).length
      ? r.activity.map(function (e) {
        return '' +
          '<div class="event">' +
            '<span class="event-avatar">' + esc(initials(e.who)) + '</span>' +
            '<span>' +
              '<p class="event-text">' + esc(e.text) + '</p>' +
              '<span class="event-meta mono">' + esc(relativeWhen(e.when)) + ' · ' + esc(e.who || 'Unknown') +
              (e.team ? ' · ' + esc(e.team) : '') + '</span>' +
            '</span>' +
          '</div>';
      }).join('')
      : '<div class="caption" style="padding:10px 0">Nothing logged yet.</div>';

    return '' +
      '<div class="detail"><div class="detail-inner">' +

        '<div class="detail-head">' +
          '<div>' +
            '<div class="detail-headline">' +
              '<h1>' + esc((r.first + ' ' + r.last).trim() || 'Unknown driver') + '</h1>' +
              '<span class="station-tag" style="font-size:11px;' +
                (clientOf(r.station) === 'voi'
                  ? 'background:#E4EDFA;color:#1B4B8F'
                  : 'background:#E7EEE9;color:#2C5238') + '">' +
                esc(r.station || '—') + '</span>' +
              statusPill(r.status, '11.5px') +
            '</div>' +
            '<div class="detail-meta mono">' +
              '<span>' + esc(r.id) + '</span>' +
              '<span>' + esc(cleanPhone(r.phone)) + '</span>' +
              '<span>' + esc(r.ts) + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="detail-age">' +
            '<div class="n" style="color:' + ageColor(r.age) + '">' + (r.age == null ? '—' : r.age) + '</div>' +
            '<div class="l">days open</div>' +
          '</div>' +
        '</div>' +

        '<div class="card">' +
          '<div class="card-head">' +
            '<span class="card-label">Request as received</span>' +
            '<span class="card-hint">WhatsApp · column E, unedited</span>' +
          '</div>' +
          '<div class="card-body"><p class="request-text">' + esc(r.text) + '</p></div>' +
        '</div>' +

        '<div class="card pad">' +
          '<span class="card-label">Triage</span>' +
          '<div class="triage-grid">' +
            selectMarkup('f-status', 'Status', r.status, o.statuses || [], false) +
            selectMarkup('f-owner', 'Owner', r.owner === 'Unassigned' ? '' : r.owner, ownerValues, true) +
            selectMarkup('f-priority', 'Priority', r.priority, o.priorities || [], true) +
            selectMarkup('f-category', 'Category', r.category, o.categories || [], true) +
          '</div>' +
          (function () {
            // VOI requests come to Anderson unless someone else takes them. Offered
            // as one click rather than written automatically, so a row nobody has
            // touched still reads as Unassigned.
            var config = clientConfig(clientOf(r.station));
            var suggested = config && config.defaultOwner;
            if (!suggested || r.owner !== 'Unassigned') return '';

            return '<div class="suggest-row">' +
              '<span class="contact-label">Nobody on this yet</span>' +
              '<button class="btn-suggest" data-assign="' + esc(suggested) + '">' +
                'Assign to ' + esc(suggested) + '</button>' +
              '<span class="contact-note">' + esc(config.label) + ' requests default to ' +
                esc(suggested) + '</span>' +
            '</div>';
          })() +
          '<div class="contact-row">' +
            '<span class="contact-label">Driver contacted via</span>' +
            (o.contactMethods || []).map(function (m) {
              return '<button class="toggle' + (r.contacted === m ? ' on' : '') +
                '" data-contact="' + esc(m) + '">' + esc(m) + '</button>';
            }).join('') +
            '<span class="contact-note">' +
              (r.contacted ? 'Last contact logged: ' + esc(r.contacted) : 'No contact logged yet') +
            '</span>' +
          '</div>' +
        '</div>' +

        '<div class="two-col">' +
          '<div class="card pad">' +
            '<div class="detail-headline">' +
              '<span class="card-label">Activity</span>' +
              '<span class="card-hint">append-only · never overwrites the request</span>' +
            '</div>' +
            '<div>' + activity + '</div>' +
            '<div class="composer">' +
              '<textarea id="draft" placeholder="Log what you did — call, payroll check, reply sent…">' +
                esc(state.draft) + '</textarea>' +
              '<div class="composer-actions">' +
                '<button class="btn-primary" id="logBtn"' +
                  (state.draft.trim() ? '' : ' disabled') + '>Log action</button>' +
                '<span class="caption">Written to the Activity Log tab with your name and a timestamp.</span>' +
              '</div>' +
            '</div>' +
          '</div>' +

          '<div class="card pad">' +
            '<span class="card-label">Same driver</span>' +
            '<span class="card-hint">' +
              (related.length
                ? related.length + ' other request' + (related.length === 1 ? '' : 's') +
                  ' from ' + esc(cleanPhone(r.phone))
                : 'No other requests from this number.') +
            '</span>' +
            '<div class="related">' +
              related.map(function (x) {
                return '<div class="related-item" data-id="' + esc(x.id) + '">' +
                  '<div class="related-top">' +
                    '<span class="related-id mono">' + esc(x.id) + '</span>' + statusPill(x.status) +
                  '</div>' +
                  '<div class="related-preview">' +
                    esc(String(x.text || '').replace(/\s*\n+\s*/g, ' ')) + '</div>' +
                '</div>';
              }).join('') +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="safety">' +
          '<h4>Nothing here changes the driver’s request</h4>' +
          '<p>Columns A–H stay exactly as the bot wrote them. This console only writes Status, Owner, ' +
          'Priority, Category, Contacted and Action notes — the raw rows are never edited or deleted.</p>' +
        '</div>' +

      '</div></div>';
  }

  function barList(items) {
    return items.map(function (b) {
      return '' +
        '<div class="bar-row">' +
          '<div class="bar-top">' +
            '<span class="bar-name">' + esc(b.name) + '</span>' +
            '<span class="bar-count">' + b.count + '</span>' +
            '<span class="bar-pct">' + b.pct + '%</span>' +
          '</div>' +
          '<div class="track"><div class="fill" style="width:' + Math.max(1, b.pct) +
            '%;background:' + b.color + '"></div></div>' +
        '</div>';
    }).join('');
  }

  function attentionTable(rows, emptyText) {
    var showText = rows.some(function (r) { return r.text != null; });
    var cols = showText ? 5 : 4;
    return '<table class="attention-table"><thead><tr>' +
      '<th style="width:66px">Age</th><th style="width:110px">Station</th>' +
      '<th>Owner</th><th style="width:148px">Status</th>' +
      (showText ? '<th>Request</th>' : '') +
      '</tr></thead><tbody>' +
      (rows.length
        ? rows.map(function (r) {
          return '<tr data-goto="' + esc(r.id) + '">' +
            '<td style="font-weight:700;color:' + ageColor(r.age) + '">' +
              (r.age == null ? '—' : r.age + 'd') + '</td>' +
            '<td>' + esc(r.station || '—') + '</td>' +
            '<td class="' + (r.owner === 'Unassigned' ? 'owner-unassigned' : '') + '">' +
              esc(r.owner) + '</td>' +
            '<td>' + statusPill(r.status) + '</td>' +
            (showText
              ? '<td class="ellipsis">' + esc(String(r.text).replace(/\s*\n+\s*/g, ' ')) + '</td>'
              : '') +
          '</tr>';
        }).join('')
        : '<tr><td colspan="' + cols + '" class="caption" style="padding:14px 10px">' + esc(emptyText) + '</td></tr>') +
      '</tbody></table>' +
      (rows.length && !showText
        ? '<span class="caption">Request text opens after the team code.</span>'
        : '');
  }

  function dashboardView() {
    if (!state.dashboard) {
      return '<div class="scroller"><div class="dash"><div class="detail-empty">Loading dashboard…</div></div></div>';
    }

    var s = state.dashboard.stats;
    var k = s.kpis;
    var maxAge = Math.max.apply(null, s.aging.map(function (a) { return a.count; }).concat([1]));
    var coverageThin = !k.completedCount || (k.avgDaysCoverage / k.completedCount) < 0.5;
    var visibleOwners = (s.byOwner || []).filter(function (o) {
      return state.showPastOwners || o.open > 0;
    });
    var hiddenOwners = (s.byOwner || []).filter(function (o) { return o.open === 0; }).length;
    var arriving = s.arriving || [];
    var overdue = s.overdue || [];

    return '' +
      '<div class="scroller"><div class="dash">' +
        '<div class="dash-head">' +
          '<div>' +
            '<h1>Open queue</h1>' +
            '<div class="dash-sub">' + k.open + ' open now · ' + k.total +
              ' since launch · refreshed ' + esc(relativeWhen(state.dashboard.syncedAt)) + '</div>' +
          '</div>' +
        '</div>' +

        '<div class="kpis">' +
          '<div class="kpi kpi-hero">' +
            '<div class="kpi-label">Open</div>' +
            '<div class="kpi-value" style="color:#8A5A00">' + k.open + '</div>' +
            '<div class="kpi-note">' + k.openPct + '% of ' + k.total + '</div>' +
          '</div>' +
          '<div class="kpi">' +
            '<div class="kpi-label">Unassigned</div>' +
            '<div class="kpi-value" style="color:#B4291F">' + k.unassigned + '</div>' +
            '<div class="kpi-note">nobody owns them yet</div>' +
          '</div>' +
          '<div class="kpi">' +
            '<div class="kpi-label">New today</div>' +
            '<div class="kpi-value">' + (k.newToday || 0) + '</div>' +
            '<div class="kpi-note">arrived since midnight</div>' +
          '</div>' +
          '<div class="kpi">' +
            '<div class="kpi-label">Open &gt; 7 days</div>' +
            '<div class="kpi-value" style="color:#B4291F">' + k.overSeven + '</div>' +
            '<div class="kpi-note">past the first SLA mark</div>' +
          '</div>' +
          '<div class="kpi">' +
            '<div class="kpi-label">Completed</div>' +
            '<div class="kpi-value" style="color:#199948">' + k.completed + '</div>' +
            '<div class="kpi-note">' + k.completedPct + '% since launch</div>' +
          '</div>' +
          '<div class="kpi kpi-resolve">' +
            '<div class="kpi-label">Avg days to resolve</div>' +
            '<div class="kpi-split">' +
              '<div>' +
                '<div class="kpi-value">' + (k.avgDays == null ? '—' : k.avgDays) + '</div>' +
                '<div class="kpi-note">target 3.0</div>' +
              '</div>' +
              '<div>' +
                '<div class="kpi-value' + (coverageThin ? ' thin' : '') + '">' +
                  k.avgDaysCoverage + '<span class="kpi-of">/' + k.completedCount + '</span></div>' +
                '<div class="kpi-note">have a completion date</div>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +

        (s.byClient && s.byClient.length
          ? '<div class="cards-row">' +
            s.byClient.map(function (c) {
              return '<div class="client-card" style="border-left-color:' + c.color + '">' +
                '<div class="client-name">' + esc(c.label) + '</div>' +
                '<div class="client-open" style="color:' + c.color + '">' + c.open + '</div>' +
                '<div class="kpi-note">open now · ' + c.total + ' since launch' +
                  (c.unassigned ? ' · ' + c.unassigned + ' unassigned' : '') + '</div>' +
              '</div>';
            }).join('') +
            '</div>'
          : '') +

        '<div class="attention-grid">' +
          '<div class="card pad">' +
            '<span class="card-label">New and unassigned</span>' +
            '<span class="card-hint">no owner yet, or arrived in the last day, and under 21 days</span>' +
            attentionTable(arriving, 'Nothing new is waiting. Every recent request has an owner.') +
          '</div>' +
          '<div class="card pad">' +
            '<span class="card-label">Open longer than 21 days</span>' +
            '<span class="card-hint">oldest first</span>' +
            attentionTable(overdue, 'Nothing has been open longer than 21 days.') +
          '</div>' +
        '</div>' +

        '<div class="band">' +
          '<div class="card pad">' +
            '<span class="card-label">Open by status</span>' +
            '<div>' + (s.openStatusMix && s.openStatusMix.length
              ? barList(s.openStatusMix)
              : '<div class="caption">No open requests.</div>') + '</div>' +
          '</div>' +
          '<div class="card pad">' +
            '<span class="card-label">Open by station</span>' +
            '<div>' + (s.openByStation && s.openByStation.length
              ? barList(s.openByStation)
              : '<div class="caption">No open requests.</div>') + '</div>' +
          '</div>' +
          '<div class="card pad">' +
            '<span class="card-label">Open by category</span>' +
            '<div>' + (s.openByCategory && s.openByCategory.length
              ? barList(s.openByCategory)
              : '<div class="caption">No open requests.</div>') + '</div>' +
          '</div>' +
        '</div>' +

        '<div class="band band-2">' +
          '<div class="card pad">' +
            '<div class="card-head-row">' +
              '<span class="card-label">Who has open work</span>' +
              (hiddenOwners
                ? '<button class="btn-secondary" id="pastOwnersBtn">' +
                  (state.showPastOwners ? 'Hide past owners' : 'Show ' + hiddenOwners + ' past owners') +
                  '</button>'
                : '') +
            '</div>' +
            '<table class="mini"><thead><tr>' +
              '<th>Owner</th><th style="text-align:right">Open</th>' +
              '<th style="text-align:right">Total</th><th style="text-align:right">Done %</th>' +
            '</tr></thead><tbody>' +
              (visibleOwners.length
                ? visibleOwners.map(function (o) {
                  return '<tr>' +
                    '<td class="' + (o.isUnassigned ? 'owner-unassigned' : '') + '">' + esc(o.owner) +
                      (o.isLegacy ? ' <span class="legacy-flag">past</span>' : '') + '</td>' +
                    '<td class="num ' + (o.open > 0 ? 'open-nonzero' : 'open-zero') + '">' + o.open + '</td>' +
                    '<td class="num">' + o.total + '</td>' +
                    '<td class="num">' + o.donePct + '%</td>' +
                  '</tr>';
                }).join('')
                : '<tr><td colspan="4" class="caption">Nobody has an open request.</td></tr>') +
            '</tbody></table>' +
          '</div>' +
          '<div class="card pad">' +
            '<span class="card-label">Aging of open requests</span>' +
            '<div>' +
              s.aging.map(function (a) {
                return '<div class="age-row">' +
                  '<span class="age-label">' + esc(a.label) + '</span>' +
                  '<span class="age-track"><span class="age-fill" style="width:' +
                    Math.round((a.count / maxAge) * 100) + '%;background:' + a.color + '"></span></span>' +
                  '<span class="age-count">' + a.count + '</span>' +
                '</div>';
              }).join('') +
            '</div>' +
            '<span class="caption">Age is counted from the timestamp the bot wrote in column A.</span>' +
          '</div>' +
        '</div>' +
      '</div></div>';
  }

  function gateView() {
    return '' +
      '<div class="gate"><div class="gate-card">' +
        '<h1>Driver Requests Console</h1>' +
        '<p>This part shows unedited driver messages and can update the sheet, so it needs the ' +
        'team access code.</p>' +
        (state.pendingRequestId
          ? '<p class="gate-pending">After you sign in we will open <span class="mono">' +
            esc(state.pendingRequestId) + '</span>.</p>'
          : '') +
        (state.gateError ? '<div class="gate-error">' + esc(state.gateError) + '</div>' : '') +
        '<input id="code" type="password" placeholder="Team access code" autocomplete="current-password">' +
        '<button class="btn-primary" id="enterBtn" style="width:100%">Open console</button>' +
        (state.publicDashboard
          ? '<p style="margin:14px 0 0;text-align:center">' +
            '<button class="btn-secondary" id="toDashBtn" style="width:100%">' +
            'View the dashboard instead — no code needed</button></p>'
          : '') +
      '</div></div>';
  }

  function whoView() {
    return '' +
      '<div class="gate"><div class="gate-card">' +
        '<h1>Who are you?</h1>' +
        '<p>Used to stamp the activity log, so the team can see who did what. Stored on this device only.</p>' +
        '<div class="who-list">' +
          (state.ownerGroups || []).map(function (g) {
            return '<div>' +
              '<div class="who-team-label">' + esc(g.team) + '</div>' +
              '<div class="who-people">' +
                g.people.map(function (p) {
                  return '<button data-who="' + esc(p) + '">' + esc(p) + '</button>';
                }).join('') +
              '</div>' +
            '</div>';
          }).join('') +
        '</div>' +
      '</div></div>';
  }

  // ---------------------------------------------------------------- render

  /**
   * Re-rendering replaces the whole tree, which loses where the user had scrolled
   * to. Anyone working down a long queue was being sent back to the top on every
   * background tick.
   */
  function withScrollPreserved(paint) {
    var queue = root.querySelector('.queue-list');
    var detail = root.querySelector('.detail');
    var scroller = root.querySelector('.scroller');
    var queueTop = queue ? queue.scrollTop : null;
    var detailTop = detail ? detail.scrollTop : null;
    var scrollerTop = scroller ? scroller.scrollTop : null;

    paint();

    if (queueTop) {
      var newQueue = root.querySelector('.queue-list');
      if (newQueue) newQueue.scrollTop = queueTop;
    }
    if (detailTop) {
      var newDetail = root.querySelector('.detail');
      if (newDetail) newDetail.scrollTop = detailTop;
    }
    if (scrollerTop) {
      var newScroller = root.querySelector('.scroller');
      if (newScroller) newScroller.scrollTop = scrollerTop;
    }
  }

  /** Updates just the "synced HH:MM" label, without disturbing the page. */
  function updateSyncedLabel() {
    var el = root.querySelector('.synced');
    if (el) el.textContent = 'synced ' + shortTime(state.syncedAt);
  }

  function render() {
    if (!state.ready) {
      root.innerHTML = '<div class="detail-empty">Loading…</div>';
      return;
    }

    // Anyone with the link can read the dashboard — it is aggregates only. The
    // Inbox still needs the team code, so it lands on the gate.
    if (!state.authed) {
      if (state.publicDashboard && state.view === 'dashboard') {
        withScrollPreserved(function () {
          root.innerHTML = topBar() + dashboardView();
        });
        wire();
        return;
      }
      root.innerHTML = topBar() + gateView();
      wire();
      var code = document.getElementById('code');
      if (code) code.focus();
      return;
    }

    if (state.pickingWho || !state.actor) {
      root.innerHTML = topBar() + whoView();
      wire();
      return;
    }

    var body;
    if (state.view === 'dashboard') body = dashboardView();
    else {
      body = '<div class="inbox' + (state.selectedId ? ' has-selection' : '') +
        (state.density === 'compact' ? ' compact' : '') + '">' +
        queuePane() + detailPane() + '</div>';
    }

    withScrollPreserved(function () {
      root.innerHTML = topBar() + body;
    });
    wire();
  }

  // Preserve caret position when re-rendering after a keystroke.
  function restoreFocus(id, caret) {
    var el = document.getElementById(id);
    if (!el) return;
    el.focus();
    if (caret != null && el.setSelectionRange) {
      try { el.setSelectionRange(caret, caret); } catch (e) { /* ignore */ }
    }
  }

  function wire() {
    root.querySelectorAll('[data-view]').forEach(function (el) {
      el.onclick = function () {
        state.view = el.getAttribute('data-view');
        if (state.view === 'dashboard') loadDashboard();
        render();
      };
    });

    var whoBtn = document.getElementById('whoBtn');
    if (whoBtn) whoBtn.onclick = function () {
      if (!state.authed) { state.view = 'inbox'; render(); return; } // show the gate
      state.pickingWho = true;
      render();
    };

    root.querySelectorAll('[data-who]').forEach(function (el) {
      el.onclick = function () {
        var name = el.getAttribute('data-who');
        api('/api/actor', { method: 'POST', body: JSON.stringify({ name: name }) })
          .then(function (res) {
            state.actor = res.actor;
            state.pickingWho = false;
            render();
          })
          .catch(showError);
      };
    });

    var toDashBtn = document.getElementById('toDashBtn');
    if (toDashBtn) toDashBtn.onclick = function () {
      state.view = 'dashboard';
      loadDashboard();
      render();
    };

    var enterBtn = document.getElementById('enterBtn');
    if (enterBtn) {
      var submit = function () {
        var value = (document.getElementById('code') || {}).value || '';
        api('/api/session', { method: 'POST', body: JSON.stringify({ code: value }) })
          .then(function () {
            state.authed = true;
            state.gateError = null;
            return boot();
          })
          .catch(function (err) {
            state.gateError = err.message;
            render();
          });
      };
      enterBtn.onclick = submit;
      var codeInput = document.getElementById('code');
      if (codeInput) codeInput.onkeydown = function (e) { if (e.key === 'Enter') submit(); };
    }

    var search = document.getElementById('search');
    if (search) {
      search.oninput = function () {
        var caret = search.selectionStart;
        state.query = search.value;
        render();
        restoreFocus('search', caret);
      };
    }

    var sortBtn = document.getElementById('sortBtn');
    if (sortBtn) sortBtn.onclick = function () {
      state.sort = state.sort === 'newest' ? 'oldest' : 'newest';
      render();
    };

    var newChip = document.getElementById('newChip');
    if (newChip) newChip.onclick = function () {
      state.onlyNew = !state.onlyNew;
      // Showing the arrivals is most useful newest-first.
      if (state.onlyNew) state.sort = 'newest';
      render();
    };

    var mineChip = document.getElementById('mineChip');
    if (mineChip) mineChip.onclick = function () {
      state.owner = state.owner === 'me' ? 'All' : 'me';
      render();
    };

    var ownerSelect = document.getElementById('ownerSelect');
    if (ownerSelect) ownerSelect.onchange = function () {
      state.owner = ownerSelect.value;
      render();
    };

    root.querySelectorAll('[data-client]').forEach(function (el) {
      el.onclick = function () {
        state.client = el.getAttribute('data-client');
        state.station = 'All'; // a DBE2 filter means nothing once VOI is selected
        render();
      };
    });

    root.querySelectorAll('[data-station]').forEach(function (el) {
      el.onclick = function () { state.station = el.getAttribute('data-station'); render(); };
    });
    root.querySelectorAll('[data-chip]').forEach(function (el) {
      el.onclick = function () { state.statusFilter = el.getAttribute('data-chip'); render(); };
    });

    root.querySelectorAll('.row[data-id], .related-item[data-id]').forEach(function (el) {
      el.onclick = function () {
        state.selectedId = el.getAttribute('data-id');
        state.draft = ''; // selecting a request clears the note draft
        markRead(state.selectedId);
        updateTabTitle();
        render();
      };
    });

    root.querySelectorAll('[data-goto]').forEach(function (el) {
      el.onclick = function () {
        state.selectedId = el.getAttribute('data-goto');
        state.pendingRequestId = state.selectedId;
        state.draft = '';
        state.view = 'inbox';
        markRead(state.selectedId);
        updateTabTitle();
        render();
      };
    });

    var pastOwnersBtn = document.getElementById('pastOwnersBtn');
    if (pastOwnersBtn) pastOwnersBtn.onclick = function () {
      state.showPastOwners = !state.showPastOwners;
      render();
    };

    root.querySelectorAll('select[data-field]').forEach(function (el) {
      el.onchange = function () {
        var patch = {};
        patch[el.getAttribute('data-field')] = el.value;
        saveTriage(patch);
      };
    });

    root.querySelectorAll('[data-assign]').forEach(function (el) {
      el.onclick = function () { saveTriage({ owner: el.getAttribute('data-assign') }); };
    });

    root.querySelectorAll('[data-contact]').forEach(function (el) {
      el.onclick = function () {
        var r = selected();
        var value = el.getAttribute('data-contact');
        saveTriage({ contacted: r && r.contacted === value ? '' : value });
      };
    });

    var draft = document.getElementById('draft');
    if (draft) {
      draft.oninput = function () {
        var wasEmpty = !state.draft.trim();
        state.draft = draft.value;
        var btn = document.getElementById('logBtn');
        // Only re-render when the button's enabled state actually flips.
        if (btn) {
          if (wasEmpty !== !state.draft.trim()) btn.disabled = !state.draft.trim();
          else btn.disabled = !state.draft.trim();
        }
      };
    }

    var logBtn = document.getElementById('logBtn');
    if (logBtn) {
      logBtn.onclick = function () {
        var text = state.draft.trim();
        if (!text) return;
        var id = state.selectedId;
        state.saving = true;
        render();
        api('/api/requests/' + encodeURIComponent(id) + '/activity', {
          method: 'POST', body: JSON.stringify({ text: text })
        }).then(function (res) {
          state.draft = '';
          if (res && res.request) {
            for (var i = 0; i < state.requests.length; i++) {
              if (state.requests[i].id === id) { state.requests[i] = res.request; break; }
            }
          }
        }).catch(showError).finally(function () {
          state.saving = false;
          render();
        });
      };
    }
  }

  function showError(err) {
    state.error = err.message || String(err);
    state.saving = false;
    render();
    setTimeout(function () {
      if (state.error === (err.message || String(err))) { state.error = null; render(); }
    }, 6000);
  }

  // ---------------------------------------------------------------- actions

  /**
   * Applies a triage change optimistically: the dropdown shows the new value at
   * once and the write happens behind it. Previously the UI waited for the write
   * AND a full reload of every request before showing anything, which is why a
   * dropdown appeared to hang for a second or two.
   *
   * If the write fails the change is put back and the error is shown, so the
   * screen never keeps a value the sheet does not have.
   */
  function saveTriage(patch) {
    var id = state.selectedId;
    var request = selected();
    if (!id || !request) return;

    var previous = {};
    Object.keys(patch).forEach(function (key) { previous[key] = request[key]; });

    Object.keys(patch).forEach(function (key) { request[key] = patch[key]; });
    if (patch.owner != null) request.owner = patch.owner || 'Unassigned';

    state.saving = true;
    state.error = null;
    render();

    api('/api/requests/' + encodeURIComponent(id) + '/triage', {
      method: 'POST', body: JSON.stringify(patch)
    })
      .then(function (res) {
        // Prefer the server's version — it carries the activity entries it wrote.
        if (res && res.request) {
          for (var i = 0; i < state.requests.length; i++) {
            if (state.requests[i].id === id) { state.requests[i] = res.request; break; }
          }
        }
      })
      .catch(function (err) {
        Object.keys(previous).forEach(function (key) { request[key] = previous[key]; });
        showError(err);
      })
      .finally(function () { state.saving = false; render(); });
  }

  function refresh(force) {
    var previousIds = {};
    state.requests.forEach(function (r) { previousIds[r.id] = true; });

    return api('/api/state' + (force ? '?fresh=1' : ''))
      .then(function (data) {
        state.requests = data.requests;
        state.options = data.options;
        state.ownerGroups = data.options.owners;
        state.syncedAt = data.syncedAt;
        state.lastTotal = data.requests.length;
        if (data.actor) state.actor = data.actor;
        state.error = null;

        noteArrivals(previousIds);
        updateTabTitle();
      })
      .catch(function (err) {
        if (err.status === 401) { state.authed = false; return; }
        state.error = err.message;
      });
  }

  function loadDashboard() {
    return api('/api/dashboard')
      .then(function (data) { state.dashboard = data; render(); })
      .catch(function (err) { showError(err); });
  }

  function boot() {
    return api('/api/whoami')
      .then(function (who) {
        state.authed = who.authed;
        state.actor = who.actor;
        state.publicDashboard = who.publicDashboard;
        state.ownerGroups = who.owners;
        if (who.pollSeconds) {
          state.pollMs = who.pollSeconds * 1000;
          startPolling();
        }
        state.ready = true;

        if (!who.authed) {
          if (who.publicDashboard) {
            state.view = 'dashboard';
            return loadDashboard();
          }
          render();
          return;
        }
        return refresh(true).then(function () {
          if (!state.selectedId) {
            var first = filtered()[0];
            if (first) state.selectedId = first.id;
          }
          render();
        });
      })
      .catch(function (err) {
        state.ready = true;
        showError(err);
      });
  }

  boot();

  /**
   * Keeps the queue current without a manual reload.
   *
   * Checks the cheap /api/pulse probe and only pulls the full request list when
   * the totals actually move, so most ticks cost almost nothing. Crucially it
   * only repaints when something really changed — repainting on every tick threw
   * away the user's scroll position and made the page feel restless.
   *
   * Interval comes from the server (CONSOLE_POLL_SECONDS) so it can be tuned
   * without a deploy. Your own edits never wait for this; they apply instantly.
   */
  function pollOnce() {
    if (!state.authed || state.saving) return;

    api('/api/pulse')
      .then(function (pulse) {
        state.syncedAt = pulse.syncedAt;

        var changed = state.lastTotal == null || pulse.total !== state.lastTotal;

        if (state.view === 'dashboard') {
          // Reloading the aggregates on every tick rebuilt the page and threw
          // the reader back to the top. Only repaint when a request arrived.
          if (changed) return refresh().then(loadDashboard);
          updateSyncedLabel();
          return;
        }

        // Never redraw the queue out from under someone mid-sentence.
        if (document.activeElement && document.activeElement.id === 'draft') {
          updateSyncedLabel();
          return;
        }

        if (changed) return refresh().then(render);

        // Nothing moved: show that we checked, and leave the page alone.
        updateSyncedLabel();
      })
      .catch(function (err) {
        if (err.status === 401) { state.authed = false; render(); }
        // A transient blip is not worth a banner; the next tick retries.
      });
  }

  var pollTimer = null;
  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollOnce, state.pollMs);
  }

  startPolling();

  // Coming back to a tab that has been idle should not mean waiting out the rest
  // of the interval to see what arrived.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) pollOnce();
  });
})();
