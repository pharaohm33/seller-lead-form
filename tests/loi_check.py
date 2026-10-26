"""Builds the LOI-generator link the screener makes for each strategy and checks the generator fills in and writes the final LOI by itself.
Needs the loi-generator repo next to this one (or LOI_GENERATOR_HTML=/path/to/index.html), Python with playwright and Chrome."""
"""Opens the LOI generator with the link the screener built (full flow output) and checks the page fills in and the final LOI text appears."""
import functools, http.server, json, os, sys, threading, re
from playwright.sync_api import sync_playwright
import pathlib
SP = str(pathlib.Path(__file__).resolve().parent.parent)

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=SP))
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{srv.server_address[1]}"
LOI = open(os.environ.get("LOI_GENERATOR_HTML", SP + "/../loi-generator/index.html")).read()

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True)
    page = b.new_page(viewport={"width": 1300, "height": 900})
    page.route("https://script.google.com/**", lambda r, q: r.fulfill(status=200, content_type="application/json", headers={"access-control-allow-origin": "*"}, body=json.dumps({"ok": True, "token": "t", "leads": []})))
    page.add_init_script("sessionStorage.setItem('adminToken','tok');")
    page.goto(base + "/index.html")
    # build the same link the screener builds, for both a flip (dual offer) and a land deal (cash LOI)
    urls = page.evaluate("""() => {
      const out = {};
      SCR.rows = scrLoad('ADDRESS,CITY,STATE OR PROVINCE,ZIP OR POSTAL CODE,PROPERTY TYPE,PRICE,BEDS,BATHS,SQUARE FEET,LOT SIZE,YEAR BUILT,DAYS ON MARKET,STATUS,URL,MLS#\\n2901 W Milton Rd,Tucson,AZ,85746,Single Family Residential,330000,4,2,1800,7000,1978,200,Active,https://x,M1\\n');
      const d = SCR.rows[0]; SCR.cfg.asset = 'sf'; SCR.cfg.minDom = 0;
      const f = { tier: 'moderate', pwEquityPct: 100, arvLow: 400000, arvHigh: 420000, rehabLow: 40000, rehabHigh: 60000, rehab: null };
      // the 3021 W Vande Loo deal: asking $325,000, AI comps $301,500 to $323,500 (middle $312,500), rehab $22,440 to $37,400
      { SCR.cfg.strategy = 'flip'; const dv = Object.assign({}, d, { street: '3021 W Vande Loo St', price: 325000, sqft: 1496, beds: 3, baths: 2, address: '3021 W Vande Loo St, Tucson, AZ 85746' });
        const pv = scrPrice(dv, { tier: 'moderate', pwEquityPct: 86, arvLow: 301500, arvHigh: 323500, rehabLow: 22440, rehabHigh: 37400, rehab: null });
        out.vande = { url: scrLoiLink(dv, pv), mao10: pv.mao10, mao20: Math.round(pv.mao), carry: pv.carryOffer, cash: pv.cashOffer, down: pv.carryDown, note: pv.priceNote }; }
      for (const strat of ['flip', 'hold']) { SCR.cfg.strategy = strat; const pp = scrPrice(d, Object.assign({ rentLtr: 3500 }, f)); out[strat] = { url: scrLoiLink(d, pp), cash: pp.cashOffer, carry: pp.carryOffer, down: pp.carryDown, arv: pp.arvMid }; }
      SCR.cfg.asset = 'land'; SCR.cfg.strategy = 'cash'; const land = Object.assign({}, d, { type: 'Vacant Land', lot: 43560 });
      const pl = scrPrice(land, { pwEquityPct: 100, arvLow: 90000, arvHigh: 110000 }); out.land = { url: scrLoiLink(land, pl), cash: pl.cashOffer };
      SCR.cfg.strategy = 'dev'; const pd = scrPrice(land, { pwEquityPct: 100, arvLow: 90000, arvHigh: 110000 }); out.dev = { url: scrLoiLink(land, pd), cash: pd.cashOffer, full: pd.carryOffer };
      return out;
    }""")
    for name, info in urls.items():
        lp = b.new_page(viewport={"width": 1300, "height": 900})
        lp.route(re.compile(r"https://pharaohm33\.github\.io/loi-generator.*"), lambda r, q: r.fulfill(status=200, content_type="text/html", body=LOI))
        errs = []; lp.on("pageerror", lambda e: errs.append(str(e)))
        lp.goto(info["url"])
        lp.wait_for_timeout(1500); print("   loaded:", lp.title()[:40], "| address field:", lp.evaluate("document.getElementById('address') && document.getElementById('address').value"))
        ready = lp.evaluate("({ready: document.documentElement.dataset.loiReady, id: document.documentElement.dataset.loiOutput, out: window.loiOutput && window.loiOutput()})")
        text = (ready["out"] or {}).get("text", "")
        print("   loi error:", lp.evaluate("document.documentElement.dataset.loiError"), "| url mode:", re.findall(r"mode=(\w+)", info["url"]), "sc_rate:", re.findall(r"sc_rate=([\d.]+)", info["url"])); print(f"--- {name}: ready={ready['ready']} final box={ready['id']!r} chars={len(text)} | page errors: {errs[:2]}")
        print("   has address:", "2901 W Milton" in text, "| has buyer company:", "Suede Buffalo" in text, "| has phone:", "633" in text)
        nums = {k: info[k] for k in info if k not in ("url",)}
        shown = [str(v) for v in nums.values() if isinstance(v, (int, float))]
        print("   solver numbers:", nums, "| each appears in the LOI text:", {s: (f"{int(float(s)):,}" in text) for s in shown})
        st = lp.evaluate("({fin: cashFinancingType, appr: appraisalContingency})"); print("   financing contingency:", st, "| LOI says satisfactory appraisal:", "satisfactory appraisal" in text.lower() or "appraisal" in text.lower())
        if info.get("mao10"): print("   MAO10:", info["mao10"], "MAO20:", info.get("mao20"), "-> carry price", info["carry"], "| note:", (info.get("note") or "none")[:140])
        print("   mentions interest-only:", "interest-only" in text.lower(), "| dual:", "DUAL" in text); print("   first lines:", " / ".join([l.strip() for l in text.splitlines() if l.strip()][:4])[:230])
        import datetime
        want = (datetime.date.today() + datetime.timedelta(days=15))
        exp = re.findall(r"offer_expiry=([\d-]+)", info["url"]); pretty = f"{want.strftime('%B')} {want.day}, {want.year}"
        print("   expiry param:", exp, "(want", want.isoformat() + ") | LOI shows:", re.findall(r"Offer Expiration: ([^\n]+)", text)[:1], "| dual_offer_active in link:", "dual_offer_active" in info["url"])
        if name == "hold":
            assert "loan_type=dscr" in info["url"] and "rehab=0" in info["url"] and "Don+Ava+Capital" in info["url"] and "res_rent=3500" in info["url"], "buy & hold: rehab 0, DSCR loan, admin template terms, rent"
            print("   hold link: DSCR loan, rehab 0, admin template buyer, rent 3500 OK | LOI mentions DSCR:", "DSCR" in text, "| Don Ava in LOI:", "Don Ava" in text)
        if name in ("vande", "flip", "hold"):
            assert exp == [want.isoformat()] and pretty in text, "expiry must be tomorrow + 14 days"
            assert "dual_offer_active" not in info["url"] and "DUAL" not in text, "seller carryback only: no dual offer"
        lp.close()
    b.close()
