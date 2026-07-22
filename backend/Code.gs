/**
 * Seller Lead Form — Apps Script backend.
 *
 * Deploy this bound to a Google Sheet (see SETUP.md). It is the entire
 * "server": public lead submissions, admin login, notes, export-to-sheet,
 * and gated delete-all all live here. No other backend exists.
 *
 * Required Script Properties (Project Settings -> Script Properties):
 *   ADMIN_PASSWORD      - the password the admin logs in with
 *   RECOVERY_CODE_WORD  - the word that unlocks emailing the password
 *   ADMIN_EMAIL         - where recovery emails are sent (fixed, not caller-supplied)
 *   SESSION_SECRET      - random long string, used to sign session tokens
 *   SHARED_SECRET       - (optional) simple app key the frontend also sends
 */

const LEADS_SHEET = 'Leads';
const NOTES_SHEET = 'Notes';
const SESSION_HOURS = 12;

const LEAD_COLUMNS = [
  'Lead ID', 'Submitted At', 'Role', 'Contact Name', 'Contact Email', 'Contact Phone', 'Social Link',
  'Seller Contact Name', 'Seller Contact Phone', 'Seller Contact Email',
  'Street Address', 'City', 'State', 'Zip', 'Units',
  'Asset Type', 'Asset Subtype', 'Beds', 'Baths', 'Sq Ft',
  'Occupied Status', 'Monthly Rent Estimate', 'Annual Property Taxes', 'Annual Insurance',
  'NOI', 'Business Revenue', 'Business Earnings Type', 'Business Earnings',
  'Total Debt', 'Senior Loan Willing', 'Payment Structure Willing',
  'Price Sought', 'Price Reasoning', 'Down Payment Needed', 'Down Payment Non-Negotiable',
  'Market Status', 'Source Link',
  'Status'
];

const NOTE_COLUMNS = ['Lead ID', 'Timestamp', 'Note', 'Author'];

function doGet(e) {
  const action = e.parameter.action;
  if (action === 'ping') {
    return jsonOut({ ok: true, message: 'Seller Lead Form backend is alive.' });
  }
  return jsonOut({ ok: false, error: 'Use POST for this API.' });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut({ ok: false, error: 'Bad request body.' });
  }

  const action = body.action;
  try {
    switch (action) {
      case 'submitLead':
        return jsonOut(submitLead(body));
      case 'adminLogin':
        return jsonOut(adminLogin(body));
      case 'forgotPassword':
        return jsonOut(forgotPassword(body));
      case 'getLeads':
        return jsonOut(withSession(body, getLeads));
      case 'addNote':
        return jsonOut(withSession(body, addNote));
      case 'updateStatus':
        return jsonOut(withSession(body, updateStatus));
      case 'exportToSheet':
        return jsonOut(withSession(body, exportToSheet));
      case 'deleteAllLeads':
        return jsonOut(withSession(body, deleteAllLeads));
      case 'getLeadsByEmail':
        return jsonOut(getLeadsByEmail(body));
      case 'addPublicNote':
        return jsonOut(addPublicNote(body));
      default:
        return jsonOut({ ok: false, error: 'Unknown action.' });
    }
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- Sheets helpers ----------

function getSheet(name, columns) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(columns);
    sheet.setFrozenRows(1);
  } else {
    ensureHeaders(sheet, columns);
  }
  return sheet;
}

// Adds any columns that didn't exist yet (e.g. a sheet created before a
// later feature added a new field) without disturbing existing data.
function ensureHeaders(sheet, columns) {
  const lastCol = sheet.getLastColumn();
  const existing = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  const missing = columns.filter(function (c) { return existing.indexOf(c) === -1; });
  if (missing.length > 0) {
    sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
  }
}

// Builds a row from a {headerName: value} object rather than a fixed
// positional array, since a sheet created before a later feature added new
// columns will have those new columns appended at the end (by
// ensureHeaders) rather than in LEAD_COLUMNS's logical order -- a plain
// positional appendRow would silently write values into the wrong columns.
function appendRowByHeaders(sheet, dataObj) {
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const row = headers.map(function (h) {
    const v = dataObj[h];
    return (v === undefined || v === null) ? '' : v;
  });
  sheet.appendRow(row);
}

