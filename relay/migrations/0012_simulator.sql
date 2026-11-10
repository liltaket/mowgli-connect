-- Whether the robot's agent says it is a simulator (MC-Agent "sim=1", MC_SIMULATOR on the robot).
-- Display only, like agent_version and allow_teleop: the robot's own claim, never used for access.
ALTER TABLE robots ADD COLUMN simulator INTEGER NOT NULL DEFAULT 0; -- 1 simulator, 0 not (or not said)
