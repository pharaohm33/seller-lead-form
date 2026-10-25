"""The screener's 'add ONE listing by pasting its page' box: paste a Redfin-style page, check the row, the contact prefill and that the Pre-LOI flow carries on.
Needs Python with playwright + Chrome (e.g. the browser-agent project's .venv)."""
import functools, http.server, json, pathlib, threading
from playwright.sync_api import sync_playwright

ROOT = str(pathlib.Path(__file__).resolve().parent.parent)
TEXT = """3021 W Vande Loo St, Tucson, AZ 85746
$325,000 Est. $2,243/mo
3 beds 2 baths 1,496 sq ft
Status For sale
261 days on Redfin
Year Built 1978
Property Type Single Family Residential
Listed by John Low
Contact: 520-409-5590
johnlow.realtor@gmail.com
"""
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=ROOT)); threading.Thread(target=srv.serve_forever, daemon=True).start()
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True); page = b.new_page(viewport={"width": 1300, "height": 900})
    page.route("https://script.google.com/**", lambda r, q: r.fulfill(status=200, content_type="application/json", headers={"access-control-allow-origin": "*"}, body=json.dumps({"ok": True, "token": "t", "leads": [], "entries": []})))
    page.add_init_script("sessionStorage.setItem('adminToken','tok');")
    page.goto(f"http://127.0.0.1:{srv.server_address[1]}/index.html"); page.click("#admin-access-btn"); page.click("#admin-tab-preloi")
    page.fill("#scr-paste-listing", TEXT); page.fill("#scr-paste-url", "https://www.redfin.com/AZ/Tucson/3021-W-Vande-Loo-St-85746/home/50511800"); page.click("#scr-paste-add")
    print("message:", page.inner_text("#scr-paste-msg"))
    row = page.evaluate("SCR.rows[0]"); print({k: row[k] for k in ("street", "city", "state", "zip", "price", "beds", "baths", "sqft", "year", "dom", "agentName", "agentPhone", "agentEmail")})
    page.wait_for_selector("[data-scr-prep]"); page.click("[data-scr-prep]")
    print("contact prefilled:", page.input_value("#scr-c-name"), page.input_value("#scr-c-phone"), page.input_value("#scr-c-email"))
    print("table row:", page.inner_text("#scr-results tbody tr").replace("\n", " | ")[:140])
    b.close()
