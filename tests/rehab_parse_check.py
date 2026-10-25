"""scrBestRehab picks the whole-job estimate, not a line item. Runs the real screener.js in headless Chrome. Usage: python rehab_parse_check.py [real_answer.json ...]"""
import functools, glob, http.server, json, os, sys, threading
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLES = {
 "headline then items (the reported bug)": ("Rough estimate: $30,000 – $45,000 for a typical light-to-moderate fix and flip.\nBreakdown:\nKitchen refresh (estimated cost): $8,000 to $12,000\nFlooring: $4,000 to $7,000\nInterior and exterior paint: $5,000 to $8,000\nHVAC service or replacement: $5,000 to $9,000", (30000, 45000)),
 "items first, then headline": ("Kitchen refresh: $10,000 to $15,000\nBathroom update: $5,000 to $8,000\nOverall, expect a rough estimate of $30,000 to $45,000 for the whole project.", (30000, 45000)),
 "k suffix": ("Ballpark total repair budget: $30K to $45K\nKitchen refresh: $10K to $15K", (30000, 45000)),
 "total row wins": ("Category | Estimated Cost\nKitchen refresh | $10,000 to $15,000\nRoof | $8,000 to $12,000\nTotal | $30,000 to $45,000", (30000, 45000)),
 "rates are ignored": ("At $15 to $25 per sq ft on 1,500 sq ft the work is $22,500 to $37,500 in total.", (22500, 37500)),
}
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Q, directory=ROOT)); threading.Thread(target=srv.serve_forever, daemon=True).start()
real = []
for f in sys.argv[1:] or glob.glob(os.path.expanduser("~/.clipper_agent/runs/*.json")):
    try:
        d = json.load(open(f)); v = d.get("vars") or {}
    except Exception:
        continue
    for k, x in v.items():
        if isinstance(x, str) and len(x) > 1500 and "rehab_text" in k:
            real.append((os.path.basename(f), x))
bad = 0
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True); pg = b.new_page()
    pg.route("https://script.google.com/**", lambda r: r.fulfill(status=200, content_type="application/json", headers={"access-control-allow-origin": "*"}, body='{"ok":true}'))
    pg.goto(f"http://127.0.0.1:{srv.server_address[1]}/index.html")
    for name, (text, want) in SAMPLES.items():
        r = pg.evaluate("t => scrBestRehab(t)", text)
        ok = r and (r["low"], r["high"]) == want
        bad += not ok; print("PASS" if ok else "FAIL", name, (r or {}).get("low"), (r or {}).get("high"))
    seen = set()
    for fn, text in real:
        if text in seen: continue
        seen.add(text)
        r = pg.evaluate("t => scrBestRehab(t)", text)
        print("real answer", fn, "->", (r or {}).get("low"), (r or {}).get("high"), "|", (r or {}).get("ctx", "")[-80:])
    b.close()
print(bad, "failed")
sys.exit(1 if bad else 0)
