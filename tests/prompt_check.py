"""The Google AI prompts tell it to write the answer itself (not 'Here are top web results'), still fit a URL, and the echoed question does not confuse the parsers.   Run:  python tests/prompt_check.py"""
import functools, http.server, os, threading
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Q, directory=ROOT)); threading.Thread(target=srv.serve_forever, daemon=True).start()
bad = 0
def check(name, ok, extra=""):
    global bad; bad += not ok; print("PASS" if ok else "FAIL", name, extra)
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True); pg = b.new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.route("https://script.google.com/**", lambda r: r.fulfill(status=200, content_type="application/json", headers={"access-control-allow-origin": "*"}, body='{"ok":true}'))
    pg.goto(f"http://127.0.0.1:{srv.server_address[1]}/index.html"); pg.wait_for_timeout(1200)
    r = pg.evaluate("""() => { SCR.cfg.asset = 'sf'; const d = { street: '1 A St', city: 'Tucson', state: 'AZ', zip: '85701', beds: 3, baths: 2, sqft: 1500, address: '1 A St, Tucson, AZ 85701', url: 'https://www.redfin.com/AZ/Tucson/1-A-St-85701/home/1' };
      const c = scrCompsPrompt(d), h = scrRehabPrompt(d, 300000); const echo = h + '\\nRough estimate: $30,000 to $45,000 for the whole job.\\nKitchen refresh: $10,000 to $15,000';
      return { c, h, cEnc: encodeURIComponent(c).length, hEnc: encodeURIComponent(h).length, best: scrBestRehab(echo, 300000), base: compsPromptResidential('1 A St', 'x', '').length }; }""")
    check("comps prompt starts by asking for a written summary, not links or web results", r["c"].startswith("Write a summary of your findings in this chat, in your own words") and "Do not reply with links, a list of websites or web search results" in r["c"][:400])
    check("comps prompt keeps the machine-read summary block", "---COMPS SUMMARY---" in r["c"] and "ARV ESTIMATE:" in r["c"] and "---END SUMMARY---" in r["c"])
    check("comps prompt still fits a Google URL (under 7000 characters encoded)", r["cEnc"] < 7000, r["cEnc"])
    check("rehab prompt asks for a written summary, not links", r["h"].endswith("with no links and no list of websites or web results.") and "Write a summary of the estimate" in r["h"] and "how much fix and flip investor repair" in r["h"])
    check("the echoed rehab question (with the instruction) does not hide the real total", r["best"] and (r["best"]["low"], r["best"]["high"]) == (30000, 45000), r["best"])
    check("no script errors", not errs, errs)
print("FAILED" if bad else "ALL PASS"); raise SystemExit(bad)
