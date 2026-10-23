-- Right-size the default computer quota for a 4 GB / 2 vCPU host.
-- 640 MiB and 0.40 CPU. Rows still on the old 1.5 GiB / 1 CPU default move with it.
ALTER TABLE user_quotas ALTER COLUMN memory_bytes SET DEFAULT 671088640;
ALTER TABLE user_quotas ALTER COLUMN cpu_millis SET DEFAULT 400;
UPDATE user_quotas
SET memory_bytes = 671088640, cpu_millis = 400
WHERE memory_bytes = 1610612736 AND cpu_millis = 1000;
