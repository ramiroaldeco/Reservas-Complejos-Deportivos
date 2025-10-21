require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch"); // v2
const { MercadoPagoConfig, Preference } = require("mercadopago");
const nodemailer = require("nodemailer");

// >>> JWT ADD
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'cambialo_en_.env';

// 👉 Importá el DAO así, SIN destructurar:
const dao = require("./dao");
console.log("DAO sanity:", {
  listarComplejos: typeof dao.listarComplejos,
  exportsKeys: Object.keys(dao)
});

// --- App & middlewares
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// >>> JWT ADD – middleware de auth
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ ok:false, error:'no_token' });
  try {
    const payload = jwt.verify(m[1], JWT_SECRET);
    req.user = payload; // { sub:'dueno', complejo:'...' }
    next();
  } catch (e) {
    return res.status(401).json({ ok:false, error:'bad_token' });
  }
}

// --- Paths de respaldos JSON (compat)
const pathDatos    = path.join(__dirname, "datos_complejos.json");
const pathReservas = path.join(__dirname, "reservas.json");
const pathCreds    = path.join(__dirname, "credenciales_mp.json");
const pathIdx      = path.join(__dirname, "prefidx.json");

// --- Helpers de archivo JSON
function leerJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; }
}
function escribirJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

// asegurar archivos de backup
if (!fs.existsSync(pathDatos))    escribirJSON(pathDatos, {});
if (!fs.existsSync(pathReservas)) escribirJSON(pathReservas, {});
if (!fs.existsSync(pathCreds))    escribirJSON(pathCreds, {});
if (!fs.existsSync(pathIdx))      escribirJSON(pathIdx, {});

// =======================
// CONFIG MP por complejo (SOLO OAuth)
// =======================
function leerCredsMP_OAUTH() {
  try { return JSON.parse(fs.readFileSync(pathCreds, "utf8")); }
  catch { return {}; }
}
function escribirCredsMP_OAUTH(obj) {
  fs.writeFileSync(pathCreds, JSON.stringify(obj, null, 2));
}

/**
 * Access token priorizando DB (tabla mp_oauth) con fallback a archivo.
 * Usar:  const token = await tokenParaAsync(complejoId)
 */
async function tokenParaAsync(complejoId) {
  // 1) DB primero (si existen helpers en dao)
  try {
    if (dao?.getMpOAuth) {
      const t = await dao.getMpOAuth(complejoId); // { access_token, refresh_token }
      if (t?.access_token) return t.access_token;
    }
  } catch (e) {
    console.warn("tokenParaAsync:getMpOAuth", e?.message || e);
  }

  // 2) Fallback a archivo
  const cred = leerCredsMP_OAUTH();
  const tok = cred?.[complejoId]?.oauth?.access_token;
  if (tok) return tok;

  const err = new Error(`El complejo ${complejoId} no tiene Mercado Pago conectado (OAuth).`);
  err.code = "NO_OAUTH";
  throw err;
}

/** Legacy (solo archivo). Dejar por compat, pero evitar su uso. */
function tokenPara(complejoId) {
  const cred = leerCredsMP_OAUTH();
  const c = cred[complejoId] || {};
  const tok = c.oauth?.access_token; // solo OAuth
  if (!tok) {
    const err = new Error(`El complejo ${complejoId} no tiene Mercado Pago conectado (OAuth).`);
    err.code = "NO_OAUTH";
    throw err;
  }
  return tok;
}

function isInvalidTokenError(err) {
  const m1 = (err && err.message || "").toLowerCase();
  const m2 = (err && err.response && (err.response.data?.message || err.response.body?.message) || "").toLowerCase();
  const m3 = (err && err.cause && String(err.cause).toLowerCase()) || "";
  return m1.includes("unauthorized") || m2.includes("invalid_token") || m3.includes("invalid_token");
}

