#!/usr/bin/env python3
"""Exercise the host/default configs with fake sites in a NEW network namespace."""

import http.client
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import time


def request(host, path="/", *, ipv6=False):
    connection = http.client.HTTPConnection("::1" if ipv6 else "127.0.0.1", 80, timeout=3)
    try:
        connection.request("GET", path, headers={"Host": host})
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


def tls_request(context, sni, host="shop.test"):
    with socket.create_connection(("127.0.0.1", 443), timeout=3) as raw:
        with context.wrap_socket(raw, server_hostname=sni) as secured:
            secured.sendall(f"GET / HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n".encode())
            chunks = []
            while data := secured.recv(16384):
                chunks.append(data)
            return b"".join(chunks)


def main():
    if os.geteuid() != 0:
        raise SystemExit("Run as root on Linux; the live nginx is never signalled.")
    if sys.argv[1:] != ["--isolated"]:
        subprocess.run(
            ["unshare", "--net", sys.executable, str(Path(__file__).resolve()), "--isolated"],
            check=True, timeout=45,
        )
        return
    if os.readlink("/proc/self/ns/net") == os.readlink("/proc/1/ns/net"):
        raise SystemExit("Refusing to run in PID 1's network namespace.")
    subprocess.run(["ip", "link", "set", "lo", "up"], check=True, timeout=5)
    nginx = shutil.which("nginx")
    if not nginx:
        raise SystemExit("nginx is required")
    source = Path(__file__).resolve().parent
    main_config = (source / "nginx.conf").read_text()
    deny_config = (source / "00-karcher-default-deny.conf").read_text()
    assert not any(term in main_config for term in ["/vhosts/", "/vhosts-includes/", "127.0.0.1:8080"])
    assert "client_max_body_size 128m;" in main_config
    with tempfile.TemporaryDirectory(prefix="karcher-nginx-test-") as directory:
        root = Path(directory)
        # Separate config tree, logs, temp paths and PID; no live files are edited.
        for name in ["conf.d", "sites-enabled", "modules-enabled", "body", "proxy", "fastcgi", "uwsgi", "scgi"]:
            (root / name).mkdir()
        shutil.copyfile("/etc/nginx/mime.types", root / "mime.types")
        config = main_config.replace("/etc/nginx/", str(root) + "/")
        config = config.replace("/run/nginx.pid", str(root / "nginx.pid"))
        config = config.replace("/var/log/nginx/", str(root) + "/")
        # Do not depend on the binary's compiled default account: an extracted
        # nginx.org package may name a user its preinst has not created yet.
        config = re.sub(r"^user .*;\n", "user www-data;\n", config, flags=re.MULTILINE)
        config = config.replace("worker_processes auto;", "worker_processes 1;")
        config = config.replace("http {", "http {\n" + "\n".join(
            f"    {directive} {root / folder};" for directive, folder in [
                ("client_body_temp_path", "body"), ("proxy_temp_path", "proxy"),
                ("fastcgi_temp_path", "fastcgi"), ("uwsgi_temp_path", "uwsgi"),
                ("scgi_temp_path", "scgi"),
            ]) + "\n")
        (root / "nginx.conf").write_text(config)
        (root / "conf.d/00-karcher-default-deny.conf").write_text(deny_config)
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            "-subj", "/CN=shop.test", "-addext", "subjectAltName=DNS:shop.test",
            "-keyout", str(root / "key.pem"), "-out", str(root / "cert.pem"),
        ], check=True, capture_output=True, timeout=10)
        (root / "sites-enabled/shop.conf").write_text(f"""
server {{
    listen 80;
    server_name shop.test;
    location /.well-known/acme-challenge/ {{ return 200 'test-challenge'; }}
    location / {{ return 301 https://shop.test$request_uri; }}
}}
server {{
    listen 443 ssl;
    server_name shop.test;
    ssl_certificate {root / 'cert.pem'};
    ssl_certificate_key {root / 'key.pem'};
    location / {{ return 200 'shop-only'; }}
}}
""")
        command = [nginx, "-p", str(root) + "/", "-c", str(root / "nginx.conf")]
        subprocess.run(command + ["-t"], check=True, capture_output=True, timeout=5)
        process = subprocess.Popen(command + ["-g", "daemon off;"], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 5
            while True:
                if process.poll() is not None:
                    raise RuntimeError(process.stderr.read().decode())
                try:
                    request("unknown.test")
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(0.05)
            for host in ["unknown.test", "127.0.0.1", "localhost"]:
                assert request(host)[0] == 404
                assert request(host, ipv6=True)[0] == 404
            assert request("shop.test")[0] == 301
            assert request("shop.test", "/.well-known/acme-challenge/test") == (200, b"test-challenge")
            context = ssl.create_default_context(cafile=str(root / "cert.pem"))
            assert b"shop-only" in tls_request(context, "shop.test")
            assert b"404 Not Found" in tls_request(context, "shop.test", "unknown.test")
            context.check_hostname = False
            for sni in ["unknown.test", None]:
                try:
                    tls_request(context, sni)
                except ssl.SSLError as error:
                    assert "UNRECOGNIZED_NAME" in str(error), str(error)
                else:
                    raise AssertionError("Unknown/missing SNI accepted")
            # Exercise graceful reload without ever using the live PID file.
            site = root / "sites-enabled/shop.conf"
            site.write_text(site.read_text().replace("shop-only", "shop-after-reload"))
            process.send_signal(signal.SIGHUP)
            deadline = time.monotonic() + 5
            while b"shop-after-reload" not in tls_request(context, "shop.test"):
                if time.monotonic() >= deadline:
                    raise AssertionError("New workers did not load the updated site")
                time.sleep(0.05)
            assert request("unknown.test")[0] == 404
        finally:
            if process.poll() is None:
                process.send_signal(signal.SIGQUIT)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            process.stderr.close()
        assert process.returncode == 0
    print("PASS: isolated syntax, HTTP IPv4/IPv6 default denial, shop routing, ACME path, TLS SNI/Host isolation and reload")


if __name__ == "__main__":
    main()
