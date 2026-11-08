-- When a robot was claimed, and when its tunnel was first seen connected (NULL = not yet), so the
-- relay can tell "setting up for the first time" from "offline".
ALTER TABLE robots ADD COLUMN claimed_at INTEGER;
ALTER TABLE robots ADD COLUMN first_online_at INTEGER;
