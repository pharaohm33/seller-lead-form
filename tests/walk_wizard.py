"""Needs Python with playwright and Google Chrome (e.g. the browser-agent project's .venv). Run from anywhere: python tests/walk_wizard.py full   (or: nocity)
Walks the REAL seller-lead-form site in headless Chrome against a fake backend: screener -> saved Pre-LOI -> Resume -> every wizard step -> Finish.
Usage: python walk_wizard.py [scenario]   (scenario: full | nocity)"""
import functools, http.server, json, sys, threading, time
from playwright.sync_api import sync_playwright

import pathlib
ROOT = str(pathlib.Path(__file__).resolve().parent.parent)
SCENARIO = sys.argv[1] if len(sys.argv) > 1 else "full"

CSV_FULL = "ADDRESS,CITY,STATE OR PROVINCE,ZIP OR POSTAL CODE,PROPERTY TYPE,PRICE,BEDS,BATHS,SQUARE FEET,LOT SIZE,YEAR BUILT,DAYS ON MARKET,STATUS,URL,MLS#\n" \
           "2901 W Milton Rd,Tucson,AZ,85746,Single Family Residential,330000,4,2,1800,7000,1978,200,Active,https://www.redfin.com/AZ/Tucson/2901-W-Milton-Rd-85746/home/1,MLS1\n"
CSV_NOCITY = "Address,Location,Price,Beds,Baths,SqFt,Price per SqFt,Days on Redfin\n2901 W Milton Rd,Southwest,330000,4,2,1800,183,98\n"

DB = {"entries": {}, "calls": [], "n": 0}


def backend(route, request):
    try:
        body = json.loads(request.post_data or "{}")
    except ValueError:
        body = {}
    act = body.get("action")
    DB["calls"].append(act)
    out = {"ok": True}
    if act == "adminLogin":
        out = {"ok": True, "token": "tok"}
    elif act == "getLeads":
        out = {"ok": True, "leads": []}
    elif act in ("adminSavePreLoi", "adminFinishPreLoi"):
        cid = body.get("crmId") or f"crm-{DB['n'] + 1}"
        DB["n"] += 1
        a = body.get("answers", {})
        DB["entries"][cid] = {"crmId": cid, "status": "Auto Pre-LOI Before Contact", "updatedAt": "2026-10-24T10:00:00Z", "street": a.get("street"), "city": a.get("city"), "state": a.get("state"),
                              "zip": a.get("zip"), "askingPrice": a.get("askingPrice"), "sellerContactName": a.get("sellerContactName"), "stepIndex": 19, "answers": a}
        out = {"ok": True, "crmId": cid, "submissionId": "sub-1"}
    elif act == "adminGetPreLoi":
        out = {"ok": True, "entries": list(DB["entries"].values())}
    elif act == "adminGetPreLoiEntry":
        e = DB["entries"].get(body.get("crmId"))
        out = {"ok": True, "entry": e} if e else {"ok": False, "error": "Not found."}
    elif act == "adminMarkPreLoiSent":
        if body.get("crmId") in DB["entries"]:
            DB["entries"][body["crmId"]]["status"] = "Auto Pre-LOI LOI Sent"
        out = {"ok": True, "crmId": "crm-copy"}
    elif act == "adminDeletePreLoi":
        DB["entries"][body["crmId"]]["status"] = "Auto Pre-LOI Deleted"
    elif act == "adminRestorePreLoi":
        DB["entries"][body["crmId"]]["status"] = "Auto Pre-LOI Before Contact"
    elif act == "adminGetSubmissions":
        a = next(iter(DB["entries"].values()))["answers"] if DB["entries"] else {}
        out = {"ok": True, "total": 1, "submissions": [{"submissionId": "sub-1", "submittedAt": "2026-10-24T10:05:00Z", "source": "Pre-LOI form (admin, no email)", "adminEmailed": "No",
               "street": a.get("street"), "city": a.get("city"), "state": a.get("state"), "zip": a.get("zip"), "sellerContactName": a.get("sellerContactName"), "sellerContactEmail": a.get("sellerContactEmail"),
               "loiLink": a.get("loiUrl"), "docUrl": DB.get("doc", ""), "draftStatus": DB.get("draft", ""), "matches": {"leads": 1, "preLoi": 1, "crm": 0, "submissions": 1}}]}
    elif act == "adminGetSubmission":
        a = next(iter(DB["entries"].values()))["answers"]
        out = {"ok": True, "submission": {"submissionId": "sub-1", "submittedAt": "2026-10-24T10:05:00Z", "source": "Pre-LOI form (admin, no email)", "adminEmailed": "No", "street": a.get("street"), "city": a.get("city"),
               "state": a.get("state"), "zip": a.get("zip"), "answers": a, "loiLink": a.get("loiUrl"), "docUrl": DB.get("doc", ""), "draftStatus": DB.get("draft", ""), "notes": "",
               "related": [{"kind": "Lead", "id": "l1", "status": "New", "when": "2026-10-20T00:00:00Z", "who": "Sam Seller"}, {"kind": "Pre-LOI", "id": "c1", "status": "Auto Pre-LOI Form Completed", "when": "2026-10-24T10:05:00Z", "who": "me"}]}}
    elif act == "adminUpdateSubmission":
        DB["doc"], DB["draft"] = body.get("docUrl", ""), body.get("draftStatus", "")
    elif act == "getLeadsByEmail":
        out = {"ok": True, "leads": []}
    route.fulfill(status=200, content_type="application/json", headers={"access-control-allow-origin": "*"}, body=json.dumps(out))


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass


