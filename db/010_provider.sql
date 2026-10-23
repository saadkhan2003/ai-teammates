-- Priority fix: destructive file deletes join the outbound ledger so a re-lease cannot run them twice.

ALTER TABLE outbound_actions DROP CONSTRAINT IF EXISTS outbound_actions_kind_chk;
ALTER TABLE outbound_actions ADD CONSTRAINT outbound_actions_kind_chk CHECK (kind IN ('send','post','purchase','plugin_write','delete'));
