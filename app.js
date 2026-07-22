/* Seller Lead Intake — front end. Talks only to the Apps Script backend
   configured in config.js. No other server exists. */

const US_STATES = ["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC"];

const COMMERCIAL_SUBTYPES = ["Multifamily","Office","Hotel/Motel","Mixed Use","Industrial","Retail","Hospitality","Agriculture","Mobile Home or RV Park","Self Storage","Single Family Portfolio","Other Commercial Portfolio"];

const ADMIN_CONTACT_PHONE = "+1 520 633 6437";

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
        <div class="nav-row">
          <button class="btn secondary" id="check-status-btn">Check Status On My Existing Leads (Non-Admin)</button>
          <button class="btn primary" id="start-btn">Start</button>
        </div>
      `;
      root.querySelector("#start-btn").onclick = () => goTo(1);
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
      `;
      root.querySelectorAll("#role-group .choice-btn").forEach(btn => {
        if (btn.dataset.value === answers.role) btn.classList.add("selected");
        btn.onclick = () => {
          root.querySelectorAll("#role-group .choice-btn").forEach(b => b.classList.remove("selected"));
          btn.classList.add("selected");
          answers.role = btn.dataset.value;
        };
      });
      root.querySelector("#name-input").value = answers.name || "";
      root.querySelector("#email-input").value = answers.email || "";
      root.querySelector("#phone-input").value = answers.phone || "";
      root.querySelector("#social-input").value = answers.socialLink || "";
    },
    validate(root) {
      answers.name = root.querySelector("#name-input").value.trim();
      answers.email = root.querySelector("#email-input").value.trim();
      answers.phone = root.querySelector("#phone-input").value.trim();
      answers.socialLink = root.querySelector("#social-input").value.trim();
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

        <label class="field-label">Number of units <span class="req">*</span></label>
        <input type="number" id="units-input" min="1" step="1" placeholder="e.g. 1 for a single-family home">
        <div class="error-text" id="units-error">Enter the number of units (1 or more).</div>
      `;
      root.querySelector("#street-input").value = answers.street || "";
      root.querySelector("#city-input").value = answers.city || "";
      root.querySelector("#state-input").value = answers.state || "";
      root.querySelector("#zip-input").value = answers.zip || "";
      root.querySelector("#units-input").value = answers.units || "";
    },
    validate(root) {
      answers.street = root.querySelector("#street-input").value.trim();
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
        <div class="banner warn">
          The property or business must currently be generating monthly income — we're not able to help
          with non-income-producing assets.
        </div>
        <label class="field-label">Type <span class="req">*</span></label>
        <div class="choice-group" id="top-type-group">
          ${["Commercial Property","Business","Residential Property (1 unit)"]
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
        } else if (answers.assetType === "Residential Property (1 unit)") {
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
          answers.assetSubtype = ""; answers.beds = ""; answers.baths = ""; answers.sqft = "";
          renderSub();
        };
      });
    },
    validate(root) {
      let ok = true;
      toggleError(root, "#top-type-error", !answers.assetType); if (!answers.assetType) ok = false;
      if (answers.assetType === "Commercial Property") {
        answers.assetSubtype = root.querySelector("#subtype-input").value;
        toggleError(root, "#subtype-error", !answers.assetSubtype); if (!answers.assetSubtype) ok = false;
      } else if (answers.assetType === "Business") {
        answers.assetSubtype = root.querySelector("#subtype-input").value.trim();
        toggleError(root, "#subtype-error", !answers.assetSubtype); if (!answers.assetSubtype) ok = false;
      } else if (answers.assetType === "Residential Property (1 unit)") {
        answers.beds = root.querySelector("#beds-input").value;
        answers.baths = root.querySelector("#baths-input").value;
        answers.sqft = root.querySelector("#sqft-input").value;
        toggleError(root, "#beds-error", answers.beds === ""); if (answers.beds === "") ok = false;
        toggleError(root, "#baths-error", answers.baths === ""); if (answers.baths === "") ok = false;
      }
      return ok;
    }
  },
  {
    key: "income",
    progress: true,
    render(root) {
      const disclaimer = `
        <div class="banner warn">
          This information is required to move forward. If you're unable to find or confirm it for a given
          property or business, please continue searching for other opportunities that do have this
          information readily accessible — we're not able to evaluate deals without it.
        </div>
      `;
      if (answers.assetType === "Residential Property (1 unit)") {
        root.innerHTML = `
          <h2 class="step-title">Property Income (NOI)</h2>
          ${disclaimer}
          <label class="field-label">Is the property currently occupied by a paying tenant? <span class="req">*</span></label>
          <div class="choice-group" id="occupied-group">
            ${["Occupied (has a landlord/tenant)", "Vacant (no tenant)"].map(v => `<button type="button" class="choice-btn" data-value="${v}">${v}</button>`).join("")}
          </div>
          <div class="error-text" id="occupied-error">Please choose one.</div>
          <div id="income-sub"></div>
        `;
        const sub = root.querySelector("#income-sub");
        const renderIncomeSub = () => {
          if (answers.residentialOccupied === "Occupied (has a landlord/tenant)") {
            sub.innerHTML = `
              <label class="field-label">Annual NOI <span class="req">*</span></label>
              <input type="number" id="noi-input" placeholder="$">
              <div class="error-text" id="noi-error">Required.</div>
            `;
            sub.querySelector("#noi-input").value = answers.residentialNOI || "";
          } else if (answers.residentialOccupied === "Vacant (no tenant)") {
            sub.innerHTML = `
              <p class="hint">Look up the estimated monthly rental value on <strong>rentcast.io</strong> for
              this property, then look up annual property taxes and insurance for a
              ${answers.beds || "?"} bed / ${answers.baths || "?"} bath home in
              ${answers.city || "this city"}${answers.state ? ", " + answers.state : ""}, and enter them below.</p>
              <a href="https://www.rentcast.io/" target="_blank" rel="noopener" class="link-btn">Open rentcast.io &rarr;</a>
              <label class="field-label">Estimated Monthly Rent (rentcast.io) <span class="req">*</span></label>
              <input type="number" id="rent-input" placeholder="$">
              <div class="error-text" id="rent-error">Required.</div>
              <label class="field-label">Annual Property Taxes <span class="req">*</span></label>
              <input type="number" id="taxes-input" placeholder="$">
              <div class="error-text" id="taxes-error">Required.</div>
              <label class="field-label">Annual Insurance <span class="req">*</span></label>
              <input type="number" id="insurance-input" placeholder="$">
              <div class="error-text" id="insurance-error">Required.</div>
              <div class="banner info" id="computed-noi-banner"></div>
            `;
            sub.querySelector("#rent-input").value = answers.rentcastMonthlyRent || "";
            sub.querySelector("#taxes-input").value = answers.annualPropertyTaxes || "";
            sub.querySelector("#insurance-input").value = answers.annualInsurance || "";
            const recompute = () => {
              const rent = Number(sub.querySelector("#rent-input").value) || 0;
              const taxes = Number(sub.querySelector("#taxes-input").value) || 0;
              const insurance = Number(sub.querySelector("#insurance-input").value) || 0;
              const noi = (rent * 12) - taxes - insurance;
              sub.querySelector("#computed-noi-banner").textContent = `Computed Annual NOI: $${noi.toLocaleString()} (monthly rent × 12, minus taxes and insurance)`;
              answers.residentialNOI = noi;
            };
            ["#rent-input", "#taxes-input", "#insurance-input"].forEach(sel => {
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
      if (answers.assetType === "Residential Property (1 unit)") {
        const ok1 = !!answers.residentialOccupied;
        toggleError(root, "#occupied-error", !ok1);
        if (!ok1) return false;
        if (answers.residentialOccupied === "Occupied (has a landlord/tenant)") {
          answers.residentialNOI = root.querySelector("#noi-input").value;
          const ok = !!answers.residentialNOI;
          toggleError(root, "#noi-error", !ok);
          return ok;
        }
        answers.rentcastMonthlyRent = root.querySelector("#rent-input").value;
        answers.annualPropertyTaxes = root.querySelector("#taxes-input").value;
        answers.annualInsurance = root.querySelector("#insurance-input").value;
        let ok = true;
        toggleError(root, "#rent-error", !answers.rentcastMonthlyRent); if (!answers.rentcastMonthlyRent) ok = false;
        toggleError(root, "#taxes-error", !answers.annualPropertyTaxes); if (!answers.annualPropertyTaxes) ok = false;
        toggleError(root, "#insurance-error", !answers.annualInsurance); if (!answers.annualInsurance) ok = false;
        return ok;
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
    key: "downPayment",
    progress: true,
    render(root) {
      root.innerHTML = `
        <h2 class="step-title">Down Payment</h2>
        <p class="step-sub">How much down payment does the seller need to move into their next stage?
        It's okay to skip this if they're not sure yet.</p>
        <input type="number" id="dp-input" placeholder="Down payment amount" ${answers.dpSkipped ? "disabled" : ""}>
        <div style="margin-top:10px;">
          <button type="button" class="btn ghost-small ${answers.dpSkipped ? "active" : ""}" id="skip-dp-btn">Skip / not sure</button>
        </div>
        <div id="nonneg-wrap"></div>
      `;
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
      root.querySelector("#dp-input").oninput = (e) => {
        answers.downPaymentNeeded = e.target.value;
        renderNonNeg();
      };
      root.querySelector("#skip-dp-btn").onclick = () => {
        answers.dpSkipped = !answers.dpSkipped;
        if (answers.dpSkipped) { answers.downPaymentNeeded = ""; answers.downPaymentNonNegotiable = ""; }
        renderStep();
      };
    },
    validate(root) {
      if (answers.dpSkipped) return true;
      answers.downPaymentNeeded = root.querySelector("#dp-input").value;
      if (!answers.downPaymentNeeded) return true; // treated as skipped
      const ok = !!answers.downPaymentNonNegotiable;
      toggleError(root, "#nonneg-error", !ok);
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
    ["Units", answers.units],
    ["Asset Type", answers.assetType],
    ["Subtype / Details", answers.assetSubtype || [answers.beds && `${answers.beds} bd`, answers.baths && `${answers.baths} ba`, answers.sqft && `${answers.sqft} sqft`].filter(Boolean).join(", ")]
  );
  if (answers.assetType === "Residential Property (1 unit)") {
    rows.push(["Occupied Status", answers.residentialOccupied || "—"]);
    if (answers.residentialOccupied === "Vacant (no tenant)") {
      rows.push(
        ["Rentcast Monthly Rent", answers.rentcastMonthlyRent || "—"],
        ["Annual Property Taxes", answers.annualPropertyTaxes || "—"],
        ["Annual Insurance", answers.annualInsurance || "—"]
      );
    }
    rows.push(["NOI", answers.residentialNOI || "—"]);
  } else if (answers.assetType === "Commercial Property") {
    rows.push(["NOI", answers.commercialNOI || "—"]);
  } else if (answers.assetType === "Business") {
    rows.push(
      ["Annual Revenue", answers.businessRevenue || "—"],
      [`Annual ${answers.businessEarningsType || "Earnings"}`, answers.businessEarnings || "—"]
    );
  }
  rows.push(
    ["Total Debt", answers.debtUnknown ? "Unknown" : (answers.totalDebt || "—")],
    ["Willing: New Senior Loan", answers.seniorLoanWilling],
    ["Willing: Payment Structure", answers.paymentStructureWilling],
    ["Price Sought", answers.priceSought],
    ["Price Reasoning", answers.priceReasoning],
    ["Down Payment Needed", answers.dpSkipped || !answers.downPaymentNeeded ? "Skipped" : answers.downPaymentNeeded],
    ["Seller Flexible on Down Payment", answers.downPaymentNonNegotiable || "N/A"],
    ["On/Off Market", answers.marketStatus || "—"],
    ["Listing Source Link", answers.sourceLink || "—"]
  );
  return rows;
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
        sellerContactName: answers.sellerContactName, sellerContactPhone: answers.sellerContactPhone,
        sellerContactEmail: answers.sellerContactEmail,
        street: answers.street, city: answers.city, state: answers.state, zip: answers.zip, units: answers.units,
        assetType: answers.assetType, assetSubtype: answers.assetSubtype,
        beds: answers.beds, baths: answers.baths, sqft: answers.sqft,
        occupiedStatus: answers.residentialOccupied, monthlyRentEstimate: answers.rentcastMonthlyRent,
        annualPropertyTaxes: answers.annualPropertyTaxes, annualInsurance: answers.annualInsurance,
        noi: answers.residentialNOI || answers.commercialNOI,
        businessRevenue: answers.businessRevenue, businessEarningsType: answers.businessEarningsType,
        businessEarnings: answers.businessEarnings,
        totalDebt: answers.debtUnknown ? "" : answers.totalDebt,
        seniorLoanWilling: answers.seniorLoanWilling, paymentStructureWilling: answers.paymentStructureWilling,
        priceSought: answers.priceSought, priceReasoning: answers.priceReasoning,
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
      <dl class="review-grid" style="text-align:left;">
        ${rows.map(([k,v]) => `<div><dt>${k}</dt><dd>${escapeHtml(String(v ?? "—"))}</dd></div>`).join("")}
      </dl>
      <div class="nav-row" style="justify-content:center;">
        <button class="btn primary" id="submit-another-btn">Submit Another Lead</button>
      </div>
    `;
    container.querySelector("#submit-another-btn").onclick = () => {
      Object.keys(answers).forEach(k => delete answers[k]);
      goTo(0);
    };
  } catch (err) {
    errBox.style.display = "block";
    errBox.textContent = "Submission failed: " + err.message + ". Please try again.";
    btn.disabled = false;
    btn.textContent = "Submit";
  }
}

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
  document.getElementById("status-message").hidden = true;
  document.getElementById("status-email-error").classList.remove("show");
}

