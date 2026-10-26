"""LoopNet / Crexi listing text -> facts -> cap-rate value -> seller-carryback offer -> LOI link that the generator really turns into a multifamily LOI.
Run:  python tests/commercial_check.py   (needs the loi-generator repo next to this one, Python with playwright and Chrome)"""
import datetime, functools, http.server, json, os, pathlib, re, sys, threading
from playwright.sync_api import sync_playwright

SP = str(pathlib.Path(__file__).resolve().parent.parent)
LOI = open(os.environ.get("LOI_GENERATOR_HTML", SP + "/../loi-generator/index.html")).read()
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
    lp = open(SP + "/tests/fixtures/loopnet_bellevue_towers.txt").read(); cx = open(SP + "/tests/fixtures/crexi_grand_luxe_masked.txt").read()
    c = pg.evaluate("t => scrParseCommercial(t)", lp)
    check("LoopNet: price, cap rate, units, NOI from price x cap", (c["price"], c["capRate"], c["units"], c["noi"], c["noiSource"]) == (13000000, 6.9, 90, 897000, "price x cap rate"), c["noi"])
    check("LoopNet: address, type, year, contacts, brokerage", (c["address"], c["type"], c["yearBuilt"], c["contacts"], c["brokerage"]) == ("3710 E Bellevue St, Tucson, AZ 85716", "Multifamily", 1969, ["Allan Mendelsberg", "Joey Martinez"], "Cushman & Wakefield | PICOR"))
    check("LoopNet: description text is captured", "multifamily investment opportunity" in c["description"].lower() or "attractive value add" in c["description"].lower(), c["description"][:60])
    x = pg.evaluate("t => scrParseCommercial(t)", cx)
    check("Crexi signed out: the hidden cap rate / NOI / units stay empty (Google AI fills them)", (x["capRate"], x["noi"], x["units"]) == (0, 0, 0) and x["price"] == 5500000 and "LOI" not in " ".join(x["contacts"]) and "Newgen" in x["description"], x["description"][:60])
    r = pg.evaluate("t => { const x = scrCommercialPrice(scrParseCommercial(t), { capLow: 6.5, capHigh: 7.5 }); return { ready: x.ready, value: x.value, noi: x.noi, capMid: x.capMid, carry: x.p.carryOffer, down: x.p.carryDown, list: x.d.price, qual: x.p.qualifies, strat: x.p.strategy, loi: x.loi } }", lp)
    check("value = NOI / middle cap rate (897,000 / 7%)", r["ready"] and r["value"] == 12814000 and r["capMid"] == 7, r["value"])
    check("buy & hold seller carry, capped at the asking price, seller gets cash at closing", r["strat"] == "hold" and 0 < r["carry"] <= r["list"] and r["down"] >= 0.1 * r["carry"], (r["carry"], r["down"]))
    q = pg.evaluate("t => { const x = scrCommercialPrice(scrParseCommercial(t), { capLow: 6.5, capHigh: 7.5, equityPct: '' }); return { ready: x.ready, qualifies: x.p.qualifies, why: x.p.why, checked: x.equityChecked } }", lp)
    check("owner equity is assumed when there is none (commercial is not on Propwire): still qualifies", q["ready"] and q["qualifies"] and not q["checked"], q)
    check("no value without NOI or cap rate", pg.evaluate("() => scrCommercialPrice({ price: 1000000, noi: 0, capRate: 0 }, {}).ready") is False)
    want = (datetime.date.today() + datetime.timedelta(days=15)).isoformat()
    q = re.findall(r"([a-z_0-9]+)=([^&]*)", r["loi"]); qd = dict(q)
    check("link: multifamily, 90 units, NOI, cap rate, DSCR, single carryback LOI, deadline", qd["prop_type"] == "multifamily" and qd["units"] == "90" and qd["noi_direct"] == "897000" and qd["cap_rate"] == "7" and qd["loan_type"] == "dscr" and qd["autogen"] == "loi" and "dual_offer_active" not in qd and qd["offer_expiry"] == want, qd.get("offer_expiry"))
    lg = b.new_page(viewport={"width": 1300, "height": 900}); lerr = []; lg.on("pageerror", lambda e: lerr.append(str(e)))
    lg.route(re.compile(r"https://pharaohm33\.github\.io/loi-generator.*"), lambda rt, rq: rt.fulfill(status=200, content_type="text/html", body=LOI))
    lg.goto(r["loi"]); lg.wait_for_timeout(2000)
    out = lg.evaluate("({ err: document.documentElement.dataset.loiError, text: (window.loiOutput() || {}).text || '' })")
    check("the generator builds the LOI (no error, price and address in it)", not out["err"] and len(out["text"]) > 800 and "8,339,000" in out["text"] and "Bellevue" in out["text"], (out["err"], len(out["text"])))
    print("   first lines:", " / ".join(l.strip() for l in out["text"].splitlines() if l.strip())[:300]); check("no script errors", not errs and not lerr, errs[:2] + lerr[:2])
    b.close()
sys.exit(1 if bad else 0)
