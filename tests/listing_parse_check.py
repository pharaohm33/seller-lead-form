"""parseListingText must read the SUBJECT home's beds/baths/sqft even when the page text lists other homes' stats first (real Redfin page texts saved as fixtures)."""
import functools, http.server, json, os, sys, threading
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CASES = [("redfin_5211_e_20th.txt", {"beds": "3", "baths": "2", "sqft": "1798", "street": "5211 E 20th St", "price": "294000", "assetType": "Residential Property (1-4 units)"}),
         ("redfin_3021_w_vande_loo.txt", {"beds": "3", "baths": "2", "sqft": "1496", "street": "3021 W Vande Loo St", "price": "325000", "assetType": "Residential Property (1-4 units)"})]
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Q, directory=ROOT)); threading.Thread(target=srv.serve_forever, daemon=True).start()
bad = 0
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True); pg = b.new_page()
    pg.route("https://script.google.com/**", lambda r: r.fulfill(status=200, content_type="application/json", headers={"access-control-allow-origin": "*"}, body='{"ok":true}'))
    pg.goto(f"http://127.0.0.1:{srv.server_address[1]}/index.html"); pg.wait_for_timeout(1200)
    for fn, want in CASES:
        path = os.path.join(ROOT, "tests", "fixtures", fn)
        if not os.path.exists(path): print("SKIP", fn); continue
        r = pg.evaluate("t => parseListingText(t)", open(path).read())
        ok = all(str(r.get(k)) == v for k, v in want.items()); bad += not ok
        print("PASS" if ok else "FAIL", fn, {k: r.get(k) for k in want})
    r = pg.evaluate("t => parseListingText(t)", "Buy\n3 bd 2 ba 828 sq ft 3720 E Monte Vista Dr, Tucson, AZ 85716\n$250,000")
    ok = r.get("street") == "3720 E Monte Vista Dr" and r.get("zip") == "85716"; bad += not ok
    print("PASS" if ok else "FAIL", "street after a sq ft figure", r.get("street"), r.get("zip"))
    b.close()
print(bad, "failed"); sys.exit(1 if bad else 0)