function sheetToObjects(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (row.every(function (c) { return c === '' || c === null; })) continue;
    const obj = {};
    headers.forEach(function (h, idx) { obj[h] = row[idx]; });
    obj._row = i + 1; // 1-indexed sheet row, for in-place updates
    rows.push(obj);
  }
  return rows;
}

// ---------- Public: submit a lead ----------

function submitLead(body) {
  const d = body.data || {};
  const required = ['role', 'name', 'email', 'phone', 'street', 'city', 'state', 'zip', 'units', 'assetType', 'marketStatus'];
  for (const key of required) {
    if (d[key] === undefined || d[key] === null || d[key] === '') {
      return { ok: false, error: 'Missing required field: ' + key };
    }
  }

  const sheet = getSheet(LEADS_SHEET, LEAD_COLUMNS);
  const leadId = Utilities.getUuid();
  const submittedAt = new Date().toISOString();

  appendRowByHeaders(sheet, {
    'Lead ID': leadId, 'Submitted At': submittedAt, 'Role': d.role, 'Contact Name': d.name,
    'Contact Email': d.email, 'Contact Phone': d.phone, 'Social Link': d.socialLink || '',
    'Seller Contact Name': d.sellerContactName || '', 'Seller Contact Phone': d.sellerContactPhone || '',
    'Seller Contact Email': d.sellerContactEmail || '',
    'Street Address': d.street, 'City': d.city, 'State': d.state, 'Zip': d.zip, 'Units': d.units,
    'Asset Type': d.assetType, 'Asset Subtype': d.assetSubtype || '',
    'Beds': d.beds || '', 'Baths': d.baths || '', 'Sq Ft': d.sqft || '',
    'Occupied Status': d.occupiedStatus || '', 'Monthly Rent Estimate': d.monthlyRentEstimate || '',
    'Annual Property Taxes': d.annualPropertyTaxes || '', 'Annual Insurance': d.annualInsurance || '',
    'NOI': d.noi || '', 'Business Revenue': d.businessRevenue || '',
    'Business Earnings Type': d.businessEarningsType || '', 'Business Earnings': d.businessEarnings || '',
    'Total Debt': (d.totalDebt === undefined || d.totalDebt === null || d.totalDebt === '') ? 'Unknown' : d.totalDebt,
    'Senior Loan Willing': d.seniorLoanWilling, 'Payment Structure Willing': d.paymentStructureWilling,
    'Price Sought': d.priceSought, 'Price Reasoning': d.priceReasoning,
    'Down Payment Needed': (d.downPaymentNeeded === undefined || d.downPaymentNeeded === '') ? 'Skipped' : d.downPaymentNeeded,
    'Down Payment Non-Negotiable': d.downPaymentNonNegotiable || 'N/A',
    'Market Status': d.marketStatus, 'Source Link': d.sourceLink || '',
    'Status': 'New'
  });

  return { ok: true, leadId: leadId };
}

// ---------- Admin auth ----------

function adminLogin(body) {
  const props = PropertiesService.getScriptProperties();
  const password = props.getProperty('ADMIN_PASSWORD');
  if (!password || body.password !== password) {
    return { ok: false, error: 'Incorrect password.' };
  }
  return { ok: true, token: makeSessionToken() };
}

function forgotPassword(body) {
  // Always return the same generic message whether or not the code word
  // matched, so a caller can't use the response to guess the code word.
  const props = PropertiesService.getScriptProperties();
  const codeWord = props.getProperty('RECOVERY_CODE_WORD');
  const adminEmail = props.getProperty('ADMIN_EMAIL');
  const password = props.getProperty('ADMIN_PASSWORD');

  if (codeWord && adminEmail && password && body.codeWord === codeWord) {
    MailApp.sendEmail({
      to: adminEmail,
      subject: 'Seller Lead Form — admin password recovery',
      body: 'Your admin password is:\n\n' + password + '\n\nIf you did not request this, someone else knows your recovery code word — consider changing it in the Apps Script project\'s Script Properties.'
    });
  }
  return { ok: true, message: 'If the code word was correct, a recovery email was just sent.' };
}

