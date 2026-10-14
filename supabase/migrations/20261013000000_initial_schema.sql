-- Participant Feedback Portal: initial schema (migration plan, phase 1).
--
-- Everything lives in the `portal` schema. Supabase's Data API publishes only
-- `public` by default, and row-level security is on for every table below
-- with a policy for `portal_api` alone, so the project's public API key can
-- read nothing even if this schema were ever exposed.
--
-- The Netlify API connects as `portal_api`, which can do only what the
-- portal's actions need. After running this file, set its password once from
-- the Supabase SQL editor (the value lives in the password manager, never in
-- this repository):
--
--   alter role portal_api with login password '...';

create schema if not exists portal;
revoke all on schema portal from public;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'portal_api') then
    create role portal_api nologin;
  end if;
end
$$;

create type portal.admin_role as enum ('admin', 'superadmin');
create type portal.question_type as enum ('rating', 'yesno', 'text');
create type portal.certificate_status as enum ('pending', 'processing', 'issued', 'failed');

-- Users + Whitelist sheets, merged.
create table portal.admin_users (
  email          text primary key
                 check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 254),
  legacy_user_id text unique,               -- 'U-xxxxxxxx' from the Whitelist sheet
  name           text not null check (length(name) between 1 and 160),
  role           portal.admin_role not null default 'admin',
  active         boolean not null default true,
  password_hash  text not null,             -- 'v2:…', the legacy format, or 'scrypt:…' after re-hashing
  password_salt  text not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Activity sheet. `code` keeps the existing A-xxxxxxxx ID that participants'
-- links, responses and analytics filters already use.
create table portal.activities (
  id                    uuid primary key default gen_random_uuid(),
  code                  text not null unique check (length(code) between 1 and 40),
  title                 text not null check (length(title) between 1 and 300),
  venue                 text not null default '',
  from_date             date not null,
  to_date               date,
  given_date            date,
  region                text not null default '',
  signatory_name        text not null default '',
  signatory_designation text not null default '',
  signature_url         text not null default '',
  template_url          text not null default '',
  created_by            text references portal.admin_users (email) on update cascade on delete set null,
  active                boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- An end before the start made the feedback window empty: the activity
  -- could never open.
  constraint activities_end_not_before_start check (to_date is null or to_date >= from_date)
);

-- Questions sheet. Each section is one page of the survey; each question
-- keeps a permanent ID so answers never move under another question. Removing
-- either one retires it: it leaves the form but keeps its history.
create table portal.survey_sections (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(name) between 1 and 120),
  position   integer not null,
  retired_at timestamptz,
  created_at timestamptz not null default now()
);

create table portal.questions (
  id         uuid primary key default gen_random_uuid(),
  section_id uuid not null references portal.survey_sections (id),
  position   integer not null,
  text       text not null check (length(text) between 1 and 500),
  type       portal.question_type not null default 'rating',
  retired_at timestamptz,
  created_at timestamptz not null default now()
);
create index questions_live on portal.questions (section_id, position) where retired_at is null;

-- Responses sheet. Activity title, venue and date are copied at submission,
-- as the sheet does, so a response still reads correctly after its activity
-- is edited or deleted.
create table portal.responses (
  id                bigint generated always as identity primary key,
  submitted_at      timestamptz not null default now(),
  activity_id       uuid references portal.activities (id) on delete set null,
  activity_code     text not null,
  activity_title    text not null,
  venue             text not null default '',
  activity_date     text not null default '',
  name              text not null check (length(name) between 1 and 160),
  email             text not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 254),
  sex               text not null check (length(sex) between 1 and 40),
  age               smallint not null check (age between 1 and 120),
  takeaways         text not null default '' check (length(takeaways) <= 2000),
  suggestions       text not null default '' check (length(suggestions) <= 2000),
  certificate_status portal.certificate_status not null default 'pending',
  certificate_error text,
  claimed_at        timestamptz,              -- when the worker took the job (see claim_certificate_jobs)
  claim_token       uuid,                     -- a report carrying an older token is ignored
  attempts          integer not null default 0,
  certificate_url   text,
  emailed_at        timestamptz,
  email_note        text,                     -- 'No recipient email', or a link-sharing warning
  verification_code text not null unique check (verification_code ~ '^CHED-[A-F0-9]{20}$'),
  legacy_sheet_row  integer unique            -- Responses row number, kept for the import's cross-checks
);

-- The duplicate rule: one response per activity and email, case-insensitive.
-- Failed rows do not count, so a participant whose certificate failed can
-- submit again; retrying the failed row after that is refused here, which is
-- what stops a second certificate being issued.
create unique index responses_one_per_activity_email
  on portal.responses (activity_id, lower(email))
  where certificate_status <> 'failed';
