import fs from "fs";
import path from "path";
import crypto from "crypto";
import multer from "multer";
import type { Request } from "express";

// ===================== Storage abstraction =====================
// Dev/production-cheap default: local disk under /uploads, served statically
// by app.ts. The spec calls for "S3-compatible object storage" in production
// and explicitly says not to store large media files in the database — this
// file is the one place that would change to point at an S3-compatible
// bucket (Cloudflare R2 has a genuinely free tier and speaks the S3 API, so
// it's a good fit if/when this needs to move off local disk — no code
// outside this file needs to know which backend is used).

export const UPLOADS_DIR = path.join(process.cwd(), "uploads");

for (const sub of ["images", "audio", "documents"]) {
  fs.mkdirSync(path.join(UPLOADS_DIR, sub), { recursive: true });
}

type Category = "images" | "audio" | "documents";

const ALLOWED: Record<Category, { mime: RegExp; ext: string[]; maxBytes: number }> = {
  images: { mime: /^image\/(jpeg|png|webp)$/, ext: [".jpg", ".jpeg", ".png", ".webp"], maxBytes: 5 * 1024 * 1024 },
  audio: { mime: /^audio\/(mpeg|mp3|wav|x-wav|mp4|aac|m4a)$/, ext: [".mp3", ".wav", ".m4a", ".aac"], maxBytes: 60 * 1024 * 1024 },
  documents: { mime: /^application\/pdf$/, ext: [".pdf"], maxBytes: 40 * 1024 * 1024 },
};

// Real magic-byte sniffing — a renamed .exe with a .pdf extension and a
// forged Content-Type header still gets caught here, since this reads the
// actual first bytes of the file rather than trusting client-supplied metadata.
const SIGNATURES: Record<Category, (buf: Buffer) => boolean> = {
  images: (buf) =>
    (buf[0] === 0xff && buf[1] === 0xd8) || // JPEG
    (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) || // PNG
    (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP"),
  audio: (buf) =>
    (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) || // "ID3" mp3 tag
    (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) || // raw mpeg frame sync
    buf.slice(0, 4).toString("ascii") === "RIFF" || // wav
    buf.slice(4, 8).toString("ascii") === "ftyp", // m4a/mp4 container
  documents: (buf) => buf.slice(0, 5).toString("ascii") === "%PDF-",
};

function makeStorage(category: Category) {
  return multer.diskStorage({
    destination: path.join(UPLOADS_DIR, category),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  });
}

/**
 * A single multer instance that accepts several differently-named file
 * fields in one multipart request (e.g. `file` = documents, `coverImage` =
 * images), routing each field to its own uploads subfolder by fieldname —
 * rather than one shared storage engine that would file everything under
 * whichever category was configured first.
 */
export function makeMultiFieldUploader(fieldToCategory: Record<string, Category>) {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const category = fieldToCategory[file.fieldname];
      if (!category) {
        cb(new Error(`Ntagenamiterere ryabonetse kuri uru rwego: ${file.fieldname}`), "");
        return;
      }
      cb(null, path.join(UPLOADS_DIR, category));
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  });

  const maxBytes = Math.max(...Object.values(fieldToCategory).map((c) => ALLOWED[c].maxBytes));

  return multer({
    storage,
    limits: { fileSize: maxBytes },
    fileFilter: (_req, file, cb) => {
      const category = fieldToCategory[file.fieldname];
      const rules = category && ALLOWED[category];
      const ext = path.extname(file.originalname).toLowerCase();
      if (!rules || !rules.mime.test(file.mimetype) || !rules.ext.includes(ext)) {
        cb(new Error(`Ubwoko bw'idosiye ntibwemewe kuri "${file.fieldname}".`));
        return;
      }
      cb(null, true);
    },
  }).fields(Object.keys(fieldToCategory).map((name) => ({ name, maxCount: 1 })));
}

export function makeUploader(category: Category) {
  const rules = ALLOWED[category];
  return multer({
    storage: makeStorage(category),
    limits: { fileSize: rules.maxBytes },
    fileFilter: (_req: Request, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (!rules.mime.test(file.mimetype) || !rules.ext.includes(ext)) {
        cb(new Error(`Ubwoko bw'idosiye ntibwemewe (${category}).`));
        return;
      }
      cb(null, true);
    },
  });
}

/** Call after multer has saved the file — verifies real file-signature bytes match the declared category, deleting the file and throwing if not. */
export function verifySignatureOrThrow(category: Category, savedPath: string) {
  const fd = fs.openSync(savedPath, "r");
  const buf = Buffer.alloc(16);
  fs.readSync(fd, buf, 0, 16, 0);
  fs.closeSync(fd);
  if (!SIGNATURES[category](buf)) {
    fs.unlinkSync(savedPath);
    throw new Error("Idosiye ntabwo isa n'uko yanditswe (signature ntabwo ihuye).");
  }
}

export function publicUrlFor(category: Category, filename: string) {
  return `/uploads/${category}/${filename}`;
}

export function deleteUploadedFile(publicUrl: string | null | undefined) {
  if (!publicUrl || !publicUrl.startsWith("/uploads/")) return;
  const full = path.join(process.cwd(), publicUrl);
  fs.unlink(full, () => {
    /* best-effort — a missing file here is not worth failing the request over */
  });
}
