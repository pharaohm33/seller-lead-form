/* Seller Lead Intake — front end. Talks only to the Apps Script backend
   configured in config.js. No other server exists. */

const US_STATES = ["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC"];

const COMMERCIAL_SUBTYPES = ["Multifamily","Office","Hotel/Motel","Mixed Use","Industrial","Retail","Hospitality","Agriculture","Mobile Home or RV Park","Self Storage","Single Family Portfolio","Other Commercial Portfolio"];

const ADMIN_CONTACT_PHONE = "+1 520 633 6437";

// Fixed preset for the STR (short-term rental) income path -- unlike the
// long-term-rental path, the submitter never types an expense ratio here;
// this business-set 25% is applied silently on top of whatever taxes and
// insurance they enter.
const STR_EXPENSE_RATIO = 25;

// How close ARV can be to asking price (as a fraction below it) and still count as "close enough"
// for the no-rehab seller-financing-only pivot in cashDealDetails -- a judgment call, tune here.
const ARV_VS_ASKING_CLOSE_PCT = 0.05;

const LEAD_STATUSES = ["New", "Contacted", "Under Review", "Offer Sent", "Negotiation", "Verbally Accepted But Not Signed", "Offer Signed By Seller", "In Escrow To Close", "Closed", "Dead"];

const STATUS_COLORS = {
  "New": { bg: "#e5e7eb", fg: "#374151" },
  "Contacted": { bg: "#dbeafe", fg: "#1d4ed8" },
  "Under Review": { bg: "#f5e7db", fg: "#b4622a" },
  "Offer Sent": { bg: "#1e3a8a", fg: "#ffffff" },
  "Negotiation": { bg: "#111827", fg: "#ffffff" },
  "Verbally Accepted But Not Signed": { bg: "#d1fae5", fg: "#065f46" },
  "Offer Signed By Seller": { bg: "#e1efe7", fg: "#1f6f4a" },
  "In Escrow To Close": { bg: "#14532d", fg: "#ffffff" },
  "Closed": { bg: "#e5e7eb", fg: "#374151" },
  "Dead": { bg: "#fbeceb", fg: "#b3372c" }
};

function statusPillHtml(status) {
  const s = status || "New";
  const colors = STATUS_COLORS[s] || STATUS_COLORS["New"];
  return `<span class="status-pill" style="background:${colors.bg}; color:${colors.fg};">${escapeHtml(s)}</span>`;
}

// Display order, top to bottom, for the NON-ADMIN status view. Kept in
// sync manually with the identical array in backend/Code.gs (used there
// for the optional Sort Priority column) -- there's no shared-import
// between the two runtimes.
const STATUS_SORT_ORDER = [
  "In Escrow To Close",
  "Offer Signed By Seller",
  "Verbally Accepted But Not Signed",
  "Negotiation",
  "Offer Sent",
  "Under Review",
  "Contacted",
  "New",
  "Closed",
  "Dead"
];

function statusSortIndex(status) {
  const idx = STATUS_SORT_ORDER.indexOf(status || "New");
  return idx === -1 ? STATUS_SORT_ORDER.length : idx;
}

// Admin's CRM table sorts "New" above "Offer Sent" so incoming leads that
// need a first look surface without scrolling, ahead of leads that are
// already in progress and just waiting on a response. Non-admins keep the
// order above so a submitter's own "Offer Sent" leads stay easy to find.
const ADMIN_STATUS_SORT_ORDER = [
  "In Escrow To Close",
  "Offer Signed By Seller",
  "Verbally Accepted But Not Signed",
  "Negotiation",
  "New",
  "Offer Sent",
  "Under Review",
  "Contacted",
  "Closed",
  "Dead"
];

function adminStatusSortIndex(status) {
  const idx = ADMIN_STATUS_SORT_ORDER.indexOf(status || "New");
  return idx === -1 ? ADMIN_STATUS_SORT_ORDER.length : idx;
}

// "newest" ignores status entirely and sorts purely by submission date;
// "default" (or anything else) keeps the existing status-priority order,
// falling back to newest-first as the tiebreak within the same status.
function leadSortComparator(mode, statusIndexFn) {
  return (a, b) => {
    if (mode === "newest") return new Date(b["Submitted At"]) - new Date(a["Submitted At"]);
    const statusDiff = statusIndexFn(a["Status"]) - statusIndexFn(b["Status"]);
    if (statusDiff !== 0) return statusDiff;
    return new Date(b["Submitted At"]) - new Date(a["Submitted At"]);
  };
}

const FOLLOWUP_REMINDER = `<strong>Follow-up reminder:</strong> If an offer has been sent to your lead and they
  haven't signed it yet, please follow up by phone or email roughly every 7 days. Log anything they counter
  with in the notes, or text admin directly at <strong>${ADMIN_CONTACT_PHONE}</strong>. You don't need to follow
  up if admin lets you know the deal is already closing, the seller is communicating directly and consistently
  with admin, or the lead is marked Dead. When a deal closes, admin will reach out to you directly — by text for
  the banking info needed to pay you, and by email for paperwork to sign.`;

async function api(action, payload) {
  const res = await fetch(window.APP_CONFIG.APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(Object.assign({ action }, payload || {}))
  });
  return res.json();
}

/* ============================================================
   PUBLIC WIZARD
   ============================================================ */

const answers = {};

