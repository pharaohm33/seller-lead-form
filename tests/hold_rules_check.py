"""Buy & hold seller carryback rules (scrSolveHold): 50% cash to the seller to start, a 75% LTV DSCR loan lowered as needed, seller cash lowered only when the loan cannot fund the cash at closing,
the soonest balloon from 5 to 15 years, buyer reserves of at least 3 months, your fee on top, single family proforma (the better of long-term and short-term rent), multifamily the in-place NOI,
appraisal at the asking price, and a single-family hold over $450,000 is skipped.   Run:  python tests/hold_rules_check.py"""
import functools, http.server, json, pathlib, sys, threading
from playwright.sync_api import sync_playwright

SP = str(pathlib.Path(__file__).resolve().parent.parent)
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=SP)); threading.Thread(target=srv.serve_forever, daemon=True).start()
bad = 0
def check(name, ok, extra=""):
    global bad; bad += not ok; print("PASS" if ok else "FAIL", name, extra)
RUN = """([price, arv, ltr, str_, noiA, units, strat]) => { SCR.cfg.minDom = 0; SCR.cfg.asset = 'sf'; SCR.cfg.strategy = strat || 'hold';
  const d = { address: '1 A St, Tucson, AZ 85701', street: '1 A St', price, sqft: 1500, dom: 300 }; if (units) d.units = units;
  const f = { pwEquityPct: 100, arvLow: arv, arvHigh: arv, rentLtr: ltr, rentStr: str_, rehabLow: 20000, rehabHigh: 30000, tier: 'moderate' }; if (noiA) f.noiAnnual = noiA;
  const p = scrPrice(d, f), h = p.holdPlan || {}, c = h.cashAtClose || {};
  return { q: p.qualifies, why: p.why, carry: p.carryOffer, down: p.carryDown, ltv: p.ltv, years: p.months / 12, noteRate: p.noteRate, cf: h.cashflow, need: h.cfNeed, dscr: h.dscr, levers: h.levers || [], basis: h.basis,
           buyerMonths: c.buyerMonths, buyer: c.buyer, wholesaler: c.wholesaler, fee: c.fee, avail: c.avail, profit: p.profit && p.profit.sale, minProfit: p.profit && p.profit.min, ceilOk: p.ceiling && p.ceiling.ok, appraisalOk: h.appraisalOk } }"""
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True); pg = b.new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.route("https://script.google.com/**", lambda r: r.fulfill(status=200, content_type="application/json", headers={"access-control-allow-origin": "*"}, body='{"ok":true}'))
    pg.goto(f"http://127.0.0.1:{srv.server_address[1]}/index.html"); pg.wait_for_timeout(1200)
    run = lambda price, arv, ltr=0, str_=0, noiA=0, units=None, strat="hold": pg.evaluate(RUN, [price, arv, ltr, str_, noiA, units, strat])
    strong = run(330000, 360000, 2500, 5200)                       # short-term rental pays the most
    check("starts at 50% cash to the seller and a 75% LTV loan when it all works", strong["q"] and abs(strong["down"] / strong["carry"] - 0.5) < 0.01 and abs(strong["ltv"] - 0.75) < 1e-9, (strong["down"], strong["carry"], strong["ltv"]))
    check("single family takes the better of long-term and short-term rent (proforma)", "short-term" in strong["basis"] and "long-term" in run(330000, 360000, 2500, 1500)["basis"], strong["basis"])
    ltr = run(330000, 360000, 2500)
    check("when the loan cannot fund the seller's 50%, seller cash comes down and the LTV drops for cash flow / DSCR", ltr["q"] and ltr["down"] / ltr["carry"] < 0.5 and ltr["ltv"] < 0.75 and any("seller cash at closing" in l and "appraisal contingency" in l for l in ltr["levers"]) and any(l.startswith("LTV") for l in ltr["levers"]), ltr["levers"])
    check("cash flow and DSCR are met: at least the floor, DSCR 1.25 or better", ltr["cf"] >= ltr["need"] - 0.5 and ltr["dscr"] >= 1.25, (ltr["cf"], ltr["need"], ltr["dscr"]))
    check("the buyer keeps at least 3 months of payments in reserve and you get at least the fee formula", all(r["buyerMonths"] >= 3 - 1e-9 and r["wholesaler"] >= min(r["fee"], 25000) - 1 for r in (strong, ltr)), (ltr["buyerMonths"], ltr["wholesaler"], ltr["fee"]))
    check("above the reserves the cash is split: a rich deal pays more than the fee formula", strong["wholesaler"] > strong["fee"] and strong["buyerMonths"] > 6, (strong["wholesaler"], strong["fee"], strong["buyerMonths"]))
    check("the balloon is between 5 and 15 years and the buyer profit is at least 10% of the price", 5 <= ltr["years"] <= 15 and ltr["profit"] >= 0.10 * ltr["carry"] - 1, (ltr["years"], ltr["profit"]))
    thin = run(300000, 318000, 1800)
    check("a thin deal takes a longer balloon only when it needs one (soonest that works)", thin["q"] and 5 < thin["years"] <= 15 and thin["profit"] >= 0.10 * thin["carry"] - 1 and ltr["years"] == 5, (thin["years"], thin["ltv"], ltr["years"]))
    gap = run(330000, 320000, 2500)
    check("an appraisal under the asking price skips the deal", gap["q"] is False and any("appraisal" in w for w in gap["why"]) and gap["appraisalOk"] is False, gap["why"])
    big = run(500000, 560000, 6000)
    check("single-family hold over $450,000 is skipped (needs a cash offer)", big["q"] is False and any("needs a cash offer" in w for w in big["why"]), big["why"])
    check("just under $450,000 is not skipped for the price", not any("needs a cash offer" in w for w in run(449000, 520000, 6000)["why"]))
    none = run(330000, 360000, 700)
    check("no cash flow: no carryback offer", none["q"] is False and any("no cash flow" in w for w in none["why"]), none["why"])
    mf = run(13000000, 14657000, 0, 0, 897000, 90)
    check("multifamily uses the in-place NOI, long-term only, and is not held to the $450,000 rule", mf["q"] and "in-place" in mf["basis"] and not any("cash offer" in w for w in mf["why"]), (mf["basis"], mf["why"]))
    check("multifamily ignores short-term rent", "in-place" in run(13000000, 14657000, 0, 99999, 897000, 90)["basis"])
    check("the price stays near asking (70% of value, capped at asking) and the seller's cash is the lever", abs(ltr["carry"] - 252000) <= 1000 and ltr["down"] / ltr["carry"] < 0.5, (ltr["carry"], ltr["down"]))
    check("the 15% counter-raise is reported (not required)", isinstance(ltr["ceilOk"], bool) and isinstance(mf["ceilOk"], bool))
    flip = run(600000, 900000, 0, 0, 0, None, "flip")
    check("fix & flip over $450,000 is untouched", not any("cash offer" in w or "cash flow" in w or "appraisal" in w for w in flip["why"]), flip["why"])
    check("no script errors", not errs, errs[:2]); b.close()
sys.exit(1 if bad else 0)
