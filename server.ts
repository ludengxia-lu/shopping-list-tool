import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const db = new Database("database.db");

// Init DB
db.exec(`
  CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    url TEXT,
    date TEXT,
    status TEXT,
    errorMessage TEXT
  );
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    phone TEXT,
    name TEXT,
    barcode TEXT,
    itemName TEXT,
    quantity TEXT,
    sourceImageId TEXT,
    date TEXT
  );
  CREATE TABLE IF NOT EXISTS notes (
    date TEXT PRIMARY KEY,
    content TEXT
  );
`);

const app = express();
app.use(express.json({ limit: "50mb" }));

const uploadsDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}
app.use("/uploads", express.static(uploadsDir));

app.get("/api/dates", (req, res) => {
  const dates = db.prepare("SELECT DISTINCT date FROM images ORDER BY date DESC").all();
  res.json(dates.map((d: any) => d.date));
});

app.get("/api/data/:date", (req, res) => {
  const date = req.params.date;
  const images = db.prepare("SELECT * FROM images WHERE date = ?").all(date);
  const items = db.prepare("SELECT * FROM items WHERE date = ?").all(date);
  const noteRow = db.prepare("SELECT content FROM notes WHERE date = ?").get(date) as any;
  const note = noteRow ? noteRow.content : "";
  res.json({ images, items, note });
});

app.post("/api/notes", (req, res) => {
  const { date, content } = req.body;
  db.prepare("INSERT INTO notes (date, content) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET content = excluded.content").run(date, content);
  res.json({ success: true });
});

app.post("/api/images", (req, res) => {
  const { id, base64, date, status } = req.body;
  const buffer = Buffer.from(base64, "base64");
  const filename = `${id}.jpg`;
  fs.writeFileSync(path.join(uploadsDir, filename), buffer);
  const url = `/uploads/${filename}`;
  
  db.prepare("INSERT INTO images (id, url, date, status) VALUES (?, ?, ?, ?)").run(id, url, date, status);
  res.json({ id, url });
});

app.put("/api/images/:id", (req, res) => {
  const { status, errorMessage } = req.body;
  db.prepare("UPDATE images SET status = ?, errorMessage = ? WHERE id = ?").run(status, errorMessage || null, req.params.id);
  res.json({ success: true });
});

app.post("/api/items", (req, res) => {
  const { items } = req.body;
  const insert = db.prepare("INSERT INTO items (id, phone, name, barcode, itemName, quantity, sourceImageId, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  
  const insertMany = db.transaction((items) => {
    for (const item of items) {
      insert.run(item.id, item.phone, item.name, item.barcode, item.itemName, item.quantity, item.sourceImageId, item.date);
    }
  });
  
  insertMany(items);
  res.json({ success: true });
});

app.delete("/api/images/:id", (req, res) => {
  const id = req.params.id;
  db.prepare("DELETE FROM images WHERE id = ?").run(id);
  db.prepare("DELETE FROM items WHERE sourceImageId = ?").run(id);
  try {
    fs.unlinkSync(path.join(uploadsDir, `${id}.jpg`));
  } catch (e) {}
  res.json({ success: true });
});

async function startServer() {
  const PORT = 3000;

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
