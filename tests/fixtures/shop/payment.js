'use strict';

const accounts = require('./accounts');
const cart = require('./cart');
const db = require('./db');

function pay(userId, theCart) {
  const user = accounts.byId(userId);
  if (!user) throw new Error('not logged in');
  const s = cart.summary(theCart);
  const order = { id: db.orders.length + 1, userId, total: s.total, items: s.items };
  db.orders.push(order);
  return order;
}

module.exports = { pay };