const steps = [
  {
    key: "intro",
    progress: false,
    render(root) {
      root.innerHTML = `
        <h2 class="step-title">Before You Start</h2>
        <div class="banner info">
          Any agreement on payment terms — down payment, monthly payments, timing, or price — will be
          discussed and confirmed directly with the admin you're in contact with before anything closes.
          Nothing submitted here is a binding offer.
        </div>
        <p>Admin contact: <strong>${ADMIN_CONTACT_PHONE}</strong></p>
        <p class="hint">This should take about 5 minutes. You can identify yourself as the seller, or as a
        connector/bird dog, wholesaler, realtor, consultant, associate, or referral bringing us a seller.</p>
        <p class="hint">Working with us on deal acquisitions? Use the <strong>Outreach SOP</strong> button at
        the top of the page first — it's our full playbook for sourcing, screening, and pricing these deals.
        If you're the seller yourself, no need, just continue below.</p>
        <p class="hint">If anything here is marked required and you don't have that information yet — for
        example, you're not the seller yourself and need to check with them — stop and use
        <strong>"Save My Progress"</strong> at the top of the page. That saves a link back to exactly where you
        left off (for your own use only, not for sharing with anyone else). Go get what's missing, then come
        back and pick up right where you stopped.</p>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; margin-top:24px;">
          <button class="btn primary" id="start-btn">Start</button>
          <button class="btn primary" id="intro-next-btn">Next</button>
        </div>
        <div style="margin-top:12px;">
          <button class="btn secondary" id="check-status-btn" style="width:100%;">Check Status On My Existing Leads (Non-Admin)</button>
        </div>
      `;
      root.querySelector("#start-btn").onclick = () => goTo(1);
      root.querySelector("#intro-next-btn").onclick = () => goTo(1);
      root.querySelector("#check-status-btn").onclick = () => showStatusView();
    }
  },
  {
    key: "contact",
    progress: true,
    render(root) {
      root.innerHTML = `
        <h2 class="step-title">Who You Are</h2>
        <p class="step-sub">Tell us your role and how to reach you.</p>
        <label class="field-label">Your role <span class="req">*</span></label>
        <div class="choice-group" id="role-group">
          ${["Seller","Bird Dog / Connector","Wholesaler","Realtor","Consultant","Associate","Referral Source"]
            .map(r => `<button type="button" class="choice-btn" data-value="${r}">${r}</button>`).join("")}
        </div>
        <div class="error-text" id="role-error">Please select a role.</div>

        <label class="field-label">Your name <span class="req">*</span></label>
        <input type="text" id="name-input" placeholder="Full name">
        <div class="error-text" id="name-error">Your name is required.</div>

        <label class="field-label">Email address <span class="req">*</span></label>
        <input type="email" id="email-input" placeholder="name@example.com">
        <div class="error-text" id="email-error">A valid email address is required.</div>

        <label class="field-label">Phone number <span class="req">*</span></label>
        <input type="tel" id="phone-input" placeholder="(555) 555-5555">
        <div class="error-text" id="phone-error">A phone number is required.</div>

        <label class="field-label">Social media profile link <span class="small-muted">(optional)</span></label>
        <input type="text" id="social-input" placeholder="https://...">

        <label class="field-label">Who referred you? <span class="small-muted">(optional)</span></label>
        <div class="row2">
          <div>
            <input type="text" id="referrer-name-input" placeholder="Referrer's name">
          </div>
          <div>
            <input type="tel" id="referrer-phone-input" placeholder="Referrer's phone">
          </div>
        </div>

        <div class="banner info" id="save-progress-nudge" style="margin-top:16px;" hidden>
          The next step asks for the seller/realtor/broker's contact info, which is different for
          every deal — so <strong>right now, before you fill in the next page</strong> (after you
          fill out this page), is the best time to hit <strong>"Save My Progress"</strong> at the
          top of the page and bookmark the link. Reopening it later brings you right back here with
          your own name and contact info already filled in, ready for the next seller/realtor/broker
          and address etc.
        </div>
      `;
      const saveNudge = root.querySelector("#save-progress-nudge");
      const updateSaveNudge = () => { saveNudge.hidden = !answers.role || answers.role === "Seller"; };
      updateSaveNudge();
      root.querySelectorAll("#role-group .choice-btn").forEach(btn => {
        if (btn.dataset.value === answers.role) btn.classList.add("selected");
        btn.onclick = () => {
          root.querySelectorAll("#role-group .choice-btn").forEach(b => b.classList.remove("selected"));
          btn.classList.add("selected");
          answers.role = btn.dataset.value;
          updateSaveNudge();
        };
      });
      root.querySelector("#name-input").value = answers.name || "";
      root.querySelector("#email-input").value = answers.email || "";
      root.querySelector("#phone-input").value = answers.phone || "";
      root.querySelector("#social-input").value = answers.socialLink || "";
      root.querySelector("#referrer-name-input").value = answers.referrerName || "";
      root.querySelector("#referrer-phone-input").value = answers.referrerPhone || "";
    },
    validate(root) {
      answers.name = root.querySelector("#name-input").value.trim();
      answers.email = root.querySelector("#email-input").value.trim();
      answers.phone = root.querySelector("#phone-input").value.trim();
      answers.socialLink = root.querySelector("#social-input").value.trim();
      answers.referrerName = root.querySelector("#referrer-name-input").value.trim();
      answers.referrerPhone = root.querySelector("#referrer-phone-input").value.trim();
      let ok = true;
      toggleError(root, "#role-error", !answers.role); if (!answers.role) ok = false;
      toggleError(root, "#name-error", !answers.name); if (!answers.name) ok = false;
      const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(answers.email);
      toggleError(root, "#email-error", !emailOk); if (!emailOk) ok = false;
      toggleError(root, "#phone-error", answers.phone.length < 7); if (answers.phone.length < 7) ok = false;
      return ok;
    }
  },
  {
    key: "sellerContact",
    progress: true,
    skip() { return answers.role === "Seller"; },
    render(root) {
      root.innerHTML = `
        <h2 class="step-title">Seller / Realtor / Broker Contact</h2>
        <p class="step-sub">Since you're bringing us this deal rather than being the seller yourself, we need
        a way to reach the actual seller, realtor, or broker directly.</p>
        <label class="field-label">Their name <span class="req">*</span></label>
        <input type="text" id="sc-name-input" placeholder="Full name">
        <div class="error-text" id="sc-name-error">Required.</div>

        <label class="field-label">Their phone</label>
        <input type="tel" id="sc-phone-input" placeholder="(555) 555-5555">

        <label class="field-label">Their email</label>
        <input type="email" id="sc-email-input" placeholder="name@example.com">
        <div class="error-text" id="sc-contact-error">Please provide at least a phone or an email for them.</div>
      `;
      root.querySelector("#sc-name-input").value = answers.sellerContactName || "";
      root.querySelector("#sc-phone-input").value = answers.sellerContactPhone || "";
      root.querySelector("#sc-email-input").value = answers.sellerContactEmail || "";
    },
    validate(root) {
      answers.sellerContactName = root.querySelector("#sc-name-input").value.trim();
      answers.sellerContactPhone = root.querySelector("#sc-phone-input").value.trim();
      answers.sellerContactEmail = root.querySelector("#sc-email-input").value.trim();
      let ok = true;
      toggleError(root, "#sc-name-error", !answers.sellerContactName); if (!answers.sellerContactName) ok = false;
      const hasContact = !!(answers.sellerContactPhone || answers.sellerContactEmail);
      toggleError(root, "#sc-contact-error", !hasContact); if (!hasContact) ok = false;
      return ok;
    }
  },
  {
    key: "address",
    progress: true,
    render(root) {
      root.innerHTML = `
        <h2 class="step-title">Property Address</h2>
        <p class="step-sub">Full U.S. address required for every submission.</p>
        <label class="field-label">Street address <span class="req">*</span></label>
        <input type="text" id="street-input" placeholder="123 Main St">
        <div class="error-text" id="street-error">Street address is required.</div>

        <label class="field-label">Parcel ID(s) <span class="small-muted">(optional, if known — separate multiple with commas)</span></label>
        <input type="text" id="parcel-ids-input" placeholder="e.g. 123-456-789">

        <div class="row3" style="margin-top:16px;">
          <div>
            <label class="field-label">City <span class="req">*</span></label>
            <input type="text" id="city-input">
            <div class="error-text" id="city-error">Required.</div>
          </div>
          <div>
            <label class="field-label">State <span class="req">*</span></label>
            <select id="state-input">
              <option value="">--</option>
              ${US_STATES.map(s => `<option value="${s}">${s}</option>`).join("")}
            </select>
            <div class="error-text" id="state-error">Required.</div>
          </div>
          <div>
            <label class="field-label">Zip <span class="req">*</span></label>
            <input type="text" id="zip-input" maxlength="10">
            <div class="error-text" id="zip-error">Required.</div>
          </div>
        </div>

        <div class="banner warn" id="dup-address-banner" hidden style="margin-top:16px;"></div>

        <label class="field-label">Number of units <span class="req">*</span></label>
        <input type="number" id="units-input" min="1" step="1" placeholder="e.g. 1 for a single-family home">
        <div class="error-text" id="units-error">Enter the number of units (1 or more).</div>
        <p class="hint">If this property has more than 4 units, choose <strong>Commercial Property</strong> as the asset type on the next step instead of Residential.</p>
      `;
      root.querySelector("#street-input").value = answers.street || "";
      root.querySelector("#parcel-ids-input").value = answers.parcelIds || "";
      root.querySelector("#city-input").value = answers.city || "";
      root.querySelector("#state-input").value = answers.state || "";
      root.querySelector("#zip-input").value = answers.zip || "";
      root.querySelector("#units-input").value = answers.units || "";

      const checkDupAddress = async () => {
        const street = root.querySelector("#street-input").value.trim();
        const city = root.querySelector("#city-input").value.trim();
        const state = root.querySelector("#state-input").value;
        const zip = root.querySelector("#zip-input").value.trim();
        const banner = root.querySelector("#dup-address-banner");
        if (!street || !city || !state || !zip) { banner.hidden = true; return; }
        const res = await api("checkAddressDuplicate", { street, city, state, zip, email: answers.email });
        if (!res.ok || !res.duplicate) { banner.hidden = true; return; }
        const dateStr = formatDate(res.submittedAt);
        const statusStr = res.status || "New";
        if (res.partial) {
          banner.className = res.ownedByYou ? "banner info" : "banner warn";
          banner.textContent = res.ownedByYou
            ? `You may have already submitted this as part of a multi-property (portfolio) entry on ${dateStr}. Current status: ${statusStr}.`
            : `This address may be part of a previously submitted portfolio listing (multiple properties in one entry) from ${dateStr}, currently at status "${statusStr}" — unless that was you, this lead may already belong to someone else.`;
        } else if (res.ownedByYou) {
          banner.className = "banner info";
          banner.textContent = `You already submitted this address on ${dateStr}. Current status: ${statusStr}.`;
        } else {
          banner.className = "banner warn";
          banner.textContent = `This address was already submitted on ${dateStr}, currently at status "${statusStr}" — unless that was you, this lead likely already belongs to someone else.`;
        }
        banner.hidden = false;
      };
      ["#street-input", "#city-input", "#zip-input"].forEach(sel => {
        root.querySelector(sel).addEventListener("blur", checkDupAddress);
      });
      root.querySelector("#state-input").addEventListener("change", checkDupAddress);
    },
    validate(root) {
      answers.street = root.querySelector("#street-input").value.trim();
      answers.parcelIds = root.querySelector("#parcel-ids-input").value.trim();
      answers.city = root.querySelector("#city-input").value.trim();
      answers.state = root.querySelector("#state-input").value;
      answers.zip = root.querySelector("#zip-input").value.trim();
      answers.units = root.querySelector("#units-input").value;
      let ok = true;
      toggleError(root, "#street-error", !answers.street); if (!answers.street) ok = false;
      toggleError(root, "#city-error", !answers.city); if (!answers.city) ok = false;
      toggleError(root, "#state-error", !answers.state); if (!answers.state) ok = false;
      toggleError(root, "#zip-error", !/^\d{5}(-\d{4})?$/.test(answers.zip)); if (!/^\d{5}(-\d{4})?$/.test(answers.zip)) ok = false;
      const unitsOk = Number(answers.units) >= 1;
      toggleError(root, "#units-error", !unitsOk); if (!unitsOk) ok = false;
      return ok;
    }
  },
  {
    key: "assetType",
    progress: true,
    render(root) {
      root.innerHTML = `
        <h2 class="step-title">Asset Type</h2>
        <label class="field-label">Type <span class="req">*</span></label>
        <div class="choice-group" id="top-type-group">
          ${["Commercial Property","Business","Residential Property (1-4 units)","Land"]
            .map(t => `<button type="button" class="choice-btn" data-value="${t}">${t}</button>`).join("")}
        </div>
        <div class="error-text" id="top-type-error">Please select an asset type.</div>
        <div id="sub-fields"></div>
      `;
      const subFields = root.querySelector("#sub-fields");

      function renderSub() {
        if (answers.assetType === "Commercial Property") {
          subFields.innerHTML = `
            <label class="field-label">Commercial subtype <span class="req">*</span></label>
            <select id="subtype-input">
              <option value="">--</option>
              ${COMMERCIAL_SUBTYPES.map(s => `<option value="${s}">${s}</option>`).join("")}
            </select>
            <div class="error-text" id="subtype-error">Please select a subtype.</div>
          `;
          subFields.querySelector("#subtype-input").value = answers.assetSubtype || "";
        } else if (answers.assetType === "Business") {
          subFields.innerHTML = `
            <label class="field-label">Business type <span class="req">*</span></label>
            <input type="text" id="subtype-input" placeholder="e.g. laundromat, car wash, self storage operator">
            <div class="error-text" id="subtype-error">Please describe the business type.</div>
          `;
          subFields.querySelector("#subtype-input").value = answers.assetSubtype || "";
        } else if (answers.assetType === "Residential Property (1-4 units)") {
          const units = Number(answers.units) || 1;
          const isMultiUnit = units >= 2 && units <= 4;
          if (!isMultiUnit) {
            subFields.innerHTML = `
              <div class="row2">
                <div>
                  <label class="field-label">Beds <span class="req">*</span></label>
                  <input type="number" id="beds-input" min="0" step="1">
                  <div class="error-text" id="beds-error">Required.</div>
                </div>
                <div>
                  <label class="field-label">Baths <span class="req">*</span></label>
                  <input type="number" id="baths-input" min="0" step="0.5">
                  <div class="error-text" id="baths-error">Required.</div>
                </div>
              </div>
              <label class="field-label">Square footage <span class="small-muted">(optional)</span></label>
              <input type="number" id="sqft-input" min="0" step="1">
            `;
            subFields.querySelector("#beds-input").value = answers.beds || "";
            subFields.querySelector("#baths-input").value = answers.baths || "";
            subFields.querySelector("#sqft-input").value = answers.sqft || "";
          } else {
            subFields.innerHTML = `
              <label class="field-label">Are all ${units} units the same layout (identical beds/baths)? <span class="req">*</span></label>
              <div class="choice-group" id="units-uniform-group">
                ${["Yes", "No"].map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
              </div>
              <div class="error-text" id="units-uniform-error">Please choose one.</div>
              <div id="unit-mix-sub"></div>
            `;
            const mixSub = subFields.querySelector("#unit-mix-sub");
            const renderMixSub = () => {
              if (answers.unitsUniform === "Yes") {
                mixSub.innerHTML = `
                  <div class="row2">
                    <div>
                      <label class="field-label">Beds (per unit) <span class="req">*</span></label>
                      <input type="number" id="beds-input" min="0" step="1">
                      <div class="error-text" id="beds-error">Required.</div>
                    </div>
                    <div>
                      <label class="field-label">Baths (per unit) <span class="req">*</span></label>
                      <input type="number" id="baths-input" min="0" step="0.5">
                      <div class="error-text" id="baths-error">Required.</div>
                    </div>
                  </div>
                  <label class="field-label">Square footage per unit <span class="small-muted">(optional)</span></label>
                  <input type="number" id="sqft-input" min="0" step="1">
                `;
                mixSub.querySelector("#beds-input").value = answers.beds || "";
                mixSub.querySelector("#baths-input").value = answers.baths || "";
                mixSub.querySelector("#sqft-input").value = answers.sqft || "";
              } else if (answers.unitsUniform === "No") {
                mixSub.innerHTML = `
                  <label class="field-label">Describe each unit's beds/baths <span class="req">*</span></label>
                  <input type="text" id="unit-mix-input" placeholder="e.g. Unit A: 2bd/1ba, Unit B: 3bd/2ba">
                  <div class="error-text" id="unit-mix-error">Required.</div>
                `;
                mixSub.querySelector("#unit-mix-input").value = answers.assetSubtype || "";
              } else {
                mixSub.innerHTML = "";
              }
            };
            renderMixSub();
            subFields.querySelectorAll("#units-uniform-group .choice-btn").forEach(btn => {
              if (btn.dataset.value === answers.unitsUniform) btn.classList.add("selected");
              btn.onclick = () => {
                subFields.querySelectorAll("#units-uniform-group .choice-btn").forEach(b => b.classList.remove("selected"));
                btn.classList.add("selected");
                answers.unitsUniform = btn.dataset.value;
                toggleError(subFields, "#units-uniform-error", false);
                renderMixSub();
              };
            });
          }
        } else if (answers.assetType === "Land") {
          subFields.innerHTML = `
            <label class="field-label">Acreage <span class="small-muted">(required unless square footage is filled in below)</span></label>
            <input type="number" id="acreage-input" min="0" step="0.01" placeholder="e.g. 5.25">
            <label class="field-label">Square footage <span class="small-muted">(required unless acreage is filled in above — useful for small in-town lots)</span></label>
            <input type="number" id="sqft-input" min="0" step="1">
            <div class="error-text" id="acreage-error">Enter either acreage or square footage.</div>

            <label class="field-label" style="margin-top:16px;">Zoning
              <span class="small-muted">(optional, but highly encouraged — ask the seller or look it up if you're not sure. Skip if truly unknown.)</span></label>
            <div class="choice-group" id="land-zoning-group">
              ${["Single Family", "Multifamily", "Other"].map(z => `<button type="button" class="choice-btn" data-value="${z}">${z}</button>`).join("")}
            </div>
            <div id="land-zoning-other-wrap" hidden style="margin-top:8px;">
              <input type="text" id="land-zoning-other-input" placeholder="e.g. Agricultural, Commercial, Industrial...">
            </div>
          `;
          subFields.querySelector("#acreage-input").value = answers.acreage || "";
          subFields.querySelector("#sqft-input").value = answers.sqft || "";

          const isKnownZoning = answers.landZoning === "Single Family" || answers.landZoning === "Multifamily";
          const zoningOtherValue = (!isKnownZoning && answers.landZoning) ? answers.landZoning : "";
          const selectedZoningValue = isKnownZoning ? answers.landZoning : (zoningOtherValue ? "Other" : "");
          const zoningGroup = subFields.querySelector("#land-zoning-group");
          const zoningOtherWrap = subFields.querySelector("#land-zoning-other-wrap");
          const zoningOtherInput = subFields.querySelector("#land-zoning-other-input");
          zoningOtherInput.value = zoningOtherValue;
          zoningOtherWrap.hidden = selectedZoningValue !== "Other";
          zoningGroup.querySelectorAll(".choice-btn").forEach(btn => {
            if (btn.dataset.value === selectedZoningValue) btn.classList.add("selected");
            btn.onclick = () => {
              zoningGroup.querySelectorAll(".choice-btn").forEach(b => b.classList.remove("selected"));
              btn.classList.add("selected");
              zoningOtherWrap.hidden = btn.dataset.value !== "Other";
              if (btn.dataset.value === "Other") {
                answers.landZoning = zoningOtherInput.value.trim();
                zoningOtherInput.focus();
              } else {
                answers.landZoning = btn.dataset.value;
              }
            };
          });
          zoningOtherInput.oninput = () => { answers.landZoning = zoningOtherInput.value.trim(); };
        } else {
          subFields.innerHTML = "";
        }
      }
      renderSub();

      root.querySelectorAll("#top-type-group .choice-btn").forEach(btn => {
        if (btn.dataset.value === answers.assetType) btn.classList.add("selected");
        btn.onclick = () => {
          root.querySelectorAll("#top-type-group .choice-btn").forEach(b => b.classList.remove("selected"));
          btn.classList.add("selected");
          answers.assetType = btn.dataset.value;
          answers.assetSubtype = ""; answers.beds = ""; answers.baths = ""; answers.sqft = ""; answers.unitsUniform = ""; answers.acreage = ""; answers.landZoning = "";
          // Land is cash-only for now -- Seller Financing / Creative Finance isn't offered for it,
          // so lock the deal type here and skip asking (see the dealType step's skip()).
          if (answers.assetType === "Land") answers.dealType = "Cash Deal";
          renderSub();
        };
      });
    },
    validate(root) {
      let ok = true;
      toggleError(root, "#top-type-error", !answers.assetType); if (!answers.assetType) ok = false;
      if (answers.assetType === "Land") {
        answers.acreage = root.querySelector("#acreage-input").value;
        answers.sqft = root.querySelector("#sqft-input").value;
        const hasSize = !!(answers.acreage || answers.sqft);
        toggleError(root, "#acreage-error", !hasSize); if (!hasSize) ok = false;
      } else if (answers.assetType === "Commercial Property") {
        answers.assetSubtype = root.querySelector("#subtype-input").value;
        toggleError(root, "#subtype-error", !answers.assetSubtype); if (!answers.assetSubtype) ok = false;
      } else if (answers.assetType === "Business") {
        answers.assetSubtype = root.querySelector("#subtype-input").value.trim();
        toggleError(root, "#subtype-error", !answers.assetSubtype); if (!answers.assetSubtype) ok = false;
      } else if (answers.assetType === "Residential Property (1-4 units)") {
        const units = Number(answers.units) || 1;
        const isMultiUnit = units >= 2 && units <= 4;
        if (!isMultiUnit) {
          answers.beds = root.querySelector("#beds-input").value;
          answers.baths = root.querySelector("#baths-input").value;
          answers.sqft = root.querySelector("#sqft-input").value;
          toggleError(root, "#beds-error", answers.beds === ""); if (answers.beds === "") ok = false;
          toggleError(root, "#baths-error", answers.baths === ""); if (answers.baths === "") ok = false;
        } else {
          toggleError(root, "#units-uniform-error", !answers.unitsUniform); if (!answers.unitsUniform) ok = false;
          if (answers.unitsUniform === "Yes") {
            answers.beds = root.querySelector("#beds-input").value;
            answers.baths = root.querySelector("#baths-input").value;
            answers.sqft = root.querySelector("#sqft-input").value;
            toggleError(root, "#beds-error", answers.beds === ""); if (answers.beds === "") ok = false;
            toggleError(root, "#baths-error", answers.baths === ""); if (answers.baths === "") ok = false;
          } else if (answers.unitsUniform === "No") {
            answers.assetSubtype = root.querySelector("#unit-mix-input").value.trim();
            toggleError(root, "#unit-mix-error", !answers.assetSubtype); if (!answers.assetSubtype) ok = false;
          }
        }
      }
      return ok;
    }
  },
  {
    key: "dealType",
    progress: true,
    // Land is cash-only for now -- assetType's button handler already forces
    // answers.dealType = "Cash Deal" when Land is selected, so this step has nothing to ask.
    skip() { return answers.assetType === "Land"; },
    render(root) {
      root.innerHTML = `
        <h2 class="step-title">Deal Type</h2>
        <p class="step-sub">Is this an all-cash deal, or does it need seller financing / a creative-finance structure?</p>
        <div class="choice-group" id="deal-type-group">
          ${["Cash Deal", "Seller Financing / Creative Finance"].map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
        </div>
        <div class="error-text" id="deal-type-error">Please choose one.</div>
      `;
      root.querySelectorAll("#deal-type-group .choice-btn").forEach(btn => {
        if (btn.dataset.value === answers.dealType) btn.classList.add("selected");
        btn.onclick = () => {
          root.querySelectorAll("#deal-type-group .choice-btn").forEach(b => b.classList.remove("selected"));
          btn.classList.add("selected");
          answers.dealType = btn.dataset.value;
          toggleError(root, "#deal-type-error", false);
        };
      });
    },
    validate(root) {
      const ok = !!answers.dealType;
      toggleError(root, "#deal-type-error", !ok);
      return ok;
    }
  },
  {
    key: "sourcing",
    progress: true,
    render(root) {
      root.innerHTML = `
        <h2 class="step-title">Deal Sourcing</h2>
        <label class="field-label">Is this on-market or off-market? <span class="req">*</span></label>
        <div class="choice-group" id="market-group">
          ${["On-Market", "Off-Market"].map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
        </div>
        <div class="error-text" id="market-error">Please choose one.</div>

        <label class="field-label">Link to where you found this listing <span class="small-muted">(optional)</span></label>
        <input type="text" id="source-link-input" placeholder="https://...">
      `;
      root.querySelector("#source-link-input").value = answers.sourceLink || "";
      bindChoiceGroup(root, "#market-group", "marketStatus");
    },
    validate(root) {
      answers.sourceLink = root.querySelector("#source-link-input").value.trim();
      const ok = !!answers.marketStatus;
      toggleError(root, "#market-error", !ok);
      return ok;
    }
  },
  {
    key: "price",
    progress: true,
    render(root) {
      root.innerHTML = `
        <h2 class="step-title">Price</h2>
        <label class="field-label">What price is the seller seeking? <span class="req">*</span></label>
        <input type="number" id="price-input" placeholder="$">
        <div class="error-text" id="price-error">Required.</div>

        <label class="field-label">How did they arrive at that price? <span class="req">*</span></label>
        <textarea id="reasoning-input" placeholder="e.g. recent appraisal, comparable sales, remaining loan balance plus profit, an offer they already turned down..."></textarea>
        <div class="error-text" id="reasoning-error">Please describe how the price was determined.</div>
      `;
      root.querySelector("#price-input").value = answers.priceSought || "";
      root.querySelector("#reasoning-input").value = answers.priceReasoning || "";
    },
    validate(root) {
      answers.priceSought = root.querySelector("#price-input").value;
      answers.priceReasoning = root.querySelector("#reasoning-input").value.trim();
      let ok = true;
      toggleError(root, "#price-error", !answers.priceSought); if (!answers.priceSought) ok = false;
      toggleError(root, "#reasoning-error", !answers.priceReasoning); if (!answers.priceReasoning) ok = false;
      return ok;
    }
  },
  {
    key: "rentReadyCheck",
    progress: true,
    // Only relevant for residential Seller Financing deals -- Cash Deals already get the full
    // ARV/rehab/comps workflow unconditionally, and this question doesn't map cleanly onto
    // Commercial/Business/Land the way it does a rental house. A Seller filling this out about
    // their own property always sees it regardless of which Deal Type they picked -- we want both
    // the cash and seller-financing question sets from them either way, since admin (not the
    // seller's initial guess) decides which structure the deal actually ends up using.
    skip() {
      return (answers.dealType !== "Seller Financing / Creative Finance" && answers.role !== "Seller")
        || answers.assetType !== "Residential Property (1-4 units)";
    },
    render(root) {
      root.innerHTML = `
        <h2 class="step-title">Property Condition</h2>
        <p class="step-sub">This determines what we need from you next.</p>
        <label class="field-label">Is the property currently in rent-ready condition? <span class="req">*</span></label>
        <div class="choice-group" id="rent-ready-group">
          ${["Yes", "No"].map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
        </div>
        <div class="error-text" id="rent-ready-error">Please choose one.</div>
        <p class="hint">If <strong>No</strong>, the next step walks you through the same ARV, rehab estimate,
        and comps research used for cash deals. Admin uses that alongside the seller financing terms to
        structure a blended hard money + seller carryback offer.</p>
      `;
      bindChoiceGroup(root, "#rent-ready-group", "propertyRentReady");
    },
    validate(root) {
      const ok = !!answers.propertyRentReady;
      toggleError(root, "#rent-ready-error", !ok);
      return ok;
    }
  },
  {
    key: "cashDealDetails",
    progress: true,
    // Runs for both deal types now -- Seller Financing leads need the same ARV/rehab/comps data Cash
    // Deals do, since Make Your Offers (below) generates a cash offer alongside the seller-financing
    // one regardless of which dealType was picked. The wholesale-fee/MAO ceiling UI still stays
    // hidden from the associate for Seller Financing (see isSellerFinancing in render()/validate())
    // -- that's a display choice, not a reason to skip gathering the underlying numbers.
    skip() {
      return answers.dealType !== "Cash Deal" && answers.dealType !== "Seller Financing / Creative Finance";
    },
    render(root) {
      const isSeller = answers.role === "Seller";
      // Seller Financing runs through this step too (see skip() above) so Make Your Offers always has
      // real cash-offer numbers to work with. The Wholesale Fee input itself stays hidden here for
      // Seller Financing (it always uses the standard formula, no manual override) but the resulting
      // Cash Buyer MAO banner is shown either way -- the associate needs that number for the cash half
      // of the dual offer script.
      const isSellerFinancing = answers.dealType !== "Cash Deal";
      if (isSeller) {
        // A seller filling this out about their own property has no reason to run ARV/repair
        // research or see our internal offer-ceiling math -- just get the two things we
        // actually need from them directly.
        root.innerHTML = `
          <h2 class="step-title">${isSellerFinancing ? "Property Value & Repair Research" : "Cash Deal Details"}</h2>
          <label class="field-label">Why are you looking to sell, and anything else we should know about the property? <span class="req">*</span></label>
          <textarea id="cash-notes-input" placeholder="e.g. relocating, inherited the property, tired of managing it, needs repairs I can't afford..."></textarea>
          <div class="error-text" id="cash-notes-error">Required.</div>

          <label class="field-label">Lowest price you'd accept to get this done quickly <span class="small-muted">(optional)</span></label>
          <input type="number" id="bottom-dollar-input" placeholder="$">

          <div class="banner info">Thanks for sharing this — we'll take a look and get back to you.</div>
        `;
        root.querySelector("#cash-notes-input").value = answers.cashDealNotes || "";
        root.querySelector("#bottom-dollar-input").value = answers.bottomDollarPrice || "";
        return;
      }

      const isResidential = answers.assetType === "Residential Property (1-4 units)";
      const isLand = answers.assetType === "Land";
      const hasCompsWorkflow = isResidential || isLand;
      const isOnMarket = answers.marketStatus === "On-Market";
      const addressLine = `${answers.street || ""}, ${answers.city || ""}, ${answers.state || ""} ${answers.zip || ""}`.trim();
      const arvPrompt = `how much is this worth at full market value (ARV): ${addressLine}`;
      const assessedValuePrompt = `what is the county assessed value for this property: ${addressLine}`;
      const zillowAddressSlug = `${answers.street || ""} ${answers.city || ""} ${answers.state || ""} ${answers.zip || ""}`
        .trim().replace(/[^a-zA-Z0-9]+/g, "-");
      const zillowSearchUrl = `https://www.zillow.com/homes/${zillowAddressSlug}_rb/`;
      // Depends on the current ARV input value, so it's rebuilt live in recomputeCashDeal() rather
      // than computed once here -- feeding the current ARV back into the repair prompt lets the AI
      // estimate repairs against an actual target value instead of guessing blind. By the time repair
      // costs matter, that ARV is usually the AI-CMA-refined number (see Step 2 above), not Chase's
      // quick estimate, so it isn't attributed to a specific source here anymore.
      const buildRepairPrompt = (arv) => {
        const arvPart = arv ? ` to reach an ARV of $${Number(arv).toLocaleString()}` : "";
        // This deal doesn't add or convert bedrooms/bathrooms, so tell the AI to price the repair
        // for the CURRENT bed/bath count, not a hypothetical one -- this doesn't limit the repair
        // scope itself, which can still run anywhere from light cosmetic to a full gut.
        const bedBathPart = (isResidential && answers.beds && answers.baths)
          ? ` It's currently ${answers.beds} bed / ${answers.baths} bath -- estimate repair costs for that existing layout (however light or heavy the work actually is), with no bedroom or bathroom additions or conversions planned.`
          : "";
        return `how much fix and flip investor repair is needed at ${addressLine}${arvPart}?${bedBathPart} ${zillowSearchUrl}`;
      };
      const googleAiHow = `go to <strong>google.com</strong> and search anything (typing "ai" works fine, or just the
        address) — once results load, look at the row of tabs near the top of the page (next to "All", "Images",
        "News", "Shopping") and click <strong>"AI Mode"</strong>`;
      root.innerHTML = `
        <h2 class="step-title">${isSellerFinancing ? "Property Value & Repair Research" : "Cash Deal Details"}</h2>

        ${isResidential ? (isSellerFinancing ? `
          <p class="hint"><strong>Step 1 — get a baseline from Chase.</strong> Use
          <a href="https://www.chase.com/personal/mortgage/calculators-resources/home-value-estimator" target="_blank" rel="noopener">Chase's Home Value Estimator</a>
          for this address. If a value comes up: if <strong>no repairs are needed</strong>, that's your As-Is
          Value too (enter the same number as ARV below). If <strong>repairs are needed</strong>, use that
          Chase number as your <strong>ARV</strong> — As-Is Value will be computed below by subtracting your
          repair estimate.</p>
          <p class="hint"><strong>Step 2 — refine with Google AI if you have time.</strong> Tap
          <strong>"Get Comps Research Prompt for Google AI"</strong> below — it's pre-filled with this
          property's details, so all you have to do is copy it, paste it into Google AI, and see what comes
          back. Then <strong>replace the ARV above</strong> with the more accurate number Google AI
          calculates from real recent sales (or find one from scratch if Chase didn't have data):</p>
        ` : `
          <p class="hint"><strong>Step 1 — get a fast first offer from Chase.</strong> Use
          <a href="https://www.chase.com/personal/mortgage/calculators-resources/home-value-estimator" target="_blank" rel="noopener">Chase's Home Value Estimator</a>
          for this address. If a value comes up: if <strong>no repairs are needed</strong>, that's your As-Is
          Value too (enter the same number as ARV below). If <strong>repairs are needed</strong>, use that
          Chase number as your <strong>ARV</strong> — As-Is Value will be computed below by subtracting your
          repair estimate. For your first offer to the seller, start at the <strong>lowest</strong> of the
          calculated Max Allowable Offer figures below (not the Cash Buyer ceiling) — that gets a
          conservative opening offer out fast, without needing full comps research yet.</p>
          <p class="hint"><strong>Step 2 — if the seller counters, all you have to do is press the
          button below.</strong> Chase's number is enough for a fast first offer, but if the seller comes
          back asking for more, tap <strong>"Get Comps Research Prompt for Google AI"</strong> below to
          find out whether there's actually room to go higher — it's pre-filled with this property's
          details, so all you have to do is copy it, paste it into Google AI, and see what comes back.
          Then <strong>replace the ARV above</strong> with the more accurate number Google AI calculates
          from real recent sales (or find one from scratch if Chase didn't have data):</p>
        `) : isLand ? `
          <p class="hint"><strong>Research this with Google AI.</strong> There's no bank estimator for land
          like there is for homes, so Google AI Mode is your primary source for value and comps here:</p>
        ` : ""}
        ${hasCompsWorkflow ? `
          <ol class="hint" style="margin:0 0 10px 18px; padding:0;">
            <li>Go to <strong>google.com</strong>, search anything (typing "ai" works fine), and click the
            <strong>"AI Mode"</strong> tab near the top of the results.</li>
            <li>Tap <strong>"Get Comps Research Prompt for Google AI"</strong> below, hit <strong>Copy</strong>,
            and paste it into AI Mode.</li>
            <li>Google AI will pull real recent comps and calculate ${isLand ? "a value range" : "an ARV range"}
            for you — this is your CMA (Comparative Market Analysis).</li>
            <li>Screenshot the <strong>full</strong> response (the comps list AND the calculations at the
            bottom) and upload it below. If it doesn't fit in one screenshot, upload as many as you need —
            we'd rather have the whole thing than a partial one.</li>
            <li><strong>Review it before trusting it</strong> — read back through the comps and math and
            make sure it actually looks right for this property. If anything seems off (a comp that's too
            far away, in different condition than claimed, math that doesn't add up, etc.), write that in
            Notes below so admin can see your reasoning.</li>
          </ol>
          ${isResidential ? `
            <p class="hint"><strong>This deal doesn't add beds or baths.</strong> Comps should match
            the subject's current bed/bath count — if the CMA leans on comps with more beds or baths than
            this property has, that overstates the ARV for a change this deal won't actually make. The
            comps prompt below already tells Google AI to match bed/bath count for this reason.</p>
          ` : ""}
          ${isLand ? `
            <p class="hint"><strong>For land, what a comp has in common matters more than how close it is.</strong>
            A comp must match on <strong>zoning</strong> (never compare commercial-zoned to residential-zoned
            land), <strong>topography/usability</strong> (a flat, buildable lot isn't comparable to a steep or
            landlocked one), and <strong>access/utilities</strong> (paved road + power vs. off-grid/no access) —
            these matter more than distance. Only once a comp matches on those should distance be weighed: expect
            roughly <strong>1–5 miles</strong> in suburban areas and <strong>10–50+ miles</strong> in rural or
            remote areas with few land sales. A comp farther away that matches on zoning/topography/access beats
            a closer one that doesn't.</p>
            <p class="hint"><strong>Recency:</strong> comps sold within the last <strong>6 months</strong> are
            ideal. Up to <strong>12 months</strong> is fine in a normal market, and up to
            <strong>24 months</strong> is standard in slow or rural markets with few sales. Any comp older than
            6 months should have its price <strong>adjusted for how the market has moved</strong> since that
            sale, not used as a raw historical number — Google AI will handle that math.</p>
            <p class="hint">Only fall back to your own hand-picked comps if AI Mode can't find anything usable —
            same zoning/topography/access rules apply, and try to match similar acreage and land type. Note what
            you found in Notes below. Lean toward the lowest comps or an average — never cherry-pick the highest
            value in the area, since that usually doesn't sell.</p>
          ` : `
            <p class="hint"><strong>Comps must be within a 1-mile radius of the property — no exceptions.</strong>
            Comps farther out drastically reduce the chance this deal actually closes, so be very cautious about
            using anything beyond 1 mile. Comps should also be no more than <strong>1 year old</strong>, and
            ideally <strong>under 6 months old</strong> — the fresher the better.</p>
            <p class="hint">Only fall back to your own hand-picked comps if AI Mode can't find anything usable —
            same rules apply (within 1 mile, ideally under 6 months old, same beds, same baths, similar square
            footage), and note what you found in Notes below. Lean toward the lowest comps or an average — never
            cherry-pick the highest ARV in the area, since that usually doesn't sell.</p>
          `}

          <button type="button" class="link-btn" id="comps-prompt-toggle-btn">Get Comps Research Prompt for Google AI &#9662;</button>
          <div id="comps-prompt-panel" hidden style="margin-top:10px;">
            <p class="hint">This is pre-filled with the address/${isLand ? "acreage or square footage" : "beds/baths/sqft"}
            already on file. Copy it, ${googleAiHow}, and paste it in.</p>
            <textarea id="comps-prompt-text" readonly rows="16" style="width:100%; font-size:12px; font-family:'IBM Plex Mono', ui-monospace, monospace;"></textarea>
            <button type="button" class="btn secondary" id="comps-prompt-copy-btn" style="margin-top:8px;">Copy Prompt</button>
          </div>

          <label class="field-label" style="margin-top:16px;">CMA Screenshots
            <span class="small-muted">(optional, but strongly encouraged — upload one or more)</span></label>
          <input type="file" id="cma-screenshots-input" accept="image/*" multiple>
          <div id="cma-screenshots-list" style="margin-top:8px;"></div>
        ` : ""}

        ${isResidential ? `
          <label class="field-label">Chase Bank Estimated Value
            <span class="small-muted">(optional — the raw number from Chase's Home Value Estimator, for admin's reference alongside the ARV below)</span></label>
          <input type="number" id="chase-estimate-input" placeholder="$">

          <label class="field-label">Asking Price <span class="req">*</span>
            <span class="small-muted">(what the seller is asking/listing for)</span></label>
          <input type="number" id="asking-price-input" placeholder="$">
          <div class="error-text" id="asking-price-error">Required.</div>
        ` : ""}

        <label class="field-label">${isLand ? "As-Is Value" : "ARV"}
          <span class="small-muted">${isLand ? "(current market value — land offers are based on this directly, not a post-repair value)" : "(After Repair Value)"}</span>${isResidential ? "" : ` <span class="req">*</span>`}</label>
        <input type="number" id="arv-input" placeholder="$">
        <div class="error-text" id="arv-error">Required.</div>
        ${!hasCompsWorkflow ? `
          <p class="hint">${googleAiHow}, copy a listing link if you have one (or just use the address), then ask:
          <br><span class="small-muted">"${arvPrompt}"</span></p>
        ` : ""}
        ${isResidential ? `<div class="banner danger" id="arv-vs-asking-banner" hidden style="margin-top:12px;"></div>` : ""}

        <label class="field-label">Pictures Link <span class="small-muted">(optional, if available)</span></label>
        <input type="text" id="pictures-link-input" placeholder="https://...">

        ${!isLand ? `
          <label class="field-label">Rehab Estimate — Low <span class="small-muted">(optional, if known)</span></label>
          <input type="number" id="rehab-low-input" placeholder="$">
          <label class="field-label">Rehab Estimate — High</label>
          <input type="number" id="rehab-high-input" placeholder="$">
          <p class="hint">To estimate this, ${googleAiHow}. It's important to also give it the for-sale listing
          link or a link to pictures of the property so it can actually see the property's condition — a repair
          estimate without pictures is just a guess.${isResidential ? ` <strong>No bedroom or bathroom
          additions</strong> — this deal doesn't add or convert them, though the repair itself can
          still run as light or as heavy as the property actually needs.` : ""} Then ask:
          <br><span class="small-muted" id="repair-prompt-hint"></span>
          <br><button type="button" class="btn secondary" id="repair-prompt-copy-btn" style="margin-top:8px;">Copy Prompt</button>
          </p>
          <div class="banner info" id="rehab-average-banner" hidden></div>

          ${hasCompsWorkflow ? `<div class="banner info" id="as-is-value-banner" hidden></div>` : ""}
        ` : ""}

        <label class="field-label">County Assessed Value <span class="small-muted">(optional, if known)</span></label>
        <input type="number" id="assessed-value-input" placeholder="$">
        <p class="hint">Don't have this handy? ${googleAiHow}, then ask:
        <br><span class="small-muted">"${assessedValuePrompt}"</span>
        <br><button type="button" class="btn secondary" id="assessed-value-prompt-copy-btn" style="margin-top:8px;">Copy Prompt</button>
        </p>

        <label class="field-label">Lowest price they'd accept to close quickly <span class="small-muted">(their bottom dollar — we'll see if we can make that work with the acquisition team, optional)</span></label>
        <input type="number" id="bottom-dollar-input" placeholder="$">

        <label class="field-label">Notes: why does the seller want to sell / what makes this a good lead?
          <span class="small-muted" id="cash-notes-hint"></span></label>
        <textarea id="cash-notes-input" placeholder="e.g. motivated seller, inherited property, tired landlord, needs to relocate..."></textarea>
        <div class="error-text" id="cash-notes-error">Since pictures${isLand ? "" : ", rehab estimate,"} and assessed value are all blank, please describe why this is a good lead.</div>

        ${!isSellerFinancing ? `
          <label class="field-label" style="margin-top:16px;">Wholesale Fee
            <span class="small-muted">(auto-filled at the greater of $25,000 or 3% of ${isLand ? "As-Is Value" : "ARV"} — override with a smaller number if you've negotiated one down for this deal)</span></label>
          <input type="number" id="wholesale-fee-input" placeholder="$">
        ` : `
          <div class="banner info" style="margin-top:16px;">Seller financing terms get structured from
          later steps — the Cash Buyer MAO below is calculated automatically (standard wholesale fee
          formula, no override) and feeds the cash-offer option in Make Your Offers.</div>
        `}

        ${isOnMarket ? `
          <p class="hint" style="margin-top:16px;"><em>Pricing guidance: for best results, aim for around 70% of
          the price posted online for an accepted offer. Only use our highest MAO as a last resort, and round
          down to the nearest $5,000. The tighter the deal, the less likely it is to sell.</em></p>
        ` : ""}

        <div class="banner warn" id="max-offer-banner" hidden style="margin-top:16px;"></div>
        <div class="banner warn" id="assessed-max-offer-banner" hidden style="margin-top:16px;"></div>
      `;
      root.querySelector("#arv-input").value = answers.arv || "";
      if (isResidential) {
        root.querySelector("#chase-estimate-input").value = answers.chaseEstimate || "";
        root.querySelector("#asking-price-input").value = answers.askingPrice || "";
      }
      root.querySelector("#pictures-link-input").value = answers.picturesLink || "";
      if (!isLand) {
        root.querySelector("#rehab-low-input").value = answers.rehabEstimateLow || "";
        root.querySelector("#rehab-high-input").value = answers.rehabEstimateHigh || "";
      }
      root.querySelector("#assessed-value-input").value = answers.countyAssessedValue || "";
      root.querySelector("#bottom-dollar-input").value = answers.bottomDollarPrice || "";
      root.querySelector("#cash-notes-input").value = answers.cashDealNotes || "";
      if (!isSellerFinancing) root.querySelector("#wholesale-fee-input").value = answers.wholesaleFee || "";
      // Once a fee is already on file (fresh input, or restored from a save/resume link) treat it as
      // deliberately set and stop auto-overwriting it as ARV changes -- only a truly untouched field
      // keeps tracking the formula live.
      let feeManuallyEdited = !!answers.wholesaleFee;

      const recomputeCashDeal = () => {
        // Land has no Rehab Estimate inputs -- offers run purely off the As-Is Value entered above,
        // so rehab stays 0 and never gets subtracted from anything below.
        const rehabLow = isLand ? 0 : (Number(root.querySelector("#rehab-low-input").value) || 0);
        const rehabHigh = isLand ? 0 : (Number(root.querySelector("#rehab-high-input").value) || 0);
        const hasSupplementary = !!(root.querySelector("#pictures-link-input").value.trim()
          || rehabLow || rehabHigh
          || root.querySelector("#assessed-value-input").value);
        root.querySelector("#cash-notes-hint").textContent = hasSupplementary
          ? "(optional)"
          : `(required since pictures${isLand ? "" : "/rehab estimate"}/assessed value are all blank)`;

        const arv = Number(root.querySelector("#arv-input").value) || 0;
        const rehab = rehabLow && rehabHigh ? (rehabLow + rehabHigh) / 2 : (rehabLow || rehabHigh || 0);

        if (!isLand) {
          root.querySelector("#repair-prompt-hint").textContent = `"${buildRepairPrompt(arv)}"`;
          const rehabAverageBanner = root.querySelector("#rehab-average-banner");
          if (rehabLow && rehabHigh) {
            rehabAverageBanner.hidden = false;
            rehabAverageBanner.innerHTML = `<strong>Rehab Estimate (average):</strong> $${rehab.toLocaleString(undefined, {maximumFractionDigits: 0})}
              <span class="small-muted">(average of your $${rehabLow.toLocaleString()} low and $${rehabHigh.toLocaleString()} high)</span>`;
          } else {
            rehabAverageBanner.hidden = true;
          }

          if (hasCompsWorkflow) {
            const asIsBanner = root.querySelector("#as-is-value-banner");
            if (!arv) {
              asIsBanner.hidden = true;
            } else {
              asIsBanner.hidden = false;
              asIsBanner.innerHTML = `<strong>As-Is Value:</strong> $${(arv - rehab).toLocaleString(undefined, {maximumFractionDigits: 0})}
                <span class="small-muted">(ARV minus the repair estimate)</span>`;
            }
          }
        }

        // A rehab deal needs ARV meaningfully ABOVE asking (that gap is the whole value-add play,
        // and it backs the 1-year seller-financing balloon at full appraised value). A no-rehab deal
        // has no way to raise value above asking (as-is value and ARV are the same thing), so it's
        // only viable if ARV lands AT OR very near asking -- that's exactly the case the 5-15 year
        // full-asking-price seller-financing balloon is built for. Below that gap either way, there's
        // no margin for a cash purchase and no case for a seller-financing pivot -- stop the deal.
        // "Very close" is a judgment call, set at 5% here; adjust ARV_VS_ASKING_CLOSE_PCT if that's
        // too tight or too loose in practice.
        if (isResidential) {
          const askingPrice = Number(root.querySelector("#asking-price-input").value) || 0;
          const arvVsAskingBanner = root.querySelector("#arv-vs-asking-banner");
          const needsRehabLive = rehab > 0;
          if (!arv || !askingPrice) {
            arvVsAskingBanner.hidden = true;
            answers.arvBelowAskingBlocked = false;
            answers.forcedSellerFinancingOnly = false;
          } else if (arv < askingPrice) {
            const gapPct = (askingPrice - arv) / askingPrice;
            if (!needsRehabLive && gapPct <= ARV_VS_ASKING_CLOSE_PCT) {
              arvVsAskingBanner.hidden = false;
              arvVsAskingBanner.className = "banner warn";
              arvVsAskingBanner.innerHTML = `<strong>ARV is close to asking price and this property needs
                no rehab.</strong> A cash offer will not work here -- moving forward switches this to a
                seller financing offer only, at full asking price, and only works if the property will
                cash flow as a long term or short term rental (checked on the next income step).`;
              answers.arvBelowAskingBlocked = false;
              answers.forcedSellerFinancingOnly = true;
            } else {
              arvVsAskingBanner.hidden = false;
              arvVsAskingBanner.className = "banner danger";
              arvVsAskingBanner.innerHTML = `<strong>This deal does not pencil.</strong> ARV needs to be at
                or above the asking price${needsRehabLive ? ", and meaningfully higher once rehab is factored in," : ""}
                for this to work as either a cash purchase or a seller financing offer. Stop here and move
                on to another opportunity -- this lead can't be submitted with these numbers.`;
              answers.arvBelowAskingBlocked = true;
              answers.forcedSellerFinancingOnly = false;
            }
          } else {
            arvVsAskingBanner.hidden = true;
            answers.arvBelowAskingBlocked = false;
            answers.forcedSellerFinancingOnly = false;
          }
        }

        {
          const feeInput = isSellerFinancing ? null : root.querySelector("#wholesale-fee-input");
          const formulaFee = arv ? Math.max(25000, 0.03 * arv) : 0;
          if (feeInput && !feeManuallyEdited) feeInput.value = formulaFee || "";
          const wholesaleFee = feeInput ? (Number(feeInput.value) || formulaFee) : formulaFee;

          const maxOfferBanner = root.querySelector("#max-offer-banner");
          const maoSuite = computeMaoSuite(arv, rehab, answers.assetType, wholesaleFee);
          if (!maoSuite) {
            maxOfferBanner.hidden = true;
          } else {
            const fmt = n => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
            maxOfferBanner.hidden = false;
            maxOfferBanner.innerHTML = `
              <strong>Cash Buyer MAO:</strong> ${fmt(maoSuite.maoCash)}
              <br><span class="small-muted">(${maoSuite.cashExplanation})</span>
              <hr style="border: none; border-top: 1px solid currentColor; opacity: 0.2; margin: 10px 0;">
              <strong>Hard Money Buyer MAO (${maoSuite.hm10Label} Down):</strong> ${fmt(maoSuite.maoHardMoney10)}
              <br><span class="small-muted">(${maoSuite.hm10Explanation})</span>
              <hr style="border: none; border-top: 1px solid currentColor; opacity: 0.2; margin: 10px 0;">
              <strong>Hard Money Buyer MAO (${maoSuite.hm20Label} Down):</strong> ${fmt(maoSuite.maoHardMoney20)}
              <br><span class="small-muted">(${maoSuite.hm20Explanation})</span>
              <br><br><strong>Start well below the Cash Buyer number and try to close there in negotiation.</strong>
              <br><span class="small-muted">The hard money numbers show what a leveraged buyer could still pay and
              hit the same target return, since less of their own cash is tied up in the deal — useful when
              presenting to a hard-money buyer, or to justify going higher if the seller won't move off a price
              above the Cash Buyer number after you've already started low. This can take a while — use
              "Save My Progress" at the top of the page to pause here and come back once the seller has agreed
              to a number.</span>
            `;
          }

          // Off-market negotiating strategy: county assessed value if we have it, otherwise fall
          // back to As-Is Value (ARV minus repairs) as the alternative base. This is a
          // talking-point number for working an off-market seller down, not the internal ceiling
          // -- county/as-is values are usually higher than a true ARV-based max offer, so cite the
          // high end of the repair estimate against this bigger, official-sounding number to
          // justify why the price needs to land near it. Only relevant off-market: on-market deals
          // already have a real listing/comps to negotiate against, so this trick doesn't apply.
          // County assessed value is a raw pre-repair-style figure (repairs get subtracted below);
          // As-Is Value already has repairs baked in, so it doesn't get subtracted again.
          const isOffMarket = answers.marketStatus === "Off-Market";
          const assessedValue = Number(root.querySelector("#assessed-value-input").value) || 0;
          const asIsValue = arv ? Math.max(arv - rehab, 0) : 0;
          const usingAssessed = assessedValue > 0;
          const negotiationBase = usingAssessed ? assessedValue : asIsValue;
          const negotiationLabel = usingAssessed ? "county assessed value" : (isLand ? "As-Is Value" : "As-Is Value (ARV minus repairs)");
          const assessedMaxOfferBanner = root.querySelector("#assessed-max-offer-banner");
          if (!isOffMarket || !negotiationBase) {
            assessedMaxOfferBanner.hidden = true;
          } else {
            const discountedBase = 0.90 * negotiationBase;
            // Same 8% selling costs (realtor commission + escrow/title fees) the main MAO formula
            // subtracts from ARV -- this banner was missing it entirely, which overstated the ceiling.
            const ceilingSellingCosts = 0.08 * negotiationBase;
            const negotiationOffer = usingAssessed
              ? (discountedBase - rehab - ceilingSellingCosts - wholesaleFee)
              : (discountedBase - ceilingSellingCosts - wholesaleFee);
            assessedMaxOfferBanner.hidden = false;
            assessedMaxOfferBanner.innerHTML = `
              <strong>Off-Market Negotiating Ceiling:</strong> $${negotiationOffer.toLocaleString(undefined, {maximumFractionDigits: 0})}
              <span class="small-muted">(90% of $${negotiationBase.toLocaleString()} ${negotiationLabel},
              ${(usingAssessed && !isLand) ? `minus $${rehab.toLocaleString()} repairs, ` : ""}minus $${ceilingSellingCosts.toLocaleString(undefined, {maximumFractionDigits: 0})}
              selling costs (8% of ${negotiationLabel} — realtor commission plus escrow/title fees), minus your
              $${wholesaleFee.toLocaleString(undefined, {maximumFractionDigits: 0})} wholesale fee)</span>
              <br><span class="small-muted">This is a negotiating tool for off-market deals, not a hard cap like
              the Max Offer above. Use the ${negotiationLabel} as your ceiling with the seller and cite the high end
              of your repair estimate to make the case for why the price needs to come down near here.</span>
            `;
          }
        }
      };
      const recomputeTriggerSelectors = ["#arv-input", "#pictures-link-input", "#assessed-value-input"];
      if (!isLand) recomputeTriggerSelectors.push("#rehab-low-input", "#rehab-high-input");
      if (isResidential) recomputeTriggerSelectors.push("#asking-price-input");
      recomputeTriggerSelectors.forEach(sel => {
        root.querySelector(sel).oninput = recomputeCashDeal;
      });
      if (!isSellerFinancing) {
        root.querySelector("#wholesale-fee-input").oninput = () => {
          feeManuallyEdited = true;
          recomputeCashDeal();
        };
      }

      if (!isLand) {
        root.querySelector("#repair-prompt-copy-btn").onclick = () => {
          const arv = Number(root.querySelector("#arv-input").value) || 0;
          const text = buildRepairPrompt(arv);
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => {
              alert("Prompt copied to clipboard.");
            }).catch(() => {
              prompt("Copy this prompt:", text);
            });
          } else {
            prompt("Copy this prompt:", text);
          }
        };
      }

      wireCopyPromptButton(root, "#assessed-value-prompt-copy-btn", () => assessedValuePrompt);

      if (hasCompsWorkflow) {
        const compsPromptToggleBtn = root.querySelector("#comps-prompt-toggle-btn");
        const compsPromptPanel = root.querySelector("#comps-prompt-panel");
        compsPromptToggleBtn.onclick = () => {
          compsPromptPanel.hidden = !compsPromptPanel.hidden;
          compsPromptToggleBtn.innerHTML = compsPromptPanel.hidden
            ? "Get Comps Research Prompt for Google AI &#9662;"
            : "Hide Comps Research Prompt &#9652;";
        };
        // Address/beds/baths/sqft (or acreage, for land) are already on file by this point in the
        // wizard (collected in the address and asset type steps) -- pre-fill the prompt with them
        // instead of leaving the associate to retype everything by hand.
        const detailsPart = isLand
          ? (answers.acreage
              ? `${answers.acreage} acre(s)${answers.sqft ? ` (${answers.sqft} square feet)` : ""}${answers.landZoning ? `, zoned ${answers.landZoning}` : ""}`
              : (answers.sqft ? `${answers.sqft} square feet${answers.landZoning ? `, zoned ${answers.landZoning}` : ""}` : "[ACREAGE/SQUARE FEET]"))
          : (answers.beds && answers.baths
              ? `${answers.beds} bedroom(s), ${answers.baths} bathroom(s), ${answers.sqft ? answers.sqft + " square feet" : "[SQUARE FEET]"}`
              : (answers.sqft ? `${answers.sqft} square feet` : "[BEDROOMS/BATHROOMS/SQUARE FEET]"));
        // Land runs on its own template rather than sharing residential's via ternaries -- the
        // underlying methodology genuinely differs (utility/zoning-match-first, distance-second,
        // time-adjusted comps for land vs. a flat distance cutoff for homes), so weaving them
        // together got harder to read than just writing two prompts.
        root.querySelector("#comps-prompt-text").value = isLand
? `Act as a professional real estate data analyst specializing in land valuation. Explain your math simply and avoid real estate jargon — I have no real estate experience.

Find recent comparable land sales (comps) and an estimated As-Is Value (current market value — this is NOT an after-repair or projected value, land doesn't get "fixed up") for this property:
- Address: ${addressLine || "[SUBJECT ADDRESS]"}
- Details: ${detailsPart}

For land, what a comp has in common matters more than how close it is. Search live for 3 to 5 properties that meet ALL of these rules, in this order of importance:
1. Identical or equivalent zoning to the subject property — never treat a commercially-zoned parcel as comparable to a residentially-zoned one, even if they're next to each other.
2. Comparable topography and usability — a flat, buildable lot is not comparable to a steep, unusable, or landlocked one without a clear value adjustment. Note each comp's topography and any notable features (wooded, cleared, waterfront, floodplain, etc.).
3. Comparable access and utilities — road access (paved vs. dirt vs. none) and utility hookups (electric, water, septic/sewer) should be similar, or clearly flagged as different along with how that affects value.
4. Similar in acreage (or square footage, for small in-town lots) to the subject property — avoid comps that are dramatically larger or smaller.

Only after a comp passes ALL four rules above should distance be weighed — prefer the closest qualifying comps, but a comp farther away that matches on zoning/topography/access beats a closer one that doesn't. As a rough guide, expect comps within about 1 to 5 miles in suburban areas, and 10 to 50+ miles in rural or remote areas with few land sales — state each comp's straight-line distance, and note if you had to go unusually far to find a qualifying match.

Recency: comps sold within the last 6 months are ideal. Up to 12 months is acceptable in a normal market. In slow or rural markets with low transaction volume, going back up to 24 months is standard practice. For any comp older than 6 months, apply a reasonable adjustment to its sale price to reflect market movement (appreciation or depreciation) between the sale date and today, show that adjustment explicitly, and use the adjusted price (not the raw historical price) in the calculation below.

If this is a non-disclosure state and you can't find actual sold prices, use active for-sale listings instead that meet the other rules, and clearly label them as asking prices, not confirmed sale prices.

For each comp, list:
- Full address
- Sale price (or asking price, if using the non-disclosure fallback) and the date
- Zoning, topography, and access/utilities
- Straight-line distance from the subject address, in miles
- Total acreage (and square footage, if it's a small lot)
- Price per Acre (or Price per Square Foot for small lots) — show both the raw price and, for comps older than 6 months, the time-adjusted price

After listing the comps, calculate and show your work:
1. Acreage Difference %: (Average Comp Acreage - Subject Acreage) / Subject Acreage x 100
2. Estimated As-Is Value: Average (time-adjusted) Price per Acre of the comps x Subject Acreage — give a final range, not just one number.

If the value comes out lower than what you might initially expect, say so plainly — that's an important finding, not something to smooth over.`
: `Act as a professional real estate data analyst. Explain your math simply and avoid real estate jargon — I have no real estate experience.

Find recent comparable sales (comps) and an estimated After Repair Value (ARV) for this property:
- Address: ${addressLine || "[SUBJECT ADDRESS]"}
- Details: ${detailsPart}

Search live for 3 to 5 properties that meet ALL of these rules:
1. Sold within the last 12 months — strongly prefer comps sold within the last 6 months if there are enough to choose from. Comps older than 12 months don't count, no exceptions.
2. Within a MAXIMUM of 1-mile STRAIGHT-LINE distance from the subject address (as the crow flies, not driving distance) — this is a hard limit, not a target, closer is always better. State your estimated straight-line distance for each one explicitly, and flag it clearly if you had to go close to the 1-mile edge because nothing closer was available.
3. In excellent, fully remodeled, or brand-new condition — skip anything described as a fixer-upper, needing TLC, sold as-is, or a renovation/investment project.
4. Same bedroom and bathroom count as the subject property (or as close as possible) — no bedroom or bathroom additions or conversions are planned, so a comp with more beds or baths would overstate what this property can actually sell for as-is. Also ideally a small starter home or bungalow, similar in size and character to the subject property.

If this is a non-disclosure state and you can't find actual sold prices, use active for-sale listings instead that meet the other three rules, and clearly label them as asking prices, not confirmed sale prices.

For each comp, list:
- Full address
- Exact sale price (or asking price, if using the non-disclosure fallback) and the date
- Estimated straight-line distance from the subject address, in miles
- Bedrooms, bathrooms, and total square feet
- Exact Price per Square Foot (price ÷ square feet)

After listing the comps, calculate and show your work:
1. Square Footage Difference %: (Average Comp SqFt - Subject SqFt) / Subject SqFt x 100
2. Estimated ARV: Average Price per Square Foot of the comps x Subject SqFt — give a final range, not just one number.

If the ARV comes out lower than what a bank's automated home value estimate would show, say so plainly — that's an important finding, not something to smooth over.`;
        root.querySelector("#comps-prompt-copy-btn").onclick = () => {
          const text = root.querySelector("#comps-prompt-text").value;
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => {
              alert("Prompt copied to clipboard.");
            }).catch(() => {
              prompt("Copy this prompt:", text);
            });
          } else {
            prompt("Copy this prompt:", text);
          }
        };

        // Screenshots upload straight to Drive as soon as they're picked (see uploadCmaScreenshot
        // in the backend) -- only the resulting links get stored in `answers`, never the raw image
        // data, so Save My Progress links and the final submission payload both stay small.
        const screenshotsList = root.querySelector("#cma-screenshots-list");
        const renderScreenshotsList = () => {
          const urls = answers.cmaScreenshotUrls || [];
          screenshotsList.innerHTML = urls.map((url, i) => `
            <div class="small-muted" style="margin-top:4px;">
              <a href="${url}" target="_blank" rel="noopener">Screenshot ${i + 1}</a>
              <button type="button" class="link-btn" data-remove-idx="${i}" style="margin-left:8px;">Remove</button>
            </div>
          `).join("");
          screenshotsList.querySelectorAll("[data-remove-idx]").forEach(btn => {
            btn.onclick = () => {
              answers.cmaScreenshotUrls.splice(Number(btn.dataset.removeIdx), 1);
              renderScreenshotsList();
            };
          });
        };
        renderScreenshotsList();

        const readFileAsBase64 = (file) => new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });

        root.querySelector("#cma-screenshots-input").onchange = async (e) => {
          const files = Array.from(e.target.files);
          for (const file of files) {
            const statusEl = document.createElement("div");
            statusEl.className = "small-muted";
            statusEl.textContent = `Uploading ${file.name}...`;
            screenshotsList.appendChild(statusEl);
            try {
              const fileData = await readFileAsBase64(file);
              const res = await api("uploadCmaScreenshot", {
                fileName: file.name, fileData, contentType: file.type || "image/png", address: addressLine
              });
              if (res.ok) {
                answers.cmaScreenshotUrls = answers.cmaScreenshotUrls || [];
                answers.cmaScreenshotUrls.push(res.url);
                renderScreenshotsList();
              } else {
                statusEl.textContent = `Failed to upload ${file.name}: ${res.error || "unknown error"}`;
              }
            } catch (err) {
              statusEl.textContent = `Failed to upload ${file.name}: ${err.message}`;
            }
          }
          e.target.value = "";
        };
      }

      recomputeCashDeal();
    },
    validate(root) {
      const isSeller = answers.role === "Seller";
      answers.cashDealNotes = root.querySelector("#cash-notes-input").value.trim();
      answers.bottomDollarPrice = root.querySelector("#bottom-dollar-input").value;
      if (isSeller) {
        const ok = !!answers.cashDealNotes;
        toggleError(root, "#cash-notes-error", !ok);
        return ok;
      }
      const isLand = answers.assetType === "Land";
      const isResidentialForChase = answers.assetType === "Residential Property (1-4 units)";
      answers.arv = root.querySelector("#arv-input").value;
      if (isResidentialForChase) answers.chaseEstimate = root.querySelector("#chase-estimate-input").value;
      answers.picturesLink = root.querySelector("#pictures-link-input").value.trim();
      // Land has no Rehab Estimate inputs -- offers run purely off the As-Is Value entered above.
      answers.rehabEstimateLow = isLand ? "" : root.querySelector("#rehab-low-input").value;
      answers.rehabEstimateHigh = isLand ? "" : root.querySelector("#rehab-high-input").value;
      const rLow = Number(answers.rehabEstimateLow) || 0;
      const rHigh = Number(answers.rehabEstimateHigh) || 0;
      answers.rehabEstimate = rLow && rHigh ? String((rLow + rHigh) / 2) : String(rLow || rHigh || "");
      answers.countyAssessedValue = root.querySelector("#assessed-value-input").value;
      if ((answers.assetType === "Residential Property (1-4 units)" || answers.assetType === "Land") && answers.arv) {
        answers.asIsValue = Number(answers.arv) - (Number(answers.rehabEstimate) || 0);
      }
      const arvNum = Number(answers.arv) || 0;
      const isSellerFinancing = answers.dealType !== "Cash Deal";
      // The wholesale-fee input and MAO/ceiling banners stay hidden from the associate for Seller
      // Financing (admin structures that deal, not the associate) -- but the underlying numbers
      // still get computed either way, since Make Your Offers needs a cash figure to text out
      // regardless of which dealType this lead is. Seller Financing has no visible fee input to
      // read, so it always uses the plain formula fee instead of a manual override.
      const formulaFee = arvNum ? Math.max(25000, 0.03 * arvNum) : "";
      answers.wholesaleFee = isSellerFinancing
        ? formulaFee
        : (root.querySelector("#wholesale-fee-input").value || formulaFee);
      const maoSuite = computeMaoSuite(arvNum, Number(answers.rehabEstimate) || 0, answers.assetType, answers.wholesaleFee);
      if (maoSuite) {
        answers.maoCash = Math.round(maoSuite.maoCash);
        answers.maoHardMoney10 = Math.round(maoSuite.maoHardMoney10);
        answers.maoHardMoney20 = Math.round(maoSuite.maoHardMoney20);
        answers.maoBreakdown = maoSuite.fullBreakdown;
      }
      let ok = true;
      // Residential ARV is no longer a hard requirement: Chase is the primary source, but if it
      // doesn't have a value for the address, it's fine to skip ARV rather than guess -- the
      // alternative is pulling real matched comps (documented in Notes), not just leaving it blank
      // AND making something up. Commercial/business have no Chase-equivalent fallback, so ARV
      // stays required there.
      const isResidential = answers.assetType === "Residential Property (1-4 units)";
      if (!isResidential) {
        toggleError(root, "#arv-error", !answers.arv); if (!answers.arv) ok = false;
      } else {
        toggleError(root, "#arv-error", false);
      }
      const hasSupplementary = !!(answers.picturesLink || answers.rehabEstimate || answers.countyAssessedValue);
      if (!hasSupplementary) {
        toggleError(root, "#cash-notes-error", !answers.cashDealNotes); if (!answers.cashDealNotes) ok = false;
      } else {
        toggleError(root, "#cash-notes-error", false);
      }

      if (isResidential) {
        answers.askingPrice = root.querySelector("#asking-price-input").value;
        const askingOk = !!answers.askingPrice;
        toggleError(root, "#asking-price-error", !askingOk); if (!askingOk) ok = false;

        const askingPriceNum = Number(answers.askingPrice) || 0;
        const needsRehabNow = (Number(answers.rehabEstimate) || 0) > 0;
        answers.forcedSellerFinancingOnly = false;
        if (arvNum && askingPriceNum && arvNum < askingPriceNum) {
          const gapPct = (askingPriceNum - arvNum) / askingPriceNum;
          if (!needsRehabNow && gapPct <= ARV_VS_ASKING_CLOSE_PCT) {
            // Close enough with no rehab -- pivot to seller-financing-only (cashflow requirement is
            // enforced in the income step). Only auto-flip a Cash Deal pick; leave an associate's own
            // Seller Financing pick alone, and remember we did this so it can be un-done below if the
            // numbers change back before submission.
            answers.forcedSellerFinancingOnly = true;
            if (answers.dealType === "Cash Deal") {
              answers.dealType = "Seller Financing / Creative Finance";
              answers.dealTypeAutoPivoted = true;
            }
          } else {
            const arvVsAskingBanner = root.querySelector("#arv-vs-asking-banner");
            arvVsAskingBanner.hidden = false;
            arvVsAskingBanner.className = "banner danger";
            arvVsAskingBanner.innerHTML = `<strong>This deal does not pencil.</strong> ARV needs to be at
              or above the asking price${needsRehabNow ? ", and meaningfully higher once rehab is factored in," : ""}
              for this to work as either a cash purchase or a seller financing offer. Stop here and move
              on to another opportunity -- this lead can't be submitted with these numbers.`;
            ok = false;
          }
        } else if (answers.dealTypeAutoPivoted) {
          // ARV came back above asking (or one of the numbers got cleared) -- undo the earlier
          // auto-pivot rather than leaving the lead stuck as Seller Financing for no reason.
          answers.dealType = "Cash Deal";
          answers.dealTypeAutoPivoted = false;
        }
      }
      return ok;
    }
  },
  {
    key: "debt",
    progress: true,
    render(root) {
      root.innerHTML = `
        <h2 class="step-title">Existing Debt</h2>
        <p class="step-sub">What is the total debt currently on the property?</p>
        <input type="number" id="debt-input" placeholder="Total debt amount" ${answers.debtUnknown ? "disabled" : ""}>
        <div style="margin-top:10px;">
          <button type="button" class="btn ghost-small ${answers.debtUnknown ? "active" : ""}" id="unknown-debt-btn">
            I don't know
          </button>
        </div>
      `;
      root.querySelector("#debt-input").value = answers.totalDebt || "";
      root.querySelector("#unknown-debt-btn").onclick = () => {
        answers.debtUnknown = !answers.debtUnknown;
        if (answers.debtUnknown) answers.totalDebt = "";
        renderStep();
      };
    },
    validate(root) {
      if (!answers.debtUnknown) answers.totalDebt = root.querySelector("#debt-input").value;
      return true; // optional either way
    }
  },
  {
    key: "seniorLoan",
    progress: true,
    // A Seller filling this out about their own property sees this regardless of Deal Type -- we
    // want the seller-financing question set from them either way, not just when they happened to
    // pick that option (admin decides the actual structure, not the seller's initial guess).
    skip() { return answers.dealType === "Cash Deal" && answers.role !== "Seller"; },
    render(root) {
      root.innerHTML = `
        <h2 class="step-title">New Senior Financing</h2>
        <p class="step-sub">Would the seller be willing to let a buyer place a new senior (1st position)
        mortgage on the property? We need a yes or a no here to accept the lead.</p>
        <div class="choice-group" id="senior-group">
          ${["Yes","No"].map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
        </div>
        <div class="error-text" id="senior-error">Please choose Yes or No.</div>
        <div class="banner danger" id="senior-block-banner" ${answers.seniorLoanWilling === "No" ? "" : "hidden"}>
          We currently do not accept leads where the seller isn't willing to allow a buyer to take out a new
          senior (1st position) mortgage on the property.
        </div>
      `;
      root.querySelectorAll("#senior-group .choice-btn").forEach(btn => {
        if (btn.dataset.value === answers.seniorLoanWilling) btn.classList.add("selected");
        btn.onclick = () => {
          root.querySelectorAll("#senior-group .choice-btn").forEach(b => b.classList.remove("selected"));
          btn.classList.add("selected");
          answers.seniorLoanWilling = btn.dataset.value;
          root.querySelector("#senior-block-banner").hidden = btn.dataset.value !== "No";
          toggleError(root, "#senior-error", false);
        };
      });
    },
    validate(root) {
      const ok = !!answers.seniorLoanWilling;
      toggleError(root, "#senior-error", !ok);
      return ok && answers.seniorLoanWilling === "Yes";
    }
  },
  {
    key: "paymentStructure",
    progress: true,
    skip() { return answers.dealType === "Cash Deal" && answers.role !== "Seller"; },
    render(root) {
      root.innerHTML = `
        <h2 class="step-title">Payment Structure</h2>
        <p class="step-sub">Would the seller accept: some down payment now, some paid monthly, and the
        remainder between the agreed purchase price and the down payment paid within a specific timeframe
        agreed by both parties? We need a yes or a no here to accept the lead.</p>
        <div class="choice-group" id="structure-group">
          ${["Yes","No"].map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
        </div>
        <div class="error-text" id="structure-error">Please choose Yes or No.</div>
        <div class="banner danger" id="structure-block-banner" ${answers.paymentStructureWilling === "No" ? "" : "hidden"}>
          We currently don't accept leads where the seller isn't willing to consider seller carry / seller
          financing (a down payment now, monthly payments, and the remainder paid over an agreed timeframe).
        </div>
      `;
      root.querySelectorAll("#structure-group .choice-btn").forEach(btn => {
        if (btn.dataset.value === answers.paymentStructureWilling) btn.classList.add("selected");
        btn.onclick = () => {
          root.querySelectorAll("#structure-group .choice-btn").forEach(b => b.classList.remove("selected"));
          btn.classList.add("selected");
          answers.paymentStructureWilling = btn.dataset.value;
          root.querySelector("#structure-block-banner").hidden = btn.dataset.value !== "No";
          toggleError(root, "#structure-error", false);
        };
      });
    },
    validate(root) {
      const ok = !!answers.paymentStructureWilling;
      toggleError(root, "#structure-error", !ok);
      return ok && answers.paymentStructureWilling === "Yes";
    }
  },
  {
    key: "downPayment",
    skip() { return answers.dealType === "Cash Deal" && answers.role !== "Seller"; },
    progress: true,
    render(root) {
      root.innerHTML = `
        <h2 class="step-title">Down Payment</h2>
        <p class="step-sub">What does the seller intend to do with the down payment from this
        transaction, and roughly how much are they looking for? It's okay to skip this if they'd
        rather not say.</p>

        <label class="field-label">What will they use it for? <span class="small-muted">(optional)</span></label>
        <textarea id="dp-intent-input" placeholder="e.g. pay off their mortgage, move into a new place, medical bills..." ${answers.dpSkipped ? "disabled" : ""}></textarea>

        <label class="field-label" style="margin-top:16px;">Approximate dollar amount <span class="small-muted">(optional)</span></label>
        <input type="number" id="dp-input" placeholder="Down payment amount" ${answers.dpSkipped ? "disabled" : ""}>
        <div style="margin-top:10px;">
          <button type="button" class="btn ghost-small ${answers.dpSkipped ? "active" : ""}" id="skip-dp-btn">Skip / seller prefers not to answer</button>
        </div>
        <div id="nonneg-wrap"></div>
      `;
      root.querySelector("#dp-intent-input").value = answers.downPaymentIntent || "";
      root.querySelector("#dp-input").value = answers.downPaymentNeeded || "";
      const nonnegWrap = root.querySelector("#nonneg-wrap");
      function renderNonNeg() {
        if (!answers.dpSkipped && answers.downPaymentNeeded) {
          nonnegWrap.innerHTML = `
            <label class="field-label">Is the seller willing to accept less down if we're unable to give them their requested down? <span class="req">*</span></label>
            <div class="choice-group" id="nonneg-group">
              ${["Yes","No","Not Sure"].map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
            </div>
            <div class="error-text" id="nonneg-error">Please choose one.</div>
          `;
          bindChoiceGroup(root, "#nonneg-group", "downPaymentNonNegotiable");
        } else {
          nonnegWrap.innerHTML = "";
        }
      }
      renderNonNeg();
      root.querySelector("#dp-intent-input").oninput = (e) => {
        answers.downPaymentIntent = e.target.value;
      };
      root.querySelector("#dp-input").oninput = (e) => {
        answers.downPaymentNeeded = e.target.value;
        renderNonNeg();
      };
      root.querySelector("#skip-dp-btn").onclick = () => {
        answers.dpSkipped = !answers.dpSkipped;
        if (answers.dpSkipped) { answers.downPaymentNeeded = ""; answers.downPaymentNonNegotiable = ""; answers.downPaymentIntent = ""; }
        renderStep();
      };
    },
    validate(root) {
      if (answers.dpSkipped) return true;
      answers.downPaymentIntent = root.querySelector("#dp-intent-input").value.trim();
      answers.downPaymentNeeded = root.querySelector("#dp-input").value;
      if (!answers.downPaymentNeeded) return true; // treated as skipped
      const ok = !!answers.downPaymentNonNegotiable;
      toggleError(root, "#nonneg-error", !ok);
      return ok;
    }
  },
  {
    key: "income",
    progress: true,
    skip() { return answers.dealType === "Cash Deal" && answers.role !== "Seller"; },
    render(root) {
      const disclaimer = `
        <div class="banner warn">
          This information is required to move forward. If you're unable to find or confirm it for a given
          property or business, please continue searching for other opportunities that do have this
          information readily accessible — we're not able to evaluate deals without it.
        </div>
      `;
      const incomeAddressLine = `${answers.street || ""}, ${answers.city || ""}, ${answers.state || ""} ${answers.zip || ""}`.trim();
      const taxesInsurancePrompt = `what are the estimated annual property taxes and homeowners insurance for this property: ${incomeAddressLine}? Give a single best estimate for each, not just a range.`;
      const incomeGoogleAiHow = `go to <strong>google.com</strong> and search anything (typing "ai" works fine, or just the
        address) — once results load, look at the row of tabs near the top of the page (next to "All", "Images",
        "News", "Shopping") and click <strong>"AI Mode"</strong>`;
      if (answers.assetType === "Residential Property (1-4 units)") {
        // Only offered on the not-rent-ready Seller Financing path (see rentReadyCheck) -- if admin's
        // eventual buyer plans to resell rather than hold this as a rental, income/NOI research is
        // wasted effort. Ask admin if unsure whether the buyer intends to keep or sell.
        const showsSellSkip = answers.propertyRentReady === "No";
        if (showsSellSkip && answers.buyerIntendsToSell) {
          root.innerHTML = `
            <h2 class="step-title">Property Income (NOI)</h2>
            <div style="margin-bottom:16px;">
              <button type="button" class="btn ghost-small active" id="buyer-sells-btn">Admin's buyer intends to sell property (ask admin if unsure)</button>
            </div>
            <div class="banner info">Skipping income/NOI details since admin's buyer intends to sell this property.</div>
          `;
          root.querySelector("#buyer-sells-btn").onclick = () => {
            answers.buyerIntendsToSell = false;
            renderStep();
          };
          return;
        }
        root.innerHTML = `
          <h2 class="step-title">Property Income (NOI)</h2>
          ${answers.forcedSellerFinancingOnly ? `
            <div class="banner danger">ARV came in too close to asking price with no rehab needed, so
            this can only move forward as a seller financing offer if it actually cash flows as a long
            term or short term rental. If the NOI below isn't positive, stop here and move on to another
            opportunity -- this lead won't be submittable otherwise.</div>
            <div class="error-text" id="cashflow-required-error">This deal needs a positive NOI (long term
            or short term rental) to move forward -- it can't work as a cash purchase with these numbers.</div>
          ` : ""}
          ${showsSellSkip ? `
            <div style="margin-bottom:16px;">
              <button type="button" class="btn ghost-small" id="buyer-sells-btn">Admin's buyer intends to sell property (ask admin if unsure)</button>
              <p class="hint" style="margin-top:8px;">If admin's buyer for this deal plans to resell rather
              than hold it as a rental, tap this to skip the income/NOI questions below. If they intend to
              keep and rent it out, leave this off and fill out the section as normal.</p>
            </div>
          ` : ""}
          ${disclaimer}
          <label class="field-label">Is the property currently occupied by a paying tenant? <span class="req">*</span></label>
          <div class="choice-group" id="occupied-group">
            ${["Occupied (has a landlord/tenant)", "Vacant (no tenant)"].map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
          </div>
          <div class="error-text" id="occupied-error">Please choose one.</div>
          <div id="income-sub"></div>
        `;
        if (showsSellSkip) {
          root.querySelector("#buyer-sells-btn").onclick = () => {
            answers.buyerIntendsToSell = true;
            renderStep();
          };
        }
        const sub = root.querySelector("#income-sub");
        const renderIncomeSub = () => {
          if (answers.residentialOccupied === "Occupied (has a landlord/tenant)") {
            const occUnits = Number(answers.units) || 1;
            const occIsMultiUniform = occUnits >= 2 && occUnits <= 4 && answers.unitsUniform === "Yes";
            sub.innerHTML = `
              <label class="field-label">Annual NOI <span class="req">*</span></label>
              <input type="number" id="noi-input" placeholder="$">
              <div class="error-text" id="noi-error">Required.</div>

              <label class="field-label" style="margin-top:16px;">Annual Property Taxes</label>
              <input type="number" id="occ-taxes-input" placeholder="$">
              <label class="field-label">Annual Insurance</label>
              <input type="number" id="occ-insurance-input" placeholder="$">
              <p class="hint">Don't have this from the seller? ${incomeGoogleAiHow}, then ask:
              <br><span class="small-muted">"${taxesInsurancePrompt}"</span>
              <br><button type="button" class="btn secondary" id="occ-taxes-prompt-copy-btn" style="margin-top:8px;">Copy Prompt</button>
              </p>

              <label class="field-label" style="margin-top:16px;">Does the seller have 12 months of rent rolls for this property? <span class="req">*</span></label>
              <div class="choice-group" id="rent-rolls-group">
                ${["Yes", "No"].map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
              </div>
              <div class="error-text" id="rent-rolls-error">Please choose one.</div>
              <div id="pl-sub"></div>

              <label class="field-label" style="margin-top:16px;">Can the property be delivered vacant upon sale? <span class="req">*</span></label>
              <div class="choice-group" id="deliverable-vacant-group">
                ${["Yes", "No"].map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
              </div>
              <div class="error-text" id="deliverable-vacant-error">Please choose one.</div>

              <label class="field-label">Current tenant lease term <span class="small-muted">(e.g. month-to-month, or a 1-year lease just renewed)</span> <span class="req">*</span></label>
              <input type="text" id="lease-term-input" placeholder="e.g. Month-to-month">
              <div class="error-text" id="lease-term-error">Required.</div>

              ${occUnits === 1 ? `
                <label class="field-label" style="margin-top:16px;">When does this tenant's lease end? <span class="small-muted">(a specific date, or "month-to-month" if there's no fixed end)</span> <span class="req">*</span></label>
                <input type="text" id="lease-end-input" placeholder="e.g. 6/30/2026, or month-to-month">
                <div class="error-text" id="lease-end-error">Required.</div>

                <label class="field-label">Would the tenant be willing to move out earlier if needed? <span class="req">*</span></label>
                <div class="choice-group" id="tenant-move-early-group">
                  ${["Yes", "No", "Not Sure"].map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
                </div>
                <div class="error-text" id="tenant-move-early-error">Please choose one.</div>
              ` : `
                <label class="field-label" style="margin-top:16px;">STR NOI Per Unit <span class="small-muted">(optional — for proforma awareness; with ${occUnits} units we wouldn't ask any tenant to leave at closing, so LTR NOI above is still the basis -- this is just what one unit could net under short-term rental once its lease naturally ends)</span></label>
                <input type="number" id="str-noi-per-unit-input" placeholder="$">
              `}

              <div id="str-comparison-sub"></div>
            `;
            sub.querySelector("#noi-input").value = answers.residentialNOI || "";
            sub.querySelector("#occ-taxes-input").value = answers.annualPropertyTaxes || "";
            sub.querySelector("#occ-insurance-input").value = answers.annualInsurance || "";
            wireCopyPromptButton(sub, "#occ-taxes-prompt-copy-btn", () => taxesInsurancePrompt);
            if (occUnits === 1) {
              sub.querySelector("#lease-end-input").value = answers.leaseEndDate || "";
              sub.querySelectorAll("#tenant-move-early-group .choice-btn").forEach(btn => {
                if (btn.dataset.value === answers.tenantWouldMoveEarly) btn.classList.add("selected");
                btn.onclick = () => {
                  sub.querySelectorAll("#tenant-move-early-group .choice-btn").forEach(b => b.classList.remove("selected"));
                  btn.classList.add("selected");
                  answers.tenantWouldMoveEarly = btn.dataset.value;
                  toggleError(sub, "#tenant-move-early-error", false);
                };
              });
            } else {
              sub.querySelector("#str-noi-per-unit-input").value = answers.strNoiPerUnit || "";
            }
            sub.querySelector("#lease-term-input").value = answers.currentLeaseTerm || "";

            const plSub = sub.querySelector("#pl-sub");
            const renderPlSub = () => {
              if (answers.hasRentRolls === "Yes") {
                plSub.innerHTML = `
                  <label class="field-label">Does the seller also have a profit &amp; loss statement for the last 12 months? <span class="req">*</span></label>
                  <div class="choice-group" id="has-pl-group">
                    ${["Yes", "No"].map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
                  </div>
                  <div class="error-text" id="has-pl-error">Please choose one.</div>
                `;
                plSub.querySelectorAll("#has-pl-group .choice-btn").forEach(btn => {
                  if (btn.dataset.value === answers.hasProfitLoss) btn.classList.add("selected");
                  btn.onclick = () => {
                    plSub.querySelectorAll("#has-pl-group .choice-btn").forEach(b => b.classList.remove("selected"));
                    btn.classList.add("selected");
                    answers.hasProfitLoss = btn.dataset.value;
                    toggleError(plSub, "#has-pl-error", false);
                  };
                });
              } else {
                plSub.innerHTML = "";
                answers.hasProfitLoss = "";
              }
            };
            renderPlSub();
            sub.querySelectorAll("#rent-rolls-group .choice-btn").forEach(btn => {
              if (btn.dataset.value === answers.hasRentRolls) btn.classList.add("selected");
              btn.onclick = () => {
                sub.querySelectorAll("#rent-rolls-group .choice-btn").forEach(b => b.classList.remove("selected"));
                btn.classList.add("selected");
                answers.hasRentRolls = btn.dataset.value;
                toggleError(sub, "#rent-rolls-error", false);
                renderPlSub();
              };
            });

            // Only relevant if the property could actually transition to a different rental
            // strategy soon -- if a long lease was just renewed, this comparison isn't useful,
            // so skip it entirely rather than asking for vacancy-style info that won't apply.
            const strSub = sub.querySelector("#str-comparison-sub");
            const renderStrSub = () => {
              if (answers.deliverableVacant === "Yes") {
                const strHint = occIsMultiUniform
                  ? `Since all ${occUnits} units are identical, search <strong>airdna.co</strong> for a comp
                     matching <strong>ONE</strong> unit (a ${answers.beds || "?"} bed / ${answers.baths || "?"}
                     bath single family/condo), and enter that <strong>one unit's</strong> projected annual
                     revenue below — we'll multiply it by ${occUnits} units automatically for the property total.`
                  : `Look up this property's projected annual short-term rental revenue on <strong>airdna.co</strong>
                     by entering the address${occUnits > 1 ? " (enter the TOTAL for all units combined)" : ""}.`;
                const strLabel = occIsMultiUniform
                  ? "Projected Annual STR Revenue PER UNIT (airdna.co)"
                  : "Projected Annual STR Revenue (airdna.co)";
                strSub.innerHTML = `
                  <h3 class="step-title" style="font-size:18px; margin-top:24px;">Short-Term Rental Comparison
                    <span class="small-muted">(optional, but encouraged — speeds up admin's evaluation of the deal;
                    uses the Annual Property Taxes/Insurance entered above)</span></h3>
                  <p class="hint">${strHint}</p>
                  <a href="https://www.airdna.co/" target="_blank" rel="noopener" class="link-btn">Open airdna.co &rarr;</a>
                  <label class="field-label">${strLabel} <span class="small-muted">(optional)</span></label>
                  <input type="number" id="occ-str-revenue-input" placeholder="$">
                  <div class="banner info" id="computed-occ-str-noi-banner" hidden></div>
                `;
                strSub.querySelector("#occ-str-revenue-input").value = occIsMultiUniform && answers.strAnnualRevenue
                  ? (Number(answers.strAnnualRevenue) / occUnits)
                  : (answers.strAnnualRevenue || "");
                const recomputeOccStr = () => {
                  const taxes = Number(sub.querySelector("#occ-taxes-input").value) || 0;
                  const insurance = Number(sub.querySelector("#occ-insurance-input").value) || 0;
                  const strRevenueEntered = Number(strSub.querySelector("#occ-str-revenue-input").value) || 0;
                  const banner = strSub.querySelector("#computed-occ-str-noi-banner");
                  if (!strRevenueEntered) {
                    banner.hidden = true;
                    answers.strAnnualRevenue = ""; answers.strNOI = "";
                    return;
                  }
                  const strRevenue = occIsMultiUniform ? strRevenueEntered * occUnits : strRevenueEntered;
                  const strGrossBeforeExpenses = strRevenue - taxes - insurance;
                  const strOtherExpenses = strRevenue * (STR_EXPENSE_RATIO / 100);
                  const strNOI = strGrossBeforeExpenses - strOtherExpenses;
                  banner.hidden = false;
                  banner.innerHTML = `
                    ${occIsMultiUniform ? `<div><strong>Total STR Revenue (${occUnits} units &times; $${strRevenueEntered.toLocaleString(undefined, {maximumFractionDigits: 0})}/unit):</strong> $${strRevenue.toLocaleString(undefined, {maximumFractionDigits: 0})}</div>` : ""}
                    <div${occIsMultiUniform ? ' style="margin-top:6px;"' : ""}><strong>Gross STR Revenue Potential:</strong> $${strGrossBeforeExpenses.toLocaleString(undefined, {maximumFractionDigits: 0})}</div>
                    <div style="margin-top:6px;"><strong>Likely Net Cashflow Per Year (STR):</strong> $${strNOI.toLocaleString(undefined, {maximumFractionDigits: 0})}
                      <span class="small-muted">(minus taxes, insurance, and a preset ${STR_EXPENSE_RATIO}% expense ratio)</span></div>
                    <div style="margin-top:6px;"><strong>Current Actual NOI (from rent rolls/P&amp;L):</strong> $${Number(answers.residentialNOI || 0).toLocaleString(undefined, {maximumFractionDigits: 0})}</div>
                  `;
                  answers.strAnnualRevenue = strRevenue;
                  answers.strNOI = strNOI;
                };
                strSub.querySelector("#occ-str-revenue-input").oninput = recomputeOccStr;
                sub.querySelector("#occ-taxes-input").oninput = recomputeOccStr;
                sub.querySelector("#occ-insurance-input").oninput = recomputeOccStr;
                recomputeOccStr();
              } else {
                strSub.innerHTML = "";
                answers.strAnnualRevenue = ""; answers.strNOI = "";
              }
            };
            renderStrSub();
            sub.querySelectorAll("#deliverable-vacant-group .choice-btn").forEach(btn => {
              if (btn.dataset.value === answers.deliverableVacant) btn.classList.add("selected");
              btn.onclick = () => {
                sub.querySelectorAll("#deliverable-vacant-group .choice-btn").forEach(b => b.classList.remove("selected"));
                btn.classList.add("selected");
                answers.deliverableVacant = btn.dataset.value;
                toggleError(sub, "#deliverable-vacant-error", false);
                renderStrSub();
              };
            });
          } else if (answers.residentialOccupied === "Vacant (no tenant)") {
            const units = Number(answers.units) || 1;
            const isMultiUniform = units >= 2 && units <= 4 && answers.unitsUniform === "Yes";
            const taxesInsuranceDesc = units > 1
              ? `the full ${units}-unit property (not a single unit)`
              : `a ${answers.beds || "?"} bed / ${answers.baths || "?"} bath home`;
            const strHint = isMultiUniform
              ? `Since all ${units} units are identical, search <strong>airdna.co</strong> for a comp matching
                 <strong>ONE</strong> unit (a ${answers.beds || "?"} bed / ${answers.baths || "?"} bath single
                 family/condo), and enter that <strong>one unit's</strong> projected annual revenue below — we'll
                 multiply it by ${units} units automatically for the property total.`
              : `Look up this property's projected annual short-term rental revenue on <strong>airdna.co</strong>
                 by entering the address${units > 1 ? " (enter the TOTAL for all units combined)" : ""}.`;
            const strLabel = isMultiUniform
              ? "Projected Annual STR Revenue PER UNIT (airdna.co)"
              : "Projected Annual STR Revenue (airdna.co)";
            sub.innerHTML = `
              <p class="hint">Look up annual property taxes and insurance for ${taxesInsuranceDesc} in
              ${answers.city || "this city"}${answers.state ? ", " + answers.state : ""}
              (search Google, or check the county assessor and an insurance quote, and use the
              middle of any range you find), and enter them below — these apply to both rental
              strategies below. Or ${incomeGoogleAiHow}, then ask:
              <br><span class="small-muted">"${taxesInsurancePrompt}"</span>
              <br><button type="button" class="btn secondary" id="vacant-taxes-prompt-copy-btn" style="margin-top:8px;">Copy Prompt</button>
              </p>
              <label class="field-label">Annual Property Taxes <span class="req">*</span></label>
              <input type="number" id="taxes-input" placeholder="$">
              <div class="error-text" id="taxes-error">Required.</div>
              <label class="field-label">Annual Insurance <span class="req">*</span></label>
              <input type="number" id="insurance-input" placeholder="$">
              <div class="error-text" id="insurance-error">Required.</div>

              <h3 class="step-title" style="font-size:18px; margin-top:24px;">Long-Term Rental</h3>
              <p class="hint">Look up the estimated monthly rental value on <strong>rentcast.io</strong> for this property.</p>
              <a href="https://www.rentcast.io/" target="_blank" rel="noopener" class="link-btn">Open rentcast.io &rarr;</a>
              <label class="field-label">Estimated Monthly Rent (rentcast.io) <span class="req">*</span></label>
              <input type="number" id="rent-input" placeholder="$">
              <div class="error-text" id="rent-error">Required.</div>
              ${units === 1 ? `
                <p class="hint">Since this is a single-family property, maintenance is estimated at
                <strong>1.1% of the $${Number(answers.priceSought || 0).toLocaleString()} purchase price</strong>
                (most DSCR lenders underwrite with maintenance included this way) — no separate expense ratio
                needed. The comparison below shows the figure with and without that maintenance estimate.</p>
              ` : `
                <label class="field-label">Expense Ratio % <span class="small-muted">(other operating expenses — maintenance, vacancy, management, capex — as a % of gross rent)</span> <span class="req">*</span></label>
                <input type="number" id="expense-ratio-input" placeholder="e.g. 35" min="0" max="100">
                <div class="error-text" id="expense-ratio-error">Required.</div>
              `}
              <div class="banner info" id="computed-ltr-noi-banner"></div>

              <h3 class="step-title" style="font-size:18px; margin-top:24px;">Short-Term Rental (STR)</h3>
              <p class="hint">${strHint}</p>
              <a href="https://www.airdna.co/" target="_blank" rel="noopener" class="link-btn">Open airdna.co &rarr;</a>
              <label class="field-label">${strLabel} <span class="req">*</span></label>
              <input type="number" id="str-revenue-input" placeholder="$">
              <div class="error-text" id="str-revenue-error">Required.</div>
              <div class="banner info" id="computed-str-noi-banner"></div>
            `;
            sub.querySelector("#taxes-input").value = answers.annualPropertyTaxes || "";
            sub.querySelector("#insurance-input").value = answers.annualInsurance || "";
            wireCopyPromptButton(sub, "#vacant-taxes-prompt-copy-btn", () => taxesInsurancePrompt);
            sub.querySelector("#rent-input").value = answers.rentcastMonthlyRent || "";
            if (units !== 1) {
              sub.querySelector("#expense-ratio-input").value = typeof answers.expenseRatio === "number" || /^\d+$/.test(answers.expenseRatio || "") ? answers.expenseRatio : "";
            }
            sub.querySelector("#str-revenue-input").value = isMultiUniform && answers.strAnnualRevenue
              ? (Number(answers.strAnnualRevenue) / units)
              : (answers.strAnnualRevenue || "");
            const recompute = () => {
              const taxes = Number(sub.querySelector("#taxes-input").value) || 0;
              const insurance = Number(sub.querySelector("#insurance-input").value) || 0;
              const rent = Number(sub.querySelector("#rent-input").value) || 0;
              const strRevenueEntered = Number(sub.querySelector("#str-revenue-input").value) || 0;
              const strRevenue = isMultiUniform ? strRevenueEntered * units : strRevenueEntered;

              const grossAnnualRent = rent * 12;
              const ltrGrossBeforeExpenses = grossAnnualRent - taxes - insurance;
              let ltrOtherExpenses, expenseRatio;
              if (units === 1) {
                ltrOtherExpenses = Number(answers.priceSought || 0) * 0.011;
                expenseRatio = "1.1% of price";
              } else {
                expenseRatio = Number(sub.querySelector("#expense-ratio-input").value) || 0;
                ltrOtherExpenses = grossAnnualRent * (expenseRatio / 100);
              }
              const ltrNOI = ltrGrossBeforeExpenses - ltrOtherExpenses;
              sub.querySelector("#computed-ltr-noi-banner").innerHTML = `
                <div><strong>Without Maintenance (Gross Rental Income Potential):</strong> $${ltrGrossBeforeExpenses.toLocaleString(undefined, {maximumFractionDigits: 0})}
                  <span class="small-muted">(monthly rent &times; 12, minus taxes and insurance only — no maintenance applied)</span></div>
                <div style="margin-top:6px;"><strong>With Maintenance (Likely Net Cashflow Per Year):</strong> $${ltrNOI.toLocaleString(undefined, {maximumFractionDigits: 0})}
                  <span class="small-muted">${units === 1
                    ? `(same as above, minus 1.1% of the $${Number(answers.priceSought || 0).toLocaleString()} purchase price: $${ltrOtherExpenses.toLocaleString(undefined, {maximumFractionDigits: 0})})`
                    : `(same as above, minus the ${expenseRatio}% expense ratio)`}</span></div>
              `;

              const strGrossBeforeExpenses = strRevenue - taxes - insurance;
              const strOtherExpenses = strRevenue * (STR_EXPENSE_RATIO / 100);
              const strNOI = strGrossBeforeExpenses - strOtherExpenses;
              sub.querySelector("#computed-str-noi-banner").innerHTML = `
                ${isMultiUniform ? `<div><strong>Total STR Revenue (${units} units &times; $${strRevenueEntered.toLocaleString(undefined, {maximumFractionDigits: 0})}/unit):</strong> $${strRevenue.toLocaleString(undefined, {maximumFractionDigits: 0})}</div>` : ""}
                <div${isMultiUniform ? ' style="margin-top:6px;"' : ""}><strong>Gross STR Revenue Potential:</strong> $${strGrossBeforeExpenses.toLocaleString(undefined, {maximumFractionDigits: 0})}
                  <span class="small-muted">(annual revenue minus taxes and insurance only — no expense ratio applied)</span></div>
                <div style="margin-top:6px;"><strong>Likely Net Cashflow Per Year:</strong> $${strNOI.toLocaleString(undefined, {maximumFractionDigits: 0})}
                  <span class="small-muted">(same as above, minus a preset ${STR_EXPENSE_RATIO}% expense ratio)</span></div>
              `;

              answers.annualPropertyTaxes = taxes;
              answers.annualInsurance = insurance;
              answers.rentcastMonthlyRent = rent;
              answers.expenseRatio = expenseRatio;
              answers.residentialNOI = ltrNOI;
              answers.strAnnualRevenue = strRevenue;
              answers.strNOI = strNOI;
            };
            ["#taxes-input", "#insurance-input", "#rent-input", "#str-revenue-input"].concat(units !== 1 ? ["#expense-ratio-input"] : []).forEach(sel => {
              sub.querySelector(sel).oninput = recompute;
            });
            recompute();
          } else {
            sub.innerHTML = "";
          }
        };
        renderIncomeSub();
        root.querySelectorAll("#occupied-group .choice-btn").forEach(btn => {
          if (btn.dataset.value === answers.residentialOccupied) btn.classList.add("selected");
          btn.onclick = () => {
            root.querySelectorAll("#occupied-group .choice-btn").forEach(b => b.classList.remove("selected"));
            btn.classList.add("selected");
            answers.residentialOccupied = btn.dataset.value;
            toggleError(root, "#occupied-error", false);
            renderIncomeSub();
          };
        });
      } else if (answers.assetType === "Commercial Property") {
        root.innerHTML = `
          <h2 class="step-title">Net Operating Income (NOI)</h2>
          ${disclaimer}
          <label class="field-label">Annual NOI <span class="req">*</span></label>
          <input type="number" id="noi-input" placeholder="$">
          <div class="error-text" id="noi-error">Required.</div>
        `;
        root.querySelector("#noi-input").value = answers.commercialNOI || "";
      } else if (answers.assetType === "Business") {
        root.innerHTML = `
          <h2 class="step-title">Business Earnings</h2>
          ${disclaimer}
          <label class="field-label">Approximate Annual Revenue <span class="req">*</span></label>
          <input type="number" id="revenue-input" placeholder="$">
          <div class="error-text" id="revenue-error">Required.</div>
          <label class="field-label" id="earnings-label">Approximate Annual Earnings <span class="req">*</span></label>
          <input type="number" id="earnings-input" placeholder="$">
          <div class="hint" id="earnings-hint"></div>
          <div class="error-text" id="earnings-error">Required.</div>
        `;
        const revenueInput = root.querySelector("#revenue-input");
        const earningsInput = root.querySelector("#earnings-input");
        revenueInput.value = answers.businessRevenue || "";
        earningsInput.value = answers.businessEarnings || "";
        const updateEarningsLabel = () => {
          const revenue = Number(revenueInput.value) || 0;
          const earnings = Number(earningsInput.value) || 0;
          const useEbitda = revenue > 5000000 || earnings > 1000000;
          answers.businessEarningsType = useEbitda ? "EBITDA" : "SDE";
          root.querySelector("#earnings-label").innerHTML = `Approximate Annual ${answers.businessEarningsType} <span class="req">*</span>`;
          root.querySelector("#earnings-hint").textContent = useEbitda
            ? "Based on this size, please provide EBITDA."
            : "Based on this size, please provide SDE (Seller's Discretionary Earnings).";
        };
        revenueInput.oninput = updateEarningsLabel;
        earningsInput.oninput = updateEarningsLabel;
        updateEarningsLabel();
      } else {
        root.innerHTML = `<p class="step-sub">Please go back and select an asset type first.</p>`;
      }
    },
    validate(root) {
      if (answers.assetType === "Residential Property (1-4 units)") {
        if (answers.propertyRentReady === "No" && answers.buyerIntendsToSell) return true;
        const ok1 = !!answers.residentialOccupied;
        toggleError(root, "#occupied-error", !ok1);
        if (!ok1) return false;

        // forcedSellerFinancingOnly (set in cashDealDetails when ARV lands too close to asking with
        // no rehab needed) means this deal only works if it actually cash flows as a rental -- checked
        // once this step's own required fields are satisfied, regardless of which occupied/vacant
        // sub-path produced the NOI numbers.
        const cashflowGateOk = () => {
          if (!answers.forcedSellerFinancingOnly) return true;
          const okCashflow = (Number(answers.residentialNOI) || 0) > 0 || (Number(answers.strNOI) || 0) > 0;
          toggleError(root, "#cashflow-required-error", !okCashflow);
          return okCashflow;
        };

        if (answers.residentialOccupied === "Occupied (has a landlord/tenant)") {
          const occUnits = Number(answers.units) || 1;
          answers.residentialNOI = root.querySelector("#noi-input").value;
          answers.annualPropertyTaxes = root.querySelector("#occ-taxes-input").value;
          answers.annualInsurance = root.querySelector("#occ-insurance-input").value;
          answers.currentLeaseTerm = root.querySelector("#lease-term-input").value.trim();
          let okOcc = true;
          toggleError(root, "#noi-error", !answers.residentialNOI); if (!answers.residentialNOI) okOcc = false;
          toggleError(root, "#rent-rolls-error", !answers.hasRentRolls); if (!answers.hasRentRolls) okOcc = false;
          if (answers.hasRentRolls === "Yes") {
            toggleError(root, "#has-pl-error", !answers.hasProfitLoss); if (!answers.hasProfitLoss) okOcc = false;
          }
          toggleError(root, "#deliverable-vacant-error", !answers.deliverableVacant); if (!answers.deliverableVacant) okOcc = false;
          toggleError(root, "#lease-term-error", !answers.currentLeaseTerm); if (!answers.currentLeaseTerm) okOcc = false;
          if (occUnits === 1) {
            answers.leaseEndDate = root.querySelector("#lease-end-input").value.trim();
            toggleError(root, "#lease-end-error", !answers.leaseEndDate); if (!answers.leaseEndDate) okOcc = false;
            toggleError(root, "#tenant-move-early-error", !answers.tenantWouldMoveEarly); if (!answers.tenantWouldMoveEarly) okOcc = false;
          } else {
            answers.strNoiPerUnit = root.querySelector("#str-noi-per-unit-input").value;
          }
          const okCashflow = cashflowGateOk();
          return okOcc && okCashflow;
        }
        // Vacant (no tenant) -- always computes both LTR and STR so admin can compare
        const vacantUnits = Number(answers.units) || 1;
        const vacantIsMultiUniform = vacantUnits >= 2 && vacantUnits <= 4 && answers.unitsUniform === "Yes";
        answers.annualPropertyTaxes = root.querySelector("#taxes-input").value;
        answers.annualInsurance = root.querySelector("#insurance-input").value;
        answers.rentcastMonthlyRent = root.querySelector("#rent-input").value;
        // For single-family (units===1), expenseRatio/residentialNOI are already kept current
        // by recompute() (1.1%-of-price formula, no manual input to re-read here). Multi-unit
        // still has a manual Expense Ratio % input to validate.
        let ok = true;
        if (vacantUnits !== 1) {
          answers.expenseRatio = root.querySelector("#expense-ratio-input").value;
          toggleError(root, "#expense-ratio-error", !answers.expenseRatio); if (!answers.expenseRatio) ok = false;
        }
        const strRevenueEntered = root.querySelector("#str-revenue-input").value;
        // The input holds a PER-UNIT figure when units are uniform -- always store the
        // multiplied TOTAL in answers.strAnnualRevenue, matching what recompute() already
        // keeps in sync on every keystroke (redone here explicitly rather than relying on
        // that timing, since this is also what actually gets submitted).
        answers.strAnnualRevenue = vacantIsMultiUniform && strRevenueEntered
          ? Number(strRevenueEntered) * vacantUnits
          : strRevenueEntered;
        toggleError(root, "#taxes-error", !answers.annualPropertyTaxes); if (!answers.annualPropertyTaxes) ok = false;
        toggleError(root, "#insurance-error", !answers.annualInsurance); if (!answers.annualInsurance) ok = false;
        toggleError(root, "#rent-error", !answers.rentcastMonthlyRent); if (!answers.rentcastMonthlyRent) ok = false;
        toggleError(root, "#str-revenue-error", !strRevenueEntered); if (!strRevenueEntered) ok = false;
        const okCashflow = cashflowGateOk();
        return ok && okCashflow;
      } else if (answers.assetType === "Commercial Property") {
        answers.commercialNOI = root.querySelector("#noi-input").value;
        const ok = !!answers.commercialNOI;
        toggleError(root, "#noi-error", !ok);
        return ok;
      } else if (answers.assetType === "Business") {
        answers.businessRevenue = root.querySelector("#revenue-input").value;
        answers.businessEarnings = root.querySelector("#earnings-input").value;
        let ok = true;
        toggleError(root, "#revenue-error", !answers.businessRevenue); if (!answers.businessRevenue) ok = false;
        toggleError(root, "#earnings-error", !answers.businessEarnings); if (!answers.businessEarnings) ok = false;
        return ok;
      }
      return true;
    }
  },
  {
    key: "dualOfferTemplates",
    progress: true,
    // Runs for Cash Deal and Seller Financing alike -- cashDealDetails now computes the MAO/As-Is
    // Value numbers for both, so a cash offer can always be paired with the seller-financing one
    // regardless of which dealType this lead is. Land/Business don't fit the "cash vs.
    // seller-financed" framing, and a Seller filling this out about their own property has no one to
    // text these scripts to. Runs BEFORE cashDealOutcome (Deal Status) -- the associate needs the
    // actual offer text to send before they can have anything to report an outcome on.
    skip() {
      return (answers.dealType !== "Cash Deal" && answers.dealType !== "Seller Financing / Creative Finance")
        || answers.assetType === "Land"
        || answers.assetType === "Business"
        || answers.role === "Seller";
    },
    render(root) {
      const addressLine = `${answers.street || ""}, ${answers.city || ""}, ${answers.state || ""} ${answers.zip || ""}`.trim();
      const sellerName = answers.sellerContactName || "[Name]";
      const isMultifamily5Plus = Number(answers.units) > 4;
      // This whole "fix and flip" seller-financing structure (down now, payoff within a year or two)
      // assumes the property needs work. A turnkey property with no rehab gets a different, longer-
      // horizon structure instead -- rehabEstimate is already 0/blank whenever nothing was entered.
      const needsRehab = Number(answers.rehabEstimate) > 0;
      const payoffWindow = isMultifamily5Plus ? "2 years" : "1 year";
      const baseValue = Number(answers.asIsValue) || Number(answers.arv) || 0;
      const downAmt = Math.round(baseValue * 0.20);
      const balanceAmt = baseValue - downAmt;
      const down20 = Math.round(baseValue * 0.20);
      const down50 = Math.round(baseValue * 0.50);
      const maoCandidates = [answers.maoCash, answers.maoHardMoney10, answers.maoHardMoney20]
        .map(Number).filter(n => n > 0);
      const cashOfferAmt = maoCandidates.length ? Math.round(Math.min(...maoCandidates)) : 0;
      const highestMao = maoCandidates.length ? Math.round(Math.max(...maoCandidates)) : 0;
      const fmt = n => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });

      root.innerHTML = `
        <h2 class="step-title">Make Your Offers</h2>
        <p class="step-sub">One text, two options by default — a cash purchase or a seller-financed
        alternative. Never mention who's buying or whether it's an investor — just ask. Only drop an
        option below if the seller has already said no to it.</p>
        ${answers.forcedSellerFinancingOnly ? `
          <div class="banner warn" style="margin-bottom:16px;">ARV came in too close to asking price
          with no rehab needed on this one, so a cash offer isn't on the table -- this can only move
          forward as a seller financing offer at full asking price, contingent on it cash flowing as a
          rental (checked on the next step).</div>
        ` : highestMao > 0 ? `
          <div class="banner warn" style="margin-bottom:16px;">
            <strong>Highest Max Allowable Offer:</strong> ${fmt(highestMao)}
            <span class="small-muted">(the most you could offer this seller in cash and still hit a
            target return under any buyer profile — the text below intentionally opens lower than this
            so there's room to negotiate up)</span>
          </div>
        ` : `
          <div class="banner warn" style="margin-bottom:16px;">No cash offer number yet — go back to
          ${answers.dealType === "Cash Deal" ? "Cash Deal Details" : "Property Value & Repair Research"}
          and enter an ARV so a cash offer can be included below.</div>
        `}
        <div id="offer-script-wrap"></div>
      `;
      const wrap = root.querySelector("#offer-script-wrap");

      // Kept as two independent flags (not one "which option" choice) because either can get ruled
      // out on its own mid-conversation -- the script below adapts to whichever combination is live.
      const renderOfferScript = () => {
        // forcedSellerFinancingOnly (set in cashDealDetails when ARV lands too close to asking with
        // no rehab needed) rules cash out the same way a seller's own "no" does -- fold it into the
        // same flag rather than threading a second condition through every branch below.
        const cashDeclined = !!answers.sellerDeclinedCash || !!answers.forcedSellerFinancingOnly;
        const financeDeclined = !!answers.sellerDeclinedSellerFinancing;
        // Our written offer is a 30-day close for 1-4 units, full stop -- don't offer to move faster
        // for this seller. We HAVE closed in under 2 weeks before, so that track record is fair to
        // mention, but only as a past fact, not as a capability on offer for this particular deal.
        // 5+ units get a 45-60 day close, regardless of whether that deal needs rehab.
        // No hyphens or em dashes in anything copy-pasted below -- reads more like a real text and
        // less like something generated. Number ranges spell out "to" instead of using a hyphen.
        const cashClause = !cashOfferAmt ? "" : isMultifamily5Plus
          ? `$${cashOfferAmt.toLocaleString()} cash to purchase outright, with a 45 to 60 day close`
          : `$${cashOfferAmt.toLocaleString()} cash to purchase outright, with a 30 day close (our requirement for deals like this, though we have closed in under 2 weeks before)`;
        // Seller financing always gets framed as full asking price, contingent on the property
        // appraising at or above that -- this is the whole pitch for why they'd take financing over
        // a discounted cash offer, so it's baked into the clause itself rather than only mentioned
        // when cash has been ruled out.
        const financeClause = !baseValue ? "" : needsRehab
          ? `$${downAmt.toLocaleString()} down now, with the remaining $${balanceAmt.toLocaleString()} paid within ${payoffWindow}, at your full asking price as long as it appraises at or above that`
          : `seller financing, typically $${down20.toLocaleString()} to $${down50.toLocaleString()} down now, with the balance paid off over 5 to 15 years depending on terms, at your full asking price as long as it appraises at or above that`;

        let script = "";
        if (!cashDeclined && !financeDeclined && cashClause && financeClause) {
          script = `Hi ${sellerName}, saw ${addressLine} is for sale. Would you be open to ${cashClause}? As another option, we could also do ${financeClause}. Let me know which works better for you.`;
        } else if (!cashDeclined && cashClause) {
          script = `Hi ${sellerName}, saw ${addressLine} is for sale. Would you be open to ${cashClause}?`;
        } else if (!financeDeclined && financeClause) {
          script = `Hi ${sellerName}, saw ${addressLine} is for sale. Would you be open to ${financeClause}?`;
        }

        const showFinanceFollowup = !financeDeclined && baseValue;
        const sfQuestionLabel = needsRehab
          ? `Is the seller willing to accept 20% down for seller financing, paid off within ${payoffWindow}?`
          : "Is the seller willing to accept seller financing (20–50% down, 5–15 year payoff)?";
        const downPaymentResponse = needsRehab
          ? "Good question, I'll put a real offer together for you rather than guess over text. If 20% down "
            + "isn't enough, let me know what you have in mind and we'll review it and get back to you."
          : "Good question, it really depends on the terms we land on together, typically 20 to 50% down with "
            + "a 5 to 15 year payoff. Let me know what you're looking for and we'll put a real offer together for you.";
        const mfCashScript = "We work with a partner who has a network of over 6 million buyers. That's how "
          + "we'd get this property sold. It wouldn't be exclusive, so you're free to keep marketing "
          + "and selling it yourself while we bring a buyer forward.";
        const mfFinanceScript = "For seller financing, we already have a specific buyer ready to go.";

        wrap.innerHTML = `
          ${answers.forcedSellerFinancingOnly ? "" : `
            <label class="field-label" style="display:flex; align-items:center; gap:8px; font-weight:normal;">
              <input type="checkbox" id="cash-declined-checkbox" ${cashDeclined ? "checked" : ""}>
              Seller already said no to a cash offer <span class="small-muted">(e.g. won't negotiate on price at all)</span>
            </label>
          `}
          <label class="field-label" style="display:flex; align-items:center; gap:8px; font-weight:normal; margin-top:6px;">
            <input type="checkbox" id="finance-declined-checkbox" ${financeDeclined ? "checked" : ""}>
            Seller already said no to seller financing
          </label>
          ${script ? `
            <div class="banner info" style="margin-top:14px;">
              <strong>Text this:</strong>
              <br><span class="small-muted">${script}</span>
              <br><button type="button" class="btn secondary" id="offer-script-copy-btn" style="margin-top:8px;">Copy Text</button>
            </div>
          ` : (cashDeclined && financeDeclined) ? `
            <p class="hint">Both options are marked declined — nothing left to send. Uncheck one above if that's not right.</p>
          ` : `
            <p class="hint">Enter an ARV in ${answers.dealType === "Cash Deal" ? "Cash Deal Details" : "Property Value & Repair Research"} to generate an offer text.</p>
          `}
          ${isMultifamily5Plus && (!cashDeclined || !financeDeclined) ? `
            <div style="margin-top:16px;">
              <p class="hint"><strong>If they ask how this actually gets sold (5+ unit deals):</strong></p>
              ${!cashDeclined ? `
                <p class="hint"><span class="small-muted">Cash: "${mfCashScript}"</span>
                <br><button type="button" class="btn secondary" id="mf-cash-script-copy-btn" style="margin-top:6px;">Copy Text</button></p>
              ` : ""}
              ${!financeDeclined ? `
                <p class="hint" style="margin-top:${!cashDeclined ? "10px" : "0"};"><span class="small-muted">Seller Financing: "${mfFinanceScript}"</span>
                <br><button type="button" class="btn secondary" id="mf-finance-script-copy-btn" style="margin-top:6px;">Copy Text</button></p>
              ` : ""}
            </div>
          ` : ""}
          ${showFinanceFollowup ? `
            <p class="hint" style="margin-top:16px;"><strong>If they ask how much down:</strong> don't commit
            to a number over text — just tell them you'll review and get back to them.
            <br><span class="small-muted">"${downPaymentResponse}"</span>
            <br><button type="button" class="btn secondary" id="down-payment-script-copy-btn" style="margin-top:8px;">Copy Text</button>
            </p>
            <label class="field-label" style="margin-top:16px;">${sfQuestionLabel} <span class="small-muted">(optional — fill in once you've asked)</span></label>
            <div class="choice-group" id="sf-accept-group">
              ${["Yes", "No", "Negotiating"].map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
            </div>
            <label class="field-label" style="margin-top:12px;">What are they negotiating for / countering with? <span class="small-muted">(optional)</span></label>
            <textarea id="sf-negotiation-notes" placeholder="e.g. wants 30% down instead of 20%, wants a shorter payoff term..."></textarea>
          ` : ""}
        `;
        if (!answers.forcedSellerFinancingOnly) {
          wrap.querySelector("#cash-declined-checkbox").onchange = (e) => {
            answers.sellerDeclinedCash = e.target.checked;
            renderOfferScript();
          };
        }
        wrap.querySelector("#finance-declined-checkbox").onchange = (e) => {
          answers.sellerDeclinedSellerFinancing = e.target.checked;
          renderOfferScript();
        };
        wireCopyPromptButton(wrap, "#offer-script-copy-btn", () => script);
        wireCopyPromptButton(wrap, "#down-payment-script-copy-btn", () => downPaymentResponse);
        wireCopyPromptButton(wrap, "#mf-cash-script-copy-btn", () => mfCashScript);
        wireCopyPromptButton(wrap, "#mf-finance-script-copy-btn", () => mfFinanceScript);
        if (showFinanceFollowup) {
          bindChoiceGroup(wrap, "#sf-accept-group", "sellerFinancingAccepted");
          const notesInput = wrap.querySelector("#sf-negotiation-notes");
          notesInput.value = answers.sellerFinancingNegotiationNotes || "";
          notesInput.oninput = (e) => { answers.sellerFinancingNegotiationNotes = e.target.value; };
        }
      };
      renderOfferScript();
    },
    validate() {
      return true; // informational/optional -- doesn't block submission either way
    }
  },
  {
    key: "cashDealOutcome",
    progress: true,
    // This is written from the associate's side of a negotiation with a third-party seller --
    // doesn't make sense to ask a seller "what price has the seller agreed to" about themselves.
    // Runs AFTER dualOfferTemplates (Make Your Offers) -- the associate needs the offer text from
    // that step to actually text the seller before there's any outcome to report here.
    skip() { return answers.dealType !== "Cash Deal" || answers.role === "Seller"; },
    render(root) {
      // Residential/commercial cash deals must pencil out under at least one buyer profile before
      // they can be submitted -- Business isn't held to this since it doesn't get a comparable MAO
      // suite the same way. Highest MAO = the most a buyer could still pay under ANY of the three
      // profiles (Cash, Hard Money low/high Down -- 10%/20% for residential/commercial, 30%/50%
      // for land); if the seller won't come down below that, the deal
      // doesn't work under any scenario and there's nothing to submit yet.
      const isEligibleAssetType = answers.assetType === "Residential Property (1-4 units)"
        || answers.assetType === "Commercial Property" || answers.assetType === "Land";
      const highestMao = Math.max(answers.maoCash || 0, answers.maoHardMoney10 || 0, answers.maoHardMoney20 || 0);
      const fmt = n => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
      // Reuses sellerDeclinedCash (also set on Make Your Offers) rather than a separate field --
      // "seller's floor is above our MAO" and "seller won't negotiate at all" both mean the same
      // thing downstream: no viable cash deal, pivot to a seller-financing-only offer at full
      // asking price with an appraisal contingency. Setting it here also updates what Make Your
      // Offers would generate if the associate goes back to it.
      // The pivot only exists if seller financing is actually still on the table -- if the seller
      // already ruled it out too (sellerDeclinedSellerFinancing, also from Make Your Offers), there's
      // no fallback structure at all, so this page has to stay a hard block until the cash price
      // actually comes down below MAO.
      const financingAvailable = !answers.sellerDeclinedSellerFinancing;
      const cashRejected = financingAvailable && !!answers.sellerDeclinedCash;

      root.innerHTML = `
        <h2 class="step-title">Deal Status</h2>
        <p class="hint">This page is for cash offers. Use the Max Allowable Offer below as your
        negotiating target.${financingAvailable
          ? ` If the seller genuinely won't come down below it, let them know we'd need to do this as
          seller financing instead, then use the button below to submit it that way, at the seller's
          full asking price with an appraisal contingency.`
          : ` The seller already said no to seller financing, so this has to close as a cash deal
          below that number — keep negotiating until it does.`}</p>
        <label class="field-label">Is this property currently under contract? <span class="req">*</span></label>
        <div class="choice-group" id="under-contract-group">
          ${["Yes", "No"].map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
        </div>
        <div class="error-text" id="under-contract-error">Please choose one.</div>
        <p class="hint">Please don't put this under contract yourself — let admin handle that once we've
        double-checked the numbers against our current buyer pool and confirmed it still looks good on our end.</p>

        ${isEligibleAssetType && highestMao > 0 ? `
          <div class="banner warn" style="margin-top:16px;">
            <strong>Highest Max Allowable Offer:</strong> ${fmt(highestMao)}
            <span class="small-muted">(the greater of the Cash Buyer / Hard Money ${answers.assetType === "Land" ? "30%" : "10%"} Down / Hard Money ${answers.assetType === "Land" ? "50%" : "20%"}
            Down numbers from the Cash Deal Details step)</span>
            <br><span class="small-muted">The seller's accepted price has to land below this number for
            a cash offer to work. Negotiate toward it.${financingAvailable
              ? ` If they won't come down that far, let them know we'd need to go with seller financing instead.`
              : ` The seller already declined seller financing, so there's no fallback here -- it has to land below this number.`}</span>
          </div>
          ${financingAvailable ? `
            <div style="margin-top:12px;">
              <button type="button" class="btn ghost-small${cashRejected ? " active" : ""}" id="cash-rejected-btn">Seller did not agree to a cash price below MAO</button>
            </div>
            ${cashRejected ? `
              <div class="banner info" style="margin-top:12px;">This will submit as a seller financing
              offer only, at the seller's full asking price with an appraisal contingency, instead of a
              cash deal.</div>
            ` : ""}
          ` : ""}
        ` : ""}

        <label class="field-label" style="margin-top:16px;">${cashRejected ? "What price is the seller asking for the property?" : "What price has the seller agreed to accept?"}
          ${isEligibleAssetType
            ? `<span class="req">*</span>`
            : `<span class="small-muted">(optional — fill this in once you have it, even if that means coming back later)</span>`}
        </label>
        <input type="number" id="accepted-price-input" placeholder="$">
        <div class="error-text" id="accepted-price-error"></div>
        <p class="hint">Once you enter ${cashRejected ? "an asking price" : "an accepted price"}, admin will reach out to you with next steps for
        sending a formal offer (assuming it's not already under contract).</p>
      `;
      root.querySelector("#accepted-price-input").value = answers.sellerAcceptedPrice || "";
      bindChoiceGroup(root, "#under-contract-group", "underContract");

      if (isEligibleAssetType && highestMao > 0) {
        if (financingAvailable) {
          root.querySelector("#cash-rejected-btn").onclick = () => {
            answers.sellerDeclinedCash = !answers.sellerDeclinedCash;
            renderStep();
          };
        }
        if (!cashRejected) {
          root.querySelector("#accepted-price-input").oninput = (e) => {
            const price = Number(e.target.value) || 0;
            const errorEl = root.querySelector("#accepted-price-error");
            if (price && price >= highestMao) {
              errorEl.textContent = financingAvailable
                ? `This is at or above the highest Max Allowable Offer (${fmt(highestMao)}) -- keep negotiating toward that number. If the seller genuinely won't come down below it, let them know we'd need to do this as seller financing instead, then press the "Seller did not agree to a cash price below MAO" button above.`
                : `This is at or above the highest Max Allowable Offer (${fmt(highestMao)}) -- the seller already declined seller financing, so keep negotiating until this comes in below that number.`;
              errorEl.classList.add("show");
            } else {
              errorEl.classList.remove("show");
            }
          };
        }
      }
    },
    validate(root) {
      const isEligibleAssetType = answers.assetType === "Residential Property (1-4 units)"
        || answers.assetType === "Commercial Property" || answers.assetType === "Land";
      const highestMao = Math.max(answers.maoCash || 0, answers.maoHardMoney10 || 0, answers.maoHardMoney20 || 0);
      const fmt = n => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
      const financingAvailable = !answers.sellerDeclinedSellerFinancing;
      const cashRejected = financingAvailable && !!answers.sellerDeclinedCash;

      answers.sellerAcceptedPrice = root.querySelector("#accepted-price-input").value;
      let ok = !!answers.underContract;
      toggleError(root, "#under-contract-error", !answers.underContract);

      const priceErrorEl = root.querySelector("#accepted-price-error");
      if (isEligibleAssetType) {
        const price = Number(answers.sellerAcceptedPrice) || 0;
        if (!answers.sellerAcceptedPrice) {
          priceErrorEl.textContent = cashRejected
            ? "Required -- enter the seller's asking price so admin can structure the seller financing offer."
            : "Required -- the seller needs to agree to a price before this lead can be submitted.";
          priceErrorEl.classList.add("show");
          ok = false;
        } else if (!cashRejected && highestMao > 0 && price >= highestMao) {
          priceErrorEl.textContent = financingAvailable
            ? `This is at or above the highest Max Allowable Offer (${fmt(highestMao)}) -- keep negotiating toward that number. If the seller genuinely won't come down below it, let them know we'd need to do this as seller financing instead, then press the "Seller did not agree to a cash price below MAO" button above.`
            : `This is at or above the highest Max Allowable Offer (${fmt(highestMao)}) -- the seller already declined seller financing, so keep negotiating until this comes in below that number.`;
          priceErrorEl.classList.add("show");
          ok = false;
        } else {
          priceErrorEl.classList.remove("show");
        }
      } else {
        priceErrorEl.classList.remove("show");
      }
      return ok;
    }
  },
  {
    key: "review",
    progress: true,
    render(root) {
      const rows = buildAnswerRows();
      root.innerHTML = `
        <h2 class="step-title">Review</h2>
        <p class="step-sub">Double check everything before submitting.</p>
        <dl class="review-grid">
          ${rows.map(([k,v]) => `<div><dt>${k}</dt><dd>${escapeHtml(String(v ?? "—"))}</dd></div>`).join("")}
        </dl>
        <div class="error-text show" id="submit-error" style="display:none;"></div>
      `;
    },
    validate() { return true; }
  }
];

let stepIndex = 0;

function buildAnswerRows() {
  const rows = [
    ["Role", answers.role], ["Name", answers.name], ["Email", answers.email], ["Phone", answers.phone],
    ["Social Link", answers.socialLink || "—"],
    ["Referred By", answers.referrerName || "—"], ["Referrer Phone", answers.referrerPhone || "—"],
  ];
  if (answers.role && answers.role !== "Seller") {
    rows.push(
      ["Seller/Realtor/Broker Name", answers.sellerContactName || "—"],
      ["Seller/Realtor/Broker Phone", answers.sellerContactPhone || "—"],
      ["Seller/Realtor/Broker Email", answers.sellerContactEmail || "—"]
    );
  }
  rows.push(
    ["Address", `${answers.street}, ${answers.city}, ${answers.state} ${answers.zip}`],
    ["Parcel ID(s)", answers.parcelIds || "—"],
    ["Units", answers.units],
    ["Asset Type", answers.assetType],
    ["Subtype / Details", answers.assetSubtype || [answers.beds && `${answers.beds} bd`, answers.baths && `${answers.baths} ba`, answers.acreage && `${answers.acreage} acres`, answers.sqft && `${answers.sqft} sqft`].filter(Boolean).join(", ")],
    ["Deal Type", answers.dealType || "—"]
  );
  if (answers.assetType === "Land") {
    rows.push(["Zoning", answers.landZoning || "—"]);
  }
  // Seller Financing deals now collect the same ARV/rehab/comps data Cash Deals do (see
  // cashDealDetails' skip()), so admin has both that AND the income/NOI numbers below -- these two
  // blocks are independent (not else-if) specifically to allow that overlap.
  const showsCashDealFields = answers.dealType === "Cash Deal" || answers.dealType === "Seller Financing / Creative Finance";
  if (showsCashDealFields) {
    rows.push(
      ["Chase Bank Estimated Value", answers.chaseEstimate || "—"],
      ["Asking Price", answers.askingPrice || "—"],
      ["ARV", answers.arv || "—"],
      ["As-Is Value", answers.asIsValue || "—"],
      ["Pictures Link", answers.picturesLink || "—"],
      ["Rehab Estimate — Low", answers.rehabEstimateLow || "—"],
      ["Rehab Estimate — High", answers.rehabEstimateHigh || "—"],
      ["Rehab Estimate (average)", answers.rehabEstimate || "—"],
      ["County Assessed Value", answers.countyAssessedValue || "—"],
      ["CMA Screenshots", (answers.cmaScreenshotUrls || []).join("\n") || "—"],
      ["Bottom Dollar Price", answers.bottomDollarPrice || "—"],
      ["Notes (Why Sell / Good Lead)", answers.cashDealNotes || "—"]
    );
    if (answers.role !== "Seller") {
      if (answers.dealType === "Cash Deal") {
        rows.push(
          ["Wholesale Fee", answers.wholesaleFee || "—"],
          ["Under Contract", answers.underContract || "—"],
          ["Seller Accepted Price", answers.sellerAcceptedPrice || "—"]
        );
      }
      // Make Your Offers runs for Cash Deal and Seller Financing alike (see dualOfferTemplates'
      // skip()) so these fields, and the Highest MAO it's built around, need to show for both --
      // previously gated to Cash Deal only, which silently hid all of this for Seller Financing.
      if (answers.assetType !== "Land" && answers.assetType !== "Business") {
        const maoCandidates = [answers.maoCash, answers.maoHardMoney10, answers.maoHardMoney20]
          .map(Number).filter(n => n > 0);
        if (maoCandidates.length) {
          rows.push(["Highest Max Allowable Offer", "$" + Math.round(Math.max(...maoCandidates)).toLocaleString()]);
        }
        rows.push(
          ["Seller Declined Cash Offer", answers.sellerDeclinedCash ? "Yes" : "No"],
          ["Seller Declined Seller Financing", answers.sellerDeclinedSellerFinancing ? "Yes" : "No"],
          ["Seller Financing Accepted (20% Down)", answers.sellerFinancingAccepted || "—"],
          ["Seller Financing Negotiation Notes", answers.sellerFinancingNegotiationNotes || "—"]
        );
      }
    }
  }
  if (answers.dealType !== "Cash Deal" || answers.role === "Seller") {
    if (answers.assetType === "Residential Property (1-4 units)") {
      rows.push(["Rent Ready", answers.propertyRentReady || "—"]);
      if (answers.propertyRentReady === "No") {
        rows.push(["Buyer Intends To Sell", answers.buyerIntendsToSell ? "Yes" : "No"]);
      }
      if (!answers.buyerIntendsToSell) {
        rows.push(["Occupied Status", answers.residentialOccupied || "—"]);
      }
      if (answers.residentialOccupied === "Vacant (no tenant)") {
        rows.push(
          ["Annual Property Taxes", answers.annualPropertyTaxes || "—"],
          ["Annual Insurance", answers.annualInsurance || "—"],
          ["Rentcast Monthly Rent", answers.rentcastMonthlyRent || "—"],
          ["Expense Ratio %", answers.expenseRatio || "—"],
          ["Long-Term Rental NOI", answers.residentialNOI || "—"],
          ["STR Annual Revenue (airdna.co)", answers.strAnnualRevenue || "—"],
          ["Short-Term Rental NOI", answers.strNOI || "—"]
        );
      } else if (answers.residentialOccupied === "Occupied (has a landlord/tenant)") {
        rows.push(
          ["Long-Term Rental NOI", answers.residentialNOI || "—"],
          ["Annual Property Taxes", answers.annualPropertyTaxes || "—"],
          ["Annual Insurance", answers.annualInsurance || "—"],
          ["Has 12mo Rent Rolls", answers.hasRentRolls || "—"],
          ["Has 12mo P&L", answers.hasRentRolls === "Yes" ? (answers.hasProfitLoss || "—") : "N/A"],
          ["Deliverable Vacant", answers.deliverableVacant || "—"],
          ["Current Lease Term", answers.currentLeaseTerm || "—"]
        );
        if (Number(answers.units) === 1) {
          rows.push(
            ["Lease End Date", answers.leaseEndDate || "—"],
            ["Tenant Would Move Early", answers.tenantWouldMoveEarly || "—"]
          );
        } else {
          rows.push(["STR NOI Per Unit", answers.strNoiPerUnit || "—"]);
        }
        if (answers.deliverableVacant === "Yes" && answers.strAnnualRevenue) {
          rows.push(
            ["STR Annual Revenue (airdna.co)", answers.strAnnualRevenue || "—"],
            ["Short-Term Rental NOI", answers.strNOI || "—"]
          );
        }
      }
    } else if (answers.assetType === "Commercial Property") {
      rows.push(["NOI", answers.commercialNOI || "—"]);
    } else if (answers.assetType === "Business") {
      rows.push(
        ["Annual Revenue", answers.businessRevenue || "—"],
        [`Annual ${answers.businessEarningsType || "Earnings"}`, answers.businessEarnings || "—"]
      );
    }
  }
  rows.push(
    ["Total Debt", answers.debtUnknown ? "Unknown" : (answers.totalDebt || "—")],
    ["Willing: New Senior Loan", answers.seniorLoanWilling],
    ["Willing: Payment Structure", answers.paymentStructureWilling],
    ["Price Sought", answers.priceSought],
    ["Price Reasoning", answers.priceReasoning],
    ["Down Payment Intended Use", answers.dpSkipped || !answers.downPaymentIntent ? "—" : answers.downPaymentIntent],
    ["Down Payment Needed", answers.dpSkipped || !answers.downPaymentNeeded ? "Skipped" : answers.downPaymentNeeded],
    ["Seller Flexible on Down Payment", answers.downPaymentNonNegotiable || "N/A"],
    ["On/Off Market", answers.marketStatus || "—"],
    ["Listing Source Link", answers.sourceLink || "—"]
  );
  return rows;
}

// Shared by every "Copy Prompt" button (county assessed value, taxes, insurance, etc.) so each new
// one doesn't need to reimplement the clipboard-with-fallback dance.
function wireCopyPromptButton(root, buttonSelector, getText) {
  const btn = root.querySelector(buttonSelector);
  if (!btn) return;
  btn.onclick = () => {
    const text = getText();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        alert("Prompt copied to clipboard.");
      }).catch(() => {
        prompt("Copy this prompt:", text);
      });
    } else {
      prompt("Copy this prompt:", text);
    }
  };
}