create index responses_queue on portal.responses (certificate_status, claimed_at)
  where certificate_status in ('pending', 'processing');
create index responses_by_activity on portal.responses (activity_code, submitted_at desc);

create table portal.answers (
  response_id bigint not null references portal.responses (id) on delete cascade,
  question_id uuid not null references portal.questions (id),
  value       text not null check (length(value) between 1 and 2000),
  primary key (response_id, question_id)
);
create index answers_by_question on portal.answers (question_id);

-- Audit sheet. `logged_at` is the exact text the entry's HMAC covers, so it
-- is stored as text: a timestamp column would re-render it and break the
-- tamper check, the mistake Sheets made.
create table portal.audit_log (
  id            bigint generated always as identity primary key,
  logged_at     text not null check (logged_at ~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$'),
  audit_id      text not null unique,
  actor_email   text not null default '',
  actor_role    text not null default '',
  action        text not null,
  target_type   text not null default '',
  target_id     text not null default '',
  outcome       text not null check (outcome in ('SUCCESS', 'FAILURE')),
  details       text not null default '{}',
  request_id    text not null default '',
  previous_hash text not null default '',
  entry_hash    text not null unique
);

create function portal.audit_log_is_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'The audit log is append-only: % is not allowed.', tg_op;
end
$$;
create trigger audit_log_no_update_or_delete before update or delete on portal.audit_log
  for each row execute function portal.audit_log_is_append_only();
create trigger audit_log_no_truncate before truncate on portal.audit_log
  for each statement execute function portal.audit_log_is_append_only();

-- Script Properties: sessions, the sign-in throttle and settings.
create table portal.admin_sessions (
  token_hash text primary key,              -- HMAC of the token; the token itself is never stored
  email      text not null references portal.admin_users (email) on update cascade on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index admin_sessions_expiry on portal.admin_sessions (expires_at);

-- The sign-in throttle: 5 attempts, then locked until 15 minutes after the
-- latest one, as the Apps Script cache entry behaved.
create table portal.login_attempts (
  email_hash      text primary key,
  attempts        integer not null default 0,
  last_attempt_at timestamptz not null default now()
);

create table portal.settings (
  key        text primary key,              -- e.g. portal_base_url, audit_head_hash
  value      text not null,
  updated_at timestamptz not null default now()
);

-- The certificate worker's queue. One statement marks up to `batch_size`
-- jobs as processing and hands each a fresh claim token; SKIP LOCKED means
-- two overlapping runs can never take the same row. A job still processing
-- after `lease` belongs to a run that died (Apps Script stops every run at 6
-- minutes) and is taken again, which replaces the manual "Stuck" tab.
create function portal.claim_certificate_jobs(batch_size integer default 10, lease interval default '15 minutes')
returns table (response_id bigint, claim_token uuid)
language sql as $$
  with picked as (
    select r.id
      from portal.responses r
      join portal.activities a on a.id = r.activity_id and a.active
     where r.certificate_status = 'pending'
        or (r.certificate_status = 'processing' and r.claimed_at < now() - lease)
     order by r.id
     limit batch_size
       for update of r skip locked
  )
  update portal.responses r
     set certificate_status = 'processing',
         claimed_at = now(),
         claim_token = gen_random_uuid(),
         attempts = r.attempts + 1
    from picked
   where r.id = picked.id
  returning r.id, r.claim_token;
$$;

-- Row-level security: on for every table, with access for portal_api only.
do $$
declare t text;
begin
  foreach t in array array['admin_users', 'activities', 'survey_sections', 'questions', 'responses',
                           'answers', 'audit_log', 'admin_sessions', 'login_attempts', 'settings']
  loop
    execute format('alter table portal.%I enable row level security', t);
  end loop;
  foreach t in array array['admin_users', 'activities', 'survey_sections', 'questions', 'responses',
                           'answers', 'admin_sessions', 'login_attempts', 'settings']
  loop
    execute format('create policy portal_api_access on portal.%I to portal_api using (true) with check (true)', t);
  end loop;
end
$$;
create policy portal_api_read on portal.audit_log for select to portal_api using (true);
create policy portal_api_append on portal.audit_log for insert to portal_api with check (true);

-- Privileges: what the API's actions need, and nothing more. The audit log
-- may be read and appended to, never changed.
grant usage on schema portal to portal_api;
grant select, insert, update, delete on
  portal.admin_users, portal.activities, portal.survey_sections, portal.questions, portal.responses,
  portal.answers, portal.admin_sessions, portal.login_attempts, portal.settings
  to portal_api;
grant select, insert on portal.audit_log to portal_api;
grant usage on all sequences in schema portal to portal_api;
revoke all on function portal.claim_certificate_jobs(integer, interval) from public;
grant execute on function portal.claim_certificate_jobs(integer, interval) to portal_api;
