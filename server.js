const express = require('express');
const crypto = require('crypto');
const admin = require('firebase-admin');

const app = express();

// Firebase Admin init
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();
const auth = admin.auth();

// Raw body for Shopify signature verification
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── Helper: verificar firma Shopify ─────────────────────────────────────────
function verificarFirma(req) {
  const hmac   = req.headers['x-shopify-hmac-sha256'];
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  const hash   = crypto.createHmac('sha256', secret).update(req.body).digest('base64');
  return hash === hmac;
}

// ── Helper: buscar miembro por email ────────────────────────────────────────
async function buscarMiembroPorEmail(email) {
  // Primero por UID de Auth
  try {
    const user = await auth.getUserByEmail(email);
    const doc  = await db.collection('miembros').doc(user.uid).get();
    if (doc.exists) return { uid: user.uid, ref: doc.ref };
  } catch (e) {}

  // Fallback: buscar por campo email en la colección
  const snap = await db.collection('miembros').where('email', '==', email).limit(1).get();
  if (!snap.empty) {
    const doc = snap.docs[0];
    return { uid: doc.id, ref: doc.ref };
  }
  return null;
}

// Health check
app.get('/', (req, res) => res.json({ status: 'AgroClub Webhook OK 🌱' }));

// ══════════════════════════════════════════════════════════════════════════════
// PAGO RECIBIDO — activar membresía
// ══════════════════════════════════════════════════════════════════════════════
app.post('/webhook/shopify', async (req, res) => {
  try {
    if (!verificarFirma(req)) {
      console.log('Firma inválida - orders/paid');
      return res.status(401).send('Unauthorized');
    }

    const order = JSON.parse(req.body.toString());
    console.log('Pago recibido:', order.id, order.email);

    const email = order.email?.toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'No email in order' });

    const firstName = order.billing_address?.first_name || order.customer?.first_name || email.split('@')[0];
    const lastName  = order.billing_address?.last_name  || order.customer?.last_name  || '';
    const nombre    = (firstName + ' ' + lastName).trim();
    const whatsapp  = order.billing_address?.phone || order.customer?.phone || '';

    const productTitle = order.line_items?.[0]?.title?.toLowerCase() || '';
    const plan = productTitle.includes('anual') ? 'VIP Anual' : 'VIP Mensual';

    const vence = new Date();
    plan === 'VIP Anual' ? vence.setFullYear(vence.getFullYear() + 1) : vence.setMonth(vence.getMonth() + 1);
    const venceStr = vence.toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });

    let uid;
    let usuarioNuevo = false;

    try {
      const user = await auth.getUserByEmail(email);
      uid = user.uid;
      console.log('Usuario existe:', uid);
    } catch (e) {
      usuarioNuevo = true;
      console.log('Usuario no existe, guardando pago pendiente');
    }

    if (usuarioNuevo) {
      await db.collection('pagos_pendientes').doc(email).set({
        email, nombre, whatsapp, plan, vence: venceStr,
        shopifyOrderId: String(order.id),
        fechaPago: new Date().toISOString()
      });
    } else {
      await db.collection('miembros').doc(uid).set({
        nombre, email, whatsapp, plan,
        estado: 'activo',
        vence: venceStr,
        fechaRegistro: new Date().toISOString(),
        shopifyOrderId: String(order.id),
        ultimoPago: new Date().toISOString()
      }, { merge: true });

      // Registrar pago en colección pagos
      const monto = order.total_price
        ? '$' + parseFloat(order.total_price).toFixed(2) + ' ' + (order.currency || 'MXN')
        : '—';
      await db.collection('pagos').add({
        nombre, email, plan, monto,
        shopifyOrderId: String(order.id),
        fecha: new Date().toISOString(),
        estado: 'confirmado'
      });

      console.log('Miembro activado y pago registrado:', email, plan);
    }

    res.status(200).json({ success: true });

  } catch (err) {
    console.error('Error en pago:', err);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// CANCELACIÓN — desactivar membresía
// ══════════════════════════════════════════════════════════════════════════════
app.post('/webhook/shopify/cancelacion', async (req, res) => {
  try {
    if (!verificarFirma(req)) {
      console.log('Firma inválida - cancelación');
      return res.status(401).send('Unauthorized');
    }

    const data  = JSON.parse(req.body.toString());
    const email = (data.email || data.customer?.email)?.toLowerCase().trim();
    console.log('Cancelación recibida para:', email);

    if (!email) return res.status(400).json({ error: 'No email en cancelación' });

    const miembro = await buscarMiembroPorEmail(email);

    if (!miembro) {
      console.log('Miembro no encontrado para cancelación:', email);
      return res.status(200).json({ message: 'Miembro no encontrado, nada que cancelar' });
    }

    await miembro.ref.update({
      estado: 'inactivo',
      canceladoEn: new Date().toISOString()
    });

    console.log('Membresía cancelada:', email);
    res.status(200).json({ success: true, message: 'Membresía cancelada' });

  } catch (err) {
    console.error('Error en cancelación:', err);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// CANCELACIÓN DIRECTA — llamada desde el frontend del panel VIP
// ══════════════════════════════════════════════════════════════════════════════
app.post('/cancelar-membresia', async (req, res) => {
  // CORS para GitHub Pages
  res.setHeader('Access-Control-Allow-Origin', 'https://teccapitalweb.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requerido' });

    console.log('Cancelación directa solicitada por:', email);

    const miembro = await buscarMiembroPorEmail(email.toLowerCase().trim());

    if (!miembro) {
      return res.status(404).json({ error: 'Miembro no encontrado' });
    }

    await miembro.ref.update({
      estado: 'inactivo',
      canceladoEn: new Date().toISOString()
    });

    console.log('Membresía cancelada directamente:', email);
    res.status(200).json({ success: true });

  } catch (err) {
    console.error('Error en cancelación directa:', err);
    res.status(500).json({ error: err.message });
  }
});

// OPTIONS preflight para CORS
app.options('/cancelar-membresia', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://teccapitalweb.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AgroClub Webhook running on port ${PORT}`));