function bindChoiceGroup(root, selector, answerKey) {
  root.querySelectorAll(selector + " .choice-btn").forEach(btn => {
    if (btn.dataset.value === answers[answerKey]) btn.classList.add("selected");
    btn.onclick = () => {
      root.querySelectorAll(selector + " .choice-btn").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      answers[answerKey] = btn.dataset.value;
    };
  });
}

function toggleError(root, selector, show) {
  const el = root.querySelector(selector);
  if (el) el.classList.toggle("show", !!show);
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}

// Full MAO suite: Cash Buyer, Hard Money Buyer (10% down), Hard Money Buyer (20% down).
//
// Hard Money (10%/20% down) uses the given leveraged formula as-is:
//   MAO = (ARV - Rehab - Selling Costs - [Upfront Cash x (1+Target ROI)])
//         / (1 + [Down Payment% x (1+Target ROI)] + Financing Cost%) - Wholesale Fee
//
// Cash Buyer is NOT the "100% down payment" case of that same formula -- an earlier version plugged
// DP%=100% into it directly, which double counts return-of-capital (the leading "1" in the
// denominator already represents repaying the full price; adding another full "+100%" on top repays
// it a second time), understating Cash Buyer MAO by roughly half. Solving the same target-return-on-
// cash-invested equation with no debt at all collapses cleanly to the simpler, debt-free formula:
//   MAO = (ARV - Rehab - Selling Costs) / (1 + Target ROC) - Wholesale Fee
// with no Upfront Cash or Financing Cost terms, since an all-cash purchase has no loan to originate
// or pay interest on.
//
// Selling Costs are a flat 8% of ARV: realtor commission (~6%) plus title/escrow fees (~2%) on the
// resale side -- bumped up from a commission-only 6% since that left out real closing costs a seller
// pays at resale. Purchase Closing Costs are a separate, additional 1% of ARV on the BUY side: no
// commission (buyers don't typically pay realtor commission at purchase), just the buyer's customary
// share of title/escrow fees, applied to every variant (Cash and Hard Money alike, since purchase
// closing costs are paid regardless of financing method -- this is distinct from Upfront Cash, which
// is a hard-money-loan-specific fee). Upfront Cash (hard-money loan points/fees) is 2% of ARV for
// residential 1-4 units, 3% for anything else (commercial/business) -- only charged on the Hard
// Money variants. Financing Cost% = a flat 12% approximate hard money annual rate x (estimated hold
// months / 12); hold months come from a rehab-severity tier bucketed by rehab as a % of ARV (<10%
// light, 10-25% moderate, >=25% heavy) -- the exact ratio cutoffs aren't specified by the given
// timeline matrices (which bucket by scope of work, not a number we collect), so this is the closest
// quantitative proxy available and should be tuned if it doesn't match real deals.
//
// Target ROI/ROC differs by variant and asset type:
// - Hard Money (10%/20% down), any asset type, and Cash Buyer on commercial/business: a floor that
//   steps down as ARV grows for residential (25% under $250k, 20% from $250k-$500k, 15% at $500k+),
//   or is keyed to the rehab-severity tier for commercial/business (18% light TI, 22% heavy adaptive
//   reuse, 25% ground-up).
// - Cash Buyer on residential: a separate "Target ROC by Strategy & Scope" scale specifically for an
//   all-cash fix-and-flip exit (buy, rehab, resell -- not a buy-and-hold cap rate, which would need
//   rental income data this flow doesn't collect), keyed to the same rehab-severity tier: 8-11%
//   Cosmetic Refresh, 12-15% Moderate Value-Add, 16-20%+ Heavy Gut/Structural, using the midpoint of
//   each range (9.5%/13.5%/18%).
//
// With these parameters (12% hard money rate, 2-15% financing cost depending on hold length, 2-3%
// upfront loan fees, 20-25% Hard Money ROI vs 9.5-22% Cash ROC), Cash Buyer MAO comes out HIGHER
// than both Hard Money variants in every case tested -- residential and commercial, light and heavy
// rehab. That's not a bug: the given Hard Money formula's financing cost and upfront loan fees are
// real dollar drags that a cash buyer never pays, and on top of that Cash Buyer's target return here
// is usually well below Hard Money's, so the two effects compound instead of leverage winning out.
// If the goal is for Hard Money to show as more competitive than Cash, the fix is to tune Hard
// Money's ROI down and/or its financing-cost assumptions down, not the Cash formula.
//
// Wholesale Fee defaults to the greater of $25,000 or 3% of ARV, applied to every variant -- pass a
// 4th argument (wholesaleFeeOverride) to use a specific dollar amount instead, e.g. when an associate
// has negotiated a smaller fee for a given deal.
function computeMaoSuite(arv, rehab, assetType, wholesaleFeeOverride) {
  if (!arv) return null;
  const isCommercial = assetType !== "Residential Property (1-4 units)";
  // Land has no separate ARV/rehab concept -- the value plugged in here is already the As-Is
  // Value entered in Cash Deal Details (rehab is always 0), so the explanation text should say
  // that instead of "ARV" to match. The math itself is asset-type-agnostic either way.
  const valueLabel = assetType === "Land" ? "As-Is Value" : "ARV";
  const isLand = assetType === "Land";
  const ratio = rehab / arv;
  let tierName, months, targetRoi, cashTargetRoc;
  if (isLand) {
    // Rehab is always 0 for land (no repair/reno concept), so the rehab-ratio tiers below would
    // always land on the lightest bucket anyway -- name it for what it actually is instead of
    // reusing "Light Tenant Improvement" wording that implies a building with tenants.
    // Numbers are Tier 1 ("Micro/Small Projects", $20K-$250K land cost) of the land underwriting
    // framework: 22-30%+ target IRR (25% used here) and an 11-24 month lifecycle -- 15 months
    // matches the framework's own worked example ($100K equity returning $140K, a 1.4x multiple,
    // squarely inside its 1.3x-1.6x Tier 1 target).
    tierName = "Land Acquisition"; months = 15; targetRoi = 0.25; cashTargetRoc = targetRoi;
  } else if (isCommercial) {
    if (ratio < 0.10) { tierName = "Light Tenant Improvement"; months = 3.5; targetRoi = 0.18; }
    else if (ratio < 0.25) { tierName = "Heavy Adaptive Reuse / Value-Add"; months = 9; targetRoi = 0.22; }
    else { tierName = "Ground-Up / Major Expansion"; months = 15; targetRoi = 0.25; }
    cashTargetRoc = targetRoi;
  } else {
    if (ratio < 0.10) { tierName = "Cosmetic Refresh"; months = 2.5; cashTargetRoc = 0.095; }
    else if (ratio < 0.25) { tierName = "Moderate Rehab"; months = 5; cashTargetRoc = 0.135; }
    else { tierName = "Full Gut / Structural"; months = 8.5; cashTargetRoc = 0.18; }
    targetRoi = arv < 250000 ? 0.25 : (arv < 500000 ? 0.20 : 0.15);
  }
  const financingCostPct = 0.12 * (months / 12);
  const sellingCosts = 0.08 * arv;
  const purchaseClosingCosts = 0.01 * arv;
  const upfrontCashPct = isCommercial ? 0.03 : 0.02;
  const upfrontCash = upfrontCashPct * arv;
  const hasOverride = wholesaleFeeOverride !== undefined && wholesaleFeeOverride !== null && wholesaleFeeOverride !== "";
  const wholesaleFee = hasOverride ? Number(wholesaleFeeOverride) : Math.max(25000, 0.03 * arv);

  const money = n => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const pct1 = n => (n * 100).toFixed(1) + "%";
  const pct0 = n => (n * 100).toFixed(0) + "%";

  // Cash Buyer has no loan at all, so it isn't the "100% down payment" case of the leveraged
  // formula below -- plugging DP%=100% into that formula's "1 + [DP%x(1+ROI)]" denominator double
  // counts return-of-capital (the leading "1" already represents repaying the full price; adding
  // "+100%" on top repays it a second time), which understates Cash Buyer MAO by roughly half.
  // Solving the same target-ROI-on-cash-invested equation with no debt at all collapses cleanly to:
  //   MAO = (ARV - Rehab - Selling Costs) / (1 + Target ROC) - Wholesale Fee
  // matching the fee-subtracted-after-division convention the leveraged formula also uses.
  const cashMao = ((arv - rehab - sellingCosts - purchaseClosingCosts) / (1 + cashTargetRoc)) - wholesaleFee;
  const cashExplanation = `${money(arv)} ${valueLabel}, minus ${money(rehab)} repairs, minus ${money(sellingCosts)} selling `
    + `costs (8% of ${valueLabel} -- realtor commission plus title/escrow fees), minus ${money(purchaseClosingCosts)} `
    + `purchase-side closing costs (1% of ${valueLabel} -- title/escrow only, no commission on the buy side; buyer and `
    + `seller customarily split closing costs this way), divided by 1 + a ${pct1(cashTargetRoc)} target ROC `
    + `for this deal profile (${tierName}) -- no financing cost or upfront loan fees, since an all-cash `
    + `purchase has no loan -- minus a ${money(wholesaleFee)} wholesale fee — the greater of $25,000 or 3% of ${valueLabel}`;
  const cash = { mao: cashMao, explanation: cashExplanation };

  function variant(downPaymentPct, downPaymentLabel, roi, roiLabel) {
    const numerator = arv - rehab - sellingCosts - purchaseClosingCosts - (upfrontCash * (1 + roi));
    const denominator = 1 + (downPaymentPct * (1 + roi)) + financingCostPct;
    const mao = (numerator / denominator) - wholesaleFee;
    const explanation = `${money(arv)} ${valueLabel}, minus ${money(rehab)} repairs, minus ${money(sellingCosts)} selling `
      + `costs (8% of ${valueLabel} -- realtor commission plus title/escrow fees), minus ${money(purchaseClosingCosts)} `
      + `purchase-side closing costs (1% of ${valueLabel} -- title/escrow only, no commission on the buy side; buyer `
      + `and seller customarily split closing costs this way), minus ${money(upfrontCash)} upfront hard money `
      + `loan fees (${pct0(upfrontCashPct)} of ${valueLabel}) grossed up by the target ${roiLabel}, all divided by `
      + `1 + [${downPaymentLabel} down payment x (1 + ${pct1(roi)} target ${roiLabel})] + `
      + `${pct1(financingCostPct)} financing cost (a 12% approximate hard money rate over an estimated `
      + `${months}-month ${tierName.toLowerCase()} hold), minus a ${money(wholesaleFee)} wholesale fee — `
      + `the greater of $25,000 or 3% of ${valueLabel}`;
    return { mao, explanation };
  }

  // Land uses much heavier down payments than the other asset types -- 30%/50% instead of
  // 10%/20% -- reflecting how much harder land is to get conventional leverage on. The "10"/"20"
  // suffixes on the returned/stored field names (maoHardMoney10, MAO Hard Money (10% Down), etc.)
  // stay fixed regardless -- they just mean "lower-leverage variant" / "higher-leverage variant"
  // now, not literally 10%/20% -- renaming them would touch live Sheet column names for no benefit.
  const dp1Pct = isLand ? 0.30 : 0.10;
  const dp1Label = isLand ? "30%" : "10%";
  const dp2Pct = isLand ? 0.50 : 0.20;
  const dp2Label = isLand ? "50%" : "20%";
  const hm10 = variant(dp1Pct, dp1Label, targetRoi, "ROI");
  const hm20 = variant(dp2Pct, dp2Label, targetRoi, "ROI");

  const sheetBlurb = (label, mao, explanation) =>
    `Maximum Allowable Offer — ${label}: ${money(mao)}\n(${explanation}) = ${money(mao)}`;
  const fullBreakdown = [
    sheetBlurb("Cash Buyer", cash.mao, cash.explanation),
    sheetBlurb(`Hard Money Buyer (${dp1Label} Down)`, hm10.mao, hm10.explanation),
    sheetBlurb(`Hard Money Buyer (${dp2Label} Down)`, hm20.mao, hm20.explanation)
  ].join("\n\n");

  return {
    maoCash: cash.mao, maoHardMoney10: hm10.mao, maoHardMoney20: hm20.mao,
    cashExplanation: cash.explanation, hm10Explanation: hm10.explanation, hm20Explanation: hm20.explanation,
    fullBreakdown, tierName, targetRoi, hm10Label: dp1Label, hm20Label: dp2Label
  };
}

