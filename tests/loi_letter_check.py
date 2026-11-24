"""The Red Bridge Living LLC letter-of-intent style of the LOI generator (loi-generator repo), and that the classic LOI is untouched for every other buyer.
Needs the loi-generator repo (LOI_GENERATOR_DIR=/path/to/loi-generator, else ../loi-generator, else ~/loi-generator-work/loi-generator), Python with playwright and Chrome.
Run:  python tests/loi_letter_check.py"""
import functools, http.server, os, pathlib, sys, threading, urllib.parse
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent.parent
CANDIDATES = [os.environ.get("LOI_GENERATOR_DIR"), str(HERE.parent / "loi-generator"), str(pathlib.Path.home() / "loi-generator-work" / "loi-generator")]
GEN = next((c for c in CANDIDATES if c and (pathlib.Path(c) / "index.html").is_file()), None)
if not GEN:
    print("SKIP: the loi-generator repo was not found (set LOI_GENERATOR_DIR)"); sys.exit(0)

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=GEN)); threading.Thread(target=srv.serve_forever, daemon=True).start()
bad = 0
def check(name, ok, extra=""):
    global bad; bad += not ok; print("PASS" if ok else "FAIL", name, "" if ok else extra)

BASE = dict(address="19772 Stanton Avenue, Castro Valley, CA 94546", units=5, prop_type="commercial", purchase_price=2000000, cash_at_closing=800000, sc_rate=4, sc_term=5, mode="deferred_then_pay",
            sc_defer_months=6, buyer_company="Red Bridge Living LLC", seller_security_type="deed_of_trust", loi_agent_fee=2.5, loi_agent_fee_type="pct", sr_ltv=50, autogen="loi",
            closing_cost_party="buyer", appraisal_contingency="on", offer_expiry="2026-12-17")

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True)
    def loi(**ov):
        q = dict(BASE); q.update(ov)
        pg = b.new_page(); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(f"http://127.0.0.1:{srv.server_address[1]}/index.html?" + urllib.parse.urlencode(q)); pg.wait_for_timeout(900)
        t = pg.evaluate("window.loiOutput().text"); under = pg.evaluate("[...document.querySelectorAll('[id^=\"s-\"]')].map(e => e.innerText).join('|')")
        err = pg.evaluate("document.documentElement.dataset.loiError || ''"); pg.close()
        assert not errs and not err, (errs, err)
        return t, under

    sample, under_default = loi()
    for line in ["LETTER OF INTENT", "Buyer: Red Bridge Living LLC", "Property: 5-unit multifamily", "Address: 19772 Stanton Avenue, Castro Valley, CA 94546", "Proposed Transaction",
                 "Agreed Purchase Price / Seller Consideration: $2,000,000.00", "Cash to Seller at Closing: $800,000.00", "Seller Financing, if applicable: $1,200,000.00", "• Interest Rate: 4.00%",
                 "• Payment Structure: Interest Only", "• Term / Balloon: 5 years", "• Payment Deferral: First 6 monthly payments deferred; first payment due in Month 7", "• Monthly Payment to Seller: $4,000.00",
                 "• Security: 2nd Position Lien", "Buyer will connect Seller directly with Buyer's lender, who will explain the proposed transaction and financing process.",
                 "Seller may elect to stay on the deed or come off the deed at closing (we recommend Seller stay on the deed for extra security). If Seller remains on the deed, Buyer entity will be added as an additional owner.",
                 "A presigned Deed in Lieu will be executed at closing so that, in the event of Buyer default, Seller may relieve Buyer of ownership interest and regain control of the Property without foreclosure.",
                 "Buyer will pay customary closing costs, lender-related costs, and a 2.5% agent commission. These costs will be paid by Buyer as permitted by the lender.",
                 "Seller cash at closing is the amount before any senior loan payoffs. Buyer is obtaining a loan up to 50% LTV based on appraised value.", "No Commitment to Close",
                 "This LOI does not obligate Seller to sell or Buyer to purchase the Property.",
                 "The transaction remains subject to satisfactory appraisal, underwriting, due diligence, lender approval, satisfactory review of the Property's financials (including trailing 12-month operating statements, current rent roll, and leases), and execution of definitive agreements by both parties.",
                 "Seller acknowledges the above proposed terms and is open to exploring the transaction with Buyer.", "SELLER", "BUYER", "Name: Red Bridge Living LLC"]:
        check("sample LOI has: " + line[:70], line in sample, sample[:300])
    order = [sample.index(x) for x in ("• Interest Rate", "• Payment Structure", "• Term / Balloon", "• Payment Deferral", "• Monthly Payment", "• Balloon Amount", "• Security")]
    check("the note bullets are in the order of the Red Bridge letter", order == sorted(order), order)
    check("a deferral that accrues interest says so in the balloon (the classic LOI math)", "Balloon Amount Due at Maturity: $1,224,000.00" in sample and "$24,000.00 of accrued interest" in sample, sample)

    # the classic LOI is kept for every other buyer, and can be forced either way
    classic, _ = loi(buyer_company="Don Ava Capital LLC")
    check("another buyer keeps the classic LOI", classic.startswith("LOI\nDeal Terms - Seller Summary") and "LETTER OF INTENT" not in classic, classic[:120])
    check("loi_style=classic keeps the classic LOI even for Red Bridge", loi(loi_style="classic")[0].startswith("LOI\nDeal Terms"))
    check("loi_style=letter gives the letter for another LLC (the same offer from a different buyer)", "Buyer: Suede Buffalo LLC" in loi(buyer_company="Suede Buffalo LLC", loi_style="letter")[0])
    check("no buyer company: still the classic non-exclusive LOI", loi(buyer_company="")[0].startswith("Non-Exclusive LOI"))

    # the variant without the stay-on-deed option / lender contact, no LTV limit by default
    plain, _ = loi(loi_variant="plain")
    for bad_text in ("remain on the deed", "stay on the deed", "come off the deed", "lender, who will explain", "connect Seller directly", "LTV", "added as an additional owner"):
        check("plain variant does not say: " + bad_text, bad_text not in plain, plain)
    check("plain variant keeps the presigned Deed in Lieu security and the No Commitment to Close section", "A presigned Deed in Lieu" in plain and "No Commitment to Close" in plain)

    # max LTV on / off / value, and the underwriting never changes
    check("max LTV shows by default with the deed option", "loan up to 50% LTV" in sample)
    ltv_on, under_on = loi(loi_variant="plain", show_max_ltv="on")
    check("max LTV on (no deed option) shows the loan LTV used in the underwriting", "loan up to 50% LTV based on appraised value" in ltv_on, ltv_on)
    ltv_val, under_val = loi(show_max_ltv="on", max_ltv_shown=45)
    check("a LTV limit typed in is what the LOI shows", "loan up to 45% LTV" in ltv_val and "50% LTV" not in ltv_val, ltv_val)
    ltv_off, under_off = loi(show_max_ltv="off")
    check("max LTV off removes the sentence", "LTV" not in ltv_off and "Seller cash at closing is the amount before any senior loan payoffs." in ltv_off, ltv_off)
    check("the underwriting numbers are the same with the LTV shown, hidden or changed", under_default == under_on == under_val == under_off and under_default, (under_default[:80], under_val[:80]))

    # zero interest is written as principal only
    po, _ = loi(sc_rate=0, mode="principal_only", monthly_principal=3000)
    check("zero interest: Principal Only, no interest rate line", "• Payment Structure: Principal Only" in po and "Interest Rate:" not in po, po)
    check("zero interest principal-only payments reduce the balloon", "Monthly Payment to Seller: $3,000.00" in po and "Balloon Amount Due at Maturity: $1,020,000.00" in po, po)
    de, _ = loi(sc_rate=0, mode="deferred_exit")
    check("zero interest with no payments: Principal Only, none monthly, the balance due at maturity", "Principal Only" in de and "Monthly Payment to Seller: None" in de and "Balloon Amount Due at Maturity: $1,200,000.00" in de, de)
    ioo, _ = loi(mode="interest_only", sc_defer_months=0)
    check("interest only with a rate stays interest only", "Payment Structure: Interest Only" in ioo and "Payment Deferral" not in ioo and "Monthly Payment to Seller: $4,000.00" in ioo, ioo)

    # 5+ units keep the financials review, smaller homes do not; the appraisal wording follows the contingency
    sfr, _ = loi(units=1, prop_type="residential")
    check("a single-family home: no financials review, and 'Single-family residence'", "financials" not in sfr and "Property: Single-family residence" in sfr, sfr)
    check("5+ units keep the T-12 / rent roll / leases review", "trailing 12-month operating statements, current rent roll, and leases" in sample)
    noappr, _ = loi(appraisal_contingency="off")
    check("no appraisal contingency: the appraisal is not in the subject-to list", "satisfactory appraisal" not in noappr and "subject to underwriting" in noappr, noappr)
    nofee, _ = loi(loi_agent_fee="")
    check("no agent commission: the costs sentence leaves it out", "agent commission" not in nofee and "customary closing costs and lender-related costs" in nofee, nofee)
    secs, _ = loi(seller_security_type="equity")
    check("senior equity security reads as senior equity", "• Security: Senior Equity Interest" in secs and "Senior Equity Interest, giving Seller" in secs and "presigned Deed in Lieu" not in secs, secs)
    allcash, _ = loi(no_sc=1, purchase_price=800000, cash_at_closing=800000)
    check("an all-cash purchase has no seller financing bullets", "Seller Financing: None" in allcash and "Balloon" not in allcash, allcash)

    # all-cash offers (Red Bridge cash, closed with the buyer's own double escrow: the LOI never mentions it)
    cash, _ = loi(autogen="cash", no_sc=1, purchase_price=800000, cash_at_closing=800000)
    check("all cash: the Red Bridge letter, price and cash are the cash offer", cash.startswith("LETTER OF INTENT") and "Agreed Purchase Price / Seller Consideration: $800,000.00" in cash and "Cash to Seller at Closing: $800,000.00" in cash, cash)
    check("all cash: acquiring the Property for cash, as-is, full price in cash at closing", "acquiring the Property for cash" in cash and "as-is, where-is" in cash and "full purchase price in cash at closing" in cash, cash)
    for bad_text in ("lender", "LTV", "underwriting", "Deed in Lieu", "Seller Security", "financing transaction", "Balloon", "Interest Rate", "escrow", "assign", "resell", "end buyer"):
        check("all cash letter does not say: " + bad_text, bad_text.lower() not in cash.lower(), cash)
    check("all cash: subject to due diligence and definitive agreements, with the T-12 review on 5+ units", "subject to satisfactory appraisal, due diligence, satisfactory review of the Property's financials" in cash and "No Commitment to Close" in cash, cash)
    check("all cash: costs are the buyer's customary closing costs and the agent commission, no lender costs", "Buyer will pay customary closing costs and a 2.5% agent commission." in cash, cash)
    cash_fin, _ = loi(autogen="cash", no_sc=1, purchase_price=800000, cash_at_closing=800000, cash_financing="hard_money")
    check("all cash with a financing choice still lists lender approval", "lender approval" in cash_fin, cash_fin)
    other_cash, _ = loi(autogen="cash", no_sc=1, purchase_price=800000, cash_at_closing=800000, buyer_company="Don Ava Capital LLC")
    check("all cash for another buyer keeps the classic all-cash LOI", "ALL-CASH PURCHASE TERMS" in other_cash and "LETTER OF INTENT" not in other_cash, other_cash[:200])

    # the section titles are blue like the sample LOI (title #1a365d, sections #2c5282) so each section is easy to find
    def html(**ov):
        q = dict(BASE); q.update(ov)
        pg = b.new_page(); pg.goto(f"http://127.0.0.1:{srv.server_address[1]}/index.html?" + urllib.parse.urlencode(q)); pg.wait_for_timeout(900)
        out = pg.evaluate("[...document.querySelectorAll('#loi-text strong')].map(e => [e.innerText.trim(), getComputedStyle(e).color])"); pg.close()
        return dict(out)
    rgb = lambda h: "rgb(%d, %d, %d)" % (int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16))
    cols = html()
    check("the letter title is dark navy", cols.get("LETTER OF INTENT") == rgb("#1a365d"), cols.get("LETTER OF INTENT"))
    for sec in ("Proposed Transaction", "Deed Structure", "Costs", "Other Terms", "No Commitment to Close", "Seller Acknowledgment"):
        check("blue section title: " + sec, cols.get(sec) == rgb("#2c5282"), cols.get(sec))
    check("the plain wording's Seller Security title is blue too", html(loi_variant="plain").get("Seller Security") == rgb("#2c5282"))
    check("the header lines and the note bullets stay black bold or plain (only the section titles are blue)", cols.get("Seller: ______________________") not in (rgb("#2c5282"), rgb("#1a365d")))
    # 2026-11-24: the appraisal floor (the lowest appraisal the offer works at) is the appraisal contingency in the letter
    fl = loi(appraisal_floor=1783000)[0]
    check("appraisal_floor: the letter's contingency is a satisfactory appraisal at or above that number", "The transaction remains subject to satisfactory appraisal at or above $1,783,000.00, underwriting, due diligence, lender approval" in fl, fl[-900:])
    check("no appraisal_floor: the wording stays 'satisfactory appraisal'", "subject to satisfactory appraisal, underwriting" in sample and "at or above" not in sample)
    off = loi(appraisal_floor=1783000, appraisal_contingency="off")[0]
    check("appraisal contingency off: no appraisal wording even with a floor", "appraisal at or above" not in off and "satisfactory appraisal" not in off, off[-700:])
    b.close()
sys.exit(1 if bad else 0)
