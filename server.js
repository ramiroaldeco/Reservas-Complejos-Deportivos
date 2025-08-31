// ---- Cargas básicas
require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const fetch = require("node-fetch"); // para consultar el pago en el webhook y notificaciones
const { MercadoPagoConfig, Preference } = require("mercadopago");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir tus HTML/JS/CSS
app.use(express.static(__dirname));

// ---- Paths a archivos (se crean si no existen)
const pathDatos     = path.join(__dirname, "datos_complejos.json");
const pathReservas  = path.join(__dirname, "reservas.json");
const pathCreds     = path.join(__dirname, "credenciales_mp.json");
const pathIdx       = path.join(__dirname, "webhook_index.json"); // prefId -> clave

function leerJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { return {}; }
}
function escribirJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}
if (!fs.existsSync(pathDatos))    escribirJSON(pathDatos, {});
if (!fs.existsSync(pathReservas)) escribirJSON(pathReservas, {});
if (!fs.existsSync(pathCreds))    escribirJSON(pathCreds, {});
if (!fs.existsSync(pathIdx))      escribirJSON(pathIdx, {});

// ---- Config MP por complejo
function tokenPara(complejoId) {
  const cred = leerJSON(pathCreds);
  const c = cred[complejoId] || {};
  // 0) Token OAuth (nuevo): priorizarlo
  if (c.oauth && c.oauth.access_token) return c.oauth.access_token; // <--
  // 1) Token por complejo (onboarding manual)
  if (c.access_token) return c.access_token;
  if (c.mp_access_token) return c.mp_access_token;
  // 2) Token global .env
  if (process.env.MP_ACCESS_TOKEN) return process.env.MP_ACCESS_TOKEN;
  // 3) Si no hay, devolvemos cadena vacía (fallará con "invalid_token")
  return "";
}
function mpClient(complejoId) {
  return new MercadoPagoConfig({ access_token: tokenPara(complejoId) });
}

// ---- Anti doble-reserva: HOLD
const HOLD_MIN = parseInt(process.env.HOLD_MIN || "10", 10); // 10 min default

function estaHoldActiva(r) {
  return r && r.status === "hold" && r.holdUntil && Date.now() < r.holdUntil;
}
function limpiarHoldsVencidos() {
  const reservas = leerJSON(pathReservas);
  let cambio = false;
  for (const k of Object.keys(reservas)) {
    const r = reservas[k];
    if (r?.status === "hold" && r.holdUntil && Date.now() >= r.holdUntil) {
      // liberar
      delete reservas[k];
      cambio = true;
    }
  }
  if (cambio) escribirJSON(pathReservas, reservas);
}
setInterval(limpiarHoldsVencidos, 60 * 1000); // cada minuto

// =======================
// RUTAS EXISTENTES (no tocamos nombres)
// =======================

// Datos del complejo
app.get("/datos_complejos", (_req, res) => {
  res.json(leerJSON(pathDatos));
});

app.post("/guardarDatos", (req, res) => {
  // Guarda el JSON completo (usa onboarding y panel)
  escribirJSON(pathDatos, req.body);
  res.json({ ok: true });
});

// NUEVA: alta/actualización de credenciales de MP por complejo
app.post("/alta-credencial", (req, res) => {
  const { id, mp_access_token, access_token } = req.body || {};
  if (!id || !(mp_access_token || access_token)) {
    return res.status(400).json({ error: "Falta id o token" });
  }
  const cred = leerJSON(pathCreds);
  cred[id] = cred[id] || {};
  // normalizamos a 'access_token' (el server lo busca así)
  cred[id].access_token = access_token || mp_access_token;
  escribirJSON(pathCreds, cred);
  res.json({ ok: true });
});

// Reservas (objeto completo)
app.get("/reservas", (_req, res) => {
  res.json(leerJSON(pathReservas));
});

// Guardar UNA reserva directa (lo usa reservar-exito.html si querés mantenerlo)
app.post("/guardarReserva", (req, res) => {
  const { clave, nombre, telefono } = req.body;
  const reservas = leerJSON(pathReservas);
  if (reservas[clave]) return res.status(400).json({ error: "Turno ya reservado" });
  reservas[clave] = { nombre, telefono, status: "approved", paidAt: Date.now() };
  escribirJSON(pathReservas, reservas);
  res.json({ ok: true });
});

