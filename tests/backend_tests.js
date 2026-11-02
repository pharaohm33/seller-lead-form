function tests(M) {
  const results = [];
  const check = (name, cond, extra) => results.push((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  <-- ' + JSON.stringify(extra)));
  const EMAIL = 'me@example.com';
  const dealA = { street: '12 Maple Ave', city: 'Tucson', state: 'AZ', zip: '85701', assetType: 'Residential Property (1-4 units)', marketStatus: 'On-Market', units: '1', askingPrice: '330000', email: EMAIL, name: 'Agent', phone: '520-555-0100', preLoiNotes: 'notes A' };
  const dealB = Object.assign({}, dealA, { street: '99 Oak Street', zip: '85702' });
  const save = (a, crmId) => adminSavePreLoi({ email: EMAIL, crmId: crmId || '', stepIndex: 19, answers: a });
  const list = (inc) => adminGetPreLoi({ includeDeleted: !!inc }).entries;

  // 1. many Pre-LOIs, none replaces another
  const a1 = save(dealA), b1 = save(dealB);
  check('two different properties = two rows', a1.ok && b1.ok && a1.crmId !== b1.crmId && list().length === 2, { a1, b1, n: list().length });
  const a2 = save(Object.assign({}, dealA, { askingPrice: '325000' }));
  check('same property saved again updates, no duplicate', a2.ok && a2.crmId === a1.crmId && list().length === 2 && a2.how.indexOf('updated') !== -1, { a2, n: list().length });
  check('same property written differently still matches', save(Object.assign({}, dealA, { street: '12 MAPLE AVENUE.' })).crmId === a1.crmId, {});
  check('a different zip is a different property', save(Object.assign({}, dealA, { zip: '85999' })).crmId !== a1.crmId, {});
  check('saved answers are read back intact', adminGetPreLoiEntry({ crmId: a1.crmId }).entry.answers.preLoiNotes === 'notes A', {});

  // 2. soft delete, restore, purge
  const d = adminDeletePreLoi({ crmId: b1.crmId });
  check('delete hides it but keeps the row', d.ok && !list().some(e => e.crmId === b1.crmId) && list(true).some(e => e.crmId === b1.crmId && e.status === PRELOI_DELETED_STATUS), { d });
  check('restore brings it back', adminRestorePreLoi({ crmId: b1.crmId }).ok && list().some(e => e.crmId === b1.crmId), {});
  check('purge refuses a live Pre-LOI', adminPurgePreLoi({ crmId: b1.crmId }).ok === false, {});
  adminDeletePreLoi({ crmId: b1.crmId });
  check('saving a deleted property again restores it as a normal Pre-LOI', save(dealB).crmId === b1.crmId && list().some(e => e.crmId === b1.crmId && e.status === PRELOI_STATUS), {});
  adminDeletePreLoi({ crmId: b1.crmId });
  check('purge removes a deleted one for good', adminPurgePreLoi({ crmId: b1.crmId }).ok && !list(true).some(e => e.crmId === b1.crmId), {});

  // 3. finishing: no Leads row, no beehiiv call, no email, a Submissions row
  const full = Object.assign({}, dealA, { sellerContactName: 'Rita Realtor', sellerContactEmail: 'rita@broker.com', loiUrl: 'https://pharaohm33.github.io/loi-generator?address=12+Maple' });
  const fin = adminFinishPreLoi({ email: EMAIL, crmId: a1.crmId, stepIndex: 19, answers: full, loiUrl: full.loiUrl });
  check('finish succeeds', fin.ok && fin.submissionId && fin.crmId === a1.crmId, { fin });
  check('finish adds nothing to Leads', !M.sheets['Leads'] || M.sheets['Leads'].data.length <= 1, { rows: M.sheets['Leads'] && M.sheets['Leads'].data.length });
  check('finish makes no beehiiv call and no email', M.fetches() === 0 && M.mails() === 0, { f: M.fetches(), m: M.mails() });
  check('the Pre-LOI row is now Form Completed', list().find(e => e.crmId === a1.crmId).status === PRELOI_DONE_STATUS, {});
  const bad = adminFinishPreLoi({ email: EMAIL, answers: Object.assign({}, dealA, { city: '' }) });
  check('finish refuses a missing city (and says which)', !bad.ok && /city/.test(bad.error), { bad });

  // 4. a real public submission is kept too, and the two can be cross referenced
  const pub = submitLead({ data: { role: 'Seller', name: 'Sam Seller', email: 'sam@example.com', phone: '520-555-0111', street: '12 Maple Ave', city: 'Tucson', state: 'AZ', zip: '85701', units: '1', assetType: 'Residential Property (1-4 units)', marketStatus: 'Off-Market' } });
  check('public submitLead still works', pub.ok === true || /agreement|MAO|Missing/.test(String(pub.error)), { pub });
  if (pub.ok) {
    const subs = adminGetSubmissions({}).submissions;
    check('public submission is logged', subs.some(s => s.source === 'Public form' && s.leadId === pub.leadId), { n: subs.length });
    const mine = subs.find(s => s.submissionId === fin.submissionId);
    check('cross reference: the Pre-LOI submission sees the Lead and the Pre-LOI row', mine.matches.leads === 1 && mine.matches.preLoi >= 1, { m: mine.matches });
    const detail = adminGetSubmission({ submissionId: fin.submissionId }).submission;
    check('detail lists related records of each kind', ['Lead', 'Pre-LOI', 'Submission'].every(k => detail.related.some(r => r.kind === k)), { rel: detail.related.map(r => r.kind) });
  }
  const only = adminGetSubmissions({ source: 'Pre-LOI' }).submissions;
  check('source filter', only.length === 1 && only[0].adminEmailed === 'No', { only: only.map(o => o.source) });
  check('search by address', adminGetSubmissions({ q: 'maple' }).total >= 1 && adminGetSubmissions({ q: 'zzz' }).total === 0, {});

  // 5. recording where the LOI ended up
  const up = adminUpdateSubmission({ submissionId: fin.submissionId, docUrl: 'https://docs.google.com/document/d/abc', draftStatus: 'Gmail draft saved' });
  const after = adminGetSubmission({ submissionId: fin.submissionId }).submission;
  check('doc link and draft status can be recorded', up.ok && after.docUrl.indexOf('docs.google.com') !== -1 && after.draftStatus === 'Gmail draft saved', { after: after.docUrl });
  check('answers survive the round trip', after.answers.sellerContactEmail === 'rita@broker.com' && after.loiLink.indexOf('loi-generator') !== -1, {});

  // 6. sent: the Pre-LOI stays, a copy goes to the CRM, and the public CRM route never shows Pre-LOI rows
  const sent = adminMarkPreLoiSent({ crmId: a1.crmId });
  check('LOI sent keeps the Pre-LOI row', sent.ok && list().find(e => e.crmId === a1.crmId).status === PRELOI_SENT_STATUS, { sent });
  const pubCrm = getCrmEntries({ email: EMAIL }).entries;
  check('the CRM gets a copy as Offer sent to cold lead', pubCrm.length === 1 && pubCrm[0].status === 'Offer sent to cold lead' && pubCrm[0].crmId === sent.crmId, { pubCrm: pubCrm.map(e => e.status) });
  check('public CRM never exposes Pre-LOI rows', !pubCrm.some(e => isPreLoiStatus(e.status)) && getCrmEntry({ email: EMAIL, crmId: a1.crmId }).ok === false, {});
  check('no email or beehiiv call at any point', M.mails() === 0, { m: M.mails(), f: M.fetches() });

  // 7. the audit log recorded every step
  const log = M.sheets['Pre-LOI Log'].data.slice(1).map(r => r[1]);
  check('audit log has save / delete / restore / finish / sent / purge', ['save', 'delete', 'restore', 'finish', 'sent', 'purge'].every(a => log.indexOf(a) !== -1), { log });

  // 8. huge answers still produce a Submissions row
  const huge = Object.assign({}, dealA, { street: '5 Big Rd', zip: '85710', preLoiNotes: 'x'.repeat(200000) });
  const fh = adminFinishPreLoi({ email: EMAIL, answers: huge });
  check('a very large form still saves (long AI text is trimmed)', fh.ok === true || /too much data/.test(String(fh.error)), { fh: fh.error });

  // 9. submissions can be deleted (reversibly) and filed in the normal CRM at a pipeline stage
  const dealC = Object.assign({}, dealA, { street: '7 Pine Rd', zip: '85703', role: 'Wholesaler', units: '1', rentalIncomeMethod: 'Long-term rental (LTR)', rentalIncomeDetail: 'LTR rent $1,975/mo less 35% = NOI', rentcastMonthlyRent: '1975', expenseRatio: '35', residentialNOI: '15405', strAnnualRevenue: '30000', strNOI: '15000' });
  const c1 = adminFinishPreLoi({ email: EMAIL, answers: dealC, loiUrl: 'https://x.io/?a=1' });
  const subList = inc => adminGetSubmissions({ includeDeleted: !!inc }).submissions;
  check('delete hides a submission but keeps its row', adminDeleteSubmission({ submissionId: c1.submissionId }).ok && !subList().some(x => x.submissionId === c1.submissionId) && subList(true).some(x => x.submissionId === c1.submissionId && x.deletedAt), {});
  check('a deleted submission no longer counts as a match', !adminGetSubmissions({ includeDeleted: true }).submissions.some(x => x.matches && x.submissionId !== c1.submissionId && x.street === '7 Pine Rd' && x.matches.submissions > 1), {});
  check('add to CRM refuses a deleted submission', adminAddSubmissionToCrm({ submissionId: c1.submissionId, status: 'New' }).ok === false, {});
  check('restore brings a submission back', adminRestoreSubmission({ submissionId: c1.submissionId }).ok && subList().some(x => x.submissionId === c1.submissionId), {});
  check('purge refuses a live submission', adminPurgeSubmission({ submissionId: c1.submissionId }).ok === false, {});
  check('add to CRM refuses an unknown stage', adminAddSubmissionToCrm({ submissionId: c1.submissionId, status: 'Bogus' }).ok === false, {});
  const leadsBefore = M.sheets['Leads'] ? M.sheets['Leads'].data.length : 0, mailsBefore = M.mails(), fetchesBefore = M.fetches();
  const add = adminAddSubmissionToCrm({ submissionId: c1.submissionId, status: 'Offer Sent' });
  const leadRows = () => { const sh = M.sheets['Leads'], h = sh.data[0]; return sh.data.slice(1).map(r => { const o = {}; h.forEach((k, i) => o[k] = r[i]); return o; }); };
  const lr = add.ok ? leadRows().find(l => l['Lead ID'] === add.leadId) : null;
  check('add to CRM writes a Leads row at the chosen stage', add.ok && add.how === 'added' && lr && lr['Status'] === 'Offer Sent' && lr['Street Address'] === '7 Pine Rd', { add, lr });
  check('the CRM row carries the rental income method and the rent / NOI numbers', lr && lr['Rental Income Method'] === 'Long-term rental (LTR)' && /35%/.test(lr['Rental Income Detail']) && lr['Monthly Rent Estimate'] === '1975' && lr['NOI'] === '15405' && lr['STR Annual Revenue'] === '30000' && lr['Expense Ratio %'] === '35', { lr: lr && [lr['Rental Income Method'], lr['Monthly Rent Estimate'], lr['NOI'], lr['STR Annual Revenue']] });
  check('add to CRM sends no email and no beehiiv call', M.mails() === mailsBefore && M.fetches() === fetchesBefore, {});
  check('the submission now points at its CRM lead and shows its stage', subList().find(x => x.submissionId === c1.submissionId).leadId === add.leadId && subList().find(x => x.submissionId === c1.submissionId).leadStatus === 'Offer Sent', {});
  const move = adminAddSubmissionToCrm({ submissionId: c1.submissionId, status: 'Negotiation' });
  check('adding again just moves the same lead to the new stage', move.ok && move.how === 'moved' && move.leadId === add.leadId && leadRows().filter(l => l['Street Address'] === '7 Pine Rd').length === 1 && leadRows().find(l => l['Lead ID'] === add.leadId)['Status'] === 'Negotiation', { move });
  const dealD = Object.assign({}, dealC, { street: '7 PINE ROAD', rentalIncomeMethod: 'None: fix & flip' });
  const d1 = adminFinishPreLoi({ email: EMAIL, answers: dealD, loiUrl: 'https://x.io/?a=2' });
  const dup = adminAddSubmissionToCrm({ submissionId: d1.submissionId, status: 'New' });
  check('the same property already in the CRM is reported first', dup.ok === false && dup.duplicate && dup.duplicate.leadId === add.leadId && leadRows().filter(l => /pine/i.test(l['Street Address'])).length === 1, { dup });
  const forced = adminAddSubmissionToCrm({ submissionId: d1.submissionId, status: 'New', force: true });
  check('force adds it anyway', forced.ok && forced.how === 'added' && leadRows().filter(l => /pine/i.test(l['Street Address'])).length === 2, { forced });
  const noRole = adminFinishPreLoi({ email: EMAIL, answers: Object.assign({}, dealC, { street: '8 Elm Ct', zip: '85704', role: '' }), loiUrl: '' });
  const nr = adminAddSubmissionToCrm({ submissionId: noRole.submissionId, status: 'New' });
  check('a submission missing a required CRM field is refused and says which', nr.ok === false && /role/.test(nr.error), { nr });
  adminDeleteSubmission({ submissionId: d1.submissionId });
  check('purge removes a deleted submission for good', adminPurgeSubmission({ submissionId: d1.submissionId }).ok && !subList(true).some(x => x.submissionId === d1.submissionId), {});
  const log2 = M.sheets['Pre-LOI Log'].data.slice(1).map(r => r[1]);
  check('the audit log records submission delete / restore / purge / to-crm', ['delete submission', 'restore submission', 'purge submission', 'to-crm submission'].every(a => log2.indexOf(a) !== -1), { log2 });
  check('the public CRM sheet of cold leads is untouched by all of this', getCrmEntries({ email: EMAIL }).entries.length === 1, {});

  // 10. the updated LOI generator link has its own spot (not the notes), shared by the Pre-LOI row and its submissions
  const dealE = Object.assign({}, dealA, { street: '3 Cedar Ln', zip: '85705', role: 'Wholesaler' });
  const e1 = adminFinishPreLoi({ email: EMAIL, answers: dealE, loiUrl: 'https://pharaohm33.github.io/loi-generator/?purchase_price=323000' });
  const upd = 'https://pharaohm33.github.io/loi-generator/?purchase_price=295000&sc_term=1';
  check('save updated LOI from the Pre-LOI side', adminSaveUpdatedLoi({ crmId: e1.crmId, loiUrl: upd }).ok, {});
  check('the Pre-LOI row keeps it apart from the notes and the original link', adminGetPreLoiEntry({ crmId: e1.crmId }).entry.answers.updatedLoiUrl === upd && adminGetPreLoiEntry({ crmId: e1.crmId }).entry.answers.loiUrl.indexOf('323000') !== -1, {});
  check('its Submission shows the same updated link', adminGetSubmission({ submissionId: e1.submissionId }).submission.updatedLoiLink === upd && !!adminGetSubmission({ submissionId: e1.submissionId }).submission.updatedLoiAt, {});
  const upd2 = upd + '&acq_pct=50';
  check('save updated LOI from the Submission side updates the Pre-LOI row too', adminSaveUpdatedLoi({ submissionId: e1.submissionId, loiUrl: upd2 }).ok && adminGetPreLoiEntry({ crmId: e1.crmId }).entry.answers.updatedLoiUrl === upd2, {});
  check('a link that is not a link is refused', adminSaveUpdatedLoi({ crmId: e1.crmId, loiUrl: 'not a link' }).ok === false && adminGetPreLoiEntry({ crmId: e1.crmId }).entry.answers.updatedLoiUrl === upd2, {});
  check('an empty link clears it everywhere', adminSaveUpdatedLoi({ crmId: e1.crmId, loiUrl: '' }).ok && !adminGetPreLoiEntry({ crmId: e1.crmId }).entry.answers.updatedLoiUrl && adminGetSubmission({ submissionId: e1.submissionId }).submission.updatedLoiLink === '', {});
  check('an unknown deal is refused', adminSaveUpdatedLoi({ crmId: 'nope', loiUrl: upd }).ok === false, {});

  // 11. Last Updated on the Leads: stamped at creation and on every change
  const lu = (id) => leadRows().find(l => l['Lead ID'] === id)['Last Updated'];
  const setLu = (id, v) => { const sh = M.sheets['Leads'], h = sh.data[0], c = h.indexOf('Last Updated'), r = sh.data.findIndex((row, i) => i > 0 && row[h.indexOf('Lead ID')] === id); sh.data[r][c] = v; };
  const OLD = '2020-01-01T00:00:00.000Z';
  check('a lead is stamped Last Updated from the moment it is created', !!lu(add.leadId) && String(lu(add.leadId)) >= String(leadRows().find(l => l['Lead ID'] === add.leadId)['Submitted At']) && !!leadRows().find(l => /Maple/.test(l['Street Address']) )['Last Updated'], { lu: lu(add.leadId) });
  const bumps = [
    ['stage change', () => updateStatus({ leadId: add.leadId, status: 'Negotiation' })],
    ['closing likelihood', () => updateClosingLikelihood({ leadId: add.leadId, score: 4 })],
    ['team', () => updateTeam({ leadId: add.leadId, team: 'Team A' })],
    ['MAO', () => updateMaoForLead({ leadId: add.leadId, maoCash: '1', maoHardMoney10: '2', maoHardMoney20: '3', maoBreakdown: 'x' })],
    ['admin note', () => addNote({ leadId: add.leadId, note: 'seller countered at 300k' })]
  ];
  bumps.forEach(([name, fn]) => { setLu(add.leadId, OLD); const r = fn(); check('Last Updated moves on ' + name, r.ok && String(lu(add.leadId)) > OLD, { r, lu: lu(add.leadId) }); });
  const noteId = getLeads({}).leads.find(l => l['Lead ID'] === add.leadId).notes[0].noteId;
  setLu(add.leadId, OLD); deleteNote({ noteId: noteId });
  check('Last Updated moves when a note is deleted', String(lu(add.leadId)) > OLD, { lu: lu(add.leadId) });
  setLu(add.leadId, '');
  const gl = getLeads({}).leads.find(l => l['Lead ID'] === add.leadId);
  check('an old lead with no stamp shows its submit time (or newest note) as Last Updated', !!gl['Last Updated'], { gl: gl['Last Updated'] });
  const lbe = getLeadsByEmail({ email: 'me@example.com' });
  check('Last Updated is admin-only (not in the public submitter view)', PUBLIC_LEAD_FIELDS.indexOf('Last Updated') === -1 && (!lbe.leads || lbe.leads.every(l => !('Last Updated' in l))), {});

  // 12. bulk clean-up: archive / delete / restore, never touching a sent offer or a deal already in the CRM
  const mk = (street, zip) => adminFinishPreLoi({ email: EMAIL, answers: Object.assign({}, dealA, { street: street, zip: zip, role: 'Wholesaler' }), loiUrl: 'https://pharaohm33.github.io/loi-generator/?x=' + zip });
  const k1 = mk('1 Junk Rd', '85711'), k2 = mk('2 Junk Rd', '85712'), k3 = mk('3 Sent Rd', '85713'), k4 = mk('4 Crm Rd', '85714');
  adminMarkPreLoiSent({ crmId: k3.crmId });
  adminAddSubmissionToCrm({ submissionId: k4.submissionId, status: 'New' });
  const ids = [k1.crmId, k2.crmId, k3.crmId, 'nope'];
  const ba = adminBulkPreLoi({ crmIds: ids, action: 'archive' });
  check('bulk archive Pre-LOI: the unsent ones are archived, the sent one and a bad id are skipped with a reason', ba.ok && ba.done === 2 && ba.skipped.length === 2 && ba.skipped.some(s => /sent/.test(s.reason)) && ba.skipped.some(s => /not found/.test(s.reason)), { ba });
  check('archived Pre-LOIs are hidden from the list but kept', !list().some(e => e.crmId === k1.crmId) && adminGetPreLoi({ includeArchived: true }).entries.some(e => e.crmId === k1.crmId && e.status === PRELOI_ARCHIVED_STATUS), {});
  check('the sent Pre-LOI is still in the list as sent', list().some(e => e.crmId === k3.crmId && e.status === PRELOI_SENT_STATUS), {});
  check('archived rows do not count in the cross reference', adminGetSubmissions({}).submissions.find(s => s.submissionId === k1.submissionId).matches.preLoi === 0, {});
  check('bulk archive twice skips what is already archived', adminBulkPreLoi({ crmIds: [k1.crmId], action: 'archive' }).skipped.some(s => /already/.test(s.reason)), {});
  const br = adminBulkPreLoi({ crmIds: [k1.crmId, k3.crmId], action: 'restore' });
  check('bulk restore brings an archived one back (as Form Completed, it has a submission) and skips one that was never archived', br.done === 1 && list().find(e => e.crmId === k1.crmId).status === PRELOI_DONE_STATUS && br.skipped.length === 1, { br });
  const bd = adminBulkPreLoi({ crmIds: [k1.crmId, k2.crmId, k3.crmId], action: 'delete' });
  check('bulk delete hides the same reversible way and still skips the sent one', bd.done === 2 && bd.skipped.length === 1 && adminGetPreLoi({ includeDeleted: true }).entries.filter(e => e.status === PRELOI_DELETED_STATUS).length >= 2, { bd });
  check('saving an archived property again brings it back as a normal Pre-LOI', (adminBulkPreLoi({ crmIds: [k2.crmId], action: 'restore' }), adminBulkPreLoi({ crmIds: [k2.crmId], action: 'archive' }), save(Object.assign({}, dealA, { street: '2 Junk Rd', zip: '85712', role: 'Wholesaler' })).crmId === k2.crmId && list().find(e => e.crmId === k2.crmId).status === PRELOI_STATUS), {});
  check('bulk Pre-LOI refuses an unknown action or an empty pick', adminBulkPreLoi({ crmIds: [k1.crmId], action: 'purge' }).ok === false && adminBulkPreLoi({ crmIds: [], action: 'archive' }).ok === false, {});

  const sa = adminBulkSubmissions({ submissionIds: [k1.submissionId, k2.submissionId, k3.submissionId, k4.submissionId], action: 'archive' });
  const subIds = () => adminGetSubmissions({}).submissions.map(s => s.submissionId);
  check('bulk archive submissions skips the sent offer and the deal already in the CRM', sa.ok && sa.skipped.length === 2 && sa.skipped.some(s => /sent/.test(s.reason)) && sa.skipped.some(s => /CRM/.test(s.reason)), { sa });
  check('archived submissions are hidden but kept, and shown with includeArchived', !subIds().includes(k1.submissionId) && subIds().includes(k3.submissionId) && adminGetSubmissions({ includeArchived: true }).submissions.some(s => s.submissionId === k1.submissionId && s.archivedAt), {});
  check('a submission knows its Pre-LOI status (so the page can tell sent from not sent)', adminGetSubmissions({}).submissions.find(s => s.submissionId === k3.submissionId).preLoiStatus === PRELOI_SENT_STATUS, {});
  const sr = adminBulkSubmissions({ submissionIds: [k1.submissionId], action: 'restore' });
  check('bulk restore submissions', sr.done === 1 && subIds().includes(k1.submissionId), { sr });
  const sd = adminBulkSubmissions({ submissionIds: [k1.submissionId, k2.submissionId], action: 'delete' });
  check('bulk delete submissions (reversible) takes an archived one out of archive', sd.done === 2 && !subIds().includes(k2.submissionId) && adminGetSubmissions({ includeDeleted: true }).submissions.find(s => s.submissionId === k2.submissionId).deletedAt && !adminGetSubmissions({ includeDeleted: true, includeArchived: true }).submissions.find(s => s.submissionId === k2.submissionId).archivedAt, { sd });
  check('bulk submissions is audit-logged', M.sheets['Pre-LOI Log'].data.some(r => String(r[1]).indexOf('bulk archive submission') === 0) && M.sheets['Pre-LOI Log'].data.some(r => String(r[1]) === 'bulk archive'), {});
  check('bulk submissions refuses an unknown action', adminBulkSubmissions({ submissionIds: [k1.submissionId], action: 'purge' }).ok === false, {});

  // 13. offers sent: the Sent-mail scan fills it, the gate blocks a second offer until the seller answers, the admin can override, several accounts
  check('the accounts list is empty at first and saves several (old and new) addresses, cleaned', adminGetOfferAccounts().accounts.length === 0 && adminSetOfferAccounts({ accounts: 'Old@Gmail.com, new@gmail.com; bad, old@gmail.com' }).accounts.join('|') === 'old@gmail.com|new@gmail.com' && adminGetOfferAccounts().accounts.length === 2, {});
  check('an LOI email subject address is split into street / city / state / zip', JSON.stringify(parseAddressLine('1689 W Wood Bridge Ct, Tucson, AZ 85746')) === JSON.stringify({ street: '1689 W Wood Bridge Ct', city: 'Tucson', state: 'AZ', zip: '85746' }), parseAddressLine('1689 W Wood Bridge Ct, Tucson, AZ 85746'));
  const dealO = Object.assign({}, dealA, { street: '40 Offer St', zip: '85720', role: 'Wholesaler', units: '1' });
  const o1 = adminFinishPreLoi({ email: EMAIL, answers: dealO, loiUrl: 'https://x.io/?o=1' });
  const oLead = adminAddSubmissionToCrm({ submissionId: o1.submissionId, status: 'New' });
  check('setup: a Pre-LOI, a submission and a lead at 40 Offer St', o1.ok && oLead.ok, { o1, oLead });
  check('gate: no offer on file -> none, allowed', adminCheckOffer({ address: '40 Offer St, Tucson, AZ 85720' }).status === 'none' && adminCheckOffer({ address: '40 Offer St, Tucson, AZ 85720' }).allowed, {});
  const sent1 = { address: '40 Offer St, Tucson, AZ 85720', sentAt: '2026-10-20T15:00:00.000Z', sentTo: 'rita@broker.com', fromAccount: 'Old@Gmail.com', subject: 'LOI for 40 Offer St, Tucson, AZ 85720', threadLink: 'https://mail.google.com/mail/u/0/#sent/abc', messageKey: 'old@gmail.com|abc' };
  const rec = adminRecordOffers({ offers: [sent1, { address: 'x', sentAt: '2026-10-21T00:00:00Z' }] });
  check('recording a sent offer adds it, files the Pre-LOI as sent, moves the lead to Offer Sent and marks the submission', rec.ok && rec.added === 1 && rec.results[1].status === 'skipped' && rec.results[0].preLoi === 'marked LOI sent' && /Offer Sent/.test(rec.results[0].lead) && rec.results[0].submissions >= 1, { rec });
  check('the Pre-LOI row is LOI sent and the lead stage is Offer Sent', list().find(e => e.crmId === o1.crmId).status === PRELOI_SENT_STATUS && leadRows().find(l => l['Lead ID'] === oLead.leadId)['Status'] === 'Offer Sent', {});
  check('the same offer recorded again is not duplicated', adminRecordOffers({ offers: [sent1] }).existing === 1 && adminGetOffers({}).offers.filter(o => /40 Offer/.test(o.street)).length === 1, {});
  const g1 = adminCheckOffer({ address: '40 Offer St, Tucson, AZ 85720' });
  check('gate: an unanswered offer blocks a new one, and says who/when', g1.status === 'sent' && g1.allowed === false && g1.offer.sentTo === 'rita@broker.com' && g1.offer.fromAccount === 'old@gmail.com', { g1 });
  check('the gate also matches a differently written address (Street/St, extra spaces)', adminCheckOffer({ street: '40 OFFER Street', city: 'Tucson', state: 'AZ', zip: '85720' }).status === 'sent', {});
  check('a different address is not blocked', adminCheckOffer({ address: '41 Offer St, Tucson, AZ 85720' }).allowed, {});
  const other = adminRecordOffers({ offers: [{ address: '40 Offer St, Tucson, AZ 85720', sentAt: '2026-10-22T10:00:00.000Z', sentTo: 'sam@seller.com', fromAccount: 'new@gmail.com', subject: 'LOI for 40 Offer St', messageKey: 'new@gmail.com|def' }] });
  check('a second account (after rotating emails) is collected too', other.added === 1 && adminGetOffers({}).offers.filter(o => /40 Offer/.test(o.street)).map(o => o.fromAccount).sort().join() === 'new@gmail.com,old@gmail.com', { other });
  adminDeleteOffer({ offerId: adminGetOffers({}).offers.find(o => o.fromAccount === 'new@gmail.com').offerId });
  check('delete takes a wrongly recorded offer out of the gate (restore puts it back)', adminGetOffers({}).offers.filter(o => /40 Offer/.test(o.street)).length === 1 && adminDeleteOffer({ offerId: adminGetOffers({ includeDeleted: true }).offers.find(o => o.fromAccount === 'new@gmail.com').offerId, restore: true }).ok, {});
  adminDeleteOffer({ offerId: adminGetOffers({}).offers.find(o => o.fromAccount === 'new@gmail.com').offerId });
  const own = adminRecordResponses({ responses: [{ address: '40 Offer St, Tucson, AZ 85720', from: 'Me <OLD@gmail.com>', receivedAt: '2026-10-21T10:00:00Z', snippet: 'forwarding' }] });
  check('a reply from your own account is ignored', own.responded === 0 && adminCheckOffer({ address: '40 Offer St, Tucson, AZ 85720' }).status === 'sent', { own });
  const un = adminRecordResponses({ responses: [{ address: '999 Nowhere Rd, Tucson, AZ 85720', from: 'x@y.com', snippet: 'hi' }] });
  check('a reply about an address with no offer is reported unmatched', un.responded === 0 && un.results[0].status === 'unmatched', { un });
  const rs = adminRecordResponses({ responses: [{ address: '40 Offer St, Tucson, AZ 85720', from: 'Rita <rita@broker.com>', receivedAt: '2026-10-23T09:00:00Z', snippet: 'Seller countered at 295k with 60 days' }] });
  check('a seller reply marks the offer responded, notes the lead and moves it to Negotiation', rs.responded === 1 && /Negotiation/.test(rs.results[0].lead) && leadRows().find(l => l['Lead ID'] === oLead.leadId)['Status'] === 'Negotiation' && getLeads({}).leads.find(l => l['Lead ID'] === oLead.leadId).notes.some(n => /countered at 295k/.test(n.note)), { rs });
  const g2 = adminCheckOffer({ address: '40 Offer St, Tucson, AZ 85720' });
  check('gate: after the seller answered a new offer is allowed (status responded)', g2.status === 'responded' && g2.allowed && !!g2.offer.respondedAt, { g2 });
  check('a lead already further along is not moved by a scan', (updateStatus({ leadId: oLead.leadId, status: 'Offer Signed By Seller' }), moveLeadForOffer(leadRows().find(l => l['Lead ID'] === oLead.leadId), 'Negotiation') === 'unchanged') && leadRows().find(l => l['Lead ID'] === oLead.leadId)['Status'] === 'Offer Signed By Seller', {});
  const gAct = adminCheckOffer({ address: '40 Offer St, Tucson, AZ 85720' });
  check('gate: a deal that is signed / accepted / in escrow is never offered on again, even after the seller answered', gAct.status === 'active_deal' && gAct.allowed === false && gAct.stage === 'Offer Signed By Seller', { gAct });
  adminRecordOffers({ offers: [{ address: '40 Offer St, Tucson, AZ 85720', sentAt: '2026-10-30T10:00:00.000Z', sentTo: 'rita@broker.com', fromAccount: 'old@gmail.com', subject: 'LOI for 40 Offer St', messageKey: 'old@gmail.com|ghi' }] });
  check('the new offer blocks again until that one is answered', adminCheckOffer({ address: '40 Offer St, Tucson, AZ 85720' }).status === 'sent', {});
  const al = adminAllowNewOffer({ address: '40 Offer St, Tucson, AZ 85720', reason: 'price drop' });
  check('admin override: allowed for any reason, even with an unanswered offer out', al.ok && adminCheckOffer({ address: '40 Offer St, Tucson, AZ 85720' }).status === 'override' && adminCheckOffer({ address: '40 Offer St, Tucson, AZ 85720' }).allowed && adminCheckOffer({ address: '40 Offer St, Tucson, AZ 85720' }).permit.reason === 'price drop', { al });
  check('asking for the same override twice does not stack', adminAllowNewOffer({ address: '40 Offer St, Tucson, AZ 85720', reason: 'again' }).already === true, {});
  check('the override is used up by the next draft, then the gate is back', adminUseOfferPermit({ address: '40 Offer St, Tucson, AZ 85720' }).used === true && adminUseOfferPermit({ address: '40 Offer St, Tucson, AZ 85720' }).used === false && adminCheckOffer({ address: '40 Offer St, Tucson, AZ 85720' }).status === 'sent', {});
  const al2 = adminAllowNewOffer({ offerId: adminGetOffers({}).offers.find(o => o.sentTo === 'rita@broker.com').offerId, reason: '' });
  check('override from an offer row works and a blank reason is recorded as such; it can be cancelled', al2.ok && adminGetOffers({}).permits[0].reason === 'No reason given' && adminCancelOverride({ permitId: al2.permitId }).ok && adminCheckOffer({ address: '40 Offer St, Tucson, AZ 85720' }).status === 'sent', {});
  check('an override works for an address with no offer yet and an empty request is refused', adminAllowNewOffer({ address: '77 Fresh Rd, Tucson, AZ 85720' }).ok && adminAllowNewOffer({}).ok === false, {});
  const leadWithOffer = getLeads({}).leads.find(l => l['Lead ID'] === oLead.leadId);
  check('Leads tab: the lead carries the offer that went out for its address (count, when, to whom, waiting)', !!leadWithOffer.offer && leadWithOffer.offer.count >= 1 && leadWithOffer.offer.sentTo === 'rita@broker.com' && leadWithOffer.offer.respondedAt === '', { offer: leadWithOffer && leadWithOffer.offer });
  check('Leads tab: a lead with no offer has none', !getLeads({}).leads.some(l => !/40 Offer/.test(l['Street Address']) && l.offer), {});
  const og = adminGetOffers({ q: '40 offer' }).offers.find(o => o.sentTo === 'rita@broker.com');
  check('Offers Sent tab: each offer shows its lead and that lead\'s stage, and the submission it could be added from', og.leadId === oLead.leadId && og.leadStatus === leadRows().find(l => l['Lead ID'] === oLead.leadId)['Status'] && og.submissionId === o1.submissionId, { og });
  const log3 = M.sheets['Pre-LOI Log'].data.map(r => r[1]).join('|');
  check('offers, replies and overrides are audit-logged', ['offer sent', 'offer response', 'offer override'].every(a => log3.indexOf(a) !== -1), { log3 });
  check('the offers list shows each offer with its gate status', adminGetOffers({ q: 'offer st' }).offers.every(o => ['sent', 'responded', 'override', 'none'].indexOf(o.gate) !== -1) && adminGetOffers({ q: 'zzz' }).total === 0, {});
  return results.join('\n') + '\n' + results.filter(r => r.startsWith('FAIL')).length + ' failed of ' + results.length;
}
