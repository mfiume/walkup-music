#!/usr/bin/env python3
"""Serve the project on http://localhost:8765/ with Cache-Control: no-store
on every response, so browser caching can't mask new code while iterating."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os

PORT = 8765
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Quieter logs
        if "404" in (fmt % args):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    os.chdir(ROOT)
    print(f"Serving {ROOT} on http://localhost:{PORT}/  (no-cache)")
    ThreadingHTTPServer(("", PORT), NoCacheHandler).serve_forever()