// Guardar TODAS las reservas (bloquear/cancelar desde micomplejo.html)
app.post("/guardarReservas", (req, res) => {
  escribirJSON(pathReservas, req.body || {});
  res.json({ ok: true });
});

// Login simple de dueño (slug + clave en datos_complejos.json)
app.post("/login", (req, res) => {
  const { complejo, password } = req.body || {};
  const datos = leerJSON(pathDatos);
  if (!datos[complejo]) return res.status(404).json({ error: "Complejo inexistente" });
  const ok = (datos[complejo].clave || "") === (password || "");
  if (!ok) return res.status(401).json({ error: "Contraseña incorrecta" });
  res.json({ ok: true });
});

// =======================
// Notificaciones opcionales (WhatsApp Cloud / Resend)
// =======================

async function enviarWhatsApp(complejoId, texto) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!token || !phoneId) return; // no configurado

  const datos = leerJSON(pathDatos);
  const para = (datos?.[complejoId]?.whatsappDueño) || process.env.ADMIN_WHATSAPP_TO;
  if (!para) return;

  const url = `https://graph.facebook.com/v20.0/${phoneId}/messages`;
  const body = {
    messaging_product: "whatsapp",
    to: String(para),
    type: "text",
    text: { body: texto }
  };
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
  } catch (e) {
    console.error("WhatsApp noti error:", e?.message || e);
  }
}

async function enviarEmail(complejoId, asunto, html) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!key || !from) return;

  const datos = leerJSON(pathDatos);
  const para = (datos?.[complejoId]?.emailDueño) || process.env.ADMIN_EMAIL;
  if (!para) return;

  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from,
        to: [para],
        subject: asunto,
        html
      })
    });
  } catch (e) {
    console.error("Email noti error:", e?.message || e);
  }
}

async function notificarAprobado({ clave, complejoId, nombre, telefono, monto }) {
  const texto = `✅ Nueva reserva confirmada
Complejo: ${complejoId}
Turno: ${clave}
Cliente: ${nombre} (${telefono})
Seña: $${monto}`;

  const html = `
    <h2>✅ Nueva reserva confirmada</h2>
    <p><strong>Complejo:</strong> ${complejoId}</p>
    <p><strong>Turno:</strong> ${clave}</p>
    <p><strong>Cliente:</strong> ${nombre} (${telefono})</p>
    <p><strong>Seña:</strong> $${monto}</p>
  `;

  await Promise.all([
    enviarWhatsApp(complejoId, texto),
    enviarEmail(complejoId, "Nueva reserva confirmada", html)
  ]);
}

// =======================
// PAGOS: crear preferencia + Webhook
// =======================

