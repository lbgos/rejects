export function isHolidaySeason(now: Date): boolean {
  const month = now.getMonth();
  return month === 11 || (month === 0 && now.getDate() <= 7);
}

export interface HolidayThemeGate {
  readonly active: boolean;
  readonly offered: boolean;
}

/** `preview` is the capture override, which draws the theme at any date and on any instance. */
export function resolveHolidayTheme(input: {
  readonly enabled: boolean;
  readonly now: Date;
  readonly preview: boolean;
}): HolidayThemeGate {
  const season = isHolidaySeason(input.now);
  return {
    active: input.preview || (input.enabled && season),
    offered: input.preview || season,
  };
}

export function nextLocalMidnight(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
}
