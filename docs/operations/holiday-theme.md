# Holiday theme

The web app's bots screens take a seasonal look from 1 December to 7 January in the client's local
time, on instances that turn it on. It draws in dark appearance, on the default theme or on top of
a named one.

## On and off

The `holidayTheme` server setting is off by default. Either:

- Settings > Appearance > Interface > Holiday theme. The switch shows only in season.
- `"holidayTheme": true` (or `false`) in the instance's `userdata/settings.json`. The server
  watches the file, so no restart is needed.

The setting is per instance and applies to every device connected to it. An open tab follows
local midnight at both ends of the season. Out of season nothing in the UI names the theme.

## Preview at any date

Open any app URL with `?holiday-preview=1`. It forces the theme on for that page load only, on any
instance and date, and is never stored. A reload without the parameter, or a new tab, shows the
real state. The Settings switch keeps showing the real setting.

Captures: use dark appearance and add the parameter to every URL the browser loads.
