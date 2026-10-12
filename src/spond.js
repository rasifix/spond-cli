export class SpondError extends Error {}
const BASE = 'https://api.spond.com/core/v1/';
export function createClient(token, fetchFn = fetch) {
  async function request(path, { method = 'GET', body, params } = {}) {
    const url = new URL(path, BASE);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    let response;
    try {
      response = await fetchFn(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
    } catch { throw new SpondError('Spond is unreachable (network error, timeout, or redirect).'); }
    if (!response.ok) {
      const messages = { 401: path === 'auth2/login'
        ? 'Login failed. Check your credentials and account.'
        : 'Token is invalid or expired. Run spond login.',
        403: 'Access denied. Check group permissions.', 429: 'Too many requests. Please try again later.' };
      throw new SpondError(messages[response.status] ?? `Spond request failed (HTTP ${response.status}).`);
    }
    try { return await response.json(); }
    catch { throw new SpondError('Spond returned invalid JSON.'); }
  }
  return {
    async login(email, password) {
      const data = await request('auth2/login', { method: 'POST', body: { email, password } });
      const access = data?.accessToken;
      if (typeof access?.token !== 'string' || !access.token || /[\r\n]/.test(access.token))
        throw new SpondError('Login returned no token. Check your credentials; MFA and challenges are not supported.');
      return { token: access.token, ...(typeof access.expiration === 'string' ? { expiration: access.expiration } : {}) };
    },
    async groups() {
      const groups = await request('groups');
      if (!Array.isArray(groups)) throw new SpondError('Unexpected group data structure.');
      return groups;
    },
    async events(groupId, { from, to, limit = 100, subgroupId } = {}) {
      const events = await request('sponds', { params: {
        groupId, subGroupId: subgroupId, minStartTimestamp: from, maxStartTimestamp: to, max: limit,
        order: 'asc', scheduled: false, includeHidden: false, includeComments: true, addProfileInfo: true
      } });
      if (!Array.isArray(events)) throw new SpondError('Unexpected event data structure.');
      return events;
    }
  };
}

export function groupRows(groups) {
  if (!Array.isArray(groups)) throw new SpondError('Unexpected group data structure.');
  const rows = [];
  for (const group of groups) {
    if (!group || typeof group.id !== 'string' || typeof group.name !== 'string')
      throw new SpondError('Unexpected group data structure.');
    rows.push({ id: group.id, name: group.name, parentId: '' });
    if (group.subGroups === undefined) continue;
    if (!Array.isArray(group.subGroups)) throw new SpondError('Unexpected subgroup data structure.');
    for (const subgroup of group.subGroups) {
      if (!subgroup || typeof subgroup.id !== 'string' || typeof subgroup.name !== 'string')
        throw new SpondError('Unexpected subgroup data structure.');
      rows.push({ id: subgroup.id, name: subgroup.name, parentId: group.id });
    }
  }
  return rows;
}

const statuses = { acceptedIds: 'accepted', declinedIds: 'declined', unansweredIds: 'unanswered',
  waitinglistIds: 'waitinglist', unconfirmedIds: 'unconfirmed' };
export function rsvpRows(event, members) {
  if (!event.responses || typeof event.responses !== 'object' || Array.isArray(event.responses))
    throw new SpondError('RSVP data unavailable; visibility may be restricted.');
  const names = new Map(members.map(m => [m.id, [m.firstName, m.lastName].filter(Boolean).join(' ')]));
  const rows = [];
  const seen = new Set();
  for (const [field, status] of Object.entries(statuses)) {
    const ids = event.responses[field];
    if (ids === undefined) continue;
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string'))
      throw new SpondError(`Unexpected RSVP data structure: ${field}.`);
    for (const id of ids) {
      if (seen.has(id)) throw new SpondError('Conflicting or duplicate RSVP IDs.');
      seen.add(id);
      rows.push({ memberId: id, name: names.get(id) || '(unmapped)', status });
    }
  }
  return { rows, missingFields: Object.keys(statuses).filter(k => event.responses[k] === undefined),
    unknownFields: Object.keys(event.responses).filter(k => !Object.hasOwn(statuses, k) && /Ids$/.test(k)) };
}

// One row per guardian/member relationship; shared guardians remain linked to each member.
export function guardianRows(members) {
  const rows = [], seen = new Set();
  for (const member of members) {
    if (member.guardians == null) continue;
    if (!Array.isArray(member.guardians)) throw new SpondError('Unexpected guardian data structure.');
    for (const guardian of member.guardians) {
      if (!guardian || typeof guardian.id !== 'string' || !guardian.id || typeof member.id !== 'string' || !member.id)
        throw new SpondError('Guardian or member ID is missing.');
      const key = JSON.stringify([guardian.id, member.id]);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ guardianId: guardian.id,
        name: [guardian.firstName, guardian.lastName].filter(Boolean).join(' '),
        email: typeof guardian.email === 'string' ? guardian.email : '',
        memberId: member.id,
        memberName: [member.firstName, member.lastName].filter(Boolean).join(' ') });
    }
  }
  return rows;
}

export function playerRows(members) {
  return members
    .filter(member => member?.respondent === true)
    .map(member => ({ id: member.id,
      name: [member.firstName, member.lastName].filter(Boolean).join(' ') }));
}