function shouldSkip(step) {
  return typeof step.skip === "function" && step.skip();
}

function nextIndex(from) {
  let i = from + 1;
  while (i < steps.length - 1 && shouldSkip(steps[i])) i++;
  return i;
}

function prevIndex(from) {
  let i = from - 1;
  while (i > 0 && shouldSkip(steps[i])) i--;
  return i;
}

function renderProgress() {
  const bar = document.getElementById("progress-bar");
  const trackable = steps.filter(s => s.progress && !shouldSkip(s));
  const currentTrackableIdx = steps.slice(0, stepIndex + 1).filter(s => s.progress && !shouldSkip(s)).length;
  bar.innerHTML = trackable.map((_, i) => `<div class="${i < currentTrackableIdx ? "done" : ""}"></div>`).join("");
}

function renderStep() {
  const container = document.getElementById("step-container");
  const step = steps[stepIndex];
  step.render(container);
  renderProgress();

  if (stepIndex === 0) return; // intro provides its own full navigation

  if (stepIndex > 1 && answers.email) {
    const emailBanner = document.createElement("div");
    emailBanner.className = "banner info";
    emailBanner.style.marginBottom = "16px";
    emailBanner.innerHTML = `Submitting as <strong>${escapeHtml(answers.email)}</strong> — your leads (and any
      notes you add to them later) will be accessible using this exact email address, so please use one only
      you have access to.`;
    container.insertBefore(emailBanner, container.firstChild);
  }

  const nav = document.createElement("div");
  nav.className = "nav-row";
  const isLast = stepIndex === steps.length - 1;
  nav.innerHTML = `
    ${stepIndex > 0 ? `<button class="btn secondary" id="back-btn">Back</button>` : `<span></span>`}
    <button class="btn primary" id="next-btn">${isLast ? "Submit" : "Next"}</button>
  `;
  container.appendChild(nav);

  if (stepIndex > 0) container.querySelector("#back-btn").onclick = () => goTo(prevIndex(stepIndex));
  container.querySelector("#next-btn").onclick = () => {
    if (step.validate && !step.validate(container)) return;
    if (isLast) { submitLead(container); return; }
    goTo(nextIndex(stepIndex));
  };
}

