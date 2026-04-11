# AgroClub MX — Webhook Server

Servidor que escucha pagos de Shopify y activa automáticamente a los miembros en Firebase.

## Variables de entorno necesarias en Railway:

- `FIREBASE_SERVICE_ACCOUNT` — JSON de la cuenta de servicio de Firebase
- `SHOPIFY_WEBHOOK_SECRET` — Secret del webhook de Shopify
- `PORT` — Puerto (Railway lo asigna automáticamente)

## Endpoint:
- `POST /webhook/shopify` — Recibe pagos de Shopify
