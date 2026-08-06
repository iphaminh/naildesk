-- SECURITY FIX — run AFTER the server is switched to the service_role key.
--
-- Today every table has `to public using (true)`, which means the publishable
-- (anon) key can read and write everything: customer phones and session tokens,
-- the 800-customer salon list, credit balances, and the settings table that
-- holds the Stripe secret key, the Gemini key and the admin PIN.
--
-- The server is the only thing that should ever touch this database, and it
-- talks to Postgres as service_role, which BYPASSES row level security. So the
-- correct posture is: no policy for anon at all. Dropping the permissive
-- policies (leaving RLS enabled) denies the anon key everything while the
-- server keeps working unchanged.

drop policy if exists app_all_appointments on appointments;
drop policy if exists app_all_blocked_slots on blocked_slots;
drop policy if exists app_all_checkins on checkins;
drop policy if exists app_all_customers on customers;
drop policy if exists app_all_nailmind_accounts on nailmind_accounts;
drop policy if exists app_all_nailmind_designs on nailmind_designs;
drop policy if exists app_all_nailmind_ledger on nailmind_ledger;
drop policy if exists app_all_nailmind_stripe_events on nailmind_stripe_events;
drop policy if exists app_all_nailmind_usage on nailmind_usage;
drop policy if exists app_all_referrals on referrals;
drop policy if exists app_all_services on services;
drop policy if exists app_all_settings on settings;
drop policy if exists app_all_tech_services on tech_services;
drop policy if exists app_all_techs on techs;
drop policy if exists app_all_ticket_items on ticket_items;
drop policy if exists app_all_tickets on tickets;

-- Belt and braces: revoke direct table privileges from the public API roles too,
-- so a future accidental policy can't re-open the door.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
