"""The rental income method is recorded on every deal (answers, notes, and the regular form's own rent fields): long-term rent, short-term rent, the listing's in-place NOI,
or none for a fix & flip / land / a hold with no rent.   Run:  python tests/rental_income_check.py"""
import functools, http.server, pathlib, threading
from playwright.sync_api import sync_playwright

SP = str(pathlib.Path(__file__).resolve().parent.parent)
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=SP)); threading.Thread(target=srv.serve_forever, daemon=True).start()
bad = 0
def check(name, ok, extra=""):
    global bad; bad += not ok; print("PASS" if ok else "FAIL", name, extra)
RUN = """([price, arv, ltr, str_, noiA, units, strat, asset]) => { SCR.cfg.minDom = 0; SCR.cfg.asset = asset || 'sf'; SCR.cfg.strategy = strat || 'hold';
  const d = { address: '1 A St, Tucson, AZ 85701', street: '1 A St', city: 'Tucson', state: 'AZ', zip: '85701', price, sqft: 1500, dom: 300 }; if (units) d.units = units;
  const f = { pwEquityPct: 100, arvLow: arv, arvHigh: arv, rentLtr: ltr, rentStr: str_, rehabLow: 20000, rehabHigh: 30000, tier: 'moderate' }; if (noiA) f.noiAnnual = noiA;
  const p = scrPrice(d, f), a = scrAnswers(d, f, p), notes = scrNotes(d, f, p, 'https://loi', 'https://resume');
  return { hold: p.hold, q: p.qualifies, method: a.rentalIncomeMethod, detail: a.rentalIncomeDetail, rent: a.rentcastMonthlyRent, exp: a.expenseRatio, ltrNoi: a.residentialNOI, strRev: a.strAnnualRevenue, strNoi: a.strNOI,
           line: (notes.split('\\n').find(l => l.indexOf('- Rental income:') === 0) || '') }; }"""
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True); pg = b.new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.route("https://script.google.com/**", lambda r: r.fulfill(status=200, content_type="application/json", headers={"access-control-allow-origin": "*"}, body='{"ok":true}'))
    pg.goto(f"http://127.0.0.1:{srv.server_address[1]}/index.html"); pg.wait_for_timeout(1200)
    run = lambda price, arv, ltr=0, str_=0, noiA=0, units=None, strat="hold", asset="sf": pg.evaluate(RUN, [price, arv, ltr, str_, noiA, units, strat, asset])
    l = run(330000, 360000, 2500)
    check("long-term rent only -> Long-term rental (LTR), with the 35% expenses and the NOI worked out", l["method"] == "Long-term rental (LTR)" and "35%" in l["detail"] and "$2,500" in l["detail"] and "only rent entered" in l["detail"], l["detail"])
    check("the regular form's own rent fields are filled (monthly rent, expense ratio, annual LTR NOI)", l["rent"] == "2500" and l["exp"] == "35" and l["ltrNoi"] == str(round(2500 * 0.65 * 12)), (l["rent"], l["exp"], l["ltrNoi"]))
    s = run(330000, 360000, 2500, 5200)
    check("short-term rent that nets more -> Short-term rental (STR), and the detail shows both and says why", s["method"] == "Short-term rental (STR)" and "LTR:" in s["detail"] and "STR:" in s["detail"] and "higher NOI" in s["detail"], s["detail"])
    check("STR revenue and STR NOI are filled per year", s["strRev"] == str(5200 * 12) and s["strNoi"] == str(round(5200 * 0.5 * 12)), (s["strRev"], s["strNoi"]))
    check("the notes carry the same rental income line", s["line"].startswith("- Rental income: ") and "Short-term" in s["line"] or "STR" in s["line"], s["line"])
    fl = run(330000, 400000, 2500, 0, 0, None, "flip")
    check("a fix & flip says none, and that rent was found but not used", not fl["hold"] and fl["method"].startswith("None: fix & flip") and "not used" in fl["detail"] and "$2,500" in fl["detail"], fl["detail"])
    fl0 = run(330000, 400000, 0, 0, 0, None, "flip")
    check("a fix & flip with no rent entered still says none", fl0["method"].startswith("None: fix & flip") and "not used" not in fl0["detail"], fl0["detail"])
    nr = run(330000, 360000, 0, 0)
    check("a buy & hold with no rent says cash flow was not tested", nr["method"].startswith("Buy & hold, but no rent was entered"), nr["method"])
    mf = run(900000, 1000000, 0, 0, 90000, 8)
    check("a multifamily / commercial deal uses the listing's in-place NOI", mf["method"].startswith("In-place NOI from the listing") and "$90,000/yr" in mf["detail"] and mf["ltrNoi"] == "90000", (mf["method"], mf["detail"]))
    check("no page errors", not errs, errs)
    b.close()
print(bad, "failed")
