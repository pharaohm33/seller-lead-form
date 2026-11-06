"""Offers Sent tab: accounts list, add by hand, seller responded, admin override (allow / cancel), delete / restore.   Run:  python tests/offers_check.py"""
import sys, pathlib
from playwright.sync_api import sync_playwright
SP = str(pathlib.Path(__file__).resolve().parent.parent)
bad = 0
def check(name, ok, extra=""):
    global bad; bad += not ok; print("PASS" if ok else "FAIL", name, extra)
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True); pg = b.new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("file://" + SP + "/index.html"); pg.wait_for_timeout(800)
    r = pg.evaluate("""async () => {
      const msgs = [], calls = []; window.alert = m => msgs.push(m); window.confirm = m => true;
      let promptAnswer = "";
      window.prompt = (q) => { msgs.push("PROMPT " + q); return promptAnswer; };
      const OFFER = (extra) => Object.assign({ offerId:"O1", street:"40 Offer St", city:"Tucson", state:"AZ", zip:"85720", sentAt:"2026-10-20T15:00:00Z", sentTo:"rita@broker.com", fromAccount:"old@gmail.com", source:"Sent scan", respondedAt:"", respondedNote:"", deletedAt:"", threadLink:"https://mail.google.com/x", permit:null, gate:"sent" }, extra || {});
      let offers = [OFFER()], accounts = ["old@gmail.com", "new@gmail.com"];
      api = async (a, body) => { calls.push([a, body]);
        if (a === "adminGetOffers") return { ok:true, total: offers.length, offers, accounts, permits: offers.filter(o => o.permit).map(o => o.permit) };
        if (a === "adminSetOfferAccounts") { accounts = body.accounts.split(/[ ,]+/).filter(Boolean); return { ok:true, accounts }; }
        if (a === "getLeads") return { ok:true, leads: currentLeads };
        if (a === "adminRecordOffers") return { ok:true, added:1, results:[{ status:"added" }] };
        return { ok:true }; };
      const wait = ms => new Promise(r => setTimeout(r, ms)), out = {};
      document.getElementById("admin-view").hidden = false;
      document.getElementById("admin-tab-offers").click(); await wait(150);
      out.tabShown = !document.getElementById("offers-panel").hidden && document.getElementById("preloi-panel").hidden && document.getElementById("crm-table-wrap").hidden;
      out.accountsShown = document.getElementById("offers-accounts").value === "old@gmail.com, new@gmail.com";
      document.getElementById("offers-accounts").value = "old@gmail.com, new@gmail.com, third@gmail.com"; document.getElementById("offers-accounts-save").click(); await wait(100);
      out.accountsSaved = calls.some(c => c[0] === "adminSetOfferAccounts" && /third@gmail.com/.test(c[1].accounts)) && accounts.length === 3;
      const list = document.getElementById("offers-list");
      out.row = list.innerText.includes("40 Offer St") && list.innerText.includes("Waiting on seller") && list.innerText.includes("old@gmail.com");
      out.noAllowedBadge = !list.innerText.includes("New offer allowed");
      promptAnswer = "Seller countered at 295k"; list.querySelector("[data-of-responded]").click(); await wait(100);
      const rc = calls.filter(c => c[0] === "adminMarkOfferResponded").pop();
      out.responded = !!rc && rc[1].offerId === "O1" && rc[1].note === "Seller countered at 295k";
      offers = [OFFER({ respondedAt:"2026-10-23T09:00:00Z", responseNote:"Seller countered at 295k", gate:"responded" })]; await loadOffers();
      out.respondedShown = list.innerText.includes("Seller responded") && !!list.querySelector("[data-of-reopen]") && !list.querySelector("[data-of-responded]");
      promptAnswer = "price drop"; list.querySelector("[data-of-allow]").click(); await wait(100);
      const ac = calls.filter(c => c[0] === "adminAllowNewOffer").pop();
      out.allow = !!ac && ac[1].offerId === "O1" && ac[1].reason === "price drop";
      offers = [OFFER({ permit:{ permitId:"P1", reason:"price drop" }, gate:"override" })]; await loadOffers();
      out.allowShown = list.innerText.includes("New offer allowed") && list.innerText.includes("price drop") && !!list.querySelector('[data-of-cancel="P1"]') && !list.querySelector("[data-of-allow]");
      list.querySelector("[data-of-cancel]").click(); await wait(100);
      out.cancel = calls.some(c => c[0] === "adminCancelOverride" && c[1].permitId === "P1");
      list.querySelector("[data-of-delete]").click(); await wait(100);
      out.del = calls.some(c => c[0] === "adminDeleteOffer" && c[1].offerId === "O1" && !c[1].restore);
      offers = [OFFER({ deletedAt:"2026-10-24T00:00:00Z", gate:"deleted" })]; document.getElementById("offers-show-deleted").checked = true; await loadOffers();
      out.deletedShown = list.innerText.includes("Deleted") && !!list.querySelector("[data-of-restore]") && calls.filter(c => c[0] === "adminGetOffers").pop()[1].includeDeleted === true;
      list.querySelector("[data-of-restore]").click(); await wait(100);
      out.restore = calls.some(c => c[0] === "adminDeleteOffer" && c[1].restore === true);
      document.getElementById("offers-add-address").value = "123 Main St, Tucson, AZ 85701"; document.getElementById("offers-add-to").value = "a@b.com";
      document.getElementById("offers-add-from").value = "old@gmail.com"; document.getElementById("offers-add-date").value = "2026-10-15"; document.getElementById("offers-add-btn").click(); await wait(100);
      const ar = calls.filter(c => c[0] === "adminRecordOffers").pop();
      out.manualAdd = !!ar && ar[1].offers[0].source === "Manual" && ar[1].offers[0].address === "123 Main St, Tucson, AZ 85701" && ar[1].offers[0].sentTo === "a@b.com" && ar[1].offers[0].sentAt.startsWith("2026-10-15");
      document.getElementById("admin-tab-leads").click(); await wait(50);
      out.backToLeads = document.getElementById("offers-panel").hidden && !document.getElementById("crm-table-wrap").hidden;
      // ---- Leads tab <-> Offers Sent tab ----
      offers = [OFFER({ leadId:"L9", leadStatus:"Negotiation" }), OFFER({ offerId:"O2", street:"41 Offer St", leadId:"", submissionId:"S2" }), OFFER({ offerId:"O3", street:"42 Offer St", leadId:"", submissionId:"" })]; await loadOffers();
      out.offersShowLeadStage = list.innerText.includes("Negotiation") && !!list.querySelector("[data-of-lead='L9']");
      out.offersCanAddToLeads = !!list.querySelector("[data-of-addlead='S2']") && list.innerText.includes("no lead");
      list.querySelector("[data-of-addlead='S2']").click(); await wait(100);
      const al3 = calls.filter(c => c[0] === "adminAddSubmissionToCrm").pop();
      out.addToLeadsCall = !!al3 && al3[1].submissionId === "S2" && al3[1].status === "Offer Sent";
      currentLeads = [
        { "Lead ID":"L9", "Submitted At":"2026-10-01T00:00:00Z", "Street Address":"40 Offer St", "City":"Tucson", "State":"AZ", Status:"Negotiation", Role:"Seller", notes:[], offer:{ count:1, sentAt:"2026-10-20T15:00:00Z", sentTo:"rita@broker.com", respondedAt:"2026-10-23T09:00:00Z" } },
        { "Lead ID":"L10", "Submitted At":"2026-10-02T00:00:00Z", "Street Address":"50 Waiting Rd", "City":"Tucson", "State":"AZ", Status:"Offer Sent", Role:"Seller", notes:[], offer:{ count:2, sentAt:"2026-10-25T15:00:00Z", sentTo:"x@y.com", respondedAt:"" } },
        { "Lead ID":"L11", "Submitted At":"2026-10-03T00:00:00Z", "Street Address":"60 Fresh Ln", "City":"Tucson", "State":"AZ", Status:"New", Role:"Seller", notes:[] }];
      document.getElementById("admin-tab-leads").click(); await wait(100); crmSortMode = "default"; renderCrmTable();
      const tb = () => document.getElementById("crm-tbody").innerText;
      out.leadsOfferHeader = Array.from(document.querySelectorAll("#crm-table-wrap .crm-table thead th")).map(th => th.textContent).includes("Offer");
      out.leadsShowOffers = tb().includes("Seller replied") && tb().includes("waiting on seller") && tb().includes("2 offers");
      const f = document.getElementById("crm-offer-filter");
      f.value = "waiting"; f.onchange({ target: f }); out.filterWaiting = tb().includes("50 Waiting Rd") && !tb().includes("40 Offer St") && !tb().includes("60 Fresh Ln");
      f.value = "replied"; f.onchange({ target: f }); out.filterReplied = tb().includes("40 Offer St") && !tb().includes("50 Waiting Rd");
      f.value = "none"; f.onchange({ target: f }); out.filterNone = tb().includes("60 Fresh Ln") && !tb().includes("40 Offer St") && !tb().includes("50 Waiting Rd");
      f.value = "all"; f.onchange({ target: f }); out.filterAll = tb().includes("60 Fresh Ln") && tb().includes("50 Waiting Rd");
      out.detailShowsOffer = buildLeadFields(currentLeads[1]).some(x => x[0] === "Offer" && /waiting on the seller/.test(x[1]) && /2 offers/.test(x[1]));
      document.getElementById("admin-tab-offers").click(); await wait(150);
      list.querySelector("[data-of-lead='L9']").click(); await wait(200);
      out.openLeadSwitches = !document.getElementById("crm-table-wrap").hidden && document.getElementById("offers-panel").hidden;
      // ---- one way to say where a property stands (Pre-LOI list, Submissions list) + the legend ----
      const h1 = standingHtml({ lead: { id: "L", status: "Dead" }, offer: { sentAt: "2026-11-02T03:49:00Z", respondedAt: "2026-11-03T03:35:00Z" } }), h2 = standingHtml({ lead: null, offer: null }), h3 = standingHtml({ lead: { id: "L", status: "New" }, offer: { sentAt: "2026-11-02T03:49:00Z", respondedAt: "" } });
      out.standingDead = /Lead: Dead/.test(h1) && /seller answered/.test(h1) && /991b1b/.test(h1);
      out.standingNone = /No lead/.test(h2) && /No offer sent/.test(h2);
      out.standingWaiting = /Lead: New/.test(h3) && /waiting/.test(h3);
      out.standingNoCrash = standingHtml(undefined).includes("No lead");
      const lg = document.getElementById("crm-legend"); out.legend = !!lg && /entered anywhere = no new offer/i.test(lg.textContent) && /Auto Pre-LOI Before Contact/.test(lg.textContent) && /Offers Sent/.test(lg.textContent) && /Leads/.test(lg.textContent);
      return out; }""")
    for k, v in r.items(): check(k, bool(v), v if v is not True else "")
    check("no page errors", not errs, errs); b.close()
sys.exit(1 if bad else 0)
