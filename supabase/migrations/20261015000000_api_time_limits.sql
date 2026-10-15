-- Time limits for the API's database sessions (migration plan, phase 4).
--
-- Netlify cuts a function off after 30 seconds and answers with an HTML error
-- page, which the browser can only report as "the backend returned a
-- webpage". So nothing the API asks of the database may wait that long:
--
--   lock_timeout                          a statement waiting for a lock (the
--                                         audit log's turn-taking lock, a row
--                                         another request is changing) gives up
--   statement_timeout                     no single statement runs longer
--   idle_in_transaction_session_timeout   a transaction left open by a client
--                                         that vanished (a function stopped
--                                         mid-request) is rolled back, which
--                                         frees every lock it held
--
-- Each failure reaches the browser as an ordinary error reply. They apply to
-- every new session portal_api opens; the import connects as the owner and is
-- not affected.

alter role portal_api set lock_timeout = '5s';
alter role portal_api set statement_timeout = '15s';
alter role portal_api set idle_in_transaction_session_timeout = '10s';
