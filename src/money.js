'use strict';

const { AppError } = require('./errors');

// Largest amount accepted in one request: ₹1,000 crore. Far below 2^53.
const MAX_AMOUNT_PAISE = 1e12;

/** Amounts arrive as integer paise. "500.50", 500.5, "500" and -1 are all rejected. */
function parseAmount(value, field = 'amount') {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > MAX_AMOUNT_PAISE) {
    throw new AppError(
      400,
      'INVALID_AMOUNT',
      `${field} must be a positive whole number of paise (e.g. 50000 for ₹500), at most ${MAX_AMOUNT_PAISE}.`
    );
  }
  return value;
}

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });

/** 12345678 -> "₹1,23,456.78" (Indian digit grouping). Display only. */
function formatPaise(paise) {
  return inr.format(paise / 100);
}

module.exports = { parseAmount, formatPaise, MAX_AMOUNT_PAISE };
