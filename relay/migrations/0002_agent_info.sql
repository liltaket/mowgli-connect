-- What the robot's agent reports about itself (MC-Agent header), for display only.
ALTER TABLE robots ADD COLUMN agent_version TEXT;
ALTER TABLE robots ADD COLUMN allow_teleop INTEGER; -- 1 on, 0 off, NULL unknown
