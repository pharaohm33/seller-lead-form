"""The updated LOI generator link has its own spot on a Pre-LOI (Details) and on a Submission, shows what changed from the generated link, and Open LOI prefers it.   Run:  python tests/updated_loi_check.py"""
import sys, json, pathlib
from playwright.sync_api import sync_playwright
SP = str(pathlib.Path(__file__).resolve().parent.parent)
bad = 0
def check(name, ok, extra=""):
    global bad; bad += not ok; print("PASS" if ok else "FAIL", name, extra)
ORIG = "https://pharaohm33.github.io/loi-generator/?purchase_price=323000&cash_at_closing=113000&sc_term=5&mode=principal_only&acq_pct=6&sub=zzz"
NEW = "https://pharaohm33.github.io/loi-generator/?purchase_price=295000&cash_at_closing=85000&sc_term=1&mode=deferred_exit&acq_pct=50"
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True); pg = b.new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e))); pg.on("dialog", lambda d: d.accept())
    pg.goto("file://" + SP + "/index.html"); pg.wait_for_timeout(800)
    r = pg.evaluate("""async ([ORIG, NEW]) => {
      const state = { upd: "" , calls: [], opened: [] };
      const ent = () => ({crmId:"X1",status:"Auto Pre-LOI Before Contact",street:"5211 E 20th St",city:"Tucson",state:"AZ",zip:"85711",askingPrice:"330000",updatedAt:"2026-10-30T12:00:00Z",
        answers:Object.assign({preLoiNotes:"NOTES", loiUrl:ORIG}, state.upd ? {updatedLoiUrl: state.upd, updatedLoiAt:"2026-10-30T13:00:00Z"} : {})});
      const sub = () => ({submissionId:"S1",source:"Pre-LOI form",street:"5211 E 20th St",city:"Tucson",state:"AZ",zip:"85711",submittedAt:"2026-10-30T12:00:00Z",crmId:"X1",loiLink:ORIG,updatedLoiLink:state.upd,updatedLoiAt:state.upd?"2026-10-30T13:00:00Z":"",related:[],matches:{leads:0,preLoi:1,crm:0,submissions:1},answers:{preLoiNotes:"NOTES"}});
      window.open = (u) => { state.opened.push(u); };
      api = async (a, body) => { state.calls.push([a, body]);
        if (a === "adminGetPreLoi") return {ok:true, entries:[ent()]};
        if (a === "adminGetPreLoiEntry") return {ok:true, entry: ent()};
        if (a === "adminSaveUpdatedLoi") { state.upd = body.loiUrl; return {ok:true}; }
        if (a === "adminGetSubmissions") return {ok:true, total:1, submissions:[sub()]};
        if (a === "adminGetSubmission") return {ok:true, submission: sub()};
        if (a === "getLeads") return {ok:true, leads:[]};
        return {ok:true}; };
      const wait = ms => new Promise(r => setTimeout(r, ms)), out = {};
      document.getElementById("admin-view").hidden = false; document.getElementById("preloi-panel").hidden = false; await loadPreLoi();
      out.hasRowBtn = !!document.querySelector("[data-pl-updloi]");
      document.querySelector("[data-pl-updloi]").click(); await wait(250);
      out.focused = document.activeElement && document.activeElement.hasAttribute("data-pd-ul-input");
      out.noChangesYet = !document.querySelector(".pl-detail-row").innerText.includes("What changed");
      document.activeElement.value = "not a link"; document.querySelector("[data-pd-ul-save]").click(); await wait(250);
      document.querySelector(".pl-detail-row [data-pd-ul-input]").value = NEW; document.querySelector("[data-pd-ul-save]").click(); await wait(400);
      const t = document.querySelector(".pl-detail-row").innerText;
      out.saveCall = state.calls.filter(c => c[0] === "adminSaveUpdatedLoi").map(c => [c[1].crmId, c[1].loiUrl === NEW]);
      out.changed = t.includes("What changed") && t.includes("323000") && t.includes("295000") && t.includes("(removed)") === false;
      out.sc_term = t.includes("5  →  1") || t.includes("5 → 1");
      out.subIgnored = !t.includes("(sub)");
      out.updBtns = !!document.querySelector("[data-pd-loi-upd]") && document.querySelector("[data-pd-loi]").innerText;
      document.querySelector("[data-pd-loi-upd]").click(); out.openedUpd = state.opened[state.opened.length - 1] === NEW;
      document.querySelector("[data-pl-loi]").click(); await wait(250); out.listOpenPrefersUpdated = state.opened[state.opened.length - 1] === NEW;
      document.getElementById("submissions-panel").hidden = false; await loadSubmissions(); document.querySelector("[data-sub]").click(); await wait(300);
      out.subShows = document.getElementById("sub-full").innerText.includes("What changed") && document.getElementById("sub-open-loi").innerText.includes("updated");
      document.querySelector("#sub-full [data-pd-ul-input]").value = NEW + "&x=1"; document.querySelector("#sub-full [data-pd-ul-save]").click(); await wait(400);
      out.subSave = state.calls.filter(c => c[0] === "adminSaveUpdatedLoi").pop()[1].submissionId === "S1" && state.upd.endsWith("&x=1");
      document.querySelector("#sub-full [data-pd-ul-clear]").click(); await wait(400); out.cleared = state.upd === "" && !document.getElementById("sub-full").innerText.includes("What changed");
      return out; }""", [ORIG, NEW])
    for k, v in r.items(): check(k, bool(v), v if not v is True else "")
    check("no page errors", not errs, errs); b.close()
sys.exit(1 if bad else 0)
