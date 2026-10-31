'use strict';

const payment = require('./payment');
const mailer = require('./mailer');

function run(userId, cart) {
  const order = payment.pay(userId, cart);
  return { order, mail: mailer.confirm(order) };
}

module.exports = { run };