// Refresca token con refresh_token guardado (guarda en archivo + DB si está disponible)
async function refreshOAuthToken(complejoId) {
  const creds = leerCredsMP_OAUTH();
  const c = creds[complejoId] || {};
  const refresh_token = c?.oauth?.refresh_token;
  if (!refresh_token) throw new Error("No hay refresh_token para refrescar");

  const body = {
    grant_type: "refresh_token",
    refresh_token,
    client_id: process.env.MP_CLIENT_ID,
    client_secret: process.env.MP_CLIENT_SECRET,
  };

  const r = await fetch("https://api.mercadopago.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error("No se pudo refrescar el token OAuth de Mercado Pago");

  // persistir en archivo
  creds[complejoId] = creds[complejoId] || {};
  creds[complejoId].oauth = {
    ...(creds[complejoId].oauth || {}),
    access_token: j.access_token,
    refresh_token: j.refresh_token || c.oauth?.refresh_token,
    user_id: j.user_id ?? c.oauth?.user_id,
    updated_at: Date.now()
  };
  escribirCredsMP_OAUTH(creds);

  // persistir en DB (si existe helper)
  try {
    if (dao?.upsertMpOAuth) {
      await dao.upsertMpOAuth({
        complex_id: complejoId,
        access_token: j.access_token,
        refresh_token: j.refresh_token || refresh_token,
        scope: j.scope,
        token_type: j.token_type,
        live_mode: j.live_mode,
        expires_in: j.expires_in
      });
    }
  } catch (e) { console.warn("refreshOAuthToken:upsertMpOAuth", e?.message || e); }

  return j.access_token;
}

// Variante usada en crear-preferencia (deja persistido en archivo + DB si está)
async function refreshTokenMP(complejoId) {
  const allCreds = leerCredsMP_OAUTH();
  const creds = allCreds?.[complejoId]?.oauth || null;
  if (!creds?.refresh_token) throw new Error(`No hay refresh_token guardado para ${complejoId}`);

  const body = {
    grant_type: "refresh_token",
    client_id: process.env.MP_CLIENT_ID,
    client_secret: process.env.MP_CLIENT_SECRET,
    refresh_token: creds.refresh_token
  };

  const r = await fetch("https://api.mercadopago.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!r.ok || !data?.access_token) {
    console.error("Fallo refresh_token MP:", { status: r.status, data });
    throw new Error("No se pudo refrescar el token de MP");
  }

  const newCreds = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || creds.refresh_token,
    scope: data.scope,
    token_type: data.token_type,
    live_mode: data.live_mode,
    expires_in: data.expires_in,
    obtained_at: Date.now()
  };

  allCreds[complejoId] = allCreds[complejoId] || {};
  allCreds[complejoId].oauth = {
    ...(allCreds[complejoId].oauth || {}),
    ...newCreds
  };
  escribirCredsMP_OAUTH(allCreds);

  // DB (si está disponible)
  try {
    if (dao?.upsertMpOAuth) {
      await dao.upsertMpOAuth({
        complex_id: complejoId,
        access_token: newCreds.access_token,
        refresh_token: newCreds.refresh_token,
        scope: newCreds.scope,
        token_type: newCreds.token_type,
        live_mode: newCreds.live_mode,
        expires_in: newCreds.expires_in
      });
    }
  } catch (e) { console.warn("refreshTokenMP:upsertMpOAuth", e?.message || e); }

  return newCreds.access_token;
}

// =======================
// HOLD anti doble-reserva (legacy archivo de compat + limpieza)
// =======================
const HOLD_MIN = parseInt(process.env.HOLD_MIN || "10", 10); // 10 min default

function estaHoldActiva(r) {
  if (!r) return false;
  const t = typeof r.holdUntil === "number" ? r.holdUntil : Number(r.holdUntil);
  return r.status === "hold" && t && Date.now() < t;
}

function limpiarHoldsVencidos() {
  const reservas = leerJSON(pathReservas);
  let cambio = false;
  for (const k of Object.keys(reservas)) {
    const r = reservas[k];
    if (r?.status === "hold" && r.holdUntil && Date.now() >= r.holdUntil) {
      delete reservas[k]; // liberar
      cambio = true;
    }
  }
  if (cambio) escribirJSON(pathReservas, reservas);
}
setInterval(limpiarHoldsVencidos, 60 * 1000); // cada minuto

// =======================
// Helpers fecha/hora/clave UNIFICADOS
// =======================

/**
 * Genera slug normalizado de nombre de cancha
 * (minúsculas, sin espacios, solo alfanuméricos)
 */
function slugCancha(nombre = "") {
  return String(nombre)
    .toLowerCase()
    .normalize('NFD')                     // separa letras y tildes
    .replace(/[\u0300-\u036f]/g, '')      // elimina las tildes/acentos
    .replace(/\s+/g, '')                  // borra espacios
    .replace(/[^a-z0-9]/g, '');           // borra todo lo que no sea letra o número
}

/**
 * Genera la clave unificada: complejo-cancha-fecha-hora
 * IMPORTANTE: usa slugCancha() para normalizar el nombre de la cancha
 */
function claveDe({ complejoId, canchaNombre, fecha, hora }) {
  return `${complejoId}-${slugCancha(canchaNombre)}-${fecha}-${hora}`;
}

/**
 * Parser de clave del servidor para extraer componentes
 * formato: complejo-cancha-YYYY-MM-DD-HH:MM
 */
function parseClaveServidor(k) {
  const m = k.match(/^(.+?)-(.+?)-(\d{4}-\d{2}-\d{2})-(\d{2}:\d{2})$/);
  if (!m) return null;
  return { complejo: m[1], cancha: m[2], fechaISO: m[3], hora: m[4] };
}

function esFechaISO(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); }
function esHora(h) { return /^\d{2}:\d{2}$/.test(h); }

function nombreDia(fechaISO) {
  const d = new Date(`${fechaISO}T00:00:00-03:00`);
  const dias = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
  return dias[d.getDay()];
}

function entre(hora, desde, hasta) {
  if (!desde || !hasta) return false;
  return (desde <= hasta) ? (hora >= desde && hora <= hasta)
    : (hora >= desde || hora <= hasta);
}

