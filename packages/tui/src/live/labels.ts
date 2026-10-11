// Local-time labels in the design's style. Fixed English names so the output does not depend on the locale.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** "10 Oct". */
export const dayLabel = (d: Date): string => `${pad2(d.getDate())} ${MONTHS[d.getMonth()]}`;

/** "sat 10 oct". */
export const weekdayLabel = (d: Date): string => `${WEEKDAYS[d.getDay()]} ${dayLabel(d).toLowerCase()}`;

/** "04 oct – 10 oct". */
export const rangeLabel = (from: Date, to: Date): string => `${dayLabel(from).toLowerCase()} – ${dayLabel(to).toLowerCase()}`;

/** "08:02". */
export const clockLabel = (d: Date): string => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

/** Local midnight of `d`'s day, `n` days later. */
export const dayStart = (d: Date, n = 0): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** "1,291". */
export const count = (n: number): string => n.toLocaleString("en-US");
