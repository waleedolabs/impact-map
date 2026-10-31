'use strict';

const checkout = require('../checkout');

module.exports = { path: '/checkout', handle: (req) => checkout.run(req.userId, req.cart) };
