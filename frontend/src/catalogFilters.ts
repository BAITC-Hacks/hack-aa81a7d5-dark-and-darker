import { useState } from 'react';
import { levels, type Role } from './types';

type Filters = { search: string; level: string; sort: string; status: string };
const defaults: Filters = { search: '', level: '', sort: 'newest', status: '' };
const memory = new Map<Role, Filters>();
function read(role: Role): Filters {
  try {
    const stored = JSON.parse(sessionStorage.getItem(`sana-catalog:${role}`) || 'null');
    if (stored && typeof stored === 'object') return {
      search: typeof stored.search === 'string' ? stored.search.slice(0, 200) : '',
      level: levels.includes(stored.level) ? stored.level : '',
      sort: ['newest', 'oldest', 'score_desc', 'score_asc'].includes(stored.sort) ? stored.sort : 'newest',
      status: role === 'business' && ['draft', 'published'].includes(stored.status) ? stored.status : '',
    };
  } catch { /* Storage can be disabled; navigation still retains settings in memory. */ }
  return memory.get(role) ?? { ...defaults };
}

// TasksPage is keyed by role, so each role gets its own state and storage entry.
export function useCatalogFilters(role: Role) {
  const [filters, setFilters] = useState(() => read(role));
  function update(patch: Partial<Filters>) {
    const next = { ...filters, ...patch };
    memory.set(role, next);
    try { sessionStorage.setItem(`sana-catalog:${role}`, JSON.stringify(next)); } catch { /* Keep the memory copy. */ }
    setFilters(next);
  }
  return { filters, update, reset: () => update(defaults) };
}
