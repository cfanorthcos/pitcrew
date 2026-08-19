// Supabase project config. The publishable/anon key is safe to ship in
// frontend code — it only grants what Row Level Security allows (see
// sql/schema.sql). NEVER put a service-role/secret key here or anywhere in
// this repo.
export const SUPABASE_URL = 'https://rtxswisramlgnwbfggzu.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_FxAis5fQyiSWWcP-fgLMDw_4_DUzP7w';

// Default "needs cleaning after N days" for a newly-added hot bag. Each bag
// stores its own clean_window_days in the database and can be tuned
// individually from the admin Hot Bags screen; this is just the prefill.
export const HOT_BAG_CLEAN_WINDOW_DAYS = 7;

// Admin screen passcode. This is a casual deterrent only, NOT real
// security — it's a plain constant shipped in frontend code, same as the
// publishable key above. The actual access boundary is Supabase RLS
// (sql/schema.sql); anyone with the publishable key can already call the
// same insert/update operations directly. This just keeps someone
// wandering by the kiosk from poking at admin/edit screens. Change it here
// before deploying; there's no admin UI for changing it.
export const ADMIN_PIN = '4477';