function validarTurno({ complejoId, canchaNombre, fecha, hora }) {
  if (!complejoId) return { ok: false, error: "Falta complejoId" };
  if (!canchaNombre) return { ok: false, error: "Falta cancha" };
  if (!esFechaISO(fecha)) return { ok: false, error: "Fecha inválida" };
  if (!esHora(hora)) return { ok: false, error: "Hora inválida" };

  const datos = _cacheComplejosCompat;
  const info = datos?.[complejoId];
  if (!info) return { ok: false, error: "Complejo inexistente" };

  const cancha = (info.canchas || []).find(c => slugCancha(c.nombre) === slugCancha(canchaNombre));
  if (!cancha) return { ok: false, error: "Cancha inexistente" };

  const ahora = new Date();
  const turno = new Date(`${fecha}T${hora}:00-03:00`);
  if (turno.getTime() < ahora.getTime()) return { ok: false, error: "Turno en el pasado" };

  const nomDia = nombreDia(fecha);
  const hDia = (info.horarios || {})[nomDia] || {};
  const desde = hDia.desde || "18:00";
  const hasta = hDia.hasta || "23:00";
  if (!entre(hora, desde, hasta)) return { ok: false, error: `Fuera de horario (${nomDia} ${desde}-${hasta})` };

  return { ok: true, cancha };
}

// =======================
// Email helpers
// =======================

// lee contacto y switches priorizando DB; fallback al cache o JSON
async function getOwnerConfig(complejoId) {
  try {
    if (dao?.leerContactoComplejo) {
      const r = await dao.leerContactoComplejo(complejoId);
      if (r) {
        return {
          owner_email: r.owner_email || "",
          owner_phone: r.owner_phone || "",
          notif_email: !!r.notif_email,
          notif_whats: !!r.notif_whats,
        };
      }
    }
  } catch (e) {
    console.warn("getOwnerConfig DB", e?.message || e);
  }
  // fallback al cache/archivo (compat)
  const datos = Object.keys(_cacheComplejosCompat || {}).length ? _cacheComplejosCompat : leerJSON(pathDatos);
  const conf = datos?.[complejoId] || {};
  const notif = conf.notif || {};
  return {
    owner_email: conf.emailDueño || "",
    owner_phone: conf.whatsappDueño || "",
    notif_email: !!notif.email,
    notif_whats: !!notif.whats
  };
}

function plantillaMailReserva({ complejoId, cancha, fecha, hora, nombre, telefono, monto }) {
  const telFmt = telefono ? (String(telefono).startsWith('+') ? telefono : `+${String(telefono).replace(/\D/g, '')}`) : 's/d';
  const montoFmt = (monto != null && monto !== "") ? `ARS $${Number(monto).toLocaleString('es-AR')}` : '—';
  const titulo = `NUEVA RESERVA — ${cancha || ''} ${hora || ''}`.trim();

  const html = `
    <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;line-height:1.45">
      <h2 style="margin:0 0 10px">NUEVA RESERVA</h2>
      <p><b>Complejo:</b> ${complejoId}</p>
      <p><b>Cancha:</b> ${cancha || 's/d'}</p>
      <p><b>Fecha:</b> ${fecha || 's/d'} <b>Hora:</b> ${hora || 's/d'}</p>
      <p><b>Cliente:</b> ${nombre || '—'}</p>
      <p><b>Teléfono:</b> ${telFmt}</p>
      <p><b>Seña:</b> ${montoFmt}</p>
      <hr style="border:none;height:1px;background:#ddd;margin:12px 0" />
      <small style="color:#666">Recomplejos</small>
    </div>`;
  return { subject: titulo, html };
}

async function enviarEmail(complejoId, subject, html) {
  try {
    const { owner_email, notif_email } = await getOwnerConfig(complejoId);
    if (!notif_email || !owner_email) return; // no activado o sin email

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.GMAIL_USER, pass: process.env.GOOGLE_APP_PASSWORD },
    });

    await transporter.sendMail({ from: process.env.GMAIL_USER, to: owner_email, subject, html });
    console.log("[EMAIL] enviado a", owner_email);
  } catch (e) {
    console.error("[EMAIL] error:", e?.message || e);
  }
}

async function notificarAprobado({ clave, complejoId, nombre, telefono, monto }) {
  try {
    const info = parseClaveServidor(clave) || {};
    const { subject, html } = plantillaMailReserva({
      complejoId,
      cancha: info.cancha,
      fecha: info.fechaISO,
      hora: info.hora,
      nombre,
      telefono,
      monto
    });
    await enviarEmail(complejoId, subject, html);
  } catch (e) {
    console.error("notificarAprobado error:", e?.message || e);
  }
}

// =======================
// RUTAS - Cache y datos de complejos
// =======================

// Cache breve para validación
let _cacheComplejosCompat = {};

// Datos de complejos (desde BD) con fallback a archivo
app.get("/datos_complejos", async (_req, res) => {
  try {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    const d = await dao.listarComplejos();
    _cacheComplejosCompat = d;
    res.json(d);
  } catch (e) {
    console.error("DB /datos_complejos", e);
    res.json(leerJSON(pathDatos)); // fallback
  }
});

