// "What's new" on the kiosk — the Updates button in the top corner. Newest
// first. Written for the drivers and managers reading the wall iPad, not for
// developers: say what changed for them, not how. Add an entry here with each
// change worth telling people about; a new `id` is what lights up the badge.

export const CHANGELOG = [
  {
    id: '2026-10-20-vehicle-care',
    date: '2026-10-20',
    title: 'Oil changes and vehicle to-do lists',
    items: [
      'Managers can record each car’s last oil change and when the next one is due.',
      'Each car has a to-do list for things like tire certs, damage and paperwork. Open items show as a red flag on that car’s tile, just like a reported issue.',
      'This Updates button, so you can see what’s changed.',
    ],
  },
  {
    id: '2026-10-19-instructions-drivers',
    date: '2026-10-19',
    title: 'Closing how-tos and a Drivers tab',
    items: [
      'Closing tasks now show how to do each one, right beside the task.',
      'New Drivers tab lists everyone on the roster, with who’s on shift first. Handy for covering a call-out.',
    ],
  },
  {
    id: '2026-10-09-closing',
    date: '2026-10-09',
    title: 'Closing checklist',
    items: ['The Closing tab is the end-of-night checklist. Tick tasks off as the close happens.'],
  },
  {
    id: '2026-10-07-feedback',
    date: '2026-10-07',
    title: 'Send feedback',
    items: ['Something broken, confusing or missing? Tap Feedback in the top corner and it goes straight to the team.'],
  },
  {
    id: '2026-09-18-issues-tasks',
    date: '2026-09-18',
    title: 'Report a car problem, and smarter slow tasks',
    items: [
      'Report an issue with any vehicle from the button under the board, even one that’s out of service or being driven.',
      'Slow tasks can repeat on an interval, at set times of day, several times a day, or just once. When several are due, the highest priority comes first.',
    ],
  },
  {
    id: '2026-09-17-redesign',
    date: '2026-09-17',
    title: 'A new look',
    items: [
      'The board was redesigned to be easier to read from across the room.',
      'The kiosk now updates itself when a new version is released, but never in the middle of someone’s checkout.',
    ],
  },
  {
    id: '2026-08-19-overdue',
    date: '2026-08-19',
    title: 'Forgotten sign-outs get flagged',
    items: ['A shift still open after 12 hours is flagged on the board so it can be closed out.'],
  },
];

// Entries newer than the last one this device has seen. Nothing seen yet means
// everything is new. A remembered id that has since been removed from the list
// counts as "seen it all" rather than lighting up the whole history again.
export function unseenEntries(entries, lastSeenId) {
  if (!lastSeenId) return entries;
  const index = entries.findIndex((entry) => entry.id === lastSeenId);
  return index === -1 ? [] : entries.slice(0, index);
}