// Crea la preferencia y deja un HOLD sobre el turno
app.post("/crear-preferencia", async (req, res) => {
  const {
    complejoId,
    clave,
    titulo,
    precio,     // puede venir o no
    senia,      // puede venir o no
    nombre,
    telefono
  } = req.body || {};

  // Aceptar senia o precio indistintamente
  const monto = Number((precio ?? senia));
  if (!complejoId || !clave || !monto) {
    return res.status(400).json({ error: "Faltan datos" });
  }

  const reservas = leerJSON(pathReservas);

  // ¿ya reservado?
  const existente = reservas[clave];
  if (existente && (existente.status === "approved" || estaHoldActiva(existente))) {
    return res.status(409).json({ error: "El turno ya está tomado" });
  }

  // Crear HOLD temporal para bloquear el turno
  const holdUntil = Date.now() + HOLD_MIN * 60 * 1000;
  reservas[clave] = {
    status: "hold",
    holdUntil,
    nombre: nombre || "",
    telefono: telefono || "",
    complejoId,
    monto
  };
  escribirJSON(pathReservas, reservas);

  // Preferencia MP
  const token = tokenPara(complejoId);
  const mp = new MercadoPagoConfig({ access_token: token });
  const preference = new Preference(mp);

  // URLs de retorno y webhook
  const FRONT_URL  = process.env.PUBLIC_URL  || `https://ramiroaldeco.github.io/recomplejos-frontend`;
  const BACK_URL   = process.env.BACKEND_URL || `https://recomplejos-backend.onrender.com`;
  const success = `${FRONT_URL}/reservar-exito.html`;
  const pending = `${FRONT_URL}/reservar-pendiente.html`;
  const failure = `${FRONT_URL}/reservar-error.html`;

  try {
    const prefBody = {
      items: [
        { title: titulo || "Seña de reserva", unit_price: monto, quantity: 1 }
      ],
      back_urls: { success, pending, failure },
      auto_return: "approved",
      notification_url: `${BACK_URL}/webhook-mp`,
      metadata: { clave, complejoId }
    };

    const result = await preference.create({ body: prefBody });
    const pref = result?.id || result?.body?.id || result?.response?.id;

    // indexamos preference -> clave (para el webhook)
    const idx = leerJSON(pathIdx);
    idx[pref] = { clave, complejoId };
    escribirJSON(pathIdx, idx);

    // Guardamos datos en la reserva
    const r2 = leerJSON(pathReservas);
    if (r2[clave]) {
      r2[clave].status = "pending";
      r2[clave].preference_id = pref;
      r2[clave].init_point =
        result?.init_point ||
        result?.body?.init_point ||
        result?.response?.init_point || "";
      r2[clave].holdUntil = holdUntil;
      escribirJSON(pathReservas, r2);
    }

    return res.json({
      ok: true,
      preference_id: pref,
      init_point: r2[clave]?.init_point || null
    });
  } catch (err) {
    // si falló MP, liberamos el HOLD
    const rr = leerJSON(pathReservas);
    delete rr[clave];
    escribirJSON(pathReservas, rr);

    const info = err?.message || "Error creando preferencia";
    console.error("MP error:", info);
    return res.status(400).json({ error: info });
  }
});

// Webhook de Mercado Pago
app.post("/webhook-mp", async (req, res) => {
  try {
    // Aceptamos rápido para que MP no reintente de más
    res.sendStatus(200);

    // MP envía { action, data: { id }, type } o similar
    const body = req.body || {};
    const paymentId = body?.data?.id || body?.id;
    if (!paymentId) return;

    // Consultamos el pago para conocer status y preference_id
    // Probaremos con el token global y, si falla, con cada token de credenciales
    const tokensATestar = [];
    const cred = leerJSON(pathCreds);
    if (process.env.MP_ACCESS_TOKEN) tokensATestar.push(process.env.MP_ACCESS_TOKEN);
    for (const k of Object.keys(cred)) {
      if (cred[k]?.oauth?.access_token) tokensATestar.push(cred[k].oauth.access_token); // <-- OAuth primero
      if (cred[k]?.access_token)        tokensATestar.push(cred[k].access_token);
      if (cred[k]?.mp_access_token)     tokensATestar.push(cred[k].mp_access_token);
    }
    tokensATestar.push(""); // por si no hay nada

    let pago = null;
    for (const t of tokensATestar) {
      try {
        if (!t) continue;
        const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
          headers: { Authorization: `Bearer ${t}` }
        });
        if (r.ok) { pago = await r.json(); break; }
      } catch { /* seguimos probando */ }
    }
    if (!pago) return;

    const prefId = pago?.order?.id || pago?.preference_id || pago?.metadata?.preference_id;
    const status = pago?.status; // approved | pending | rejected | in_process | cancelled

    // Encontramos la reserva por metadata o por índice pref -> clave
    let clave = pago?.metadata?.clave;
    let complejoId = pago?.metadata?.complejoId;
    if ((!clave || !complejoId) && prefId) {
      const idx = leerJSON(pathIdx);
      clave = clave || idx[prefId]?.clave;
      complejoId = complejoId || idx[prefId]?.complejoId;
    }
    if (!clave) return;

    // Actualizamos la reserva
    const reservas = leerJSON(pathReservas);
    const r = reservas[clave] || {};
    r.preference_id = prefId || r.preference_id;
    r.payment_id = pago?.id || r.payment_id;

    if (status === "approved") {
      r.status = "approved";
      r.paidAt = Date.now();
      // Aseguramos datos útiles para notificación
      r.nombre = r.nombre || "";
      r.telefono = r.telefono || "";
      r.complejoId = r.complejoId || complejoId || "";
      // Notificar (no bloqueante)
      const infoNoti = {
        clave,
        complejoId: r.complejoId,
        nombre: r.nombre,
        telefono: r.telefono,
        monto: r.monto || r.precio || r.senia || ""
      };
      escribirJSON(pathReservas, { ...reservas, [clave]: r });
      notificarAprobado(infoNoti).catch(()=>{});
      // limpiar hold
      delete r.holdUntil;
    } else if (status === "rejected" || status === "cancelled") {
      // liberar el turno
      delete reservas[clave];
      escribirJSON(pathReservas, reservas);
      return;
    } else {
      r.status = "pending"; // in_process / pending
      escribirJSON(pathReservas, { ...reservas, [clave]: r });
      return;
    }

    // guardar final por si faltaba algo
    escribirJSON(pathReservas, { ...reservas, [clave]: r });
  } catch (e) {
    console.error("Error en webhook:", e?.message || e);
  }
});

