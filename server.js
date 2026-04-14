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

// Health check
app.get('/', (req, res) => res.json({ status: 'AgroClub Webhook OK 🌱' }));

// Shopify webhook - order paid
app.post('/webhook/shopify', async (req, res) => {
  try {
    // Verify Shopify signature
    const hmac = req.headers['x-shopify-hmac-sha256'];
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
    const hash = crypto
      .createHmac('sha256', secret)
      .update(req.body)
      .digest('base64');

    if (hash !== hmac) {
      console.log('Invalid Shopify signature');
      return res.status(401).send('Unauthorized');
    }

    const order = JSON.parse(req.body.toString());
    console.log('Order received:', order.id, order.email);

    const email = order.email?.toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'No email in order' });

    // Nombre: billing_address primero, luego customer, luego email
    const firstName = order.billing_address?.first_name
      || order.customer?.first_name
      || email.split('@')[0];
    const lastName = order.billing_address?.last_name
      || order.customer?.last_name
      || '';
    const nombre = (firstName + ' ' + lastName).trim();
    const whatsapp = order.billing_address?.phone
      || order.customer?.phone
      || '';

    // Plan desde line items
    const lineItem = order.line_items?.[0];
    const productTitle = lineItem?.title?.toLowerCase() || '';
    const plan = productTitle.includes('anual') ? 'VIP Anual' : 'VIP Mensual';

    // Fecha de vencimiento
    const vence = new Date();
    if (plan === 'VIP Anual') {
      vence.setFullYear(vence.getFullYear() + 1);
    } else {
      vence.setMonth(vence.getMonth() + 1);
    }
    const venceStr = vence.toLocaleDateString('es-MX', {
      day: 'numeric', month: 'long', year: 'numeric'
    });

    // Buscar si el usuario ya existe en Firebase Auth
    let uid;
    let usuarioNuevo = false;

    try {
      const user = await auth.getUserByEmail(email);
      uid = user.uid;
      console.log('Usuario ya existe en Auth:', uid);
      // NO tocamos la contraseña — el usuario ya la tiene
    } catch (e) {
      // No existe — NO creamos cuenta aquí
      // Solo guardamos en Firestore con estado pendiente_registro
      // El usuario creará su cuenta desde la página de ventas
      console.log('Usuario no existe en Auth, guardando como pendiente_registro');
      usuarioNuevo = true;
    }

    if (usuarioNuevo) {
      // Guardar por email como documento temporal
      // Se activará cuando el usuario cree su cuenta
      await db.collection('pagos_pendientes').doc(email).set({
        email,
        nombre,
        whatsapp,
        plan,
        vence: venceStr,
        shopifyOrderId: String(order.id),
        fechaPago: new Date().toISOString()
      });
      console.log('Pago pendiente guardado para:', email);
    } else {
      // Usuario ya existe — activar directamente en miembros
      await db.collection('miembros').doc(uid).set({
        nombre,
        email,
        whatsapp,
        plan,
        estado: 'activo',
        vence: venceStr,
        fechaRegistro: new Date().toISOString(),
        shopifyOrderId: String(order.id),
        ultimoPago: new Date().toISOString()
      }, { merge: true });
      console.log('Miembro activado:', email, plan);
    }

    res.status(200).json({ success: true, message: usuarioNuevo ? 'Pago guardado, esperando registro' : 'Miembro activado' });

  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AgroClub Webhook running on port ${PORT}`));