function makeSessionToken() {
  const secret = PropertiesService.getScriptProperties().getProperty('SESSION_SECRET');
  const expires = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
  const sig = hmacHex(String(expires), secret);
  return expires + '.' + sig;
}

function verifySessionToken(token) {
  if (!token || token.indexOf('.') === -1) return false;
  const parts = token.split('.');
  const expires = Number(parts[0]);
  const sig = parts[1];
  if (!expires || expires < Date.now()) return false;
  const secret = PropertiesService.getScriptProperties().getProperty('SESSION_SECRET');
  return hmacHex(String(expires), secret) === sig;
}

function hmacHex(value, secret) {
  const raw = Utilities.computeHmacSha256Signature(value, secret);
  return raw.map(function (b) {
    const v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

function withSession(body, fn) {
  if (!verifySessionToken(body.token)) {
    return { ok: false, error: 'Session expired or invalid. Please log in again.' };
  }
  return fn(body);
}

// ---------- Admin: leads + notes ----------

function getLeads(body) {
  const leadsSheet = getSheet(LEADS_SHEET, LEAD_COLUMNS);
  const notesSheet = getSheet(NOTES_SHEET, NOTE_COLUMNS);
  const leads = sheetToObjects(leadsSheet);
  const notes = sheetToObjects(notesSheet);

  const notesByLead = {};
  notes.forEach(function (n) {
    const id = n['Lead ID'];
    if (!notesByLead[id]) notesByLead[id] = [];
    notesByLead[id].push({ timestamp: n['Timestamp'], note: n['Note'], author: n['Author'] || 'Admin' });
  });

  leads.forEach(function (l) {
    l.notes = notesByLead[l['Lead ID']] || [];
  });

  return { ok: true, leads: leads };
}

function addNote(body) {
  if (!body.leadId || !body.note) return { ok: false, error: 'Missing leadId or note.' };
  const sheet = getSheet(NOTES_SHEET, NOTE_COLUMNS);
  sheet.appendRow([body.leadId, new Date().toISOString(), body.note, 'Admin']);
  return { ok: true };
}

// ---------- Public: non-admin "check my leads" by email ----------
// No password on this path by design -- knowing the email is the access
// check. Only that email's own leads and only that email's own notes are
// ever returned; admin notes are never exposed here.

function getLeadsByEmail(body) {
  if (!body.email) return { ok: false, error: 'Email is required.' };
  const targetEmail = String(body.email).trim().toLowerCase();

  const leadsSheet = getSheet(LEADS_SHEET, LEAD_COLUMNS);
  const notesSheet = getSheet(NOTES_SHEET, NOTE_COLUMNS);
  const leads = sheetToObjects(leadsSheet).filter(function (l) {
    return String(l['Contact Email'] || '').trim().toLowerCase() === targetEmail;
  });
  const notes = sheetToObjects(notesSheet);

  const notesByLead = {};
  notes.forEach(function (n) {
    const author = String(n['Author'] || 'Admin').trim().toLowerCase();
    if (author !== targetEmail) return; // never expose admin's or anyone else's notes
    const id = n['Lead ID'];
    if (!notesByLead[id]) notesByLead[id] = [];
    notesByLead[id].push({ timestamp: n['Timestamp'], note: n['Note'] });
  });

  leads.forEach(function (l) {
    l.notes = notesByLead[l['Lead ID']] || [];
    delete l._row;
  });

  return { ok: true, leads: leads };
}

function addPublicNote(body) {
  if (!body.leadId || !body.note || !body.email) return { ok: false, error: 'Missing information.' };
  const targetEmail = String(body.email).trim().toLowerCase();
  const leadsSheet = getSheet(LEADS_SHEET, LEAD_COLUMNS);
  const leads = sheetToObjects(leadsSheet);
  const match = leads.find(function (l) { return l['Lead ID'] === body.leadId; });
  if (!match || String(match['Contact Email'] || '').trim().toLowerCase() !== targetEmail) {
    return { ok: false, error: 'That lead does not belong to this email address.' };
  }
  const notesSheet = getSheet(NOTES_SHEET, NOTE_COLUMNS);
  notesSheet.appendRow([body.leadId, new Date().toISOString(), body.note, body.email]);
  return { ok: true };
}

function updateStatus(body) {
  if (!body.leadId || !body.status) return { ok: false, error: 'Missing leadId or status.' };
  const sheet = getSheet(LEADS_SHEET, LEAD_COLUMNS);
  const leads = sheetToObjects(sheet);
  const match = leads.find(function (l) { return l['Lead ID'] === body.leadId; });
  if (!match) return { ok: false, error: 'Lead not found.' };
  const statusCol = LEAD_COLUMNS.indexOf('Status') + 1;
  sheet.getRange(match._row, statusCol).setValue(body.status);
  return { ok: true };
}

// ---------- Admin: export + gated delete ----------

function exportToSheet(body) {
  const leadsSheet = getSheet(LEADS_SHEET, LEAD_COLUMNS);
  const notesSheet = getSheet(NOTES_SHEET, NOTE_COLUMNS);
  const leads = sheetToObjects(leadsSheet);

  if (leads.length === 0) {
    return { ok: false, error: 'No leads to export.' };
  }

  const notes = sheetToObjects(notesSheet);
  const notesByLead = {};
  notes.forEach(function (n) {
    const id = n['Lead ID'];
    const line = '[' + n['Timestamp'] + '] ' + n['Note'];
    notesByLead[id] = notesByLead[id] ? notesByLead[id] + ' | ' + line : line;
  });

  const now = new Date();
  const stamp = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd HH-mm');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let tabName = 'Export ' + stamp;
  let suffix = 1;
  while (ss.getSheetByName(tabName)) {
    tabName = 'Export ' + stamp + ' (' + (++suffix) + ')';
  }
  const exportSheet = ss.insertSheet(tabName);
  const headers = LEAD_COLUMNS.concat(['All Notes', 'Exported At']);
  exportSheet.appendRow(headers);
  exportSheet.setFrozenRows(1);

  const exportedAt = now.toISOString();
  leads.forEach(function (l) {
    const row = LEAD_COLUMNS.map(function (c) { return l[c]; });
    row.push(notesByLead[l['Lead ID']] || '');
    row.push(exportedAt);
    exportSheet.appendRow(row);
  });

  const exportToken = Utilities.getUuid();
  const props = PropertiesService.getScriptProperties();
  props.setProperty('EXPORT_TOKEN', exportToken);
  props.setProperty('EXPORT_TOKEN_EXPIRES', String(Date.now() + 30 * 60 * 1000));

  return {
    ok: true,
    exportedCount: leads.length,
    tabName: tabName,
    exportToken: exportToken
  };
}

function deleteAllLeads(body) {
  const props = PropertiesService.getScriptProperties();
  const storedToken = props.getProperty('EXPORT_TOKEN');
  const expires = Number(props.getProperty('EXPORT_TOKEN_EXPIRES') || 0);

  if (!storedToken || !body.exportToken || body.exportToken !== storedToken) {
    return { ok: false, error: 'You must export the current data before it can be deleted.' };
  }
  if (Date.now() > expires) {
    return { ok: false, error: 'Export confirmation expired — please export again before deleting.' };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const leadsSheet = getSheet(LEADS_SHEET, LEAD_COLUMNS);
  const notesSheet = getSheet(NOTES_SHEET, NOTE_COLUMNS);

  clearSheetBody(leadsSheet);
  clearSheetBody(notesSheet);

  props.deleteProperty('EXPORT_TOKEN');
  props.deleteProperty('EXPORT_TOKEN_EXPIRES');

  return { ok: true, message: 'CRM data cleared. Exported copy is safe in tab.' };
}

function clearSheetBody(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.deleteRows(2, lastRow - 1);
  }
}
