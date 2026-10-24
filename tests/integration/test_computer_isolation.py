"""Docker-only I2 acceptance check; unit nftables assertions run offline."""
import os
import shutil
import socket
import pytest

pytestmark = pytest.mark.skipif(not os.getenv("RUN_DOCKER_ISOLATION_TESTS") or not shutil.which("docker"), reason="requires an explicitly enabled disposable Docker daemon")


def test_computer_a_cannot_connect_to_computer_b():
    # The deployment acceptance harness provisions two isolated computers and supplies their endpoints.
    host = os.getenv("ISOLATION_TEST_TARGET")
    assert host, "set ISOLATION_TEST_TARGET to computer B's disposable test endpoint"
    try:
        socket.create_connection((host, 8080), timeout=2)
    except OSError:
        return
    pytest.fail("computer A reached computer B directly")
