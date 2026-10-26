"""Buy & hold rules: the seller keeps 50% down (the solver never lowers it), no carryback offer when it cannot cash flow that way, and a single-family hold over $450,000 is skipped (it needs a cash offer).
Run:  python tests/hold_rules_check.py"""
import functools, http.server, json, pathlib, sys, threading
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
    run = lambda price, rent, strat="hold", arv=None, units=None: pg.evaluate("""([price, rent, strat, arv, units]) => { SCR.cfg.minDom = 0; SCR.cfg.asset = 'sf'; SCR.cfg.strategy = strat;
        const d = { address: '1 A St, Tucson, AZ 85701', street: '1 A St', price, sqft: 1500, dom: 300 }; if (units) d.units = units;
        const p = scrPrice(d, { pwEquityPct: 100, arvLow: arv || price * 1.15, arvHigh: arv || price * 1.15, rehabLow: 20000, rehabHigh: 30000, rentLtr: rent, tier: 'moderate' });
        return { ready: p.ready, q: p.qualifies, why: p.why, carry: p.carryOffer, down: p.carryDown, cf: p.holdPlan && p.holdPlan.cashflow } }""", [price, rent, strat, arv, units])
    r = run(330000, 3500)
    check("the seller keeps 50% down in a buy & hold", r["ready"] and r["down"] == round(r["carry"] * 0.5 / 500) * 500 or abs(r["down"] - r["carry"] * 0.5) <= 500, (r["carry"], r["down"]))
    r = run(500000, 6000)
    check("single-family hold over $450,000 is skipped (needs a cash offer)", r["q"] is False and any("needs a cash offer" in w for w in r["why"]), r["why"])
    r = run(449000, 6000)
    check("just under $450,000 is not skipped for the price", not any("needs a cash offer" in w for w in r["why"]), r["why"])
    r = run(330000, 800)
    check("no carryback when it cannot cash flow with 50% down", r["q"] is False and any("no seller carryback offer" in w for w in r["why"]), r["why"])
    r = run(13000000, 0, units=90, arv=14000000)
    check("the $450,000 rule is for single family only (a 90-unit building is not skipped for it)", not any("needs a cash offer" in w for w in r["why"]), r["why"])
    r = run(600000, 0, strat="flip", arv=900000)
    check("fix & flip over $450,000 is untouched", not any("cash offer" in w or "no seller carryback" in w for w in r["why"]), r["why"])
    check("no script errors", not errs, errs[:2]); b.close()
sys.exit(1 if bad else 0)
