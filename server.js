const express = require('express');
const admin = require('firebase-admin');
const Stripe = require('stripe');
const crypto = require('crypto');
const bunnyCatalog = require('./data/agrotec-bunny-catalog.json');

const app = express();

// ─── Firebase Admin init ─────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();
const auth = admin.auth();

// ─── Stripe init ─────────────────────────────────────────────────────────────
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Price IDs (en variables de entorno para poder cambiar sin tocar código)
const PRICE_MENSUAL = process.env.STRIPE_PRICE_MENSUAL || 'price_1TPb9nPBgqsOPfUYOzCZpX42';
const PRICE_ANUAL   = process.env.STRIPE_PRICE_ANUAL   || 'price_1TPbCQPBgqsOPfUYZhUk9OGQ';

// Bunny Stream (la clave de API NO se usa para reproducir; solo la Token authentication key)
const BUNNY_STREAM_LIBRARY_ID = String(process.env.BUNNY_STREAM_LIBRARY_ID || '730478').trim();
const BUNNY_TOKEN_AUTH_KEY = String(process.env.BUNNY_TOKEN_AUTH_KEY || '').trim();
const BUNNY_TOKEN_TTL_SECONDS = Math.min(900, Math.max(60, Number(process.env.BUNNY_TOKEN_TTL_SECONDS) || 300));
const BUNNY_VIDEO_IDS = new Set(
  bunnyCatalog.flatMap(curso => (curso.clases || []).map(clase => String(clase.videoId || '').trim())).filter(Boolean)
);