// ===== OAuth Mercado Pago: callback / conectar / estado =====
// ⚠️ IMPORTANTE: dejá estas rutas ANTES de app.listen(...) y de cualquier middleware 404

// Helpers con nombres únicos para evitar colisiones
const CREDS_MP_PATH_OAUTH = path.join(__dirname, "credenciales_mp.json");
function leerCredsMP_OAUTH() {
  try { return JSON.parse(fs.readFileSync(CREDS_MP_PATH_OAUTH, "utf8")); }
  catch { return {}; }
}
function escribirCredsMP_OAUTH(obj) {
  fs.writeFileSync(CREDS_MP_PATH_OAUTH, JSON.stringify(obj, null, 2));
}

// Redirige al dueño a autorizar tu app (state = complejoId)
app.get("/mp/conectar", (req, res) => {
  const { complejoId } = req.query;
  if (!complejoId) return res.status(400).send("Falta complejoId");
  
  const u = new URL("https://auth.mercadopago.com/authorization");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", process.env.MP_CLIENT_ID);
  u.searchParams.set("redirect_uri", process.env.MP_REDIRECT_URI);
  u.searchParams.set("state", complejoId);
  u.searchParams.set("scope", "offline_access read write"); // refresh + APIs

  res.redirect(u.toString());
});

// Estado de conexión para pintar UI (conectado / no)
app.get("/mp/estado", (req, res) => {
  const { complejoId } = req.query;
  if (!complejoId) return res.status(400).json({ ok:false, error:"Falta complejoId" });

  const creds = leerCredsMP_OAUTH();
  const conectado = Boolean(creds[complejoId]?.oauth?.access_token);
  res.json({ ok:true, conectado });
});

// Callback al que vuelve Mercado Pago con ?code=...&state=complejoId
app.get("/mp/callback", async (req, res) => {
  const { code, state: complejoId } = req.query;
  if (!code || !complejoId) {
    return res.status(400).send("❌ Faltan parámetros en el callback");
  }

  try {
    const r = await fetch("https://api.mercadopago.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: process.env.MP_CLIENT_ID,
        client_secret: process.env.MP_CLIENT_SECRET,
        code,
        redirect_uri: process.env.MP_REDIRECT_URI
      })
    });

    const data = await r.json();
    if (!r.ok || !data.access_token) {
      console.error("OAuth error:", data);
      return res.status(400).send("❌ No se pudo conectar Mercado Pago.");
    }

    const creds = leerCredsMP_OAUTH();
    creds[complejoId] = creds[complejoId] || {};
    creds[complejoId].oauth = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      user_id: data.user_id,
      updated_at: Date.now()
    };
    escribirCredsMP_OAUTH(creds);

    res.send("✅ Mercado Pago conectado. Ya podés cobrar las señas.");
  } catch (e) {
    console.error(e);
    res.status(500).send("❌ Error interno al conectar Mercado Pago.");
  }
});
// =======================
// END
// =======================
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});



