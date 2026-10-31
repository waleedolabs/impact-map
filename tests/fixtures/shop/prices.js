'use strict';

const CURRENCY = 'USD';

function format(amount) {
  return amount.toFixed(2) + ' ' + CURRENCY;
}

function total(items) {
  return items.reduce((sum, i) => sum + i.price * i.qty, 0);
}

module.exports = { format, total };