function hideStatusView() {
  document.getElementById("status-view").hidden = true;
  document.getElementById("public-view").hidden = false;
}

document.getElementById("status-back-btn").onclick = hideStatusView;

document.getElementById("status-lookup-btn").onclick = async () => {
  const emailInput = document.getElementById("status-email-input");
  const email = emailInput.value.trim();
  const errEl = document.getElementById("status-email-error");
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  errEl.classList.toggle("show", !emailOk);
  if (!emailOk) return;

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
  renderStatusLeads(email, res.leads);
};

function buildLeadFields(lead) {
  const fields = [
    ["Submitted", formatDate(lead["Submitted At"])],
    ["Role", lead["Role"]], ["Name", lead["Contact Name"]], ["Email", lead["Contact Email"]], ["Phone", lead["Contact Phone"]],
    ["Social Link", lead["Social Link"] || "—"],
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
    ["Units", lead["Units"]],
    ["Asset Type", lead["Asset Type"]], ["Subtype", lead["Asset Subtype"] || "—"],
    ["Beds", lead["Beds"] || "—"], ["Baths", lead["Baths"] || "—"], ["Sq Ft", lead["Sq Ft"] || "—"]
  );
  if (lead["Asset Type"] === "Residential Property (1 unit)") {
    fields.push(["Occupied Status", lead["Occupied Status"] || "—"]);
    if (lead["Occupied Status"] === "Vacant (no tenant)") {
      fields.push(
        ["Rentcast Monthly Rent", lead["Monthly Rent Estimate"] || "—"],
        ["Annual Property Taxes", lead["Annual Property Taxes"] || "—"],
        ["Annual Insurance", lead["Annual Insurance"] || "—"]
      );
    }
    fields.push(["NOI", lead["NOI"] || "—"]);
  } else if (lead["Asset Type"] === "Commercial Property") {
    fields.push(["NOI", lead["NOI"] || "—"]);
  } else if (lead["Asset Type"] === "Business") {
    fields.push(
      ["Annual Revenue", lead["Business Revenue"] || "—"],
      [`Annual ${lead["Business Earnings Type"] || "Earnings"}`, lead["Business Earnings"] || "—"]
    );
  }
  fields.push(
    ["Total Debt", lead["Total Debt"]],
    ["Willing: New Senior Loan", lead["Senior Loan Willing"]],
    ["Willing: Payment Structure", lead["Payment Structure Willing"]],
    ["Price Sought", lead["Price Sought"]], ["Price Reasoning", lead["Price Reasoning"]],
    ["Down Payment Needed", lead["Down Payment Needed"]],
    ["Seller Flexible on Down Payment", lead["Down Payment Non-Negotiable"]],
    ["On/Off Market", lead["Market Status"] || "—"],
    ["Listing Source Link", lead["Source Link"] || "—"],
    ["Status", lead["Status"] || "New"]
  );
  return fields;
}

