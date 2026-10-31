'use strict';

const accounts = require('./accounts');
const invoices = require('./invoices');

function confirm(order) {
  const user = accounts.byId(order.userId);
  return 'To: ' + user.email + '\n' + invoices.create(order);
}

module.exports = { confirm };
