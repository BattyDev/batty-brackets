/* Shared registration rules for the host desk and player screen. */
export function documentText(doc, event = {}) {
  return String(doc?.body ?? doc?.text ?? (doc?.id === 'doc_coc' ? event.overrides?.codeOfConduct : '') ?? '').trim();
}

export function paymentFor(entry, event) {
  const due = Number(entry.amountDue ?? event.entryFee ?? 0);
  const received = Number(entry.amountPaid ?? (entry.paidAt ? due : 0));
  return { due, received, balance: Math.max(0, Math.round((due - received) * 100) / 100),
    paid: received >= due };
}

export function validAmount(value) {
  const amount = Number(value);
  return value !== '' && Number.isFinite(amount) && amount >= 0 && amount <= 99999999.99
    && Math.abs(amount * 100 - Math.round(amount * 100)) < 0.000001;
}
