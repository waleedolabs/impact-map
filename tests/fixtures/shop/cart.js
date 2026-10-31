'use strict';

const products = require('./products');
const prices = require('./prices');

function add(cart, id) {
  const p = products.get(id);
  if (!p) throw new Error('unknown product ' + id);
  const line = cart.find((l) => l.id === id);
  if (line) line.qty += 1;
  else cart.push({ id, name: p.name, price: p.price, qty: 1 });
  return cart;
}

function summary(cart) {
  return { items: cart, total: prices.total(cart) };
}

module.exports = { add, summary };
