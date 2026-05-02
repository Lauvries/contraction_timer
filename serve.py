#!/usr/bin/env python3
"""Serve this app from its own folder (works even if you run from elsewhere)."""
import http.server
import os
import socket
import socketserver
import sys

PORT = int(os.environ.get("PORT", "8080"))
HERE = os.path.dirname(os.path.abspath(__file__))


def local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0)
        s.connect(("10.254.254.254", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return None


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=HERE, **kwargs)


def main():
    ip = local_ip()
    print("Contraction timer — open in your browser:")
    print(f"  On this computer:  http://127.0.0.1:{PORT}/")
    if ip:
        print(f"  On your phone:     http://{ip}:{PORT}/")
    print("Press Ctrl+C to stop.\n")
    socketserver.TCPServer.allow_reuse_address = True
    try:
        with socketserver.TCPServer(("0.0.0.0", PORT), Handler) as httpd:
            httpd.serve_forever()
    except OSError as e:
        if e.errno == 48 or e.errno == 98:  # Address already in use (mac / linux)
            print(f"Port {PORT} is already in use. Try: PORT=8765 python3 serve.py", file=sys.stderr)
        else:
            print(e, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
