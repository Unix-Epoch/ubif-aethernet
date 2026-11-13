// Audit-agent defaults (set on the admin site, read by the program). Its own module so mobile.js can read staleMinutes without importing index.js (a cycle).
export const AGENT_DEFAULTS = { paused: false, days: [1, 2, 3, 5, 6], times: ['10:00', '18:00'], emailTo: ['green.trimar@gmail.com'], closedDays: 3, staleMinutes: 45, openHours: { from: '10:00', to: '19:00' } };
