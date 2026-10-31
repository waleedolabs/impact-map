'use strict';

const db = require('./db');

function login(email, password) {
  const u = db.users.find((x) => x.email === email && x.password === password);
  return u ? { id: u.id, email: u.email } : null;
}

function byId(id) {
  const u = db.users.find((x) => x.id === id);
  return u ? { id: u.id, email: u.email } : null;
}

module.exports = { login, byId };
