"""Standalone installer ownership tests; Docker and user crontab are mocked."""
import os
from pathlib import Path
import subprocess
import shutil
import tempfile
import unittest

STUBS = Path(__file__).resolve().parents[2] / "test" / "installer" / "stubs"
DIGEST = "sha256:" + "0" * 63 + "1"
SAN = "https://github.com/liltaket/mowgli-connect/.github/workflows/agent-image.yml@refs/heads/main"
ISSUER = "https://token.actions.githubusercontent.com"


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
        # The fake docker and cosign of test/installer: the official image is verified, never skipped.
        self.fake = self.root / "fake"
        self.fake.mkdir()
        self.log = self.fake / "calls"
        self.log.write_text("")
        self.env = dict(os.environ, TEST_CRON=str(self.cron), FAKE=str(self.fake), FAKE_COSIGN=str(STUBS / "fake-cosign"),
                        MC_UPDATE_HEALTH_TIMEOUT="2", MC_UPDATE_HEALTH_SETTLE="0", MC_UPDATE_HEALTH_INTERVAL="1",
                        PATH=str(self.bin) + os.pathsep + os.environ["PATH"])
        self.script = Path(__file__).resolve().parents[1] / "install.sh"
        for name in ("docker", "fake-cosign", "logger"):
            shutil.copy(STUBS / name, self.bin / name)
        (self.fake / "tag.latest").write_text(DIGEST + "\n")
        (self.fake / f"sig.{DIGEST}").write_text(f"{SAN} {ISSUER} liltaket/mowgli-connect\n")
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

    def run_installer(self, *args, success=True, verified=False):
        # These tests are about settings and cron ownership. The saved custom image runs
        # unverified, as an owner may choose; verified=True installs the official signed image.
        verify = [] if verified or {"--uninstall", "--purge"} & set(args) else ["--insecure-skip-verify"]
        result = subprocess.run(["sh", str(self.script), "--dir", str(self.directory), *verify, *args],
                                env=self.env, cwd=self.root, text=True, capture_output=True, timeout=10)
        if success:
            self.assertEqual(0, result.returncode, result.stderr + result.stdout)
        else:
            self.assertNotEqual(0, result.returncode)
        return result

    def seed(self, image="ghcr.io/example/custom-agent:approved"):
        (self.directory / "compose.yaml").write_text("name: mowgli-connect\nservices: {}\n")
        (self.directory / ".env").write_text(
            "MC_RELAY_URL='https://custom.example'\nMC_ROBOT_NAME='My robot'\n"
            f"MC_IMAGE='{image}'\n"
            "MC_ALLOW_TELEOP=false\nMC_CUSTOM='keep-me'\n")

    def test_rerun_preserves_config_and_unrelated_values(self):
        self.seed()
        self.run_installer("--yes", "--auto-update", "no", "--dns", "system")
        settings = (self.directory / ".env").read_text()
        self.assertIn("MC_RELAY_URL='https://custom.example'", settings)
        self.assertIn("MC_IMAGE='ghcr.io/example/custom-agent:approved'", settings)
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
        self.assertIn("MC_IMAGE='ghcr.io/example/custom-agent:approved'", settings)

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
        self.seed(image="")  # the official, verified image (a custom one is never updated automatically)
        self.cron.write_text(f"9 3 * * * cd '{self.directory}' && docker compose up -d # mowgli-connect auto-update\n")
        self.run_installer("--yes", "--dir", "./connect", verified=True)
        self.assertIn("MC_AUTO_UPDATE=yes", (self.directory / ".env").read_text())
        self.assertIn(f"# mowgli-connect auto-update {self.directory}", self.cron.read_text())

    def test_compose_settings_in_dotenv_are_not_carried_over(self):
        self.seed()
        with (self.directory / ".env").open("a") as f:
            f.write("COMPOSE_FILE=/elsewhere/compose.yaml\nCOMPOSE_PROJECT_NAME=other\n")
        self.run_installer("--yes", "--auto-update", "no", "--dns", "system")
        settings = (self.directory / ".env").read_text()
        self.assertNotIn("COMPOSE_", settings)
        self.assertIn("MC_CUSTOM='keep-me'", settings)

    def test_saved_auto_update_does_not_block_an_unverified_custom_image(self):
        self.seed()
        with (self.directory / ".env").open("a") as f:
            f.write("MC_AUTO_UPDATE=yes\n")
        self.run_installer("--yes", "--dns", "system")
        self.assertIn("MC_AUTO_UPDATE=no", (self.directory / ".env").read_text())
        # An explicit request for both is still refused.
        self.run_installer("--yes", "--dns", "system", "--auto-update", "yes", success=False)

    def test_uninstall_works_before_any_image_was_verified(self):
        self.seed(image="")
        self.run_installer("--uninstall")
        self.assertIn(" down", self.log.read_text())

    def test_saved_values_are_never_executed_as_shell(self):
        self.seed()
        marker = self.root / "executed"
        (self.directory / ".env").write_text(f"MC_ROBOT_NAME='$(touch {marker})'\n")
        self.run_installer("--yes", "--auto-update", "no", "--dns", "system", success=False)
        self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