function renderStatusLeads(email, leads) {
  const container = document.getElementById("status-leads-container");
  container.innerHTML = leads.map(lead => {
    const fields = buildLeadFields(lead).filter(([k]) => k !== "Email" && k !== "Phone");
    return `
      <div class="card">
        <dl class="review-grid">
          ${fields.map(([k,v]) => `<div><dt>${k}</dt><dd>${escapeHtml(String(v ?? "—"))}</dd></div>`).join("")}
        </dl>
        <div class="notes-list">
          <strong>Your Notes</strong>
          <div>
            ${(lead.notes || []).map(n => `
              <div class="note-item"><span class="ts">${formatDate(n.timestamp)}</span>${escapeHtml(n.note)}</div>
            `).join("") || `<p class="small-muted">No notes yet.</p>`}
          </div>
          <textarea class="status-note-input" placeholder="Add a note (this can't edit or delete the info above — only admin can do that)"></textarea>
          <button class="btn primary status-add-note-btn" style="margin-top:8px;" data-lead-id="${lead["Lead ID"]}">Add Note</button>
        </div>
      </div>
    `;
  }).join("");

  container.querySelectorAll(".status-add-note-btn").forEach(btn => {
    btn.onclick = async () => {
      const card = btn.closest(".card");
      const textarea = card.querySelector(".status-note-input");
      const note = textarea.value.trim();
      if (!note) return;
      btn.disabled = true;
      const res = await api("addPublicNote", { email, leadId: btn.dataset.leadId, note });
      btn.disabled = false;
      if (res.ok) {
        const lead = leads.find(l => l["Lead ID"] === btn.dataset.leadId);
        lead.notes = lead.notes || [];
        lead.notes.push({ timestamp: new Date().toISOString(), note });
        renderStatusLeads(email, leads);
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

async function loadLeads() {
  adminMessage("Loading leads...", "info");
  const res = await api("getLeads", { token: sessionToken });
  if (!res.ok) { adminMessage(res.error, "danger"); return; }
  currentLeads = res.leads.sort((a, b) => new Date(b["Submitted At"]) - new Date(a["Submitted At"]));
  adminMessage("", "info");
  renderCrmTable();
}

function renderCrmTable() {
  const tbody = document.getElementById("crm-tbody");
  const emptyEl = document.getElementById("crm-empty");
  if (currentLeads.length === 0) {
    tbody.innerHTML = "";
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;
  tbody.innerHTML = currentLeads.map((l, i) => `
    <tr data-idx="${i}">
      <td>${formatDate(l["Submitted At"])}</td>
      <td>${escapeHtml(l["Role"] || "")}</td>
      <td>${escapeHtml(l["Contact Name"] || "")}<br><span class="small-muted">${escapeHtml(l["Contact Email"] || "")} · ${escapeHtml(l["Contact Phone"] || "")}</span></td>
      <td>${escapeHtml(l["City"] || "")}, ${escapeHtml(l["State"] || "")}</td>
      <td>${escapeHtml(l["Asset Type"] || "")}</td>
      <td>${escapeHtml(l["Senior Loan Willing"] || "")}</td>
      <td>${escapeHtml(l["Payment Structure Willing"] || "")}</td>
      <td>${escapeHtml(String(l["Price Sought"] ?? ""))}</td>
      <td><span class="status-pill">${escapeHtml(l["Status"] || "New")}</span></td>
    </tr>
  `).join("");
  tbody.querySelectorAll("tr").forEach(tr => {
    tr.onclick = () => openDetail(currentLeads[Number(tr.dataset.idx)]);
  });
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
      ${["New","Contacted","Under Review","Offer Sent","Closed","Dead"].map(s =>
        `<option value="${s}" ${lead["Status"] === s ? "selected" : ""}>${s}</option>`).join("")}
    </select>
    <dl class="review-grid" style="margin-top:16px;">
      ${fields.map(([k,v]) => `<div><dt>${k}</dt><dd>${escapeHtml(String(v ?? "—"))}</dd></div>`).join("")}
    </dl>
    <div class="notes-list">
      <strong>Notes</strong>
      <div id="notes-container">
        ${(lead.notes || []).map(n => `
          <div class="note-item"><span class="ts">${formatDate(n.timestamp)} — ${escapeHtml(n.author || "Admin")}</span>${escapeHtml(n.note)}</div>
        `).join("") || `<p class="small-muted">No notes yet.</p>`}
      </div>
      <textarea id="new-note-input" placeholder="Add a note (raw lead data above can't be edited or deleted)"></textarea>
      <button class="btn primary" id="add-note-btn" style="margin-top:8px;">Add Note</button>
    </div>
  `;

  panel.querySelector("#close-detail-btn").onclick = () => overlay.hidden = true;
  panel.querySelector("#status-select").onchange = async (e) => {
    const res = await api("updateStatus", { token: sessionToken, leadId: lead["Lead ID"], status: e.target.value });
    if (res.ok) { lead["Status"] = e.target.value; renderCrmTable(); }
  };
  panel.querySelector("#add-note-btn").onclick = async () => {
    const noteInput = panel.querySelector("#new-note-input");
    const note = noteInput.value.trim();
    if (!note) return;
    const res = await api("addNote", { token: sessionToken, leadId: lead["Lead ID"], note });
    if (res.ok) {
      lead.notes = lead.notes || [];
      lead.notes.push({ timestamp: new Date().toISOString(), note });
      openDetail(lead);
    }
  };
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