function goTo(idx) {
  stepIndex = idx;
  renderStep();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function submitLead(container) {
  const btn = container.querySelector("#next-btn");
  btn.disabled = true;
  btn.textContent = "Submitting...";
  const errBox = container.querySelector("#submit-error");
  try {
    const res = await api("submitLead", {
      data: {
        role: answers.role, name: answers.name, email: answers.email, phone: answers.phone, socialLink: answers.socialLink,
        referrerName: answers.referrerName, referrerPhone: answers.referrerPhone,
        sellerContactName: answers.sellerContactName, sellerContactPhone: answers.sellerContactPhone,
        sellerContactEmail: answers.sellerContactEmail,
        street: answers.street, parcelIds: answers.parcelIds, city: answers.city, state: answers.state, zip: answers.zip, units: answers.units,
        assetType: answers.assetType, assetSubtype: answers.assetSubtype,
        beds: answers.beds, baths: answers.baths, sqft: answers.sqft, acreage: answers.acreage, landZoning: answers.landZoning,
        dealType: answers.dealType,
        arv: answers.arv, chaseEstimate: answers.chaseEstimate, asIsValue: answers.asIsValue, picturesLink: answers.picturesLink, rehabEstimate: answers.rehabEstimate,
        rehabEstimateLow: answers.rehabEstimateLow, rehabEstimateHigh: answers.rehabEstimateHigh,
        countyAssessedValue: answers.countyAssessedValue,
        cmaScreenshotUrls: (answers.cmaScreenshotUrls || []).join("\n"),
        bottomDollarPrice: answers.bottomDollarPrice,
        cashDealNotes: answers.cashDealNotes, wholesaleFee: answers.wholesaleFee,
        maoCash: answers.maoCash, maoHardMoney10: answers.maoHardMoney10, maoHardMoney20: answers.maoHardMoney20,
        maoBreakdown: answers.maoBreakdown,
        underContract: answers.underContract, sellerAcceptedPrice: answers.sellerAcceptedPrice,
        sellerDeclinedCash: answers.sellerDeclinedCash ? "Yes" : "",
        sellerDeclinedSellerFinancing: answers.sellerDeclinedSellerFinancing ? "Yes" : "",
        sellerFinancingAccepted: answers.sellerFinancingAccepted, sellerFinancingNegotiationNotes: answers.sellerFinancingNegotiationNotes,
        propertyRentReady: answers.propertyRentReady,
        buyerIntendsToSell: answers.buyerIntendsToSell ? "Yes" : "",
        occupiedStatus: answers.residentialOccupied, monthlyRentEstimate: answers.rentcastMonthlyRent,
        strAnnualRevenue: answers.strAnnualRevenue, strNOI: answers.strNOI,
        annualPropertyTaxes: answers.annualPropertyTaxes, annualInsurance: answers.annualInsurance,
        expenseRatio: answers.expenseRatio,
        hasRentRolls: answers.hasRentRolls, hasProfitLoss: answers.hasProfitLoss,
        deliverableVacant: answers.deliverableVacant, currentLeaseTerm: answers.currentLeaseTerm,
        leaseEndDate: answers.leaseEndDate, tenantWouldMoveEarly: answers.tenantWouldMoveEarly,
        strNoiPerUnit: answers.strNoiPerUnit,
        noi: answers.residentialNOI || answers.commercialNOI,
        businessRevenue: answers.businessRevenue, businessEarningsType: answers.businessEarningsType,
        businessEarnings: answers.businessEarnings,
        totalDebt: answers.debtUnknown ? "" : answers.totalDebt,
        seniorLoanWilling: answers.seniorLoanWilling, paymentStructureWilling: answers.paymentStructureWilling,
        priceSought: answers.priceSought, priceReasoning: answers.priceReasoning,
        downPaymentIntent: answers.dpSkipped ? "" : answers.downPaymentIntent,
        downPaymentNeeded: answers.dpSkipped ? "" : answers.downPaymentNeeded,
        downPaymentNonNegotiable: answers.downPaymentNonNegotiable,
        marketStatus: answers.marketStatus, sourceLink: answers.sourceLink
      }
    });
    if (!res.ok) throw new Error(res.error || "Something went wrong.");
    const rows = buildAnswerRows();
    container.innerHTML = `
      <div class="success-box">
        <div class="check">&#9989;</div>
        <h2>Thank you</h2>
        <p class="step-sub">Your submission was received. Any agreed terms will still be confirmed directly
        with our admin (${ADMIN_CONTACT_PHONE}) before anything closes. Here's a copy of what was submitted:</p>
      </div>
      <div class="banner info" style="text-align:left;">${FOLLOWUP_REMINDER}</div>
      <dl class="review-grid" style="text-align:left;">
        ${rows.map(([k,v]) => `<div><dt>${k}</dt><dd>${escapeHtml(String(v ?? "—"))}</dd></div>`).join("")}
      </dl>
      <div class="nav-row" style="justify-content:center; gap:12px;">
        <button class="btn secondary" id="check-status-from-success-btn">Check Status On My Existing Leads (Non-Admin)</button>
        <button class="btn primary" id="submit-another-btn">Submit Another Lead</button>
      </div>
    `;
    container.querySelector("#submit-another-btn").onclick = () => {
      Object.keys(answers).forEach(k => delete answers[k]);
      goTo(0);
    };
    container.querySelector("#check-status-from-success-btn").onclick = () => {
      const justSubmittedEmail = answers.email;
      Object.keys(answers).forEach(k => delete answers[k]);
      answers.email = justSubmittedEmail;
      stepIndex = 0;
      showStatusView();
    };
  } catch (err) {
    errBox.style.display = "block";
    errBox.textContent = "Submission failed: " + err.message + ". Please try again.";
    btn.disabled = false;
    btn.textContent = "Submit";
  }
}

/* ---------- Save/resume progress via URL (client-side only, no backend) ---------- */

// These are all recomputed automatically from other saved answers (arv, rehabEstimate, assetType,
// countyAssessedValue) whenever the relevant step renders or validates -- leaving them out of the
// save/resume link keeps it shorter (maoBreakdown especially, a multi-paragraph blurb) without
// losing anything, since they're never a source of truth themselves.
const DERIVED_ANSWER_KEYS = ["asIsValue", "maoCash", "maoHardMoney10", "maoHardMoney20", "maoBreakdown"];

function buildShareUrl() {
  const trimmedAnswers = {};
  Object.keys(answers).forEach(k => {
    if (!DERIVED_ANSWER_KEYS.includes(k)) trimmedAnswers[k] = answers[k];
  });
  const payload = JSON.stringify({ a: trimmedAnswers, s: stepIndex });
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("resume", payload); // URLSearchParams handles encoding
  return url.toString();
}

function restoreFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("resume"); // already decoded by URLSearchParams
  if (!raw) return false;
  try {
    const payload = JSON.parse(raw);
    Object.assign(answers, payload.a || {});
    stepIndex = Math.min(Math.max(payload.s || 0, 0), steps.length - 1);
    return true;
  } catch (e) {
    return false;
  }
}