// Guardar datos mergeados (onboarding)
app.post("/guardarDatos", async (req, res) => {
  try {
    const nuevos = req.body || {};
    await dao.guardarDatosComplejos(nuevos);
    const actuales = leerJSON(pathDatos);
    const merged = { ...actuales, ...nuevos };
    escribirJSON(pathDatos, merged);
    res.json({ ok: true });
  } catch (e) {
    console.error("DB /guardarDatos", e);
    res.status(500).json({ error: "DB error al guardar" });
  }
});

// Alta/actualización credencial "legacy"
app.post("/alta-credencial", (req, res) => {
  const { id, mp_access_token, access_token } = req.body || {};
  if (!id || !(mp_access_token || access_token)) {
    return res.status(400).json({ error: "Falta id o token" });
  }
  const cred = leerJSON(pathCreds);
  cred[id] = cred[id] || {};
  cred[id].access_token = access_token || mp_access_token;
  escribirJSON(pathCreds, cred);
  res.json({ ok: true });
});

// =======================
// RUTAS - Reservas
// =======================

// Reservas → leer de BD (compat: archivo si falla)
app.get("/reservas", async (_req, res) => {
  try {
    const r = await dao.listarReservasObjCompat();
    res.json(r);
  } catch (e) {
    console.error("DB /reservas", e);
    res.json(leerJSON(pathReservas)); // fallback
  }
});

// Guardar reservas masivo (panel dueño)
app.post("/guardarReservas", async (req, res) => {
  try {
    await dao.guardarReservasObjCompat(req.body || {});
    escribirJSON(pathReservas, req.body || {});
    res.json({ ok: true });
  } catch (e) {
    console.error("DB /guardarReservas", e);
    res.status(500).json({ error: "DB error al guardar" });
  }
});

// ¿Está libre este turno?
app.get("/disponible", async (req, res) => {
  const { complejoId, cancha, fecha, hora } = req.query || {};
  const v = validarTurno({ complejoId, canchaNombre: cancha, fecha, hora });
  if (!v.ok) return res.json({ ok: false, motivo: v.error });

  try {
    const obj = await dao.listarReservasObjCompat();
    const clave = claveDe({ complejoId, canchaNombre: cancha, fecha, hora });
    const r = obj[clave];
    const ocupado = Boolean(
      r && (
        r.status === "approved" ||
        r.status === "manual" ||
        r.status === "blocked" ||
        (r.status === "hold" && r.holdUntil && Date.now() < r.holdUntil)
      )
    );
    return res.json({ ok: true, libre: !ocupado });
  } catch {
    const reservas = leerJSON(pathReservas);
    const clave = claveDe({ complejoId, canchaNombre: cancha, fecha, hora });
    const r = reservas[clave];
    const ocupado = Boolean(
      r && (
        r.status === "approved" ||
        r.status === "manual" ||
        r.status === "blocked" ||
        estaHoldActiva(r)
      )
    );
    return res.json({ ok: true, libre: !ocupado, via: "archivo" });
  }
});

// Estado de una reserva por clave
app.get("/estado-reserva", async (req, res) => {
  const { clave } = req.query || {};
  if (!clave) return res.status(400).json({ error: "Falta clave" });
  try {
    const obj = await dao.listarReservasObjCompat();
    const r = obj[clave];
    if (!r) return res.json({ ok: true, existe: false, status: "none" });
    return res.json({ ok: true, existe: true, status: r.status, data: r });
  } catch {
    const reservas = leerJSON(pathReservas);
    const r = reservas[clave];
    if (!r) return res.json({ ok: true, existe: false, status: "none", via: "archivo" });
    return res.json({ ok: true, existe: true, status: r.status, data: r, via: "archivo" });
  }
});

// =======================
// NUEVA RUTA: Reservar manual (recomendada)
// =======================

/**
 * Crea o actualiza una reserva manual para un turno concreto.
 * Guarda en la base de datos y notifica al dueño si corresponde.
 * Espera en req.body: { complejoId, cancha, fechaISO, hora, nombre, telefono, monto }
 */
