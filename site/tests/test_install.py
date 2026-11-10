"""Standalone installer ownership tests; Docker and user crontab are mocked."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class InstallerOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.directory = self.root / "connect"
        self.directory.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.cron = self.root / "crontab"
        self.cron.write_text("")
        self.log = self.root / "docker.log"
        self.log.write_text("")
        self.env = dict(os.environ, TEST_CRON=str(self.cron), TEST_DOCKER_LOG=str(self.log),
                        PATH=str(self.bin) + os.pathsep + os.environ["PATH"])
        self.script = Path(__file__).resolve().parents[1] / "install.sh"
        self.mock("docker", '''printf '%s\\n' "$*" >> "$TEST_DOCKER_LOG"
if [ "$1" = logs ]; then echo 'robot paired'; fi
''')
        self.mock("crontab", '''case "$1" in
-l) cat "$TEST_CRON" ;;
-) cat > "$TEST_CRON" ;;
-r) : > "$TEST_CRON" ;;
*) exit 1 ;;
esac
''')

    def mock(self, name, body):
        path = self.bin / name
        path.write_text("#!/bin/sh\nset -eu\n" + body)
        path.chmod(0o755)

    def run_installer(self, *args, success=True):
        result = subprocess.run(["sh", str(self.script), "--dir", str(self.directory), *args],
                                env=self.env, cwd=self.root, text=True, capture_output=True, timeout=10)
        if success:
            self.assertEqual(0, result.returncode, result.stderr + result.stdout)
        else:
            self.assertNotEqual(0, result.returncode)
        return result

    def seed(self):
        (self.directory / "compose.yaml").write_text("name: mowgli-connect\nservices: {}\n")
        (self.directory / ".env").write_text(
            "MC_RELAY_URL='https://custom.example'\nMC_ROBOT_NAME='My robot'\n"
            "MC_IMAGE='ghcr.io/liltaket/mowgli-connect-agent:approved'\n"
            "MC_ALLOW_TELEOP=false\nMC_CUSTOM='keep-me'\n")

    def test_rerun_preserves_config_and_unrelated_values(self):
        self.seed()
        self.run_installer("--yes", "--auto-update", "no", "--dns", "system")
        settings = (self.directory / ".env").read_text()
        self.assertIn("MC_RELAY_URL='https://custom.example'", settings)
        self.assertIn("MC_IMAGE='ghcr.io/liltaket/mowgli-connect-agent:approved'", settings)
        self.assertIn("MC_ROBOT_NAME='My robot'", settings)
        self.assertIn("MC_CUSTOM='keep-me'", settings)
        self.assertEqual(0o600, (self.directory / ".env").stat().st_mode & 0o777)

    def test_explicit_options_replace_only_requested_settings(self):
        self.seed()
        self.run_installer("--yes", "--relay", "https://other.example", "--name", "new-name",
                           "--auto-update", "no", "--dns", "system")
        settings = (self.directory / ".env").read_text()
        self.assertIn("MC_RELAY_URL='https://other.example'", settings)
        self.assertIn("MC_ROBOT_NAME='new-name'", settings)
        self.assertIn("MC_IMAGE='ghcr.io/liltaket/mowgli-connect-agent:approved'", settings)

    def test_uninstall_removes_own_legacy_and_current_cron_without_purge(self):
        self.seed()
        other = "8 3 * * * cd '/other/robot' && docker compose up -d # mowgli-connect auto-update /other/robot\n"
        own = f"9 3 * * * cd '{self.directory}' && docker compose up -d # mowgli-connect auto-update\n"
        self.cron.write_text(other + own)
        self.run_installer("--uninstall")
        self.assertEqual(other, self.cron.read_text())
        self.assertNotIn("--volumes", self.log.read_text())
        self.assertTrue((self.directory / ".env").exists())
        self.cron.write_text(other + own.rstrip() + " " + str(self.directory) + "\n")
        self.run_installer("--uninstall")
        self.assertEqual(other, self.cron.read_text())

    def test_purge_is_explicit_and_only_valid_for_uninstall(self):
        self.seed()
        self.run_installer("--purge", success=False)
        self.assertEqual("", self.log.read_text())
        self.run_installer("--uninstall", "--purge")
        self.assertIn("down --volumes", self.log.read_text())

    def test_legacy_disabled_updates_stay_disabled_on_rerun(self):
        self.seed()
        self.run_installer("--yes")
        self.assertEqual("", self.cron.read_text())
        self.assertIn("MC_AUTO_UPDATE=no", (self.directory / ".env").read_text())

    def test_relative_directory_preserves_legacy_enabled_updates(self):
        self.seed()
        self.cron.write_text(f"9 3 * * * cd '{self.directory}' && docker compose up -d # mowgli-connect auto-update\n")
        self.run_installer("--yes", "--dir", "./connect")
        self.assertIn("MC_AUTO_UPDATE=yes", (self.directory / ".env").read_text())
        self.assertIn(f"# mowgli-connect auto-update {self.directory}", self.cron.read_text())

    def test_saved_values_are_never_executed_as_shell(self):
        self.seed()
        marker = self.root / "executed"
        (self.directory / ".env").write_text(f"MC_ROBOT_NAME='$(touch {marker})'\n")
        self.run_installer("--yes", "--auto-update", "no", "--dns", "system", success=False)
        self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
