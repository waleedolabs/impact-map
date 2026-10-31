'use strict';

const db = require('./db');
const prices = require('./prices');

function list() {
  return db.products.map((p) => ({ id: p.id, name: p.name, label: prices.format(p.price) }));
}

function get(id) {
  return db.products.find((p) => p.id === id) || null;
}

module.exports = { list, get };
