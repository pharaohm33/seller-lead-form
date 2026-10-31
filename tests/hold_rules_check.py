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
    check("starts at 50% cash to the seller and a loan up to 75% LTV when it all works, with a short balloon", strong["q"] and abs(strong["down"] / strong["carry"] - 0.5) < 0.01 and strong["ltv"] <= 0.75 and strong["years"] <= 5, (strong["down"], strong["carry"], strong["ltv"], strong["years"]))
    check("single family takes the better of long-term and short-term rent (proforma)", "short-term" in strong["basis"] and "long-term" in run(330000, 360000, 2500, 1500)["basis"], strong["basis"])
    ltr = run(330000, 360000, 2500)
    check("when the loan cannot fund the seller's 50%, seller cash comes down and the LTV drops for cash flow / DSCR", ltr["q"] and ltr["down"] / ltr["carry"] < 0.5 and ltr["ltv"] < 0.75 and any("seller cash at closing" in l and "appraisal contingency" in l for l in ltr["levers"]) and any(l.startswith("LTV") for l in ltr["levers"]), ltr["levers"])
    check("cash flow and DSCR are met: at least the floor, DSCR 1.25 or better", ltr["cf"] >= ltr["need"] - 0.5 and ltr["dscr"] >= 1.25, (ltr["cf"], ltr["need"], ltr["dscr"]))
    check("the buyer keeps at least 3 months of payments in reserve and you get at least the fee formula", all(r["buyerMonths"] >= 3 - 1e-9 and r["wholesaler"] >= min(r["fee"], 25000) - 1 for r in (strong, ltr)), (ltr["buyerMonths"], ltr["wholesaler"], ltr["fee"]))
    check("above the reserves the cash is split: a rich deal pays more than the fee formula", strong["wholesaler"] > strong["fee"] and strong["buyerMonths"] > 6, (strong["wholesaler"], strong["fee"], strong["buyerMonths"]))
    check("the balloon is between 1 and 15 years (checked year by year); the buyer profit is at least 5% of the price under 5 years, 10% from 5 years", 1 <= ltr["years"] <= 15 and ltr["profit"] >= (0.05 if ltr["years"] < 5 else 0.10) * ltr["carry"] - 1, (ltr["years"], ltr["profit"]))
    thin = run(300000, 318000, 1800)
    check("a thin deal takes a longer balloon only when it needs one (soonest that works)", thin["q"] and thin["years"] <= 15 and thin["profit"] >= (0.05 if thin["years"] < 5 else 0.10) * thin["carry"] - 1 and ltr["years"] < thin["years"], (thin["years"], thin["ltv"], ltr["years"]))
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
    check("the offer starts at the asking price (the seller gets full price) and the seller's cash is the lever", ltr["carry"] == 330000 and ltr["down"] / ltr["carry"] < 0.5, (ltr["carry"], ltr["down"]))
    check("cash back to the buyer and your Acq / Bird Dog Fee split the net cash 50 / 50, each clearing its floor", abs(strong["buyer"] - strong["wholesaler"]) <= 0.03 * strong["wholesaler"] + 1 and strong["wholesaler"] >= strong["fee"] - 1 and strong["buyerMonths"] >= 3, (strong["buyer"], strong["wholesaler"], strong["fee"], strong["buyerMonths"]))
    check("the 15% counter-raise is reported (not required)", isinstance(ltr["ceilOk"], bool) and isinstance(mf["ceilOk"], bool))
    flip = run(600000, 900000, 0, 0, 0, None, "flip")
    check("fix & flip over $450,000 is untouched", not any("cash offer" in w or "cash flow" in w or "appraisal" in w for w in flip["why"]), flip["why"])
    SALE = """([price, arv, ltr, req]) => { SCR.HOLD.SALE_EXIT_REQUIRED = req; SCR.cfg.minDom = 0; SCR.cfg.asset = 'sf'; SCR.cfg.strategy = 'hold';
      const d = { address: '1 A St, Tucson, AZ 85701', street: '1 A St', price, sqft: 1500, dom: 300 }; const f = { pwEquityPct: 100, arvLow: arv, arvHigh: arv, rentLtr: ltr, rentStr: 0, rehabLow: 20000, rehabHigh: 30000, tier: 'moderate' };
      const p = scrPrice(d, f), x = (p.holdPlan || {}).saleExit || {}; SCR.HOLD.SALE_EXIT_REQUIRED = true; return { q: p.qualifies, years: p.months / 12, ltv: p.ltv, down: p.carryDown / p.carryOffer, surplus: x.surplus, log: p.holdLog[0] }; }"""
    strongRent = [330000, 340000, 4500]
    off, on = pg.evaluate(SALE, strongRent + [False]), pg.evaluate(SALE, strongRent + [True])
    check("without the safeguard a strong-rent deal can leave the sale exit short (the problem it fixes)", off["surplus"] < 0, off["surplus"])
    check("Sale Exit - CF pocketed (appreciation) is above 0 at the balloon: the sale off appreciation alone clears the DSCR loan and the seller note", on["q"] and on["surplus"] > 0 and on["log"]["saleOk"] is True, on["surplus"])
    check("to get there the LTV comes down and/or the balloon gets longer / the seller keeps more cash up front", on["ltv"] < off["ltv"] or on["years"] > off["years"] or on["down"] > off["down"], (on, off))
    check("every qualifying deal in a sweep has a sale exit above 0", all((lambda r: (not r["q"]) or r["surplus"] > 0)(pg.evaluate(SALE, [pr, ar, rent, True])) for pr, ar, rent in [(330000, 360000, 2500), (330000, 401500, 2308), (300000, 318000, 1800), (320000, 330000, 2600), (250000, 255000, 3000), (400000, 405000, 5000), (330000, 345000, 4000)]))
    check("no script errors", not errs, errs[:2]); b.close()
sys.exit(1 if bad else 0)
