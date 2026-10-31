'use strict';

const products = require('../products');

module.exports = { path: '/products', handle: () => products.list() };
