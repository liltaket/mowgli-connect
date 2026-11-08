-- Fewer D1 row writes per robot poll (the Free plan allows 100,000 a day). A WITHOUT ROWID table
-- keeps the replay records in one b-tree, so recording a jti writes one row instead of three
-- (table, primary-key index, expiry index). Records live 90 seconds, so the table stays small and
-- the cron's expiry sweep needs no index.
CREATE TABLE jti_seen_lean (
  robot_id   TEXT NOT NULL,
  jti        TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (robot_id, jti)
) WITHOUT ROWID;
-- Keep the records still in their 90-second window, so no assertion can be replayed across this.
INSERT INTO jti_seen_lean (robot_id, jti, expires_at) SELECT robot_id, jti, expires_at FROM jti_seen;
DROP TABLE jti_seen;
ALTER TABLE jti_seen_lean RENAME TO jti_seen;
