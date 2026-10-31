'use strict';

const cart = require('../cart');

module.exports = { path: '/cart', handle: (req) => cart.summary(req.cart) };
