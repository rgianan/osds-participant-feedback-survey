-- Migration plan, phase 2: the certificate worker.
--
-- A job whose run dies (Apps Script stops every run at 6 minutes) is taken
-- again once its 15-minute claim runs out. A job that kills its run EVERY
-- time, say a template so large it never finishes, would then be retried
-- forever and hold up the queue. After 5 claims that never reported back, it
-- is marked failed instead, with a reason an admin can act on; a retry from
-- the Certificates screen resets the count.

create or replace function portal.claim_certificate_jobs(batch_size integer default 10, lease interval default '15 minutes')
returns table (response_id bigint, claim_token uuid)
language plpgsql as $$
#variable_conflict use_column
begin
  update portal.responses
     set certificate_status = 'failed',
         certificate_error = 'Stopped after 5 attempts that never finished. Check the template and the Apps Script executions log, then retry.',
         claimed_at = null,
         claim_token = null
   where certificate_status = 'processing'
     and claimed_at < now() - lease
     and attempts >= 5;

  return query
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
end
$$;

revoke all on function portal.claim_certificate_jobs(integer, interval) from public;
grant execute on function portal.claim_certificate_jobs(integer, interval) to portal_api;
