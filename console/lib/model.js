/**
 * Turning sheet rows into the model the console renders, and the derived numbers
 * the dashboard shows.
 *
 * Pure functions only - no network, no Sheets client - so all of this is
 * directly testable.
 */

const owners = require('./owners');
const clients = require('./clients');

// The exact values column H's dropdown offers. Must round-trip unchanged: the
// bot's normalizeStatusString() and the Apps Script filters depend on them,
// including the deliberately lowercase "needs to be clarified".
const STATUS_OPTIONS = [
  'To be contacted',
  'In Progress',
  'Completed',
  'Not started',
  'needs to be clarified'
];

const DONE_STATUS = 'Completed';

// bg / text / bar, from the design tokens.
const STATUS_COLORS = {
  'To be contacted':        { bg: '#FFE1AC', text: '#7A4A00', bar: '#F0A93C' },
  'In Progress':            { bg: '#D9E7FF', text: '#1B4B8F', bar: '#3E7BD6' },
  'Completed':              { bg: '#D8F0DD', text: '#1B5E2A', bar: '#199948' },
  'Not started':            { bg: '#FFDCDC', text: '#8C2020', bar: '#D24E4E' },
  'needs to be clarified':  { bg: '#FFF3C4', text: '#6F5A00', bar: '#D8B326' }
};

const STATUS_FALLBACK = { bg: '#EDF0EC', text: '#46584C', bar: '#9AA79E' };

const PRIORITY_OPTIONS = ['', 'Low', 'Normal', 'High', 'Urgent'];
const CATEGORY_OPTIONS = [
  '', 'Payroll', 'Documents', 'Equipment', 'Scanner', 'Vacation',
  'Bank details', 'Contract', 'Recruiting', 'Vehicle', 'Other'
];
const CONTACT_METHODS = ['WhatsApp', 'Phone', 'In person'];

function statusColors(status) {
  return STATUS_COLORS[status] || STATUS_FALLBACK;
}

/** An open request is anything not Completed - matches the design's `Open` chip. */
function isOpen(status) {
  return String(status || '').trim().toLowerCase() !== DONE_STATUS.toLowerCase();
}

/**
 * Parse the bot's timestamp format: "DD/MM/YYYY, HH:mm:ss" (en-GB, 24h).
 *
 * Never hand this to `new Date()`. JavaScript reads "05/08/2026" as 5 August in
 * some engines and as May 8th in others, so for the first twelve days of every
 * month the age of every request - and therefore the whole aging breakdown and
 * the SLA column - would be silently wrong.
 *
 * @returns {Date|null} null when the value cannot be parsed
 */
