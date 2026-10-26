"""Owner equity counts the mortgage balance against the LOWEST value known (Propwire's, the asking price, the comps ARV), not Propwire's own percentage, which rests on a valuation that can run far too high.
Run:  python tests/equity_check.py"""
import functools, http.server, pathlib, sys, threading
from playwright.sync_api import sync_playwright

SP = str(pathlib.Path(__file__).resolve().parent.parent)
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=SP)); threading.Thread(target=srv.serve_forever, daemon=True).start()
bad = 0
def check(name, ok, extra=""):
    global bad; bad += not ok; print("PASS" if ok else "FAIL", name, extra)
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True); pg = b.new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.route("https://script.google.com/**", lambda r: r.fulfill(status=200, content_type="application/json", headers={"access-control-allow-origin": "*"}, body='{"ok":true}'))
    pg.goto(f"http://127.0.0.1:{srv.server_address[1]}/index.html"); pg.wait_for_timeout(1200)
    info = lambda f, ref=None: pg.evaluate("([f, ref]) => scrEquityInfo(f, ref)", [f, ref or {}])
    # 6300 N Camino Miraval: Propwire says value $774,242, mortgage $214,991, 72% equity; asking $1,098,000; the comps ARV came back around $245,000
    pw = {"pwEquityPct": 72, "pwValue": 774242, "pwMortgage": 214991, "pwMortgageSet": True}
    r = info(pw, {"list": 1098000})
    check("before comps: the lowest known value is Propwire's, so about 72%", r and 71 < r["pct"] < 73 and r["valueLabel"] == "Propwire's value", r)
    r = info(pw, {"list": 1098000, "arv": 245000})
    check("after comps: the mortgage against the comps ARV leaves about 12%, not Propwire's 72%", r and 11 < r["pct"] < 13 and r["valueLabel"] == "comps ARV" and r["propwirePct"] == 72, r)
    r = info({"pwEquityPct": 90, "pwValue": 500000, "pwMortgage": 50000, "pwMortgageSet": True}, {"list": 300000})
    check("an asking price below Propwire's value is the reference (300,000 - 50,000)", r and abs(r["pct"] - 83.33) < 0.1 and r["valueLabel"] == "asking price", r)
    r = info({"pwEquityPct": 85, "pwValue": 400000}, {"list": 380000})
    check("no mortgage figure: Propwire's own percentage is used", r and r["pct"] == 85 and r["mortgage"] is None, r)
    r = info({"pwEquityPct": 100, "pwValue": 400000, "pwMortgage": 0, "pwMortgageSet": True}, {"list": 380000})
    check("a free-and-clear home (mortgage entered as 0) is 100%", r and r["pct"] == 100, r)
    check("nothing known: no equity figure", info({}) is None)
    q = pg.evaluate("""() => { SCR.cfg.minDom = 0; SCR.cfg.asset = 'sf'; SCR.cfg.strategy = 'flip';
      const d = { address: '6300 N Camino Miraval, Tucson, AZ 85718', street: '6300 N Camino Miraval', price: 1098000, sqft: 5439, dom: 300 };
      const p = scrPrice(d, { pwEquityPct: 72, pwValue: 774242, pwMortgage: 214991, pwMortgageSet: true, arvLow: 242212, arvHigh: 247712, rehabLow: 20000, rehabHigh: 30000, tier: 'moderate' });
      return { q: p.qualifies, why: p.why, eq: p.ownerEquityPct } }""")
    check("the offer does not qualify, and says why in terms of the mortgage", q["q"] is False and any("owner equity" in w and "mortgage" in w and "comps ARV" in w and "Propwire says 72%" in w for w in q["why"]), q["why"])
    check("no script errors", not errs, errs[:2]); b.close()
sys.exit(1 if bad else 0)
