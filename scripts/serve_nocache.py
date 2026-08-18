#!/usr/bin/env python3
"""Serve the project on http://localhost:8765/ with Cache-Control: no-store
on every response, so browser caching can't mask new code while iterating."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os

PORT = 8765
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# /music is the Sounds tab's old path, kept so an old bookmark still loads.
SPA_ROUTES = {"/lineup", "/roster", "/sounds", "/music", "/settings"}


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_GET(self):
        # Map SPA routes to index.html so direct hits / reloads work.
        # Strip query/fragment for the routing match.
        path = self.path.split("?", 1)[0].split("#", 1)[0].rstrip("/")
        if path in SPA_ROUTES:
            self.path = "/index.html"
        return super().do_GET()

    def log_message(self, fmt, *args):
        # Quieter logs
        if "404" in (fmt % args):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    os.chdir(ROOT)
    print(f"Serving {ROOT} on http://localhost:{PORT}/  (no-cache)")
    ThreadingHTTPServer(("", PORT), NoCacheHandler).serve_forever()