app.post("/reservar-manual", async (req, res) => {
  try {
    const { complejoId, cancha, fechaISO, hora, nombre, telefono, monto } = req.body || {};
    if (!complejoId || !cancha || !fechaISO || !hora) {
      return res.status(400).json({
        ok: false,
        error: "Faltan datos: complejoId, cancha, fechaISO, hora"
      });
    }

    // Validar el turno
    const v = validarTurno({ complejoId, canchaNombre: cancha, fecha: fechaISO, hora });
    if (!v.ok) {
      return res.status(400).json({ ok: false, error: v.error });
    }

    // Guarda en la BD como reserva manual
    if (dao.reservarManualDB) {
      await dao.reservarManualDB({
        complex_id: complejoId,
        cancha,
        fechaISO,
        hora,
        nombre,
        telefono,
        monto
      });
    } else if (dao.insertarReservaManual) {
      // fallback: usa la función existente en tu DAO
      await dao.insertarReservaManual({
        complex_id: complejoId,
        cancha,
        fechaISO,
        hora,
        nombre,
        telefono,
        monto
      });
    } else {
      return res.status(500).json({
        ok: false,
        error: "No hay función disponible para guardar reservas manuales"
      });
    }

    // Notifica al dueño por email (solo si notif_email está activo)
    try {
      const { subject, html } = plantillaMailReserva({
        complejoId,
        cancha,
        fecha: fechaISO,
        hora,
        nombre,
        telefono,
        monto
      });
      await enviarEmail(complejoId, subject, html);
    } catch (e) {
      console.warn("No se pudo enviar email de reserva manual:", e?.message || e);
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("/reservar-manual error:", e);
    return res.status(500).json({
      ok: false,
      error: e.message || "Error interno"
    });
  }
});

// =======================
// Reserva manual (LEGACY - mantener compatibilidad)
// =======================
app.post("/reservas/manual", async (req, res) => {
  try {
    const { complejoId, cancha, fechaISO, hora, nombre, telefono, monto } = req.body || {};
    if (!complejoId || !cancha || !fechaISO || !hora) {
      return res.status(400).json({ ok: false, error: "Faltan datos: complejoId, cancha, fechaISO, hora" });
    }

    // Inserta/actualiza en BD como 'manual'
    if (dao.insertarReservaManual) {
      await dao.insertarReservaManual({
        complex_id: complejoId,
        cancha,
        fechaISO,
        hora,
        nombre,
        telefono,
        monto
      });
    } else {
      // Fallback: compat que no borre todo
      const key = claveDe({ complejoId, canchaNombre: cancha, fecha: fechaISO, hora });
      const obj = {
        [key]: { status: "manual", nombre: nombre || "", telefono: telefono || "", monto: Number(monto || 0) || 0, creado: Date.now() },
        __append: true
      };
      await dao.guardarReservasObjCompat(obj);
    }
// Email al dueño (si notif_email y owner_email en DB)
try {
  // recuperar nombre legible desde la caché de datos
  let canchaLegible = cancha;
  try {
    const info = _cacheComplejosCompat?.[complejoId];
    const match = (info?.canchas || []).find(
      c => slugCancha(c.nombre) === slugCancha(cancha)
    );
    if (match?.nombre) canchaLegible = match.nombre;
  } catch (_) {}

  const { subject, html } = plantillaMailReserva({
    complejoId,
    cancha: canchaLegible,
    fecha: fechaISO,
    hora,
    nombre,
    telefono,
    monto
  });
  await enviarEmail(complejoId, subject, html);
} catch (e) {
  console.warn("No se pudo enviar email de reserva manual:", e?.message || e);
}

return res.json({ ok: true });


// Notificar reserva manual (solo email, no guarda estado)
app.post("/notificar-manual", async (req, res) => {
  try {
    const { complejoId, nombre, telefono, monto, clave } = req.body || {};
    if (!complejoId) return res.status(400).json({ ok: false, error: "Falta complejoId" });

    const { subject, html } = plantillaMailReserva({
      complejoId,
      cancha: "", fecha: "", hora: "",
      nombre, telefono, monto
    });
    await enviarEmail(complejoId, subject, html);
    res.json({ ok: true });
  } catch (e) {
    console.error("notificar-manual:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// LOGIN
// =======================

app.post("/login", async (req, res) => {
  const id = String(req.body?.complejo || "").trim();
  const pass = String(req.body?.password || "").trim();

  if (!id || !pass) return res.status(400).json({ error: "Faltan datos" });

  let ok = false;

  // 1) Chequeo en la DB
  try {
    const r = await dao.loginDueno(id, pass);
    ok = !!r?.ok;
  } catch (e) {
    console.error("DB /login:", e);
  }

  // 2) Fallback a archivo (por si la DB no tenía la clave guardada aún)
  if (!ok) {
    try {
      const datos = leerJSON(pathDatos);
      const claveArchivo = String(datos?.[id]?.clave || "").trim();
      if (claveArchivo && claveArchivo === pass) ok = true;
    } catch {}
  }

  if (!ok) return res.status(401).json({ error: "Contraseña incorrecta" });
  res.json({ ok: true });
});

// =======================
// PAGOS: crear preferencia (SOLO OAuth)
// =======================

app.post("/crear-preferencia", async (req, res) => {
  const {
    complejoId,
    // NUEVOS CAMPOS
    cancha, fecha, hora,
    // LEGADO
    clave: claveLegacy,
    titulo,
    precio, senia,
    nombre, telefono
  } = req.body || {};

  const monto = Number((precio ?? senia));
  if (!complejoId || !monto) {
    return res.status(400).json({ error: "Faltan datos (complejoId/monto)" });
  }

  // construir/validar clave
  let clave = claveLegacy;
  if (cancha && fecha && hora) {
    const v = validarTurno({ complejoId, canchaNombre: cancha, fecha, hora });
    if (!v.ok) return res.status(400).json({ error: v.error });
    clave = claveDe({ complejoId, canchaNombre: cancha, fecha, hora });
  }
  if (!clave) {
    return res.status(400).json({ error: "Faltan cancha/fecha/hora (o clave)" });
  }

  // --- HOLD en BD (solo si llegaron cancha/fecha/hora) ---
  if (cancha && fecha && hora) {
    const v = validarTurno({ complejoId, canchaNombre: cancha, fecha, hora });
    if (!v.ok) return res.status(400).json({ error: v.error });

    try {
      const okHold = await dao.crearHold({
        complex_id: complejoId,
        cancha,
        fechaISO: fecha,
        hora,
        nombre,
        telefono,
        monto,
        holdMinutes: HOLD_MIN
      });
      if (!okHold) {
        return res.status(409).json({ error: "El turno ya está tomado" });
      }
    } catch (e) {
      console.error("DB crear hold:", e);
      // seguimos: también se hace HOLD en archivo más abajo
    }
  } else if (!claveLegacy) {
    return res.status(400).json({ error: "Faltan cancha/fecha/hora (o clave)" });
  }

  // HOLD también en archivo (compat panel viejo)
  const reservas = leerJSON(pathReservas);
  const holdUntil = Date.now() + HOLD_MIN * 60 * 1000;
  reservas[clave] = {
    ...(reservas[clave] || {}),
    status: "hold",
    holdUntil,
    nombre: nombre || "",
    telefono: telefono || "",
    complejoId,
    monto,
    cancha: cancha || "",
    fecha: fecha || "",
    hora: hora || ""
  };
  escribirJSON(pathReservas, reservas);

  // helper para crear preferencia con el token que toque
  const crearCon = async (accessToken) => {
    const mp = new MercadoPagoConfig({ accessToken });
    const preference = new Preference(mp);
    return await preference.create({
      body: {
        items: [{
          title: titulo || "Seña de reserva",
          unit_price: monto,
          quantity: 1,
          currency_id: "ARS"
        }],
        back_urls: {
          success: `${process.env.PUBLIC_URL}/reservar-exito.html`,
          pending: `${process.env.PUBLIC_URL}/reservar-pendiente.html`,
          failure: `${process.env.PUBLIC_URL}/reservar-error.html`
        },
        auto_return: "approved",
        notification_url: `${process.env.BACKEND_URL}/webhook-mp`,
        metadata: { clave, complejoId, nombre: nombre || "", telefono: telefono || "" }
      }
    });
  };

  try {
    // 1) token actual del dueño
    let tokenActual;
    try {
      tokenActual = await tokenParaAsync(complejoId);
    } catch (e) {
      // liberar hold en archivo
      const rr = leerJSON(pathReservas);
      delete rr[clave];
      escribirJSON(pathReservas, rr);

      if (e.code === "NO_OAUTH") {
        return res.status(409).json({
          error: "Este complejo aún no conectó su Mercado Pago. Pedile al dueño que toque 'Conectar Mercado Pago'."
        });
      }
      return res.status(500).json({ error: "Error obteniendo credenciales del dueño" });
    }

    // 2) Intento de creación con retry por token vencido
    let result;
    try {
      result = await crearCon(tokenActual);
    } catch (err) {
      const status = err?.status || err?.body?.status;
      const msg = (err?.body && (err.body.message || err.body.error)) || err?.message || "";
      if (status === 401 || /invalid_token/i.test(msg)) {
        try {
          const tokenNuevo = await refreshTokenMP(complejoId);
          result = await crearCon(tokenNuevo);
        } catch (err2) {
          const rr = leerJSON(pathReservas);
          delete rr[clave];
          escribirJSON(pathReservas, rr);
          const detalle2 =
            (err2?.body && (err2.body.message || err2.body.error || (Array.isArray(err2.body.cause) && err2.body.cause[0]?.description))) ||
            err2?.message || "Error creando preferencia";
          return res.status(400).json({ error: detalle2 });
        }
      } else {
        const rr = leerJSON(pathReservas);
        delete rr[clave];
        escribirJSON(pathReservas, rr);
        const detalle =
          (err?.body && (err.body.message || err.body.error || (Array.isArray(err.body.cause) && err.body.cause[0]?.description))) ||
          err?.message || "Error creando preferencia";
        return res.status(400).json({ error: detalle });
      }
    }

    // 3) Preferencia OK → indexamos prefId -> clave/complejo y devolvemos
    const prefId = result?.id || result?.body?.id || result?.response?.id;
    const initPoint = result?.init_point || result?.body?.init_point || result?.response?.init_point || "";

    const idx = leerJSON(pathIdx);
    idx[prefId] = { clave, complejoId };
    escribirJSON(pathIdx, idx);

    // intentar enlazar en BD (si existe helper)
    try {
      if (dao?.setPreferenceIdEnHold && cancha && fecha && hora && prefId) {
        await dao.setPreferenceIdEnHold({
          complex_id: complejoId,
          cancha,
          fechaISO: fecha,
          hora,
          preference_id: prefId
        });
      }
    } catch (e) { console.warn("setPreferenceIdEnHold", e?.message || e); }

    const r2 = leerJSON(pathReservas);
    if (r2[clave]) {
      r2[clave] = {
        ...r2[clave],
        status: "pending",
        preference_id: prefId,
        init_point: initPoint,
        holdUntil
      };
      escribirJSON(pathReservas, r2);
    }

    return res.json({ preference_id: prefId, init_point: initPoint });
  } catch (e) {
    // Excepción general → liberar hold en archivo
    const rr = leerJSON(pathReservas);
    delete rr[clave];
    escribirJSON(pathReservas, rr);

    const detalle =
      (e?.body && (e.body.message || e.body.error || (Array.isArray(e.body.cause) && e.body.cause[0]?.description))) ||
      e?.message || "Error creando preferencia";
    return res.status(400).json({ error: detalle });
  }
});

// =======================
// Webhook de Mercado Pago
// =======================

app.post("/webhook-mp", async (req, res) => {
  try {
    // responder rápido para que MP no reintente de más
    res.sendStatus(200);

    const body = req.body || {};
    const paymentId = body?.data?.id || body?.id;
    if (!paymentId) return;

    // buscamos el pago consultando con cualquier token válido que tengamos
    const tokensATestar = [];
    const cred = leerJSON(pathCreds);
    if (process.env.MP_ACCESS_TOKEN) tokensATestar.push(process.env.MP_ACCESS_TOKEN);
    for (const k of Object.keys(cred)) {
      if (cred[k]?.oauth?.access_token) tokensATestar.push(cred[k].oauth.access_token);
      if (cred[k]?.access_token) tokensATestar.push(cred[k].access_token);
      if (cred[k]?.mp_access_token) tokensATestar.push(cred[k].mp_access_token);
    }

    let pago = null;
    for (const t of tokensATestar) {
      try {
        if (!t) continue;
        const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
          headers: { Authorization: `Bearer ${t}` }
        });
        if (r.ok) { pago = await r.json(); break; }
      } catch { /* seguir probando */ }
    }
    if (!pago) return;

    const prefId = pago?.order?.id || pago?.preference_id || pago?.metadata?.preference_id;
    const status = pago?.status; // approved | pending | rejected | in_process | cancelled

    // localizar clave/complejo por metadata o índice pref -> clave
    let clave = pago?.metadata?.clave;
    let complejoId = pago?.metadata?.complejoId;
    if ((!clave || !complejoId) && prefId) {
      const idx = leerJSON(pathIdx);
      clave = clave || idx[prefId]?.clave;
      complejoId = complejoId || idx[prefId]?.complejoId;
    }
    if (!clave) return;

    // actualizar BD (si está disponible)
    try {
      await dao.actualizarReservaTrasPago({
        preference_id: prefId,
        payment_id: pago?.id,
        status,
        nombre: pago?.metadata?.nombre || null,
        telefono: pago?.metadata?.telefono || null
      });
    } catch (e) {
      console.error("DB actualizar tras pago:", e);
    }

    // mantener compat en archivo local
    const reservas = leerJSON(pathReservas);
    const r = reservas[clave] || {};
    r.preference_id = prefId || r.preference_id;
    r.payment_id = pago?.id || r.payment_id;

    if (status === "approved") {
      r.status = "approved";
      r.paidAt = Date.now();
      r.nombre = r.nombre || pago?.metadata?.nombre || "";
      r.telefono = r.telefono || pago?.metadata?.telefono || "";
      r.complejoId = r.complejoId || complejoId || "";

      escribirJSON(pathReservas, { ...reservas, [clave]: r });

      // 📧 Enviar email al dueño
      const infoNoti = {
        clave,
        complejoId: r.complejoId,
        nombre: r.nombre,
        telefono: r.telefono,
        monto: r.monto || r.precio || r.senia || ""
      };
      await notificarAprobado(infoNoti);

      delete r.holdUntil;

    } else if (status === "rejected" || status === "cancelled") {
      delete reservas[clave];
      escribirJSON(pathReservas, reservas);
      return;

    } else {
      r.status = "pending"; // in_process / pending
      escribirJSON(pathReservas, { ...reservas, [clave]: r });
      return;
    }

    escribirJSON(pathReservas, { ...reservas, [clave]: r });
  } catch (e) {
    console.error("Error en webhook:", e?.message || e);
  }
});

// =======================
// OAuth Mercado Pago: conectar / estado / callback
// =======================

app.get("/mp/conectar", (req, res) => {
  const { complejoId } = req.query;
  if (!complejoId) return res.status(400).send("Falta complejoId");

  const u = new URL("https://auth.mercadopago.com/authorization");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", process.env.MP_CLIENT_ID);
  u.searchParams.set("redirect_uri", process.env.MP_REDIRECT_URI);
  u.searchParams.set("state", complejoId);
  u.searchParams.set("scope", "offline_access read write");

  res.redirect(u.toString());
});

app.get("/mp/estado", async (req, res) => {
  const { complejoId } = req.query;
  if (!complejoId) return res.status(400).json({ ok: false, error: "Falta complejoId" });

  // DB primero
  let conectado = false;
  try {
    if (dao?.getMpOAuth) {
      const t = await dao.getMpOAuth(complejoId);
      conectado = !!t?.access_token;
    }
  } catch { }
  // Fallback a archivo
  if (!conectado) {
    const creds = leerCredsMP_OAUTH();
    conectado = !!creds?.[complejoId]?.oauth?.access_token;
  }
  res.json({ ok: true, conectado });
});

app.get("/mp/callback", async (req, res) => {
  const { code, state: complejoId } = req.query;
  if (!code || !complejoId) {
    // si vienen mal los params, vuelvo al onboarding con error
    const u = new URL(`${process.env.PUBLIC_URL}/onboarding.html`);
    u.searchParams.set("mp", "error");
    return res.redirect(u.toString());
  }

  try {
    // Intercambio authorization_code → tokens
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

    if (!r.ok || !data?.access_token) {
      // redirijo con error si falló el intercambio
      const u = new URL(`${process.env.PUBLIC_URL}/onboarding.html`);
      u.searchParams.set("complejo", complejoId);
      u.searchParams.set("mp", "error");
      return res.redirect(u.toString());
    }

    // Persisto credenciales OAuth del DUEÑO (DB si está la función)
    try {
      if (dao?.upsertMpOAuth) {
        await dao.upsertMpOAuth({
          complex_id: complejoId,
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          scope: data.scope,
          token_type: data.token_type,
          live_mode: data.live_mode,
          expires_in: data.expires_in
        });
      }
    } catch (e) { console.warn("callback:upsertMpOAuth", e?.message || e); }

    // Archivo (backup)
    const all = leerCredsMP_OAUTH();
    all[complejoId] = all[complejoId] || {};
    all[complejoId].oauth = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      user_id: data.user_id,
      scope: data.scope,
      token_type: data.token_type,
      live_mode: data.live_mode,
      expires_in: data.expires_in,
      obtained_at: Date.now()
    };
    escribirCredsMP_OAUTH(all);

    // Redirijo al onboarding con confirmación
    const ok = new URL(`${process.env.PUBLIC_URL}/onboarding.html`);
    ok.searchParams.set("complejo", complejoId);
    ok.searchParams.set("mp", "ok");
    return res.redirect(ok.toString());

  } catch (e) {
    console.error("Callback OAuth MP error:", e?.message || e);
    const u = new URL(`${process.env.PUBLIC_URL}/onboarding.html`);
    u.searchParams.set("complejo", complejoId);
    u.searchParams.set("mp", "error");
    return res.redirect(u.toString());
  }
});

// =======================
// Rutas de contacto y notificaciones
// =======================

app.get('/complejos/:id/contacto', async (req, res) => {
  try {
    const out = await dao.leerContactoComplejo(req.params.id);
    res.json({ ok: true, data: out });
  } catch (e) {
    console.error('GET contacto', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/complejos/:id/contacto', async (req, res) => {
  try {
    const { owner_phone, owner_email, notif_whats, notif_email } = req.body || {};
    const out = await dao.guardarContactoComplejo(req.params.id, { owner_phone, owner_email, notif_whats, notif_email });
    res.json({ ok: true, data: out });
  } catch (e) {
    console.error('POST contacto', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/complejos/:id/notificaciones', async (req, res) => {
  try {
    const { notif_whats, notif_email } = req.body || {};
    const out = await dao.guardarNotificaciones(req.params.id, { notif_whats, notif_email });
    res.json({ ok: true, data: out });
  } catch (e) {
    console.error('POST notificaciones', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// =======================
// Rutas MP credenciales
// =======================

app.post('/complejos/:id/mp/credenciales', async (req, res) => {
  try {
    const saved = await dao.guardarCredencialesMP(req.params.id, req.body || {});
    res.json({ ok: true, data: saved });
  } catch (e) {
    console.error('POST mp/credenciales', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.get('/complejos/:id/mp/credenciales', async (req, res) => {
  try {
    const creds = await dao.leerCredencialesMP(req.params.id);
    res.json({ ok: true, data: creds });
  } catch (e) {
    console.error('GET mp/credenciales', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// =======================
// Health checks y testing
// =======================

app.get("/__health_db", async (_req, res) => {
  try {
    const d = await dao.listarComplejos();
    res.json({ ok: true, via: "db", count: Object.keys(d || {}).length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Endpoint de prueba (GET para abrirlo en el navegador)
app.get("/__test-email", async (req, res) => {
  try {
    const complejoId = String(req.query.complejoId || "").trim();
    if (!complejoId) return res.status(400).json({ ok: false, error: "Falta ?complejoId=" });

    const { subject, html } = plantillaMailReserva({
      complejoId,
      cancha: "Prueba",
      fecha: new Date().toISOString().slice(0, 10),
      hora: "20:00",
      nombre: "Tester",
      telefono: "",
      monto: 1234
    });

    await enviarEmail(complejoId, subject, html);
    res.json({ ok: true, msg: `Email de prueba enviado para complejo ${complejoId}.` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// Arranque del servidor
// =======================

app.listen(PORT, () => {
  console.log(`Server escuchando en http://0.0.0.0:${PORT}`);
});
