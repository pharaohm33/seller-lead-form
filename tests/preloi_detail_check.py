"""The admin Pre-LOI "Full deal details" view shows the extra variables the browser agent saves for a multifamily offer (commercialJson), when they were produced, and nothing extra for a deal without them (fix & flip).
Run:  ~/browser-agent/.venv/bin/python tests/preloi_detail_check.py"""
import functools, http.server, json, pathlib, sys, threading
from playwright.sync_api import sync_playwright

SP = str(pathlib.Path(__file__).resolve().parent.parent)
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=SP)); threading.Thread(target=srv.serve_forever, daemon=True).start()
bad = 0
def check(name, ok, extra=""):
    global bad; bad += not ok; print("PASS" if ok else "FAIL", name, "" if ok else extra)

CJ = {"property": {"address": "844 N Ogden St, Denver, CO 80218", "units": 21, "askingPrice": 3750000, "brokerage": "Panorama Commercial Group"}, "broker": {"name": "Mark Pyms", "phone": "(720) 318-9454", "email": "Mark@panoramacommercialgroup.com"},
      "income": {"noiAnnual": 205690, "noiSource": "listing NOI"}, "valuation": {"capLow": 5.3, "capHigh": 6.86, "capRuns": 3, "valueMiddle": 3377000, "capRateValue": 3383000, "aiValue": 3370840, "valueBasis": "the cap-rate value and Google AI's value averaged", "appraisalLikelyLow": True,
      "aiCheck": {"found": True, "submarket": "Capitol Hill", "value_low": 3164462, "value_high": 3577217}}, "offer": {"carryPrice": 3750000, "sellerMonthlyPayment": 3100, "buyerReserveMonths": 6.7, "agentCommission": {"pct": 2.5}},
      "links": {"loiGenerator": "https://pharaohm33.github.io/loi-generator/?address=x", "stackCalculatorShare": "https://deal-craft-toolkit-98.lovable.app/?s=AAA", "stackCalculatorShareAtAsking": "https://deal-craft-toolkit-98.lovable.app/?s=BBB",
                "stackCalculatorResults": {"carryPayment": "3,100.00", "dscrPayment": "12,327.24", "netCfDay1": "1,713.59", "buyerReserves": "293,460", "verdict": "DEAL ✅"}}, "rules": {"capTolerance": 0.2}}

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True); pg = b.new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.route("https://script.google.com/**", lambda r: r.fulfill(status=200, content_type="application/json", headers={"access-control-allow-origin": "*"}, body='{"ok":true}'))
    pg.goto(f"http://127.0.0.1:{srv.server_address[1]}/index.html"); pg.wait_for_timeout(1500)
    JS = "(e) => preLoiDetailHtml(e)"
    mf = pg.evaluate(JS, {"status": "Pre-LOI", "street": "844 N Ogden St", "city": "Denver", "state": "CO", "zip": "80218", "askingPrice": 3750000, "answers": {"preLoiStrategy": "Buy & hold (multifamily)", "commercialJson": json.dumps(CJ), "preLoiNotes": "PRE-LOI notes", "loiUrl": "https://pharaohm33.github.io/loi-generator/?address=x&purchase_price=3750000"}})
    ff = pg.evaluate(JS, {"status": "Pre-LOI", "street": "1 A St", "city": "Tucson", "state": "AZ", "zip": "85701", "askingPrice": 300000, "answers": {"preLoiStrategy": "Fix & flip", "preLoiNotes": "notes", "loiUrl": "https://pharaohm33.github.io/loi-generator/?address=y"}})
    check("a multifamily entry gets the 'Multifamily offer details' section", "Multifamily offer details (every variable)" in mf, mf[:200])
    for needle in ("Mark Pyms", "205,690", "Capitol Hill", "3,377,000", "5.3", "Appraisal Likely Low", "Stack Method calculator, likely appraisal", "Stack Method calculator, appraises at asking", "?s=AAA", "?s=BBB", "carry payment 3,100.00/mo", "verdict DEAL", "Rules in force"):
        check("the section shows: " + needle, needle in mf, "")
    check("the calculator links are real links that open in a new tab", 'href="https://deal-craft-toolkit-98.lovable.app/?s=AAA"' in mf and 'target="_blank"' in mf, "")
    check("the raw JSON blob is not dumped into 'All saved form answers'", "Commercial Json" not in mf and "commercialJson" not in mf.split("All saved form answers")[-1], "")
    check("a fix & flip (no multifamily variables) has no such section and still renders", "Multifamily offer details" not in ff and "Full deal details" in ff, ff[:200])
    check("no page errors", not errs, errs[:2])
    b.close()
sys.exit(1 if bad else 0)
