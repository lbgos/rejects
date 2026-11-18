import { useHolidayTheme } from "./holidayTheme";

const COLOURS = ["warm", "berry", "gold", "fir"] as const;
const RUN = ["warm", "berry", "warm", "gold", "warm", "fir"] as const;
const BULBS = [...RUN, ...RUN, ...RUN].map((light, index) => {
  const angle = (index / 18) * 2 * Math.PI - Math.PI / 2;
  return { x: 50 + 41 * Math.cos(angle), y: 50 + 41 * Math.sin(angle), light };
});

export function HolidayWreath() {
  const { active } = useHolidayTheme();
  if (!active) return null;
  return (
    <svg
      aria-hidden
      data-holiday-wreath
      viewBox="0 0 100 100"
      className="pointer-events-none absolute -top-4 left-1/2 hidden size-24 -translate-x-1/2 max-md:-top-4.5 max-md:size-28"
    >
      <defs>
        {COLOURS.map((light) => (
          <radialGradient key={light} id={`holiday-wreath-${light}`}>
            <stop offset="0" stopOpacity="0.45" style={{ stopColor: `var(--holiday-${light})` }} />
            <stop offset="1" stopOpacity="0" style={{ stopColor: `var(--holiday-${light})` }} />
          </radialGradient>
        ))}
      </defs>
      <circle
        cx="50"
        cy="50"
        r="41"
        fill="none"
        strokeWidth="0.8"
        style={{ stroke: "var(--holiday-wire)" }}
      />
      {BULBS.map(({ x, y, light }) => (
        <g key={`${x}:${y}`}>
          <circle cx={x} cy={y} r="5.5" fill={`url(#holiday-wreath-${light})`} />
          <circle cx={x} cy={y} r="1.8" style={{ fill: `var(--holiday-${light})` }} />
        </g>
      ))}
    </svg>
  );
}
