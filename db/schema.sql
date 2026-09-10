-- Jobverse DB schema — the four tables the sync layer keeps fresh from
-- (or pushes back into) the Sheet.
--
-- Column names mirror the Sheet columns referenced elsewhere this session
-- (Prospects.gs, ReviewQueue structure, Reports.gs's Applications reads,
-- the logActivity(actor, action, entityType, entityId, details) call
-- pattern used everywhere). Applications in particular is assembled from
-- what Reports.gs reads (Status, Outcome, InterviewDate, CreatedAt) plus
-- the fields the worker/claim patches added (ClaimedBy, ATSType, file
-- ids) — I haven't read a live Applications sheet header row this
-- session, so treat those columns as a proposal to diff against the real
-- one, not a confirmed match.

create table if not exists prospects (
  prospect_id   text primary key,          -- ProspectID
  found_at      timestamptz not null,      -- FoundAt
  candidate_id  text not null,             -- CandidateID
  company       text,
  job_title     text,
  job_url       text not null,
  source        text,                      -- adzuna / reed / jsearch
  status        text not null,             -- Found / Found - Manual Review / Queued / ...
  notes         text,
  updated_at    timestamptz not null default now()
);
create index if not exists idx_prospects_candidate on prospects (candidate_id);
create unique index if not exists idx_prospects_job_url_candidate on prospects (candidate_id, job_url);

create table if not exists applications (
  application_id       text primary key,
  candidate_id         text not null,
  job_url              text not null,
  prospect_id          text references prospects(prospect_id),
  ats_type             text,               -- greenhouse / lever / workday / null=unsupported
  status               text not null,      -- Generated / Claiming / Approved / Submitted / Failed
  claimed_by            text,
  claimed_at            timestamptz,
  submitted_at          timestamptz,
  outcome               text,              -- free text, Reports.gs string-matches 'interview'/'offer' in this
  interview_date         timestamptz,
  cv_file_id             text,
  cover_letter_file_id   text,
  ai_score               numeric,
  ai_findings            jsonb,            -- { confidence, unsupported_claims: [], missing_keywords: [] }
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index if not exists idx_applications_candidate on applications (candidate_id);
create index if not exists idx_applications_status on applications (status);
-- The query the worker actually runs on every poll — cleared, unclaimed, generated:
create index if not exists idx_applications_claimable
  on applications (status, created_at)
  where status = 'Generated';

create table if not exists review_queue (
  task_id        text primary key,         -- TaskID
  created_at     timestamptz not null,
  type           text,                     -- CV / CoverLetter
  candidate_id   text not null,
  job_id         text,
  ref_id         text,
  summary        text,
  ai_score       numeric,
  ai_findings    jsonb,
  status         text,                     -- Awaiting Human / Decided
  reviewer       text,
  decided_at     timestamptz,
  decision       text,                     -- approve / revise
  notes          text,
  synced_at      timestamptz not null default now()
);
create index if not exists idx_review_queue_candidate on review_queue (candidate_id);
create index if not exists idx_review_queue_status on review_queue (status);

create table if not exists activity_log (
  id           bigserial primary key,
  actor        text,                       -- matches logActivity(actor, ...)
  action       text not null,
  entity_type  text,
  entity_id    text,
  details      text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_activity_entity on activity_log (entity_type, entity_id);
create index if not exists idx_activity_created_at on activity_log (created_at);

-- Claiming a cleared application atomically — this replaces the whole
-- LockService + manual timeout dance from the Apps Script patch:
--
--   update applications
--   set status = 'Claiming', claimed_by = $1, claimed_at = now()
--   where application_id = (
--     select application_id from applications
--     where status = 'Generated'
--       and (ai_findings->'unsupported_claims') = '[]'::jsonb
--       and (ai_findings->>'confidence')::numeric >= 0.8
--     order by created_at
--     for update skip locked
--     limit 1
--   )
--   returning *;
--
-- Stale-claim release (run this on a short timer, e.g. every minute):
--
--   update applications set status = 'Generated', claimed_by = null, claimed_at = null
--   where status = 'Claiming' and claimed_at < now() - interval '10 minutes';