// ─── CORS global ─────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, stripe-signature');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── Raw body para Stripe (DEBE ir antes de express.json) ────────────────────
app.use('/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ─── Helper: buscar miembro por email ────────────────────────────────────────
async function buscarMiembroPorEmail(email) {
  try {
    const user = await auth.getUserByEmail(email);
    const doc  = await db.collection('miembros').doc(user.uid).get();
    if (doc.exists) return { uid: user.uid, ref: doc.ref, userExists: true };
    return { uid: user.uid, ref: db.collection('miembros').doc(user.uid), userExists: true };
  } catch (e) {}

  const snap = await db.collection('miembros').where('email', '==', email).limit(1).get();
  if (!snap.empty) {
    const doc = snap.docs[0];
    return { uid: doc.id, ref: doc.ref, userExists: false };
  }
  return null;
}

// Health check
app.get('/', (req, res) => res.json({ status: 'AgroClub Webhook OK 🌱', stripe: true }));

function fechaVigente(valor) {
  if (!valor) return false;
  if (typeof valor.toDate === 'function') return valor.toDate() > new Date();
  var directa = new Date(valor);
  if (!Number.isNaN(directa.getTime())) return directa > new Date();
  var meses = { enero:0, febrero:1, marzo:2, abril:3, mayo:4, junio:5, julio:6, agosto:7, septiembre:8, octubre:9, noviembre:10, diciembre:11 };
  var texto = String(valor).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  var match = texto.match(/(\d+)\s+de\s+([a-z]+)\s+de\s+(\d{4})/);
  if (!match || meses[match[2]] === undefined) return false;
  return new Date(Number(match[3]), meses[match[2]], Number(match[1]), 23, 59, 59) > new Date();
}

async function obtenerMembresia(uid, email) {
  const directa = await db.collection('miembros').doc(uid).get();
  if (directa.exists) return directa.data();
  if (!email) return null;
  const snap = await db.collection('miembros').where('email', '==', email.toLowerCase().trim()).limit(1).get();
  return snap.empty ? null : snap.docs[0].data();
}

// ── Clase muestra gratis (lógica ICADEM): la primera clase del primer curso
//    se puede reproducir sin membresía. Mismo criterio que el frontend:
//    curso con menor `orden` (sin orden = al final) y su clase con menor `num`.
let _muestraCache = { videoId: null, ts: 0 };
async function obtenerVideoMuestraGratis() {
  if (_muestraCache.ts && (Date.now() - _muestraCache.ts) < 5 * 60 * 1000) return _muestraCache.videoId;
  try {
    const snap = await db.collection('cursos').get();
    const cursos = snap.docs.map(d => d.data())
      .filter(c => Array.isArray(c.clases) && c.clases.length && c.activo !== false)
      .sort((a, b) => (Number(a.orden) || 9999) - (Number(b.orden) || 9999));
    let videoId = null;
    if (cursos.length) {
      const clases = cursos[0].clases.slice().sort((a, b) => (Number(a.num) || 9999) - (Number(b.num) || 9999));
      videoId = clases[0] && clases[0].videoId ? String(clases[0].videoId) : null;
    }
    _muestraCache = { videoId, ts: Date.now() };
    return videoId;
  } catch (e) {
    console.error('❌ obtenerVideoMuestraGratis:', e.message);
    return null;
  }
}

// Devuelve una URL efímera; nunca expone la clave privada de Bunny al navegador.
app.post('/api/bunny/embed-token', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!BUNNY_STREAM_LIBRARY_ID || !BUNNY_TOKEN_AUTH_KEY) {
      return res.status(503).json({ error: 'Bunny Stream no está configurado en Railway' });
    }

    const videoId = String(req.body?.videoId || '').trim();
    if (!videoId || !BUNNY_VIDEO_IDS.has(videoId)) {
      return res.status(404).json({ error: 'Video no autorizado o inexistente' });
    }

    const authorization = String(req.headers.authorization || '');
    if (!authorization.startsWith('Bearer ')) return res.status(401).json({ error: 'Sesión requerida' });
    const decoded = await auth.verifyIdToken(authorization.slice(7));

    const adminDoc = await db.collection('admins').doc(decoded.uid).get();
    const membresia = adminDoc.exists ? { estado:'activo' } : await obtenerMembresia(decoded.uid, decoded.email || '');
    const tieneAcceso = membresia && (
      membresia.estado === 'activo' || membresia.esVIP === true || membresia.activo === true ||
      membresia.activa === true || fechaVigente(membresia.vence)
    );
    if (!tieneAcceso) {
      const videoGratis = await obtenerVideoMuestraGratis();
      if (!videoGratis || videoGratis !== videoId) {
        return res.status(403).json({ error: 'Membresía VIP requerida' });
      }
      // Clase muestra gratis: se permite reproducir sin membresía (lógica ICADEM)
    }

    const expires = Math.floor(Date.now() / 1000) + BUNNY_TOKEN_TTL_SECONDS;
    const token = crypto.createHash('sha256').update(BUNNY_TOKEN_AUTH_KEY + videoId + expires).digest('hex');
    const embedUrl = `https://iframe.mediadelivery.net/embed/${encodeURIComponent(BUNNY_STREAM_LIBRARY_ID)}/${encodeURIComponent(videoId)}?token=${token}&expires=${expires}`;
    return res.json({ embedUrl, expires });
  } catch (error) {
    if (error && String(error.code || '').startsWith('auth/')) return res.status(401).json({ error: 'Sesión inválida o vencida' });
    console.error('❌ Bunny embed-token:', error);
    return res.status(500).json({ error: 'No se pudo preparar el reproductor' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 1) CREAR CHECKOUT SESSION — Stripe Embedded
// El frontend llama aquí y recibe un clientSecret que monta el formulario
// ═════════════════════════════════════════════════════════════════════════════
app.post('/crear-checkout', async (req, res) => {
  try {
    const { plan, email, uid, nombre, whatsapp } = req.body;

    if (!email) return res.status(400).json({ error: 'Email requerido' });
    if (!plan || !['mensual', 'anual'].includes(plan)) {
      return res.status(400).json({ error: 'Plan inválido (mensual|anual)' });
    }

    const priceId = plan === 'anual' ? PRICE_ANUAL : PRICE_MENSUAL;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      ui_mode: 'embedded',
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email,
      allow_promotion_codes: true,
      metadata: {
        uid: uid || '',
        nombre: nombre || '',
        whatsapp: whatsapp || '',
        plan
      },
      subscription_data: {
        metadata: {
          uid: uid || '',
          email,
          nombre: nombre || '',
          whatsapp: whatsapp || '',
          plan
        }
      },
      return_url: `https://teccapitalweb.github.io/AgroClub---mx/index.html?pago_exitoso=1&session_id={CHECKOUT_SESSION_ID}`
    });

    console.log('✅ Checkout session creada:', session.id, 'para', email);
    res.json({ clientSecret: session.client_secret });

  } catch (err) {
    console.error('❌ Error crear-checkout:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 2) VERIFICAR SESSION — el frontend puede preguntar el estado después de pagar
// ═════════════════════════════════════════════════════════════════════════════
app.get('/verificar-session/:sessionId', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
    res.json({
      status: session.status,
      payment_status: session.payment_status,
      customer_email: session.customer_email
    });
  } catch (err) {
    console.error('❌ Error verificar-session:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 3) WEBHOOK STRIPE — recibe eventos y actualiza Firestore
// ═════════════════════════════════════════════════════════════════════════════
app.post('/stripe-webhook', async (req, res) => {
  let event;
  const sig = req.headers['stripe-signature'];

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('❌ Firma Stripe inválida:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('📩 Evento Stripe:', event.type);

  try {
    switch (event.type) {

      // ─── Pago exitoso — ACTIVAR membresía ─────────────────────────────────
      case 'checkout.session.completed': {
        const session = event.data.object;
        const email = (session.customer_email || session.customer_details?.email || '').toLowerCase().trim();
        const nombre = session.metadata?.nombre || session.customer_details?.name || email.split('@')[0];
        // ═══ FIX: WhatsApp desde múltiples fuentes ═══
        // Prioridad: 1) metadata (mandado por el frontend) → 2) usuarios_free → 3) Stripe phone
        let whatsapp = session.metadata?.whatsapp || '';
        const planKey = session.metadata?.plan || 'mensual';
        const plan = planKey === 'anual' ? 'VIP Anual' : 'VIP Mensual';

        if (!email) {
          console.warn('⚠️ Sin email en session');
          return res.status(200).json({ received: true });
        }

        const vence = new Date();
        plan === 'VIP Anual' ? vence.setFullYear(vence.getFullYear() + 1) : vence.setMonth(vence.getMonth() + 1);
        const venceStr = vence.toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });

        let uid = session.metadata?.uid || null;

        if (!uid) {
          try {
            const user = await auth.getUserByEmail(email);
            uid = user.uid;
            console.log(`✅ UID recuperado de Firebase Auth: ${uid}`);
          } catch (e) {
            console.warn(`⚠️ Usuario no existe en Firebase Auth para email: ${email}. Intentando crearlo automáticamente...`);
            try {
              const newUser = await auth.createUser({
                email: email,
                displayName: nombre || email.split('@')[0],
                emailVerified: true
              });
              uid = newUser.uid;
              console.log(`✅ Usuario creado automáticamente en Firebase Auth: ${uid}`);
            } catch (createError) {
              console.error(`❌ No se pudo crear usuario Auth: ${createError.message}`);
            }
          }
        }

        // ═══ FIX: Si aún no tenemos WhatsApp, buscar en usuarios_free ═══
        if (!whatsapp && uid) {
          try {
            const freeDoc = await db.collection('usuarios_free').doc(uid).get();
            if (freeDoc.exists) {
              const freeData = freeDoc.data();
              if (freeData.whatsapp) {
                whatsapp = freeData.whatsapp;
                console.log('📱 WhatsApp recuperado de usuarios_free:', whatsapp);
              }
            }
          } catch (e) {
            console.warn('⚠️ No se pudo leer usuarios_free:', e.message);
          }
        }

        // Último fallback: el phone que Stripe pudo haber capturado
        if (!whatsapp) {
          whatsapp = session.customer_details?.phone || '';
        }

        const docId = uid || email;
        if (docId) {
          console.log(`📝 Escribiendo en miembros/${docId} (uid: ${uid ? 'sí' : 'NO - usando email'})`);
          await db.collection('miembros').doc(docId).set({
            nombre,
            email,
            whatsapp,
            plan,
            estado: 'activo',
            vence: venceStr,
            fechaRegistro: new Date().toISOString(),
            stripeCustomerId: session.customer,
            stripeSubscriptionId: session.subscription,
            ultimoPago: new Date().toISOString(),
            uid: uid || null,
          }, { merge: true });

            const monto = session.amount_total
              ? (session.amount_total / 100).toFixed(2) + ' ' + (session.currency || 'MXN').toUpperCase()
              : '—';

            await db.collection('pagos').add({
              nombre, email, plan, monto,
              stripeSessionId: session.id,
              stripeSubscriptionId: session.subscription,
              fecha: new Date().toISOString(),
              estado: 'confirmado'
            });

            console.log(`✅ Miembro activado: ${email} | Plan: ${plan} | Vence: ${venceStr}`);
          } else {
            console.error(`❌ CRÍTICO: Sin uid ni email para crear documento. Metadata: ${JSON.stringify(session.metadata)}`);
          }
          break;
        }

      // ─── Suscripción actualizada (ej. renovación automática) ──────────────
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const email = (sub.metadata?.email || '').toLowerCase().trim();

        if (email) {
          const m = await buscarMiembroPorEmail(email);
          if (m && m.userExists) {
            const nuevoEstado = sub.status === 'active' || sub.status === 'trialing' ? 'activo' : 'inactivo';

            const vence = new Date(sub.current_period_end * 1000);
            const venceStr = vence.toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });

            await m.ref.update({
              estado: nuevoEstado,
              vence: venceStr,
              stripeSubscriptionId: sub.id
            });
            console.log(`🔁 Suscripción actualizada: ${email} → ${nuevoEstado}`);
          }
        }
        break;
      }

      // ─── Suscripción cancelada ────────────────────────────────────────────
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const email = (sub.metadata?.email || '').toLowerCase().trim();

        if (email) {
          const m = await buscarMiembroPorEmail(email);
          if (m && m.userExists) {
            await m.ref.update({
              estado: 'inactivo',
              canceladoEn: new Date().toISOString()
            });
            console.log('🛑 Membresía cancelada (Stripe):', email);
          }
        }
        break;
      }

      default:
        console.log('ℹ️ Evento sin handler:', event.type);
    }

    res.status(200).json({ received: true });

  } catch (err) {
    console.error('❌ Error procesando webhook:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 4) CANCELACIÓN DIRECTA — llamada desde el panel VIP del portal
// ═════════════════════════════════════════════════════════════════════════════
app.post('/cancelar-membresia', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requerido' });

    const emailLower = email.toLowerCase().trim();
    console.log('🛑 Cancelación solicitada por:', emailLower);

    const miembro = await buscarMiembroPorEmail(emailLower);
    if (!miembro) return res.status(404).json({ error: 'Miembro no encontrado' });

    // Cancelar suscripción en Stripe si existe
    const doc = await miembro.ref.get();
    const subId = doc.data()?.stripeSubscriptionId;
    if (subId) {
      try {
        await stripe.subscriptions.cancel(subId);
        console.log('✅ Stripe subscription cancelled:', subId);
      } catch (e) {
        console.warn('⚠️ No se pudo cancelar en Stripe (tal vez ya estaba cancelada):', e.message);
      }
    }

    await miembro.ref.update({
      estado: 'inactivo',
      canceladoEn: new Date().toISOString()
    });

    res.status(200).json({ success: true });

  } catch (err) {
    console.error('❌ Error cancelar-membresia:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 AgroClub Webhook (Stripe) running on port ${PORT}`);
  console.log(`🐰 Bunny Stream: ${BUNNY_VIDEO_IDS.size} videos autorizados · POST /api/bunny/embed-token`);
});
