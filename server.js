const express = require("express");
const fs = require("fs");
const cors = require("cors");
const mercadopago = require("mercadopago");
const { Preference, MercadoPagoConfig } = require("mercadopago");

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// Configuración del SDK (versión nueva)
const mp = new MercadoPagoConfig({
  access_token: "APP_USR-7166528274201655-052620-d5be87848e1966536ccc3bb503e18272-406714342"
});

const pathDatos = "./datos_complejos.json";
const pathReservas = "./reservas.json";

function leerJSON(path) {
  try {
    const contenido = fs.readFileSync(path);
    return JSON.parse(contenido);
  } catch (err) {
    console.error(`Error leyendo ${path}:`, err);
    return {};
  }
}

function escribirJSON(path, datos) {
  try {
    fs.writeFileSync(path, JSON.stringify(datos, null, 2));
  } catch (err) {
    console.error(`Error escribiendo ${path}:`, err);
  }
}

app.get("/datos_complejos", (req, res) => {
  const datos = leerJSON(pathDatos);
  res.json(datos);
});

app.get("/reservas", (req, res) => {
  const reservas = leerJSON(pathReservas);
  res.json(reservas);
});

app.post("/guardarDatos", (req, res) => {
  const nuevosDatos = req.body;
  escribirJSON(pathDatos, nuevosDatos);
  res.json({ ok: true });
});

app.post("/guardarReserva", (req, res) => {
  const { clave, nombre, telefono } = req.body;
  const reservas = leerJSON(pathReservas);

  if (reservas[clave]) {
    return res.status(400).json({ error: "Turno ya reservado" });
  }

  reservas[clave] = { nombre, telefono };
  escribirJSON(pathReservas, reservas);
  res.json({ ok: true });
});

app.post("/login", (req, res) => {
  const { complejo, password } = req.body;
  const datos = leerJSON(pathDatos);

  if (!datos[complejo]) {
    return res.status(404).json({ error: "Complejo no encontrado" });
  }

  const claveGuardada = datos[complejo].clave;

  if (!claveGuardada) {
    return res.status(400).json({ error: "El complejo no tiene clave configurada" });
  }

  if (claveGuardada !== password) {
    return res.status(401).json({ error: "Contraseña incorrecta" });
  }

  res.json({ ok: true });
});

// ✅ Ruta corregida para generar preferencia de pago
app.post("/crear-preferencia", async (req, res) => {
  const { titulo, precio } = req.body;

  try {
    const preference = new Preference(mp);
    const result = await preference.create({
      body: {
        items: [
          {
            title: titulo,
            quantity: 1,
            unit_price: Number(precio),
            currency_id: "ARS"
          }
        ],
        back_urls: {
          success: "http://localhost:3000/reservar-exito.html",
          failure: "http://localhost:3000/reservar-error.html",
          pending: "http://localhost:3000/reservar-pendiente.html"
        },
        auto_return: "approved"
      }
    });

    console.log("✅ Preferencia creada:", result);
    res.json({ init_point: result.init_point });

  } catch (error) {
    console.error("❌ Error al generar link de pago:");
    console.error("Mensaje:", error.message);
    console.error("Status:", error.status);
    console.error("Causa:", error.cause);
    console.error("Stack:", error.stack);

    // 📌 Log detallado para saber qué devuelve exactamente MercadoPago
    console.error("Respuesta completa del error:", JSON.stringify(error, null, 2));

    res.status(500).json({ error: "Error al generar el link de pago" });
  }
});
app.post("/confirmar-pago", (req, res) => {
  const { clave, nombre, telefono } = req.body;
  const reservas = leerJSON(pathReservas);

  if (reservas[clave]) {
    return res.status(400).json({ error: "El turno ya está reservado" });
  }

  reservas[clave] = { nombre, telefono };
  escribirJSON(pathReservas, reservas);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});



