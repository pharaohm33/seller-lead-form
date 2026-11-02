"""Bulk clean-up of Pre-LOI and Submissions (quick-select, archive / delete / restore, sent offers protected) and the Last updated column of the Leads CRM.   Run:  python tests/cleanup_check.py"""
import sys, pathlib
from playwright.sync_api import sync_playwright
SP = str(pathlib.Path(__file__).resolve().parent.parent)
bad = 0
def check(name, ok, extra=""):
    global bad; bad += not ok; print("PASS" if ok else "FAIL", name, extra)
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True); pg = b.new_page(); errs = []; dialogs = []
    pg.on("pageerror", lambda e: errs.append(str(e))); pg.on("dialog", lambda d: (dialogs.append(d.message), d.accept()))
    pg.goto("file://" + SP + "/index.html"); pg.wait_for_timeout(800)
    r = pg.evaluate("""async () => {
      const day = 86400000, ago = d => new Date(Date.now() - d * day).toISOString();
      const state = { calls: [], archived: {} }, dialogs = []; window.alert = m => dialogs.push(m); window.confirm = m => (dialogs.push(m), true);
      const PRE = [
        { crmId:"A", status:"Auto Pre-LOI Before Contact", street:"1 Stuck Rd", zip:"85701", updatedAt: ago(30) },
        { crmId:"B", status:"Auto Pre-LOI Form Completed", street:"2 Done Rd", zip:"85702", updatedAt: ago(2) },
        { crmId:"C", status:"Auto Pre-LOI LOI Sent", street:"3 Sent Rd", zip:"85703", updatedAt: ago(40) },
        { crmId:"D", status:"Auto Pre-LOI Archived", street:"4 Shelf Rd", zip:"85704", updatedAt: ago(50) },
        { crmId:"E", status:"Auto Pre-LOI Before Contact", street:"2 DONE ROAD", zip:"85702", updatedAt: ago(20) },
      ];
      const SUB = [
        { submissionId:"s1", source:"Pre-LOI form", street:"1 Stuck Rd", zip:"85701", submittedAt: ago(30), docUrl:"", draftStatus:"", leadId:"", preLoiStatus:"Auto Pre-LOI Form Completed", matches:{leads:0,preLoi:1,crm:0,submissions:1} },
        { submissionId:"s2", source:"Pre-LOI form", street:"2 Done Rd", zip:"85702", submittedAt: ago(20), docUrl:"https://docs.google.com/d", draftStatus:"Gmail draft saved", leadId:"", preLoiStatus:"Auto Pre-LOI Form Completed", matches:{leads:0,preLoi:1,crm:0,submissions:2} },
        { submissionId:"s3", source:"Pre-LOI form", street:"2 Done Rd", zip:"85702", submittedAt: ago(2), docUrl:"https://docs.google.com/d", draftStatus:"Gmail draft saved", leadId:"", preLoiStatus:"Auto Pre-LOI Form Completed", matches:{leads:0,preLoi:1,crm:0,submissions:2} },
        { submissionId:"s4", source:"Pre-LOI form", street:"3 Sent Rd", zip:"85703", submittedAt: ago(40), docUrl:"https://docs.google.com/d", draftStatus:"Gmail draft saved", leadId:"", preLoiStatus:"Auto Pre-LOI LOI Sent", matches:{leads:0,preLoi:1,crm:0,submissions:1} },
        { submissionId:"s5", source:"Public form", street:"5 Crm Rd", zip:"85705", submittedAt: ago(60), docUrl:"", draftStatus:"", leadId:"L1", leadStatus:"New", matches:{leads:1,preLoi:0,crm:0,submissions:1} },
        { submissionId:"s6", source:"Pre-LOI form", street:"6 Mail Rd", zip:"85706", submittedAt: ago(3), docUrl:"d", draftStatus:"Email sent to realtor", leadId:"", preLoiStatus:"", matches:{leads:0,preLoi:0,crm:0,submissions:1} },
      ];
      api = async (a, body) => { state.calls.push([a, body]);
        if (a === "adminGetPreLoi") return {ok:true, entries: PRE.filter(e => body.includeArchived || e.status !== "Auto Pre-LOI Archived")};
        if (a === "adminGetSubmissions") return {ok:true, total: SUB.length, submissions: SUB};
        if (a === "adminBulkPreLoi") return {ok:true, done: body.crmIds.length - 1, skipped:[{id: body.crmIds[0], street:"x", reason:"offer already sent"}]};
        if (a === "adminBulkSubmissions") return {ok:true, done: body.submissionIds.length, skipped:[]};
        return {ok:true}; };
      const wait = ms => new Promise(r => setTimeout(r, ms)), out = {};
      const ticked = wrap => Array.from(wrap.querySelectorAll("[data-cu-pick]")).filter(c => c.checked).map(c => c.dataset.cuPick).sort().join(",");
      const quick = async (wrap, mode) => { const s = wrap.querySelector("[data-cu-quick]"); s.value = mode; s.dispatchEvent(new Event("change")); await wait(30); };
      document.getElementById("admin-view").hidden = false; document.getElementById("preloi-panel").hidden = false; await loadPreLoi();
      let w = document.getElementById("preloi-entries");
      out.preloiRows = w.querySelectorAll("[data-cu-pick]").length === 4;                       // the archived one is hidden by default
      out.preloiNoArchiveOnSent = !w.querySelector('[data-cu-one="archive:C"]') && !!w.querySelector('[data-cu-one="archive:A"]');
      await quick(w, "unsent"); out.pl_unsent = ticked(w) === "A,B,E";
      await quick(w, "stuck"); out.pl_stuck = ticked(w) === "A,E";
      await quick(w, "old"); out.pl_old = ticked(w) === "A,E";
      await quick(w, "dups"); out.pl_dups = ticked(w) === "E";                                  // E is the older save of "2 Done Rd"? no: E is older than B? B 2d, E 20d -> E is the older one
      await quick(w, "none"); out.pl_none = ticked(w) === "" && w.querySelector("[data-cu-count]").textContent === "0 selected" && w.querySelector("[data-cu-act]").disabled;
      await quick(w, "stuck"); out.pl_count = w.querySelector("[data-cu-count]").textContent === "2 selected" && !w.querySelector("[data-cu-act]").disabled;
      dialogs.length = 0; state.calls.length = 0;
      w.querySelector('[data-cu-act="archive"]').click(); await wait(300);
      const bulk = state.calls.filter(c => c[0] === "adminBulkPreLoi")[0];
      out.pl_bulkCall = !!bulk && bulk[1].action === "archive" && bulk[1].crmIds.sort().join(",") === "A,E";
      out.pl_reloaded = state.calls.some(c => c[0] === "adminGetPreLoi");
      document.getElementById("preloi-show-archived").checked = true; await loadPreLoi(); w = document.getElementById("preloi-entries");
      out.pl_archivedShown = w.querySelectorAll("[data-cu-pick]").length === 5 && !!w.querySelector('[data-cu-one="restore:D"]') && w.innerText.includes("Archived");
      await quick(w, "unsent"); out.pl_archivedNotPicked = ticked(w).indexOf("D") === -1;

      document.getElementById("submissions-panel").hidden = false; await loadSubmissions();
      w = document.getElementById("submissions-list");
      out.sub_rows = w.querySelectorAll("[data-cu-pick]").length === 6;
      await quick(w, "unsent"); out.sub_unsent = ticked(w) === "s1,s2,s3";                       // not s4 (Pre-LOI sent), s5 (in the CRM) or s6 (draft status says sent)
      await quick(w, "nodoc"); out.sub_nodoc = ticked(w) === "s1";
      await quick(w, "old"); out.sub_old = ticked(w) === "s1,s2";
      await quick(w, "dups"); out.sub_dups = ticked(w) === "s2";                                 // s3 is the newest save of 2 Done Rd
      out.sub_noArchiveOnSentOrCrm = !w.querySelector('[data-cu-one="archive:s4"]') && !w.querySelector('[data-cu-one="archive:s5"]') && !w.querySelector('[data-cu-one="archive:s6"]') && !!w.querySelector('[data-cu-one="archive:s1"]');
      state.calls.length = 0;
      await quick(w, "dups"); w.querySelector('[data-cu-act="delete"]').click(); await wait(300);
      const sb = state.calls.filter(c => c[0] === "adminBulkSubmissions")[0];
      out.sub_bulkCall = !!sb && sb[1].action === "delete" && sb[1].submissionIds.join(",") === "s2";
      out.sub_archivedCheckbox = state.calls.some(c => c[0] === "adminGetSubmissions" && c[1].includeArchived === false);
      out.skippedReported = dialogs.some(d => d.includes("skipped") && d.includes("offer already sent"));

      // the Leads CRM: Last updated column, sort, and a stage change bumps it
      currentLeads.length = 0;
      currentLeads.push({ "Lead ID":"L1", "Submitted At": ago(10), "Last Updated": ago(1), "Street Address":"Old Submit, Recent Touch", "Status":"New", "Role":"Seller", notes:[] },
                        { "Lead ID":"L2", "Submitted At": ago(2), "Last Updated": ago(2), "Street Address":"New Submit, No Touch", "Status":"New", "Role":"Seller", notes:[] },
                        { "Lead ID":"L3", "Submitted At": ago(5), "Street Address":"No Stamp Yet", "Status":"New", "Role":"Seller", notes:[] });
      crmSortMode = "updated"; renderCrmTable();
      const rows = Array.from(document.querySelectorAll("#crm-tbody tr")).map(tr => tr.innerText);
      out.crm_header = Array.from(document.querySelectorAll("#crm-table-wrap .crm-table thead th")).map(th => th.textContent).slice(0, 3).join("|") === "Submitted|Last updated|Role";
      out.crm_sortUpdated = rows[0].includes("Old Submit") && rows[1].includes("New Submit") && rows[2].includes("No Stamp");
      out.crm_cells = document.querySelector("#crm-tbody tr").children.length === 12 + 1;
      const l = currentLeads[1]; const before = l["Last Updated"]; touchLeadLocal(l);
      out.crm_touch = l["Last Updated"] > before;
      return out; }""")
    for k, v in r.items(): check(k, bool(v), v if v is not True else "")
    check("no page errors", not errs, errs); b.close()
sys.exit(1 if bad else 0)
