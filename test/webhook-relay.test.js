const test = require('node:test');
const assert = require('node:assert/strict');
const { esEventoV2, reenviarEventoV2 } = require('../webhook-relay');

const stripe = {
  subscriptions: {
    retrieve: async (id) => ({ id, metadata: { origen: id === 'sub_v2' ? 'agroclub-mx-v2' : 'anterior' } }),
  },
};

test('distingue el checkout v2 del portal anterior', async () => {
  const base = { type: 'checkout.session.completed', data: { object: { mode: 'subscription', metadata: { origen: 'agroclub-mx-v2' } } } };
  assert.equal(await esEventoV2(base, stripe), true);
  assert.equal(await esEventoV2({ ...base, data: { object: { mode: 'subscription', metadata: {} } } }, stripe), false);
});

test('distingue cambios de suscripción e invoices por origen', async () => {
  assert.equal(await esEventoV2({ type: 'customer.subscription.updated', data: { object: { metadata: { origen: 'agroclub-mx-v2' } } } }, stripe), true);
  assert.equal(await esEventoV2({ type: 'customer.subscription.deleted', data: { object: { metadata: {} } } }, stripe), false);
  const factura = (id) => ({ type: 'invoice.payment_failed', data: { object: { parent: { subscription_details: { subscription: id } } } } });
  assert.equal(await esEventoV2(factura('sub_v2'), stripe), true);
  assert.equal(await esEventoV2(factura('sub_anterior'), stripe), false);
});

test('reenvía el cuerpo original y la firma, y no confirma fallos', async () => {
  const body = Buffer.from('{"id":"evt_1"}');
  let recibido;
  const fetchOk = async (url, init) => { recibido = { url: url.href, init }; return { ok: true, status: 200 }; };
  await reenviarEventoV2(body, 't=123,v1=firma', 'https://agroclub-api-v2-production.up.railway.app/stripe/webhook', fetchOk);
  assert.equal(recibido.url, 'https://agroclub-api-v2-production.up.railway.app/stripe/webhook');
  assert.equal(recibido.init.body, body);
  assert.equal(recibido.init.headers['stripe-signature'], 't=123,v1=firma');
  await assert.rejects(reenviarEventoV2(body, 'firma', 'https://agroclub-api-v2-production.up.railway.app/stripe/webhook', async () => ({ ok: false, status: 503 })), /503/);
  await assert.rejects(reenviarEventoV2(body, 'firma', '', fetchOk), /AGROCLUB_V2_WEBHOOK_URL/);
  await assert.rejects(reenviarEventoV2(body, 'firma', 'https://otra-marca.example/stripe/webhook', fetchOk), /inválido/);
});
