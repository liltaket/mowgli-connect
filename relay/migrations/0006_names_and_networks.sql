-- Released robot hostnames stay unavailable to other robots for a while (security review 10):
-- whatever a previous owner's robot served under a name, cached somewhere or registered as a
-- service worker in someone's browser, must not reach the next owner.
CREATE TABLE released_hostnames (
  hostname    TEXT PRIMARY KEY,
  robot_id    TEXT NOT NULL,   -- the robot that held it; it may take the name back
  released_at INTEGER NOT NULL
) WITHOUT ROWID;

-- A coarse, hashed network of the request that registered an unclaimed robot (IPv4 /24, IPv6
-- /48), so one network cannot use up the global hourly cap on new robots.
ALTER TABLE robots ADD COLUMN origin_net TEXT;
