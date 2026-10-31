'use strict';

const fs = require('node:fs');
const path = require('node:path');

// every file in routes/ registers itself; nothing lists them by name
const routes = {};
for (const name of fs.readdirSync(path.join(__dirname, 'routes'))) {
  const route = require(path.join(__dirname, 'routes', name));
  routes[route.path] = route.handle;
}

function dispatch(url, req) {
  const handle = routes[url];
  if (!handle) return { status: 404 };
  return { status: 200, body: handle(req) };
}

module.exports = { dispatch, routes };
