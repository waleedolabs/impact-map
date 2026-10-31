'use strict';

const prices = require('./prices');

function create(order) {
  return 'Invoice #' + order.id + ': ' + prices.format(order.total);
}

module.exports = { create };
