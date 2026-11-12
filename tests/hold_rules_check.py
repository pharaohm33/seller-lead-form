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
    thin = run(300000, 318000, 1900)
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
    # The seller is paid every month: a principal-only note pays at least MIN_NOTE_PMT, found by lowering the loan; every other rule still holds, otherwise the deal is skipped.
    PAY = """([price, arv, ltr, str_, minPay]) => { SCR.HOLD.MIN_NOTE_PMT = minPay; SCR.cfg.minDom = 0; SCR.cfg.asset = 'sf'; SCR.cfg.strategy = 'hold';
      const d = { address: '1 A St, Tucson, AZ 85701', street: '1 A St', price, sqft: 1500, dom: 300 }; const f = { pwEquityPct: 100, arvLow: arv, arvHigh: arv, rentLtr: ltr, rentStr: str_, rehabLow: 20000, rehabHigh: 30000, tier: 'moderate' };
      const p = scrPrice(d, f), h = p.holdPlan || {}, c = h.cashAtClose || {}, x = h.saleExit || {}; SCR.HOLD.MIN_NOTE_PMT = 250;
      return { q: p.qualifies, why: p.why, noteRate: p.noteRate, mp: p.monthlyPrincipal, cf: h.cashflow, need: h.cfNeed, dscr: h.dscr, down: p.carryDown / p.carryOffer, years: p.months / 12, sale: x.surplus, buyerMonths: c.buyerMonths, wholesaler: c.wholesaler, fee: c.fee, structure: h.structure, ltv: p.ltv, link: scrLoiLink(d, p) }; }"""
    sweep = [(pr, ar, rent) for pr, ar in [(250000, 270000), (300000, 325000), (330000, 360000), (350000, 380000), (400000, 440000)] for rent in (1900, 2200, 2500, 2800, 3200)]
    rows = [(sp, pg.evaluate(PAY, [sp[0], sp[1], sp[2], 0, 250]), pg.evaluate(PAY, [sp[0], sp[1], sp[2], 0, 0])) for sp in sweep]
    q = [(sp, a, b) for sp, a, b in rows if a["q"]]
    check("a sweep has qualifying deals to test the monthly payment on", len(q) >= 5, len(q))
    check("every qualifying hold deal pays the seller something every month (interest-only, or principal of at least $250 a month)", all(a["noteRate"] > 0 or a["mp"] >= 250 for sp, a, b in q), [(sp, a["mp"]) for sp, a, b in q if not (a["noteRate"] > 0 or a["mp"] >= 250)])
    check("none of those deals is sent as a deferred-to-exit offer", all("mode=deferred_exit" not in a["link"] for sp, a, b in q))
    check("paying the seller each month never breaks the other rules: cash flow floor, DSCR 1.25, reserves, your fee, sale exit above 0", all(a["cf"] >= a["need"] - 0.5 and a["dscr"] >= 1.25 - 1e-9 and a["buyerMonths"] >= 3 - 1e-9 and a["wholesaler"] >= min(a["fee"], 25000) - 1 and a["sale"] > 0 for sp, a, b in q), [(sp, a["cf"], a["need"], a["dscr"]) for sp, a, b in q if not (a["cf"] >= a["need"] - 0.5 and a["dscr"] >= 1.25 - 1e-9)])
    check("every offer link uses the 2nd lien / deed of trust seller security, not senior equity", all("seller_security_type=deed_of_trust" in a["link"] and "seller_security_type=equity" not in a["link"] for sp, a, b in q), [a["link"][-80:] for sp, a, b in q][:1])
    dropped = [(sp, b) for sp, a, b in rows if b["q"] and not a["q"]]
    check("a deal that only worked by paying the seller nothing is skipped and says so", all(any("paying the seller nothing each month" in w for w in (a_["why"])) for sp, a_, b in rows if b["q"] and not a_["q"] and b["structure"] == "principal" and b["mp"] < 250), dropped)
    changed = [(sp, a["mp"], a["ltv"], b["ltv"], a["noteRate"]) for sp, a, b in rows if a["q"] and b["q"] and b["structure"] == "principal" and (b["mp"] or 0) < 250]
    check("a deal that used to be deferred now pays the seller by taking a smaller loan (or is skipped above)", all((c[1] >= 250 or c[4] > 0) and c[2] <= c[3] + 1e-9 for c in changed), changed)
    # A seller down payment asked for (cfg.downTargetFlipPct and cfg.downTargetHoldPct, % of the full purchase price): the offer starts there and comes down only as far as the other rules force; blank = the usual rules.
    DOWN = """([price, arv, ltr, str_, pct, strat, other]) => { SCR.cfg.downTargetHoldPct = strat === 'hold' ? pct : (other || 0); SCR.cfg.downTargetFlipPct = strat === 'flip' ? pct : (other || 0); SCR.cfg.minDom = 0; SCR.cfg.asset = 'sf'; SCR.cfg.strategy = strat;
      const d = { address: '1 A St, Tucson, AZ 85701', street: '1 A St', price, sqft: 1500, dom: 300 }; const f = { pwEquityPct: 100, arvLow: arv, arvHigh: arv, rentLtr: ltr, rentStr: str_, rehabLow: 20000, rehabHigh: 30000, tier: 'moderate' };
      const p = scrPrice(d, f), h = p.holdPlan || {}, c = h.cashAtClose || {}, x = h.saleExit || {}; SCR.cfg.downTargetHoldPct = 0; SCR.cfg.downTargetFlipPct = 0;
      return { q: p.qualifies, down: p.carryDown / p.carryOffer, carry: p.carryOffer, years: p.months / 12, cf: h.cashflow, need: h.cfNeed, dscr: h.dscr, sale: x.surplus, buyerMonths: c.buyerMonths, wholesaler: c.wholesaler, fee: c.fee, levers: h.levers || [], note: p.carryNote || '' }; }"""
    auto = pg.evaluate(DOWN, [330000, 360000, 2500, 5200, 0, 'hold'])
    asked = pg.evaluate(DOWN, [330000, 360000, 2500, 5200, 40, 'hold'])
    check("blank = automatic: the usual start (50% where it works) is unchanged", auto["q"] and abs(auto["down"] - 0.5) < 0.01, auto["down"])
    check("asking for 40% down gives the seller 40% (or the best the rules allow) and every other rule still holds", asked["q"] and asked["down"] >= 0.40 - 0.005 and asked["cf"] >= asked["need"] - 0.5 and asked["dscr"] >= 1.25 - 1e-9 and asked["sale"] > 0 and asked["buyerMonths"] >= 3 - 1e-9, asked)
    weak = pg.evaluate(DOWN, [300000, 325000, 2500, 0, 45, 'hold']); weak_auto = pg.evaluate(DOWN, [300000, 325000, 2500, 0, 0, 'hold'])
    check("a down payment the deal cannot carry comes down only as far as it must, never below what the automatic rules reach, and says so", weak["q"] and weak["down"] <= 0.45 + 1e-9 and weak["down"] >= weak_auto["down"] - 1e-9 and (weak["down"] >= 0.45 - 0.005 or any("asked 45%" in l for l in weak["levers"])), (weak, weak_auto["down"]))
    check("the asked-for down payment is reported in the levers", any("seller down payment" in l for l in asked["levers"]), asked["levers"])
    flip_auto = pg.evaluate(DOWN, [600000, 900000, 0, 0, 0, 'flip']); flip_ask = pg.evaluate(DOWN, [600000, 900000, 0, 0, 45, 'flip'])
    check("flips: the asked-for down payment is the start (45%), not the usual ~30%", flip_ask["down"] > flip_auto["down"] + 0.02 and flip_ask["down"] <= 0.45 + 1e-9, (flip_auto["down"], flip_ask["down"]))
    flip_other = pg.evaluate(DOWN, [600000, 900000, 0, 0, 0, 'flip', 70]); hold_other = pg.evaluate(DOWN, [330000, 360000, 2500, 5200, 0, 'hold', 70])
    check("the two settings are separate: a flip target does not move a buy & hold offer and the other way round", abs(hold_other["down"] - auto["down"]) < 1e-9 and abs(flip_other["down"] - flip_auto["down"]) < 1e-9, (hold_other["down"], auto["down"], flip_other["down"], flip_auto["down"]))
    sweep = [pg.evaluate(DOWN, [pr, ar, rent, 0, 35, 'hold']) for pr, ar, rent in [(250000, 270000, 2200), (300000, 325000, 2500), (330000, 360000, 2800), (400000, 440000, 3200)]]
    check("with a target set every qualifying hold deal still meets cash flow, DSCR, reserves, fee and the sale exit", all((not r["q"]) or (r["cf"] >= r["need"] - 0.5 and r["dscr"] >= 1.25 - 1e-9 and r["sale"] > 0 and r["buyerMonths"] >= 3 - 1e-9 and r["wholesaler"] >= min(r["fee"], 25000) - 1) for r in sweep), sweep)
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