def main():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=ROOT))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True)
        page = b.new_page(viewport={"width": 1300, "height": 900})
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.on("dialog", lambda d: (errs.append("DIALOG: " + d.message[:120]), d.dismiss()))
        page.route("https://script.google.com/**", backend)
        page.add_init_script("sessionStorage.setItem('adminToken','tok'); window.__opened=[]; window.open=(u)=>{window.__opened.push(u); return null};")
        page.goto(base + "/index.html")
        page.click("#admin-access-btn")
        page.wait_for_selector("#admin-view:not([hidden])")
        page.click("#admin-tab-preloi")
        csv = CSV_FULL if SCENARIO == "full" else CSV_NOCITY
        # ---- the REAL screener builds the Pre-LOI answers
        saved = page.evaluate("""async (csv) => {
          SCR.cfg.defCity = %s; SCR.cfg.defState = %s;
          SCR.rows = scrLoad(csv); const d = SCR.rows[0];
          SCR.cfg.asset = 'sf'; SCR.cfg.strategy = 'flip'; SCR.cfg.minDom = 0;
          const f = { tier: 'moderate', pwEquityPct: 100, pwValue: 330000, pwMortgage: 0, pwMortgageSet: true, arvLow: 400000, arvHigh: 420000, rehabLow: 40000, rehabHigh: 60000,
                      owner: 'Olive Owner', contactRole: 'realtor', contactName: 'Rita Realtor', contactPhone: '520-247-8391', contactEmail: 'rita@broker.com', rehab: null };
          const p = scrPrice(d, f); if (!p.ready) return { error: 'not ready', p };
          const a = scrAnswers(d, f, p); const loi = scrLoiLink(d, p);
          a.loiUrl = loi; a.preLoiNotes = scrNotes(d, f, p, loi, scrResumeLink(a));
          const r = await api('adminSavePreLoi', { token: sessionToken, email: SCR.AGENT_EMAIL, crmId: '', stepIndex: 19, answers: a });
          return { ok: r.ok, keys: Object.keys(a).length, answers: a };
        }""" % (json.dumps("Tucson" if SCENARIO == "nocity" else ""), json.dumps("AZ" if SCENARIO == "nocity" else "")), csv)
        print("screener saved a Pre-LOI:", saved.get("ok"), "| answers keys:", saved.get("keys"))
        if "--answers" in sys.argv: print({k: str(v)[:60] for k, v in saved["answers"].items() if k not in ("preLoiNotes", "loiUrl", "holdLog")})
        # ---- list -> Resume
        page.click("#admin-tab-leads"); page.click("#admin-tab-preloi")
        page.wait_for_selector("[data-pl-resume]")
        page.click("[data-pl-resume]")
        page.wait_for_selector("#public-view:not([hidden])")
        banner = page.locator(".banner.warn", has_text="Pre-LOI mode").count()
        print("pre-LOI banner shown:", banner > 0)
        # ---- walk every step
        report = []
        for i in range(40):
            key = page.evaluate("steps[stepIndex].key")
            idx = page.evaluate("stepIndex")
            last = page.evaluate("stepIndex === steps.length - 1")
            btn = page.locator("#next-btn")
            label = btn.inner_text()
            btn.click()
            page.wait_for_timeout(700)
            after = page.evaluate("stepIndex")
            if last:
                report.append((idx, key, "FINISH CLICKED", label))
                break
            if after == idx:
                errors = page.evaluate("[...document.querySelectorAll('.error-text.show, .field-error.show, .banner.danger')].filter(e => e.offsetParent).map(e => e.innerText.trim().slice(0, 140))")
                report.append((idx, key, "BLOCKED", errors))
                break
            report.append((idx, key, "ok", ""))
        for r in report:
            print("  step", r)
        page.wait_for_timeout(800)
        opened = page.evaluate("window.__opened")
        print("calls:", [c for c in DB["calls"] if c not in ("getLeads",)])
        print("early-capture / submitLead called:", [c for c in DB["calls"] if c in ("earlyCaptureLead", "submitLead")])
        print("LOI generator opened:", [u[:120] for u in opened])
        print("page errors:", errs[:5])
        # ---- admin screens after finishing
        page.evaluate("leavePreLoiMode()")
        page.wait_for_selector("[data-pl-sent]")
        row = page.inner_text("#preloi-entries tbody tr")
        print("Pre-LOI list row:", " | ".join(x.strip() for x in row.split("\n") if x.strip())[:170])
        print("buttons:", page.evaluate("[...document.querySelectorAll('#preloi-entries tbody tr button')].map(b => b.innerText)"))
        page.click("[data-pl-sent]"); page.wait_for_timeout(500)
        print("after LOI sent the row is still listed:", "LOI sent" in page.inner_text("#preloi-entries tbody tr"))
        page.click("[data-pl-delete]"); page.wait_for_timeout(300)   # confirm() is auto-dismissed by the dialog handler above
        page.on("dialog", lambda d: d.accept())
        page.click("#admin-tab-submissions"); page.wait_for_selector("[data-sub]")
        print("Submissions row:", " | ".join(x.strip() for x in page.inner_text("#submissions-list tbody tr").split("\n") if x.strip())[:200])
        page.click("[data-sub]"); page.wait_for_selector("#sub-doc")
        print("detail shows cross reference:", page.locator("#submission-detail td", has_text="Lead").count() > 0)
        page.fill("#sub-doc", "https://docs.google.com/document/d/abc"); page.fill("#sub-draft", "Gmail draft saved"); page.click("#sub-save"); page.wait_for_timeout(500)
        print("doc/draft saved:", DB.get("doc"), "|", DB.get("draft"))
        if "--shot" in sys.argv:
            page.screenshot(path="/tmp/walk_final.png")
        b.close()


main()