function restartWizard() {
  if (!confirm("Restart and clear all progress on this form? This can't be undone.")) return;
  Object.keys(answers).forEach(k => delete answers[k]);
  window.history.replaceState(null, "", window.location.pathname);
  document.getElementById("admin-view").hidden = true;
  document.getElementById("status-view").hidden = true;
  document.getElementById("public-view").hidden = false;
  goTo(0);
}

document.getElementById("restart-btn").onclick = restartWizard;
document.getElementById("status-followup-reminder").innerHTML = FOLLOWUP_REMINDER;

document.getElementById("save-progress-btn").onclick = () => {
  // Every step only writes its fields into `answers` inside validate() (normally triggered by the
  // Next button) -- so without this, anything typed into the CURRENT step but not yet advanced past
  // was silently missing from the saved link. Run validate() here purely for that side effect (sync
  // DOM -> answers), ignore its pass/fail, and clear any error highlights it triggers, since saving
  // progress with required fields still blank is explicitly allowed.
  const stepContainer = document.getElementById("step-container");
  const currentStep = steps[stepIndex];
  if (currentStep.validate) {
    currentStep.validate(stepContainer);
    stepContainer.querySelectorAll(".error-text.show").forEach(el => el.classList.remove("show"));
  }
  const url = buildShareUrl();
  window.history.replaceState(null, "", url);
  const message = "This saved link lets you pick up exactly where you left off. It's for your own use — anyone who has this link can see and resume this data, so don't share it with anyone else.";
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => {
      alert("Link copied to your clipboard.\n\n" + message);
    }).catch(() => {
      prompt(message + "\n\nCopy this link:", url);
    });
  } else {
    prompt(message + "\n\nCopy this link:", url);
  }
};

