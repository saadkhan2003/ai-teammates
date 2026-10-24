"""Pure, ordered IPv4 firewall policy shared by installer and guard."""
import ipaddress
import os

DEFAULT_DNS = "1.1.1.1,8.8.8.8"
# A host can run several stacks (one compose project each); each gets its own subnet and chain.
# Defaults are the main stack's values.
SUBNET = os.environ.get("ISOLATION_SUBNET", "172.30.28")
CHAIN = os.environ.get("ISOLATION_CHAIN", "TEAMS-ISO")


def resolvers(raw=None):
    raw = os.environ.get("COMPUTER_DNS", DEFAULT_DNS) if raw is None else raw
    values = raw.split(",")
    if not values or any(not part.strip() for part in values):
        raise ValueError("COMPUTER_DNS requires comma-separated IPv4 addresses")
    # The computers bridge is IPv4-only. Reject names, CIDRs and IPv6 explicitly.
    return list(dict.fromkeys(str(ipaddress.IPv4Address(part.strip())) for part in values))


def rules(raw=None):
    result = [
        ["-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-j", "RETURN"],
        ["-s", SUBNET + ".10/32", "-j", "RETURN"],
        ["-s", SUBNET + ".11/32", "-j", "RETURN"],
        ["-s", SUBNET + ".0/24", "-d", SUBNET + ".10/32", "-p", "tcp", "-m", "tcp", "--dport", "8080", "-j", "RETURN"],
    ]
    # Embedded DNS is container-local; this exception never routes loopback off-host.
    for address in dict.fromkeys([*resolvers(raw), "127.0.0.11"]):
        for protocol in ("udp", "tcp"):
            result.append(["-s", SUBNET + ".0/24", "-d", address + "/32", "-p", protocol,
                           "-m", protocol, "--dport", "53", "-j", "RETURN"])
    # The computer's egress proxy and relay tunnel are root-owned and authenticate to the API's
    # bearer-protected /internal routes on this one port. Bot uids stay blocked by the per-bot
    # nftables policy inside the computer, which only allows loopback and the egress proxy.
    for dest in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"):
        result.append(["-s", SUBNET + ".0/24", "-d", dest, "-p", "tcp", "-j", "REJECT", "--reject-with", "tcp-reset"])
        result.append(["-s", SUBNET + ".0/24", "-d", dest, "-p", "udp", "-j", "DROP"])
        result.append(["-s", SUBNET + ".0/24", "-d", dest, "-j", "DROP"])
    result.append(["-j", "RETURN"])
    return result


if __name__ == "__main__":
    import subprocess
    import sys
    policy = rules()  # Validate before mutating the firewall.
    ipt = sys.argv[1]
    subprocess.run([ipt, "-N", CHAIN], check=False, stderr=subprocess.DEVNULL)
    subprocess.check_call([ipt, "-F", CHAIN])
    for rule in policy:
        subprocess.check_call([ipt, "-A", CHAIN, *rule])
    if subprocess.run([ipt, "-C", "DOCKER-USER", "-j", CHAIN], stderr=subprocess.DEVNULL).returncode:
        subprocess.check_call([ipt, "-I", "DOCKER-USER", "1", "-j", CHAIN])