function parseSheetTimestamp(value) {
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;

  const text = String(value == null ? '' : value).trim();
  if (!text) return null;

  const m = text.match(
    /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:,)?\s*(?:(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (!m) return null;

  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  const hour = m[4] ? parseInt(m[4], 10) : 0;
  const minute = m[5] ? parseInt(m[5], 10) : 0;
  const second = m[6] ? parseInt(m[6], 10) : 0;

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;

  const date = new Date(year, month - 1, day, hour, minute, second);

  // Rejects impossible dates that would otherwise roll over, e.g. 31/02/2026.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }

  return date;
}

/** Whole days between a request's timestamp and now. Unparseable dates give null. */
function ageInDays(timestamp, now) {
  const then = parseSheetTimestamp(timestamp);
  if (!then) return null;

  const reference = now || new Date();
  const startOfThen = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const startOfNow = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());

  return Math.max(0, Math.round((startOfNow - startOfThen) / 86400000));
}

/** Aging colour thresholds from the design tokens. */
function ageColor(age) {
  if (age == null) return '#8B998F';
  if (age <= 7) return '#5D6D63';
  if (age <= 21) return '#8A5A00';
  return '#B4291F';
}

function agingBucket(age) {
  if (age == null) return null;
  if (age <= 3) return '0–3 days';
  if (age <= 7) return '4–7 days';
  if (age <= 21) return '8–21 days';
  return '22+ days';
}

const AGING_BUCKETS = [
  { label: '0–3 days',  color: '#199948' },
  { label: '4–7 days',  color: '#7FB08C' },
  { label: '8–21 days', color: '#F0A93C' },
  { label: '22+ days',  color: '#D24E4E' }
];

/** Digits-only form of a phone number, for grouping duplicates reliably. */
function phoneKey(phone) {
  return String(phone == null ? '' : phone).replace(/\D/g, '');
}

/**
 * Flags requests that share a phone number, so the queue can show the
 * "possible duplicate" banner. Counts across OPEN requests only - a driver with
 * one open request and ten completed ones is not a duplicate.
 */
function markDuplicates(requests) {
  const openCountByPhone = {};

  requests.forEach(function (r) {
    if (!isOpen(r.status)) return;
    const key = phoneKey(r.phone);
    if (!key) return;
    openCountByPhone[key] = (openCountByPhone[key] || 0) + 1;
  });

  requests.forEach(function (r) {
    const key = phoneKey(r.phone);
    r.samePhoneOpenCount = key ? (openCountByPhone[key] || 0) : 0;
    r.isDuplicate = r.samePhoneOpenCount > 1;
  });

  return requests;
}

/** Other requests from the same phone number, newest first. */
function relatedRequests(requests, request) {
  const key = phoneKey(request.phone);
  if (!key) return [];

  return requests
    .filter(function (r) { return r.id !== request.id && phoneKey(r.phone) === key; })
    .sort(function (a, b) { return (a.age == null ? 1e9 : a.age) - (b.age == null ? 1e9 : b.age); });
}

/**
 * Applies the three composable filters from the design: station AND status chip
 * AND free-text search. Result is always sorted oldest-open-first.
 */
function filterRequests(requests, opts) {
  const station = (opts && opts.station) || 'All';
  const statusFilter = (opts && opts.statusFilter) || 'Open';
  const query = String((opts && opts.query) || '').trim().toLowerCase();

  const client = (opts && opts.client) || 'All';
  const owner = (opts && opts.owner) || 'All';

  const matched = requests.filter(function (r) {
    // Owner is independent of status, so "my open requests" composes naturally.
    if (owner !== 'All' && (r.owner || owners.UNASSIGNED) !== owner) return false;

    // Contract first, then the location within it.
    if (client !== 'All' && clients.clientOf(r.station) !== client) return false;
    if (station !== 'All' && clients.locationOf(r.station) !== station) return false;

    if (statusFilter === 'Open' && !isOpen(r.status)) return false;
    if (statusFilter === 'Unassigned' && r.owner !== owners.UNASSIGNED) return false;
    if (['To be contacted', 'In Progress', 'Completed', 'Not started', 'needs to be clarified']
      .indexOf(statusFilter) !== -1 && r.status !== statusFilter) return false;

    if (query) {
      const haystack = [
        r.first, r.last, r.first + ' ' + r.last, r.id, r.text, r.category, r.owner, r.station
      ].join(' ').toLowerCase();
      if (haystack.indexOf(query) === -1) return false;
    }

    return true;
  });

  return matched.sort(function (a, b) {
    const ageA = a.age == null ? -1 : a.age;
    const ageB = b.age == null ? -1 : b.age;
    if (ageB !== ageA) return ageB - ageA;      // oldest first
    return String(a.id).localeCompare(String(b.id)); // stable tiebreak
  });
}

function countMix(rows, nameOf, colorOf) {
  const counts = {};
  rows.forEach(function (r) {
    const name = nameOf(r);
    counts[name] = (counts[name] || 0) + 1;
  });
  const denom = rows.length || 1;
  return Object.keys(counts)
    .sort(function (a, b) { return counts[b] - counts[a]; })
    .map(function (name) {
      return {
        name: name,
        count: counts[name],
        pct: Math.round((counts[name] / denom) * 1000) / 10,
        color: colorOf(name)
      };
    });
}

function attentionRow(r) {
  return {
    id: r.id,
    age: r.age,
    station: r.station,
    owner: r.owner,
    status: r.status,
    text: r.text,
    category: r.category || ''
  };
}

/** Everything the dashboard renders, computed in one pass over the requests. */
function dashboardStats(requests) {
  const total = requests.length;
  const open = requests.filter(function (r) { return isOpen(r.status); });
  const completed = requests.filter(function (r) { return !isOpen(r.status); });

  const pct = function (n) { return total ? Math.round((n / total) * 1000) / 10 : 0; };

  // Status mix, ordered by the dropdown so colours stay stable between refreshes.
  const statusCounts = {};
  requests.forEach(function (r) {
    const key = r.status || '(blank)';
    statusCounts[key] = (statusCounts[key] || 0) + 1;
  });
  const statusMix = Object.keys(statusCounts)
    .sort(function (a, b) { return statusCounts[b] - statusCounts[a]; })
    .map(function (name) {
      return {
        name: name,
        count: statusCounts[name],
        pct: pct(statusCounts[name]),
        color: statusColors(name).bar
      };
    });

  const stationCounts = {};
  requests.forEach(function (r) {
    const key = r.station || '(none)';
    stationCounts[key] = (stationCounts[key] || 0) + 1;
  });
  const byStation = Object.keys(stationCounts)
    .sort(function (a, b) { return stationCounts[b] - stationCounts[a]; })
    .map(function (name) {
      const config = clients.configOf(clients.clientOf(name));
      return {
        name: name,
        count: stationCounts[name],
        pct: pct(stationCounts[name]),
        color: config ? config.color : '#9AA79E'
      };
    });

  // Per contract: the split that matters now that VOI is a separate business.
  const byClientMap = {};
  requests.forEach(function (r) {
    const key = clients.clientOf(r.station);
    if (!byClientMap[key]) byClientMap[key] = { open: 0, total: 0, unassigned: 0 };
    byClientMap[key].total++;
    if (isOpen(r.status)) {
      byClientMap[key].open++;
      if ((r.owner || owners.UNASSIGNED) === owners.UNASSIGNED) byClientMap[key].unassigned++;
    }
  });
  const byClient = Object.keys(byClientMap).map(function (key) {
    const row = byClientMap[key];
    const config = clients.configOf(key);
    return {
      client: key,
      label: clients.labelOf(key),
      color: config ? config.color : '#9AA79E',
      open: row.open,
      total: row.total,
      unassigned: row.unassigned,
      pct: pct(row.total)
    };
  }).sort(function (a, b) { return b.total - a.total; });

  // Workload per owner: unassigned first, then most open work.
  const byOwnerMap = {};
  requests.forEach(function (r) {
    const key = r.owner || owners.UNASSIGNED;
    if (!byOwnerMap[key]) byOwnerMap[key] = { owner: key, open: 0, total: 0 };
    byOwnerMap[key].total++;
    if (isOpen(r.status)) byOwnerMap[key].open++;
  });
  const byOwner = Object.keys(byOwnerMap).map(function (key) {
    const row = byOwnerMap[key];
    return {
      owner: row.owner,
      team: owners.teamOf(row.owner),
      open: row.open,
      total: row.total,
      donePct: row.total ? Math.round(((row.total - row.open) / row.total) * 100) : 0,
      isUnassigned: row.owner === owners.UNASSIGNED,
      isLegacy: owners.isLegacy(row.owner)
    };
  }).sort(function (a, b) {
    if (a.isUnassigned !== b.isUnassigned) return a.isUnassigned ? -1 : 1;
    if (b.open !== a.open) return b.open - a.open;
    return b.total - a.total;
  });

  const aging = AGING_BUCKETS.map(function (bucket) {
    return {
      label: bucket.label,
      color: bucket.color,
      count: open.filter(function (r) { return agingBucket(r.age) === bucket.label; }).length
    };
  });

  const unassigned = open.filter(function (r) { return r.owner === owners.UNASSIGNED; }).length;
  const overSeven = open.filter(function (r) { return r.age != null && r.age > 7; }).length;

  // Time to resolve means creation -> completion, which needs the "Completed At"
  // date that google-apps-script/dashboard.gs stamps. Deliberately NOT derived
  // from `age`: age runs to today, so a request closed the day after it arrived
  // a year ago would report ~365 days. Requests completed before that column
  // existed have no completion date and are simply excluded, with `avgDaysCoverage`
  // reporting how many did count so the number is never read as complete.
  const resolveTimes = completed
    .map(function (r) { return r.resolveDays; })
    .filter(function (d) { return d != null; });
  const avgDays = resolveTimes.length
    ? Math.round((resolveTimes.reduce(function (s, d) { return s + d; }, 0) / resolveTimes.length) * 10) / 10
    : null;

  const needsAttention = open
    .filter(function (r) { return r.owner === owners.UNASSIGNED || (r.age != null && r.age > 21); })
    .sort(function (a, b) { return (b.age || 0) - (a.age || 0); });

  // Old breaches stay in their own list. New and unassigned work would otherwise
  // sort underneath a 60-day row and never get seen.
  const overdue = open
    .filter(function (r) { return r.age != null && r.age > 21; })
    .sort(function (a, b) { return (b.age || 0) - (a.age || 0); })
    .map(attentionRow);
  const arriving = open
    .filter(function (r) {
      if (r.age != null && r.age > 21) return false;
      return r.owner === owners.UNASSIGNED || r.age === 0 || r.age === 1;
    })
    .sort(function (a, b) { return (a.age == null ? 0 : a.age) - (b.age == null ? 0 : b.age); })
    .map(attentionRow);

  const openStatusMix = countMix(open, function (r) { return r.status || '(blank)'; }, function (name) {
    return statusColors(name).bar;
  });
  const openByStation = countMix(open, function (r) { return r.station || '(none)'; }, function (name) {
    const config = clients.configOf(clients.clientOf(name));
    return config ? config.color : '#9AA79E';
  });
  const CATEGORY_COLORS = {
    Payroll: '#199948',
    Documents: '#3E7BD6',
    Equipment: '#7A5AF8',
    Scanner: '#0E8A8A',
    Vacation: '#C45C26',
    'Bank details': '#8A5A00',
    Contract: '#3D6B4F',
    Recruiting: '#5B4B8A',
    Vehicle: '#1F6B4A'
  };
  const openByCategory = countMix(open, function (r) {
    return r.category ? r.category : 'Uncategorised';
  }, function (name) {
    return CATEGORY_COLORS[name] || '#9AA79E';
  });

  return {
    kpis: {
      total: total,
      open: open.length,
      openPct: pct(open.length),
      completed: completed.length,
      completedPct: pct(completed.length),
      unassigned: unassigned,
      overSeven: overSeven,
      newToday: open.filter(function (r) { return r.age === 0; }).length,
      avgDays: avgDays,
      avgDaysCoverage: resolveTimes.length,
      completedCount: completed.length
    },
    statusMix: statusMix,
    byStation: byStation,
    openStatusMix: openStatusMix,
    openByStation: openByStation,
    openByCategory: openByCategory,
    byClient: byClient,
    byOwner: byOwner,
    aging: aging,
    needsAttention: needsAttention.map(attentionRow),
    arriving: arriving,
    overdue: overdue
  };
}

module.exports = {
  STATUS_OPTIONS,
  STATUS_COLORS,
  DONE_STATUS,
  PRIORITY_OPTIONS,
  CATEGORY_OPTIONS,
  CONTACT_METHODS,
  AGING_BUCKETS,
  statusColors,
  isOpen,
  parseSheetTimestamp,
  ageInDays,
  ageColor,
  agingBucket,
  phoneKey,
  markDuplicates,
  relatedRequests,
  filterRequests,
  dashboardStats
};
