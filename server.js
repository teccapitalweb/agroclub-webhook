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

    const email = order.email;
    const nombre = order.billing_address?.first_name + ' ' + (order.billing_address?.last_name || '');
    const whatsapp = order.billing_address?.phone || '';

    // Determine plan from line items
    const lineItem = order.line_items?.[0];
    const productTitle = lineItem?.title?.toLowerCase() || '';
    const plan = productTitle.includes('anual') ? 'VIP Anual' : 'VIP Mensual';

    // Calculate expiry date
    const vence = new Date();
    if (plan === 'VIP Anual') {
      vence.setFullYear(vence.getFullYear() + 1);
    } else {
      vence.setMonth(vence.getMonth() + 1);
    }
    const venceStr = vence.toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });

    // Check if user exists in Firebase Auth
    let uid;
    try {
      const user = await auth.getUserByEmail(email);
      uid = user.uid;
      console.log('User exists:', uid);
    } catch (e) {
      // User doesn't exist - create with temp password
      const tempPassword = Math.random().toString(36).slice(-8) + 'Ag1!';
      const newUser = await auth.createUser({ email, password: tempPassword, displayName: nombre.trim() });
      uid = newUser.uid;
      console.log('User created:', uid);
    }

    // Save/update member in Firestore
    await db.collection('miembros').doc(uid).set({
      nombre: nombre.trim(),
      email,
      whatsapp,
      plan,
      estado: 'activo',
      vence: venceStr,
      fechaRegistro: new Date().toISOString(),
      shopifyOrderId: String(order.id),
      ultimoPago: new Date().toISOString()
    }, { merge: true });

    console.log('Member activated:', email, plan);
    res.status(200).json({ success: true, message: 'Member activated' });

  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AgroClub Webhook running on port ${PORT}`));
