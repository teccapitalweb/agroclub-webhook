const test = require('node:test');
const assert = require('node:assert/strict');
const { puedeCancelar } = require('../cancel-auth');

test('un correo sin autenticar o distinto no cancela la suscripción', () => {
  assert.equal(puedeCancelar(null, 'paga@example.com', 'uid-paga', {}), false);
  assert.equal(puedeCancelar({ uid: 'uid-otro', email: 'otro@example.com', email_verified: true }, 'paga@example.com', 'uid-paga', {}), false);
});

test('el dueño por UID conserva el autoservicio y el legado exige correo verificado', () => {
  const cuenta = { uid: 'uid-paga', email: 'paga@example.com', email_verified: false };
  assert.equal(puedeCancelar(cuenta, 'paga@example.com', 'uid-paga', {}), true);
  assert.equal(puedeCancelar(cuenta, 'paga@example.com', 'doc-antiguo', { uid: 'uid-paga' }), true);
  assert.equal(puedeCancelar(cuenta, 'paga@example.com', 'doc-antiguo', {}), false);
  assert.equal(puedeCancelar({ ...cuenta, email_verified: true }, 'paga@example.com', 'doc-antiguo', {}), true);
});