restoreFromUrl();
renderStep();

/* ============================================================
   NON-ADMIN: CHECK MY LEADS BY EMAIL
   No password on this path by design — knowing the email is the access
   check, matching how the backend's getLeadsByEmail/addPublicNote work.
   ============================================================ */

function showStatusView() {
  document.getElementById("public-view").hidden = true;
  document.getElementById("status-view").hidden = false;
  document.getElementById("status-email-input").value = answers.email || "";
  document.getElementById("status-leads-container").innerHTML = "";
  document.getElementById("status-pagination").innerHTML = "";
  document.getElementById("status-message").hidden = true;
  document.getElementById("status-email-error").classList.remove("show");
  statusSearchQuery = "";
  statusSortMode = "default";
  statusPage = 1;
  statusLeadsAll = [];
  statusLeadsEmail = "";
  document.getElementById("status-search-input").value = "";
  document.getElementById("status-search-input").hidden = true;
  document.getElementById("status-sort-select").value = "default";
  document.getElementById("status-sort-select").hidden = true;
}

function hideStatusView() {
  document.getElementById("status-view").hidden = true;
  document.getElementById("public-view").hidden = false;
}

document.getElementById("status-back-btn").onclick = hideStatusView;

document.getElementById("status-search-input").oninput = (e) => {
  statusSearchQuery = e.target.value.trim();
  statusPage = 1;
  renderStatusResultsTable(statusLeadsEmail, statusLeadsAll);
};

document.getElementById("status-sort-select").onchange = (e) => {
  statusSortMode = e.target.value;
  statusPage = 1;
  renderStatusResultsTable(statusLeadsEmail, statusLeadsAll);
};

document.getElementById("status-lookup-btn").onclick = async () => {
  const emailInput = document.getElementById("status-email-input");
  const email = emailInput.value.trim();
  const errEl = document.getElementById("status-email-error");
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  errEl.classList.toggle("show", !emailOk);
  if (!emailOk) return;

  statusSearchQuery = "";
  statusPage = 1;
  document.getElementById("status-search-input").value = "";

  const msgEl = document.getElementById("status-message");
  msgEl.hidden = false;
  msgEl.className = "banner info";
  msgEl.textContent = "Looking up your leads...";
  document.getElementById("status-leads-container").innerHTML = "";

  const res = await api("getLeadsByEmail", { email });
  if (!res.ok) {
    msgEl.className = "banner danger";
    msgEl.textContent = res.error || "Something went wrong.";
    return;
  }
  if (res.leads.length === 0) {
    msgEl.className = "banner info";
    msgEl.textContent = "No leads found for that email address.";
    return;
  }
  msgEl.hidden = true;
  renderStatusResultsTable(email, res.leads);
};

function buildLeadFields(lead) {
  const fields = [
    ["Submitted", formatDate(lead["Submitted At"])],
    ["Role", lead["Role"]], ["Name", lead["Contact Name"]], ["Email", lead["Contact Email"]], ["Phone", lead["Contact Phone"]],
    ["Social Link", lead["Social Link"] || "—"],
    ["Referred By", lead["Referrer Name"] || "—"], ["Referrer Phone", lead["Referrer Phone"] || "—"],
  ];
  if (lead["Role"] && lead["Role"] !== "Seller") {
    fields.push(
      ["Seller/Realtor/Broker Name", lead["Seller Contact Name"] || "—"],
      ["Seller/Realtor/Broker Phone", lead["Seller Contact Phone"] || "—"],
      ["Seller/Realtor/Broker Email", lead["Seller Contact Email"] || "—"]
    );
  }
  fields.push(
    ["Address", `${lead["Street Address"]}, ${lead["City"]}, ${lead["State"]} ${lead["Zip"]}`],
    ["Parcel ID(s)", lead["Parcel IDs"] || "—"],
    ["Units", lead["Units"]],
    ["Asset Type", lead["Asset Type"]], ["Subtype", lead["Asset Subtype"] || "—"],
    ["Beds", lead["Beds"] || "—"], ["Baths", lead["Baths"] || "—"], ["Acreage", lead["Acreage"] || "—"], ["Sq Ft", lead["Sq Ft"] || "—"],
    ["Deal Type", lead["Deal Type"] || "—"]
  );
  if (lead["Asset Type"] === "Land") {
    fields.push(["Zoning", lead["Land Zoning"] || "—"]);
  }
  // Mirrors buildAnswerRows() -- Seller Financing deals now collect both the ARV/rehab/comps block
  // AND the income/NOI block, so these two ifs are independent (not else-if) to let both show.
  const showsCashDealFields = lead["Deal Type"] === "Cash Deal" || lead["Deal Type"] === "Seller Financing / Creative Finance";
  if (showsCashDealFields) {
    fields.push(
      ["Chase Bank Estimated Value", lead["Chase Estimated Value"] || "—"],
      ["Asking Price", lead["Asking Price"] || "—"],
      ["ARV", lead["ARV"] || "—"],
      ["As-Is Value", lead["As-Is Value"] || "—"],
      ["Pictures Link", lead["Pictures Link"] || "—"],
      ["Rehab Estimate — Low", lead["Rehab Estimate Low"] || "—"],
      ["Rehab Estimate — High", lead["Rehab Estimate High"] || "—"],
      ["Rehab Estimate (average)", lead["Rehab Estimate"] || "—"],
      ["County Assessed Value", lead["County Assessed Value"] || "—"],
      ["CMA Screenshots", lead["CMA Screenshot URLs"] || "—"],
      ["Bottom Dollar Price", lead["Bottom Dollar Price"] || "—"],
      ["Notes (Why Sell / Good Lead)", lead["Cash Deal Notes"] || "—"]
    );
    if (lead["Role"] !== "Seller") {
      if (lead["Deal Type"] === "Cash Deal") {
        fields.push(
          ["Wholesale Fee", lead["Wholesale Fee"] || "—"],
          ["Under Contract", lead["Under Contract"] || "—"],
          ["Seller Accepted Price", lead["Seller Accepted Price"] || "—"]
        );
      }
      // Make Your Offers runs for Cash Deal and Seller Financing alike, so these fields (and the
      // Highest MAO it's built around) need to show for both -- previously gated to Cash Deal only,
      // which silently hid all of this for Seller Financing leads.
      if (lead["Asset Type"] !== "Land" && lead["Asset Type"] !== "Business") {
        const maoCandidates = [lead["MAO Cash"], lead["MAO Hard Money (10% Down)"], lead["MAO Hard Money (20% Down)"]]
          .map(Number).filter(n => n > 0);
        if (maoCandidates.length) {
          fields.push(["Highest Max Allowable Offer", "$" + Math.round(Math.max(...maoCandidates)).toLocaleString()]);
        }
        fields.push(
          ["Seller Declined Cash Offer", lead["Seller Declined Cash"] || "No"],
          ["Seller Declined Seller Financing", lead["Seller Declined Seller Financing"] || "No"],
          ["Seller Financing Accepted (20% Down)", lead["Seller Financing Accepted"] || "—"],
          ["Seller Financing Negotiation Notes", lead["Seller Financing Negotiation Notes"] || "—"]
        );
      }
    }
  }
  if (lead["Deal Type"] !== "Cash Deal" || lead["Role"] === "Seller") {
    if (lead["Asset Type"] === "Residential Property (1-4 units)") {
      fields.push(["Rent Ready", lead["Rent Ready"] || "—"]);
      const buyerIntendsToSell = lead["Rent Ready"] === "No" && lead["Buyer Intends To Sell"] === "Yes";
      if (lead["Rent Ready"] === "No") {
        fields.push(["Buyer Intends To Sell", lead["Buyer Intends To Sell"] || "No"]);
      }
      if (!buyerIntendsToSell) {
        fields.push(["Occupied Status", lead["Occupied Status"] || "—"]);
      }
      if (lead["Occupied Status"] === "Vacant (no tenant)") {
        fields.push(
          ["Annual Property Taxes", lead["Annual Property Taxes"] || "—"],
          ["Annual Insurance", lead["Annual Insurance"] || "—"],
          ["Rentcast Monthly Rent", lead["Monthly Rent Estimate"] || "—"],
          ["Expense Ratio %", lead["Expense Ratio %"] || "—"],
          ["Long-Term Rental NOI", lead["NOI"] || "—"],
          ["STR Annual Revenue (airdna.co)", lead["STR Annual Revenue"] || "—"],
          ["Short-Term Rental NOI", lead["STR NOI"] || "—"]
        );
      } else if (lead["Occupied Status"] === "Occupied (has a landlord/tenant)") {
        fields.push(
          ["Long-Term Rental NOI", lead["NOI"] || "—"],
          ["Annual Property Taxes", lead["Annual Property Taxes"] || "—"],
          ["Annual Insurance", lead["Annual Insurance"] || "—"],
          ["Has 12mo Rent Rolls", lead["Has Rent Rolls"] || "—"],
          ["Has 12mo P&L", lead["Has Rent Rolls"] === "Yes" ? (lead["Has P&L"] || "—") : "N/A"],
          ["Deliverable Vacant", lead["Deliverable Vacant"] || "—"],
          ["Current Lease Term", lead["Current Lease Term"] || "—"]
        );
        if (Number(lead["Units"]) === 1) {
          fields.push(
            ["Lease End Date", lead["Lease End Date"] || "—"],
            ["Tenant Would Move Early", lead["Tenant Would Move Early"] || "—"]
          );
        } else {
          fields.push(["STR NOI Per Unit", lead["STR NOI Per Unit"] || "—"]);
        }
        if (lead["Deliverable Vacant"] === "Yes" && lead["STR Annual Revenue"]) {
          fields.push(
            ["STR Annual Revenue (airdna.co)", lead["STR Annual Revenue"] || "—"],
            ["Short-Term Rental NOI", lead["STR NOI"] || "—"]
          );
        }
      }
    } else if (lead["Asset Type"] === "Commercial Property") {
      fields.push(["NOI", lead["NOI"] || "—"]);
    } else if (lead["Asset Type"] === "Business") {
      fields.push(
        ["Annual Revenue", lead["Business Revenue"] || "—"],
        [`Annual ${lead["Business Earnings Type"] || "Earnings"}`, lead["Business Earnings"] || "—"]
      );
    }
  }
  fields.push(
    ["Total Debt", lead["Total Debt"]],
    ["Willing: New Senior Loan", lead["Senior Loan Willing"]],
    ["Willing: Payment Structure", lead["Payment Structure Willing"]],
    ["Price Sought", lead["Price Sought"]], ["Price Reasoning", lead["Price Reasoning"]],
    ["Down Payment Intended Use", lead["Down Payment Intent"] || "—"],
    ["Down Payment Needed", lead["Down Payment Needed"]],
    ["Seller Flexible on Down Payment", lead["Down Payment Non-Negotiable"]],
    ["On/Off Market", lead["Market Status"] || "—"],
    ["Listing Source Link", lead["Source Link"] || "—"],
    ["Status", lead["Status"] || "New"]
  );
  return fields;
}

let statusLeadsAll = [];
let statusLeadsEmail = "";
let statusSearchQuery = "";
let statusSortMode = "default";
let statusPage = 1;

// Shared between the admin CRM and a user's own "check status" lead list -- both can otherwise
// grow into an endless-scroll table once someone's been submitting leads for a while.
const LEADS_PAGE_SIZE = 100;

// containerId: element to render Prev/Next controls into. page/totalItems/pageSize: current state.
// onChange(newPage): called with the page to switch to; caller re-renders its own table.
function renderPaginationControls(containerId, page, totalItems, pageSize, onChange) {
  const container = document.getElementById(containerId);
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  if (totalPages <= 1) { container.innerHTML = ""; return; }
  const startItem = (page - 1) * pageSize + 1;
  const endItem = Math.min(page * pageSize, totalItems);
  container.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:12px; flex-wrap:wrap;">
      <span class="small-muted">Showing ${startItem}&ndash;${endItem} of ${totalItems}</span>
      <div style="display:flex; align-items:center; gap:10px;">
        <button type="button" class="btn secondary" id="${containerId}-prev" ${page <= 1 ? "disabled" : ""}>Previous</button>
        <span class="small-muted">Page ${page} of ${totalPages}</span>
        <button type="button" class="btn secondary" id="${containerId}-next" ${page >= totalPages ? "disabled" : ""}>Next</button>
      </div>
    </div>
  `;
  container.querySelector(`#${containerId}-prev`).onclick = () => onChange(page - 1);
  container.querySelector(`#${containerId}-next`).onclick = () => onChange(page + 1);
}

function leadMatchesAddressSearch(lead, query) {
  if (!query) return true;
  const haystack = [lead["Street Address"], lead["City"], lead["State"], lead["Zip"]]
    .map(v => String(v || "").toLowerCase()).join(" ");
  return haystack.indexOf(query.toLowerCase()) !== -1;
}

function renderStatusResultsTable(email, leads) {
  statusLeadsAll = leads;
  statusLeadsEmail = email;
  const container = document.getElementById("status-leads-container");
  const paginationEl = document.getElementById("status-pagination");
  const searchInput = document.getElementById("status-search-input");
  const sortSelect = document.getElementById("status-sort-select");
  searchInput.hidden = leads.length <= 1;
  sortSelect.hidden = leads.length <= 1;

  const filteredLeads = leads
    .filter(lead => leadMatchesAddressSearch(lead, statusSearchQuery))
    .sort(leadSortComparator(statusSortMode, statusSortIndex));

  if (filteredLeads.length === 0) {
    container.innerHTML = `<p class="small-muted" style="padding:12px;">${leads.length === 0 ? "No leads found for that email address." : "No leads match your search."}</p>`;
    paginationEl.innerHTML = "";
    return;
  }

  const totalPages = Math.max(1, Math.ceil(filteredLeads.length / LEADS_PAGE_SIZE));
  if (statusPage > totalPages) statusPage = totalPages;
  const pageStart = (statusPage - 1) * LEADS_PAGE_SIZE;
  const visibleLeads = filteredLeads.slice(pageStart, pageStart + LEADS_PAGE_SIZE);

  container.innerHTML = `
    <table class="crm-table">
      <thead>
        <tr>
          <th>Submitted</th><th>Role</th><th>Contact</th><th>Address</th><th>Asset Type</th><th>Senior Loan</th><th>Payment Structure</th><th>Price Sought</th><th>Status</th>
        </tr>
      </thead>
      <tbody id="status-results-tbody"></tbody>
    </table>
  `;
  const tbody = document.getElementById("status-results-tbody");
  tbody.innerHTML = visibleLeads.map((l, i) => `
    <tr data-idx="${i}">
      <td>${formatDate(l["Submitted At"])}</td>
      <td>${escapeHtml(l["Role"] || "")}</td>
      <td>${escapeHtml(l["Contact Name"] || "")}<br><span class="small-muted">${escapeHtml(l["Contact Email"] || "")} · ${escapeHtml(l["Contact Phone"] || "")}</span></td>
      <td>${escapeHtml(l["Street Address"] || "")}<br><span class="small-muted">${escapeHtml(l["City"] || "")}, ${escapeHtml(l["State"] || "")}</span></td>
      <td>${escapeHtml(l["Asset Type"] || "")}</td>
      <td>${escapeHtml(l["Senior Loan Willing"] || "")}</td>
      <td>${escapeHtml(l["Payment Structure Willing"] || "")}</td>
      <td>${escapeHtml(String(l["Price Sought"] ?? ""))}</td>
      <td>${statusPillHtml(l["Status"])}</td>
    </tr>
  `).join("");
  tbody.querySelectorAll("tr").forEach(tr => {
    tr.onclick = () => openStatusDetail(visibleLeads[Number(tr.dataset.idx)], email, leads);
  });

  renderPaginationControls("status-pagination", statusPage, filteredLeads.length, LEADS_PAGE_SIZE, (newPage) => {
    statusPage = newPage;
    renderStatusResultsTable(email, leads);
  });
}

function openStatusDetail(lead, email, leads) {
  const overlay = document.getElementById("detail-overlay");
  const panel = document.getElementById("detail-panel");
  overlay.hidden = false;

  const fields = buildLeadFields(lead).filter(([k]) => k !== "Status");

  panel.innerHTML = `
    <button class="link-btn" id="close-detail-btn" style="float:right;">Close ✕</button>
    <h2>Lead Detail</h2>
    <div style="margin:8px 0 16px;">${statusPillHtml(lead["Status"])}</div>
    <dl class="review-grid">
      ${fields.map(([k,v]) => `<div><dt>${k}</dt><dd>${escapeHtml(String(v ?? "—"))}</dd></div>`).join("")}
    </dl>
    <div class="notes-list">
      <strong>Notes</strong>
      <p class="small-muted" style="margin:2px 0 8px;">Notes from admin appear here too. You can only edit or delete notes you added yourself.</p>
      <div class="status-notes-container" data-lead-id="${lead["Lead ID"]}">
        ${(lead.notes || []).map(n => renderStatusNoteItem(n, email)).join("") || `<p class="small-muted">No notes yet.</p>`}
      </div>
      <textarea class="status-note-input" placeholder="Add a note (this can't edit or delete the property/business info above — only admin can do that)"></textarea>
      <button class="btn primary status-add-note-btn" style="margin-top:8px;">Add Note</button>
    </div>
  `;

  panel.querySelector("#close-detail-btn").onclick = () => overlay.hidden = true;
  panel.querySelector(".status-add-note-btn").onclick = async () => {
    const textarea = panel.querySelector(".status-note-input");
    const note = textarea.value.trim();
    if (!note) return;
    const res = await api("addPublicNote", { email, leadId: lead["Lead ID"], note });
    if (res.ok) {
      lead.notes = lead.notes || [];
      lead.notes.push({ noteId: res.noteId, timestamp: new Date().toISOString(), note, author: email });
      openStatusDetail(lead, email, leads);
    }
  };

  bindStatusNoteEdits(panel, email, leads, () => openStatusDetail(lead, email, leads));
}

function renderStatusNoteItem(n, email) {
  const isMine = !!(n.author && email && n.author.toLowerCase() === email.toLowerCase());
  const authorLabel = isMine ? "You" : (n.author || "Admin");
  const badgeStyle = isMine
    ? "background:var(--accent-light); color:var(--accent);"
    : "background:var(--navy); color:#fff;";
  return `
    <div class="note-item" data-note-id="${n.noteId || ""}">
      <span class="ts">
        ${formatDate(n.timestamp)}
        <span style="${badgeStyle} padding:2px 8px; border-radius:10px; font-size:11px; font-weight:600; margin-left:4px;">${escapeHtml(authorLabel)}</span>
      </span>
      <span class="note-text">${escapeHtml(n.note)}</span>
      ${isMine && n.noteId ? `
        <button type="button" class="link-btn status-edit-note-btn" style="margin-left:8px;">Edit</button>
        <button type="button" class="link-btn status-delete-note-btn" style="margin-left:8px; color:var(--danger);">Delete</button>
      ` : ""}
    </div>
  `;
}

function bindStatusNoteEdits(container, email, leads, rerender) {
  container.querySelectorAll(".status-edit-note-btn").forEach(btn => {
    btn.onclick = () => {
      const item = btn.closest(".note-item");
      const noteId = item.dataset.noteId;
      const noteTextEl = item.querySelector(".note-text");
      const currentText = noteTextEl.textContent;
      item.innerHTML = `
        <textarea class="status-edit-note-input">${escapeHtml(currentText)}</textarea>
        <div class="nav-row" style="margin-top:6px;">
          <button type="button" class="btn secondary status-cancel-edit-btn">Cancel</button>
          <button type="button" class="btn primary status-save-edit-btn">Save</button>
        </div>
      `;
      item.querySelector(".status-cancel-edit-btn").onclick = () => rerender();
      item.querySelector(".status-save-edit-btn").onclick = async () => {
        const newText = item.querySelector(".status-edit-note-input").value.trim();
        if (!newText) return;
        const saveBtn = item.querySelector(".status-save-edit-btn");
        saveBtn.disabled = true;
        const res = await api("editPublicNote", { email, noteId, newText });
        if (res.ok) {
          leads.forEach(l => {
            (l.notes || []).forEach(n => {
              if (n.noteId === noteId) n.note = newText;
            });
          });
          rerender();
        } else {
          saveBtn.disabled = false;
        }
      };
    };
  });

  container.querySelectorAll(".status-delete-note-btn").forEach(btn => {
    btn.onclick = async () => {
      const item = btn.closest(".note-item");
      const noteId = item.dataset.noteId;
      if (!confirm("Delete this note? This cannot be undone.")) return;
      const res = await api("deletePublicNote", { email, noteId });
      if (res.ok) {
        leads.forEach(l => {
          l.notes = (l.notes || []).filter(n => n.noteId !== noteId);
        });
        rerender();
      }
    };
  });
}

/* ============================================================
   ADMIN
   ============================================================ */

let sessionToken = sessionStorage.getItem("adminToken") || null;
let currentLeads = [];
let lastExportToken = null;
let deleteConfirmStep = 0;
let lastMaoCalcSuite = null;

const adminModal = document.getElementById("admin-modal");
const loginForm = document.getElementById("login-form");
const forgotForm = document.getElementById("forgot-form");

document.getElementById("admin-access-btn").onclick = () => {
  if (sessionToken) { showAdminView(); return; }
  adminModal.hidden = false;
  loginForm.hidden = false;
  forgotForm.hidden = true;
};
document.getElementById("admin-cancel-btn").onclick = () => adminModal.hidden = true;

document.getElementById("admin-login-btn").onclick = async () => {
  const pw = document.getElementById("admin-password-input").value;
  const errEl = document.getElementById("login-error");
  errEl.classList.remove("show");
  try {
    const res = await api("adminLogin", { password: pw });
    if (!res.ok) { errEl.textContent = res.error || "Login failed."; errEl.classList.add("show"); return; }
    sessionToken = res.token;
    sessionStorage.setItem("adminToken", sessionToken);
    adminModal.hidden = true;
    showAdminView();
  } catch (e) {
    errEl.textContent = "Could not reach the server. Check config.js.";
    errEl.classList.add("show");
  }
};

document.getElementById("forgot-password-link").onclick = () => {
  loginForm.hidden = true;
  forgotForm.hidden = false;
};
document.getElementById("forgot-cancel-btn").onclick = () => {
  forgotForm.hidden = true;
  loginForm.hidden = false;
};
document.getElementById("forgot-submit-btn").onclick = async () => {
  const codeWord = document.getElementById("code-word-input").value;
  const resultEl = document.getElementById("forgot-result");
  resultEl.textContent = "Checking...";
  const res = await api("forgotPassword", { codeWord });
  resultEl.textContent = res.message || "If the code word was correct, a recovery email was just sent.";
};

document.getElementById("admin-logout-btn").onclick = () => {
  sessionToken = null;
  sessionStorage.removeItem("adminToken");
  document.getElementById("admin-view").hidden = true;
  document.getElementById("public-view").hidden = false;
};

document.getElementById("mao-calc-public-btn").onclick = openMaoCalculator;
document.getElementById("outreach-sop-btn").onclick = openOutreachSop;

document.getElementById("crm-search-input").oninput = (e) => {
  crmSearchQuery = e.target.value.trim();
  crmPage = 1;
  renderCrmTable();
};

document.getElementById("crm-sort-select").onchange = (e) => {
  crmSortMode = e.target.value;
  crmPage = 1;
  renderCrmTable();
};

async function showAdminView() {
  document.getElementById("public-view").hidden = true;
  document.getElementById("admin-view").hidden = false;
  await loadLeads();
}

function adminMessage(text, type) {
  const el = document.getElementById("admin-message");
  el.hidden = !text;
  el.textContent = text;
  el.className = "banner " + (type || "info");
}

let crmSearchQuery = "";
let crmSortMode = "default";
let crmPage = 1;

async function loadLeads() {
  adminMessage("Loading leads...", "info");
  const res = await api("getLeads", { token: sessionToken });
  if (!res.ok) { adminMessage(res.error, "danger"); return; }
  currentLeads = res.leads;
  crmPage = 1;
  adminMessage("", "info");
  renderCrmTable();
}

