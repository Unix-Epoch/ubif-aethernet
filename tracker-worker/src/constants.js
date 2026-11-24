/*
  Business constants the tracker Worker's modules share: one definition each.

  Store hours come from the Assize rules engine (assize-rules.js): that file is inlined into the userscript and the admin site as a plain
  function body, so it cannot import, and it stays the one place the hours are written. Open 10–19 Monday–Saturday; Lexington every day.
*/
import { R } from './assize.js';

export const STORE_HOURS = R.STORE_HOURS;
export const hoursFor = R.hoursFor;

// Portal's status ids for a work order that is over: Sale complete, Closed, Cancelled.
export const CLOSED_STATUS = new Set([14, 15, 25]);

// Sales per labor hour target band, dollars. Same band as Tactician's TARGET.withoutGm (src/62-tactician.js, Oct 12, 2026):
// the userscript's constant can't be imported by a Worker, so it is repeated here, once. labor_hours excludes general managers.
export const SPLH_TARGET = [160, 180];
