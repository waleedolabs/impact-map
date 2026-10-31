'use strict';

const test = require('node:test');
const assert = require('node:assert');

const products = require('../products');
const accounts = require('../accounts');
const cart = require('../cart');
const checkout = require('../checkout');
const server = require('../server');

test('products are listed with a formatted price', () => {
  assert.strictEqual(products.list()[0].label, '12.00 USD');
});

test('login accepts the right password only', () => {
  assert.ok(accounts.login('sara@example.com', 'secret'));
  assert.strictEqual(accounts.login('sara@example.com', 'nope'), null);
});

test('cart totals add up', () => {
  const c = [];
  cart.add(c, 'esp');
  cart.add(c, 'esp');
  cart.add(c, 'tur');
  assert.strictEqual(cart.summary(c).total, 33);
});

test('checkout creates an order and a confirmation mail', () => {
  const c = cart.add([], 'tur');
  const r = checkout.run(1, c);
  assert.strictEqual(r.order.total, 9);
  assert.match(r.mail, /sara@example.com/);
  assert.match(r.mail, /9.00 USD/);
});

test('the server answers on /products and 404s elsewhere', () => {
  assert.strictEqual(server.dispatch('/products', {}).status, 200);
  assert.strictEqual(server.dispatch('/nothing', {}).status, 404);
});