function leadMatchesSearch(l, query) {
  if (!query) return true;
  const haystack = [
    l["Street Address"], l["City"], l["State"], l["Zip"],
    l["Contact Name"], l["Contact Email"]
  ].map(v => String(v || "").toLowerCase()).join(" ");
  return haystack.indexOf(query.toLowerCase()) !== -1;
}

function renderCrmTable() {
  const tbody = document.getElementById("crm-tbody");
  const emptyEl = document.getElementById("crm-empty");
  const paginationEl = document.getElementById("crm-pagination");

  const filteredLeads = currentLeads
    .filter(l => leadMatchesSearch(l, crmSearchQuery))
    .sort(leadSortComparator(crmSortMode, adminStatusSortIndex));

  if (filteredLeads.length === 0) {
    tbody.innerHTML = "";
    emptyEl.hidden = false;
    emptyEl.textContent = currentLeads.length === 0
      ? "No leads yet."
      : "No leads match your search.";
    paginationEl.innerHTML = "";
    return;
  }
  emptyEl.hidden = true;

  const totalPages = Math.max(1, Math.ceil(filteredLeads.length / LEADS_PAGE_SIZE));
  if (crmPage > totalPages) crmPage = totalPages;
  const pageStart = (crmPage - 1) * LEADS_PAGE_SIZE;
  const visibleLeads = filteredLeads.slice(pageStart, pageStart + LEADS_PAGE_SIZE);

  tbody.innerHTML = visibleLeads.map((l, i) => `
    <tr data-idx="${i}">
      <td>${formatDate(l["Submitted At"])}</td>
      <td>${escapeHtml(l["Role"] || "")}</td>
      <td>${escapeHtml(l["Contact Name"] || "")}<br><span class="small-muted">${escapeHtml(l["Contact Email"] || "")} · ${escapeHtml(l["Contact Phone"] || "")}</span></td>
      <td>${l["Role"] === "Seller" ? "—" : escapeHtml(l["Team"] || "—")}</td>
      <td>${escapeHtml(l["Street Address"] || "")}<br><span class="small-muted">${escapeHtml(l["City"] || "")}, ${escapeHtml(l["State"] || "")}</span></td>
      <td>${escapeHtml(l["Asset Type"] || "")}</td>
      <td>${escapeHtml(l["Senior Loan Willing"] || "")}</td>
      <td>${escapeHtml(l["Payment Structure Willing"] || "")}</td>
      <td>${escapeHtml(String(l["Price Sought"] ?? ""))}</td>
      <td>${escapeHtml(l["Closing Likelihood"] ? String(l["Closing Likelihood"]) + "/5" : "—")}</td>
      <td>${statusPillHtml(l["Status"])}</td>
    </tr>
  `).join("");
  tbody.querySelectorAll("tr").forEach(tr => {
    tr.onclick = () => openDetail(visibleLeads[Number(tr.dataset.idx)]);
  });

  renderPaginationControls("crm-pagination", crmPage, filteredLeads.length, LEADS_PAGE_SIZE, (newPage) => {
    crmPage = newPage;
    renderCrmTable();
  });
}

// Standalone MAO calculator, separate from the Cash Deal wizard step -- lets admin plug in
// numbers directly (e.g. a seller countered with a different rehab estimate) and, optionally, save
// the recalculated MAO suite onto an existing lead without having the associate re-run the wizard.
// Built on the same computeMaoSuite() the wizard step uses, so the math never drifts between the two.
// Available everywhere -- a header button open to anyone (bird dogs/connectors, wholesalers,
// admin, even a seller poking around) -- not just admin. It's independent of the lead wizard: no
// login or in-progress submission required, just plug in numbers and see the math. The "save
// straight onto an existing lead" section only appears when an admin session is active, since that
// needs full CRM access to pick from every lead on file; non-admins can still always use the
// calculator itself, they just email/text the numbers over instead of writing them to the sheet
// directly. Whenever someone actually submits a Cash Deal lead through the wizard (not this
// calculator), the same computeMaoSuite() math is already captured on that submission automatically
// (see cashDealDetails' validate()) -- this panel doesn't change that.
function openMaoCalculator() {
  const overlay = document.getElementById("mao-calc-overlay");
  const panel = document.getElementById("mao-calc-panel");
  const isAdmin = !!sessionToken;
  overlay.hidden = false;

  panel.innerHTML = `
    <button class="link-btn" id="close-mao-calc-btn" style="float:right;">Close ✕</button>
    <h2>MAO Calculator</h2>
    <p class="small-muted">Uses the same Maximum Allowable Offer math as the Cash Deal Details wizard step --
    open to bird dogs/connectors, wholesalers, and admin alike. Plug in numbers any time, independent of
    submitting a lead.</p>

    ${isAdmin ? `
      <label class="field-label">Save to an existing lead <span class="small-muted">(optional -- pre-fills ARV/Rehab/Asset Type below)</span></label>
      <select id="mao-calc-lead-select">
        <option value="">-- Select a lead --</option>
        ${currentLeads.map(l => `<option value="${escapeHtml(l["Lead ID"])}">${escapeHtml(l["Street Address"] || "(no address)")}, ${escapeHtml(l["City"] || "")} — ${escapeHtml(l["Contact Name"] || "")}</option>`).join("")}
      </select>
    ` : ""}

    <label class="field-label">ARV <span class="small-muted">(After Repair Value)</span></label>
    <input type="number" id="mao-calc-arv" placeholder="$">

    <label class="field-label">Rehab Estimate</label>
    <input type="number" id="mao-calc-rehab" placeholder="$">

    <label class="field-label">Asset Type</label>
    <select id="mao-calc-asset-type">
      <option value="Residential Property (1-4 units)">Residential Property (1-4 units)</option>
      <option value="Commercial Property">Commercial Property</option>
      <option value="Business">Business</option>
      <option value="Land">Land</option>
    </select>

    <div class="banner warn" id="mao-calc-output" hidden style="margin-top:16px;"></div>

    ${isAdmin ? `
      <div style="margin-top:20px; padding-top:16px; border-top:1px solid var(--border);">
        <button class="btn primary" id="mao-calc-save-btn" disabled>Save MAO to Selected Lead</button>
        <div id="mao-calc-save-message" class="small-muted" style="margin-top:8px;"></div>
      </div>
    ` : ""}
  `;

  panel.querySelector("#close-mao-calc-btn").onclick = () => overlay.hidden = true;

  const recompute = () => {
    const arv = Number(panel.querySelector("#mao-calc-arv").value) || 0;
    const rehab = Number(panel.querySelector("#mao-calc-rehab").value) || 0;
    const assetType = panel.querySelector("#mao-calc-asset-type").value;
    const output = panel.querySelector("#mao-calc-output");
    const saveBtn = panel.querySelector("#mao-calc-save-btn");
    const leadSelected = isAdmin && !!panel.querySelector("#mao-calc-lead-select").value;

    lastMaoCalcSuite = computeMaoSuite(arv, rehab, assetType);
    if (!lastMaoCalcSuite) {
      output.hidden = true;
      if (saveBtn) saveBtn.disabled = true;
      return;
    }
    const fmt = n => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
    output.hidden = false;
    output.innerHTML = `
      <strong>Cash Buyer MAO:</strong> ${fmt(lastMaoCalcSuite.maoCash)}
      <br><span class="small-muted">(${lastMaoCalcSuite.cashExplanation})</span>
      <hr style="border: none; border-top: 1px solid currentColor; opacity: 0.2; margin: 10px 0;">
      <strong>Hard Money Buyer MAO (${lastMaoCalcSuite.hm10Label} Down):</strong> ${fmt(lastMaoCalcSuite.maoHardMoney10)}
      <br><span class="small-muted">(${lastMaoCalcSuite.hm10Explanation})</span>
      <hr style="border: none; border-top: 1px solid currentColor; opacity: 0.2; margin: 10px 0;">
      <strong>Hard Money Buyer MAO (${lastMaoCalcSuite.hm20Label} Down):</strong> ${fmt(lastMaoCalcSuite.maoHardMoney20)}
      <br><span class="small-muted">(${lastMaoCalcSuite.hm20Explanation})</span>
    `;
    if (saveBtn) saveBtn.disabled = !leadSelected;
  };

  if (isAdmin) {
    panel.querySelector("#mao-calc-lead-select").onchange = (e) => {
      const lead = currentLeads.find(l => l["Lead ID"] === e.target.value);
      if (lead) {
        if (lead["ARV"]) panel.querySelector("#mao-calc-arv").value = lead["ARV"];
        if (lead["Rehab Estimate"]) panel.querySelector("#mao-calc-rehab").value = lead["Rehab Estimate"];
        if (lead["Asset Type"]) panel.querySelector("#mao-calc-asset-type").value = lead["Asset Type"];
      }
      panel.querySelector("#mao-calc-save-message").textContent = "";
      recompute();
    };
  }
  ["#mao-calc-arv", "#mao-calc-rehab"].forEach(sel => { panel.querySelector(sel).oninput = recompute; });
  panel.querySelector("#mao-calc-asset-type").onchange = recompute;

  if (isAdmin) {
    panel.querySelector("#mao-calc-save-btn").onclick = async () => {
      const leadId = panel.querySelector("#mao-calc-lead-select").value;
      const msgEl = panel.querySelector("#mao-calc-save-message");
      if (!leadId || !lastMaoCalcSuite) return;
      msgEl.textContent = "Saving...";
      const res = await api("updateMaoForLead", {
        token: sessionToken, leadId,
        maoCash: Math.round(lastMaoCalcSuite.maoCash),
        maoHardMoney10: Math.round(lastMaoCalcSuite.maoHardMoney10),
        maoHardMoney20: Math.round(lastMaoCalcSuite.maoHardMoney20),
        maoBreakdown: lastMaoCalcSuite.fullBreakdown
      });
      if (res.ok) {
        msgEl.textContent = "Saved to the lead sheet.";
        const lead = currentLeads.find(l => l["Lead ID"] === leadId);
        if (lead) {
          lead["MAO Cash"] = Math.round(lastMaoCalcSuite.maoCash);
          lead["MAO Hard Money (10% Down)"] = Math.round(lastMaoCalcSuite.maoHardMoney10);
          lead["MAO Hard Money (20% Down)"] = Math.round(lastMaoCalcSuite.maoHardMoney20);
          lead["MAO Breakdown"] = lastMaoCalcSuite.fullBreakdown;
        }
      } else {
        msgEl.textContent = "Failed to save: " + (res.error || "unknown error");
      }
    };
  }
}

// FSBO cold-text SOP, open to anyone (same access pattern as the MAO Calculator) -- a reference
// panel, not tied to the wizard's own state, so it's safe to open at any point in a submission.
function openOutreachSop() {
  const overlay = document.getElementById("outreach-sop-overlay");
  const panel = document.getElementById("outreach-sop-panel");
  overlay.hidden = false;
  panel.innerHTML = `
    <button class="link-btn" id="close-outreach-sop-btn" style="float:right;">Close ✕</button>
    <h2>FSBO + On Market Acquisition SOP</h2>
    <p class="small-muted">This SOP is for deals that need rehab/renovation (fix and flip). Cold-text every
    lead with two soft offers, cash and seller financing, unless the seller's already ruled one out.
    <strong>Daily target: 50 new properties texted per day.</strong></p>

    <h3 style="margin-top:22px;">1. Source the lead</h3>
    <p class="hint"><strong>1–4 units:</strong> Zillow and Redfin For-Sale-By-Owner listings around the
    US — <strong>single-family only, up to 4 units, no condos or apartments.</strong>
    <br><strong>5+ unit multifamily:</strong> Crexi or LoopNet instead — FSBO sites aren't where commercial
    listings live.</p>
    <p class="hint">City population <strong>50,000+</strong>. We can go up to <strong>$90M</strong> on
    commercial deals, but for simplicity, stick to deals <strong>under $20M</strong>.</p>

    <h3 style="margin-top:22px;">2. Screen before you text</h3>
    <p class="hint"><strong>1–4 units:</strong> run the address through PropWire and estimate the seller's
    loan balance against the property's value. PropWire's equity/debt data only shows reliably for 1–4
    unit properties.</p>
    <div class="banner warn">
      <strong>No data shows on a 1–4 unit property?</strong> Skip it and move to the next address — don't guess.
      <br><strong>Debt below ~50% of value?</strong> Proceed with both offers (Step 4).
      <br><strong>Debt at or above ~50%?</strong> Seller financing won't work here — go cash-only, offered
      above the existing debt so the payoff is covered, start low, and leave room to go up (Step 4, cash only).
    </div>
    <p class="hint"><strong>5+ unit multifamily:</strong> PropWire won't have data here — that's expected,
    not a reason to skip. Instead, ask the seller directly:
    <br><span class="small-muted">"Does the property have under 50% debt compared to its total value?"</span>
    <br>"Yes" &rarr; qualifies for seller financing, send both offers. "No" (or high debt) &rarr; cash offer
    only, above the existing debt, start low.
    <br><strong>Skip any 5+ unit listing that requires an NDA to see financials if no NOI is shown AND the
    property is generating income</strong> — too much friction for a cold-outreach volume play. A vacant
    property is fine to pursue either way, NDA or not.</p>

    <h3 style="margin-top:22px;">3. Price it on SendMySeller before you text</h3>
    <p class="hint">Run the address through the SendMySeller wizard for the low cash offer number (the
    lowest of the calculated Max Allowable Offer figures) and the as-is/ARV value (used to frame the
    seller-financing alternative). Always follow the site's guidance for the initial low cash offer —
    don't estimate it by hand.</p>

    <h3 style="margin-top:22px;">4. Text the offer(s)</h3>
    <p class="hint">Never mention who's buying or whether it's an investor — just ask. Default to offering
    both, unless Step 2 ruled seller financing out, or the seller has separately already said no to one.
    This SOP assumes the property needs rehab — a turnkey property with nothing to fix uses a different,
    longer-horizon seller-financing structure (the wizard's Make Your Offers step switches to it
    automatically once no rehab estimate is entered).</p>
    <p class="hint">Our written offer is a <strong>30-day close</strong> for single-family, full stop — don't
    offer to move faster for this seller. We have closed in under 2 weeks before, so that track record is
    fair to mention, but only as a past fact, never as a capability on offer for this particular deal. For
    5+ unit deals, quote a <strong>45–60 day close</strong> instead, regardless of whether that deal needs
    rehab (see Step 6).</p>
    <p class="hint">Seller financing is always framed as full asking price, contingent on the property
    appraising at or above that — that's the pitch for why they'd take financing over a discounted cash
    offer.</p>
    <div class="banner info">
      <strong>Both live:</strong> "Hi [Name] — saw [Address] is for sale. Would you be open to $[cash] cash
      to purchase outright, with a 30-day close (our requirement for deals like this, though we have closed
      in under 2 weeks before)? As another option, we could also do $[20% down] down now, with the
      remaining $[balance] paid within 1 year, at your full asking price as long as it appraises at or
      above that. Let me know which works better for you."
    </div>
    <div class="banner info" style="margin-top:10px;">
      <strong>Cash only</strong> (high debt, or seller financing already declined): "Hi [Name] — saw
      [Address] is for sale. Would you be open to $[cash] cash to purchase outright, with a 30-day close
      (our requirement for deals like this, though we have closed in under 2 weeks before)?"
    </div>
    <p class="hint" style="margin-top:14px;"><strong>5+ unit multifamily — if they ask how this actually
    gets sold:</strong></p>
    <div class="banner info">
      <strong>Cash:</strong> "We work with a partner who has a network of over 6 million buyers. That's
      how we'd get this property sold. It wouldn't be exclusive, so you're free to keep marketing
      and selling it yourself while we bring a buyer forward."
    </div>
    <div class="banner info" style="margin-top:10px;">
      <strong>Seller financing:</strong> "For seller financing, we already have a specific buyer ready to go."
    </div>

    <h3 style="margin-top:22px;">5. If they ask "how much down?"</h3>
    <p class="hint">Don't quote a number or imply there's room to negotiate up. Just say you'll review:</p>
    <div class="banner info">"Good question — I'll put a real offer together for you rather than guess
    over text. If 20% down isn't enough, let me know what you have in mind and we'll review it and get
    back to you."</div>
    <p class="hint" style="margin-top:10px;"><strong>Turnkey / no rehab needed instead:</strong> "Good
    question — it really depends on the terms we land on together, typically 20-50% down with a 5-15 year
    payoff. Let me know what you're looking for and we'll put a real offer together for you."</p>

    <h3 style="margin-top:22px;">6. Timelines</h3>
    <p class="hint">Single-family / 1–4 units needing rehab: <strong>30-day close</strong> (as fast as 2
    weeks or less if needed), seller-financing payoff within 1 year.
    <br>Commercial multifamily (5+ units) needing rehab: <strong>45–60 day close</strong>, seller-financing
    payoff within 2 years.
    <br>Turnkey / no rehab needed: same close timelines as above by size, seller-financing payoff over
    5–15 years instead.</p>

    <h3 style="margin-top:22px;">7. Follow up</h3>
    <p class="hint">Default to following up every <strong>3 days</strong> while an offer is out and unsigned
    — only stretch to day 7 if the conversation itself makes that the smarter call (e.g. the seller said
    they need more time, or you're waiting on something specific from them). Log every counter or objection
    in the lead's notes — admin uses it to decide how to adjust either offer.</p>
  `;
  panel.querySelector("#close-outreach-sop-btn").onclick = () => overlay.hidden = true;
}

function formatDate(iso) {
  try { return new Date(iso).toLocaleString(); } catch (e) { return iso; }
}

function openDetail(lead) {
  const overlay = document.getElementById("detail-overlay");
  const panel = document.getElementById("detail-panel");
  overlay.hidden = false;

  const fields = buildLeadFields(lead).filter(([k]) => k !== "Status");

  panel.innerHTML = `
    <button class="link-btn" id="close-detail-btn" style="float:right;">Close ✕</button>
    <h2>Lead Detail</h2>
    <label class="field-label">Status</label>
    <select id="status-select">
      ${LEAD_STATUSES.map(s =>
        `<option value="${s}" ${lead["Status"] === s ? "selected" : ""}>${s}</option>`).join("")}
    </select>
    <label class="field-label">Closing Likelihood <span class="small-muted">(1 = lowest, 5 = highest opportunity to close)</span></label>
    <select id="likelihood-select">
      <option value="" ${!lead["Closing Likelihood"] ? "selected" : ""}>Not scored</option>
      ${[1,2,3,4,5].map(n =>
        `<option value="${n}" ${String(lead["Closing Likelihood"]) === String(n) ? "selected" : ""}>${n}</option>`).join("")}
    </select>
    ${lead["Role"] !== "Seller" ? `
      <label class="field-label">Team <span class="small-muted">(admin-only, since this submitter isn't the seller)</span></label>
      <input type="text" id="team-input" placeholder="e.g. Team Alpha" value="${escapeHtml(lead["Team"] || "")}">
    ` : ""}
    <dl class="review-grid" style="margin-top:16px;">
      ${fields.map(([k,v]) => `<div><dt>${k}</dt><dd>${escapeHtml(String(v ?? "—"))}</dd></div>`).join("")}
    </dl>
    ${lead["MAO Cash"] ? `
      <div class="banner info" style="margin-top:16px; text-align:left; white-space:pre-wrap;">
        <strong>Wholesale Offer Math (admin-only)</strong>
        <br>Cash Buyer MAO: $${Number(lead["MAO Cash"]).toLocaleString()}
        <br>Hard Money Buyer MAO (${lead["Asset Type"] === "Land" ? "30%" : "10%"} Down): $${Number(lead["MAO Hard Money (10% Down)"]).toLocaleString()}
        <br>Hard Money Buyer MAO (${lead["Asset Type"] === "Land" ? "50%" : "20%"} Down): $${Number(lead["MAO Hard Money (20% Down)"]).toLocaleString()}
        <hr style="border: none; border-top: 1px solid currentColor; opacity: 0.2; margin: 10px 0;">
        ${escapeHtml(lead["MAO Breakdown"] || "")}
      </div>
    ` : ""}
    ${lead["CMA Screenshot URLs"] ? `
      <div class="banner info" style="margin-top:16px; text-align:left;">
        <strong>CMA Screenshots</strong>
        <br>${lead["CMA Screenshot URLs"].split("\n").filter(Boolean).map((url, i) =>
          `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">Screenshot ${i + 1}</a>`).join(" &middot; ")}
      </div>
    ` : ""}
    <div class="notes-list">
      <strong>Notes</strong>
      <div id="notes-container">
        ${(lead.notes || []).map(n => renderAdminNoteItem(n)).join("") || `<p class="small-muted">No notes yet.</p>`}
      </div>
      <textarea id="new-note-input" placeholder="Add a note (raw lead data above can't be edited or deleted)"></textarea>
      <label class="small-muted" style="display:block; margin-top:6px;">
        <input type="checkbox" id="private-note-checkbox"> Private (invisible to non-admins)
      </label>
      <button class="btn primary" id="add-note-btn" style="margin-top:8px;">Add Note</button>
    </div>
  `;

  panel.querySelector("#close-detail-btn").onclick = () => overlay.hidden = true;
  panel.querySelector("#status-select").onchange = async (e) => {
    const res = await api("updateStatus", { token: sessionToken, leadId: lead["Lead ID"], status: e.target.value });
    if (res.ok) { lead["Status"] = e.target.value; renderCrmTable(); }
    else alert("Failed to save status: " + (res.error || "unknown error"));
  };
  panel.querySelector("#likelihood-select").onchange = async (e) => {
    const res = await api("updateClosingLikelihood", { token: sessionToken, leadId: lead["Lead ID"], score: e.target.value });
    if (res.ok) { lead["Closing Likelihood"] = e.target.value; renderCrmTable(); }
    else alert("Failed to save closing likelihood: " + (res.error || "unknown error"));
  };
  const teamInput = panel.querySelector("#team-input");
  if (teamInput) {
    teamInput.onblur = async (e) => {
      const team = e.target.value.trim();
      const res = await api("updateTeam", { token: sessionToken, leadId: lead["Lead ID"], team });
      if (res.ok) {
        // Team is keyed by submitter email, not per-lead -- the backend just
        // applied it to every lead on file from this same email, so mirror
        // that here instead of only updating the one lead we opened.
        const targetEmail = String(lead["Contact Email"] || "").trim().toLowerCase();
        currentLeads.forEach(l => {
          if (String(l["Contact Email"] || "").trim().toLowerCase() === targetEmail) l["Team"] = team;
        });
        renderCrmTable();
      } else {
        alert("Failed to save team: " + (res.error || "unknown error"));
      }
    };
  }
  bindAdminNoteControls(panel, lead);
}

// Wires up the "add note" and "delete note" controls inside an already-open
// detail panel. Split out from openDetail() so adding/deleting a note only
// touches #notes-container -- re-running openDetail() here would rebuild
// the whole panel from `lead`, wiping out any in-progress edit (e.g. a
// Team value the admin just typed but hasn't blurred out of yet) that
// hasn't been written back to `lead` by its own async save yet.
function bindAdminNoteControls(panel, lead) {
  const notesContainer = panel.querySelector("#notes-container");

  function renderNotes() {
    notesContainer.innerHTML = (lead.notes || []).map(n => renderAdminNoteItem(n)).join("") || `<p class="small-muted">No notes yet.</p>`;
    notesContainer.querySelectorAll(".admin-delete-note-btn").forEach(btn => {
      btn.onclick = async () => {
        const item = btn.closest(".note-item");
        const noteId = item.dataset.noteId;
        if (!confirm("Delete this note? This cannot be undone.")) return;
        const res = await api("deleteNote", { token: sessionToken, noteId });
        if (res.ok) {
          lead.notes = (lead.notes || []).filter(n => n.noteId !== noteId);
          renderNotes();
        } else {
          alert("Failed to delete note: " + (res.error || "unknown error"));
        }
      };
    });
  }

  panel.querySelector("#add-note-btn").onclick = async () => {
    const noteInput = panel.querySelector("#new-note-input");
    const note = noteInput.value.trim();
    if (!note) return;
    const isPrivate = panel.querySelector("#private-note-checkbox").checked;
    const res = await api("addNote", { token: sessionToken, leadId: lead["Lead ID"], note, isPrivate });
    if (res.ok) {
      lead.notes = lead.notes || [];
      lead.notes.push({ noteId: res.noteId, timestamp: new Date().toISOString(), note, author: "Admin", visibility: isPrivate ? "Private" : "Shared" });
      noteInput.value = "";
      panel.querySelector("#private-note-checkbox").checked = false;
      renderNotes();
    } else {
      alert("Failed to add note: " + (res.error || "unknown error"));
    }
  };

  renderNotes();
}

function renderAdminNoteItem(n) {
  const author = n.author || "Admin";
  const isAdminAuthor = author === "Admin";
  const badgeStyle = isAdminAuthor
    ? "background:var(--navy); color:#fff;"
    : "background:var(--accent-light); color:var(--accent);";
  return `
    <div class="note-item" data-note-id="${n.noteId || ""}">
      <span class="ts">
        ${formatDate(n.timestamp)}
        <span style="${badgeStyle} padding:2px 8px; border-radius:10px; font-size:11px; font-weight:600; margin-left:4px;">${escapeHtml(author)}</span>
        ${n.visibility === "Private" ? `<strong style="color:var(--warn);"> (Private — invisible to non-admins)</strong>` : ""}
      </span>
      <div>${escapeHtml(n.note)}</div>
      ${n.noteId ? `<button type="button" class="link-btn admin-delete-note-btn" style="color:var(--danger); margin-top:4px;">Delete</button>` : ""}
    </div>
  `;
}

/* ---------- Export + gated delete ---------- */

document.getElementById("export-btn").onclick = async () => {
  if (!confirm(`Export ${currentLeads.length} lead(s) to a timestamped Google Sheets tab?`)) return;
  adminMessage("Exporting...", "info");
  const res = await api("exportToSheet", { token: sessionToken });
  if (!res.ok) { adminMessage(res.error, "danger"); return; }
  lastExportToken = res.exportToken;
  deleteConfirmStep = 0;
  adminMessage(`Exported ${res.exportedCount} lead(s) to sheet tab "${res.tabName}".`, "info");
  document.getElementById("delete-zone").hidden = false;
};

document.getElementById("delete-step-btn").onclick = async () => {
  deleteConfirmStep++;
  if (deleteConfirmStep === 1) {
    if (!confirm("Your export is complete. Are you sure you want to delete all CRM data now?")) { deleteConfirmStep = 0; return; }
  } else if (deleteConfirmStep === 2) {
    if (!confirm("This cannot be undone — the only remaining copy will be the exported sheet tab. Really delete?")) { deleteConfirmStep = 0; return; }
  } else if (deleteConfirmStep >= 3) {
    const typed = prompt('Final confirmation: type DELETE (all caps) to permanently clear the CRM.');
    if (typed !== "DELETE") { deleteConfirmStep = 0; return; }
    const res = await api("deleteAllLeads", { token: sessionToken, exportToken: lastExportToken });
    if (!res.ok) { adminMessage(res.error, "danger"); deleteConfirmStep = 0; return; }
    adminMessage("CRM data cleared. Starting fresh.", "info");
    document.getElementById("delete-zone").hidden = true;
    deleteConfirmStep = 0;
    lastExportToken = null;
    await loadLeads();
  }
};
