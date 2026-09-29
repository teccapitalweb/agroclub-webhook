// Conservar el webhook histórico y reenviar únicamente los pagos del checkout v2.
const ORIGEN_V2 = 'agroclub-mx-v2';

async function esEventoV2(event, stripe) {
  const obj = event.data?.object || {};
  if (event.type === 'checkout.session.completed') {
    return obj.mode === 'subscription' && obj.metadata?.origen === ORIGEN_V2;
  }
  if (event.type.startsWith('customer.subscription.')) {
    return obj.metadata?.origen === ORIGEN_V2;
  }
  if (['invoice.paid', 'invoice.payment_succeeded', 'invoice.payment_failed'].includes(event.type)) {
    const candidato = obj.parent?.subscription_details?.subscription || obj.subscription;
    const id = typeof candidato === 'string' ? candidato : candidato?.id;
    if (!id) return false;
    const sub = await stripe.subscriptions.retrieve(id);
    return sub.metadata?.origen === ORIGEN_V2;
  }
  return false;
}

async function reenviarEventoV2(body, signature, destination, fetchImpl = fetch) {
  if (!Buffer.isBuffer(body) || !signature) throw new Error('Falta el cuerpo original o la firma de Stripe');
  if (!destination) throw new Error('Falta AGROCLUB_V2_WEBHOOK_URL');
  const url = new URL(destination);
  if (url.protocol !== 'https:' || url.hostname !== 'agroclub-api-v2-production.up.railway.app' ||
      url.pathname !== '/stripe/webhook' || url.search || url.hash) {
    throw new Error('Destino del webhook v2 inválido');
  }
  const respuesta = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    body,
    signal: AbortSignal.timeout(8000),
  });
  if (!respuesta.ok) throw new Error(`El webhook v2 respondió ${respuesta.status}`);
}

module.exports = { esEventoV2, reenviarEventoV2 };
