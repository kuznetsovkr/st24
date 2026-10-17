#!/usr/bin/env python3
"""Root-only ruleset checks, confined to a NEW Linux network namespace."""

import json
import os
from pathlib import Path
import subprocess
import sys


def nft(*args, source=None):
    result = subprocess.run(
        ["/usr/sbin/nft", *args], input=source, capture_output=True,
        text=True, check=True, timeout=10,
    )
    return result.stdout


def main():
    if os.geteuid() != 0:
        raise SystemExit("Run as root on Linux; no live host firewall is changed.")
    if sys.argv[1:] != ["--isolated"]:
        subprocess.run(
            ["unshare", "--net", sys.executable, str(Path(__file__).resolve()), "--isolated"],
            check=True, timeout=40,
        )
        return
    if os.readlink("/proc/self/ns/net") == os.readlink("/proc/1/ns/net"):
        raise SystemExit("Refusing to run firewall tests in PID 1's network namespace.")

    source = Path(__file__).with_name("inbound.nft").read_text()
    assert "flush ruleset" not in "\n".join(
        line for line in source.splitlines() if not line.lstrip().startswith("#")
    )
    nft("--file", "-", source="""
table ip existing_owner {
    chain input {
        type filter hook input priority 0; policy accept;
        tcp dport 1501 accept
    }
}
""")
    previous = json.loads(nft("--json", "list", "table", "ip", "existing_owner"))
    nft("--check", "--file", "-", source=source)
    nft("--file", "-", source=source)
    state = json.loads(nft("--json", "list", "table", "inet", "karcher_ingress"))
    chains = [item["chain"] for item in state["nftables"] if "chain" in item]
    assert len(chains) == 1
    assert chains[0]["family"] == "inet"
    assert chains[0]["hook"] == "input"
    assert chains[0]["prio"] == -10
    assert chains[0]["policy"] == "drop"
    rules = [item["rule"] for item in state["nftables"] if "rule" in item]
    port_sets = [
        expression["match"]["right"]["set"]
        for rule in rules for expression in rule["expr"]
        if isinstance(expression.get("match", {}).get("right"), dict)
        and "set" in expression["match"]["right"]
        and expression["match"].get("left", {}).get("payload", {}).get("field") == "dport"
    ]
    assert port_sets == [[22, 80, 443]]
    assert rules[-1]["expr"][-1] == {"drop": None}
    assert json.loads(nft("--json", "list", "table", "ip", "existing_owner")) == previous

    nft("--file", "-", source="delete table inet karcher_ingress\n" + source)
    reloaded = json.loads(nft("--json", "list", "table", "inet", "karcher_ingress"))
    assert sum("rule" in item for item in reloaded["nftables"]) == len(rules)
    nft("delete", "table", "inet", "karcher_ingress")
    assert json.loads(nft("--json", "list", "table", "ip", "existing_owner")) == previous
    print("PASS: isolated syntax, inet/default-deny/priority, exact ports, atomic reload, foreign-table preservation and scoped rollback")


if __name__ == "__main__":
    main()
