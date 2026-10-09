// Supabase project config. The publishable/anon key is safe to ship in
// frontend code — it only grants what Row Level Security allows (see
// sql/schema.sql). NEVER put a service-role/secret key here or anywhere in
// this repo.
export const SUPABASE_URL = 'https://rtxswisramlgnwbfggzu.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_FxAis5fQyiSWWcP-fgLMDw_4_DUzP7w';

// The hour the closing checklist starts a fresh night. Not midnight: a close
// that runs to 12:30am is still that night's close, and resetting at midnight
// would wipe half-finished ticks off the screen in front of whoever is doing it.
// Ticks made before this hour count toward the previous day.
export const CLOSING_DAY_STARTS_AT_HOUR = 4;

// A shift still open after this many hours is treated as "the driver forgot to
// sign out" and flagged on both boards. It is only ever a flag: nothing closes
// a session automatically, so PitCrew never invents a return time. An admin
// force-closes from the dashboard, and that gets recorded as a management
// action so history stays honest about which returns were real.
export const SHIFT_OVERDUE_HOURS = 12;

// Admin screen passcode. This is a casual deterrent only, NOT real
// security — it's a plain constant shipped in frontend code, same as the
// publishable key above. The actual access boundary is Supabase RLS
// (sql/schema.sql); anyone with the publishable key can already call the
// same insert/update operations directly. This just keeps someone
// wandering by the kiosk from poking at admin/edit screens. It is asked for
// every time admin.html loads — nothing remembers an unlock, because the one
// device that matters is a wall iPad whose browser session outlives everybody's
// shift. Change it here before deploying; there's no admin UI for changing it.
export const ADMIN_PIN = '3560';

// Zapier "Catch Hook" URL for the Send Feedback button (see js/feedback.js and
// "Feedback to Monday" in the README). Leave empty to hide the button. Like the
// publishable key, this ships to every browser: anyone who finds it can post a
// feedback item, and nothing more.
export const FEEDBACK_WEBHOOK_URL = 'https://hooks.zapier.com/hooks/catch/10599539/4mnt30k/';
